/**
 * Hardware auto-detection, startup micro-benchmark, and adaptive graphics governor.
 *
 * When frame times exceed budget or `PerformanceObserver("longtask")` detects main-thread
 * stalls, the governor degrades rendering strictly in order:
 *   1. DPR (1.5 -> 1.0)
 *   2. Chromatic aberration (off)
 *   3. Bloom (off)
 *   4. Scenery instance counts (100% -> 50%)
 *   5. 30 fps cap
 *
 * The governor NEVER raises quality mid-interval (only during idle, menu, or Z1 recovery).
 */

import type { QualityLevel } from '../store/useAppStore';

export type DegradationStep =
  | 'dpr'
  | 'chromaticAberration'
  | 'bloom'
  | 'scenery'
  | 'fpsCap30';

export const DEGRADATION_ORDER: readonly DegradationStep[] = [
  'dpr',
  'chromaticAberration',
  'bloom',
  'scenery',
  'fpsCap30',
];

export interface HardwareCapabilities {
  isTouchDevice: boolean;
  screenMinDim: number;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  benchmarkMs: number;
}

export interface QualityRecommendation {
  quality: QualityLevel;
  reason: string;
  isCompactPhone: boolean;
  capabilities: HardwareCapabilities;
}

export interface EffectiveRenderConfig {
  baseQuality: QualityLevel;
  degradationStage: number; // 0..5
  activeDegradations: DegradationStep[];
  dprMax: number;
  chromaticAberration: boolean;
  bloom: boolean;
  sceneryScale: number; // 1.0 or 0.5
  fpsCap: 30 | 60;
}

export interface GovernorDiagnostics {
  emaFrameTimeMs: number;
  lastFrameTimeMs: number;
  longTaskCount: number;
  recentLongTasks: number;
  degradationStage: number;
  activeDegradations: DegradationStep[];
  fpsCap: 30 | 60;
}

let cachedBenchmarkMs: number | null = null;

/**
 * Short deterministic startup CPU micro-benchmark (~5–25 ms on modern hardware,
 * noticeably higher under 4x CPU throttle or low-end mobile devices).
 */
export function runStartupMicroBenchmark(iterations = 40_000): number {
  const perf = typeof performance !== 'undefined' ? performance : null;
  const start = perf ? perf.now() : Date.now();
  let acc = 0;
  for (let i = 1; i <= iterations; i++) {
    acc += Math.sin(i * 0.013) * Math.cos(i * 0.007);
  }
  const end = perf ? perf.now() : Date.now();
  // Prevent dead-code elimination
  if (acc === Number.POSITIVE_INFINITY) return 999;
  return Math.max(0.1, end - start);
}

export function gatherHardwareCapabilities(): HardwareCapabilities {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      isTouchDevice: false,
      screenMinDim: 1080,
      hardwareConcurrency: 8,
      deviceMemoryGb: 8,
      benchmarkMs: 3,
    };
  }

  const isTouchDevice =
    'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  const screenW = window.screen?.width || window.innerWidth || 1280;
  const screenH = window.screen?.height || window.innerHeight || 720;
  const screenMinDim = Math.min(screenW, screenH);
  const hardwareConcurrency =
    typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0
      ? navigator.hardwareConcurrency
      : 4;
  const rawMem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const deviceMemoryGb = typeof rawMem === 'number' && rawMem > 0 ? rawMem : null;

  if (cachedBenchmarkMs === null) {
    cachedBenchmarkMs = runStartupMicroBenchmark();
  }

  return {
    isTouchDevice,
    screenMinDim,
    hardwareConcurrency,
    deviceMemoryGb,
    benchmarkMs: cachedBenchmarkMs,
  };
}

/**
 * Auto-detect recommended default quality tier from touch capability, screen size,
 * hardwareConcurrency, deviceMemory, and the startup micro-benchmark.
 */
export function detectRecommendedQuality(
  overrideCaps?: Partial<HardwareCapabilities>
): QualityRecommendation {
  const caps: HardwareCapabilities = {
    ...gatherHardwareCapabilities(),
    ...overrideCaps,
  };

  const isCompactPhone = caps.isTouchDevice && caps.screenMinDim <= 520;

  if (
    caps.hardwareConcurrency <= 2 ||
    (caps.deviceMemoryGb !== null && caps.deviceMemoryGb <= 2) ||
    caps.benchmarkMs >= 26 ||
    (isCompactPhone && caps.hardwareConcurrency <= 4)
  ) {
    return {
      quality: 'low',
      reason: isCompactPhone
        ? 'Compact phone / constrained hardware'
        : `Low CPU/memory budget (${caps.hardwareConcurrency} cores, ${caps.benchmarkMs.toFixed(1)} ms bench)`,
      isCompactPhone,
      capabilities: caps,
    };
  }

  if (
    caps.isTouchDevice ||
    caps.hardwareConcurrency <= 4 ||
    (caps.deviceMemoryGb !== null && caps.deviceMemoryGb <= 4) ||
    caps.benchmarkMs >= 11 ||
    caps.screenMinDim <= 820
  ) {
    return {
      quality: 'medium',
      reason: caps.isTouchDevice
        ? 'Touch tablet / mobile GPU'
        : `Balanced hardware (${caps.hardwareConcurrency} cores, ${caps.benchmarkMs.toFixed(1)} ms bench)`,
      isCompactPhone,
      capabilities: caps,
    };
  }

  return {
    quality: 'high',
    reason: `Desktop / high-performance GPU (${caps.hardwareConcurrency} cores, ${caps.benchmarkMs.toFixed(1)} ms bench)`,
    isCompactPhone,
    capabilities: caps,
  };
}

/**
 * Resolve effective WebGL render switches for a base QualityLevel and governor degradation stage (0..5).
 */
export function getEffectiveRenderConfig(
  baseQuality: QualityLevel,
  degradationStage: number,
  softwareGl = false
): EffectiveRenderConfig {
  const stage = Math.max(0, Math.min(DEGRADATION_ORDER.length, Math.round(degradationStage)));

  let dprMax = softwareGl ? 1 : baseQuality === 'low' ? 1 : 1.5;
  let chromaticAberration = !softwareGl && baseQuality === 'high';
  let bloom = !softwareGl && baseQuality !== 'low';
  let sceneryScale = 1.0;
  let fpsCap: 30 | 60 = baseQuality === 'low' ? 30 : 60;

  const activeDegradations: DegradationStep[] = [];

  if (stage >= 1) {
    dprMax = 1.0;
    activeDegradations.push('dpr');
  }
  if (stage >= 2) {
    chromaticAberration = false;
    activeDegradations.push('chromaticAberration');
  }
  if (stage >= 3) {
    bloom = false;
    activeDegradations.push('bloom');
  }
  if (stage >= 4) {
    sceneryScale = 0.5;
    activeDegradations.push('scenery');
  }
  if (stage >= 5) {
    fpsCap = 30;
    activeDegradations.push('fpsCap30');
  }

  return {
    baseQuality,
    degradationStage: stage,
    activeDegradations,
    dprMax,
    chromaticAberration,
    bloom,
    sceneryScale,
    fpsCap,
  };
}

export interface GraphicsGovernorOptions {
  degradeCooldownMs?: number;
  upgradeHoldMs?: number;
  longTaskWindowMs?: number;
  longTaskTriggerCount?: number;
  frameBudget60Ms?: number;
  frameBudget30Ms?: number;
}

export class GraphicsGovernor {
  private baseQuality: QualityLevel = 'high';
  private stage = 0;
  private emaFrameTimeMs = 16.6;
  private lastFrameTimeMs = 16.6;
  private totalLongTasks = 0;
  private recentLongTaskTimestamps: number[] = [];

  private lastDegradeAtMs = 0;
  private comfortableSinceMs: number | null = null;
  private observer: PerformanceObserver | null = null;
  private listeners = new Set<(config: EffectiveRenderConfig) => void>();

  private readonly degradeCooldownMs: number;
  private readonly upgradeHoldMs: number;
  private readonly longTaskWindowMs: number;
  private readonly longTaskTriggerCount: number;
  private readonly frameBudget60Ms: number;
  private readonly frameBudget30Ms: number;

  constructor(options: GraphicsGovernorOptions = {}) {
    this.degradeCooldownMs = options.degradeCooldownMs ?? 2500;
    this.upgradeHoldMs = options.upgradeHoldMs ?? 8000;
    this.longTaskWindowMs = options.longTaskWindowMs ?? 3000;
    this.longTaskTriggerCount = options.longTaskTriggerCount ?? 2;
    this.frameBudget60Ms = options.frameBudget60Ms ?? 22.5;
    this.frameBudget30Ms = options.frameBudget30Ms ?? 38.0;
  }

  public setBaseQuality(quality: QualityLevel): void {
    if (this.baseQuality === quality) return;
    this.baseQuality = quality;
    this.stage = 0;
    this.comfortableSinceMs = null;
    this.notify();
  }

  public reset(): void {
    this.stage = 0;
    this.emaFrameTimeMs = 16.6;
    this.lastFrameTimeMs = 16.6;
    this.comfortableSinceMs = null;
    this.lastDegradeAtMs = 0;
    this.notify();
  }

  public getStage(): number {
    return this.stage;
  }

  public getConfig(softwareGl = false): EffectiveRenderConfig {
    return getEffectiveRenderConfig(this.baseQuality, this.stage, softwareGl);
  }

  public getDiagnostics(softwareGl = false): GovernorDiagnostics {
    const cfg = this.getConfig(softwareGl);
    return {
      emaFrameTimeMs: Math.round(this.emaFrameTimeMs * 10) / 10,
      lastFrameTimeMs: Math.round(this.lastFrameTimeMs * 10) / 10,
      longTaskCount: this.totalLongTasks,
      recentLongTasks: this.recentLongTaskTimestamps.length,
      degradationStage: this.stage,
      activeDegradations: cfg.activeDegradations,
      fpsCap: cfg.fpsCap,
    };
  }

  public subscribe(listener: (config: EffectiveRenderConfig) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Attach a PerformanceObserver for "longtask" entries (supported in Chromium browsers).
   */
  public startLongTaskObserver(): void {
    if (this.observer || typeof PerformanceObserver === 'undefined') return;
    try {
      const supported = (
        PerformanceObserver as unknown as { supportedEntryTypes?: string[] }
      ).supportedEntryTypes;
      if (supported && !supported.includes('longtask')) return;

      this.observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const now = Date.now();
        for (let i = 0; i < entries.length; i++) {
          this.recordLongTask(entries[i].duration, now);
        }
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch {
      this.observer = null;
    }
  }

  public stopLongTaskObserver(): void {
    if (this.observer) {
      try {
        this.observer.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.observer = null;
    }
  }

  public recordLongTask(durationMs: number, nowMs = Date.now()): void {
    if (durationMs < 50) return;
    this.totalLongTasks += 1;
    this.recentLongTaskTimestamps.push(nowMs);
    this.pruneLongTasks(nowMs);
  }

  /**
   * Record a rendered frame duration and evaluate whether to step down quality.
   * `isMidInterval` MUST be true during active workout intervals (Z2+) so the governor
   * never raises quality mid-interval.
   */
  public recordFrame(
    frameTimeMs: number,
    nowMs = Date.now(),
    ctx: { isMidInterval: boolean; softwareGl?: boolean } = { isMidInterval: false }
  ): EffectiveRenderConfig {
    const clamped = Math.max(1, Math.min(250, frameTimeMs));
    this.lastFrameTimeMs = clamped;
    this.emaFrameTimeMs = this.emaFrameTimeMs * 0.88 + clamped * 0.12;
    this.pruneLongTasks(nowMs);

    const currentCfg = this.getConfig(Boolean(ctx.softwareGl));
    const budgetMs = currentCfg.fpsCap === 30 ? this.frameBudget30Ms : this.frameBudget60Ms;
    const overBudget =
      this.emaFrameTimeMs > budgetMs ||
      this.recentLongTaskTimestamps.length >= this.longTaskTriggerCount;

    if (overBudget) {
      this.comfortableSinceMs = null;
      if (
        this.stage < DEGRADATION_ORDER.length &&
        (this.lastDegradeAtMs === 0 || nowMs - this.lastDegradeAtMs >= this.degradeCooldownMs)
      ) {
        this.stage = this.nextApplicableStage(this.stage);
        this.lastDegradeAtMs = nowMs;
        this.recentLongTaskTimestamps.length = 0;
        this.notify();
      }
      return this.getConfig(Boolean(ctx.softwareGl));
    }

    // Never raise quality mid-interval; only recover gently during idle / menu / Z1 recovery
    if (ctx.isMidInterval) {
      this.comfortableSinceMs = null;
      return currentCfg;
    }

    if (
      this.stage > 0 &&
      this.emaFrameTimeMs < 13.5 &&
      this.recentLongTaskTimestamps.length === 0
    ) {
      if (this.comfortableSinceMs === null) {
        this.comfortableSinceMs = nowMs;
      } else if (nowMs - this.comfortableSinceMs >= this.upgradeHoldMs) {
        this.stage = Math.max(0, this.stage - 1);
        this.comfortableSinceMs = nowMs;
        this.notify();
      }
    } else {
      this.comfortableSinceMs = null;
    }

    return this.getConfig(Boolean(ctx.softwareGl));
  }

  /**
   * Advance strictly along the ordered ladder:
   *   1: DPR -> 2: Chromatic Aberration -> 3: Bloom -> 4: Scenery -> 5: 30 fps cap
   * Skips stages that are already disabled by the base quality preset so each step
   * produces an immediate measurable cost reduction.
   */
  private nextApplicableStage(currentStage: number): number {
    const before = getEffectiveRenderConfig(this.baseQuality, currentStage, false);
    for (let next = currentStage + 1; next <= DEGRADATION_ORDER.length; next++) {
      const candidate = getEffectiveRenderConfig(this.baseQuality, next, false);
      if (
        candidate.dprMax !== before.dprMax ||
        candidate.chromaticAberration !== before.chromaticAberration ||
        candidate.bloom !== before.bloom ||
        candidate.sceneryScale !== before.sceneryScale ||
        candidate.fpsCap !== before.fpsCap
      ) {
        return next;
      }
    }
    return DEGRADATION_ORDER.length;
  }

  private pruneLongTasks(nowMs: number): void {
    const cutoff = nowMs - this.longTaskWindowMs;
    while (
      this.recentLongTaskTimestamps.length > 0 &&
      this.recentLongTaskTimestamps[0] < cutoff
    ) {
      this.recentLongTaskTimestamps.shift();
    }
  }

  private notify(): void {
    const cfg = this.getConfig(false);
    this.listeners.forEach((cb) => cb(cfg));
  }
}

export const graphicsGovernor = new GraphicsGovernor();
