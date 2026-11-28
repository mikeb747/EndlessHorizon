/**
 * Core WorkoutEngine class managing the nested workout timeline, target power
 * calculations from FTP and intensity offset, and off-main-thread Web Worker
 * communication for stable timing and ERG keep-alive heartbeats.
 */

import { WorkoutWallClock } from '../core/workoutClock';
import { ActiveStepSnapshot, evaluateWorkoutAtTime } from '../core/workoutEngine';
import { getEffectiveFtp, getTargetWatts } from '../core/zones';
import { FlattenedStep, ParsedWorkout, WorkoutTreeNode } from '../core/zwoParser';
import type {
  WorkerRunState,
  WorkoutEngineWorkerCommand,
  WorkoutEngineWorkerEvent,
} from '../workers/workoutEngine.worker';

export type WorkoutEngineRunState = WorkerRunState;

export interface ActiveRepeatContext {
  groupId: string;
  label: string;
  currentRep: number;
  totalReps: number;
}

export interface WorkoutEngineState {
  workout: ParsedWorkout;
  runState: WorkoutEngineRunState;
  elapsedSec: number;
  ftp: number;
  intensityOffsetPct: number;
  effectiveFtp: number;
  snapshot: ActiveStepSnapshot | null;
  repeatContext: ActiveRepeatContext | null;
}

export interface WorkoutTickEvent {
  elapsedSec: number;
  dtSec: number;
  runState: WorkoutEngineRunState;
  snapshot: ActiveStepSnapshot | null;
  stepChanged: boolean;
  shouldSendErg: boolean;
  resumeGapSec?: number;
  nowMs: number;
}

export interface WorkoutErgEvent {
  targetWatts: number;
  reason: 'start' | 'step-change' | 'ramp' | 'keep-alive' | 'config-change' | 'seek';
  nowMs: number;
}

export interface WorkoutEngineCallbacks {
  onStateUpdate?: (event: WorkoutTickEvent) => void;
  onErgCommand?: (event: WorkoutErgEvent) => void;
  onComplete?: (event: { elapsedSec: number; snapshot: ActiveStepSnapshot | null; nowMs: number }) => void;
}

export interface WorkerLike {
  postMessage: (message: WorkoutEngineWorkerCommand) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<WorkoutEngineWorkerEvent>) => void) | null;
}

export interface WorkoutEngineOptions {
  ftp?: number;
  intensityOffsetPct?: number;
  callbacks?: WorkoutEngineCallbacks;
  useWorker?: boolean;
  workerFactory?: () => WorkerLike;
}

export const MIN_FTP = 80;
export const MAX_FTP = 600;
export const MIN_INTENSITY_OFFSET = -50;
export const MAX_INTENSITY_OFFSET = 50;

export function clampFtp(rawFtp: number): number {
  if (!Number.isFinite(rawFtp)) return 250;
  return Math.max(MIN_FTP, Math.min(MAX_FTP, Math.round(rawFtp)));
}

export function clampIntensityOffset(rawOffset: number): number {
  if (!Number.isFinite(rawOffset)) return 0;
  return Math.max(MIN_INTENSITY_OFFSET, Math.min(MAX_INTENSITY_OFFSET, Math.round(rawOffset)));
}

export class WorkoutEngine {
  private workout: ParsedWorkout;
  private ftp: number;
  private intensityOffsetPct: number;
  private elapsedSec = 0;
  private runState: WorkoutEngineRunState = 'idle';
  private snapshot: ActiveStepSnapshot | null = null;

  private callbacks: WorkoutEngineCallbacks;
  private worker: WorkerLike | null = null;
  private readonly useWorker: boolean;
  private readonly workerFactory?: () => WorkerLike;

  // Fallback main-thread timers when Web Workers are unavailable
  private readonly fallbackClock = new WorkoutWallClock();
  private fallbackTickTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(initialWorkout: ParsedWorkout, options: WorkoutEngineOptions = {}) {
    this.workout = initialWorkout;
    this.ftp = clampFtp(options.ftp ?? 250);
    this.intensityOffsetPct = clampIntensityOffset(options.intensityOffsetPct ?? 0);
    this.callbacks = options.callbacks ?? {};
    this.useWorker = options.useWorker ?? true;
    this.workerFactory = options.workerFactory;

    this.snapshot = this.evaluateAt(0);
  }

  /**
   * Update event callbacks after construction.
   */
  public setCallbacks(callbacks: WorkoutEngineCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Load a new workout (with nested tree and flattened timeline) and reset elapsed time to 0.
   */
  public loadWorkout(
    workout: ParsedWorkout,
    options?: { ftp?: number; intensityOffsetPct?: number }
  ): ActiveStepSnapshot | null {
    this.stopClock();
    this.workout = workout;
    if (options?.ftp !== undefined) {
      this.ftp = clampFtp(options.ftp);
    }
    if (options?.intensityOffsetPct !== undefined) {
      this.intensityOffsetPct = clampIntensityOffset(options.intensityOffsetPct);
    }
    this.elapsedSec = 0;
    this.runState = 'idle';
    this.fallbackClock.load(workout.totalDuration, 0);
    this.snapshot = this.evaluateAt(0);
    this.syncWorkoutToWorker();
    return this.snapshot;
  }

  public getWorkout(): ParsedWorkout {
    return this.workout;
  }

  /**
   * Returns the nested hierarchical workout structure (including repeat blocks).
   */
  public getNestedTree(): WorkoutTreeNode[] {
    return this.workout.tree;
  }

  /**
   * Returns the flattened execution timeline derived from the nested tree.
   */
  public getTimeline(): FlattenedStep[] {
    return this.workout.timeline;
  }

  /**
   * Returns active repeat block metadata if the current step belongs to a nested repeat group.
   */
  public getActiveRepeatContext(): ActiveRepeatContext | null {
    const step = this.snapshot?.step;
    if (!step?.groupId || !step.repeatIndex || !step.repeatTotal) {
      return null;
    }
    const groupNode = this.workout.tree.find(
      (node) => node.type === 'group' && node.id === step.groupId
    );
    return {
      groupId: step.groupId,
      label: groupNode?.type === 'group' ? groupNode.label : step.label,
      currentRep: step.repeatIndex,
      totalReps: step.repeatTotal,
    };
  }

  /**
   * Calculate target ERG power in watts for a given FTP fraction (or the active step's fraction).
   */
  public getTargetPower(powerFraction?: number): number {
    const fraction = powerFraction ?? this.snapshot?.powerFraction ?? 0;
    return getTargetWatts(fraction, this.ftp, this.intensityOffsetPct);
  }

  public getEffectiveFtp(): number {
    return getEffectiveFtp(this.ftp, this.intensityOffsetPct);
  }

  public getFtp(): number {
    return this.ftp;
  }

  public getIntensityOffsetPct(): number {
    return this.intensityOffsetPct;
  }

  public getRunState(): WorkoutEngineRunState {
    return this.runState;
  }

  public getElapsedSec(): number {
    return this.elapsedSec;
  }

  public getSnapshot(): ActiveStepSnapshot | null {
    return this.snapshot;
  }

  public getState(): WorkoutEngineState {
    return {
      workout: this.workout,
      runState: this.runState,
      elapsedSec: this.elapsedSec,
      ftp: this.ftp,
      intensityOffsetPct: this.intensityOffsetPct,
      effectiveFtp: this.getEffectiveFtp(),
      snapshot: this.snapshot,
      repeatContext: this.getActiveRepeatContext(),
    };
  }

  /**
   * Update rider FTP and immediately recompute target power (emitting ERG update if running).
   */
  public setFtp(rawFtp: number): ActiveStepSnapshot | null {
    this.ftp = clampFtp(rawFtp);
    this.snapshot = this.evaluateAt(this.elapsedSec);
    this.postToWorker({ type: 'SET_CONFIG', ftp: this.ftp });

    if (this.runState === 'running' && this.snapshot) {
      this.callbacks.onErgCommand?.({
        targetWatts: this.snapshot.targetWatts,
        reason: 'config-change',
        nowMs: Date.now(),
      });
    }
    return this.snapshot;
  }

  /**
   * Set exact intensity offset percentage (-50% to +50%).
   */
  public setIntensityOffset(rawOffsetPct: number): ActiveStepSnapshot | null {
    this.intensityOffsetPct = clampIntensityOffset(rawOffsetPct);
    this.snapshot = this.evaluateAt(this.elapsedSec);
    this.postToWorker({ type: 'SET_CONFIG', intensityOffsetPct: this.intensityOffsetPct });

    if (this.runState === 'running' && this.snapshot) {
      this.callbacks.onErgCommand?.({
        targetWatts: this.snapshot.targetWatts,
        reason: 'config-change',
        nowMs: Date.now(),
      });
    }
    return this.snapshot;
  }

  /**
   * Adjust intensity offset relatively (e.g., +1% or -1%).
   */
  public adjustIntensity(deltaPct: number): ActiveStepSnapshot | null {
    return this.setIntensityOffset(this.intensityOffsetPct + deltaPct);
  }

  /**
   * Start or resume the workout clock in the Web Worker.
   */
  public start(): ActiveStepSnapshot | null {
    if (this.runState === 'completed') {
      this.elapsedSec = 0;
    }
    this.runState = 'running';
    this.snapshot = this.evaluateAt(this.elapsedSec);

    const worker = this.ensureWorker();
    if (worker) {
      this.syncWorkoutToWorker();
      worker.postMessage({ type: 'START', elapsedSec: this.elapsedSec });
    } else {
      this.startFallbackTimers();
    }

    if (this.snapshot) {
      this.callbacks.onErgCommand?.({
        targetWatts: this.snapshot.targetWatts,
        reason: 'start',
        nowMs: Date.now(),
      });
    }

    return this.snapshot;
  }

  public pause(): void {
    if (this.runState !== 'running') return;
    this.runState = 'paused';
    this.fallbackClock.pause(Date.now());
    this.postToWorker({ type: 'PAUSE' });
    this.stopFallbackTimers();
  }

  public resume(): ActiveStepSnapshot | null {
    if (this.runState !== 'paused') return this.snapshot;
    return this.start();
  }

  public stop(markCompleted = false): void {
    this.stopClock();
    this.runState = markCompleted ? 'completed' : 'idle';
  }

  public reset(): ActiveStepSnapshot | null {
    this.stopClock();
    this.elapsedSec = 0;
    this.runState = 'idle';
    this.snapshot = this.evaluateAt(0);
    this.syncWorkoutToWorker();
    return this.snapshot;
  }

  /**
   * Seek directly to a workout elapsed time in seconds.
   */
  public seek(elapsedSec: number): ActiveStepSnapshot | null {
    const clamped = Math.max(0, Math.min(this.workout.totalDuration, elapsedSec));
    this.elapsedSec = clamped;
    this.fallbackClock.seek(clamped, Date.now());
    this.snapshot = this.evaluateAt(clamped);
    this.postToWorker({ type: 'SEEK', elapsedSec: clamped });

    if (this.runState === 'running' && this.snapshot) {
      this.callbacks.onErgCommand?.({
        targetWatts: this.snapshot.targetWatts,
        reason: 'seek',
        nowMs: Date.now(),
      });
    }
    return this.snapshot;
  }

  /**
   * Jump directly to a flattened timeline step index.
   */
  public jumpToStep(stepIndex: number): ActiveStepSnapshot | null {
    const timeline = this.workout.timeline;
    if (timeline.length === 0) return null;
    const clampedIdx = Math.max(0, Math.min(timeline.length - 1, stepIndex));
    return this.seek(timeline[clampedIdx].startTime);
  }

  /**
   * Jump to a node in the nested workout tree (either a single step or the start of a repeat group).
   */
  public jumpToNode(nodeId: string): ActiveStepSnapshot | null {
    const node = this.workout.tree.find((n) => n.id === nodeId);
    if (!node) return null;
    const targetStepIndex = node.type === 'group' ? node.firstStepIndex : node.stepIndex;
    return this.jumpToStep(targetStepIndex);
  }

  public skipStep(): ActiveStepSnapshot | null {
    const curIdx = this.snapshot?.stepIndex ?? 0;
    const nextIdx = Math.min(this.workout.timeline.length - 1, curIdx + 1);
    return this.jumpToStep(nextIdx);
  }

  public previousStep(): ActiveStepSnapshot | null {
    if (!this.snapshot) return null;
    // If > 4s into step, restart current step; otherwise jump to previous step
    const targetIdx =
      this.snapshot.stepElapsedSec > 4
        ? this.snapshot.stepIndex
        : Math.max(0, this.snapshot.stepIndex - 1);
    return this.jumpToStep(targetIdx);
  }

  /**
   * Deterministic synchronous tick (used by fallback timers and unit tests).
   */
  public tick(dtSec: number): WorkoutTickEvent | null {
    if (this.runState !== 'running' || dtSec <= 0) return null;

    const prevStepIndex = this.snapshot?.stepIndex ?? -1;
    const nextElapsed = Math.min(this.workout.totalDuration, this.elapsedSec + dtSec);
    this.elapsedSec = nextElapsed;

    const snap = this.evaluateAt(nextElapsed);
    this.snapshot = snap;
    const nowMs = Date.now();

    const stepChanged = snap !== null && prevStepIndex !== -1 && snap.stepIndex !== prevStepIndex;
    const isRamp =
      snap !== null &&
      (snap.step.kind === 'warmup' || snap.step.kind === 'cooldown' || snap.step.kind === 'ramp');
    const shouldSendErg = stepChanged || isRamp;

    if (snap?.isComplete) {
      this.runState = 'completed';
      this.stopClock();
    }

    const event: WorkoutTickEvent = {
      elapsedSec: this.elapsedSec,
      dtSec,
      runState: this.runState,
      snapshot: snap,
      stepChanged,
      shouldSendErg,
      resumeGapSec: dtSec > 1.5 ? dtSec : 0,
      nowMs,
    };

    if (shouldSendErg && snap && !snap.isComplete) {
      this.callbacks.onErgCommand?.({
        targetWatts: snap.targetWatts,
        reason: stepChanged ? 'step-change' : 'ramp',
        nowMs,
      });
    }

    this.callbacks.onStateUpdate?.(event);

    if (snap?.isComplete) {
      this.callbacks.onComplete?.({
        elapsedSec: this.workout.totalDuration,
        snapshot: snap,
        nowMs,
      });
    }

    return event;
  }

  /**
   * Terminate the underlying Web Worker and clear all timers.
   */
  public dispose(): void {
    this.stopClock();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  private evaluateAt(elapsedSec: number): ActiveStepSnapshot | null {
    return evaluateWorkoutAtTime(
      this.workout.timeline,
      elapsedSec,
      this.ftp,
      this.intensityOffsetPct
    );
  }

  private ensureWorker(): WorkerLike | null {
    if (!this.useWorker) return null;
    if (this.worker) return this.worker;

    try {
      if (this.workerFactory) {
        this.worker = this.workerFactory();
      } else if (typeof Worker !== 'undefined') {
        this.worker = new Worker(
          new URL('../workers/workoutEngine.worker.ts', import.meta.url),
          { type: 'module' }
        ) as unknown as WorkerLike;
      }

      if (this.worker) {
        this.worker.onmessage = (event: MessageEvent<WorkoutEngineWorkerEvent>) => {
          this.handleWorkerMessage(event.data);
        };
        this.syncWorkoutToWorker();
      }
    } catch {
      this.worker = null;
    }

    return this.worker;
  }

  private handleWorkerMessage(msg: WorkoutEngineWorkerEvent): void {
    switch (msg.type) {
      case 'STATE_UPDATE': {
        if (this.runState !== 'running' && msg.runState !== 'completed') return;
        this.elapsedSec = msg.elapsedSec;
        this.runState = msg.runState;
        this.snapshot = msg.snapshot;

        if (msg.shouldSendErg && msg.snapshot && msg.runState === 'running') {
          this.callbacks.onErgCommand?.({
            targetWatts: msg.snapshot.targetWatts,
            reason: msg.stepChanged ? 'step-change' : 'ramp',
            nowMs: msg.nowMs,
          });
        }

        this.callbacks.onStateUpdate?.({
          elapsedSec: msg.elapsedSec,
          dtSec: msg.dtSec,
          runState: msg.runState,
          snapshot: msg.snapshot,
          stepChanged: msg.stepChanged,
          shouldSendErg: msg.shouldSendErg,
          resumeGapSec: msg.resumeGapSec,
          nowMs: msg.nowMs,
        });
        break;
      }

      case 'ERG_KEEPALIVE': {
        if (this.runState !== 'running') return;
        this.callbacks.onErgCommand?.({
          targetWatts: msg.targetWatts,
          reason: 'keep-alive',
          nowMs: msg.nowMs,
        });
        break;
      }

      case 'COMPLETED': {
        this.runState = 'completed';
        this.elapsedSec = msg.elapsedSec;
        this.snapshot = msg.snapshot;
        this.callbacks.onComplete?.({
          elapsedSec: msg.elapsedSec,
          snapshot: msg.snapshot,
          nowMs: msg.nowMs,
        });
        break;
      }
    }
  }

  private syncWorkoutToWorker(): void {
    this.postToWorker({
      type: 'LOAD_WORKOUT',
      timeline: this.workout.timeline,
      totalDuration: this.workout.totalDuration,
      ftp: this.ftp,
      intensityOffsetPct: this.intensityOffsetPct,
      elapsedSec: this.elapsedSec,
    });
  }

  private postToWorker(command: WorkoutEngineWorkerCommand): void {
    this.worker?.postMessage(command);
  }

  private startFallbackTimers(): void {
    this.stopFallbackTimers();
    this.fallbackClock.load(this.workout.totalDuration, this.elapsedSec);
    this.fallbackClock.start(Date.now(), this.elapsedSec);
    this.fallbackTickTimer = setInterval(() => {
      const poll = this.fallbackClock.poll(Date.now());
      if (poll.dtSec > 0) {
        this.tick(poll.dtSec);
      }
    }, 1000);
    this.fallbackKeepAliveTimer = setInterval(() => {
      if (this.runState !== 'running' || !this.snapshot) return;
      this.callbacks.onErgCommand?.({
        targetWatts: this.snapshot.targetWatts,
        reason: 'keep-alive',
        nowMs: Date.now(),
      });
    }, 5000);
  }

  private stopFallbackTimers(): void {
    if (this.fallbackTickTimer !== null) {
      clearInterval(this.fallbackTickTimer);
      this.fallbackTickTimer = null;
    }
    if (this.fallbackKeepAliveTimer !== null) {
      clearInterval(this.fallbackKeepAliveTimer);
      this.fallbackKeepAliveTimer = null;
    }
  }

  private stopClock(): void {
    this.postToWorker({ type: 'STOP' });
    this.stopFallbackTimers();
  }
}
