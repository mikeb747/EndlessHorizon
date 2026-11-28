/**
 * Shared procedural spline math for the endless Temple-Run-style neon road.
 * Curves and workout-driven elevation grades are evaluated relative to the cyclist's
 * current worldDistance and workoutElapsedSec so the rider stays anchored at local
 * (0, 0, 0) while the road bends and climbs authentically toward the horizon (-Z).
 */

import {
  FreeRideTerrainProfile,
  sampleFreeRideElevation,
  sampleFreeRideGrade,
} from '../core/freeRide';
import { getPowerZone } from '../core/zones';
import { ParsedWorkout } from '../core/zwoParser';
import {
  CompiledGpsRoute,
  sampleCompiledRouteCurvature,
} from '../recording/gpsRoutes';
import { SceneryDisplayId } from '../recording/types';
import { CadenceMatcherState, createCadenceMatcherState } from './cadenceMatcher';

export const ROAD_WIDTH = 7.4;
export const ROAD_HALF_WIDTH = ROAD_WIDTH / 2;

/** Extended draw-distance road horizon (trimmed right behind camera at +7.5m to skip unseen rear geometry). */
export const ROAD_Z_NEAR = 7.5;
export const ROAD_Z_FAR = -265;
export const ROAD_Z_SPAN = ROAD_Z_NEAR - ROAD_Z_FAR; // 272.5 m
/** Adaptive non-linear LOD segment count (denser near camera, coarser toward horizon for 60fps). */
export const ROAD_SEGMENTS = 56;
/** Pre-allocated forward curve LUT resolution for GPS Art in-game corners (zero per-frame GC). */
export const CURVE_LUT_SAMPLES = 65;
/** Max visual heading sweep toward horizon (~51.5 deg) so 180-deg GPS hairpins stay sharp & playable. */
export const MAX_VISIBLE_HEADING_RAD = 0.9;

/** Camera depth-buffer precision planes (higher near improves 24-bit depth precision ~4.5x). */
export const WORLD_CAMERA_NEAR = 0.45;
export const WORLD_CAMERA_FAR = 480;
/** Full 360° Sky Dome radius (wraps completely overhead even on +20% climbs & ultrawide). */
export const SKY_DOME_RADIUS = 410;
/** Wide-screen Palm Grove cliff ridge width (covers ultrawide 21:9 / 32:9 edge-to-edge). */
export const PALM_GROVE_CLIFF_WIDTH = 660;

/** Neon City raised sidewalk & building setback dimensions (meters). */
export const NEON_CITY_CURB_GAP = 0.24;
/** Clear walkable promenade width in front of skyscraper facades (meters). */
export const NEON_CITY_SIDEWALK_WIDTH = 3.8;
/** Visual paved sidewalk width (2x walkway) extending cleanly under the building fronts. */
export const NEON_CITY_SIDEWALK_PAVED_WIDTH = 7.8;
/** Total solid sidewalk + under-building foundation apron width (eliminates all floor gaps). */
export const NEON_CITY_SIDEWALK_TOTAL_WIDTH = 24.0;
export const NEON_CITY_SIDEWALK_HEIGHT = 0.18;
export const NEON_CITY_BUILDING_SETBACK = 0.42;
export const NEON_CITY_BUILDING_MAX_JITTER = 4.6;
export const NEON_CITY_BUILDING_MAX_WIDTH = 8.0;
export const NEON_CITY_MIN_BUILDING_FRONT_X =
  ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP + NEON_CITY_SIDEWALK_WIDTH + NEON_CITY_BUILDING_SETBACK;

/** Island Causeway (Lüttmoorsiel–Nordstrandischmoor inspired) raised embankment dimensions. */
export const CAUSEWAY_EMBANKMENT_DROP_M = 2.85;
export const CAUSEWAY_EMBANKMENT_TOE_X = ROAD_HALF_WIDTH + 6.4;

/** Cloud Horizon 2D billboard sprite count (2 triangles per sprite vs 36 for 3D dodecahedrons). */
export const CLOUD_HORIZON_SPRITE_COUNT = 32;

/**
 * Compute non-linear LOD Z coordinate for a road/sidewalk/grid strip segment.
 * Allocates denser geometry close to the cyclist (smooth curves & crests) and
 * progressively longer segments toward the far horizon to keep vertex work light at 60fps.
 */
export function computeRoadSegmentZ(
  segmentIndex: number,
  totalSegments = ROAD_SEGMENTS,
  zNear = ROAD_Z_NEAR,
  zFar = ROAD_Z_FAR
): number {
  if (totalSegments <= 0) return zNear;
  const u = Math.max(0, Math.min(1, segmentIndex / totalSegments));
  const warped = 0.38 * u + 0.62 * u * u;
  return zNear - warped * (zNear - zFar);
}

/**
 * Map a world Z coordinate linearly into [0, 1] along the road span so texture UVs remain
 * uniformly spaced in world meters even when using non-linear LOD vertex spacing.
 */
export function computeLinearRoadT(
  z: number,
  zNear = ROAD_Z_NEAR,
  zFar = ROAD_Z_FAR
): number {
  const span = zNear - zFar;
  if (span <= 0) return 0;
  return (zNear - z) / span;
}

/**
 * Compute lateral center offset for a Neon City building of width `buildingWidth`
 * so its street-facing facade is guaranteed to sit behind the full raised sidewalk.
 */
export function computeBuildingCenterOffset(
  buildingWidth: number,
  minFrontX = NEON_CITY_MIN_BUILDING_FRONT_X,
  extraJitter = 0
): number {
  return minFrontX + Math.max(0, buildingWidth) * 0.5 + Math.max(0, extraJitter);
}

export const PALM_GROVE_PALM_COUNT = 64;
export const PALM_GROVE_LANE_STEP_M = 7.8;
/** Average meters between consecutive palms in Palm Grove (3.9 m). */
export const PALM_GROVE_AVG_SPACING_M =
  ((PALM_GROVE_PALM_COUNT / 2) * PALM_GROVE_LANE_STEP_M) / PALM_GROVE_PALM_COUNT;
/** Cloud Horizon low-poly bushes are 16x less frequent than Palm Grove palms (~62.4 m). */
export const CLOUD_HORIZON_BUSH_SPACING_M = PALM_GROVE_AVG_SPACING_M * 16;

/**
 * Compute UV.y texture offset so horizontal grid lines on a ground/road plane where
 * uv.y=0 is near the camera (+Z) and uv.y=1 is far toward the horizon (-Z) scroll
 * DOWN the screen (toward the cyclist) at an exact 1:1 physical speed match.
 */
export function computeForwardScrollOffset(
  distanceM: number,
  repeatY: number,
  spanM: number
): number {
  if (spanM <= 0 || repeatY <= 0) return 0;
  const raw = (distanceM * (repeatY / spanM)) % 1;
  return raw < 0 ? raw + 1 : raw;
}

export interface SpeedStreakParams {
  visible: boolean;
  activeCount: number;
  streakLength: number;
  opacity: number;
  travelSpeed: number;
}

/**
 * Pure zone-reactive calculation for speed lines rushing toward the camera:
 * - Hidden completely in Zone 1 and Zone 2 (or on Low quality / stationary).
 * - Active in Zone 3+ and accelerates noticeably in higher zones (Z3 < Z4 < Z5 < Z6 < Z7).
 */
export function computeSpeedStreakParams(
  zoneNumber: number,
  speedMps: number,
  intensityNorm: number,
  quality: 'low' | 'medium' | 'high',
  maxStreaks = 84
): SpeedStreakParams {
  const speedFactor = Math.min(1.6, Math.max(0, speedMps) / 10);
  if (quality === 'low' || zoneNumber <= 2 || speedFactor < 0.04) {
    return {
      visible: false,
      activeCount: 0,
      streakLength: 0,
      opacity: 0,
      travelSpeed: 0,
    };
  }

  const clampedIntensity = Math.max(0, Math.min(1, intensityNorm));
  const zoneStep = Math.max(0, zoneNumber - 3); // 0 for Z3 .. 4 for Z7
  const zoneSpeedMul = 1.0 + zoneStep * 0.45 + zoneStep * zoneStep * 0.08;
  const intensityBoost = 0.45 + clampedIntensity * 1.25;
  const activeCount = Math.min(
    maxStreaks,
    Math.floor((quality === 'high' ? 28 : 16) + clampedIntensity * 56)
  );
  const streakLength = (1.6 + speedFactor * 3.8) * intensityBoost;
  const opacity = Math.min(0.78, 0.18 + speedFactor * 0.25 + clampedIntensity * 0.35);
  const travelSpeed = (Math.max(0, speedMps) * 2.4 + 4 * speedFactor) * zoneSpeedMul;

  return {
    visible: true,
    activeCount,
    streakLength,
    opacity,
    travelSpeed,
  };
}

/**
 * Reference forward speed (m/s) used to project workout timeline seconds into
 * ahead-of-bike road meters so upcoming climbs and the finish line appear cleanly
 * ~15–18 seconds ahead on the horizon.
 */
export const REF_ROAD_SPEED_MPS = 10.0;

/**
 * Map Coggan Power Zone (1..7) to exact in-game road gradient (rise / run):
 * - Zone 1: Flat (0%)
 * - Zone 2: Gentle incline (3%)
 * - Zone 3: Tempo incline (6%)
 * - Zone 4: Threshold climb (10%)
 * - Zone 5+: Steep mountain climb (22%, and +10% steeper = 32% on Neon City)
 */
export function getZoneGradient(zoneNumber: number, sceneryTheme?: SceneryDisplayId): number {
  if (zoneNumber <= 1) return 0.0;
  if (zoneNumber === 2) return 0.03;
  if (zoneNumber === 3) return 0.06;
  if (zoneNumber === 4) return 0.1;
  return sceneryTheme === 'neon-city' ? 0.32 : 0.22;
}

export interface WorkoutElevationProfile {
  workoutId: string;
  totalDuration: number;
  /** Smoothed road gradient (rise / run) at each integer second [0..totalDuration] */
  gradeAtSec: Float32Array;
  /** Cumulative elevation in meters at each integer second [0..totalDuration] */
  cumElevMeters: Float32Array;
}

/**
 * Precompute a continuous, smoothed 1 Hz elevation lookup table from a loaded workout's
 * timeline. Runs once per workout load (O(N) ~3300 floats) so every 60 fps road vertex
 * sample is O(1) with zero per-frame allocations.
 */
export function buildWorkoutElevationProfile(
  workout: ParsedWorkout,
  sceneryTheme?: SceneryDisplayId
): WorkoutElevationProfile {
  const totalSec = Math.max(1, Math.ceil(workout.totalDuration));
  const rawGrade = new Float32Array(totalSec + 1);
  const timeline = workout.timeline;

  let stepIdx = 0;
  for (let t = 0; t <= totalSec; t++) {
    while (stepIdx < timeline.length - 1 && t >= timeline[stepIdx].endTime) {
      stepIdx++;
    }
    const step = timeline[stepIdx];
    if (!step) {
      rawGrade[t] = 0;
      continue;
    }
    const stepElapsed = Math.max(0, Math.min(step.duration, t - step.startTime));
    const progress = step.duration > 0 ? stepElapsed / step.duration : 0;
    const powerFraction =
      step.powerLow === step.powerHigh
        ? step.powerLow
        : step.powerLow + (step.powerHigh - step.powerLow) * progress;
    const zone = getPowerZone(powerFraction);
    rawGrade[t] = getZoneGradient(zone.zone, sceneryTheme);
  }

  // Smooth gradient transitions over a gentle 3-second centered moving window so
  // abrupt Z1 (0%) <-> Z6 (20%) transitions form realistic vertical transition curves
  // while steady intervals still hold their exact target grade.
  const gradeAtSec = new Float32Array(totalSec + 1);
  for (let t = 0; t <= totalSec; t++) {
    const prev = rawGrade[Math.max(0, t - 1)];
    const curr = rawGrade[t];
    const next = rawGrade[Math.min(totalSec, t + 1)];
    gradeAtSec[t] = prev * 0.2 + curr * 0.6 + next * 0.2;
  }

  // Integrate elevation using trapezoidal rule at REF_ROAD_SPEED_MPS meters per second
  const cumElevMeters = new Float32Array(totalSec + 1);
  cumElevMeters[0] = 0;
  for (let t = 1; t <= totalSec; t++) {
    const avgGrade = 0.5 * (gradeAtSec[t - 1] + gradeAtSec[t]);
    cumElevMeters[t] = cumElevMeters[t - 1] + avgGrade * REF_ROAD_SPEED_MPS;
  }

  return {
    workoutId: workout.id,
    totalDuration: totalSec,
    gradeAtSec,
    cumElevMeters,
  };
}

/**
 * Sample smoothed road gradient (rise / run) at an arbitrary fractional workout time.
 */
export function sampleGradeAtTime(profile: WorkoutElevationProfile, timeSec: number): number {
  if (timeSec <= 0) return profile.gradeAtSec[0];
  if (timeSec >= profile.totalDuration) return 0; // Flat finish apron after workout end
  const i0 = Math.floor(timeSec);
  const i1 = Math.min(profile.totalDuration, i0 + 1);
  const frac = timeSec - i0;
  return profile.gradeAtSec[i0] + (profile.gradeAtSec[i1] - profile.gradeAtSec[i0]) * frac;
}

/**
 * Sample cumulative road elevation (meters) at an arbitrary fractional workout time.
 * Extrapolates smoothly before t=0 and continues flat after t=totalDuration.
 */
export function sampleElevationMeters(profile: WorkoutElevationProfile, timeSec: number): number {
  if (timeSec <= 0) {
    return timeSec * profile.gradeAtSec[0] * REF_ROAD_SPEED_MPS;
  }
  if (timeSec >= profile.totalDuration) {
    return profile.cumElevMeters[profile.totalDuration];
  }
  const i0 = Math.floor(timeSec);
  const i1 = Math.min(profile.totalDuration, i0 + 1);
  const frac = timeSec - i0;
  return profile.cumElevMeters[i0] + (profile.cumElevMeters[i1] - profile.cumElevMeters[i0]) * frac;
}

function rawCurveX(s: number): number {
  return Math.sin(s * 0.011) * 8.5 + Math.sin(s * 0.023 + 1.4) * 3.4;
}

function rawCurveDerivX(s: number): number {
  return Math.cos(s * 0.011) * 8.5 * 0.011 + Math.cos(s * 0.023 + 1.4) * 3.4 * 0.023;
}

function rawDemoElevationY(s: number): number {
  return Math.sin(s * 0.015 + 0.6) * 2.0 + Math.cos(s * 0.031) * 0.7;
}

function rawDemoElevationDerivY(s: number): number {
  return Math.cos(s * 0.015 + 0.6) * 2.0 * 0.015 - Math.sin(s * 0.031) * 0.7 * 0.031;
}

export interface RoadSample {
  x: number;
  y: number;
  slopeX: number;
  slopeY: number;
}

const _sampleOut: RoadSample = { x: 0, y: 0, slopeX: 0, slopeY: 0 };

let _activeRoadCurveSource: WorldRuntimeState | null = null;

/**
 * Bind the active WorldRuntimeState curve LUT once per frame in SceneDriver so every
 * road strip, sidewalk, building, palm, embankment, and finish sign automatically follows
 * the exact same GPS Art corners with O(1) lookup and zero per-frame allocations.
 */
export function setActiveRoadCurveSource(rt: WorldRuntimeState | null): void {
  _activeRoadCurveSource = rt;
}

/**
 * Integrate bounded GPS Art route curvature into the pre-allocated road curve LUT
 * from local Z = 0 forward to ROAD_Z_FAR and backward to ROAD_Z_NEAR.
 * Tight 180° GPS hairpins are smoothly bounded via tanh into dramatic, playable 3D bends.
 */
export function updateRoadCurveLut(rt: WorldRuntimeState): void {
  const route = rt.gpsRoute;
  if (!route) {
    rt.curveLutReady = false;
    rt.currentCurvature = 0;
    return;
  }

  const n = rt.curveLutX.length;
  const maxIdx = n - 1;
  const dz = ROAD_Z_SPAN / maxIdx;
  const uZero = ROAD_Z_NEAR / ROAD_Z_SPAN;
  const idxZero = uZero * maxIdx;
  const iFwdStart = Math.ceil(idxZero);
  const iBackStart = Math.floor(idxZero);

  // Forward integration from z = 0 (x = 0, heading = 0) toward ROAD_Z_FAR (-265m)
  let theta = 0;
  let x = 0;
  let prevSlope = 0;
  let prevAhead = 0;

  for (let i = iFwdStart; i < n; i++) {
    const z = ROAD_Z_NEAR - i * dz;
    const ahead = -z; // >= 0
    const ds = ahead - prevAhead;
    if (ds > 0) {
      const k = sampleCompiledRouteCurvature(route, rt.distance + prevAhead + ds * 0.5);
      theta += k * ds;
      const clampedHeading =
        MAX_VISIBLE_HEADING_RAD * Math.tanh(theta / MAX_VISIBLE_HEADING_RAD);
      const slope = Math.tan(clampedHeading);
      x += 0.5 * (prevSlope + slope) * ds;
      prevSlope = slope;
      prevAhead = ahead;
    }
    rt.curveLutX[i] = x;
    rt.curveLutSlopeX[i] = prevSlope;
  }

  // Backward integration from z = 0 toward ROAD_Z_NEAR (+7.5m behind rider)
  theta = 0;
  x = 0;
  prevSlope = 0;
  let prevBehind = 0;

  for (let i = iBackStart; i >= 0; i--) {
    const z = ROAD_Z_NEAR - i * dz;
    const behind = Math.max(0, z);
    const ds = behind - prevBehind;
    if (ds > 0) {
      const k = sampleCompiledRouteCurvature(route, Math.max(0, rt.distance - prevBehind - ds * 0.5));
      theta -= k * ds;
      const clampedHeading =
        MAX_VISIBLE_HEADING_RAD * Math.tanh(theta / MAX_VISIBLE_HEADING_RAD);
      const slope = Math.tan(clampedHeading);
      x -= 0.5 * (prevSlope + slope) * ds;
      prevSlope = slope;
      prevBehind = behind;
    }
    rt.curveLutX[i] = x;
    rt.curveLutSlopeX[i] = prevSlope;
  }

  // Look slightly ahead (+8m) so cyclist lean anticipates the corner cleanly
  rt.currentCurvature = sampleCompiledRouteCurvature(route, rt.distance + 8);
  rt.curveLutReady = true;
}

/**
 * Evaluate road centerline offset (x, y) at a local Z coordinate (z <= 0 is ahead of cyclist)
 * given the rider's cumulative forward distance in meters and optional workout elevation profile.
 * Mutates and returns a reusable object (or target) to avoid per-frame GC allocations.
 */
export function sampleRoadAtZ(
  worldDistance: number,
  localZ: number,
  target: RoadSample = _sampleOut,
  elevationProfile: WorkoutElevationProfile | null = null,
  workoutElapsedSec = 0,
  freeRideTerrain: FreeRideTerrainProfile | null = null,
  curveSource?: WorldRuntimeState | null
): RoadSample {
  const aheadDist = -localZ; // positive ahead of bike
  const s = worldDistance + aheadDist;

  const activeCurve = curveSource !== undefined ? curveSource : _activeRoadCurveSource;
  if (activeCurve && activeCurve.curveLutReady) {
    const lutX = activeCurve.curveLutX;
    const lutSlope = activeCurve.curveLutSlopeX;
    const maxIdx = lutX.length - 1;
    const t = Math.max(0, Math.min(1, (ROAD_Z_NEAR - localZ) / ROAD_Z_SPAN));
    const f = t * maxIdx;
    const i0 = Math.floor(f);
    const i1 = Math.min(maxIdx, i0 + 1);
    const frac = f - i0;
    target.x = lutX[i0] + (lutX[i1] - lutX[i0]) * frac;
    target.slopeX = lutSlope[i0] + (lutSlope[i1] - lutSlope[i0]) * frac;
  } else {
    const baseX = rawCurveX(worldDistance);
    const baseDx = rawCurveDerivX(worldDistance);

    // Subtract tangent at bike position so local road leaves (0,0,0) heading straight -Z
    // and gently curves into the distance
    target.x = rawCurveX(s) - baseX - baseDx * aheadDist * 0.55;
    target.slopeX = rawCurveDerivX(s) - baseDx * 0.55;
  }

  if (freeRideTerrain) {
    const baseElev = sampleFreeRideElevation(freeRideTerrain, worldDistance);
    target.y = sampleFreeRideElevation(freeRideTerrain, s) - baseElev;
    target.slopeY = sampleFreeRideGrade(freeRideTerrain, s);
  } else if (elevationProfile) {
    const tBike = workoutElapsedSec;
    const tSample = tBike + aheadDist / REF_ROAD_SPEED_MPS;
    const baseElev = sampleElevationMeters(elevationProfile, tBike);
    target.y = sampleElevationMeters(elevationProfile, tSample) - baseElev;
    target.slopeY = sampleGradeAtTime(elevationProfile, tSample);
  } else {
    const baseY = rawDemoElevationY(worldDistance);
    const baseDy = rawDemoElevationDerivY(worldDistance);
    target.y = rawDemoElevationY(s) - baseY - baseDy * aheadDist * 0.65;
    target.slopeY = rawDemoElevationDerivY(s) - baseDy * 0.65;
  }

  return target;
}

/**
 * Smooth banking curvature signal for the default non-GPS road spline.
 * Positive values indicate a right-hand turn (+X ahead), negative indicate left-hand (-X ahead).
 */
export function getRoadCurvatureAt(worldDistance: number): number {
  const d1 = rawCurveDerivX(worldDistance);
  const d2 = rawCurveDerivX(worldDistance + 12);
  return (d2 - d1) * 1.35;
}

/**
 * Compute bike Z-axis roll angle (radians) for leaning INTO corners.
 * In Three.js right-handed coordinates facing -Z (+X right, +Y up, +Z toward camera):
 * - Right turn (curvature > 0) requires NEGATIVE rotation.z so the top of the bike tilts RIGHT (+X).
 * - Left turn (curvature < 0) requires POSITIVE rotation.z so the top of the bike tilts LEFT (-X).
 */
export function computeCornerLeanAngle(
  curvature: number,
  isGpsRoute: boolean,
  speedMps: number
): number {
  if (speedMps <= 0.5 || !Number.isFinite(curvature)) return 0;
  const maxLean = isGpsRoute ? 0.28 : 0.22;
  const scaled = isGpsRoute ? curvature * 14.5 : curvature;
  const clamped = Math.max(-maxLean, Math.min(maxLean, scaled));
  return -clamped;
}

/**
 * Shared mutable world animation state driven by the 3D render loop so sub-components
 * stay synchronized at 60 fps without triggering React re-renders.
 */
export interface WorldRuntimeState {
  distance: number; // meters traveled
  speedMps: number; // smoothed forward speed (m/s)
  cadenceRad: number; // cumulative crank angle (radians)
  modelCadenceRpm: number; // exact 3D model pedalling RPM matched to sensor
  cadenceMatcher: CadenceMatcherState;
  wheelRad: number; // cumulative wheel angle (radians)
  pedalPulse: number; // 0..1 pulse peaking twice per crank revolution
  intervalBurst: number; // 0..1 shockwave progress on step start
  edgeFlash: number; // 0..1 extra emissive boost on step start
  intensityNorm: number; // 0..1 normalized zone intensity (higher in Z5+)
  zoneNumber: number; // active Coggan zone 1..7 (used to gate & accelerate speed lines)
  leanAngle: number; // bike roll angle in radians
  lastPulseCount: number;
  // Workout-driven or Free Ride undulating elevation & finish pass state
  elevationProfile: WorkoutElevationProfile | null;
  freeRideTerrain: FreeRideTerrainProfile | null;
  workoutElapsedSec: number; // smoothly interpolated workout clock for continuous hill travel
  lastStoreElapsed: number;
  subSecAccum: number;
  workoutDurationSec: number;
  currentGrade: number; // smoothed rise/run gradient (-0.14..0.20)
  pitchAngle: number; // atan(currentGrade) radians
  finishPassDist: number; // meters past the finish line during post-completion coast
  // GPS Art route corner LUT (pre-allocated once, updated per frame in SceneDriver)
  gpsRoute: CompiledGpsRoute | null;
  curveLutReady: boolean;
  curveLutX: Float32Array;
  curveLutSlopeX: Float32Array;
  currentCurvature: number;
  // Shared per-frame camera frustum planes (6 planes * 4 floats) & live culling telemetry
  frustumPlanes: Float32Array;
  frustumReady: boolean;
  cameraZ: number;
  drawnInstances: number;
  culledInstances: number;
}

export function createWorldRuntime(): WorldRuntimeState {
  const cadenceMatcher = createCadenceMatcherState();
  return {
    distance: 0,
    speedMps: 0,
    cadenceRad: cadenceMatcher.crankRad,
    modelCadenceRpm: 0,
    cadenceMatcher,
    wheelRad: 0,
    pedalPulse: 0,
    intervalBurst: 0,
    edgeFlash: 0,
    intensityNorm: 0.25,
    zoneNumber: 2,
    leanAngle: 0,
    lastPulseCount: 0,
    elevationProfile: null,
    freeRideTerrain: null,
    workoutElapsedSec: 0,
    lastStoreElapsed: 0,
    subSecAccum: 0,
    workoutDurationSec: 0,
    currentGrade: 0,
    pitchAngle: 0,
    finishPassDist: 0,
    gpsRoute: null,
    curveLutReady: false,
    curveLutX: new Float32Array(CURVE_LUT_SAMPLES),
    curveLutSlopeX: new Float32Array(CURVE_LUT_SAMPLES),
    currentCurvature: 0,
    frustumPlanes: new Float32Array(24),
    frustumReady: false,
    cameraZ: 4.7,
    drawnInstances: 0,
    culledInstances: 0,
  };
}
