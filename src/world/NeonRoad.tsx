import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { QualityLevel, SceneryTheme } from '../store/useAppStore';
import {
  computeForwardScrollOffset,
  computeLinearRoadT,
  computeRoadSegmentZ,
  ROAD_HALF_WIDTH,
  ROAD_SEGMENTS,
  ROAD_Z_FAR,
  ROAD_Z_NEAR,
  ROAD_Z_SPAN,
  RoadSample,
  sampleRoadAtZ,
  WorldRuntimeState,
} from './roadMath';

interface NeonRoadProps {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  zoneHex: string;
  sceneryTheme: SceneryTheme;
  quality: QualityLevel;
}

const SEGMENTS = ROAD_SEGMENTS;
const ROAD_REPEAT_Y = 36;

// Precomputed non-linear LOD Z coordinates and linear UV-t values (allocated once)
const SEGMENT_Z = new Float32Array(SEGMENTS + 1);
const SEGMENT_LINEAR_T = new Float32Array(SEGMENTS + 1);
for (let i = 0; i <= SEGMENTS; i++) {
  const z = computeRoadSegmentZ(i, SEGMENTS, ROAD_Z_NEAR, ROAD_Z_FAR);
  SEGMENT_Z[i] = z;
  SEGMENT_LINEAR_T[i] = computeLinearRoadT(z, ROAD_Z_NEAR, ROAD_Z_FAR);
}

// Reusable per-frame road centerline cache so all 6 strips share 1 spline sampling pass (6x fewer spline calls!)
const _sample: RoadSample = { x: 0, y: 0, slopeX: 0, slopeY: 0 };
const _centerX = new Float32Array(SEGMENTS + 1);
const _centerY = new Float32Array(SEGMENTS + 1);
const _targetColor = new THREE.Color();
const _currentColor = new THREE.Color('#00e5ff');
const _centerColor = new THREE.Color('#ff2a9d');

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
  ctx.strokeStyle = 'rgba(140, 95, 255, 0.26)';
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
  ctx.strokeStyle = 'rgba(0, 220, 255, 0.22)';
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
  tex.repeat.set(1, ROAD_REPEAT_Y);
  tex.anisotropy = Math.min(8, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

function buildStripGeometry(segments: number, withNormals: boolean): THREE.BufferGeometry {
  const vertexCount = (segments + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const linearT = SEGMENT_LINEAR_T[i];
    uvs[i * 4 + 0] = 0;
    uvs[i * 4 + 1] = linearT;
    uvs[i * 4 + 2] = 1;
    uvs[i * 4 + 3] = linearT;

    if (i < segments) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      // Counter-clockwise when viewed from +Y above (a=left-near, b=right-near, c=left-far, d=right-far)
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  if (withNormals) {
    geo.computeVertexNormals();
  }
  return geo;
}

function updateStripFromCenterCache(
  geo: THREE.BufferGeometry,
  offsetLeft: number,
  offsetRight: number,
  yLift: number,
  recomputeNormals: boolean
): void {
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;

  for (let i = 0; i <= SEGMENTS; i++) {
    const cx = _centerX[i];
    const cy = _centerY[i] + yLift;
    const z = SEGMENT_Z[i];
    const idx = i * 6;
    arr[idx + 0] = cx + offsetLeft;
    arr[idx + 1] = cy;
    arr[idx + 2] = z;

    arr[idx + 3] = cx + offsetRight;
    arr[idx + 4] = cy;
    arr[idx + 5] = z;
  }

  posAttr.needsUpdate = true;
  if (recomputeNormals) {
    geo.computeVertexNormals();
  }
}

export function NeonRoad({ runtimeRef, zoneHex, sceneryTheme, quality }: NeonRoadProps) {
  const gl = useThree((s) => s.gl);

  const roadTexture = useMemo(
    () => createRoadSurfaceTexture(gl.capabilities.getMaxAnisotropy()),
    [gl]
  );

  // Geometries allocated once and updated in-place each frame
  const geometries = useMemo(() => {
    return {
      deck: buildStripGeometry(SEGMENTS, true),
      centerGlow: buildStripGeometry(SEGMENTS, false),
      outerLeft: buildStripGeometry(SEGMENTS, false),
      outerRight: buildStripGeometry(SEGMENTS, false),
      innerLeft: buildStripGeometry(SEGMENTS, false),
      innerRight: buildStripGeometry(SEGMENTS, false),
    };
  }, []);

  // Lightweight unlit HDR MeshBasicMaterial with polygonOffset prevents Z-fighting at 265m
  // and avoids PBR fragment cost on emissive neon strips for stable 60 fps.
  const { outerEdgeMaterial, innerEdgeMaterial } = useMemo(() => {
    const outer = new THREE.MeshBasicMaterial({
      color: '#00e5ff',
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const inner = new THREE.MeshBasicMaterial({
      color: '#00e5ff',
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    return { outerEdgeMaterial: outer, innerEdgeMaterial: inner };
  }, []);

  const centerGlowMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useEffect(() => {
    return () => {
      roadTexture.dispose();
      outerEdgeMaterial.dispose();
      innerEdgeMaterial.dispose();
      Object.values(geometries).forEach((g) => g.dispose());
    };
  }, [roadTexture, outerEdgeMaterial, innerEdgeMaterial, geometries]);

  useFrame((_, delta) => {
    const dt = Math.min(0.1, delta);
    const rt = runtimeRef.current;

    // Cross-fade zone color smoothly over ~1 second
    _targetColor.set(zoneHex);
    const blend = 1 - Math.exp(-3.2 * dt);
    _currentColor.lerp(_targetColor, blend);

    // Extra HDR luminance boost on interval start (drives selective Bloom cleanly)
    const flashBoost = rt.edgeFlash * 1.9;
    outerEdgeMaterial.color.copy(_currentColor).multiplyScalar(2.35 + flashBoost);
    innerEdgeMaterial.color.copy(_currentColor).multiplyScalar(1.6 + flashBoost * 0.7);

    if (centerGlowMatRef.current) {
      _centerColor.set(
        sceneryTheme === 'cloud-horizon' || sceneryTheme === 'causeway-embankment'
          ? '#00d8ff'
          : '#ff2a9d'
      );
      centerGlowMatRef.current.color.copy(_centerColor);
      centerGlowMatRef.current.opacity = 0.24 + rt.pedalPulse * 0.14;
    }

    // Scroll road surface texture UVs toward the camera (down the screen) at 1:1 physical speed
    roadTexture.offset.y = computeForwardScrollOffset(rt.distance, ROAD_REPEAT_Y, ROAD_Z_SPAN);

    // Sample road spline ONCE per segment and reuse across all 6 strips
    for (let i = 0; i <= SEGMENTS; i++) {
      sampleRoadAtZ(
        rt.distance,
        SEGMENT_Z[i],
        _sample,
        rt.elevationProfile,
        rt.workoutElapsedSec,
        rt.freeRideTerrain
      );
      _centerX[i] = _sample.x;
      _centerY[i] = _sample.y;
    }

    // Update road deck (only strip requiring vertex normals) and neon edge strips
    updateStripFromCenterCache(geometries.deck, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, 0, true);
    updateStripFromCenterCache(geometries.centerGlow, -0.42, 0.42, 0.025, false);

    // Thick outer neon edge bars (brightest element in the scene, lifted cleanly to avoid Z-fighting)
    updateStripFromCenterCache(
      geometries.outerLeft,
      -ROAD_HALF_WIDTH - 0.24,
      -ROAD_HALF_WIDTH + 0.14,
      0.055,
      false
    );
    updateStripFromCenterCache(
      geometries.outerRight,
      ROAD_HALF_WIDTH - 0.14,
      ROAD_HALF_WIDTH + 0.24,
      0.055,
      false
    );

    // Thinner parallel inner neon edge lines
    updateStripFromCenterCache(
      geometries.innerLeft,
      -ROAD_HALF_WIDTH + 0.48,
      -ROAD_HALF_WIDTH + 0.62,
      0.04,
      false
    );
    updateStripFromCenterCache(
      geometries.innerRight,
      ROAD_HALF_WIDTH - 0.62,
      ROAD_HALF_WIDTH - 0.48,
      0.04,
      false
    );
  });

  const roadRoughness = quality === 'low' ? 0.55 : 0.16;
  const roadMetalness = quality === 'low' ? 0.3 : 0.72;

  return (
    <group>
      {/* Glossy wet-look road deck */}
      <mesh geometry={geometries.deck} frustumCulled={false}>
        <meshStandardMaterial
          map={roadTexture}
          color="#ffffff"
          roughness={roadRoughness}
          metalness={roadMetalness}
          envMapIntensity={quality === 'low' ? 0.5 : 1.35}
        />
      </mesh>

      {/* Soft pink/cyan lane glow under the bike */}
      <mesh geometry={geometries.centerGlow} frustumCulled={false}>
        <meshBasicMaterial
          ref={centerGlowMatRef}
          color="#ff2a9d"
          transparent
          opacity={0.28}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Thick outer neon edge strips (zone-colored hero glow, shared material for symmetric color fade) */}
      <mesh geometry={geometries.outerLeft} material={outerEdgeMaterial} frustumCulled={false} />
      <mesh geometry={geometries.outerRight} material={outerEdgeMaterial} frustumCulled={false} />

      {/* Thinner second parallel inner edge lines */}
      <mesh geometry={geometries.innerLeft} material={innerEdgeMaterial} frustumCulled={false} />
      <mesh geometry={geometries.innerRight} material={innerEdgeMaterial} frustumCulled={false} />
    </group>
  );
}
