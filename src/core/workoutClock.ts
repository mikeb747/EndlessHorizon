/**
 * Wall-clock anchored workout timer with pause accounting and resume-gap reporting.
 *
 * Replaces clamped delta accumulation (which lost elapsed time during background tab
 * throttling or CPU stalls) with an exact wall-clock anchor:
 *   elapsedSec = baseElapsedSec + (nowMs - anchorWallMs - accumulatedPausedMs) / 1000
 */

export interface WorkoutClockPollResult {
  elapsedSec: number;
  dtSec: number;
  /** Non-zero when wall-clock time jumped by > 1.5 s between polls (e.g. tab sleep/throttle). */
  resumeGapSec: number;
  reachedEnd: boolean;
}

export const RESUME_GAP_THRESHOLD_SEC = 1.5;

export class WorkoutWallClock {
  private totalDurationSec = 0;
  private baseElapsedSec = 0;
  private elapsedSec = 0;
  private anchorWallMs: number | null = null;
  private accumulatedPausedMs = 0;
  private pausedAtWallMs: number | null = null;
  private lastPollWallMs: number | null = null;
  private running = false;

  public load(totalDurationSec: number, initialElapsedSec = 0): void {
    this.totalDurationSec = Math.max(0, totalDurationSec);
    this.baseElapsedSec = this.clampElapsed(initialElapsedSec);
    this.elapsedSec = this.baseElapsedSec;
    this.anchorWallMs = null;
    this.accumulatedPausedMs = 0;
    this.pausedAtWallMs = null;
    this.lastPollWallMs = null;
    this.running = false;
  }

  public start(nowMs: number, overrideElapsedSec?: number): number {
    if (typeof overrideElapsedSec === 'number') {
      this.baseElapsedSec = this.clampElapsed(overrideElapsedSec);
      this.elapsedSec = this.baseElapsedSec;
      this.anchorWallMs = nowMs;
      this.accumulatedPausedMs = 0;
      this.pausedAtWallMs = null;
    } else if (this.anchorWallMs === null) {
      this.anchorWallMs = nowMs;
      this.accumulatedPausedMs = 0;
      this.pausedAtWallMs = null;
    } else if (this.pausedAtWallMs !== null) {
      this.accumulatedPausedMs += Math.max(0, nowMs - this.pausedAtWallMs);
      this.pausedAtWallMs = null;
    }
    this.lastPollWallMs = nowMs;
    this.running = true;
    return this.elapsedSec;
  }

  public pause(nowMs: number): number {
    if (this.running) {
      this.syncElapsedFromWall(nowMs);
      this.pausedAtWallMs = nowMs;
      this.running = false;
    }
    return this.elapsedSec;
  }

  public stop(): void {
    this.running = false;
    this.anchorWallMs = null;
    this.accumulatedPausedMs = 0;
    this.pausedAtWallMs = null;
    this.lastPollWallMs = null;
    this.baseElapsedSec = this.elapsedSec;
  }

  public seek(targetElapsedSec: number, nowMs: number): number {
    const clamped = this.clampElapsed(targetElapsedSec);
    this.baseElapsedSec = clamped;
    this.elapsedSec = clamped;
    this.accumulatedPausedMs = 0;
    if (this.running) {
      this.anchorWallMs = nowMs;
      this.pausedAtWallMs = null;
      this.lastPollWallMs = nowMs;
    } else {
      this.anchorWallMs = null;
      this.pausedAtWallMs = null;
      this.lastPollWallMs = null;
    }
    return this.elapsedSec;
  }

  public poll(nowMs: number): WorkoutClockPollResult {
    if (!this.running || this.anchorWallMs === null) {
      return {
        elapsedSec: this.elapsedSec,
        dtSec: 0,
        resumeGapSec: 0,
        reachedEnd: this.totalDurationSec > 0 && this.elapsedSec >= this.totalDurationSec,
      };
    }

    const prevElapsed = this.elapsedSec;
    const prevPollWallMs = this.lastPollWallMs ?? nowMs;
    const rawWallDtSec = Math.max(0, (nowMs - prevPollWallMs) / 1000);
    this.lastPollWallMs = nowMs;

    this.syncElapsedFromWall(nowMs);
    const dtSec = Math.max(0, this.elapsedSec - prevElapsed);
    const resumeGapSec = rawWallDtSec > RESUME_GAP_THRESHOLD_SEC ? rawWallDtSec : 0;
    const reachedEnd = this.totalDurationSec > 0 && this.elapsedSec >= this.totalDurationSec;

    if (reachedEnd) {
      this.running = false;
    }

    return {
      elapsedSec: this.elapsedSec,
      dtSec,
      resumeGapSec,
      reachedEnd,
    };
  }

  public getElapsedSec(): number {
    return this.elapsedSec;
  }

  public getAccumulatedPausedMs(): number {
    return this.accumulatedPausedMs;
  }

  public isRunning(): boolean {
    return this.running;
  }

  private syncElapsedFromWall(nowMs: number): void {
    if (this.anchorWallMs === null) return;
    const activeWallMs = Math.max(0, nowMs - this.anchorWallMs - this.accumulatedPausedMs);
    this.elapsedSec = this.clampElapsed(this.baseElapsedSec + activeWallMs / 1000);
  }

  private clampElapsed(sec: number): number {
    const safe = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    if (this.totalDurationSec > 0) {
      return Math.min(this.totalDurationSec, safe);
    }
    return safe;
  }
}
