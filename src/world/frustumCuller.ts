/**
 * Zero-allocation Camera Frustum Culling & Adaptive FOV Bounding utilities.
 *
 * Extracts the 6 normalized Gribb-Hartmann frustum planes from the camera's
 * projection * view matrix into a reusable Float32Array(24), allowing instanced
 * scenery and effects to skip off-screen and behind-camera geometry before GPU draw.
 */

export const CAMERA_FOV_MIN = 46;
export const CAMERA_FOV_MAX = 66;

export interface AdaptiveCameraFraming {
  fov: number;
  camZ: number;
  camY: number;
}

/**
 * Compute bounded forward vertical FOV and camera follow offset across portrait (1146x1392),
 * tablet (1280x800), and ultrawide (3440x1440) viewports.
 * Keeping vertical FOV within [46°, 66°] limits peripheral overdraw and boosts frustum culling
 * while pulling the camera back slightly in portrait mode so both road edges stay framed.
 */
export function computeAdaptiveCameraFraming(
  aspect: number,
  speedFovKick: number
): AdaptiveCameraFraming {
  const safeAspect = Math.max(0.45, aspect);
  const clampedKick = Math.max(0, Math.min(4.0, speedFovKick));

  let baseFov = 54;
  let camZ = 4.6;
  let camY = 2.22;

  if (safeAspect < 1.0) {
    // Portrait / tall window: gently tighten FOV cap and pull back slightly to frame both road edges
    const narrowFactor = Math.max(0, Math.min(1, (1.0 - safeAspect) / 0.55));
    baseFov = 57 + narrowFactor * 7;
    camZ = 5.05 + narrowFactor * 1.25;
    camY = 2.4 + narrowFactor * 0.36;
  } else if (safeAspect > 1.8) {
    // Wide / ultrawide monitor: tighter forward FOV reduces peripheral geometry & distortion
    const wideFactor = Math.max(0, Math.min(1, (safeAspect - 1.8) / 1.2));
    baseFov = 52 - wideFactor * 5;
    camZ = 4.35 - wideFactor * 0.2;
  }

  const fov = Math.max(CAMERA_FOV_MIN, Math.min(CAMERA_FOV_MAX, baseFov + clampedKick));
  return { fov, camZ, camY };
}

/**
 * Compute the distance (meters) at which Three.js FogExp2 reaches a given opacity threshold
 * (e.g. 0.985 => 98.5% fogged out). Objects beyond this distance are invisible in the haze.
 */
export function computeFogCullDistance(fogDensity: number, opacityThreshold = 0.985): number {
  if (fogDensity <= 0) return Infinity;
  const clamped = Math.max(0.1, Math.min(0.9999, opacityThreshold));
  return Math.sqrt(-Math.log(1 - clamped)) / fogDensity;
}

/**
 * Extract 6 normalized inward-facing frustum planes from a column-major 4x4
 * `projectionMatrix * matrixWorldInverse` array into `out` (length >= 24).
 *
 * Plane order is optimized for fast rejection in forward-driving scenes:
 *   0: Near (rejects behind-camera instances immediately!)
 *   1: Left
 *   2: Right
 *   3: Far
 *   4: Top
 *   5: Bottom
 */
export function extractFrustumPlanes(
  m: ArrayLike<number>,
  out: Float32Array
): Float32Array {
  const me0 = m[0], me1 = m[1], me2 = m[2], me3 = m[3];
  const me4 = m[4], me5 = m[5], me6 = m[6], me7 = m[7];
  const me8 = m[8], me9 = m[9], me10 = m[10], me11 = m[11];
  const me12 = m[12], me13 = m[13], me14 = m[14], me15 = m[15];

  setNormalizedPlane(out, 0, me3 + me2, me7 + me6, me11 + me10, me15 + me14); // Near
  setNormalizedPlane(out, 4, me3 + me0, me7 + me4, me11 + me8, me15 + me12); // Left
  setNormalizedPlane(out, 8, me3 - me0, me7 - me4, me11 - me8, me15 - me12); // Right
  setNormalizedPlane(out, 12, me3 - me2, me7 - me6, me11 - me10, me15 - me14); // Far
  setNormalizedPlane(out, 16, me3 - me1, me7 - me5, me11 - me9, me15 - me13); // Top
  setNormalizedPlane(out, 20, me3 + me1, me7 + me5, me11 + me9, me15 + me13); // Bottom
  return out;
}

function setNormalizedPlane(
  out: Float32Array,
  offset: number,
  nx: number,
  ny: number,
  nz: number,
  d: number
): void {
  const len = Math.hypot(nx, ny, nz);
  const invLen = len > 1e-8 ? 1 / len : 1;
  out[offset + 0] = nx * invLen;
  out[offset + 1] = ny * invLen;
  out[offset + 2] = nz * invLen;
  out[offset + 3] = d * invLen;
}

/**
 * Exact sphere-vs-frustum visibility test (zero allocations).
 * Returns false if the sphere lies strictly outside any of the 6 frustum planes.
 */
export function isSphereInFrustum(
  planes: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  radius: number
): boolean {
  for (let i = 0; i < 24; i += 4) {
    const dist =
      planes[i + 0] * cx + planes[i + 1] * cy + planes[i + 2] * cz + planes[i + 3];
    if (dist < -radius) return false;
  }
  return true;
}

/**
 * Exact axis-aligned bounding box (center + half-extents) vs frustum visibility test.
 * Tighter than bounding spheres for tall buildings, palm trees, and rain streaks.
 */
export function isAabbInFrustum(
  planes: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number
): boolean {
  for (let i = 0; i < 24; i += 4) {
    const nx = planes[i + 0];
    const ny = planes[i + 1];
    const nz = planes[i + 2];
    const d = planes[i + 3];
    const dist = nx * cx + ny * cy + nz * cz + d;
    const projRadius = Math.abs(nx) * hx + Math.abs(ny) * hy + Math.abs(nz) * hz;
    if (dist + projRadius < 0) return false;
  }
  return true;
}
