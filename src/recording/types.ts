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

export type SceneryDisplayId =
  | 'neon-city'
  | 'palm-grove'
  | 'cloud-horizon'
  | 'causeway-embankment';

export function getSceneryDisplayName(theme: SceneryDisplayId): string {
  switch (theme) {
    case 'neon-city':
      return 'Neon City';
    case 'palm-grove':
      return 'Palm Grove';
    case 'cloud-horizon':
      return 'Cloud Horizon';
    case 'causeway-embankment':
      return 'Island Causeway';
  }
}

/**
 * Format the Garmin .FIT Activity Name per user specification:
 * - Free Ride: "Free Ride - <Scenery>"
 * - Workout:   "<Workout Name> - <Scenery>"
 */
export function formatFitActivityName(opts: {
  rideMode: 'workout' | 'freeride';
  workoutName: string;
  sceneryTheme: SceneryDisplayId;
  visitedSceneries?: readonly SceneryDisplayId[];
}): string {
  const unique = opts.visitedSceneries
    ? Array.from(new Set(opts.visitedSceneries))
    : [opts.sceneryTheme];
  const sceneryLabel =
    unique.length > 1
      ? `${getSceneryDisplayName(unique[0])} + ${unique.length - 1} Worlds`
      : getSceneryDisplayName(unique[0] ?? opts.sceneryTheme);

  if (opts.rideMode === 'freeride') {
    return `Free Ride - ${sceneryLabel}`;
  }
  const cleanWorkout = (opts.workoutName || 'Workout').trim();
  return `${cleanWorkout} - ${sceneryLabel}`;
}

export interface SavedRide {
  id: string;
  workoutId: string;
  workoutName: string;
  /** Exact activity name embedded in the binary .FIT file ("Free Ride - Scenery" or "Workout Name - Scenery") */
  activityName?: string;
  sceneryName?: string;
  gpsRouteName?: string;
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
  stravaActivityId?: number | null;
  records: RecordedSample[];
  laps: RecordedLap[];
}
