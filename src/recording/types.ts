/**
 * Data models for 1 Hz ride telemetry recording, step-change laps,
 * persistent completed workout storage, and Garmin FIT export.
 */

export const FIT_SPORT_CYCLING = 2 as const;
export const FIT_SUB_SPORT_VIRTUAL_ACTIVITY = 58 as const;

export interface RecordedSample {
  /** Wall-clock Unix timestamp (ms) when this sample was recorded */
  timestampMs: number;
  /** Workout elapsed time (seconds) */
  elapsedSec: number;
  /** Instantaneous power (Watts) from trainer stream */
  power: number;
  /** Heart rate (BPM) from HRM stream (0 when unavailable) */
  heartRate: number;
  /** Cadence (RPM) from trainer stream */
  cadence: number;
  /** Virtual speed (m/s) */
  speedMps: number;
  /** Cumulative virtual distance (meters) */
  distanceM: number;
  /** Virtual elevation altitude (meters, derived from in-game gradient) */
  altitudeM: number;
  /** Current road grade (%) */
  gradePct: number;
  /** Virtual GPS latitude (degrees, Ura-shima virtual circuit) */
  latDeg: number;
  /** Virtual GPS longitude (degrees, Ura-shima virtual circuit) */
  lonDeg: number;
  /** Active workout timeline step index */
  stepIndex: number;
}

export interface RecordedLap {
  lapIndex: number;
  stepIndex: number;
  stepLabel: string;
  startTimeMs: number;
  endTimeMs: number;
  totalElapsedSec: number;
  totalTimerSec: number;
  startDistanceM: number;
  totalDistanceM: number;
  totalAscentM: number;
  totalDescentM: number;
  avgPower: number;
  maxPower: number;
  avgHeartRate: number;
  maxHeartRate: number;
  avgCadence: number;
  maxCadence: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  calories: number;
}

export interface SavedRide {
  id: string;
  workoutId: string;
  workoutName: string;
  ftp: number;
  startTimeMs: number;
  endTimeMs: number;
  totalElapsedSec: number;
  totalTimerSec: number;
  totalDistanceM: number;
  totalAscentM: number;
  totalDescentM: number;
  avgPower: number;
  maxPower: number;
  normalizedPower: number;
  avgHeartRate: number;
  maxHeartRate: number;
  avgCadence: number;
  maxCadence: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  tss: number;
  intensityFactor: number;
  totalWorkKj: number;
  calories: number;
  sport: typeof FIT_SPORT_CYCLING;
  subSport: typeof FIT_SUB_SPORT_VIRTUAL_ACTIVITY;
  uploadedToStrava: boolean;
  uploadedAtMs?: number;
  records: RecordedSample[];
  laps: RecordedLap[];
}
