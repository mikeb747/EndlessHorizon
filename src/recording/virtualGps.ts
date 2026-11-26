/**
 * Virtual GPS coordinate synthesizer centered on Ura-shima, Japan
 * (Maruyama / Urashima Island area in the Seto Inland Sea: 34.2175° N, 133.7150° E).
 *
 * Maps cumulative virtual distance (meters) onto a smooth, continuous closed-loop
 * island circuit so FIT files contain valid GPS coordinates and distance-consistent
 * speed without overlapping real-world Strava road segments. Altitude is supplied
 * strictly from the in-game workout elevation profile rather than real-world terrain.
 */

export const URASHIMA_CENTER_LAT = 34.2175;
export const URASHIMA_CENTER_LON = 133.715;
export const VIRTUAL_START_ALTITUDE_M = 24.0;

// Smooth closed-loop coastal circuit radius (~700 m -> ~4.4 km per lap)
const LOOP_RADIUS_M = 700;
const METERS_PER_DEG_LAT = 111320;
const METERS_PER_DEG_LON =
  METERS_PER_DEG_LAT * Math.cos((URASHIMA_CENTER_LAT * Math.PI) / 180);

export interface VirtualGpsPoint {
  latDeg: number;
  lonDeg: number;
}

/**
 * Deterministically compute (lat, lon) around Ura-shima for a given cumulative distance (m).
 * Uses a gentle organic coastal loop parameterized by arc length so GPS velocity matches
 * reported virtual trainer speed accurately.
 */
export function sampleUrashimaGps(distanceM: number): VirtualGpsPoint {
  const safeDist = Math.max(0, distanceM);
  // Arc angle along perimeter (~2 * pi * R)
  const theta = safeDist / LOOP_RADIUS_M;

  // Mild harmonic modulation creates an organic island circuit shape while staying near unit speed
  const r = LOOP_RADIUS_M * (1 + 0.14 * Math.sin(2 * theta) + 0.06 * Math.cos(3 * theta));
  const northM = r * Math.sin(theta);
  const eastM = r * Math.cos(theta);

  return {
    latDeg: URASHIMA_CENTER_LAT + northM / METERS_PER_DEG_LAT,
    lonDeg: URASHIMA_CENTER_LON + eastM / METERS_PER_DEG_LON,
  };
}
