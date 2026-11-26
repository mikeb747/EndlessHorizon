/**
 * Pure auto-pause state evaluation for detecting when the rider stops pedalling
 * (power === 0 and cadence === 0) for at least 5 consecutive seconds.
 */

export const AUTO_PAUSE_DELAY_SEC = 5;

export interface AutoPauseEvalInput {
  enabled: boolean;
  isRunning: boolean;
  isAutoPaused: boolean;
  instantPower: number;
  cadence: number;
  dtSec: number;
  zeroPedalSec: number;
}

export interface AutoPauseEvalResult {
  zeroPedalSec: number;
  shouldAutoPause: boolean;
  shouldAutoResume: boolean;
}

export function evaluateAutoPause(input: AutoPauseEvalInput): AutoPauseEvalResult {
  if (!input.enabled) {
    return {
      zeroPedalSec: 0,
      shouldAutoPause: false,
      shouldAutoResume: false,
    };
  }

  const isStopped = input.instantPower <= 0 && input.cadence <= 0;

  if (input.isRunning) {
    if (isStopped) {
      const nextZero = input.zeroPedalSec + Math.max(0, input.dtSec);
      return {
        zeroPedalSec: nextZero,
        shouldAutoPause: nextZero >= AUTO_PAUSE_DELAY_SEC,
        shouldAutoResume: false,
      };
    }
    return {
      zeroPedalSec: 0,
      shouldAutoPause: false,
      shouldAutoResume: false,
    };
  }

  if (input.isAutoPaused && !isStopped) {
    return {
      zeroPedalSec: 0,
      shouldAutoPause: false,
      shouldAutoResume: true,
    };
  }

  return {
    zeroPedalSec: input.zeroPedalSec,
    shouldAutoPause: false,
    shouldAutoResume: false,
  };
}
