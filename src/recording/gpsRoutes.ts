/**
 * GPS Art Route Engine & In-Game Corner Curvature Mapper.
 *
 * Maps any normalized 2D line drawing (such as the Single-Line Bike or a user-uploaded
 * drawing) onto a conformal 1:1 GPS trajectory centered at Ura-shima, Japan so Strava
 * plots reproduce the exact line drawing 1:1 without distortion.
 *
 * Simultaneously computes a bounded, smooth in-game 3D corner curvature profile so:
 * - Straight lines on the drawing appear straight in 3D
 * - Sweeping arcs curve smoothly left/right in 3D with cyclist banking lean
 * - Tight 180° hairpins / micro-loops become thrilling, playable sharp bends in 3D
 *   while the recorded GPS coordinates still trace the exact 1:1 tight drawing.
 */

import { BIKE_LINE_ART_POINTS } from './bikeLineArtPath';
import type { NormalizedPoint } from './lineArtTracer';
import {
  sampleUrashimaGps,
  URASHIMA_CENTER_LAT,
  URASHIMA_CENTER_LON,
  VirtualGpsPoint,
} from './virtualGps';

export type GpsRoutePresetId = 'urashima-loop' | 'bike-line-art' | 'custom-drawing';

export interface GpsRoutePresetMeta {
  id: GpsRoutePresetId;
  name: string;
  subtitle: string;
}

export const GPS_ROUTE_PRESETS: readonly GpsRoutePresetMeta[] = [
  {
    id: 'urashima-loop',
    name: 'Ura-shima Loop',
    subtitle: 'Classic smooth island coastal circuit (~4.4 km laps)',
  },
  {
    id: 'bike-line-art',
    name: 'Single-Line Bike (GPS Art)',
    subtitle: '1:1 GPS plot of the single-line bicycle drawing with matching in-game corners',
  },
  {
    id: 'custom-drawing',
    name: 'Custom Line Drawing',
    subtitle: 'Upload any black-on-white line drawing to ride & plot 1:1 on Strava',
  },
];

const METERS_PER_DEG_LAT = 111320;
const METERS_PER_DEG_LON =
  METERS_PER_DEG_LAT * Math.cos((URASHIMA_CENTER_LAT * Math.PI) / 180);

/**
 * Maximum playable in-game 3D road curvature (rad/m).
 * 0.024 rad/m ≈ 42 m minimum playable visual corner radius so 180° tiny-radius bends
 * in the GPS drawing feel like sharp, exhilarating corners in 3D without folding the road.
 */
export const MAX_IN_GAME_CURVATURE = 0.024;

const CURVATURE_LUT_SAMPLES = 768;

export interface CompiledGpsRoute {
  id: GpsRoutePresetId;
  name: string;
  closedLoop: boolean;
  /** Target physical arc length of one full pass of the drawing (meters) */
  totalLengthM: number;
  /** Normalized East/North points scaled to physical meters centered around (0, 0) */
  eastM: Float64Array;
  northM: Float64Array;
  /** Cumulative arc length in meters at each polyline vertex */
  cumDistM: Float64Array;
  /** Normalized original points (for clean UI mini-map rendering) */
  previewPoints: readonly NormalizedPoint[];
  /** Exit unit tangent vector (East, North) for graceful continuation past totalLengthM */
  exitDirX: number;
  exitDirY: number;
  /** Uniformly sampled signed in-game 3D curvature (+ = Right turn, - = Left turn) */
  curvatureLut: Float32Array;
  /** Uniformly sampled raw signed curvature (unclamped, rad/m) */
  rawCurvatureLut: Float32Array;
}

function wrapAngleDelta(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Compile a normalized 2D polyline (East = +X, North = +Y) into an arc-length-parameterized
 * 1:1 conformal GPS route + precomputed bounded in-game 3D corner curvature LUT.
 */
export function compileGpsRoute(
  id: GpsRoutePresetId,
  name: string,
  normalizedPoints: readonly NormalizedPoint[],
  targetLengthM: number,
  closedLoop = false
): CompiledGpsRoute {
  const safePts =
    normalizedPoints.length >= 2
      ? normalizedPoints
      : [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ];
  const n = safePts.length;
  const safeTargetM = Math.max(500, targetLengthM);

  // Measure normalized arc length & bounding box center
  const normCum = new Float64Array(n);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const p = safePts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) {
      normCum[i] =
        normCum[i - 1] + Math.hypot(p.x - safePts[i - 1].x, p.y - safePts[i - 1].y);
    }
  }

  const totalNormLen = Math.max(1e-6, normCum[n - 1]);
  const metersPerUnit = safeTargetM / totalNormLen;
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;

  const eastM = new Float64Array(n);
  const northM = new Float64Array(n);
  const cumDistM = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    eastM[i] = (safePts[i].x - centerX) * metersPerUnit;
    northM[i] = (safePts[i].y - centerY) * metersPerUnit;
    cumDistM[i] = normCum[i] * metersPerUnit;
  }

  // Compute exit tangent from final ~3% of path for clean baseline extension if rider exceeds length
  let exitDirX = 1;
  let exitDirY = 0;
  for (let i = n - 2; i >= 0; i--) {
    const dx = eastM[n - 1] - eastM[i];
    const dy = northM[n - 1] - northM[i];
    const len = Math.hypot(dx, dy);
    if (len >= Math.min(40, safeTargetM * 0.02)) {
      exitDirX = dx / len;
      exitDirY = dy / len;
      break;
    }
  }

  // Helper to sample physical (eastM, northM) by binary search on cumDistM
  const sampleXY = (distM: number): [number, number] => {
    const d = Math.max(0, Math.min(safeTargetM, distM));
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cumDistM[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segLen = cumDistM[hi] - cumDistM[lo];
    const t = segLen > 1e-9 ? (d - cumDistM[lo]) / segLen : 0;
    return [
      eastM[lo] + (eastM[hi] - eastM[lo]) * t,
      northM[lo] + (northM[hi] - northM[lo]) * t,
    ];
  };

  // Precompute signed curvature LUT along arc length
  // Sign convention: + = RIGHT turn (road bends +X), - = LEFT turn (road bends -X)
  const rawCurvatureLut = new Float32Array(CURVATURE_LUT_SAMPLES);
  const curvatureLut = new Float32Array(CURVATURE_LUT_SAMPLES);
  const windowM = Math.max(10, Math.min(28, safeTargetM * 0.0022));

  for (let i = 0; i < CURVATURE_LUT_SAMPLES; i++) {
    const s = (i / (CURVATURE_LUT_SAMPLES - 1)) * safeTargetM;
    const sBack = Math.max(0, s - windowM);
    const sMid = s;
    const sFwd = Math.min(safeTargetM, s + windowM);

    const [x0, y0] = sampleXY(sBack);
    const [x1, y1] = sampleXY(sMid);
    const [x2, y2] = sampleXY(sFwd);

    const dx1 = x1 - x0;
    const dy1 = y1 - y0;
    const dx2 = x2 - x1;
    const dy2 = y2 - y1;
    const l1 = Math.hypot(dx1, dy1);
    const l2 = Math.hypot(dx2, dy2);

    if (l1 > 0.5 && l2 > 0.5) {
      const th1 = Math.atan2(dy1, dx1);
      const th2 = Math.atan2(dy2, dx2);
      // In East/North coords, positive dTheta = LEFT turn; negate so +curvature = RIGHT turn (+X in 3D)
      const dTheta = wrapAngleDelta(th2 - th1);
      const span = 0.5 * (l1 + l2);
      const rawK = -dTheta / Math.max(1, span);
      rawCurvatureLut[i] = rawK;
    }
  }

  // Smooth the curvature LUT with a 5-tap Gaussian kernel, then soft-saturate tight 180° hairpins
  // via tanh so tiny-radius GPS bends become crisp, dramatic, playable sharp bends in 3D.
  for (let i = 0; i < CURVATURE_LUT_SAMPLES; i++) {
    const kM2 = rawCurvatureLut[Math.max(0, i - 2)];
    const kM1 = rawCurvatureLut[Math.max(0, i - 1)];
    const k0 = rawCurvatureLut[i];
    const kP1 = rawCurvatureLut[Math.min(CURVATURE_LUT_SAMPLES - 1, i + 1)];
    const kP2 = rawCurvatureLut[Math.min(CURVATURE_LUT_SAMPLES - 1, i + 2)];
    const smoothed = kM2 * 0.1 + kM1 * 0.22 + k0 * 0.36 + kP1 * 0.22 + kP2 * 0.1;

    // Gentle amplification on medium curves, smooth hyperbolic clamp on tight 180° hairpins
    const amplified = smoothed * 1.45;
    curvatureLut[i] =
      MAX_IN_GAME_CURVATURE * Math.tanh(amplified / MAX_IN_GAME_CURVATURE);
  }

  return {
    id,
    name,
    closedLoop,
    totalLengthM: safeTargetM,
    eastM,
    northM,
    cumDistM,
    previewPoints: safePts,
    exitDirX,
    exitDirY,
    curvatureLut,
    rawCurvatureLut,
  };
}

/**
 * Sample exact 1:1 conformal GPS coordinates (lat, lon) centered on Ura-shima
 * for a given cumulative ridden distance (meters).
 */
export function sampleCompiledRouteGps(
  route: CompiledGpsRoute | null,
  distanceM: number
): VirtualGpsPoint {
  if (!route || route.id === 'urashima-loop') {
    return sampleUrashimaGps(distanceM);
  }

  const safeDist = Math.max(0, distanceM);
  const n = route.cumDistM.length;
  let east = 0;
  let north = 0;

  if (route.closedLoop && route.totalLengthM > 0) {
    const wrapped = safeDist % route.totalLengthM;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (route.cumDistM[mid] <= wrapped) lo = mid;
      else hi = mid;
    }
    const segLen = route.cumDistM[hi] - route.cumDistM[lo];
    const t = segLen > 1e-9 ? (wrapped - route.cumDistM[lo]) / segLen : 0;
    east = route.eastM[lo] + (route.eastM[hi] - route.eastM[lo]) * t;
    north = route.northM[lo] + (route.northM[hi] - route.northM[lo]) * t;
  } else if (safeDist <= route.totalLengthM) {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (route.cumDistM[mid] <= safeDist) lo = mid;
      else hi = mid;
    }
    const segLen = route.cumDistM[hi] - route.cumDistM[lo];
    const t = segLen > 1e-9 ? (safeDist - route.cumDistM[lo]) / segLen : 0;
    east = route.eastM[lo] + (route.eastM[hi] - route.eastM[lo]) * t;
    north = route.northM[lo] + (route.northM[hi] - route.northM[lo]) * t;
  } else {
    // Past the end of an open GPS drawing (e.g. Bike): continue cleanly straight along
    // the exit baseline so extra ride distance never scribbles back over the artwork.
    const extraM = safeDist - route.totalLengthM;
    east = route.eastM[n - 1] + route.exitDirX * extraM;
    north = route.northM[n - 1] + route.exitDirY * extraM;
  }

  return {
    latDeg: URASHIMA_CENTER_LAT + north / METERS_PER_DEG_LAT,
    lonDeg: URASHIMA_CENTER_LON + east / METERS_PER_DEG_LON,
  };
}

/**
 * Sample bounded signed in-game 3D corner curvature (rad/m) at cumulative distance (m).
 * Positive = Right bend (+X), Negative = Left bend (-X), 0 = Straight road.
 */
export function sampleCompiledRouteCurvature(
  route: CompiledGpsRoute | null,
  distanceM: number
): number {
  if (!route || route.totalLengthM <= 0) return 0;

  let d = distanceM;
  if (d < 0) return 0;
  if (route.closedLoop) {
    d = d % route.totalLengthM;
  } else if (d > route.totalLengthM) {
    // Straight exit road after finishing the drawing
    return 0;
  }

  const u = (d / route.totalLengthM) * (route.curvatureLut.length - 1);
  const i0 = Math.floor(u);
  const i1 = Math.min(route.curvatureLut.length - 1, i0 + 1);
  const frac = u - i0;
  return route.curvatureLut[i0] + (route.curvatureLut[i1] - route.curvatureLut[i0]) * frac;
}

/**
 * Sample fractional completion progress [0..1] along the GPS Art drawing for live HUD preview.
 */
export function sampleCompiledRouteProgress(
  route: CompiledGpsRoute | null,
  distanceM: number
): number {
  if (!route || route.totalLengthM <= 0) return 0;
  if (route.closedLoop) return (Math.max(0, distanceM) % route.totalLengthM) / route.totalLengthM;
  return Math.max(0, Math.min(1, distanceM / route.totalLengthM));
}

/**
 * Build the active CompiledGpsRoute for a preset ID, optional custom points, and target distance (km).
 * Returns null for 'urashima-loop' so the classic coastal loop & gentle default road spline run untouched.
 */
export function buildActiveGpsRoute(options: {
  presetId: GpsRoutePresetId;
  targetDistanceKm: number;
  customName?: string;
  customPoints?: readonly NormalizedPoint[];
  customClosedLoop?: boolean;
}): CompiledGpsRoute | null {
  const targetM = Math.max(1000, options.targetDistanceKm * 1000);
  if (options.presetId === 'bike-line-art') {
    return compileGpsRoute(
      'bike-line-art',
      'Single-Line Bike',
      BIKE_LINE_ART_POINTS,
      targetM,
      false
    );
  }
  if (
    options.presetId === 'custom-drawing' &&
    options.customPoints &&
    options.customPoints.length >= 2
  ) {
    return compileGpsRoute(
      'custom-drawing',
      options.customName || 'Custom Line Drawing',
      options.customPoints,
      targetM,
      Boolean(options.customClosedLoop)
    );
  }
  return null;
}

export { BIKE_LINE_ART_POINTS };
