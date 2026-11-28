import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { QualityLevel, SceneryTheme } from '../store/useAppStore';
import { isAabbInFrustum, isSphereInFrustum } from './frustumCuller';
import {
  CAUSEWAY_EMBANKMENT_DROP_M,
  CAUSEWAY_EMBANKMENT_TOE_X,
  CLOUD_HORIZON_BUSH_SPACING_M,
  CLOUD_HORIZON_SPRITE_COUNT,
  computeBuildingCenterOffset,
  computeForwardScrollOffset,
  computeLinearRoadT,
  computeRoadSegmentZ,
  NEON_CITY_CURB_GAP,
  NEON_CITY_MIN_BUILDING_FRONT_X,
  NEON_CITY_SIDEWALK_HEIGHT,
  NEON_CITY_SIDEWALK_PAVED_WIDTH,
  NEON_CITY_SIDEWALK_TOTAL_WIDTH,
  PALM_GROVE_CLIFF_WIDTH,
  PALM_GROVE_LANE_STEP_M,
  PALM_GROVE_PALM_COUNT,
  ROAD_HALF_WIDTH,
  ROAD_SEGMENTS,
  ROAD_Z_FAR,
  ROAD_Z_NEAR,
  ROAD_Z_SPAN,
  RoadSample,
  sampleRoadAtZ,
  WorldRuntimeState,
} from './roadMath';
import { getUnifiedSkyThemeParams } from './roadShaderHelpers';

interface SceneryThemesProps {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  sceneryTheme: SceneryTheme;
  quality: QualityLevel;
}

// Module-level scratch objects (zero per-frame allocations in all useFrame callbacks)
const _dummy = new THREE.Object3D();
const _sample: RoadSample = { x: 0, y: 0, slopeX: 0, slopeY: 0 };
const _color = new THREE.Color();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camForward = new THREE.Vector3();

// Preallocated palette Color constants (avoids per-instance hex string parsing inside useFrame)
const _colCyanTrash = new THREE.Color('#00e8ff');
const _colPinkTrash = new THREE.Color('#ff3ca8');
const _colMagentaBike = new THREE.Color('#ff2a9d');
const _colCyanBike = new THREE.Color('#00f0ff');
const _colCyanPalm = new THREE.Color('#00d8e8');
const _colPinkPalm = new THREE.Color('#e63a9c');
const _colCyanRain = new THREE.Color('#5cf0ff');
const _colPinkRain = new THREE.Color('#e68aff');
const _colCyanBollard = new THREE.Color('#3cf0ff');
const _colAmberBollard = new THREE.Color('#ff9852');

// Shared precomputed non-linear LOD Z coordinates and linear UV-t values (allocated once)
const STRIP_SEGMENTS = ROAD_SEGMENTS;
const STRIP_Z = new Float32Array(STRIP_SEGMENTS + 1);
const STRIP_LINEAR_T = new Float32Array(STRIP_SEGMENTS + 1);
for (let i = 0; i <= STRIP_SEGMENTS; i++) {
  const z = computeRoadSegmentZ(i, STRIP_SEGMENTS, ROAD_Z_NEAR, ROAD_Z_FAR);
  STRIP_Z[i] = z;
  STRIP_LINEAR_T[i] = computeLinearRoadT(z, ROAD_Z_NEAR, ROAD_Z_FAR);
}

// Reusable per-frame centerline buffers for Neon City sidewalks & Causeway embankments
const _cityCenterX = new Float32Array(STRIP_SEGMENTS + 1);
const _cityCenterY = new Float32Array(STRIP_SEGMENTS + 1);

/**
 * Shared terrain-conforming wide ground/water ribbon matching NeonRoad's non-linear
 * LOD Z segments & linear world-meter UVs (zero per-frame allocations).
 */
function buildLevelRibbonGeometry(halfWidth: number, yOffset: number): THREE.BufferGeometry {
  const vertexCount = (STRIP_SEGMENTS + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];

  for (let i = 0; i <= STRIP_SEGMENTS; i++) {
    const z = STRIP_Z[i];
    const linearT = STRIP_LINEAR_T[i];
    const idx = i * 6;
    positions[idx + 0] = -halfWidth;
    positions[idx + 1] = yOffset;
    positions[idx + 2] = z;
    positions[idx + 3] = halfWidth;
    positions[idx + 4] = yOffset;
    positions[idx + 5] = z;

    normals[idx + 1] = 1;
    normals[idx + 4] = 1;

    uvs[i * 4 + 0] = 0;
    uvs[i * 4 + 1] = linearT;
    uvs[i * 4 + 2] = 1;
    uvs[i * 4 + 3] = linearT;

    if (i < STRIP_SEGMENTS) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function updateLevelRibbonFromRoad(
  geo: THREE.BufferGeometry,
  rt: WorldRuntimeState,
  halfWidth: number,
  yOffset: number
): void {
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;
  const dist = rt.distance;

  for (let i = 0; i <= STRIP_SEGMENTS; i++) {
    const z = STRIP_Z[i];
    sampleRoadAtZ(
      dist,
      z,
      _sample,
      rt.elevationProfile,
      rt.workoutElapsedSec,
      rt.freeRideTerrain
    );
    const yGround = _sample.y + yOffset;
    const idx = i * 6;
    arr[idx + 0] = _sample.x - halfWidth;
    arr[idx + 1] = yGround;
    arr[idx + 2] = z;
    arr[idx + 3] = _sample.x + halfWidth;
    arr[idx + 4] = yGround;
    arr[idx + 5] = z;
  }

  posAttr.needsUpdate = true;
}

/**
 * Unified single-draw-call full-screen shader rendering Sky Gradient + Twinkling Stars +
 * Synthwave Horizon Sun + Soft Outer Halo across all 4 scenery themes.
 * Reconstructs exact camera view rays per pixel (zero geometry tessellation, zero overdraw,
 * zero per-frame allocations) and smoothly tracks camera FOV, aspect ratio, and climb pitch.
 */
function UnifiedSynthwaveSky({
  theme,
  runtimeRef,
}: {
  theme: SceneryTheme;
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
}) {
  const material = useMemo(() => {
    const initial = getUnifiedSkyThemeParams(theme);
    return new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTheme: { value: initial.shaderIndex },
        uTime: { value: 0 },
        uPitchOffset: { value: 0 },
        uSunElev: { value: initial.sunBaseElev },
        uSunRadius: { value: initial.sunAngularRadius },
        uHaloColor: { value: new THREE.Color(initial.haloColorHex) },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uCamForward: { value: new THREE.Vector3(0, 0, -1) },
        uAspect: { value: 1.77 },
        uTanHalfFov: { value: Math.tan(THREE.MathUtils.degToRad(30)) },
      },
      vertexShader: `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.9999, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vNdc;

        uniform float uTheme;
        uniform float uTime;
        uniform float uPitchOffset;
        uniform float uSunElev;
        uniform float uSunRadius;
        uniform vec3 uHaloColor;
        uniform vec3 uCamRight;
        uniform vec3 uCamUp;
        uniform vec3 uCamForward;
        uniform float uAspect;
        uniform float uTanHalfFov;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          vec3 rayDir = normalize(
            uCamForward
            + uCamRight * (vNdc.x * uAspect * uTanHalfFov)
            + uCamUp * (vNdc.y * uTanHalfFov)
          );

          // 1) Theme-specific 360-degree synthwave sky gradient
          float elev = rayDir.y - uPitchOffset;
          vec3 skyCol;

          if (uTheme > 2.5) {
            // Island Causeway
            vec3 nadirCol = vec3(0.03, 0.08, 0.16);
            vec3 horCol   = vec3(0.76, 0.36, 0.48);
            vec3 midCol   = vec3(0.11, 0.24, 0.42);
            vec3 topCol   = vec3(0.03, 0.06, 0.16);
            vec3 upper = mix(horCol, midCol, smoothstep(0.0, 0.26, max(0.0, elev)));
            upper = mix(upper, topCol, smoothstep(0.22, 0.74, max(0.0, elev)));
            skyCol = mix(nadirCol, upper, smoothstep(-0.12, 0.04, elev));
          } else if (uTheme > 1.5) {
            // Cloud Horizon
            vec3 nadirCol = vec3(0.08, 0.04, 0.22);
            vec3 horCol   = vec3(0.86, 0.34, 0.62);
            vec3 midCol   = vec3(0.38, 0.11, 0.56);
            vec3 topCol   = vec3(0.07, 0.035, 0.22);
            vec3 upper = mix(horCol, midCol, smoothstep(0.0, 0.28, max(0.0, elev)));
            upper = mix(upper, topCol, smoothstep(0.24, 0.78, max(0.0, elev)));
            skyCol = mix(nadirCol, upper, smoothstep(-0.14, 0.04, elev));
          } else if (uTheme > 0.5) {
            // Palm Grove
            vec3 nadirCol = vec3(0.06, 0.025, 0.16);
            vec3 horCol   = vec3(0.36, 0.10, 0.44);
            vec3 midCol   = vec3(0.15, 0.05, 0.30);
            vec3 topCol   = vec3(0.045, 0.02, 0.13);
            vec3 upper = mix(horCol, midCol, smoothstep(0.0, 0.24, max(0.0, elev)));
            upper = mix(upper, topCol, smoothstep(0.20, 0.72, max(0.0, elev)));
            skyCol = mix(nadirCol, upper, smoothstep(-0.12, 0.04, elev));
          } else {
            // Neon City
            vec3 nadirCol = vec3(0.04, 0.02, 0.11);
            vec3 horCol   = vec3(0.24, 0.08, 0.42);
            vec3 midCol   = vec3(0.09, 0.035, 0.23);
            vec3 topCol   = vec3(0.028, 0.012, 0.09);
            vec3 upper = mix(horCol, midCol, smoothstep(0.0, 0.22, max(0.0, elev)));
            upper = mix(upper, topCol, smoothstep(0.18, 0.68, max(0.0, elev)));
            skyCol = mix(nadirCol, upper, smoothstep(-0.10, 0.04, elev));
          }

          // 2) Procedural twinkling stars across upper sky (zero extra geometry or draw calls)
          if (elev > 0.05) {
            float az = atan(rayDir.x, -rayDir.z);
            float el = asin(clamp(rayDir.y, -1.0, 1.0));
            vec2 starGrid = vec2(az * 34.0, el * 34.0);
            vec2 cell = floor(starGrid);
            vec2 f = fract(starGrid) - 0.5;
            float rnd = hash21(cell);
            if (rnd > 0.90) {
              vec2 starOff = vec2(hash21(cell + 17.3) - 0.5, hash21(cell + 41.9) - 0.5) * 0.62;
              float distToStar = length(f - starOff);
              float starRadius = mix(0.045, 0.09, fract(rnd * 27.1));
              float starCore = 1.0 - smoothstep(0.0, starRadius, distToStar);
              float twinkle = 0.68 + 0.32 * sin(uTime * (1.8 + fract(rnd * 13.7) * 2.4) + rnd * 62.8);
              float horizonFade = smoothstep(0.06, 0.24, elev);
              skyCol += vec3(0.84, 0.91, 1.0) * starCore * twinkle * horizonFade * 0.92;
            }
          }

          // 3) Synthwave Horizon Sun + soft outer halo projected onto the forward sky hemisphere
          if (rayDir.z < -0.15) {
            float invZ = 1.0 / max(0.15, -rayDir.z);
            vec2 sunProj = vec2(rayDir.x * invZ, rayDir.y * invZ - uSunElev);
            vec2 sunP = sunProj / max(0.05, uSunRadius);
            float sunD = length(sunP);

            // Soft outer halo glow around the horizon sun
            float halo = exp(-sunD * sunD * 1.45) * 0.24;
            skyCol += uHaloColor * halo;

            if (sunD < 1.02) {
              float y = clamp(sunP.y * 0.5 + 0.5, 0.0, 1.0);
              vec3 sunCol;
              float alpha = 1.0 - smoothstep(0.955, 1.0, sunD);

              if (uTheme > 2.5) {
                // Island Causeway coastal sunset orb
                vec3 topCol = vec3(1.0, 0.78, 0.44);
                vec3 midCol = vec3(0.98, 0.46, 0.44);
                vec3 botCol = vec3(0.86, 0.28, 0.56);
                sunCol = mix(botCol, midCol, smoothstep(0.0, 0.48, y));
                sunCol = mix(sunCol, topCol, smoothstep(0.45, 1.0, y));
                float stripeAlpha = 1.0;
                if (y < 0.46) {
                  float stripeWave = fract(y * 16.0 - uTime * 0.04);
                  float gapThickness = mix(0.38, 0.08, y / 0.46);
                  stripeAlpha = step(gapThickness, stripeWave);
                }
                alpha *= stripeAlpha;
                sunCol *= 1.12;
              } else if (uTheme > 1.5) {
                // Cloud Horizon radiant white-cyan glowing orb
                vec3 core = vec3(0.95, 0.99, 1.0);
                vec3 mid = vec3(0.45, 0.92, 1.0);
                vec3 rim = vec3(0.92, 0.45, 0.98);
                sunCol = mix(core, mid, smoothstep(0.18, 0.86, sunD));
                sunCol = mix(sunCol, rim, smoothstep(0.84, 1.0, sunD));
                sunCol *= 1.15;
              } else {
                if (uTheme > 0.5) {
                  // Palm Grove warm coral-magenta to golden sunset
                  vec3 topCol = vec3(0.92, 0.30, 0.62);
                  vec3 midCol = vec3(0.96, 0.48, 0.42);
                  vec3 botCol = vec3(0.98, 0.72, 0.36);
                  sunCol = mix(botCol, midCol, smoothstep(0.0, 0.52, y));
                  sunCol = mix(sunCol, topCol, smoothstep(0.48, 1.0, y));
                } else {
                  // Neon City electric magenta to hot orange
                  vec3 topCol = vec3(0.98, 0.14, 0.74);
                  vec3 midCol = vec3(0.98, 0.32, 0.56);
                  vec3 botCol = vec3(1.0, 0.68, 0.22);
                  sunCol = mix(botCol, midCol, smoothstep(0.0, 0.55, y));
                  sunCol = mix(sunCol, topCol, smoothstep(0.50, 1.0, y));
                }
                float stripeAlpha = 1.0;
                if (y < 0.62) {
                  float stripeWave = fract(y * 18.0 - uTime * 0.06);
                  float gapThickness = mix(0.46, 0.10, y / 0.62);
                  stripeAlpha = step(gapThickness, stripeWave);
                }
                alpha *= stripeAlpha;
                sunCol *= 1.1;
              }

              skyCol = mix(skyCol, sunCol, clamp(alpha, 0.0, 1.0));
            }
          }

          gl_FragColor = vec4(skyCol, 1.0);
        }
      `,
    });
  }, []);

  useEffect(() => {
    const params = getUnifiedSkyThemeParams(theme);
    material.uniforms.uTheme.value = params.shaderIndex;
    material.uniforms.uSunRadius.value = params.sunAngularRadius;
    (material.uniforms.uHaloColor.value as THREE.Color).set(params.haloColorHex);
  }, [theme, material]);

  useEffect(() => () => material.dispose(), [material]);

  useFrame((state, delta) => {
    const dt = Math.min(0.1, delta);
    const cam = state.camera as THREE.PerspectiveCamera;
    const params = getUnifiedSkyThemeParams(theme);

    // Extract camera basis into module-level scratch vectors (ZERO allocations)
    cam.matrixWorld.extractBasis(_camRight, _camUp, _camForward);
    _camForward.negate();

    (material.uniforms.uCamRight.value as THREE.Vector3).copy(_camRight);
    (material.uniforms.uCamUp.value as THREE.Vector3).copy(_camUp);
    (material.uniforms.uCamForward.value as THREE.Vector3).copy(_camForward);
    material.uniforms.uAspect.value = cam.aspect;
    material.uniforms.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    material.uniforms.uTime.value += dt;

    const grade = runtimeRef.current.currentGrade;
    const targetPitch = grade * 0.26;
    const damp = Math.min(1, dt * 4);
    material.uniforms.uPitchOffset.value +=
      (targetPitch - material.uniforms.uPitchOffset.value) * damp;

    const targetSunElev = params.sunBaseElev + grade * 0.72;
    material.uniforms.uSunElev.value +=
      (targetSunElev - material.uniforms.uSunElev.value) * damp;
  });

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-100}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  );
}

/**
 * Procedural 8-frond arching palm crown BufferGeometry (merged into one single-drawcall mesh
 * for InstancedMesh rendering — looks unmistakably like iconic synthwave palm trees).
 */
function createPalmCrownGeometry(): THREE.BufferGeometry {
  const frondParts: THREE.BufferGeometry[] = [];
  const frondCount = 8;

  for (let i = 0; i < frondCount; i++) {
    const angle = (i / frondCount) * Math.PI * 2 + (i % 2) * 0.14;
    const droop = i % 2 === 0 ? 0.36 : 0.56;
    const length = i % 2 === 0 ? 2.15 : 1.75;

    // 3 arched segments per frond tapering to a sharp tip
    const seg1 = new THREE.BoxGeometry(0.32, 0.05, length * 0.42);
    seg1.translate(0, 0.14, length * 0.21);
    seg1.rotateX(-0.18 + droop * 0.25);
    seg1.rotateY(angle);
    frondParts.push(seg1);

    const seg2 = new THREE.BoxGeometry(0.24, 0.045, length * 0.42);
    seg2.translate(0, 0.02, length * 0.58);
    seg2.rotateX(0.22 + droop * 0.55);
    seg2.rotateY(angle);
    frondParts.push(seg2);

    const seg3 = new THREE.ConeGeometry(0.14, length * 0.38, 4);
    seg3.rotateX(Math.PI / 2 + 0.58 + droop * 0.65);
    seg3.translate(
      Math.sin(angle) * length * 0.88,
      -0.34 - droop * 0.35,
      Math.cos(angle) * length * 0.88
    );
    frondParts.push(seg3);
  }

  const merged = mergeGeometries(frondParts, false);
  frondParts.forEach((g) => g.dispose());
  merged.computeVertexNormals();
  return merged;
}

/**
 * Procedural building window facade texture (deep obsidian glass tower with crisp
 * orange/cyan/pink lit window bands — muted below road edge glow so zone color leads).
 */
function createBuildingWindowTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#070514';
  ctx.fillRect(0, 0, 256, 512);

  // Crisp neon architectural corner edge trims
  ctx.strokeStyle = 'rgba(130, 75, 225, 0.48)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 252, 508);

  const cols = 6;
  const rows = 22;
  const cellW = 256 / cols;
  const cellH = 512 / rows;

  const palette = ['#ff7a24', '#00b8e6', '#d63aa8', '#ff9e3d'];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const hash = Math.sin(r * 21.7 + c * 9.3) * 43758.5453;
      const frac = hash - Math.floor(hash);
      if (frac > 0.52) {
        const colorIdx = Math.floor((frac * 19) % palette.length);
        ctx.fillStyle = palette[colorIdx];
        ctx.globalAlpha = 0.36 + (frac - 0.52) * 0.52;
        ctx.fillRect(c * cellW + 7, r * cellH + 5, cellW - 14, cellH - 10);
      }
    }
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(4, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Procedural Neon City extended sidewalk + continuous under-building floor texture:
 * - u=0..0.08: curb riser + neon curb lip
 * - u=0.08..0.78: double-wide (7.8m) dark synthwave architectural concrete paving slabs running under buildings
 * - u=0.78..1.0: seamless dark slate foundation concrete apron extending past every skyscraper back wall
 */
function createSidewalkTexture(
  repeatY: number,
  maxAnisotropy: number
): { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture } {
  const w = 512;
  const h = 256;

  // Albedo concrete paving + seamless foundation floor
  const colCanvas = document.createElement('canvas');
  colCanvas.width = w;
  colCanvas.height = h;
  const ctx = colCanvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#1e163e'); // curb vertical face
  grad.addColorStop(0.08, '#322464'); // curb bevel
  grad.addColorStop(0.13, '#1c1538'); // inner walkway
  grad.addColorStop(0.45, '#171130'); // mid double-wide walkway
  grad.addColorStop(0.78, '#120d26'); // under building facades
  grad.addColorStop(1, '#0b071a'); // continuous dark concrete floor apron behind buildings
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Crisp concrete slab joints (4 longitudinal lanes across the double-wide 7.8m sidewalk + apron)
  ctx.strokeStyle = 'rgba(130, 108, 210, 0.25)';
  ctx.lineWidth = 2;
  const longitudinalLines = [0.09, 0.26, 0.43, 0.61, 0.78];
  ctx.beginPath();
  for (const u of longitudinalLines) {
    ctx.moveTo(w * u, 0);
    ctx.lineTo(w * u, h);
  }
  ctx.stroke();

  // Transverse paving seams extending across the entire width so under-building alleys look paved
  for (let r = 0; r < 4; r++) {
    const y = (r / 4) * h;
    ctx.beginPath();
    ctx.moveTo(w * 0.08, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Subtle tactile curb warning strip near edge
  ctx.fillStyle = 'rgba(175, 92, 245, 0.28)';
  ctx.fillRect(w * 0.06, 0, w * 0.032, h);

  const map = new THREE.CanvasTexture(colCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, repeatY);
  map.anisotropy = Math.min(8, maxAnisotropy);
  map.needsUpdate = true;

  // Emissive map: thin glowing purple-magenta curb trim + faint paving seams
  const emCanvas = document.createElement('canvas');
  emCanvas.width = w;
  emCanvas.height = h;
  const ectx = emCanvas.getContext('2d')!;
  ectx.fillStyle = '#000000';
  ectx.fillRect(0, 0, w, h);

  // Thin glowing neon curb edge accent (softer than primary road zone glow)
  const curbGlow = ectx.createLinearGradient(w * 0.04, 0, w * 0.11, 0);
  curbGlow.addColorStop(0, 'rgba(180, 60, 255, 0)');
  curbGlow.addColorStop(0.5, 'rgba(210, 82, 255, 0.72)');
  curbGlow.addColorStop(1, 'rgba(180, 60, 255, 0)');
  ectx.fillStyle = curbGlow;
  ectx.fillRect(w * 0.04, 0, w * 0.075, h);

  // Subtle paving seam accent across the double-wide sidewalk
  ectx.strokeStyle = 'rgba(110, 75, 220, 0.22)';
  ectx.lineWidth = 2;
  for (let r = 0; r < 4; r++) {
    const y = (r / 4) * h;
    ectx.beginPath();
    ectx.moveTo(w * 0.09, y);
    ectx.lineTo(w * 0.85, y);
    ectx.stroke();
  }
  ectx.strokeStyle = 'rgba(110, 75, 220, 0.16)';
  ectx.beginPath();
  ectx.moveTo(w * 0.43, 0);
  ectx.lineTo(w * 0.43, h);
  ectx.moveTo(w * 0.78, 0);
  ectx.lineTo(w * 0.78, h);
  ectx.stroke();

  const emissiveMap = new THREE.CanvasTexture(emCanvas);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;
  emissiveMap.wrapS = THREE.ClampToEdgeWrapping;
  emissiveMap.wrapT = THREE.RepeatWrapping;
  emissiveMap.repeat.set(1, repeatY);
  emissiveMap.anisotropy = Math.min(8, maxAnisotropy);
  emissiveMap.needsUpdate = true;

  return { map, emissiveMap };
}

/**
 * Build a 4-vertex-per-row raised sidewalk + continuous under-building city floor ribbon
 * (curb base -> curb top -> double-wide 7.8m sidewalk -> 24m total solid foundation apron)
 * using precomputed non-linear LOD Z segments and linear world-meter UVs.
 * Renders the curb, extended sidewalk, and gapless city floor in 1 single draw call per side!
 */
function buildSidewalkProfileGeometry(side: -1 | 1): THREE.BufferGeometry {
  const vertsPerRow = 4;
  const vertexCount = (STRIP_SEGMENTS + 1) * vertsPerRow;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];

  for (let i = 0; i <= STRIP_SEGMENTS; i++) {
    const linearT = STRIP_LINEAR_T[i];
    const baseV = i * vertsPerRow;

    // Static approximate normals (curb faces inward toward road, paved deck & apron face +Y up)
    normals[(baseV + 0) * 3 + 0] = -side * 0.92;
    normals[(baseV + 0) * 3 + 1] = 0.38;
    normals[(baseV + 0) * 3 + 2] = 0;

    normals[(baseV + 1) * 3 + 0] = -side * 0.25;
    normals[(baseV + 1) * 3 + 1] = 0.97;
    normals[(baseV + 1) * 3 + 2] = 0;

    normals[(baseV + 2) * 3 + 0] = 0;
    normals[(baseV + 2) * 3 + 1] = 1;
    normals[(baseV + 2) * 3 + 2] = 0;

    normals[(baseV + 3) * 3 + 0] = 0;
    normals[(baseV + 3) * 3 + 1] = 1;
    normals[(baseV + 3) * 3 + 2] = 0;

    // UVs: u=0 curb base, u=0.08 curb top, u=0.78 outer paved sidewalk (7.8m), u=1.0 floor apron (24m)
    uvs[(baseV + 0) * 2 + 0] = 0.0;
    uvs[(baseV + 0) * 2 + 1] = linearT;
    uvs[(baseV + 1) * 2 + 0] = 0.08;
    uvs[(baseV + 1) * 2 + 1] = linearT;
    uvs[(baseV + 2) * 2 + 0] = 0.78;
    uvs[(baseV + 2) * 2 + 1] = linearT;
    uvs[(baseV + 3) * 2 + 0] = 1.0;
    uvs[(baseV + 3) * 2 + 1] = linearT;

    if (i < STRIP_SEGMENTS) {
      const nBase = (i + 1) * vertsPerRow;
      for (let q = 0; q < 3; q++) {
        if (side === 1) {
          indices.push(
            baseV + q,
            baseV + q + 1,
            nBase + q,
            baseV + q + 1,
            nBase + q + 1,
            nBase + q
          );
        } else {
          indices.push(
            baseV + q + 1,
            baseV + q,
            nBase + q,
            baseV + q + 1,
            nBase + q,
            nBase + q + 1
          );
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function updateSidewalkFromCenterCache(geo: THREE.BufferGeometry, side: -1 | 1): void {
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;
  const curbInnerX = side * (ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP);
  const curbTopX = side * (ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP + 0.08);
  // Double-wide (~7.8m) paved sidewalk running cleanly under skyscraper fronts
  const pavedOuterX = side * (ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP + NEON_CITY_SIDEWALK_PAVED_WIDTH);
  // Continuous concrete city floor apron extending past the deepest skyscraper back walls (27.94m)
  const apronOuterX = side * (ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP + NEON_CITY_SIDEWALK_TOTAL_WIDTH);

  for (let i = 0; i <= STRIP_SEGMENTS; i++) {
    const cx = _cityCenterX[i];
    const cy = _cityCenterY[i];
    const z = STRIP_Z[i];
    const idx = i * 12;

    // 0: Curb bottom
    arr[idx + 0] = cx + curbInnerX;
    arr[idx + 1] = cy - 0.03;
    arr[idx + 2] = z;

    // 1: Curb top lip
    arr[idx + 3] = cx + curbTopX;
    arr[idx + 4] = cy + NEON_CITY_SIDEWALK_HEIGHT;
    arr[idx + 5] = z;

    // 2: Outer edge of double-wide paved sidewalk (under building facades)
    arr[idx + 6] = cx + pavedOuterX;
    arr[idx + 7] = cy + NEON_CITY_SIDEWALK_HEIGHT;
    arr[idx + 8] = z;

    // 3: Far outer city floor apron (zero gaps under or between skyscrapers)
    arr[idx + 9] = cx + apronOuterX;
    arr[idx + 10] = cy + NEON_CITY_SIDEWALK_HEIGHT - 0.02;
    arr[idx + 11] = z;
  }

  posAttr.needsUpdate = true;
}

/**
 * Safely merge heterogeneous BufferGeometries (e.g. indexed Cylinder + non-indexed Polyhedron)
 * by normalizing every part to non-indexed with position+normal attributes.
 */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = parts.map((g) => {
    const nonIndexed = g.index ? g.toNonIndexed() : g.clone();
    if (!nonIndexed.attributes.normal) {
      nonIndexed.computeVertexNormals();
    }
    // Strip UVs if not uniformly needed so mergeGeometries never rejects mismatched attributes
    if (nonIndexed.attributes.uv) {
      nonIndexed.deleteAttribute('uv');
    }
    return nonIndexed;
  });
  const merged = mergeGeometries(normalized, false);
  parts.forEach((g) => g.dispose());
  normalized.forEach((g) => g.dispose());
  if (!merged) {
    throw new Error('Failed to merge procedural scenery geometries');
  }
  merged.computeVertexNormals();
  return merged;
}

/**
 * Helper to create a cylinder segment oriented along the vector from point A to point B.
 */
function createTubeSegment(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  radialSegments = 6
): THREE.BufferGeometry {
  const start = new THREE.Vector3(ax, ay, az);
  const end = new THREE.Vector3(bx, by, bz);
  const dir = end.clone().sub(start);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, radialSegments);
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize()
  );
  geo.applyQuaternion(quat);
  geo.translate((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  return geo;
}

/**
 * Composite procedural synthwave street Trash Can (bottom-pivoted at y = 0).
 * Split into metallic body + emissive neon collar/slot accent for crisp silhouette readability.
 */
function createTrashCanGeometries(): { body: THREE.BufferGeometry; accent: THREE.BufferGeometry } {
  const bodyParts: THREE.BufferGeometry[] = [];
  const accentParts: THREE.BufferGeometry[] = [];

  // Heavy base plinth
  const base = new THREE.CylinderGeometry(0.32, 0.36, 0.08, 8);
  base.translate(0, 0.04, 0);
  bodyParts.push(base);

  // Tapered main cylinder bin
  const bin = new THREE.CylinderGeometry(0.34, 0.28, 0.78, 8);
  bin.translate(0, 0.45, 0);
  bodyParts.push(bin);

  // 4 vertical armored ribs around the bin
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const rib = new THREE.BoxGeometry(0.055, 0.72, 0.055);
    rib.translate(Math.cos(a) * 0.32, 0.45, Math.sin(a) * 0.32);
    bodyParts.push(rib);
  }

  // Two posts supporting the hooded dome lid
  const postL = new THREE.BoxGeometry(0.055, 0.24, 0.06);
  postL.translate(-0.28, 0.94, 0);
  bodyParts.push(postL);
  const postR = new THREE.BoxGeometry(0.055, 0.24, 0.06);
  postR.translate(0.28, 0.94, 0);
  bodyParts.push(postR);

  // Domed rain hood canopy
  const hood = new THREE.CylinderGeometry(0.22, 0.38, 0.18, 8);
  hood.translate(0, 1.12, 0);
  bodyParts.push(hood);

  // Glowing neon rim collar around the opening + front badge strip
  const collar = new THREE.TorusGeometry(0.345, 0.028, 6, 10);
  collar.rotateX(Math.PI / 2);
  collar.translate(0, 0.84, 0);
  accentParts.push(collar);

  const frontBadge = new THREE.BoxGeometry(0.24, 0.05, 0.04);
  frontBadge.translate(0, 0.62, 0.33);
  accentParts.push(frontBadge);

  const body = mergeParts(bodyParts);
  const accent = mergeParts(accentParts);
  return { body, accent };
}

/**
 * Composite procedural synthwave Parked Bicycle + curb U-rack (bottom-pivoted at y = 0).
 * Split into metallic frame/tires/rack + emissive neon wheel rims & top-tube highlight.
 */
function createParkedBikeGeometries(): { frame: THREE.BufferGeometry; accent: THREE.BufferGeometry } {
  const frameParts: THREE.BufferGeometry[] = [];
  const accentParts: THREE.BufferGeometry[] = [];

  const wheelR = 0.35;
  const rearZ = -0.54;
  const frontZ = 0.54;

  // Rear & Front Tires + Hubs (rolling along Z axis)
  for (const wz of [rearZ, frontZ]) {
    const tire = new THREE.TorusGeometry(wheelR, 0.042, 6, 14);
    tire.rotateY(Math.PI / 2);
    tire.translate(0, wheelR, wz);
    frameParts.push(tire);

    const hub = new THREE.CylinderGeometry(0.045, 0.045, 0.14, 6);
    hub.rotateZ(Math.PI / 2);
    hub.translate(0, wheelR, wz);
    frameParts.push(hub);

    // Emissive wheel rim ring
    const rim = new THREE.TorusGeometry(wheelR - 0.05, 0.02, 5, 14);
    rim.rotateY(Math.PI / 2);
    rim.translate(0, wheelR, wz);
    accentParts.push(rim);
  }

  // Diamond Frame geometry (BB, Seat Cluster, Head Tube, Stays, Fork)
  const bbY = 0.32;
  const bbZ = -0.06;
  const seatY = 0.86;
  const seatZ = -0.22;
  const headTopY = 0.88;
  const headTopZ = 0.38;
  const headBotY = 0.72;
  const headBotZ = 0.42;

  frameParts.push(
    createTubeSegment(0, bbY, bbZ, 0, seatY, seatZ, 0.026), // Seat tube
    createTubeSegment(0, bbY, bbZ, 0, headBotY, headBotZ, 0.028), // Down tube
    createTubeSegment(0, seatY - 0.03, seatZ, 0, headTopY - 0.02, headTopZ, 0.024), // Top tube
    createTubeSegment(0, headBotY, headBotZ, 0, headTopY + 0.08, headTopZ - 0.02, 0.026), // Head tube & stem
    createTubeSegment(-0.045, bbY, bbZ, -0.055, wheelR, rearZ, 0.017), // Left chainstay
    createTubeSegment(0.045, bbY, bbZ, 0.055, wheelR, rearZ, 0.017), // Right chainstay
    createTubeSegment(-0.035, seatY - 0.04, seatZ, -0.055, wheelR, rearZ, 0.016), // Left seatstay
    createTubeSegment(0.035, seatY - 0.04, seatZ, 0.055, wheelR, rearZ, 0.016), // Right seatstay
    createTubeSegment(-0.04, headBotY, headBotZ, -0.055, wheelR, frontZ, 0.018), // Left fork
    createTubeSegment(0.04, headBotY, headBotZ, 0.055, wheelR, frontZ, 0.018) // Right fork
  );

  // Saddle + Seatpost
  frameParts.push(createTubeSegment(0, seatY, seatZ, 0, seatY + 0.14, seatZ - 0.04, 0.019));
  const saddle = new THREE.BoxGeometry(0.13, 0.05, 0.28);
  saddle.translate(0, seatY + 0.16, seatZ - 0.05);
  frameParts.push(saddle);

  // Handlebars
  const bar = new THREE.CylinderGeometry(0.02, 0.02, 0.48, 6);
  bar.rotateZ(Math.PI / 2);
  bar.translate(0, headTopY + 0.08, headTopZ - 0.01);
  frameParts.push(bar);

  // Curbside U-shaped steel bike rack bar right beside the bike
  const rackX = 0.22;
  frameParts.push(
    createTubeSegment(rackX, 0, -0.26, rackX, 0.72, -0.26, 0.028),
    createTubeSegment(rackX, 0, 0.26, rackX, 0.72, 0.26, 0.028),
    createTubeSegment(rackX, 0.72, -0.26, rackX, 0.72, 0.26, 0.028)
  );

  // Neon glowing top-tube accent bar
  accentParts.push(createTubeSegment(0, seatY - 0.02, seatZ, 0, headTopY - 0.01, headTopZ, 0.018));

  const frame = mergeParts(frameParts);
  const accent = mergeParts(accentParts);
  return { frame, accent };
}

/**
 * Instanced Neon City skyscrapers pushed cleanly behind wide raised sidewalks,
 * extended 283m+ draw distance with a distant horizon skyline silhouette band for 60 fps,
 * occasional sidewalk Trash Cans & Parked Bikes, and wide purple ground mist.
 * (No palm trees in Background #1.)
 */
function NeonCityScenery({ runtimeRef }: { runtimeRef: React.MutableRefObject<WorldRuntimeState> }) {
  const gl = useThree((s) => s.gl);
  const bldgCount = 86; // 43 per side x 6.8m = 292.4m deep boulevard in 1 single draw call
  const bldgLaneStep = 6.8;
  const farSkylineCount = 46; // Low-poly distant horizon skyline ring in 1 single draw call
  const trashCount = 8;
  const bikeCount = 6;
  const sidewalkRepeatY = 56;

  const bldgMeshRef = useRef<THREE.InstancedMesh>(null);
  const farSkylineRef = useRef<THREE.InstancedMesh>(null);
  const trashBodyRef = useRef<THREE.InstancedMesh>(null);
  const trashAccentRef = useRef<THREE.InstancedMesh>(null);
  const bikeFrameRef = useRef<THREE.InstancedMesh>(null);
  const bikeAccentRef = useRef<THREE.InstancedMesh>(null);
  const fogGroupRef = useRef<THREE.Group>(null);

  const windowTex = useMemo(
    () => createBuildingWindowTexture(gl.capabilities.getMaxAnisotropy()),
    [gl]
  );
  const sidewalkTextures = useMemo(
    () => createSidewalkTexture(sidewalkRepeatY, gl.capabilities.getMaxAnisotropy()),
    [gl, sidewalkRepeatY]
  );
  const sidewalkGeos = useMemo(
    () => ({
      left: buildSidewalkProfileGeometry(-1),
      right: buildSidewalkProfileGeometry(1),
    }),
    []
  );
  const trashGeos = useMemo(() => createTrashCanGeometries(), []);
  const bikeGeos = useMemo(() => createParkedBikeGeometries(), []);

  // Buildings pushed back so every front facade sits cleanly behind the full 3.8m sidewalk
  const bldgSeeds = useMemo(() => {
    return Array.from({ length: bldgCount }, (_, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const lane = Math.floor(i / 2);
      const h = 17 + ((i * 7.3) % 28);
      const w = 4.2 + ((i * 2.1) % 3.8);
      const d = 4.6 + ((i * 3.7) % 4.4);
      const jitter = (i * 1.9) % 4.6;
      const latOffset = computeBuildingCenterOffset(w, NEON_CITY_MIN_BUILDING_FRONT_X, jitter);
      return { side, slotZ: lane * bldgLaneStep, h, w, d, latOffset };
    });
  }, [bldgCount, bldgLaneStep]);

  // Low-poly distant horizon metropolis silhouette band fading softly into exponential fog
  const farSkylineSeeds = useMemo(() => {
    return Array.from({ length: farSkylineCount }, (_, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const rank = Math.floor(i / 2);
      // Fan across [-265, -22] and [+22, +265] so ultrawide monitors see an endless city skyline
      const x = side * (22 + rank * 10.6 + ((i * 3.1) % 5.5));
      const z = -258 - ((i * 11.7) % 52);
      const w = 8.5 + ((i * 4.3) % 9.5);
      const d = 8.0 + ((i * 3.7) % 7.5);
      const h = 24 + ((i * 13.9) % 52);
      return { x, z, w, d, h };
    });
  }, [farSkylineCount]);

  // Occasional Trash Cans sitting cleanly on top of the raised sidewalk near the curb
  const trashSeeds = useMemo(() => {
    return Array.from({ length: trashCount }, (_, i) => ({
      side: i % 2 === 0 ? -1 : 1,
      slotZ: 24 + i * 40,
      latOffset: ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP + 0.78 + (i % 2) * 0.35,
      yaw: (i % 2 === 0 ? 1 : -1) * (Math.PI * 0.5) + ((i % 3) - 1) * 0.14,
      scale: 1.15 + (i % 3) * 0.08,
      isCyan: i % 2 === 0,
    }));
  }, [trashCount]);

  // Occasional Parked Bicycles locked to sidewalk U-racks along the middle of the sidewalk
  const bikeSeeds = useMemo(() => {
    return Array.from({ length: bikeCount }, (_, i) => ({
      side: i % 2 === 0 ? 1 : -1,
      slotZ: 34 + i * 54,
      latOffset: ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP + 1.65 + (i % 2) * 0.45,
      yaw: (i % 2 === 0 ? -1 : 1) * 0.38,
      scale: 1.2 + (i % 2) * 0.08,
      isMagenta: i % 2 === 0,
    }));
  }, [bikeCount]);

  useEffect(
    () => () => {
      windowTex.dispose();
      sidewalkTextures.map.dispose();
      sidewalkTextures.emissiveMap.dispose();
      sidewalkGeos.left.dispose();
      sidewalkGeos.right.dispose();
      trashGeos.body.dispose();
      trashGeos.accent.dispose();
      bikeGeos.frame.dispose();
      bikeGeos.accent.dispose();
    },
    [windowTex, sidewalkTextures, sidewalkGeos, trashGeos, bikeGeos]
  );

  // Populate static distant skyline instances once (zero per-frame matrix updates!)
  useEffect(() => {
    if (farSkylineRef.current) {
      for (let i = 0; i < farSkylineCount; i++) {
        const f = farSkylineSeeds[i];
        _dummy.position.set(f.x, f.h * 0.5 - 6, f.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(f.w, f.h, f.d);
        _dummy.updateMatrix();
        farSkylineRef.current.setMatrixAt(i, _dummy.matrix);
      }
      farSkylineRef.current.instanceMatrix.needsUpdate = true;
    }
  }, [farSkylineCount, farSkylineSeeds]);

  useEffect(() => {
    if (trashAccentRef.current) {
      for (let i = 0; i < trashCount; i++) {
        _color.set(trashSeeds[i].isCyan ? '#00e8ff' : '#ff3ca8');
        trashAccentRef.current.setColorAt(i, _color);
      }
      if (trashAccentRef.current.instanceColor) {
        trashAccentRef.current.instanceColor.needsUpdate = true;
      }
    }
    if (bikeAccentRef.current) {
      for (let i = 0; i < bikeCount; i++) {
        _color.set(bikeSeeds[i].isMagenta ? '#ff2a9d' : '#00f0ff');
        bikeAccentRef.current.setColorAt(i, _color);
      }
      if (bikeAccentRef.current.instanceColor) {
        bikeAccentRef.current.instanceColor.needsUpdate = true;
      }
    }
  }, [trashCount, bikeCount, trashSeeds, bikeSeeds]);

  useFrame(() => {
    const rt = runtimeRef.current;
    const dist = rt.distance;
    const bldgSpan = (bldgCount / 2) * bldgLaneStep;
    const propSpan = 324;

    // Scroll sidewalk slab texture forward at exact 1:1 physical speed
    const swOffset = computeForwardScrollOffset(dist, sidewalkRepeatY, ROAD_Z_SPAN);
    sidewalkTextures.map.offset.y = swOffset;
    sidewalkTextures.emissiveMap.offset.y = swOffset;

    // Sample road centerline ONCE for both left and right raised sidewalks
    for (let i = 0; i <= STRIP_SEGMENTS; i++) {
      sampleRoadAtZ(
        dist,
        STRIP_Z[i],
        _sample,
        rt.elevationProfile,
        rt.workoutElapsedSec,
        rt.freeRideTerrain
      );
      _cityCenterX[i] = _sample.x;
      _cityCenterY[i] = _sample.y;
    }
    updateSidewalkFromCenterCache(sidewalkGeos.left, -1);
    updateSidewalkFromCenterCache(sidewalkGeos.right, 1);

    if (fogGroupRef.current) {
      fogGroupRef.current.rotation.x = rt.pitchAngle * 0.85;
    }

    const planes = rt.frustumPlanes;
    const useFrustum = rt.frustumReady;
    const nearWrapZ = 9;
    const sceneryStride = rt.sceneryScale < 0.75 ? 2 : 1;

    // Frustum-cull & compact distant horizon skyline so narrow/standard windows skip off-axis towers
    if (farSkylineRef.current) {
      const skylineLiftY = rt.currentGrade * 145;
      let visFar = 0;
      for (let i = 0; i < farSkylineCount; i += sceneryStride) {
        const f = farSkylineSeeds[i];
        const cy = f.h * 0.5 - 6 + skylineLiftY;
        if (
          useFrustum &&
          !isAabbInFrustum(planes, f.x, cy, f.z, f.w * 0.5 + 1, f.h * 0.5 + 1, f.d * 0.5 + 1)
        ) {
          rt.culledInstances += 1;
          continue;
        }
        _dummy.position.set(f.x, cy, f.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(f.w, f.h, f.d);
        _dummy.updateMatrix();
        farSkylineRef.current.setMatrixAt(visFar, _dummy.matrix);
        visFar += 1;
      }
      rt.drawnInstances += visFar;
      farSkylineRef.current.count = visFar;
      farSkylineRef.current.instanceMatrix.needsUpdate = true;
    }

    // Frustum-cull & compact boulevard skyscrapers (skips behind-camera & off-screen towers)
    if (bldgMeshRef.current) {
      let visBldg = 0;
      for (let i = 0; i < bldgCount; i += sceneryStride) {
        const s = bldgSeeds[i];
        const raw = (s.slotZ - dist) % bldgSpan;
        const wrapped = raw < 0 ? raw + bldgSpan : raw;
        const z = nearWrapZ - wrapped;
        if (z - s.d * 0.5 > rt.cameraZ) {
          rt.culledInstances += 1;
          continue;
        }
        sampleRoadAtZ(
          dist,
          z,
          _sample,
          rt.elevationProfile,
          rt.workoutElapsedSec,
          rt.freeRideTerrain
        );

        const cx = _sample.x + s.side * s.latOffset;
        const cy = _sample.y + s.h * 0.5 - 1.2;
        if (
          useFrustum &&
          !isAabbInFrustum(planes, cx, cy, z, s.w * 0.5 + 0.6, s.h * 0.5 + 0.6, s.d * 0.5 + 0.6)
        ) {
          rt.culledInstances += 1;
          continue;
        }

        _dummy.position.set(cx, cy, z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(s.w, s.h, s.d);
        _dummy.updateMatrix();
        bldgMeshRef.current.setMatrixAt(visBldg, _dummy.matrix);
        visBldg += 1;
      }
      rt.drawnInstances += visBldg;
      bldgMeshRef.current.count = visBldg;
      bldgMeshRef.current.instanceMatrix.needsUpdate = true;
    }

    if (trashBodyRef.current && trashAccentRef.current) {
      let visTrash = 0;
      for (let i = 0; i < trashCount; i += sceneryStride) {
        const t = trashSeeds[i];
        const raw = (t.slotZ - dist) % propSpan;
        const wrapped = raw < 0 ? raw + propSpan : raw;
        const z = nearWrapZ - wrapped;
        if (z - 1.0 > rt.cameraZ) {
          rt.culledInstances += 1;
          continue;
        }
        sampleRoadAtZ(
          dist,
          z,
          _sample,
          rt.elevationProfile,
          rt.workoutElapsedSec,
          rt.freeRideTerrain
        );

        const cx = _sample.x + t.side * t.latOffset;
        const cy = _sample.y + NEON_CITY_SIDEWALK_HEIGHT - 0.01;
        if (useFrustum && !isSphereInFrustum(planes, cx, cy + 0.65, z, 1.35)) {
          rt.culledInstances += 1;
          continue;
        }

        _dummy.position.set(cx, cy, z);
        _dummy.rotation.set(Math.atan(_sample.slopeY) * 0.5, t.yaw, 0);
        _dummy.scale.set(t.scale, t.scale, t.scale);
        _dummy.updateMatrix();
        trashBodyRef.current.setMatrixAt(visTrash, _dummy.matrix);
        trashAccentRef.current.setMatrixAt(visTrash, _dummy.matrix);
        trashAccentRef.current.setColorAt(visTrash, t.isCyan ? _colCyanTrash : _colPinkTrash);
        visTrash += 1;
      }
      rt.drawnInstances += visTrash;
      trashBodyRef.current.count = visTrash;
      trashAccentRef.current.count = visTrash;
      trashBodyRef.current.instanceMatrix.needsUpdate = true;
      trashAccentRef.current.instanceMatrix.needsUpdate = true;
      if (trashAccentRef.current.instanceColor) {
        trashAccentRef.current.instanceColor.needsUpdate = true;
      }
    }

    if (bikeFrameRef.current && bikeAccentRef.current) {
      let visBike = 0;
      for (let i = 0; i < bikeCount; i += sceneryStride) {
        const b = bikeSeeds[i];
        const raw = (b.slotZ - dist) % propSpan;
        const wrapped = raw < 0 ? raw + propSpan : raw;
        const z = nearWrapZ - wrapped;
        if (z - 1.2 > rt.cameraZ) {
          rt.culledInstances += 1;
          continue;
        }
        sampleRoadAtZ(
          dist,
          z,
          _sample,
          rt.elevationProfile,
          rt.workoutElapsedSec,
          rt.freeRideTerrain
        );

        const cx = _sample.x + b.side * b.latOffset;
        const cy = _sample.y + NEON_CITY_SIDEWALK_HEIGHT - 0.01;
        if (useFrustum && !isSphereInFrustum(planes, cx, cy + 0.55, z, 1.55)) {
          rt.culledInstances += 1;
          continue;
        }

        _dummy.position.set(cx, cy, z);
        _dummy.rotation.set(Math.atan(_sample.slopeY), b.yaw, b.side * 0.08);
        _dummy.scale.set(b.scale, b.scale, b.scale);
        _dummy.updateMatrix();
        bikeFrameRef.current.setMatrixAt(visBike, _dummy.matrix);
        bikeAccentRef.current.setMatrixAt(visBike, _dummy.matrix);
        bikeAccentRef.current.setColorAt(visBike, b.isMagenta ? _colMagentaBike : _colCyanBike);
        visBike += 1;
      }
      rt.drawnInstances += visBike;
      bikeFrameRef.current.count = visBike;
      bikeAccentRef.current.count = visBike;
      bikeFrameRef.current.instanceMatrix.needsUpdate = true;
      bikeAccentRef.current.instanceMatrix.needsUpdate = true;
      if (bikeAccentRef.current.instanceColor) {
        bikeAccentRef.current.instanceColor.needsUpdate = true;
      }
    }
  });

  return (
    <group>
      {/* Left & Right Raised Sidewalks with curbs following the road spline (2 draw calls total) */}
      <mesh geometry={sidewalkGeos.left} frustumCulled={false}>
        <meshStandardMaterial
          map={sidewalkTextures.map}
          emissiveMap={sidewalkTextures.emissiveMap}
          emissive="#c45eff"
          emissiveIntensity={0.62}
          roughness={0.68}
          metalness={0.28}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      <mesh geometry={sidewalkGeos.right} frustumCulled={false}>
        <meshStandardMaterial
          map={sidewalkTextures.map}
          emissiveMap={sidewalkTextures.emissiveMap}
          emissive="#c45eff"
          emissiveIntensity={0.62}
          roughness={0.68}
          metalness={0.28}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>

      {/* Instanced Boulevard Skyscrapers set cleanly behind the 3.8m sidewalks */}
      <instancedMesh ref={bldgMeshRef} args={[undefined, undefined, bldgCount]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          map={windowTex}
          color="#282144"
          emissiveMap={windowTex}
          emissive="#ffffff"
          emissiveIntensity={0.58}
          roughness={0.55}
          metalness={0.45}
        />
      </instancedMesh>

      {/* Low-poly Distant Horizon Skyline Ring fading into fog (frustum-culled 1 draw call) */}
      <instancedMesh
        ref={farSkylineRef}
        args={[undefined, undefined, farSkylineCount]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#1a0d38" />
      </instancedMesh>

      {/* Occasional Sidewalk Trash Cans */}
      <instancedMesh
        ref={trashBodyRef}
        args={[trashGeos.body, undefined, trashCount]}
        frustumCulled={false}
      >
        <meshStandardMaterial
          color="#3f3670"
          emissive="#1a1238"
          emissiveIntensity={0.45}
          roughness={0.38}
          metalness={0.62}
        />
      </instancedMesh>
      <instancedMesh
        ref={trashAccentRef}
        args={[trashGeos.accent, undefined, trashCount]}
        frustumCulled={false}
      >
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>

      {/* Occasional Sidewalk Parked Bicycles */}
      <instancedMesh
        ref={bikeFrameRef}
        args={[bikeGeos.frame, undefined, bikeCount]}
        frustumCulled={false}
      >
        <meshStandardMaterial
          color="#3c336b"
          emissive="#191236"
          emissiveIntensity={0.45}
          roughness={0.32}
          metalness={0.72}
        />
      </instancedMesh>
      <instancedMesh
        ref={bikeAccentRef}
        args={[bikeGeos.accent, undefined, bikeCount]}
        frustumCulled={false}
      >
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>

      {/* Wide low purple synthwave ground mist banks flanking the skyscrapers */}
      <group ref={fogGroupRef}>
        <mesh position={[-52, 0.7, -120]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[86, 275]} />
          <meshBasicMaterial
            color="#7c1fb8"
            transparent
            opacity={0.18}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
        <mesh position={[52, 0.7, -120]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[86, 275]} />
          <meshBasicMaterial
            color="#7c1fb8"
            transparent
            opacity={0.18}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>
    </group>
  );
}

/**
 * Procedural Palm Grove level synthwave floor grid texture (deep plum-indigo base with
 * glowing magenta-rose & violet-cyan grid lines, matching Cloud Horizon's seamless floor feel).
 */
function createPalmFloorTexture(
  repeatX: number,
  repeatY: number,
  maxAnisotropy: number
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#0b0520';
  ctx.fillRect(0, 0, 256, 256);

  // Primary glowing magenta-rose grid cell border
  ctx.strokeStyle = 'rgba(232, 62, 168, 0.72)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 252, 252);

  // Subtle violet-cyan sub-grid crosshairs
  ctx.strokeStyle = 'rgba(110, 185, 255, 0.30)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(128, 0);
  ctx.lineTo(128, 256);
  ctx.moveTo(0, 128);
  ctx.lineTo(256, 128);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = Math.min(8, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Instanced Palm Grove: cyan & pink low-poly arched palm trees, 720m-wide level synthwave
 * ground grid floor flush with the road, wide-screen wireframe horizon cliffs spanning
 * 660m edge-to-edge, and magenta/cyan ground mist banks.
 */
function PalmGroveScenery({ runtimeRef }: { runtimeRef: React.MutableRefObject<WorldRuntimeState> }) {
  const gl = useThree((s) => s.gl);
  const palmCount = PALM_GROVE_PALM_COUNT;
  const gridHalfWidth = 360; // 720m wide level floor covering ultrawide screens edge-to-edge
  const gridRepeatX = 120;
  const gridRepeatY = 48;
  const floorYOffset = -0.06; // Level with the road (polygonOffset prevents any Z-fighting)

  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const crownRef = useRef<THREE.InstancedMesh>(null);
  const terrainGroupRef = useRef<THREE.Group>(null);

  const palmCrownGeo = useMemo(() => createPalmCrownGeometry(), []);
  const floorGeo = useMemo(
    () => buildLevelRibbonGeometry(gridHalfWidth, floorYOffset),
    [gridHalfWidth, floorYOffset]
  );
  const floorTex = useMemo(
    () => createPalmFloorTexture(gridRepeatX, gridRepeatY, gl.capabilities.getMaxAnisotropy()),
    [gl, gridRepeatX, gridRepeatY]
  );

  const palmSeeds = useMemo(() => {
    return Array.from({ length: palmCount }, (_, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const lane = Math.floor(i / 2);
      const height = 4.6 + ((i * 1.45) % 2.8);
      const latOffset = ROAD_HALF_WIDTH + 2.2 + ((i * 2.3) % 5.6);
      const isCyan = (i + lane) % 2 === 0;
      const lean = side * (0.14 + ((i * 0.04) % 0.16));
      return { side, slotZ: lane * PALM_GROVE_LANE_STEP_M, height, latOffset, isCyan, lean };
    });
  }, [palmCount]);

  // Wide-screen synthwave mountain cliff ridge geometry (660m x 320m, simplified 48x22 grid for 60fps)
  const mountainGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(PALM_GROVE_CLIFF_WIDTH, 320, 48, 22);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const distFromRoad = Math.abs(x);
      const mask = THREE.MathUtils.smoothstep(distFromRoad, 13.5, 32);
      // Gradually heighten outer cliffs so wide/ultrawide edges stay framed with bold peaks
      const outerBoost = 1.0 + THREE.MathUtils.smoothstep(distFromRoad, 40, 230) * 0.72;
      const ridge =
        (Math.abs(Math.sin(x * 0.055 + z * 0.036) * 16.5) +
          Math.abs(Math.cos(x * 0.105 - z * 0.048) * 9.0) +
          Math.sin(z * 0.024) * 4.5 +
          3.2) *
        outerBoost;
      pos.setY(i, mask * ridge - 1.6);
    }
    geo.computeVertexNormals();
    return geo;
  }, []);

  useEffect(
    () => () => {
      mountainGeo.dispose();
      palmCrownGeo.dispose();
      floorGeo.dispose();
      floorTex.dispose();
    },
    [mountainGeo, palmCrownGeo, floorGeo, floorTex]
  );

  useEffect(() => {
    if (!crownRef.current) return;
    for (let i = 0; i < palmCount; i++) {
      _color.set(palmSeeds[i].isCyan ? '#00d8e8' : '#e63a9c');
      crownRef.current.setColorAt(i, _color);
    }
    if (crownRef.current.instanceColor) crownRef.current.instanceColor.needsUpdate = true;
  }, [palmCount, palmSeeds]);

  useFrame(() => {
    const rt = runtimeRef.current;
    const dist = rt.distance;
    const span = (palmCount / 2) * PALM_GROVE_LANE_STEP_M;

    // Scroll level synthwave grid floor forward toward cyclist at exact 1:1 physical speed
    floorTex.offset.y = computeForwardScrollOffset(dist, gridRepeatY, ROAD_Z_SPAN);
    updateLevelRibbonFromRoad(floorGeo, rt, gridHalfWidth, floorYOffset);

    if (terrainGroupRef.current) {
      terrainGroupRef.current.rotation.x = rt.pitchAngle * 0.85;
    }

    if (trunkRef.current && crownRef.current) {
      const planes = rt.frustumPlanes;
      const useFrustum = rt.frustumReady;
      const sceneryStride = rt.sceneryScale < 0.75 ? 2 : 1;
      let visPalms = 0;

      for (let i = 0; i < palmCount; i += sceneryStride) {
        const p = palmSeeds[i];
        const raw = (p.slotZ - dist) % span;
        const wrapped = raw < 0 ? raw + span : raw;
        const z = 9 - wrapped;
        if (z - 2.6 > rt.cameraZ) {
          rt.culledInstances += 1;
          continue;
        }
        sampleRoadAtZ(
          dist,
          z,
          _sample,
          rt.elevationProfile,
          rt.workoutElapsedSec,
          rt.freeRideTerrain
        );
        const xBase = _sample.x + p.side * p.latOffset;
        const cy = _sample.y + p.height * 0.5;
        if (
          useFrustum &&
          !isAabbInFrustum(planes, xBase, cy, z, 3.0, p.height * 0.65 + 1.0, 3.0)
        ) {
          rt.culledInstances += 1;
          continue;
        }

        _dummy.position.set(xBase, _sample.y + p.height * 0.5 - 0.12, z);
        _dummy.rotation.set(0, 0, -p.lean);
        _dummy.scale.set(1, p.height, 1);
        _dummy.updateMatrix();
        trunkRef.current.setMatrixAt(visPalms, _dummy.matrix);

        const topX = xBase + Math.sin(p.lean) * p.height * 0.55;
        const topY = _sample.y + p.height - 0.04;

        _dummy.position.set(topX, topY, z);
        _dummy.rotation.set(0, i * 0.7, -p.lean * 0.45);
        _dummy.scale.set(1.08, 1.08, 1.08);
        _dummy.updateMatrix();
        crownRef.current.setMatrixAt(visPalms, _dummy.matrix);
        crownRef.current.setColorAt(visPalms, p.isCyan ? _colCyanPalm : _colPinkPalm);
        visPalms += 1;
      }

      rt.drawnInstances += visPalms;
      trunkRef.current.count = visPalms;
      crownRef.current.count = visPalms;
      trunkRef.current.instanceMatrix.needsUpdate = true;
      crownRef.current.instanceMatrix.needsUpdate = true;
      if (crownRef.current.instanceColor) {
        crownRef.current.instanceColor.needsUpdate = true;
      }
    }
  });

  return (
    <group>
      {/* 720m-wide level synthwave floor ribbon flush with road elevation (Cloud Horizon style) */}
      <mesh geometry={floorGeo} frustumCulled={false}>
        <meshStandardMaterial
          map={floorTex}
          emissiveMap={floorTex}
          emissive="#d642a8"
          emissiveIntensity={0.62}
          roughness={0.44}
          metalness={0.48}
          polygonOffset
          polygonOffsetFactor={2}
          polygonOffsetUnits={2}
        />
      </mesh>

      {/* Solid dark wide-screen cliff silhouettes + wireframe ridges + mist tilted with climb */}
      <group ref={terrainGroupRef}>
        <mesh geometry={mountainGeo} position={[0, -0.5, -135]}>
          <meshStandardMaterial
            color="#120928"
            roughness={0.88}
            flatShading
            polygonOffset
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        </mesh>
        <mesh geometry={mountainGeo} position={[0, -0.42, -135]}>
          <meshBasicMaterial
            color="#9b42c4"
            wireframe
            transparent
            opacity={0.44}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>

        {/* Wide cyan left & magenta right mist banks */}
        <mesh position={[-76, 0.85, -125]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[142, 280]} />
          <meshBasicMaterial
            color="#00b4d8"
            transparent
            opacity={0.14}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
        <mesh position={[76, 0.85, -125]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[142, 280]} />
          <meshBasicMaterial
            color="#d9268a"
            transparent
            opacity={0.16}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>

      {/* Low-poly cyan & pink arched palm trees */}
      <instancedMesh ref={trunkRef} args={[undefined, undefined, palmCount]} frustumCulled={false}>
        <cylinderGeometry args={[0.1, 0.21, 1, 6]} />
        <meshStandardMaterial color="#160a26" roughness={0.85} />
      </instancedMesh>
      <instancedMesh
        ref={crownRef}
        args={[palmCrownGeo, undefined, palmCount]}
        frustumCulled={false}
      >
        <meshStandardMaterial
          color="#ffffff"
          emissive="#3c2658"
          emissiveIntensity={0.45}
          roughness={0.55}
          flatShading
        />
      </instancedMesh>
    </group>
  );
}

/**
 * Composite procedural low-poly synthwave Bush (5 overlapping faceted foliage lobes +
 * dark root base, bottom-pivoted at y = 0 so it sits flush on the Cloud Horizon grid).
 */
function createLowPolyBushGeometries(): {
  foliage: THREE.BufferGeometry;
  base: THREE.BufferGeometry;
} {
  const foliageParts: THREE.BufferGeometry[] = [];
  const baseParts: THREE.BufferGeometry[] = [];

  const mainLobe = new THREE.IcosahedronGeometry(0.76, 0);
  mainLobe.scale(1.12, 0.88, 1.06);
  mainLobe.translate(0, 0.62, 0);
  foliageParts.push(mainLobe);

  const lobe1 = new THREE.DodecahedronGeometry(0.56, 0);
  lobe1.scale(1.05, 0.82, 0.95);
  lobe1.translate(-0.56, 0.44, 0.24);
  foliageParts.push(lobe1);

  const lobe2 = new THREE.IcosahedronGeometry(0.52, 0);
  lobe2.scale(0.95, 0.86, 1.08);
  lobe2.translate(0.58, 0.42, 0.16);
  foliageParts.push(lobe2);

  const lobe3 = new THREE.DodecahedronGeometry(0.58, 0);
  lobe3.scale(1.08, 0.92, 0.92);
  lobe3.translate(-0.32, 0.52, -0.44);
  foliageParts.push(lobe3);

  const lobe4 = new THREE.IcosahedronGeometry(0.5, 0);
  lobe4.scale(1.0, 0.78, 1.05);
  lobe4.translate(0.4, 0.44, -0.38);
  foliageParts.push(lobe4);

  // Dark faceted root/stem base anchored at y = 0
  const stem = new THREE.CylinderGeometry(0.18, 0.34, 0.34, 6);
  stem.translate(0, 0.17, 0);
  baseParts.push(stem);

  const rootPad = new THREE.DodecahedronGeometry(0.46, 0);
  rootPad.scale(1.35, 0.28, 1.25);
  rootPad.translate(0, 0.08, 0);
  baseParts.push(rootPad);

  const foliage = mergeParts(foliageParts);
  const base = mergeParts(baseParts);
  return { foliage, base };
}

/**
 * Procedural 2D synthwave cumulus cloud sprite texture (256x128 RGBA CanvasTexture).
 * Renders soft billowing sunset cloud silhouettes with warm coral-gold sun-kissed top
 * rims, rose-magenta mid-tones, and deep violet bases using just 2 triangles per sprite!
 */
function createCloudSpriteTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, w, h);

  // Paint overlapping feathered cumulus puffs onto the alpha silhouette
  const puffs = [
    { x: 48, y: 94, r: 34 },
    { x: 82, y: 74, r: 44 },
    { x: 128, y: 58, r: 52 },
    { x: 172, y: 74, r: 42 },
    { x: 206, y: 94, r: 32 },
    { x: 105, y: 96, r: 38 },
    { x: 152, y: 96, r: 38 },
  ];

  for (const p of puffs) {
    const rad = ctx.createRadialGradient(p.x, p.y - p.r * 0.14, p.r * 0.18, p.x, p.y, p.r);
    rad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    rad.addColorStop(0.68, 'rgba(255, 255, 255, 0.94)');
    rad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = rad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Soft flat cloud deck fade along the bottom edge
  ctx.globalCompositeOperation = 'destination-in';
  const bottomMask = ctx.createLinearGradient(0, 0, 0, h);
  bottomMask.addColorStop(0, 'rgba(255,255,255,1)');
  bottomMask.addColorStop(0.76, 'rgba(255,255,255,1)');
  bottomMask.addColorStop(0.95, 'rgba(255,255,255,0.22)');
  bottomMask.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bottomMask;
  ctx.fillRect(0, 0, w, h);

  // Apply vibrant synthwave sunset lighting gradient inside the silhouette
  ctx.globalCompositeOperation = 'source-atop';
  const sunGrad = ctx.createLinearGradient(0, 12, 0, h);
  sunGrad.addColorStop(0, '#ffcb8c'); // sunlit coral-gold crest
  sunGrad.addColorStop(0.28, '#ff7d78'); // glowing peach-coral upper body
  sunGrad.addColorStop(0.62, '#dc4892'); // rose-magenta mid cloud
  sunGrad.addColorStop(1, '#581f6e'); // twilight plum underside
  ctx.fillStyle = sunGrad;
  ctx.fillRect(0, 0, w, h);

  // Warm rim highlight on upper crown lobes
  const rimGrad = ctx.createRadialGradient(128, 30, 8, 128, 48, 86);
  rimGrad.addColorStop(0, 'rgba(255, 232, 185, 0.45)');
  rimGrad.addColorStop(1, 'rgba(255, 180, 140, 0)');
  ctx.fillStyle = rimGrad;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Cloud Horizon: seamless 360° pink-violet sky dome with wide/tall digital rain streaks,
 * ultra-lightweight instanced 2D billboard cloud sprites (64 triangles total in 1 draw call!),
 * expansive 720m-wide terrain-conforming blue grid ribbon, and sparse low-poly bushes.
 */
function CloudHorizonScenery({
  runtimeRef,
  quality,
}: {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  quality: QualityLevel;
}) {
  const gl = useThree((s) => s.gl);
  const rainCount = quality === 'low' ? 48 : 112;
  const bushCount = 5; // Spaced 62.4m apart => exact 16x sparser than Palm Grove's 3.9m avg spacing
  const gridHalfWidth = 360; // 720m wide to fill ultrawide monitors edge-to-edge
  const gridRepeatX = 120;
  const gridRepeatY = 48;

  const rainRef = useRef<THREE.InstancedMesh>(null);
  const cloudInstRef = useRef<THREE.InstancedMesh>(null);
  const cloudLiftRef = useRef(0);
  const bushFoliageRef = useRef<THREE.InstancedMesh>(null);
  const bushBaseRef = useRef<THREE.InstancedMesh>(null);

  const bushGeos = useMemo(() => createLowPolyBushGeometries(), []);
  const cloudSpriteTex = useMemo(() => createCloudSpriteTexture(), []);
  const gridGeo = useMemo(() => buildLevelRibbonGeometry(gridHalfWidth, -0.22), [gridHalfWidth]);

  const gridTex = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#070b28';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(42, 168, 255, 0.78)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 252);
    ctx.strokeStyle = 'rgba(85, 200, 255, 0.36)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(128, 0);
    ctx.lineTo(128, 256);
    ctx.moveTo(0, 128);
    ctx.lineTo(256, 128);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(gridRepeatX, gridRepeatY);
    tex.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    return tex;
  }, [gl, gridRepeatX, gridRepeatY]);

  // Wide & tall falling digital rain streaks covering ultrawide + steep uphill skies
  const rainSeeds = useMemo(() => {
    return Array.from({ length: rainCount }, (_, i) => ({
      x: ((i * 39.7) % 420) - 210,
      yOffset: (i * 17.3) % 126,
      z: -60 - ((i * 23.1) % 190),
      len: 12 + ((i * 5.3) % 24),
      speed: 9 + ((i * 3.1) % 14),
      isCyan: i % 2 === 0,
    }));
  }, [rainCount]);

  // Sparse low-poly bushes spaced CLOUD_HORIZON_BUSH_SPACING_M (62.4m) apart
  const bushSeeds = useMemo(() => {
    const bushPalette = ['#1ef0d2', '#3cc4ff', '#c066ff', '#2ef0ae'];
    return Array.from({ length: bushCount }, (_, i) => ({
      side: i % 2 === 0 ? 1 : -1,
      slotZ: 28 + i * CLOUD_HORIZON_BUSH_SPACING_M,
      latOffset: ROAD_HALF_WIDTH + 1.9 + (i % 3) * 0.95,
      scale: 1.2 + (i % 3) * 0.16,
      yaw: i * 1.37,
      color: new THREE.Color(bushPalette[i % bushPalette.length]),
    }));
  }, [bushCount]);

  // 32 instanced 2D cumulus sprites spanning x in [-285, +285] (64 triangles total, 1 draw call!)
  const cloudSprites = useMemo(() => {
    const sprites: Array<{
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      flipX: number;
      tintColor: THREE.Color;
    }> = [];
    const perSide = CLOUD_HORIZON_SPRITE_COUNT / 2;
    const tints = ['#ffffff', '#ffe4d8', '#ffd6ee', '#f6c8ff'].map((hex) => new THREE.Color(hex));

    for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
      const side = sideIdx === 0 ? -1 : 1;
      for (let j = 0; j < perSide; j++) {
        const t = j / (perSide - 1); // 0 near sun canyon -> 1 far ultrawide wing
        const isFrontLayer = j % 2 === 1;
        const distX = 48 + t * 238 + (isFrontLayer ? 6 : -4);
        const w = (48 + t * 44) * (isFrontLayer ? 0.86 : 1.08);
        const h = w * (0.44 + (j % 3) * 0.05);
        const y = 7.5 + t * 14 + (isFrontLayer ? -2.5 : 4.5) + Math.sin(j * 1.9 + sideIdx) * 2.5;
        const z = isFrontLayer ? -274 - (j % 3) * 3 : -288 - (j % 3) * 3;
        sprites.push({
          x: side * distX,
          y,
          z,
          w,
          h,
          flipX: (j + sideIdx) % 2 === 0 ? 1 : -1,
          tintColor: tints[(j + sideIdx) % tints.length],
        });
      }
    }
    return sprites;
  }, []);

  useEffect(
    () => () => {
      gridGeo.dispose();
      gridTex.dispose();
      cloudSpriteTex.dispose();
      bushGeos.foliage.dispose();
      bushGeos.base.dispose();
    },
    [gridGeo, gridTex, cloudSpriteTex, bushGeos]
  );

  // Initialize static instanced 2D cloud sprites + subtle tint variation once
  useEffect(() => {
    if (cloudInstRef.current) {
      for (let i = 0; i < cloudSprites.length; i++) {
        const c = cloudSprites[i];
        _dummy.position.set(c.x, c.y, c.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(c.w * c.flipX, c.h, 1);
        _dummy.updateMatrix();
        cloudInstRef.current.setMatrixAt(i, _dummy.matrix);
        cloudInstRef.current.setColorAt(i, c.tintColor);
      }
      cloudInstRef.current.instanceMatrix.needsUpdate = true;
      if (cloudInstRef.current.instanceColor) {
        cloudInstRef.current.instanceColor.needsUpdate = true;
      }
    }
  }, [cloudSprites]);

  useEffect(() => {
    if (rainRef.current) {
      for (let i = 0; i < rainCount; i++) {
        rainRef.current.setColorAt(i, rainSeeds[i].isCyan ? _colCyanRain : _colPinkRain);
      }
      if (rainRef.current.instanceColor) rainRef.current.instanceColor.needsUpdate = true;
    }
    if (bushFoliageRef.current) {
      for (let i = 0; i < bushCount; i++) {
        bushFoliageRef.current.setColorAt(i, bushSeeds[i].color);
      }
      if (bushFoliageRef.current.instanceColor) {
        bushFoliageRef.current.instanceColor.needsUpdate = true;
      }
    }
  }, [rainCount, bushCount, rainSeeds, bushSeeds]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const rt = runtimeRef.current;
    const dist = rt.distance;

    // Positive UV offset scrolls the blue horizon grid DOWN the screen toward the cyclist at 1:1 speed
    gridTex.offset.y = computeForwardScrollOffset(dist, gridRepeatY, ROAD_Z_SPAN);
    updateLevelRibbonFromRoad(gridGeo, rt, gridHalfWidth, -0.22);

    const planes = rt.frustumPlanes;
    const useFrustum = rt.frustumReady;
    const sceneryStride = rt.sceneryScale < 0.75 ? 2 : 1;

    // Frustum-cull & compact 2D billboard cloud sprites (skips off-screen ultrawide wings)
    if (cloudInstRef.current) {
      const targetCloudY = rt.currentGrade * 195;
      cloudLiftRef.current += (targetCloudY - cloudLiftRef.current) * Math.min(1, delta * 4);
      const liftY = cloudLiftRef.current;
      let visClouds = 0;

      for (let i = 0; i < cloudSprites.length; i += sceneryStride) {
        const c = cloudSprites[i];
        const cy = c.y + liftY;
        const boundR = Math.max(c.w, c.h) * 0.62;
        if (useFrustum && !isSphereInFrustum(planes, c.x, cy, c.z, boundR)) {
          rt.culledInstances += 1;
          continue;
        }
        _dummy.position.set(c.x, cy, c.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(c.w * c.flipX, c.h, 1);
        _dummy.updateMatrix();
        cloudInstRef.current.setMatrixAt(visClouds, _dummy.matrix);
        cloudInstRef.current.setColorAt(visClouds, c.tintColor);
        visClouds += 1;
      }

      rt.drawnInstances += visClouds;
      cloudInstRef.current.count = visClouds;
      cloudInstRef.current.instanceMatrix.needsUpdate = true;
      if (cloudInstRef.current.instanceColor) {
        cloudInstRef.current.instanceColor.needsUpdate = true;
      }
    }

    // Frustum-cull & compact vertical digital rain streaks
    if (rainRef.current) {
      const rainLift = rt.currentGrade * 60;
      let visRain = 0;
      for (let i = 0; i < rainCount; i += sceneryStride) {
        const r = rainSeeds[i];
        const y = 132 + rainLift - ((r.yOffset + t * r.speed) % 126);
        if (useFrustum && !isAabbInFrustum(planes, r.x, y, r.z, 0.5, r.len * 0.55, 0.5)) {
          rt.culledInstances += 1;
          continue;
        }
        _dummy.position.set(r.x, y, r.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(0.14, r.len, 0.14);
        _dummy.updateMatrix();
        rainRef.current.setMatrixAt(visRain, _dummy.matrix);
        rainRef.current.setColorAt(visRain, r.isCyan ? _colCyanRain : _colPinkRain);
        visRain += 1;
      }
      rt.drawnInstances += visRain;
      rainRef.current.count = visRain;
      rainRef.current.instanceMatrix.needsUpdate = true;
      if (rainRef.current.instanceColor) {
        rainRef.current.instanceColor.needsUpdate = true;
      }
    }

    // Frustum-cull & compact sparse low-poly bushes
    if (bushFoliageRef.current && bushBaseRef.current) {
      const bushSpan = bushCount * CLOUD_HORIZON_BUSH_SPACING_M;
      let visBushes = 0;
      for (let i = 0; i < bushCount; i += sceneryStride) {
        const b = bushSeeds[i];
        const raw = (b.slotZ - dist) % bushSpan;
        const wrapped = raw < 0 ? raw + bushSpan : raw;
        const z = 9 - wrapped;
        if (z - 1.8 > rt.cameraZ) {
          rt.culledInstances += 1;
          continue;
        }
        sampleRoadAtZ(
          dist,
          z,
          _sample,
          rt.elevationProfile,
          rt.workoutElapsedSec,
          rt.freeRideTerrain
        );

        const cx = _sample.x + b.side * b.latOffset;
        const cy = _sample.y - 0.2;
        if (useFrustum && !isSphereInFrustum(planes, cx, cy + 0.75, z, 2.0)) {
          rt.culledInstances += 1;
          continue;
        }

        _dummy.position.set(cx, cy, z);
        _dummy.rotation.set(Math.atan(_sample.slopeY) * 0.6, b.yaw, 0);
        _dummy.scale.set(b.scale, b.scale, b.scale);
        _dummy.updateMatrix();
        bushFoliageRef.current.setMatrixAt(visBushes, _dummy.matrix);
        bushBaseRef.current.setMatrixAt(visBushes, _dummy.matrix);
        bushFoliageRef.current.setColorAt(visBushes, b.color);
        visBushes += 1;
      }
      rt.drawnInstances += visBushes;
      bushFoliageRef.current.count = visBushes;
      bushBaseRef.current.count = visBushes;
      bushFoliageRef.current.instanceMatrix.needsUpdate = true;
      bushBaseRef.current.instanceMatrix.needsUpdate = true;
      if (bushFoliageRef.current.instanceColor) {
        bushFoliageRef.current.instanceColor.needsUpdate = true;
      }
    }
  });

  return (
    <group>
      {/* Expansive 720m-wide blue glowing synthwave grid ribbon conforming to road elevation */}
      <mesh geometry={gridGeo} frustumCulled={false}>
        <meshStandardMaterial
          map={gridTex}
          emissiveMap={gridTex}
          emissive="#3da8ff"
          emissiveIntensity={0.68}
          roughness={0.4}
          metalness={0.5}
          polygonOffset
          polygonOffsetFactor={2}
          polygonOffsetUnits={2}
        />
      </mesh>

      {/* Occasional Low-Poly Synthwave Bushes (~16x sparser than Palm Grove palms) */}
      <instancedMesh
        ref={bushFoliageRef}
        args={[bushGeos.foliage, undefined, bushCount]}
        frustumCulled={false}
      >
        <meshStandardMaterial
          color="#ffffff"
          emissive="#1e6e88"
          emissiveIntensity={0.65}
          roughness={0.55}
          flatShading
        />
      </instancedMesh>
      <instancedMesh
        ref={bushBaseRef}
        args={[bushGeos.base, undefined, bushCount]}
        frustumCulled={false}
      >
        <meshStandardMaterial color="#181236" roughness={0.85} flatShading />
      </instancedMesh>

      {/* Vertical falling neon digital rain streaks spanning wide-screen & uphill skies */}
      <instancedMesh ref={rainRef} args={[undefined, undefined, rainCount]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.62}
          depthWrite={false}
          fog={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>

      {/* Instanced 2D sunset cumulus cloud sprites (2 triangles each, 1 frustum-culled draw call) */}
      <instancedMesh
        ref={cloudInstRef}
        args={[undefined, undefined, cloudSprites.length]}
        frustumCulled={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={cloudSpriteTex}
          color="#ffffff"
          transparent
          alphaTest={0.04}
          depthWrite={false}
          fog={false}
          side={THREE.DoubleSide}
        />
      </instancedMesh>
    </group>
  );
}

/**
 * Procedural basalt armor & gravel ballast embankment texture for Island Causeway
 * (inspired by Lüttmoorsiel–Nordstrandischmoor Halligbahn):
 * - u=0..0.24: crushed stone ballast shoulder + gleaming narrow-gauge steel rail stripe
 * - u=0.24..1.0: sloped dark basalt riprap blocks down to shimmering Wadden Sea foam line
 */
function createEmbankmentTexture(
  repeatY: number,
  maxAnisotropy: number
): { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture } {
  const w = 512;
  const h = 256;

  const colCanvas = document.createElement('canvas');
  colCanvas.width = w;
  colCanvas.height = h;
  const ctx = colCanvas.getContext('2d')!;

  // Base gradient from shoulder ballast down sloped wet basalt stone
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#1e2438'); // road shoulder edge
  grad.addColorStop(0.22, '#2b3248'); // gravel ballast crest
  grad.addColorStop(0.32, '#22273c'); // upper basalt riprap
  grad.addColorStop(0.84, '#141c2e'); // lower tidal-darkened basalt
  grad.addColorStop(1, '#10243a'); // waterline tide seam
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Subtle narrow-gauge steel rail + wooden sleeper ties along the shoulder crest (u=0.06..0.18)
  ctx.fillStyle = 'rgba(42, 30, 38, 0.72)';
  for (let r = 0; r < 12; r++) {
    ctx.fillRect(w * 0.04, (r / 12) * h + 4, w * 0.14, 7);
  }
  ctx.fillStyle = '#7adfff';
  ctx.fillRect(w * 0.075, 0, 5, h);
  ctx.fillRect(w * 0.145, 0, 5, h);

  // Deterministic basalt riprap stone blocks down the embankment slope (u=0.24..0.95)
  const cols = 10;
  const rows = 10;
  const startX = w * 0.24;
  const slopeW = w * 0.72;
  const cellW = slopeW / cols;
  const cellH = h / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hash = Math.sin(r * 19.3 + c * 7.7) * 43758.5453;
      const frac = hash - Math.floor(hash);
      const jitterX = (frac - 0.5) * cellW * 0.28;
      const shade = Math.floor(26 + frac * 34);
      const bx = startX + c * cellW + jitterX;
      const by = r * cellH;
      ctx.fillStyle = `rgb(${shade}, ${shade + 8}, ${shade + 26})`;
      ctx.fillRect(bx + 2, by + 2, cellW - 4, cellH - 4);
      ctx.strokeStyle = 'rgba(8, 12, 24, 0.65)';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx + 2, by + 2, cellW - 4, cellH - 4);
    }
  }

  // Soft tidal waterline foam sheen along the bottom edge of the stone armor
  const foam = ctx.createLinearGradient(w * 0.88, 0, w, 0);
  foam.addColorStop(0, 'rgba(72, 218, 255, 0)');
  foam.addColorStop(0.55, 'rgba(110, 232, 255, 0.34)');
  foam.addColorStop(1, 'rgba(60, 180, 235, 0.12)');
  ctx.fillStyle = foam;
  ctx.fillRect(w * 0.88, 0, w * 0.12, h);

  const map = new THREE.CanvasTexture(colCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, repeatY);
  map.anisotropy = Math.min(8, maxAnisotropy);
  map.needsUpdate = true;

  // Subtle emissive map: gleaming parallel narrow-gauge rail lines + waterline bioluminescent foam
  const emCanvas = document.createElement('canvas');
  emCanvas.width = w;
  emCanvas.height = h;
  const ectx = emCanvas.getContext('2d')!;
  ectx.fillStyle = '#000000';
  ectx.fillRect(0, 0, w, h);

  ectx.fillStyle = 'rgba(0, 210, 255, 0.42)';
  ectx.fillRect(w * 0.075, 0, 5, h);
  ectx.fillRect(w * 0.145, 0, 5, h);

  const waterGlow = ectx.createLinearGradient(w * 0.88, 0, w, 0);
  waterGlow.addColorStop(0, 'rgba(0, 195, 255, 0)');
  waterGlow.addColorStop(0.6, 'rgba(48, 220, 255, 0.38)');
  waterGlow.addColorStop(1, 'rgba(0, 180, 240, 0)');
  ectx.fillStyle = waterGlow;
  ectx.fillRect(w * 0.88, 0, w * 0.12, h);

  const emissiveMap = new THREE.CanvasTexture(emCanvas);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;
  emissiveMap.wrapS = THREE.ClampToEdgeWrapping;
  emissiveMap.wrapT = THREE.RepeatWrapping;
  emissiveMap.repeat.set(1, repeatY);
  emissiveMap.anisotropy = Math.min(8, maxAnisotropy);
  emissiveMap.needsUpdate = true;

  return { map, emissiveMap };
}

/**
 * Procedural shimmering Wadden Sea tidal water texture for Island Causeway
 * (deep maritime indigo-teal water with warm sunset coral & cyan ripple glints).
 */
function createWaddenWaterTexture(
  repeatX: number,
  repeatY: number,
  maxAnisotropy: number
): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#07172c';
  ctx.fillRect(0, 0, w, h);

  // Subtle synthwave tidal sandbar & swell bands
  for (let i = 0; i < 28; i++) {
    const hash = Math.sin(i * 37.9 + 4.1) * 43758.5453;
    const f = hash - Math.floor(hash);
    const y = (i / 28) * h;
    const x = f * w;
    const len = 34 + ((i * 19) % 68);
    ctx.fillStyle = i % 3 === 0 ? 'rgba(255, 134, 98, 0.24)' : 'rgba(46, 206, 245, 0.28)';
    ctx.fillRect(x, y, len, 3);
    if (x + len > w) {
      ctx.fillRect(0, y, x + len - w, 3);
    }
  }

  // Fine water shimmer horizon lines
  ctx.strokeStyle = 'rgba(72, 186, 232, 0.18)';
  ctx.lineWidth = 1.5;
  for (let r = 0; r < 8; r++) {
    const y = (r / 8) * h + 6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = Math.min(8, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a 4-vertex-per-row raised sloped stone embankment geometry (left or right side)
 * dropping from road height down to submerged stone toe below the Wadden Sea waterline.
 */
function buildEmbankmentProfileGeometry(side: -1 | 1): THREE.BufferGeometry {
  const vertsPerRow = 4;
  const vertexCount = (STRIP_SEGMENTS + 1) * vertsPerRow;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];

  for (let i = 0; i <= STRIP_SEGMENTS; i++) {
    const linearT = STRIP_LINEAR_T[i];
    const baseV = i * vertsPerRow;

    // Shoulder top faces +Y, embankment armor slopes outward & upward
    normals[(baseV + 0) * 3 + 0] = 0;
    normals[(baseV + 0) * 3 + 1] = 1;
    normals[(baseV + 0) * 3 + 2] = 0;

    normals[(baseV + 1) * 3 + 0] = side * 0.22;
    normals[(baseV + 1) * 3 + 1] = 0.975;
    normals[(baseV + 1) * 3 + 2] = 0;

    normals[(baseV + 2) * 3 + 0] = side * 0.56;
    normals[(baseV + 2) * 3 + 1] = 0.83;
    normals[(baseV + 2) * 3 + 2] = 0;

    normals[(baseV + 3) * 3 + 0] = side * 0.52;
    normals[(baseV + 3) * 3 + 1] = 0.85;
    normals[(baseV + 3) * 3 + 2] = 0;

    uvs[(baseV + 0) * 2 + 0] = 0.0;
    uvs[(baseV + 0) * 2 + 1] = linearT;
    uvs[(baseV + 1) * 2 + 0] = 0.24;
    uvs[(baseV + 1) * 2 + 1] = linearT;
    uvs[(baseV + 2) * 2 + 0] = 0.64;
    uvs[(baseV + 2) * 2 + 1] = linearT;
    uvs[(baseV + 3) * 2 + 0] = 1.0;
    uvs[(baseV + 3) * 2 + 1] = linearT;

    if (i < STRIP_SEGMENTS) {
      const nBase = (i + 1) * vertsPerRow;
      for (let q = 0; q < 3; q++) {
        if (side === 1) {
          indices.push(
            baseV + q,
            baseV + q + 1,
            nBase + q,
            baseV + q + 1,
            nBase + q + 1,
            nBase + q
          );
        } else {
          indices.push(
            baseV + q + 1,
            baseV + q,
            nBase + q,
            baseV + q + 1,
            nBase + q,
            nBase + q + 1
          );
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function updateEmbankmentFromCenterCache(geo: THREE.BufferGeometry, side: -1 | 1): void {
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;
  const innerX = side * (ROAD_HALF_WIDTH + 0.15);
  const crestX = side * (ROAD_HALF_WIDTH + 1.45);
  const midSlopeX = side * (ROAD_HALF_WIDTH + 4.0);
  const toeX = side * CAUSEWAY_EMBANKMENT_TOE_X;

  for (let i = 0; i <= STRIP_SEGMENTS; i++) {
    const cx = _cityCenterX[i];
    const cy = _cityCenterY[i];
    const z = STRIP_Z[i];
    const idx = i * 12;

    // 0: Road shoulder edge
    arr[idx + 0] = cx + innerX;
    arr[idx + 1] = cy - 0.01;
    arr[idx + 2] = z;

    // 1: Ballast/rail shoulder crest
    arr[idx + 3] = cx + crestX;
    arr[idx + 4] = cy - 0.09;
    arr[idx + 5] = z;

    // 2: Mid stone armor slope
    arr[idx + 6] = cx + midSlopeX;
    arr[idx + 7] = cy - CAUSEWAY_EMBANKMENT_DROP_M * 0.54;
    arr[idx + 8] = z;

    // 3: Submerged stone embankment toe below tidal sea level
    arr[idx + 9] = cx + toeX;
    arr[idx + 10] = cy - CAUSEWAY_EMBANKMENT_DROP_M - 0.35;
    arr[idx + 11] = z;
  }

  posAttr.needsUpdate = true;
}

/**
 * Island Causeway Scenery — inspired by the Lüttmoorsiel–Nordstrandischmoor Halligbahn:
 * - Raised sloped basalt stone embankment with parallel narrow-gauge rail glint on both shoulders
 * - Endless 720m-wide shimmering Wadden Sea tidal water flanking both sides
 * - Iconic wooden tidal breakwater groynes (Lahnungen) jutting perpendicular into the sea
 * - Coastal shoulder reflector bollards + distant Hallig island Warft mound & pulsing beacon
 */
function CausewayEmbankmentScenery({
  runtimeRef,
}: {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
}) {
  const gl = useThree((s) => s.gl);
  const waterHalfWidth = 360;
  const waterRepeatX = 76;
  const waterRepeatY = 38;
  const embankmentRepeatY = 44;

  // 8 perpendicular wooden breakwater groynes (4 per side) x 12 timber pilings = 96 posts in 1 draw call
  const groyneArmCount = 8;
  const pilingsPerArm = 12;
  const totalPilings = groyneArmCount * pilingsPerArm;
  const groyneSpacingM = 34;

  // Coastal reflector bollards lining the embankment crests every 22m
  const bollardCount = 24;
  const bollardStepM = 22;

  const pilingRef = useRef<THREE.InstancedMesh>(null);
  const groyneBeamRef = useRef<THREE.InstancedMesh>(null);
  const bollardPostRef = useRef<THREE.InstancedMesh>(null);
  const bollardCapRef = useRef<THREE.InstancedMesh>(null);
  const halligGroupRef = useRef<THREE.Group>(null);
  const beaconMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const halligLiftRef = useRef(0);

  const waterGeo = useMemo(
    () => buildLevelRibbonGeometry(waterHalfWidth, -CAUSEWAY_EMBANKMENT_DROP_M),
    [waterHalfWidth]
  );
  const waterTex = useMemo(
    () => createWaddenWaterTexture(waterRepeatX, waterRepeatY, gl.capabilities.getMaxAnisotropy()),
    [gl, waterRepeatX, waterRepeatY]
  );
  const embTextures = useMemo(
    () => createEmbankmentTexture(embankmentRepeatY, gl.capabilities.getMaxAnisotropy()),
    [gl, embankmentRepeatY]
  );
  const embGeos = useMemo(
    () => ({
      left: buildEmbankmentProfileGeometry(-1),
      right: buildEmbankmentProfileGeometry(1),
    }),
    []
  );

  const groyneArms = useMemo(() => {
    return Array.from({ length: groyneArmCount }, (_, a) => ({
      side: (a % 2 === 0 ? -1 : 1) as -1 | 1,
      slotZ: 18 + a * groyneSpacingM,
      lengthM: 22 + (a % 3) * 6,
    }));
  }, [groyneArmCount, groyneSpacingM]);

  const bollardSeeds = useMemo(() => {
    return Array.from({ length: bollardCount }, (_, i) => ({
      side: (i % 2 === 0 ? -1 : 1) as -1 | 1,
      slotZ: Math.floor(i / 2) * bollardStepM + (i % 2 === 0 ? 0 : bollardStepM * 0.5),
      isCyan: i % 2 === 0,
    }));
  }, [bollardCount, bollardStepM]);

  useEffect(
    () => () => {
      waterGeo.dispose();
      waterTex.dispose();
      embTextures.map.dispose();
      embTextures.emissiveMap.dispose();
      embGeos.left.dispose();
      embGeos.right.dispose();
    },
    [waterGeo, waterTex, embTextures, embGeos]
  );

  useEffect(() => {
    if (bollardCapRef.current) {
      for (let i = 0; i < bollardCount; i++) {
        _color.set(bollardSeeds[i].isCyan ? '#3cf0ff' : '#ff9852');
        bollardCapRef.current.setColorAt(i, _color);
      }
      if (bollardCapRef.current.instanceColor) {
        bollardCapRef.current.instanceColor.needsUpdate = true;
      }
    }
  }, [bollardCount, bollardSeeds]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const rt = runtimeRef.current;
    const dist = rt.distance;

    // Scroll embankment stone & tidal water forward toward rider at exact 1:1 physical speed
    const embOff = computeForwardScrollOffset(dist, embankmentRepeatY, ROAD_Z_SPAN);
    embTextures.map.offset.y = embOff;
    embTextures.emissiveMap.offset.y = embOff;

    waterTex.offset.y = computeForwardScrollOffset(dist, waterRepeatY, ROAD_Z_SPAN);
    // Gentle lateral North Sea tide ripple shimmer
    waterTex.offset.x = Math.sin(t * 0.22) * 0.08;

    // Sample road centerline ONCE for both left & right sloped embankments + water ribbon
    const waterPos = waterGeo.attributes.position as THREE.BufferAttribute;
    const waterArr = waterPos.array as Float32Array;
    for (let i = 0; i <= STRIP_SEGMENTS; i++) {
      const z = STRIP_Z[i];
      sampleRoadAtZ(
        dist,
        z,
        _sample,
        rt.elevationProfile,
        rt.workoutElapsedSec,
        rt.freeRideTerrain
      );
      _cityCenterX[i] = _sample.x;
      _cityCenterY[i] = _sample.y;

      const yWater = _sample.y - CAUSEWAY_EMBANKMENT_DROP_M;
      const wIdx = i * 6;
      waterArr[wIdx + 0] = _sample.x - waterHalfWidth;
      waterArr[wIdx + 1] = yWater;
      waterArr[wIdx + 2] = z;
      waterArr[wIdx + 3] = _sample.x + waterHalfWidth;
      waterArr[wIdx + 4] = yWater;
      waterArr[wIdx + 5] = z;
    }
    waterPos.needsUpdate = true;
    updateEmbankmentFromCenterCache(embGeos.left, -1);
    updateEmbankmentFromCenterCache(embGeos.right, 1);

    const planes = rt.frustumPlanes;
    const useFrustum = rt.frustumReady;
    const nearWrapZ = 9;
    const sceneryStride = rt.sceneryScale < 0.75 ? 2 : 1;

    // Frustum-cull & compact wooden tidal breakwater pilings (Lahnungen) + horizontal rails
    if (pilingRef.current && groyneBeamRef.current) {
      const groyneSpan = groyneArmCount * groyneSpacingM;
      let visPilings = 0;
      let visBeams = 0;

      for (let a = 0; a < groyneArmCount; a += sceneryStride) {
        const arm = groyneArms[a];
        const raw = (arm.slotZ - dist) % groyneSpan;
        const wrapped = raw < 0 ? raw + groyneSpan : raw;
        const z = nearWrapZ - wrapped;
        if (z - 2.0 > rt.cameraZ) {
          rt.culledInstances += pilingsPerArm + 1;
          continue;
        }

        sampleRoadAtZ(
          dist,
          z,
          _sample,
          rt.elevationProfile,
          rt.workoutElapsedSec,
          rt.freeRideTerrain
        );

        const waterY = _sample.y - CAUSEWAY_EMBANKMENT_DROP_M;
        const startX = _sample.x + arm.side * (CAUSEWAY_EMBANKMENT_TOE_X + 1.2);
        const midX = startX + arm.side * (arm.lengthM * 0.5);

        // Coarse arm frustum rejection skips all 12 pilings + beam at once when off-screen!
        if (
          useFrustum &&
          !isAabbInFrustum(planes, midX, waterY + 0.7, z, arm.lengthM * 0.55, 2.0, 2.2)
        ) {
          rt.culledInstances += pilingsPerArm + 1;
          continue;
        }

        // Horizontal weathered timber breakwater beam connecting the pilings above the tide
        _dummy.position.set(midX, waterY + 0.65, z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(arm.lengthM, 0.2, 0.24);
        _dummy.updateMatrix();
        groyneBeamRef.current.setMatrixAt(visBeams, _dummy.matrix);
        visBeams += 1;

        for (let p = 0; p < pilingsPerArm; p += sceneryStride) {
          const frac = p / (pilingsPerArm - 1);
          const px = startX + arm.side * (frac * arm.lengthM);
          const pz = z + (p % 2 === 0 ? -0.32 : 0.32);
          const postH = 1.6 + ((p * 0.17 + a * 0.23) % 0.45);
          _dummy.position.set(px, waterY + postH * 0.5 - 0.35, pz);
          _dummy.rotation.set(0, 0, ((p % 3) - 1) * 0.04);
          _dummy.scale.set(0.14, postH, 0.14);
          _dummy.updateMatrix();
          pilingRef.current.setMatrixAt(visPilings, _dummy.matrix);
          visPilings += 1;
        }
      }

      rt.drawnInstances += visPilings + visBeams;
      pilingRef.current.count = visPilings;
      groyneBeamRef.current.count = visBeams;
      pilingRef.current.instanceMatrix.needsUpdate = true;
      groyneBeamRef.current.instanceMatrix.needsUpdate = true;
    }

    // Frustum-cull & compact embankment shoulder reflector bollards
    if (bollardPostRef.current && bollardCapRef.current) {
      const bollardSpan = (bollardCount / 2) * bollardStepM;
      let visBollards = 0;

      for (let i = 0; i < bollardCount; i += sceneryStride) {
        const b = bollardSeeds[i];
        const raw = (b.slotZ - dist) % bollardSpan;
        const wrapped = raw < 0 ? raw + bollardSpan : raw;
        const z = nearWrapZ - wrapped;
        if (z - 0.8 > rt.cameraZ) {
          rt.culledInstances += 1;
          continue;
        }

        sampleRoadAtZ(
          dist,
          z,
          _sample,
          rt.elevationProfile,
          rt.workoutElapsedSec,
          rt.freeRideTerrain
        );

        const bx = _sample.x + b.side * (ROAD_HALF_WIDTH + 1.25);
        const by = _sample.y - 0.08;
        if (useFrustum && !isSphereInFrustum(planes, bx, by + 0.55, z, 1.1)) {
          rt.culledInstances += 1;
          continue;
        }

        _dummy.position.set(bx, by + 0.46, z);
        _dummy.rotation.set(Math.atan(_sample.slopeY) * 0.6, 0, 0);
        _dummy.scale.set(0.11, 0.92, 0.11);
        _dummy.updateMatrix();
        bollardPostRef.current.setMatrixAt(visBollards, _dummy.matrix);

        _dummy.position.set(bx, by + 0.82, z);
        _dummy.scale.set(0.135, 0.14, 0.135);
        _dummy.updateMatrix();
        bollardCapRef.current.setMatrixAt(visBollards, _dummy.matrix);
        bollardCapRef.current.setColorAt(
          visBollards,
          b.isCyan ? _colCyanBollard : _colAmberBollard
        );
        visBollards += 1;
      }

      rt.drawnInstances += visBollards;
      bollardPostRef.current.count = visBollards;
      bollardCapRef.current.count = visBollards;
      bollardPostRef.current.instanceMatrix.needsUpdate = true;
      bollardCapRef.current.instanceMatrix.needsUpdate = true;
      if (bollardCapRef.current.instanceColor) {
        bollardCapRef.current.instanceColor.needsUpdate = true;
      }
    }

    // Track uphill gradient smoothly for the distant Hallig island Warft silhouette + pulse beacon
    if (halligGroupRef.current) {
      const targetY = -CAUSEWAY_EMBANKMENT_DROP_M + rt.currentGrade * 165;
      halligLiftRef.current += (targetY - halligLiftRef.current) * Math.min(1, delta * 4);
      halligGroupRef.current.position.y = halligLiftRef.current;
    }
    if (beaconMatRef.current) {
      const pulse = 0.65 + 0.35 * Math.sin(t * 2.4);
      beaconMatRef.current.opacity = pulse;
    }
  });

  return (
    <group>
      {/* Endless 720m-wide shimmering Wadden Sea tidal water on both sides of the embankment */}
      <mesh geometry={waterGeo} frustumCulled={false}>
        <meshStandardMaterial
          map={waterTex}
          emissiveMap={waterTex}
          emissive="#1e92c8"
          emissiveIntensity={0.62}
          roughness={0.28}
          metalness={0.65}
          polygonOffset
          polygonOffsetFactor={3}
          polygonOffsetUnits={3}
        />
      </mesh>

      {/* Left & Right Raised Sloped Basalt Stone Embankment Walls (2 draw calls total) */}
      <mesh geometry={embGeos.left} frustumCulled={false}>
        <meshStandardMaterial
          map={embTextures.map}
          emissiveMap={embTextures.emissiveMap}
          emissive="#32c8ff"
          emissiveIntensity={0.55}
          roughness={0.78}
          metalness={0.26}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      <mesh geometry={embGeos.right} frustumCulled={false}>
        <meshStandardMaterial
          map={embTextures.map}
          emissiveMap={embTextures.emissiveMap}
          emissive="#32c8ff"
          emissiveIntensity={0.55}
          roughness={0.78}
          metalness={0.26}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>

      {/* Iconic Wooden Tidal Breakwater Pilings & Cross-Beams (Lahnungen, 2 frustum-culled draw calls) */}
      <instancedMesh
        ref={pilingRef}
        args={[undefined, undefined, totalPilings]}
        frustumCulled={false}
      >
        <cylinderGeometry args={[0.85, 1, 1, 6]} />
        <meshStandardMaterial color="#362834" roughness={0.92} metalness={0.08} />
      </instancedMesh>
      <instancedMesh
        ref={groyneBeamRef}
        args={[undefined, undefined, groyneArmCount]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#402f3b" roughness={0.9} metalness={0.08} />
      </instancedMesh>

      {/* Coastal Shoulder Reflector Bollards along both embankment crests */}
      <instancedMesh
        ref={bollardPostRef}
        args={[undefined, undefined, bollardCount]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#1f273c" roughness={0.6} metalness={0.4} />
      </instancedMesh>
      <instancedMesh
        ref={bollardCapRef}
        args={[undefined, undefined, bollardCount]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>

      {/* Distant Hallig Island Mound (Warft) Silhouette + Pulsing Coastal Navigation Beacon */}
      <group ref={halligGroupRef} position={[68, -CAUSEWAY_EMBANKMENT_DROP_M, -286]}>
        {/* Low flat Hallig earth dike mound */}
        <mesh position={[0, 2.2, 0]} scale={[36, 4.4, 10]}>
          <cylinderGeometry args={[0.72, 1.0, 1, 8]} />
          <meshBasicMaterial color="#151b32" />
        </mesh>
        {/* Silhouetted Hallig farmhouse on the Warft */}
        <mesh position={[-4, 5.6, 0]}>
          <boxGeometry args={[9.5, 3.2, 4.8]} />
          <meshBasicMaterial color="#1b223d" />
        </mesh>
        <mesh position={[-4, 8.6, 0]} rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[7.4, 3.4, 4]} />
          <meshBasicMaterial color="#1f2846" />
        </mesh>
        {/* Warm lit farmhouse window dots */}
        <mesh position={[-6.2, 5.6, 2.5]}>
          <planeGeometry args={[1.4, 1.1]} />
          <meshBasicMaterial color="#ffb86c" toneMapped={false} fog={false} />
        </mesh>
        <mesh position={[-1.8, 5.6, 2.5]}>
          <planeGeometry args={[1.4, 1.1]} />
          <meshBasicMaterial color="#ffb86c" toneMapped={false} fog={false} />
        </mesh>
        {/* Coastal navigation beacon mast + pulsing amber lantern */}
        <mesh position={[14, 9.5, 0]}>
          <cylinderGeometry args={[0.32, 0.55, 11, 6]} />
          <meshBasicMaterial color="#1e2944" />
        </mesh>
        <mesh position={[14, 15.6, 0]}>
          <sphereGeometry args={[1.15, 8, 8]} />
          <meshBasicMaterial
            ref={beaconMatRef}
            color="#ffaa55"
            transparent
            opacity={0.95}
            toneMapped={false}
            fog={false}
          />
        </mesh>
      </group>
    </group>
  );
}

export function SceneryThemes({ runtimeRef, sceneryTheme, quality }: SceneryThemesProps) {
  return (
    <group>
      <UnifiedSynthwaveSky theme={sceneryTheme} runtimeRef={runtimeRef} />
      {sceneryTheme === 'neon-city' && <NeonCityScenery runtimeRef={runtimeRef} />}
      {sceneryTheme === 'palm-grove' && <PalmGroveScenery runtimeRef={runtimeRef} />}
      {sceneryTheme === 'cloud-horizon' && (
        <CloudHorizonScenery runtimeRef={runtimeRef} quality={quality} />
      )}
      {sceneryTheme === 'causeway-embankment' && (
        <CausewayEmbankmentScenery runtimeRef={runtimeRef} />
      )}
    </group>
  );
}
