import { FlattenedStep } from './zwoParser';
import { getPowerZone, getTargetWatts, PowerZoneInfo } from './zones';

export interface ActiveStepSnapshot {
  step: FlattenedStep;
  stepIndex: number;
  stepElapsedSec: number;
  stepRemainingSec: number;
  stepProgress: number; // 0..1
  powerFraction: number; // interpolated fraction before intensity offset
  targetWatts: number;
  zone: PowerZoneInfo;
  nextStep: FlattenedStep | null;
  countdownSec: number | null; // 5..1 when <= 5s remain before step change
  isComplete: boolean;
}

/**
 * Evaluate exact step state and interpolated ramp power at a given workout elapsed time.
 */
export function evaluateWorkoutAtTime(
  timeline: FlattenedStep[],
  elapsedSec: number,
  ftp: number,
  intensityOffsetPct: number
): ActiveStepSnapshot | null {
  if (timeline.length === 0) return null;

  const totalDuration = timeline[timeline.length - 1].endTime;
  const clampedElapsed = Math.max(0, Math.min(elapsedSec, totalDuration));
  const isComplete = elapsedSec >= totalDuration;

  let activeIndex = timeline.length - 1;
  for (let i = 0; i < timeline.length; i++) {
    if (clampedElapsed < timeline[i].endTime) {
      activeIndex = i;
      break;
    }
  }

  const step = timeline[activeIndex];
  const stepElapsedSec = Math.max(0, Math.min(step.duration, clampedElapsed - step.startTime));
  const stepRemainingSec = Math.max(0, step.duration - stepElapsedSec);
  const stepProgress = step.duration > 0 ? Math.min(1, stepElapsedSec / step.duration) : 1;

  // Interpolate continuously for Warmup / Cooldown / Ramp steps
  const powerFraction =
    step.powerLow === step.powerHigh
      ? step.powerLow
      : step.powerLow + (step.powerHigh - step.powerLow) * stepProgress;

  const zone = getPowerZone(powerFraction);
  const targetWatts = getTargetWatts(powerFraction, ftp, intensityOffsetPct);
  const nextStep = activeIndex + 1 < timeline.length ? timeline[activeIndex + 1] : null;

  const ceilRemaining = Math.ceil(stepRemainingSec);
  const countdownSec =
    !isComplete && nextStep !== null && ceilRemaining <= 5 && ceilRemaining >= 1
      ? ceilRemaining
      : null;

  return {
    step,
    stepIndex: activeIndex,
    stepElapsedSec,
    stepRemainingSec,
    stepProgress,
    powerFraction,
    targetWatts,
    zone,
    nextStep,
    countdownSec,
    isComplete,
  };
}

/**
 * 3-second rolling average power calculator (samples timestamped in ms).
 */
export class RollingPowerBuffer {
  private readonly windowMs: number;
  private samples: Array<{ t: number; watts: number }> = [];

  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
  }

  push(watts: number, timestampMs: number): number {
    this.samples.push({ t: timestampMs, watts });
    const cutoff = timestampMs - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
    return this.getAverage();
  }

  getAverage(): number {
    if (this.samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) {
      sum += this.samples[i].watts;
    }
    return Math.round(sum / this.samples.length);
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Live TSS estimate from instantaneous power samples (1 Hz).
 * Uses 30-second rolling average fourth-power Normalized Power when enough samples exist.
 */
export function calculateLiveTss(powerSamples1Hz: number[], ftp: number): number {
  if (powerSamples1Hz.length === 0 || ftp <= 0) return 0;
  const n = powerSamples1Hz.length;

  let fourthSum = 0;
  let count = 0;
  let rollingSum = 0;
  const windowSize = Math.min(30, n);

  for (let i = 0; i < n; i++) {
    rollingSum += powerSamples1Hz[i];
    if (i >= windowSize) {
      rollingSum -= powerSamples1Hz[i - windowSize];
    }
    if (i >= windowSize - 1) {
      const avg = rollingSum / windowSize;
      fourthSum += Math.pow(avg, 4);
      count++;
    }
  }

  const np = count > 0 ? Math.pow(fourthSum / count, 0.25) : 0;
  const intensityFactor = np / ftp;
  const tss = ((n * np * intensityFactor) / (ftp * 3600)) * 100;
  return Math.round(tss * 10) / 10;
}

/**
 * Convert mechanical work done in kilojoules (kJ) into estimated Calories (kcal).
 * On a bicycle (~24% human gross efficiency), 1 kJ mechanical work ≈ 1 kcal burned.
 */
export function calculateCaloriesFromKj(workKj: number): number {
  return Math.max(0, Math.round(workKj));
}
