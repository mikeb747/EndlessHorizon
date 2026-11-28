/**
 * Stateful ride telemetry recorder that captures 1 Hz Bluetooth/simulated device
 * streams (heart rate, power, cadence, speed), integrates virtual distance & altitude
 * from workout zone gradients, tracks start/end wall-clock timestamps, and records
 * automatic Laps at every workout step transition.
 */

import { calculateCaloriesFromKj, calculateLiveTss } from '../core/workoutEngine';
import { CompiledGpsRoute, sampleCompiledRouteGps } from './gpsRoutes';
import {
  FIT_SPORT_CYCLING,
  FIT_SUB_SPORT_VIRTUAL_ACTIVITY,
  RecordedLap,
  RecordedSample,
  SavedRide,
} from './types';
import { VIRTUAL_START_ALTITUDE_M } from './virtualGps';

interface ActiveLapAccumulator {
  lapIndex: number;
  stepIndex: number;
  stepLabel: string;
  startTimeMs: number;
  startDistanceM: number;
  timerSec: number;
  ascentM: number;
  descentM: number;
  workKj: number;
  sampleCount: number;
  powerSum: number;
  maxPower: number;
  hrSum: number;
  hrCount: number;
  maxHr: number;
  cadenceSum: number;
  cadenceCount: number;
  maxCadence: number;
  speedSum: number;
  maxSpeed: number;
}

export interface RecordTickInput {
  timestampMs: number;
  dtSec: number;
  elapsedSec: number;
  power: number;
  heartRate: number;
  cadence: number;
  speedKmh: number;
  gradePct: number;
  stepIndex: number;
  stepLabel: string;
}

export class RideRecorder {
  private workoutId = '';
  private workoutName = '';
  private activityName = '';
  private sceneryName = '';
  private gpsRoute: CompiledGpsRoute | null = null;
  private ftp = 250;
  private startTimeMs: number | null = null;
  private totalTimerSec = 0;
  private distanceM = 0;
  private altitudeM = VIRTUAL_START_ALTITUDE_M;
  private totalAscentM = 0;
  private totalDescentM = 0;
  private totalWorkKj = 0;

  private records: RecordedSample[] = [];
  private laps: RecordedLap[] = [];
  private activeLap: ActiveLapAccumulator | null = null;

  public reset(): void {
    this.startTimeMs = null;
    this.activityName = '';
    this.sceneryName = '';
    this.gpsRoute = null;
    this.totalTimerSec = 0;
    this.distanceM = 0;
    this.altitudeM = VIRTUAL_START_ALTITUDE_M;
    this.totalAscentM = 0;
    this.totalDescentM = 0;
    this.totalWorkKj = 0;
    this.records = [];
    this.laps = [];
    this.activeLap = null;
  }

  public beginSession(
    workoutId: string,
    workoutName: string,
    ftp: number,
    startTimeMs = Date.now(),
    initialStepIndex = 0,
    initialStepLabel = 'Warmup',
    options?: {
      activityName?: string;
      sceneryName?: string;
      gpsRoute?: CompiledGpsRoute | null;
    }
  ): void {
    if (this.startTimeMs !== null) return;
    this.workoutId = workoutId;
    this.workoutName = workoutName;
    this.activityName = options?.activityName || workoutName;
    this.sceneryName = options?.sceneryName || '';
    this.gpsRoute = options?.gpsRoute ?? null;
    this.ftp = ftp;
    this.startTimeMs = startTimeMs;
    this.activeLap = this.createLapAccumulator(0, initialStepIndex, initialStepLabel, startTimeMs);
  }

  public updateMeta(ftp: number, activityName?: string, sceneryName?: string): void {
    this.ftp = ftp;
    if (activityName) this.activityName = activityName;
    if (sceneryName) this.sceneryName = sceneryName;
  }

  public setGpsRoute(route: CompiledGpsRoute | null): void {
    this.gpsRoute = route;
  }

  public getStartTimeMs(): number | null {
    return this.startTimeMs;
  }

  public getDistanceM(): number {
    return this.distanceM;
  }

  public getAltitudeM(): number {
    return this.altitudeM;
  }

  public getTotalAscentM(): number {
    return this.totalAscentM;
  }

  public getLapCount(): number {
    return this.laps.length + (this.activeLap ? 1 : 0);
  }

  public getRecordCount(): number {
    return this.records.length;
  }

  /**
   * Close the current lap and start a new lap whenever the workout step changes.
   */
  public markStepChange(stepIndex: number, stepLabel: string, timestampMs = Date.now()): void {
    if (this.startTimeMs === null) return;
    if (this.activeLap && this.activeLap.stepIndex === stepIndex) return;

    if (this.activeLap && this.activeLap.sampleCount > 0) {
      this.laps.push(this.closeLapAccumulator(this.activeLap, timestampMs));
      this.activeLap = this.createLapAccumulator(
        this.laps.length,
        stepIndex,
        stepLabel,
        timestampMs
      );
    } else if (this.activeLap) {
      // No samples recorded yet in the previous step; re-tag it cleanly
      this.activeLap.stepIndex = stepIndex;
      this.activeLap.stepLabel = stepLabel;
      this.activeLap.startTimeMs = timestampMs;
      this.activeLap.startDistanceM = this.distanceM;
    } else {
      this.activeLap = this.createLapAccumulator(
        this.laps.length,
        stepIndex,
        stepLabel,
        timestampMs
      );
    }
  }

  /**
   * Append a 1 Hz telemetry sample from the trainer & heart rate streams.
   */
  public recordSample(input: RecordTickInput): RecordedSample {
    if (this.startTimeMs === null) {
      this.beginSession(
        this.workoutId || 'custom',
        this.workoutName || 'NeonVelo Ride',
        this.ftp,
        input.timestampMs,
        input.stepIndex,
        input.stepLabel
      );
    }

    // Automatically split a new lap whenever stepIndex transitions
    if (this.activeLap && this.activeLap.stepIndex !== input.stepIndex) {
      this.markStepChange(input.stepIndex, input.stepLabel, input.timestampMs);
    }

    const dt = Math.max(0, input.dtSec);
    const speedMps = Math.max(0, input.speedKmh / 3.6);
    const deltaDistM = speedMps * dt;
    this.distanceM += deltaDistM;

    const deltaAltM = deltaDistM * (input.gradePct / 100);
    this.altitudeM += deltaAltM;
    if (deltaAltM > 0) {
      this.totalAscentM += deltaAltM;
    } else if (deltaAltM < 0) {
      this.totalDescentM += Math.abs(deltaAltM);
    }

    const addedKj = (Math.max(0, input.power) * dt) / 1000;
    this.totalWorkKj += addedKj;
    this.totalTimerSec += dt;

    const gps = sampleCompiledRouteGps(this.gpsRoute, this.distanceM);

    const sample: RecordedSample = {
      timestampMs: input.timestampMs,
      elapsedSec: input.elapsedSec,
      power: Math.max(0, Math.round(input.power)),
      heartRate: Math.max(0, Math.round(input.heartRate)),
      cadence: Math.max(0, Math.round(input.cadence)),
      speedMps,
      distanceM: this.distanceM,
      altitudeM: this.altitudeM,
      gradePct: input.gradePct,
      latDeg: gps.latDeg,
      lonDeg: gps.lonDeg,
      stepIndex: input.stepIndex,
    };

    this.records.push(sample);

    if (this.activeLap) {
      const lap = this.activeLap;
      lap.timerSec += dt;
      lap.workKj += addedKj;
      if (deltaAltM > 0) lap.ascentM += deltaAltM;
      else if (deltaAltM < 0) lap.descentM += Math.abs(deltaAltM);
      lap.sampleCount += 1;
      lap.powerSum += sample.power;
      if (sample.power > lap.maxPower) lap.maxPower = sample.power;
      if (sample.heartRate > 0) {
        lap.hrSum += sample.heartRate;
        lap.hrCount += 1;
        if (sample.heartRate > lap.maxHr) lap.maxHr = sample.heartRate;
      }
      if (sample.cadence > 0) {
        lap.cadenceSum += sample.cadence;
        lap.cadenceCount += 1;
        if (sample.cadence > lap.maxCadence) lap.maxCadence = sample.cadence;
      }
      lap.speedSum += sample.speedMps;
      if (sample.speedMps > lap.maxSpeed) lap.maxSpeed = sample.speedMps;
    }

    return sample;
  }

  /**
   * Finalize the current recording session into an immutable SavedRide ready for
   * IndexedDB storage, summary display, and binary FIT export.
   */
  public finalize(endTimeMs = Date.now()): SavedRide | null {
    if (this.startTimeMs === null) return null;

    const finalLaps = [...this.laps];
    if (this.activeLap && (this.activeLap.sampleCount > 0 || finalLaps.length === 0)) {
      finalLaps.push(this.closeLapAccumulator(this.activeLap, endTimeMs));
    }

    const recs = this.records;
    const count = recs.length;
    const powerSamples = recs.map((r) => r.power);

    let powerSum = 0;
    let maxPower = 0;
    let hrSum = 0;
    let hrCount = 0;
    let maxHr = 0;
    let cadSum = 0;
    let cadCount = 0;
    let maxCad = 0;
    let speedSum = 0;
    let maxSpeedMps = 0;

    for (let i = 0; i < count; i++) {
      const r = recs[i];
      powerSum += r.power;
      if (r.power > maxPower) maxPower = r.power;
      if (r.heartRate > 0) {
        hrSum += r.heartRate;
        hrCount += 1;
        if (r.heartRate > maxHr) maxHr = r.heartRate;
      }
      if (r.cadence > 0) {
        cadSum += r.cadence;
        cadCount += 1;
        if (r.cadence > maxCad) maxCad = r.cadence;
      }
      speedSum += r.speedMps;
      if (r.speedMps > maxSpeedMps) maxSpeedMps = r.speedMps;
    }

    const avgPower = count > 0 ? Math.round(powerSum / count) : 0;
    const avgHeartRate = hrCount > 0 ? Math.round(hrSum / hrCount) : 0;
    const avgCadence = cadCount > 0 ? Math.round(cadSum / cadCount) : 0;
    const avgSpeedMps = count > 0 ? speedSum / count : 0;
    const normalizedPower = computeNormalizedPower(powerSamples);
    const tss = calculateLiveTss(powerSamples, this.ftp);
    const intensityFactor =
      this.ftp > 0 && normalizedPower > 0
        ? Math.round((normalizedPower / this.ftp) * 1000) / 1000
        : 0;
    const totalElapsedSec = Math.max(
      Math.round(this.totalTimerSec),
      Math.round((endTimeMs - this.startTimeMs) / 1000)
    );

    return {
      id: `ride-${this.startTimeMs}-${Math.random().toString(36).slice(2, 7)}`,
      workoutId: this.workoutId,
      workoutName: this.workoutName,
      activityName: this.activityName || this.workoutName,
      sceneryName: this.sceneryName || undefined,
      gpsRouteName: this.gpsRoute?.name ?? 'Ura-shima Loop',
      ftp: this.ftp,
      startTimeMs: this.startTimeMs,
      endTimeMs: Math.max(this.startTimeMs, endTimeMs),
      totalElapsedSec,
      totalTimerSec: Math.round(this.totalTimerSec),
      totalDistanceM: Math.round(this.distanceM * 10) / 10,
      totalAscentM: Math.round(this.totalAscentM),
      totalDescentM: Math.round(this.totalDescentM),
      avgPower,
      maxPower,
      normalizedPower,
      avgHeartRate,
      maxHeartRate: maxHr,
      avgCadence,
      maxCadence: maxCad,
      avgSpeedKmh: Math.round(avgSpeedMps * 3.6 * 10) / 10,
      maxSpeedKmh: Math.round(maxSpeedMps * 3.6 * 10) / 10,
      tss,
      intensityFactor,
      totalWorkKj: Math.round(this.totalWorkKj * 10) / 10,
      calories: calculateCaloriesFromKj(this.totalWorkKj),
      sport: FIT_SPORT_CYCLING,
      subSport: FIT_SUB_SPORT_VIRTUAL_ACTIVITY,
      uploadedToStrava: false,
      records: [...recs],
      laps: finalLaps,
    };
  }

  private createLapAccumulator(
    lapIndex: number,
    stepIndex: number,
    stepLabel: string,
    startTimeMs: number
  ): ActiveLapAccumulator {
    return {
      lapIndex,
      stepIndex,
      stepLabel,
      startTimeMs,
      startDistanceM: this.distanceM,
      timerSec: 0,
      ascentM: 0,
      descentM: 0,
      workKj: 0,
      sampleCount: 0,
      powerSum: 0,
      maxPower: 0,
      hrSum: 0,
      hrCount: 0,
      maxHr: 0,
      cadenceSum: 0,
      cadenceCount: 0,
      maxCadence: 0,
      speedSum: 0,
      maxSpeed: 0,
    };
  }

  private closeLapAccumulator(lap: ActiveLapAccumulator, endTimeMs: number): RecordedLap {
    const safeEnd = Math.max(lap.startTimeMs, endTimeMs);
    const totalElapsedSec = Math.max(
      Math.round(lap.timerSec),
      Math.round((safeEnd - lap.startTimeMs) / 1000)
    );
    const totalDistanceM = Math.max(0, this.distanceM - lap.startDistanceM);
    const n = lap.sampleCount;

    return {
      lapIndex: lap.lapIndex,
      stepIndex: lap.stepIndex,
      stepLabel: lap.stepLabel,
      startTimeMs: lap.startTimeMs,
      endTimeMs: safeEnd,
      totalElapsedSec,
      totalTimerSec: Math.round(lap.timerSec),
      startDistanceM: Math.round(lap.startDistanceM * 10) / 10,
      totalDistanceM: Math.round(totalDistanceM * 10) / 10,
      totalAscentM: Math.round(lap.ascentM),
      totalDescentM: Math.round(lap.descentM),
      avgPower: n > 0 ? Math.round(lap.powerSum / n) : 0,
      maxPower: lap.maxPower,
      avgHeartRate: lap.hrCount > 0 ? Math.round(lap.hrSum / lap.hrCount) : 0,
      maxHeartRate: lap.maxHr,
      avgCadence: lap.cadenceCount > 0 ? Math.round(lap.cadenceSum / lap.cadenceCount) : 0,
      maxCadence: lap.maxCadence,
      avgSpeedMps: n > 0 ? lap.speedSum / n : 0,
      maxSpeedMps: lap.maxSpeed,
      calories: calculateCaloriesFromKj(lap.workKj),
    };
  }
}

function computeNormalizedPower(powerSamples1Hz: number[]): number {
  const n = powerSamples1Hz.length;
  if (n === 0) return 0;
  const windowSize = Math.min(30, n);
  let rollingSum = 0;
  let fourthSum = 0;
  let count = 0;
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
  return count > 0 ? Math.round(Math.pow(fourthSum / count, 0.25)) : 0;
}
