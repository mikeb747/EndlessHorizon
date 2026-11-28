import * as THREE from 'three';
import type { SceneryTheme } from '../store/useAppStore';
import {
  computeLinearRoadT,
  computeRoadSegmentZ,
  ROAD_SEGMENTS,
  ROAD_Z_FAR,
  ROAD_Z_NEAR,
  RoadSample,
  sampleRoadAtZ,
  WorldRuntimeState,
} from './roadMath';

export const ROAD_PROFILE_COUNT = ROAD_SEGMENTS + 1;

export const ROAD_SEGMENT_Z = new Float32Array(ROAD_PROFILE_COUNT);
export const ROAD_SEGMENT_LINEAR_T = new Float32Array(ROAD_PROFILE_COUNT);

for (let i = 0; i < ROAD_PROFILE_COUNT; i++) {
  const z = computeRoadSegmentZ(i, ROAD_SEGMENTS, ROAD_Z_NEAR, ROAD_Z_FAR);
  ROAD_SEGMENT_Z[i] = z;
  ROAD_SEGMENT_LINEAR_T[i] = computeLinearRoadT(z, ROAD_Z_NEAR, ROAD_Z_FAR);
}

const _packSample: RoadSample = { x: 0, y: 0, slopeX: 0, slopeY: 0 };

/**
 * Create a preallocated array of ROAD_PROFILE_COUNT Vector4 uniforms for GPU vertex-shader
 * road bending & elevation. Each entry holds (centerX, centerY, slopeX, slopeY).
 */
export function createRoadProfileUniformArray(): THREE.Vector4[] {
  const arr: THREE.Vector4[] = new Array(ROAD_PROFILE_COUNT);
  for (let i = 0; i < ROAD_PROFILE_COUNT; i++) {
    arr[i] = new THREE.Vector4(0, 0, 0, 0);
  }
  return arr;
}

/**
 * Sample the active road spline + elevation profile into the preallocated GPU uniform array
 * with ZERO heap allocations per frame.
 */
export function packRoadProfileUniforms(
  rt: WorldRuntimeState,
  profileOut: THREE.Vector4[],
  segmentZ: Float32Array = ROAD_SEGMENT_Z
): void {
  const count = Math.min(profileOut.length, segmentZ.length);
  const dist = rt.distance;
  for (let i = 0; i < count; i++) {
    sampleRoadAtZ(
      dist,
      segmentZ[i],
      _packSample,
      rt.elevationProfile,
      rt.workoutElapsedSec,
      rt.freeRideTerrain
    );
    profileOut[i].set(_packSample.x, _packSample.y, _packSample.slopeX, _packSample.slopeY);
  }
}

export interface UnifiedSkyThemeParams {
  shaderIndex: number;
  sunBaseElev: number;
  sunAngularRadius: number;
  haloColorHex: string;
}

export function getUnifiedSkyThemeParams(theme: SceneryTheme): UnifiedSkyThemeParams {
  switch (theme) {
    case 'causeway-embankment':
      return {
        shaderIndex: 3,
        sunBaseElev: 0.115,
        sunAngularRadius: 0.2,
        haloColorHex: '#ff925c',
      };
    case 'cloud-horizon':
      return {
        shaderIndex: 2,
        sunBaseElev: 0.125,
        sunAngularRadius: 0.235,
        haloColorHex: '#66e8ff',
      };
    case 'palm-grove':
      return {
        shaderIndex: 1,
        sunBaseElev: 0.13,
        sunAngularRadius: 0.21,
        haloColorHex: '#ff2a9d',
      };
    case 'neon-city':
    default:
      return {
        shaderIndex: 0,
        sunBaseElev: 0.13,
        sunAngularRadius: 0.21,
        haloColorHex: '#ff2a9d',
      };
  }
}
