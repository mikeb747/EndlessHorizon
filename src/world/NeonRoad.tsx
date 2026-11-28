import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { QualityLevel, SceneryTheme } from '../store/useAppStore';
import {
  computeForwardScrollOffset,
  ROAD_HALF_WIDTH,
  ROAD_SEGMENTS,
  ROAD_Z_SPAN,
  WorldRuntimeState,
} from './roadMath';
import {
  createRoadProfileUniformArray,
  packRoadProfileUniforms,
  ROAD_PROFILE_COUNT,
  ROAD_SEGMENT_LINEAR_T,
  ROAD_SEGMENT_Z,
} from './roadShaderHelpers';

interface NeonRoadProps {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  zoneHex: string;
  sceneryTheme: SceneryTheme;
  quality: QualityLevel;
}

const SEGMENTS = ROAD_SEGMENTS;
const ROAD_REPEAT_Y = 36;

// Module-level scratch colors (zero per-frame allocations)
const _targetColor = new THREE.Color();
const _currentColor = new THREE.Color('#00e5ff');
const _centerColor = new THREE.Color('#ff2a9d');

interface StripSpec {
  offsetLeft: number;
  offsetRight: number;
  yLift: number;
  weight?: number;
}

function createRoadSurfaceTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Deep glossy obsidian asphalt base
  ctx.fillStyle = '#070614';
  ctx.fillRect(0, 0, size, size);

  // Subtle wet-look center reflection gradient
  const centerGrad = ctx.createLinearGradient(0, 0, size, 0);
  centerGrad.addColorStop(0, 'rgba(14, 10, 32, 0.25)');
  centerGrad.addColorStop(0.25, 'rgba(20, 14, 42, 0.45)');
  centerGrad.addColorStop(0.5, 'rgba(56, 22, 74, 0.72)');
  centerGrad.addColorStop(0.75, 'rgba(20, 14, 42, 0.45)');
  centerGrad.addColorStop(1, 'rgba(14, 10, 32, 0.25)');
  ctx.fillStyle = centerGrad;
  ctx.fillRect(0, 0, size, size);

  // Faint synthwave grid lines across the road
  ctx.strokeStyle = 'rgba(140, 95, 255, 0.28)';
  ctx.lineWidth = 2;
  const cols = 8;
  for (let i = 1; i < cols; i++) {
    const x = (i / cols) * size;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }

  const rows = 4;
  ctx.strokeStyle = 'rgba(0, 220, 255, 0.24)';
  ctx.lineWidth = 2;
  for (let j = 0; j < rows; j++) {
    const y = (j / rows) * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  // Soft neon center lane strip
  const glowGrad = ctx.createLinearGradient(size * 0.42, 0, size * 0.58, 0);
  glowGrad.addColorStop(0, 'rgba(255, 42, 157, 0)');
  glowGrad.addColorStop(0.5, 'rgba(255, 42, 157, 0.55)');
  glowGrad.addColorStop(1, 'rgba(255, 42, 157, 0)');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(size * 0.42, 0, size * 0.16, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(8, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build static road strip geometry once at mount.
 * Vertices hold local (lateralOffset, yLift, worldZ) plus `aSegIndex` (0..ROAD_SEGMENTS)
 * and `aRibbonWeight`, so all curving & elevation displacement happens 100% in the GPU vertex shader.
 */
function buildStaticRoadStripsGeometry(strips: StripSpec[]): THREE.BufferGeometry {
  const vertsPerStrip = (SEGMENTS + 1) * 2;
  const totalVerts = vertsPerStrip * strips.length;
  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const segIndices = new Float32Array(totalVerts);
  const weights = new Float32Array(totalVerts);
  const indices: number[] = [];

  for (let s = 0; s < strips.length; s++) {
    const strip = strips[s];
    const baseVertex = s * vertsPerStrip;
    const w = strip.weight ?? 1.0;

    for (let i = 0; i <= SEGMENTS; i++) {
      const z = ROAD_SEGMENT_Z[i];
      const linearT = ROAD_SEGMENT_LINEAR_T[i];
      const v0 = baseVertex + i * 2;
      const v1 = v0 + 1;

      positions[v0 * 3 + 0] = strip.offsetLeft;
      positions[v0 * 3 + 1] = strip.yLift;
      positions[v0 * 3 + 2] = z;

      positions[v1 * 3 + 0] = strip.offsetRight;
      positions[v1 * 3 + 1] = strip.yLift;
      positions[v1 * 3 + 2] = z;

      uvs[v0 * 2 + 0] = 0;
      uvs[v0 * 2 + 1] = linearT;
      uvs[v1 * 2 + 0] = 1;
      uvs[v1 * 2 + 1] = linearT;

      segIndices[v0] = i;
      segIndices[v1] = i;
      weights[v0] = w;
      weights[v1] = w;

      if (i < SEGMENTS) {
        const a = v0;
        const b = v1;
        const c = v0 + 2;
        const d = v1 + 2;
        indices.push(a, b, c, b, d, c);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aSegIndex', new THREE.BufferAttribute(segIndices, 1));
  geo.setAttribute('aRibbonWeight', new THREE.BufferAttribute(weights, 1));
  geo.setIndex(indices);
  return geo;
}

const ROAD_VERTEX_SHADER = `
  attribute float aSegIndex;
  attribute float aRibbonWeight;
  uniform vec4 uRoadProfile[${ROAD_PROFILE_COUNT}];

  varying vec2 vUv;
  varying float vWeight;
  varying vec3 vWorldPos;
  varying vec3 vNormalDir;
  #include <fog_pars_vertex>

  void main() {
    int idx = int(aSegIndex + 0.5);
    vec4 prof = uRoadProfile[idx];

    vec3 displaced = position;
    displaced.x += prof.x;
    displaced.y += prof.y;

    vUv = uv;
    vWeight = aRibbonWeight;
    vNormalDir = normalize(vec3(0.0, 1.0, prof.w));

    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = worldPos.xyz;
    vec4 mvPosition = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const DECK_FRAGMENT_SHADER = `
  uniform sampler2D uRoadMap;
  uniform float uScrollOffset;
  uniform float uRepeatY;
  uniform float uWetness;
  uniform vec3 uZoneColor;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormalDir;
  #include <fog_pars_fragment>

  void main() {
    // Scroll road asphalt & synthwave grid toward the cyclist on GPU
    vec2 scrollUv = vec2(vUv.x, vUv.y * uRepeatY + uScrollOffset);
    vec3 baseCol = texture2D(uRoadMap, scrollUv).rgb;

    // Subtle wet-asphalt Fresnel & grazing sunset sheen
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float ndotv = clamp(dot(normalize(vNormalDir), viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - ndotv, 3.0) * uWetness;

    // Soft zone-colored edge bounce along outer 18% of asphalt deck
    float edgeProx = smoothstep(0.32, 0.5, abs(vUv.x - 0.5));
    vec3 edgeBounce = uZoneColor * edgeProx * (0.14 + fresnel * 0.22);

    // Subtle cool sky reflection across glossy center lane
    vec3 skySheen = vec3(0.16, 0.12, 0.30) * fresnel * 0.45;

    vec3 col = baseCol + edgeBounce + skySheen;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

const EDGE_CORE_FRAGMENT_SHADER = `
  uniform vec3 uZoneColor;
  uniform float uGlowMult;
  uniform float uFlash;

  varying vec2 vUv;
  varying float vWeight;
  #include <fog_pars_fragment>

  void main() {
    // White-hot neon core tapering smoothly into saturated zone color at ribbon borders
    float centerDist = abs(vUv.x - 0.5) * 2.0;
    float coreHot = smoothstep(0.65, 0.0, centerDist);
    float edgeFade = 1.0 - smoothstep(0.78, 1.0, centerDist);

    vec3 neonCol = uZoneColor * (uGlowMult * vWeight + uFlash * 1.45 * vWeight);
    vec3 whiteHot = mix(uZoneColor, vec3(1.0), 0.72) * (1.35 + uFlash * 0.75) * vWeight;
    vec3 col = mix(neonCol, whiteHot, coreHot * 0.62) * edgeFade;

    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

const EDGE_HALO_FRAGMENT_SHADER = `
  uniform vec3 uZoneColor;
  uniform float uFlash;

  varying vec2 vUv;
  #include <fog_pars_fragment>

  void main() {
    // Smooth Gaussian additive glow halo so road edges shine vividly even when Bloom is OFF
    float d = (vUv.x - 0.5) * 2.0;
    float halo = exp(-d * d * 4.4);
    float alpha = halo * (0.42 + uFlash * 0.28);
    vec3 col = uZoneColor * (1.28 + uFlash * 0.85) * halo;

    gl_FragColor = vec4(col, alpha);
    #include <fog_fragment>
  }
`;

const CENTER_GLOW_FRAGMENT_SHADER = `
  uniform vec3 uCenterColor;
  uniform float uOpacity;
  uniform float uScrollOffset;

  varying vec2 vUv;
  #include <fog_pars_fragment>

  void main() {
    float d = (vUv.x - 0.5) * 2.0;
    float glow = exp(-d * d * 3.8);
    // Subtle forward-streaming pulse cadence along the center strip
    float wave = 0.86 + 0.14 * sin((vUv.y * 18.0 + uScrollOffset * 2.0) * 6.28318);
    float alpha = glow * uOpacity * wave;

    gl_FragColor = vec4(uCenterColor * glow * 1.15, alpha);
    #include <fog_fragment>
  }
`;

export function NeonRoad({ runtimeRef, zoneHex, sceneryTheme, quality }: NeonRoadProps) {
  const gl = useThree((s) => s.gl);

  const roadTexture = useMemo(
    () => createRoadSurfaceTexture(gl.capabilities.getMaxAnisotropy()),
    [gl]
  );

  // Preallocated shared road profile uniform array (mutated in-place, zero allocations per frame)
  const profileUniforms = useMemo(() => createRoadProfileUniformArray(), []);

  // Static GPU geometries allocated once at mount (ZERO per-frame vertex uploads!)
  const geometries = useMemo(() => {
    return {
      deck: buildStaticRoadStripsGeometry([
        { offsetLeft: -ROAD_HALF_WIDTH, offsetRight: ROAD_HALF_WIDTH, yLift: 0, weight: 1 },
      ]),
      centerGlow: buildStaticRoadStripsGeometry([
        { offsetLeft: -0.48, offsetRight: 0.48, yLift: 0.025, weight: 1 },
      ]),
      // Bright zone-colored core ribbons (outer left/right + parallel inner lines in 1 draw call)
      edgeCore: buildStaticRoadStripsGeometry([
        {
          offsetLeft: -ROAD_HALF_WIDTH - 0.22,
          offsetRight: -ROAD_HALF_WIDTH + 0.14,
          yLift: 0.056,
          weight: 1.0,
        },
        {
          offsetLeft: ROAD_HALF_WIDTH - 0.14,
          offsetRight: ROAD_HALF_WIDTH + 0.22,
          yLift: 0.056,
          weight: 1.0,
        },
        {
          offsetLeft: -ROAD_HALF_WIDTH + 0.48,
          offsetRight: -ROAD_HALF_WIDTH + 0.62,
          yLift: 0.042,
          weight: 0.68,
        },
        {
          offsetLeft: ROAD_HALF_WIDTH - 0.62,
          offsetRight: ROAD_HALF_WIDTH - 0.48,
          yLift: 0.042,
          weight: 0.68,
        },
      ]),
      // Soft additive halo flanking both outer edges so zone glow shines even with Bloom OFF
      edgeHalo: buildStaticRoadStripsGeometry([
        {
          offsetLeft: -ROAD_HALF_WIDTH - 0.85,
          offsetRight: -ROAD_HALF_WIDTH + 0.72,
          yLift: 0.046,
          weight: 1.0,
        },
        {
          offsetLeft: ROAD_HALF_WIDTH - 0.72,
          offsetRight: ROAD_HALF_WIDTH + 0.85,
          yLift: 0.046,
          weight: 1.0,
        },
      ]),
    };
  }, []);

  const materials = useMemo(() => {
    const deck = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uRoadProfile: { value: profileUniforms },
          uRoadMap: { value: roadTexture },
          uScrollOffset: { value: 0 },
          uRepeatY: { value: ROAD_REPEAT_Y },
          uWetness: { value: 0.75 },
          uZoneColor: { value: new THREE.Color('#00e5ff') },
        },
      ]),
      vertexShader: ROAD_VERTEX_SHADER,
      fragmentShader: DECK_FRAGMENT_SHADER,
    });

    const edgeCore = new THREE.ShaderMaterial({
      fog: true,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uRoadProfile: { value: profileUniforms },
          uZoneColor: { value: new THREE.Color('#00e5ff') },
          uGlowMult: { value: 2.1 },
          uFlash: { value: 0 },
        },
      ]),
      vertexShader: ROAD_VERTEX_SHADER,
      fragmentShader: EDGE_CORE_FRAGMENT_SHADER,
    });

    const edgeHalo = new THREE.ShaderMaterial({
      fog: true,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uRoadProfile: { value: profileUniforms },
          uZoneColor: { value: new THREE.Color('#00e5ff') },
          uFlash: { value: 0 },
        },
      ]),
      vertexShader: ROAD_VERTEX_SHADER,
      fragmentShader: EDGE_HALO_FRAGMENT_SHADER,
    });

    const centerGlow = new THREE.ShaderMaterial({
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uRoadProfile: { value: profileUniforms },
          uCenterColor: { value: new THREE.Color('#ff2a9d') },
          uOpacity: { value: 0.28 },
          uScrollOffset: { value: 0 },
        },
      ]),
      vertexShader: ROAD_VERTEX_SHADER,
      fragmentShader: CENTER_GLOW_FRAGMENT_SHADER,
    });

    // Ensure all 4 materials reference the exact same live profileUniforms array
    deck.uniforms.uRoadProfile.value = profileUniforms;
    edgeCore.uniforms.uRoadProfile.value = profileUniforms;
    edgeHalo.uniforms.uRoadProfile.value = profileUniforms;
    centerGlow.uniforms.uRoadProfile.value = profileUniforms;

    return { deck, edgeCore, edgeHalo, centerGlow };
  }, [profileUniforms, roadTexture]);

  useEffect(() => {
    materials.deck.uniforms.uWetness.value = quality === 'low' ? 0.28 : 0.78;
  }, [quality, materials]);

  useEffect(() => {
    return () => {
      roadTexture.dispose();
      materials.deck.dispose();
      materials.edgeCore.dispose();
      materials.edgeHalo.dispose();
      materials.centerGlow.dispose();
      geometries.deck.dispose();
      geometries.centerGlow.dispose();
      geometries.edgeCore.dispose();
      geometries.edgeHalo.dispose();
    };
  }, [roadTexture, materials, geometries]);

  useFrame((_, delta) => {
    const dt = Math.min(0.1, delta);
    const rt = runtimeRef.current;

    // Cross-fade zone color smoothly over ~1 second
    _targetColor.set(zoneHex);
    const blend = 1 - Math.exp(-3.2 * dt);
    _currentColor.lerp(_targetColor, blend);

    // Update GPU scroll uniform (no texture mutation, no CPU vertex loop!)
    const scrollOffset = computeForwardScrollOffset(rt.distance, ROAD_REPEAT_Y, ROAD_Z_SPAN);

    // Pack the 57 road centerline/elevation samples into the shared GPU uniform array once per frame
    packRoadProfileUniforms(rt, profileUniforms);

    materials.deck.uniforms.uScrollOffset.value = scrollOffset;
    (materials.deck.uniforms.uZoneColor.value as THREE.Color).copy(_currentColor);

    (materials.edgeCore.uniforms.uZoneColor.value as THREE.Color).copy(_currentColor);
    materials.edgeCore.uniforms.uFlash.value = rt.edgeFlash;

    (materials.edgeHalo.uniforms.uZoneColor.value as THREE.Color).copy(_currentColor);
    materials.edgeHalo.uniforms.uFlash.value = rt.edgeFlash;

    _centerColor.set(
      sceneryTheme === 'cloud-horizon' || sceneryTheme === 'causeway-embankment'
        ? '#00d8ff'
        : '#ff2a9d'
    );
    (materials.centerGlow.uniforms.uCenterColor.value as THREE.Color).copy(_centerColor);
    materials.centerGlow.uniforms.uOpacity.value = 0.26 + rt.pedalPulse * 0.16;
    materials.centerGlow.uniforms.uScrollOffset.value = scrollOffset;
  });

  return (
    <group>
      {/* Glossy GPU-bent wet-look road deck */}
      <mesh geometry={geometries.deck} material={materials.deck} frustumCulled={false} />

      {/* Soft pulsing center lane glow */}
      <mesh geometry={geometries.centerGlow} material={materials.centerGlow} frustumCulled={false} />

      {/* Soft additive outer edge glow halo (visible even when Bloom is OFF) */}
      <mesh geometry={geometries.edgeHalo} material={materials.edgeHalo} frustumCulled={false} />

      {/* Bright white-hot core neon edge ribbons (outer + parallel inner in 1 draw call) */}
      <mesh geometry={geometries.edgeCore} material={materials.edgeCore} frustumCulled={false} />
    </group>
  );
}
