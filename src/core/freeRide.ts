/**
 * Pure Free Ride terrain generation and ERG zone-range power targeting logic.
 *
 * - Terrain: randomly seeded, infinitely smooth undulating elevation profile
 *   whose gradient is mathematically bounded and strictly <= 15% (0.15).
 * - ERG Power: keeps the target strictly inside the rider's selected Coggan zone
 *   range while allowing ±5 W on-the-fly adjustments to the middle of the range.
 */

import { COGGAN_ZONES, ZoneNumber } from './zones';

export const FREE_RIDE_MAX_GRADE = 0.15; // 15% max uphill gradient
export const FREE_RIDE_MIN_GRADE = -0.14; // Gentle max downhill gradient
export const FREE_RIDE_WATT_STEP = 5;

export interface ZoneWattRange {
  zone: ZoneNumber;
  minWatts: number;
  maxWatts: number;
  midWatts: number;
}

export interface FreeRideWaveComponent {
  amplitudeM: number;
  angularFreq: number; // rad / m
  phase: number; // rad
}

export interface FreeRideTerrainProfile {
  seed: number;
  baseGradeBias: number;
  waves: FreeRideWaveComponent[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create a randomly undulating infinite road elevation profile where the exact
 * analytical gradient dy/ds is strictly bounded below 15% everywhere.
 */
export function createFreeRideTerrain(
  seed = Math.floor(Math.random() * 0x7fffffff) || 1984
): FreeRideTerrainProfile {
  const rand = mulberry32(seed);

  // Five wavelengths from rolling ~130m punches up to ~860m climbs for natural cycling terrain
  const wavelengths = [135, 225, 360, 560, 860];
  const rawWeights = [0.24, 0.28, 0.24, 0.15, 0.09];

  // Randomize each component's relative weight slightly while normalizing total peak slope
  const perturbed = rawWeights.map((w) => w * (0.75 + rand() * 0.5));
  const weightSum = perturbed.reduce((a, b) => a + b, 0);

  // Reserve a small positive bias (+0.6%) and cap sum of |A_k * w_k| at 0.138
  // => Guaranteed global maximum gradient <= 0.138 + 0.006 = 0.144 (< 15%!)
  // => Guaranteed global minimum gradient >= -0.138 + 0.006 = -0.132
  const maxSlopeBudget = 0.138;
  const baseGradeBias = 0.006;

  const waves: FreeRideWaveComponent[] = wavelengths.map((wl, i) => {
    const variedWl = wl * (0.88 + rand() * 0.24);
    const angularFreq = (Math.PI * 2) / variedWl;
    const slopeShare = (perturbed[i] / weightSum) * maxSlopeBudget;
    const amplitudeM = slopeShare / angularFreq;
    const phase = rand() * Math.PI * 2;
    return { amplitudeM, angularFreq, phase };
  });

  return {
    seed,
    baseGradeBias,
    waves,
  };
}

/**
 * Evaluate exact elevation height (meters) along the undulating Free Ride road at distance s (m).
 */
export function sampleFreeRideElevation(
  terrain: FreeRideTerrainProfile,
  distanceM: number
): number {
  let y = distanceM * terrain.baseGradeBias;
  const waves = terrain.waves;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    y += w.amplitudeM * Math.sin(distanceM * w.angularFreq + w.phase);
  }
  return y;
}

/**
 * Evaluate exact road gradient (rise / run) at distance s (m), strictly bounded to [-0.14, +0.15].
 */
export function sampleFreeRideGrade(
  terrain: FreeRideTerrainProfile,
  distanceM: number
): number {
  let slope = terrain.baseGradeBias;
  const waves = terrain.waves;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    slope += w.amplitudeM * w.angularFreq * Math.cos(distanceM * w.angularFreq + w.phase);
  }
  return Math.max(FREE_RIDE_MIN_GRADE, Math.min(FREE_RIDE_MAX_GRADE, slope));
}

/**
 * Compute the ERG wattage bounds and mid-range center for a selected Coggan zone at given FTP.
 */
export function getZoneWattRange(zone: ZoneNumber, ftp: number): ZoneWattRange {
  const safeFtp = Math.max(80, Math.round(ftp));
  const info = COGGAN_ZONES[zone];
  const minPct = zone === 1 ? 40 : info.minPct;
  const maxPct = info.maxPct ?? 185;

  const minWatts = Math.max(40, Math.round((minPct / 100) * safeFtp));
  const maxWatts = Math.max(minWatts + 10, Math.round((maxPct / 100) * safeFtp));
  const midWatts = Math.round((minWatts + maxWatts) / 2);

  return { zone, minWatts, maxWatts, midWatts };
}

export interface ClampedFreeRideRangeState extends ZoneWattRange {
  centerWatts: number;
  clampedOffsetWatts: number;
}

/**
 * Apply the user's ±5 W mid-range adjustment while keeping the adjusted center
 * strictly within the selected zone's [minWatts, maxWatts] range.
 */
export function clampFreeRideCenterWatts(
  zone: ZoneNumber,
  ftp: number,
  offsetWatts: number
): ClampedFreeRideRangeState {
  const range = getZoneWattRange(zone, ftp);
  const rawCenter = range.midWatts + Math.round(offsetWatts);
  const centerWatts = Math.max(range.minWatts, Math.min(range.maxWatts, rawCenter));
  const clampedOffsetWatts = centerWatts - range.midWatts;

  return {
    ...range,
    centerWatts,
    clampedOffsetWatts,
  };
}

/**
 * Compute the live Free Ride ERG target power (Watts) from the selected zone,
 * rider FTP, ±5 W mid-range adjustment, and current undulating terrain gradient.
 *
 * The resulting target smoothly responds to climbs/descents around the user's
 * chosen mid-range center while ALWAYS staying strictly inside [minWatts, maxWatts].
 */
export function computeFreeRideTargetWatts(
  zone: ZoneNumber,
  ftp: number,
  offsetWatts: number,
  currentGrade: number
): number {
  const state = clampFreeRideCenterWatts(zone, ftp, offsetWatts);
  const clampedGrade = Math.max(FREE_RIDE_MIN_GRADE, Math.min(FREE_RIDE_MAX_GRADE, currentGrade));
  const normalizedGrade = clampedGrade / FREE_RIDE_MAX_GRADE; // roughly -0.93 .. +1.0
  const halfSpan = (state.maxWatts - state.minWatts) / 2;

  // Modulate gently with terrain grade (±40% of half-span) around the adjusted center
  const terrainDelta = Math.round(normalizedGrade * halfSpan * 0.4);
  const rawTarget = state.centerWatts + terrainDelta;

  return Math.max(state.minWatts, Math.min(state.maxWatts, rawTarget));
}
