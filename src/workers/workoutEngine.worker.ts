/**
 * Dedicated Web Worker for NeonVelo's high-frequency workout engine.
 *
 * Keeps the workout clock, interval state evaluation, and 5-second ERG keep-alive
 * heartbeat running off the main UI thread so WebGL frame drops or background window
 * throttling never stall elapsed time, interval transitions, or trainer resistance.
 */

import { WorkoutWallClock } from '../core/workoutClock';
import { ActiveStepSnapshot, evaluateWorkoutAtTime } from '../core/workoutEngine';
import { FlattenedStep } from '../core/zwoParser';

export type WorkerRunState = 'idle' | 'running' | 'paused' | 'completed';

export type WorkoutEngineWorkerCommand =
  | {
      type: 'LOAD_WORKOUT';
      timeline: FlattenedStep[];
      totalDuration: number;
      ftp: number;
      intensityOffsetPct: number;
      elapsedSec?: number;
    }
  | { type: 'START'; elapsedSec?: number }
  | { type: 'PAUSE' }
  | { type: 'STOP' }
  | { type: 'SEEK'; elapsedSec: number }
  | { type: 'SET_CONFIG'; ftp?: number; intensityOffsetPct?: number };

export type WorkoutEngineWorkerEvent =
  | {
      type: 'STATE_UPDATE';
      elapsedSec: number;
      dtSec: number;
      runState: WorkerRunState;
      snapshot: ActiveStepSnapshot | null;
      stepChanged: boolean;
      shouldSendErg: boolean;
      resumeGapSec?: number;
      nowMs: number;
    }
  | {
      type: 'ERG_KEEPALIVE';
      targetWatts: number;
      elapsedSec: number;
      nowMs: number;
    }
  | {
      type: 'COMPLETED';
      elapsedSec: number;
      snapshot: ActiveStepSnapshot | null;
      nowMs: number;
    };

const TICK_POLL_MS = 250; // 4 Hz internal wall-clock polling for responsive transitions
const STATE_EMIT_INTERVAL_SEC = 1.0; // 1 Hz telemetry/history state updates (+ immediate on step change or resume gap)
const ERG_KEEPALIVE_MS = 5000; // 5-second FTMS ERG keep-alive heartbeat

const wallClock = new WorkoutWallClock();
let timeline: FlattenedStep[] = [];
let totalDuration = 0;
let ftp = 250;
let intensityOffsetPct = 0;
let elapsedSec = 0;
let runState: WorkerRunState = 'idle';
let lastStepIndex = -1;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let accumulatedEmitSec = 0;

function clearTimers(): void {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function postWorkerEvent(event: WorkoutEngineWorkerEvent): void {
  self.postMessage(event);
}

function emitCurrentState(
  dtSec: number,
  forceErg = false,
  resumeGapSec = 0,
  nowMs = Date.now()
): ActiveStepSnapshot | null {
  const snapshot = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
  const currentStepIndex = snapshot?.stepIndex ?? -1;
  const stepChanged = currentStepIndex !== lastStepIndex && lastStepIndex !== -1;
  lastStepIndex = currentStepIndex;

  const isRamp =
    snapshot !== null &&
    (snapshot.step.kind === 'warmup' ||
      snapshot.step.kind === 'cooldown' ||
      snapshot.step.kind === 'ramp');

  const shouldSendErg = forceErg || stepChanged || (runState === 'running' && isRamp);

  postWorkerEvent({
    type: 'STATE_UPDATE',
    elapsedSec,
    dtSec,
    runState,
    snapshot,
    stepChanged,
    shouldSendErg,
    resumeGapSec,
    nowMs,
  });

  return snapshot;
}

function startTimers(): void {
  clearTimers();
  accumulatedEmitSec = 0;

  tickTimer = setInterval(() => {
    if (runState !== 'running') return;

    const nowMs = Date.now();
    const poll = wallClock.poll(nowMs);
    elapsedSec = poll.elapsedSec;
    if (poll.dtSec <= 0 && !poll.reachedEnd) return;

    accumulatedEmitSec += poll.dtSec;

    const previewSnap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
    const previewStepIdx = previewSnap?.stepIndex ?? -1;
    const stepChangedNow = lastStepIndex !== -1 && previewStepIdx !== lastStepIndex;

    if (poll.reachedEnd) {
      runState = 'completed';
      clearTimers();
      const emitDt = accumulatedEmitSec;
      accumulatedEmitSec = 0;
      const finalSnap = emitCurrentState(emitDt, false, poll.resumeGapSec, nowMs);
      postWorkerEvent({
        type: 'COMPLETED',
        elapsedSec: totalDuration,
        snapshot: finalSnap,
        nowMs,
      });
      return;
    }

    // Emit immediately on step transition, resume gap recovery, or every 1.0s of elapsed workout time
    if (stepChangedNow || poll.resumeGapSec > 0 || accumulatedEmitSec >= STATE_EMIT_INTERVAL_SEC) {
      const emitDt = accumulatedEmitSec;
      accumulatedEmitSec = 0;
      emitCurrentState(emitDt, stepChangedNow, poll.resumeGapSec, nowMs);
    }
  }, TICK_POLL_MS);

  keepAliveTimer = setInterval(() => {
    if (runState !== 'running') return;
    const nowMs = Date.now();
    const poll = wallClock.poll(nowMs);
    elapsedSec = poll.elapsedSec;
    const snap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
    if (!snap) return;
    postWorkerEvent({
      type: 'ERG_KEEPALIVE',
      targetWatts: snap.targetWatts,
      elapsedSec,
      nowMs,
    });
  }, ERG_KEEPALIVE_MS);
}

self.onmessage = (event: MessageEvent<WorkoutEngineWorkerCommand>) => {
  const msg = event.data;
  const nowMs = Date.now();

  switch (msg.type) {
    case 'LOAD_WORKOUT': {
      clearTimers();
      timeline = msg.timeline;
      totalDuration = msg.totalDuration;
      ftp = msg.ftp;
      intensityOffsetPct = msg.intensityOffsetPct;
      const initialElapsed = Math.max(0, Math.min(totalDuration, msg.elapsedSec ?? 0));
      wallClock.load(totalDuration, initialElapsed);
      elapsedSec = wallClock.getElapsedSec();
      runState = 'idle';
      const initialSnap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
      lastStepIndex = initialSnap?.stepIndex ?? -1;
      break;
    }

    case 'START': {
      const overrideElapsed =
        runState === 'completed'
          ? 0
          : typeof msg.elapsedSec === 'number'
            ? msg.elapsedSec
            : undefined;
      elapsedSec = wallClock.start(nowMs, overrideElapsed);
      const startSnap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
      lastStepIndex = startSnap?.stepIndex ?? -1;
      runState = 'running';
      startTimers();
      break;
    }

    case 'PAUSE': {
      if (runState === 'running') {
        elapsedSec = wallClock.pause(nowMs);
        runState = 'paused';
      }
      clearTimers();
      break;
    }

    case 'STOP': {
      wallClock.stop();
      runState = 'idle';
      clearTimers();
      break;
    }

    case 'SEEK': {
      elapsedSec = wallClock.seek(msg.elapsedSec, nowMs);
      accumulatedEmitSec = 0;
      const snap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
      lastStepIndex = snap?.stepIndex ?? -1;
      break;
    }

    case 'SET_CONFIG': {
      if (typeof msg.ftp === 'number') {
        ftp = msg.ftp;
      }
      if (typeof msg.intensityOffsetPct === 'number') {
        intensityOffsetPct = msg.intensityOffsetPct;
      }
      break;
    }
  }
};
