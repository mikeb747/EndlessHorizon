import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { WorldRuntimeState } from './roadMath';

interface HoloDataCardsProps {
  visible: boolean;
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
}

type HoloMetricKind = 'cadence' | 'speed' | 'ftpPct' | 'target';

interface SingleCardProps {
  position: [number, number, number];
  rotationY: number;
  label: string;
  unit: string;
  metric: HoloMetricKind;
  borderHex: string;
  valueHex: string;
  useZoneColor?: boolean;
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

function formatMetricValue(rt: WorldRuntimeState, metric: HoloMetricKind): string {
  switch (metric) {
    case 'cadence':
      return String(Math.round(rt.liveCadence));
    case 'speed':
      return rt.liveSpeedKmh.toFixed(1);
    case 'ftpPct':
      return `${Math.round(rt.liveFtpPct)}%`;
    case 'target':
      return String(Math.round(rt.liveTargetWatts));
  }
}

function HoloCardPlane({
  position,
  rotationY,
  label,
  unit,
  metric,
  borderHex,
  valueHex,
  useZoneColor = false,
  phaseOffset,
  runtimeRef,
}: SingleCardProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const lastDrawKeyRef = useRef<string>('');
  const syncAccumRef = useRef(0.25);

  const { ctx, texture } = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 160;
    const context = c.getContext('2d');
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { ctx: context, texture: t };
  }, []);

  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((state, delta) => {
    const rt = runtimeRef.current;
    if (meshRef.current) {
      const t = state.clock.elapsedTime;
      meshRef.current.position.y = position[1] + Math.sin(t * 1.8 + phaseOffset) * 0.045;
      meshRef.current.rotation.y = rotationY + rt.leanAngle * 0.35;
    }

    // Throttle holographic texture redraws to ~4 Hz and skip if displayed string is unchanged
    syncAccumRef.current += Math.min(0.1, delta);
    if (syncAccumRef.current < 0.25 || !ctx) return;
    syncAccumRef.current = 0;

    const val = formatMetricValue(rt, metric);
    const activeBorder = useZoneColor ? rt.liveZoneHex : borderHex;
    const activeValue = useZoneColor ? rt.liveZoneHex : valueHex;
    const drawKey = `${val}|${activeBorder}`;
    if (drawKey !== lastDrawKeyRef.current) {
      lastDrawKeyRef.current = drawKey;
      drawHoloCardCanvas(ctx, label, val, unit, activeBorder, activeValue);
      texture.needsUpdate = true;
    }
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
 * Reads live telemetry directly from runtimeRef inside useFrame so the 3D scene never
 * re-renders on incoming BLE packets.
 */
export function HoloDataCards({ visible, runtimeRef }: HoloDataCardsProps) {
  if (!visible) return null;

  return (
    <group>
      <HoloCardPlane
        position={[-1.78, 1.72, -0.3]}
        rotationY={0.28}
        label="CADENCE"
        unit="RPM"
        metric="cadence"
        borderHex="#00f0ff"
        valueHex="#7cf8ff"
        phaseOffset={0}
        runtimeRef={runtimeRef}
      />
      <HoloCardPlane
        position={[-1.85, 1.02, -0.15]}
        rotationY={0.28}
        label="SPEED"
        unit="KM/H"
        metric="speed"
        borderHex="#ff2a9d"
        valueHex="#ff85c8"
        phaseOffset={1.3}
        runtimeRef={runtimeRef}
      />
      <HoloCardPlane
        position={[1.78, 1.72, -0.3]}
        rotationY={-0.28}
        label="% FTP"
        unit="EFFORT"
        metric="ftpPct"
        borderHex="#00f0ff"
        valueHex="#00f0ff"
        useZoneColor
        phaseOffset={2.1}
        runtimeRef={runtimeRef}
      />
      <HoloCardPlane
        position={[1.85, 1.02, -0.15]}
        rotationY={-0.28}
        label="TARGET"
        unit="W"
        metric="target"
        borderHex="#00f0ff"
        valueHex="#ffffff"
        phaseOffset={3.4}
        runtimeRef={runtimeRef}
      />
    </group>
  );
}
