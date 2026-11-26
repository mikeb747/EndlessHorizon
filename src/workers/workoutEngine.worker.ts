/**
 * Dedicated Web Worker for NeonVelo's high-frequency workout engine.
 *
 * Keeps the workout clock, interval state evaluation, and 5-second ERG keep-alive
 * heartbeat running off the main UI thread so WebGL frame drops or background window
 * throttling never stall elapsed time, interval transitions, or trainer resistance.
 */

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

const TICK_POLL_MS = 250; // 4 Hz internal drift-compensated polling for responsive transitions
const STATE_EMIT_INTERVAL_SEC = 1.0; // 1 Hz telemetry/history state updates (+ immediate on step change)
const ERG_KEEPALIVE_MS = 5000; // 5-second FTMS ERG keep-alive heartbeat

let timeline: FlattenedStep[] = [];
let totalDuration = 0;
let ftp = 250;
let intensityOffsetPct = 0;
let elapsedSec = 0;
let runState: WorkerRunState = 'idle';
let lastStepIndex = -1;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let lastPollPerfMs = 0;
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

function emitCurrentState(dtSec: number, forceErg = false): ActiveStepSnapshot | null {
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
    nowMs: Date.now(),
  });

  return snapshot;
}

function startTimers(): void {
  clearTimers();
  lastPollPerfMs = performance.now();
  accumulatedEmitSec = 0;

  tickTimer = setInterval(() => {
    if (runState !== 'running') return;

    const nowPerf = performance.now();
    const rawDtSec = Math.max(0, Math.min(2.0, (nowPerf - lastPollPerfMs) / 1000));
    lastPollPerfMs = nowPerf;
    if (rawDtSec <= 0) return;

    const prevElapsed = elapsedSec;
    elapsedSec = Math.min(totalDuration, elapsedSec + rawDtSec);
    accumulatedEmitSec += elapsedSec - prevElapsed;

    const previewSnap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
    const previewStepIdx = previewSnap?.stepIndex ?? -1;
    const stepChangedNow = lastStepIndex !== -1 && previewStepIdx !== lastStepIndex;
    const reachedEnd = totalDuration > 0 && elapsedSec >= totalDuration;

    if (reachedEnd) {
      runState = 'completed';
      clearTimers();
      const emitDt = accumulatedEmitSec;
      accumulatedEmitSec = 0;
      const finalSnap = emitCurrentState(emitDt, false);
      postWorkerEvent({
        type: 'COMPLETED',
        elapsedSec: totalDuration,
        snapshot: finalSnap,
        nowMs: Date.now(),
      });
      return;
    }

    // Emit immediately on step transition or every 1.0s of elapsed workout time
    if (stepChangedNow || accumulatedEmitSec >= STATE_EMIT_INTERVAL_SEC) {
      const emitDt = accumulatedEmitSec;
      accumulatedEmitSec = 0;
      emitCurrentState(emitDt, stepChangedNow);
    }
  }, TICK_POLL_MS);

  keepAliveTimer = setInterval(() => {
    if (runState !== 'running') return;
    const snap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
    if (!snap) return;
    postWorkerEvent({
      type: 'ERG_KEEPALIVE',
      targetWatts: snap.targetWatts,
      elapsedSec,
      nowMs: Date.now(),
    });
  }, ERG_KEEPALIVE_MS);
}

self.onmessage = (event: MessageEvent<WorkoutEngineWorkerCommand>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'LOAD_WORKOUT': {
      clearTimers();
      timeline = msg.timeline;
      totalDuration = msg.totalDuration;
      ftp = msg.ftp;
      intensityOffsetPct = msg.intensityOffsetPct;
      elapsedSec = Math.max(0, Math.min(totalDuration, msg.elapsedSec ?? 0));
      runState = 'idle';
      const initialSnap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
      lastStepIndex = initialSnap?.stepIndex ?? -1;
      break;
    }

    case 'START': {
      if (typeof msg.elapsedSec === 'number') {
        elapsedSec = Math.max(0, Math.min(totalDuration, msg.elapsedSec));
      }
      if (runState === 'completed') {
        elapsedSec = 0;
      }
      const startSnap = evaluateWorkoutAtTime(timeline, elapsedSec, ftp, intensityOffsetPct);
      lastStepIndex = startSnap?.stepIndex ?? -1;
      runState = 'running';
      startTimers();
      break;
    }

    case 'PAUSE': {
      if (runState === 'running') {
        runState = 'paused';
      }
      clearTimers();
      break;
    }

    case 'STOP': {
      runState = 'idle';
      clearTimers();
      break;
    }

    case 'SEEK': {
      elapsedSec = Math.max(0, Math.min(totalDuration, msg.elapsedSec));
      accumulatedEmitSec = 0;
      lastPollPerfMs = performance.now();
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
