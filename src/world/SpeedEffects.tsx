import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { QualityLevel } from '../store/useAppStore';
import { isAabbInFrustum } from './frustumCuller';
import { computeSpeedStreakParams, WorldRuntimeState } from './roadMath';

interface SpeedEffectsProps {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  quality: QualityLevel;
}

const MAX_STREAKS = 84;
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

/**
 * Instanced cyan/magenta speed streaks radiating past the camera from the horizon vanishing point.
 * Completely hidden in Zone 1 & Zone 2; active in Zone 3+ and accelerates noticeably in higher zones.
 * Compacts only frustum-visible streaks into InstancedMesh.count so off-screen streaks incur zero GPU draw.
 */
export function SpeedEffects({ runtimeRef, quality }: SpeedEffectsProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const travelAccumRef = useRef(0);

  const seeds = useMemo(() => {
    return Array.from({ length: MAX_STREAKS }, (_, i) => {
      const angle = (i * 2.39996) % (Math.PI * 2);
      const radius = 3.2 + ((i * 1.37) % 6.2);
      const x = Math.cos(angle) * radius * 1.15;
      const y = Math.max(0.7, Math.abs(Math.sin(angle)) * radius * 0.85 + 0.8);
      const zOffset = (i * 13.7) % 95;
      const speedMul = 0.85 + ((i * 0.19) % 0.65);
      return { x, y, zOffset, speedMul, isMagenta: i % 5 === 0 };
    });
  }, []);

  useEffect(() => {
    if (!meshRef.current) return;
    for (let i = 0; i < MAX_STREAKS; i++) {
      _color.set(seeds[i].isMagenta ? '#ff4fb3' : '#00f0ff');
      meshRef.current.setColorAt(i, _color);
    }
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  }, [seeds]);

  useFrame((_, delta) => {
    if (!meshRef.current || !matRef.current) return;

    const dt = Math.min(0.1, delta);
    const rt = runtimeRef.current;
    const params = computeSpeedStreakParams(
      rt.zoneNumber,
      rt.speedMps,
      rt.intensityNorm,
      quality,
      MAX_STREAKS
    );

    if (!params.visible) {
      meshRef.current.visible = false;
      meshRef.current.count = 0;
      return;
    }

    meshRef.current.visible = true;
    matRef.current.opacity = params.opacity;
    travelAccumRef.current += dt * params.travelSpeed;

    const planes = rt.frustumPlanes;
    const useFrustum = rt.frustumReady;
    const halfLen = params.streakLength * 0.5;
    let visibleCount = 0;

    for (let i = 0; i < params.activeCount; i++) {
      const s = seeds[i];
      const travel = (s.zOffset + travelAccumRef.current * s.speedMul) % 95;
      const z = -82 + travel;

      // Skip streaks already behind the camera or outside the forward view frustum
      if (z - halfLen > rt.cameraZ) {
        rt.culledInstances += 1;
        continue;
      }
      if (useFrustum && !isAabbInFrustum(planes, s.x, s.y, z, 0.2, 0.2, halfLen + 0.2)) {
        rt.culledInstances += 1;
        continue;
      }

      _dummy.position.set(s.x, s.y, z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(0.024, 0.024, params.streakLength);
      _dummy.updateMatrix();
      meshRef.current.setMatrixAt(visibleCount, _dummy.matrix);
      _color.set(s.isMagenta ? '#ff4fb3' : '#00f0ff');
      meshRef.current.setColorAt(visibleCount, _color);
      visibleCount += 1;
    }

    rt.drawnInstances += visibleCount;
    meshRef.current.count = visibleCount;
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, MAX_STREAKS]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial
        ref={matRef}
        color="#ffffff"
        transparent
        opacity={0.45}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </instancedMesh>
  );
}
