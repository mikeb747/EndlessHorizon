/**
 * Zero-allocation, plain module-level typed-array ring buffers for live BLE telemetry,
 * 1 Hz ride history plotting, and O(1) incremental TSS computation.
 *
 * Written directly inside Web Bluetooth notification handlers without calling React/Zustand
 * setState or allocating objects per packet, decoupling ride recording and 3D rendering from
 * main-thread React re-renders.
 */

import { CadenceSource } from '../devices/types';

export const TELEMETRY_RING_CAPACITY = 256;
export const POWER_3S_RING_CAPACITY = 64;
export const RIDE_HISTORY_CAPACITY = 14400; // 4 hours at 1 Hz

export interface TelemetryRingReadout {
  power: number;
  heartRate: number;
  cadence: number;
  speedKmh: number;
  timestampMs: number;
}

/**
 * Plain module-level ring buffer + latest-value slots updated directly by BLE/sim handlers.
 * Performs zero heap allocations on every incoming packet.
 */
export class LiveTelemetryBuffer {
  public readonly capacity = TELEMETRY_RING_CAPACITY;
  public readonly powerBuf = new Float32Array(TELEMETRY_RING_CAPACITY);
  public readonly hrBuf = new Float32Array(TELEMETRY_RING_CAPACITY);
  public readonly cadenceBuf = new Float32Array(TELEMETRY_RING_CAPACITY);
  public readonly speedBuf = new Float32Array(TELEMETRY_RING_CAPACITY);
  public readonly tsBuf = new Float64Array(TELEMETRY_RING_CAPACITY);

  private writeIdx = 0;
  private ringCount = 0;

  // Zero-allocation 3-second rolling power average ring
  private readonly p3Vals = new Float32Array(POWER_3S_RING_CAPACITY);
  private readonly p3Ts = new Float64Array(POWER_3S_RING_CAPACITY);
  private p3Head = 0;
  private p3Tail = 0;
  private p3Count = 0;
  private p3Sum = 0;
  private readonly p3WindowMs: number;

  // Latest-value slots read directly by the 3D scene loop, recorder, and 4 Hz HUD sync
  public instantPower = 0;
  public power3sAvg = 0;
  public heartRate = 68;
  public cadence = 0;
  public cadenceSensorRpm = 0;
  public cadenceTimestampMs = 0;
  public cadenceSource: CadenceSource = 'none';
  public speedKmh = 0;

  // Arrival timestamps per sensor stream (wall-clock ms)
  public lastTrainerMs = 0;
  public lastHrMs = 0;
  public lastCadenceMs = 0;

  // Dirty flag consumed by the ~4 Hz HUD sync loop
  public dirty = false;

  constructor(powerWindowMs = 3000) {
    this.p3WindowMs = powerWindowMs;
  }

  private appendRingSnapshot(timestampMs: number): void {
    const idx = this.writeIdx;
    this.powerBuf[idx] = this.instantPower;
    this.hrBuf[idx] = this.heartRate;
    this.cadenceBuf[idx] = this.cadence;
    this.speedBuf[idx] = this.speedKmh;
    this.tsBuf[idx] = timestampMs;
    this.writeIdx = (idx + 1) % this.capacity;
    if (this.ringCount < this.capacity) {
      this.ringCount += 1;
    }
  }

  private pushRollingPower(watts: number, timestampMs: number): number {
    // Evict oldest if full
    if (this.p3Count >= POWER_3S_RING_CAPACITY) {
      this.p3Sum -= this.p3Vals[this.p3Head];
      this.p3Head = (this.p3Head + 1) % POWER_3S_RING_CAPACITY;
      this.p3Count -= 1;
    }
    this.p3Vals[this.p3Tail] = watts;
    this.p3Ts[this.p3Tail] = timestampMs;
    this.p3Tail = (this.p3Tail + 1) % POWER_3S_RING_CAPACITY;
    this.p3Count += 1;
    this.p3Sum += watts;

    const cutoff = timestampMs - this.p3WindowMs;
    while (this.p3Count > 1 && this.p3Ts[this.p3Head] < cutoff) {
      this.p3Sum -= this.p3Vals[this.p3Head];
      this.p3Head = (this.p3Head + 1) % POWER_3S_RING_CAPACITY;
      this.p3Count -= 1;
    }

    return this.p3Count > 0 ? Math.round(this.p3Sum / this.p3Count) : 0;
  }

  public pushTrainer(
    instantPower: number,
    trainerCadence: number,
    speedKmh: number,
    timestampMs: number,
    trainerCadenceSource: CadenceSource,
    dedicatedCadenceConnected: boolean
  ): void {
    this.instantPower = instantPower;
    this.power3sAvg = this.pushRollingPower(instantPower, timestampMs);
    this.speedKmh = speedKmh;
    this.lastTrainerMs = timestampMs;

    if (!dedicatedCadenceConnected) {
      this.cadence = Math.round(trainerCadence);
      this.cadenceTimestampMs = timestampMs;
      this.cadenceSource = trainerCadenceSource;
    }

    this.appendRingSnapshot(timestampMs);
    this.dirty = true;
  }

  public pushHeartRate(heartRate: number, timestampMs: number): void {
    this.heartRate = heartRate;
    this.lastHrMs = timestampMs;
    this.appendRingSnapshot(timestampMs);
    this.dirty = true;
  }

  public pushCadence(cadenceRpm: number, timestampMs: number): void {
    const rounded = Math.round(cadenceRpm);
    this.cadenceSensorRpm = rounded;
    this.cadence = rounded;
    this.cadenceTimestampMs = timestampMs;
    this.cadenceSource = 'ble-cadence';
    this.lastCadenceMs = timestampMs;
    this.appendRingSnapshot(timestampMs);
    this.dirty = true;
  }

  public resetRollingPower(): void {
    this.p3Head = 0;
    this.p3Tail = 0;
    this.p3Count = 0;
    this.p3Sum = 0;
    this.power3sAvg = 0;
  }

  public clearTrainer(dedicatedCadenceConnected: boolean): void {
    this.resetRollingPower();
    this.instantPower = 0;
    this.speedKmh = 0;
    if (!dedicatedCadenceConnected) {
      this.cadence = 0;
      this.cadenceTimestampMs = 0;
    }
    this.dirty = true;
  }

  public clearHeartRate(): void {
    this.heartRate = 0;
    this.dirty = true;
  }

  public clearCadence(trainerConnected: boolean): void {
    this.cadenceSensorRpm = 0;
    if (!trainerConnected) {
      this.cadence = 0;
      this.cadenceTimestampMs = 0;
    }
    this.dirty = true;
  }

  public clearAll(): void {
    this.resetRollingPower();
    this.instantPower = 0;
    this.power3sAvg = 0;
    this.heartRate = 0;
    this.cadence = 0;
    this.cadenceSensorRpm = 0;
    this.cadenceTimestampMs = 0;
    this.speedKmh = 0;
    this.dirty = true;
  }

  public getRingCount(): number {
    return this.ringCount;
  }

  /**
   * Read the N-th sample back from the most recent arrival (0 = latest) into `out`
   * without allocating a new object. Returns false if out of bounds.
   */
  public readLatest(offsetFromLatest: number, out: TelemetryRingReadout): boolean {
    if (offsetFromLatest < 0 || offsetFromLatest >= this.ringCount) return false;
    const idx = (this.writeIdx - 1 - offsetFromLatest + this.capacity * 2) % this.capacity;
    out.power = this.powerBuf[idx];
    out.heartRate = this.hrBuf[idx];
    out.cadence = this.cadenceBuf[idx];
    out.speedKmh = this.speedBuf[idx];
    out.timestampMs = this.tsBuf[idx];
    return true;
  }
}

/**
 * Preallocated typed-array 1 Hz history buffer for Telemetry Graph and Ride Summary.
 * Eliminates O(N) array spread copies (`[...state.history, sample]`) every second.
 */
export class RideHistoryBuffer {
  public readonly capacity = RIDE_HISTORY_CAPACITY;
  public readonly timeSec = new Int32Array(RIDE_HISTORY_CAPACITY);
  public readonly power = new Uint16Array(RIDE_HISTORY_CAPACITY);
  public readonly heartRate = new Uint16Array(RIDE_HISTORY_CAPACITY);
  public readonly targetWatts = new Uint16Array(RIDE_HISTORY_CAPACITY);
  public readonly cadence = new Uint16Array(RIDE_HISTORY_CAPACITY);

  public length = 0;
  public version = 0;
  public peakPower = 0;
  private powerSum = 0;
  private hrSum = 0;
  private hrCount = 0;

  public reset(): void {
    this.length = 0;
    this.peakPower = 0;
    this.powerSum = 0;
    this.hrSum = 0;
    this.hrCount = 0;
    this.version += 1;
  }

  public push(
    timeSec: number,
    power: number,
    heartRate: number,
    targetWatts: number,
    cadence: number
  ): void {
    const t = Math.max(0, Math.round(timeSec));
    const p = Math.max(0, Math.min(65535, Math.round(power)));
    const hr = Math.max(0, Math.min(65535, Math.round(heartRate)));
    const tgt = Math.max(0, Math.min(65535, Math.round(targetWatts)));
    const cad = Math.max(0, Math.min(65535, Math.round(cadence)));

    if (this.length > 0 && this.timeSec[this.length - 1] === t) {
      const idx = this.length - 1;
      const oldP = this.power[idx];
      const oldHr = this.heartRate[idx];
      this.powerSum += p - oldP;
      if (oldHr > 0) {
        this.hrSum -= oldHr;
        this.hrCount -= 1;
      }
      if (hr > 0) {
        this.hrSum += hr;
        this.hrCount += 1;
      }
      this.power[idx] = p;
      this.heartRate[idx] = hr;
      this.targetWatts[idx] = tgt;
      this.cadence[idx] = cad;
      if (p > this.peakPower) this.peakPower = p;
      if (tgt > this.peakPower) this.peakPower = tgt;
      this.version += 1;
      return;
    }

    if (this.length >= this.capacity) {
      // Shift left by 1 only if a ride exceeds 4 continuous hours
      const droppedP = this.power[0];
      const droppedHr = this.heartRate[0];
      this.powerSum -= droppedP;
      if (droppedHr > 0) {
        this.hrSum -= droppedHr;
        this.hrCount -= 1;
      }
      this.timeSec.copyWithin(0, 1);
      this.power.copyWithin(0, 1);
      this.heartRate.copyWithin(0, 1);
      this.targetWatts.copyWithin(0, 1);
      this.cadence.copyWithin(0, 1);
      this.length = this.capacity - 1;
    }

    const idx = this.length;
    this.timeSec[idx] = t;
    this.power[idx] = p;
    this.heartRate[idx] = hr;
    this.targetWatts[idx] = tgt;
    this.cadence[idx] = cad;
    this.length += 1;

    this.powerSum += p;
    if (hr > 0) {
      this.hrSum += hr;
      this.hrCount += 1;
    }
    if (p > this.peakPower) this.peakPower = p;
    if (tgt > this.peakPower) this.peakPower = tgt;
    this.version += 1;
  }

  public getAvgPower(): number {
    return this.length > 0 ? Math.round(this.powerSum / this.length) : 0;
  }

  public getAvgHeartRate(): number {
    return this.hrCount > 0 ? Math.round(this.hrSum / this.hrCount) : 0;
  }
}

/**
 * O(1) incremental TSS & Normalized Power tracker using a preallocated 30-second
 * Float32Array circular window. Produces identical results to batch `calculateLiveTss`
 * without storing or copying a growing `powerSamples1Hz` array.
 */
export class IncrementalTssTracker {
  private readonly windowSize = 30;
  private readonly windowBuf = new Float32Array(30);
  private head = 0;
  private rollingSum = 0;
  private totalSum = 0;
  private fourthPowerSum = 0;
  private windowCount = 0;
  private sampleCount = 0;

  public reset(): void {
    this.windowBuf.fill(0);
    this.head = 0;
    this.rollingSum = 0;
    this.totalSum = 0;
    this.fourthPowerSum = 0;
    this.windowCount = 0;
    this.sampleCount = 0;
  }

  public pushPower(watts: number): void {
    const w = Number.isFinite(watts) ? Math.max(0, watts) : 0;
    if (this.sampleCount < this.windowSize) {
      this.windowBuf[this.sampleCount] = w;
      this.rollingSum += w;
      this.totalSum += w;
      this.sampleCount += 1;
      if (this.sampleCount === this.windowSize) {
        const avg = this.rollingSum / this.windowSize;
        this.fourthPowerSum += Math.pow(avg, 4);
        this.windowCount = 1;
      }
      return;
    }

    const evicted = this.windowBuf[this.head];
    this.windowBuf[this.head] = w;
    this.head = (this.head + 1) % this.windowSize;
    this.rollingSum += w - evicted;
    this.totalSum += w;
    this.sampleCount += 1;

    const avg = this.rollingSum / this.windowSize;
    this.fourthPowerSum += Math.pow(avg, 4);
    this.windowCount += 1;
  }

  public hydrateFromSamples(samples: ArrayLike<number>): void {
    this.reset();
    for (let i = 0; i < samples.length; i++) {
      this.pushPower(samples[i]);
    }
  }

  public getSampleCount(): number {
    return this.sampleCount;
  }

  public getNormalizedPower(): number {
    if (this.sampleCount === 0) return 0;
    if (this.sampleCount < this.windowSize) {
      return this.totalSum / this.sampleCount;
    }
    return this.windowCount > 0 ? Math.pow(this.fourthPowerSum / this.windowCount, 0.25) : 0;
  }

  public getLiveTss(ftp: number): number {
    if (this.sampleCount === 0 || ftp <= 0) return 0;
    const np = this.getNormalizedPower();
    const intensityFactor = np / ftp;
    const tss = ((this.sampleCount * np * intensityFactor) / (ftp * 3600)) * 100;
    return Math.round(tss * 10) / 10;
  }
}

export const liveTelemetryBuffer = new LiveTelemetryBuffer(3000);
export const rideHistoryBuffer = new RideHistoryBuffer();
export const liveTssTracker = new IncrementalTssTracker();
