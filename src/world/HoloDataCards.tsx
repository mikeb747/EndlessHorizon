import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { WorldRuntimeState } from './roadMath';

interface HoloDataCardsProps {
  visible: boolean;
  cadence: number;
  speedKmh: number;
  ftpPct: number;
  targetWatts: number;
  zoneHex: string;
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
}

interface SingleCardProps {
  position: [number, number, number];
  rotationY: number;
  label: string;
  value: string;
  unit: string;
  borderHex: string;
  valueHex: string;
  phaseOffset: number;
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
}

function drawHoloCardCanvas(
  ctx: CanvasRenderingContext2D,
  label: string,
  value: string,
  unit: string,
  borderHex: string,
  valueHex: string
): void {
  const w = 320;
  const h = 160;
  ctx.clearRect(0, 0, w, h);

  // Translucent dark obsidian holographic glass backing
  ctx.fillStyle = 'rgba(8, 7, 24, 0.72)';
  ctx.beginPath();
  ctx.roundRect(8, 8, w - 16, h - 16, 14);
  ctx.fill();

  // Subtle scanline texture
  ctx.fillStyle = 'rgba(0, 240, 255, 0.04)';
  for (let y = 14; y < h - 14; y += 6) {
    ctx.fillRect(12, y, w - 24, 2);
  }

  // Crisp glowing neon border
  ctx.strokeStyle = borderHex;
  ctx.lineWidth = 4;
  ctx.shadowColor = borderHex;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(8, 8, w - 16, h - 16, 14);
  ctx.stroke();

  // Small uppercase header label
  ctx.shadowBlur = 4;
  ctx.fillStyle = 'rgba(210, 232, 255, 0.85)';
  ctx.font = '700 22px Rajdhani, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(label, 26, 44);

  // Large glowing Orbitron numeric value
  ctx.shadowColor = valueHex;
  ctx.shadowBlur = 14;
  ctx.fillStyle = valueHex;
  ctx.font = '800 62px Orbitron, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(value, 24, 118);

  // Unit suffix bottom-right
  ctx.shadowBlur = 4;
  ctx.fillStyle = 'rgba(180, 210, 245, 0.85)';
  ctx.font = '700 24px Rajdhani, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(unit, w - 24, 118);
  ctx.shadowBlur = 0;
}

function HoloCardPlane({
  position,
  rotationY,
  label,
  value,
  unit,
  borderHex,
  valueHex,
  phaseOffset,
  runtimeRef,
}: SingleCardProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  const { canvas, texture } = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 160;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { canvas: c, texture: t };
  }, []);

  useEffect(() => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawHoloCardCanvas(ctx, label, value, unit, borderHex, valueHex);
    texture.needsUpdate = true;
  }, [canvas, texture, label, value, unit, borderHex, valueHex]);

  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;
    meshRef.current.position.y = position[1] + Math.sin(t * 1.8 + phaseOffset) * 0.045;
    meshRef.current.rotation.y = rotationY + runtimeRef.current.leanAngle * 0.35;
  });

  return (
    <mesh ref={meshRef} position={position} rotation={[0, rotationY, 0]}>
      <planeGeometry args={[1.18, 0.59]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={0.92}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * Translucent neon holographic data cards floating in 3D space flanking the cyclist.
 * Shows CADENCE, SPEED, % FTP, and TARGET with uppercase labels & glowing numbers.
 */
export function HoloDataCards({
  visible,
  cadence,
  speedKmh,
  ftpPct,
  targetWatts,
  zoneHex,
  runtimeRef,
}: HoloDataCardsProps) {
  if (!visible) return null;

  return (
    <group>
      <HoloCardPlane
        position={[-1.78, 1.72, -0.3]}
        rotationY={0.28}
        label="CADENCE"
        value={String(Math.round(cadence))}
        unit="RPM"
        borderHex="#00f0ff"
        valueHex="#7cf8ff"
        phaseOffset={0}
        runtimeRef={runtimeRef}
      />
      <HoloCardPlane
        position={[-1.85, 1.02, -0.15]}
        rotationY={0.28}
        label="SPEED"
        value={speedKmh.toFixed(1)}
        unit="KM/H"
        borderHex="#ff2a9d"
        valueHex="#ff85c8"
        phaseOffset={1.3}
        runtimeRef={runtimeRef}
      />
      <HoloCardPlane
        position={[1.78, 1.72, -0.3]}
        rotationY={-0.28}
        label="% FTP"
        value={`${Math.round(ftpPct)}%`}
        unit="EFFORT"
        borderHex={zoneHex}
        valueHex={zoneHex}
        phaseOffset={2.1}
        runtimeRef={runtimeRef}
      />
      <HoloCardPlane
        position={[1.85, 1.02, -0.15]}
        rotationY={-0.28}
        label="TARGET"
        value={String(Math.round(targetWatts))}
        unit="W"
        borderHex="#00f0ff"
        valueHex="#ffffff"
        phaseOffset={3.4}
        runtimeRef={runtimeRef}
      />
    </group>
  );
}
