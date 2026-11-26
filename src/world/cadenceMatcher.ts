/**
 * Pure cadence-matching math and 2-bone analytical leg IK for the 3D NeonCyclist model.
 * Guarantees that the cyclist's crankset and legs spin at the exact RPM reported by
 * the connected Bluetooth cadence sensor / smart trainer (1:1 revolutions per minute),
 * smoothly handling discrete 1 Hz BLE packets, coasting timeouts, and resting crank pose.
 */

export const CADENCE_STALE_TIMEOUT_MS = 3000;
export const MAX_MODEL_CADENCE_RPM = 220;

export interface CadenceMatcherState {
  /** Smoothed RPM currently driving the 3D cyclist crankset */
  currentRpm: number;
  /** Cumulative forward crank angle in radians (2π per full pedal revolution) */
  crankRad: number;
  /** Last non-stale RPM observed from sensor */
  effectiveTargetRpm: number;
  /** True when sensor packets went stale and cadence smoothly coasted to 0 */
  staleZeroed: boolean;
}

export interface CadenceMatcherInput {
  /** Live cadence reported by Bluetooth cadence sensor / trainer (RPM) */
  sensorRpm: number;
  /** Timestamp (ms) of the most recent cadence telemetry packet (0 if none/continuous) */
  lastPacketMs: number;
  /** Current monotonic/epoch timestamp (ms) */
  nowMs: number;
  /** Whether 1:1 Bluetooth cadence matching is enabled */
  enabled: boolean;
  /** Fallback RPM when cadence matching is disabled or in menu demo mode */
  fallbackRpm: number;
  /** Milliseconds without a fresh sensor update before coasting to 0 RPM */
  staleTimeoutMs?: number;
}

export function createCadenceMatcherState(): CadenceMatcherState {
  return {
    currentRpm: 0,
    crankRad: Math.PI * 0.5, // Start with horizontal resting pedals
    effectiveTargetRpm: 0,
    staleZeroed: false,
  };
}

/**
 * Advance the 3D cyclist crank model by dtSec so its angular velocity matches
 * the Bluetooth sensor RPM at an exact 1:1 ratio (omega = RPM * 2π / 60).
 */
export function stepCadenceMatcher(
  state: CadenceMatcherState,
  input: CadenceMatcherInput,
  dtSec: number
): CadenceMatcherState {
  const dt = Math.max(0, Math.min(0.1, dtSec));
  const staleMs = input.staleTimeoutMs ?? CADENCE_STALE_TIMEOUT_MS;

  let targetRpm = 0;
  let staleZeroed = false;

  if (input.enabled) {
    const clampedSensor = Number.isFinite(input.sensorRpm)
      ? Math.max(0, Math.min(MAX_MODEL_CADENCE_RPM, input.sensorRpm))
      : 0;
    const isStale =
      clampedSensor > 0 &&
      input.lastPacketMs > 0 &&
      input.nowMs - input.lastPacketMs > staleMs;

    if (isStale) {
      targetRpm = 0;
      staleZeroed = true;
    } else {
      targetRpm = clampedSensor;
    }
  } else {
    targetRpm = Number.isFinite(input.fallbackRpm)
      ? Math.max(0, Math.min(MAX_MODEL_CADENCE_RPM, input.fallbackRpm))
      : 0;
  }

  // Crisp low-latency exponential response:
  // ~0.16s time constant when matching active cadence changes (locks within ~0.5s),
  // ~0.34s flywheel-like coasting decay when dropping to 0 rpm.
  const tau = targetRpm > 0.5 ? 0.16 : 0.34;
  const blend = 1 - Math.exp(-dt / tau);
  let nextRpm = state.currentRpm + (targetRpm - state.currentRpm) * blend;

  // Snap cleanly to exact target when within 0.08 RPM to prevent endless tiny drift
  if (Math.abs(targetRpm - nextRpm) < 0.08) {
    nextRpm = targetRpm;
  }

  let nextCrankRad = state.crankRad;
  if (nextRpm > 0.5) {
    // Exact physical angular velocity: 1 revolution = 2π rad, RPM / 60 rev/s
    nextCrankRad += (nextRpm / 60) * Math.PI * 2 * dt;
  } else if (targetRpm === 0 && nextRpm <= 0.5) {
    nextRpm = 0;
    // Gently settle crank arms to horizontal resting coast position (π/2 or 3π/2 mod 2π)
    const twoPi = Math.PI * 2;
    const norm = ((nextCrankRad % twoPi) + twoPi) % twoPi;
    const restA = Math.PI * 0.5;
    const restB = Math.PI * 1.5;
    const diffA = ((restA - norm + Math.PI * 3) % twoPi) - Math.PI;
    const diffB = ((restB - norm + Math.PI * 3) % twoPi) - Math.PI;
    const shortestDiff = Math.abs(diffA) <= Math.abs(diffB) ? diffA : diffB;
    nextCrankRad += shortestDiff * (1 - Math.exp(-dt * 4.5));
  }

  state.currentRpm = nextRpm;
  state.crankRad = nextCrankRad;
  state.effectiveTargetRpm = targetRpm;
  state.staleZeroed = staleZeroed;
  return state;
}

export interface TwoBoneLegPose {
  /** Pedal spindle position in bike-local YZ plane */
  pedalY: number;
  pedalZ: number;
  /** Knee joint position in bike-local YZ plane (bending forward toward -Z) */
  kneeY: number;
  kneeZ: number;
  /** Midpoint & X-axis pitch angle for thigh capsule (hip -> knee) */
  thighMidY: number;
  thighMidZ: number;
  thighRotX: number;
  /** Midpoint & X-axis pitch angle for shin capsule (knee -> pedal) */
  shinMidY: number;
  shinMidZ: number;
  shinRotX: number;
}

/**
 * Exact 2D analytical two-bone IK in the sagittal (Y-Z) plane for a cyclist's leg.
 * Coordinates: +Y = up, -Z = forward (direction of travel).
 * Knee always bends forward (toward -Z), keeping the foot locked to the rotating pedal spindle.
 */
export function solveTwoBoneLegIK(
  hipY: number,
  hipZ: number,
  pedalY: number,
  pedalZ: number,
  thighLen: number,
  shinLen: number
): TwoBoneLegPose {
  const dy = pedalY - hipY;
  const dz = pedalZ - hipZ;
  const rawDist = Math.hypot(dy, dz);
  const minDist = Math.abs(thighLen - shinLen) + 0.02;
  const maxDist = thighLen + shinLen - 0.01;
  const dist = Math.max(minDist, Math.min(maxDist, rawDist));

  // Unit vector from hip toward pedal
  const uy = rawDist > 1e-6 ? dy / rawDist : -1;
  const uz = rawDist > 1e-6 ? dz / rawDist : 0;

  // Law of cosines: distance along hip->pedal line to knee projection
  const a = (thighLen * thighLen - shinLen * shinLen + dist * dist) / (2 * dist);
  const hSq = Math.max(0, thighLen * thighLen - a * a);
  const h = Math.sqrt(hSq);

  // Perpendicular vector pointing FORWARD (-Z) when hip->pedal points downward (-Y):
  // If u = (uy, uz) ≈ (-1, 0), then perp = (uz, -uy) has perpZ = -uy ≈ +1 (backward),
  // so forward-bending perpendicular is (-uz, uy) where perpZ = uy ≈ -1 (forward -Z)!
  const perpY = -uz;
  const perpZ = uy;

  const kneeY = hipY + a * uy + h * perpY;
  const kneeZ = hipZ + a * uz + h * perpZ;

  // CapsuleGeometry default axis is +Y. Rotating around +X by rx maps (0, +1, 0) -> (0, cos(rx), sin(rx)).
  // Wait: in Three.js, R_x(rx) * (0, 1, 0)^T = (0, cos(rx), sin(rx))^T.
  // So to align local +Y along vector (vy, vz), rx = atan2(vz, vy).
  const thighVy = kneeY - hipY;
  const thighVz = kneeZ - hipZ;
  const thighRotX = Math.atan2(thighVz, thighVy);

  const shinVy = pedalY - kneeY;
  const shinVz = pedalZ - kneeZ;
  const shinRotX = Math.atan2(shinVz, shinVy);

  return {
    pedalY,
    pedalZ,
    kneeY,
    kneeZ,
    thighMidY: (hipY + kneeY) * 0.5,
    thighMidZ: (hipZ + kneeZ) * 0.5,
    thighRotX,
    shinMidY: (kneeY + pedalY) * 0.5,
    shinMidZ: (kneeZ + pedalZ) * 0.5,
    shinRotX,
  };
}
