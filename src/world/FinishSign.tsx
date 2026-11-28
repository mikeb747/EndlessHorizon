import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { formatClock } from '../core/zones';
import {
  REF_ROAD_SPEED_MPS,
  ROAD_WIDTH,
  RoadSample,
  sampleRoadAtZ,
  WorldRuntimeState,
} from './roadMath';

interface FinishSignProps {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  totalDurationSec: number;
  estimatedTss: number;
}

const _sample: RoadSample = { x: 0, y: 0, slopeX: 0, slopeY: 0 };

/**
 * 7-segment LED bitmask for digits 0–9 and '-' (segments: A top, B top-right,
 * C bot-right, D bottom, E bot-left, F top-left, G middle).
 */
const SEVEN_SEG_MAP: Record<string, number[]> = {
  '0': [1, 1, 1, 1, 1, 1, 0],
  '1': [0, 1, 1, 0, 0, 0, 0],
  '2': [1, 1, 0, 1, 1, 0, 1],
  '3': [1, 1, 1, 1, 0, 0, 1],
  '4': [0, 1, 1, 0, 0, 1, 1],
  '5': [1, 0, 1, 1, 0, 1, 1],
  '6': [1, 0, 1, 1, 1, 1, 1],
  '7': [1, 1, 1, 0, 0, 0, 0],
  '8': [1, 1, 1, 1, 1, 1, 1],
  '9': [1, 1, 1, 1, 0, 1, 1],
  '-': [0, 0, 0, 0, 0, 0, 1],
};

function drawHexSegment(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  horizontal: boolean
): void {
  const bevel = Math.min(w, h) * 0.45;
  ctx.beginPath();
  if (horizontal) {
    ctx.moveTo(x + bevel, y);
    ctx.lineTo(x + w - bevel, y);
    ctx.lineTo(x + w, y + h * 0.5);
    ctx.lineTo(x + w - bevel, y + h);
    ctx.lineTo(x + bevel, y + h);
    ctx.lineTo(x, y + h * 0.5);
  } else {
    ctx.moveTo(x + w * 0.5, y);
    ctx.lineTo(x + w, y + bevel);
    ctx.lineTo(x + w, y + h - bevel);
    ctx.lineTo(x + w * 0.5, y + h);
    ctx.lineTo(x, y + h - bevel);
    ctx.lineTo(x, y + bevel);
  }
  ctx.closePath();
  ctx.fill();
}

function drawSevenSegmentDigit(
  ctx: CanvasRenderingContext2D,
  char: string,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const mask = SEVEN_SEG_MAP[char] ?? SEVEN_SEG_MAP['0'];
  const t = Math.max(10, w * 0.17); // segment thickness
  const gap = 4;
  const halfH = h * 0.5;

  const segments: Array<{ sx: number; sy: number; sw: number; sh: number; horiz: boolean }> = [
    // A: top
    { sx: x + t * 0.55, sy: y, sw: w - t * 1.1, sh: t, horiz: true },
    // B: top-right
    { sx: x + w - t, sy: y + t * 0.55, sw: t, sh: halfH - t * 0.75 - gap, horiz: false },
    // C: bottom-right
    { sx: x + w - t, sy: y + halfH + gap, sw: t, sh: halfH - t * 0.75 - gap, horiz: false },
    // D: bottom
    { sx: x + t * 0.55, sy: y + h - t, sw: w - t * 1.1, sh: t, horiz: true },
    // E: bottom-left
    { sx: x, sy: y + halfH + gap, sw: t, sh: halfH - t * 0.75 - gap, horiz: false },
    // F: top-left
    { sx: x, sy: y + t * 0.55, sw: t, sh: halfH - t * 0.75 - gap, horiz: false },
    // G: middle
    { sx: x + t * 0.55, sy: y + halfH - t * 0.5, sw: w - t * 1.1, sh: t, horiz: true },
  ];

  // Pass 1: Faint unlit ghost "8" segments (matching retro arcade LED aesthetic)
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(116, 36, 128, 0.36)';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    drawHexSegment(ctx, seg.sx, seg.sy, seg.sw, seg.sh, seg.horiz);
  }

  // Pass 2: Bright glowing cyan-white active LED segments
  ctx.shadowColor = '#1ae8ff';
  ctx.shadowBlur = 22;
  ctx.fillStyle = '#92f7ff';
  for (let i = 0; i < segments.length; i++) {
    if (!mask[i]) continue;
    const seg = segments[i];
    drawHexSegment(ctx, seg.sx, seg.sy, seg.sw, seg.sh, seg.horiz);
  }

  // Inner hot-white core highlight
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#e8feff';
  for (let i = 0; i < segments.length; i++) {
    if (!mask[i]) continue;
    const seg = segments[i];
    const inset = 3;
    drawHexSegment(
      ctx,
      seg.sx + inset,
      seg.sy + inset,
      Math.max(4, seg.sw - inset * 2),
      Math.max(4, seg.sh - inset * 2),
      seg.horiz
    );
  }
  ctx.restore();
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Render the retro synthwave floating overhead Finish Sign onto a 1024×584 canvas:
 * - Dark obsidian rounded display housing
 * - Cyan-to-magenta glowing neon perimeter border
 * - Top row: "FINISH LINE:" (neon magenta) + total workout duration / TSS (neon cyan)
 * - Horizontal cyan neon divider
 * - Center hero: 4 huge retro 7-segment glowing LED digits (with ghost unlit segments)
 *   showing live final countdown MM.SS (00.12 -> 00.00)
 * - Horizontal cyan neon divider
 * - Bottom row: "RIDER 1:" (neon magenta) + "FINAL SPRINT" / "COMPLETE" (neon cyan)
 */
function renderFinishSignCanvas(
  canvas: HTMLCanvasElement,
  remainingSec: number,
  totalDurationSec: number,
  estimatedTss: number,
  crossed: boolean
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const pad = 26;
  const bw = W - pad * 2;
  const bh = H - pad * 2;
  const radius = 26;

  // Translucent dark obsidian synthwave housing
  drawRoundedRectPath(ctx, pad, pad, bw, bh, radius);
  const bgGrad = ctx.createLinearGradient(0, pad, 0, H - pad);
  bgGrad.addColorStop(0, 'rgba(13, 10, 34, 0.94)');
  bgGrad.addColorStop(0.5, 'rgba(10, 8, 28, 0.96)');
  bgGrad.addColorStop(1, 'rgba(18, 9, 36, 0.95)');
  ctx.fillStyle = bgGrad;
  ctx.fill();

  // Subtle horizontal retro CRT scanlines inside the panel
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(0, 230, 255, 0.035)';
  for (let sy = pad; sy < H - pad; sy += 6) {
    ctx.fillRect(pad, sy, bw, 2);
  }
  ctx.restore();

  // Outer cyan -> magenta glowing neon perimeter border
  const borderGrad = ctx.createLinearGradient(0, pad, 0, H - pad);
  borderGrad.addColorStop(0, '#5ef2ff');
  borderGrad.addColorStop(0.55, '#42b8ff');
  borderGrad.addColorStop(1, '#ff54dc');

  ctx.save();
  drawRoundedRectPath(ctx, pad, pad, bw, bh, radius);
  ctx.strokeStyle = borderGrad;
  ctx.lineWidth = 10;
  ctx.shadowColor = crossed ? '#ff3ad4' : '#35e8ff';
  ctx.shadowBlur = 24;
  ctx.stroke();

  // Crisp bright inner core stroke
  drawRoundedRectPath(ctx, pad, pad, bw, bh, radius);
  ctx.strokeStyle = '#d8fbff';
  ctx.lineWidth = 2.5;
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.restore();

  // Top row: FINISH LINE: <duration / TSS>
  const topY = 114;
  ctx.save();
  ctx.font = '800 54px Orbitron, monospace';
  ctx.textBaseline = 'middle';

  const leftTopText = 'FINISH LINE: ';
  const rightTopText = crossed ? `${estimatedTss} TSS` : formatClock(totalDurationSec);
  const leftW = ctx.measureText(leftTopText).width;
  const rightW = ctx.measureText(rightTopText).width;
  const startTopX = (W - (leftW + rightW)) * 0.5;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#ff54cc';
  ctx.shadowColor = '#ff2ab8';
  ctx.shadowBlur = 16;
  ctx.fillText(leftTopText, startTopX, topY);

  ctx.fillStyle = '#6cf3ff';
  ctx.shadowColor = '#00d9ff';
  ctx.shadowBlur = 16;
  ctx.fillText(rightTopText, startTopX + leftW, topY);
  ctx.restore();

  // Top glowing horizontal rule
  const drawRule = (ry: number) => {
    ctx.save();
    ctx.strokeStyle = '#59eeff';
    ctx.lineWidth = 5;
    ctx.shadowColor = '#00d8ff';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(pad + 42, ry);
    ctx.lineTo(W - pad - 42, ry);
    ctx.stroke();
    ctx.restore();
  };

  drawRule(160);

  // Center Hero 4-Digit Retro 7-Segment LED Readout (MM.SS countdown -> 00.00)
  const clampedRem = Math.max(0, Math.ceil(remainingSec));
  const mins = Math.floor(clampedRem / 60);
  const secs = clampedRem % 60;
  const digits = [
    String(Math.floor(mins / 10) % 10),
    String(mins % 10),
    String(Math.floor(secs / 10)),
    String(secs % 10),
  ];

  const digitW = 136;
  const digitH = 204;
  const digitGap = 54;
  const totalDigitsW = digitW * 4 + digitGap * 3;
  const startDigitX = (W - totalDigitsW) * 0.5;
  const digitY = 190;

  for (let i = 0; i < 4; i++) {
    const dx = startDigitX + i * (digitW + digitGap);
    drawSevenSegmentDigit(ctx, digits[i], dx, digitY, digitW, digitH);

    // Retro glowing decimal/separator dot between segments (echoing 1.9.8.4)
    if (i < 3) {
      const dotX = dx + digitW + digitGap * 0.5;
      ctx.save();
      if (i === 1) {
        // Double colon for MM:SS
        ctx.fillStyle = '#8ef7ff';
        ctx.shadowColor = '#00e5ff';
        ctx.shadowBlur = 16;
        ctx.fillRect(dotX - 7, digitY + digitH * 0.3, 14, 14);
        ctx.fillRect(dotX - 7, digitY + digitH * 0.66, 14, 14);
      } else {
        // Subtle lower-corner ghost/accent dot
        ctx.fillStyle = 'rgba(130, 80, 175, 0.55)';
        ctx.fillRect(dotX - 5, digitY + digitH - 14, 10, 10);
      }
      ctx.restore();
    }
  }

  // Bottom glowing horizontal rule
  drawRule(424);

  // Bottom row: RIDER 1: FINISH / COMPLETE (echoing PLAYER 1: ACTIVE)
  const botY = 478;
  ctx.save();
  ctx.font = '800 54px Orbitron, monospace';
  ctx.textBaseline = 'middle';

  const leftBotText = 'RIDER 1: ';
  const rightBotText = crossed ? 'COMPLETE' : 'FINISH';
  const lbW = ctx.measureText(leftBotText).width;
  const rbW = ctx.measureText(rightBotText).width;
  const startBotX = (W - (lbW + rbW)) * 0.5;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#ff54cc';
  ctx.shadowColor = '#ff2ab8';
  ctx.shadowBlur = 16;
  ctx.fillText(leftBotText, startBotX, botY);

  ctx.fillStyle = crossed ? '#7affc9' : '#6cf3ff';
  ctx.shadowColor = crossed ? '#00ffaa' : '#00d9ff';
  ctx.shadowBlur = 18;
  ctx.fillText(rightBotText, startBotX + lbW, botY);
  ctx.restore();
}

function createFinishStripTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#09061a';
  ctx.fillRect(0, 0, 512, 128);

  const cols = 16;
  const rows = 4;
  const cw = 512 / cols;
  const ch = 128 / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lit = (r + c) % 2 === 0;
      ctx.fillStyle = lit ? (r < 2 ? '#59f3ff' : '#ff4dd4') : '#120b2c';
      ctx.fillRect(c * cw + 2, r * ch + 2, cw - 4, ch - 4);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Floating retro-arcade synthwave Finish Sign hovering above the neon road
 * that approaches over the final ~18 seconds of a workout and glides cleanly
 * overhead as the cyclist crosses the glowing finish threshold.
 */
export function FinishSign({ runtimeRef, totalDurationSec, estimatedTss }: FinishSignProps) {
  const groupRef = useRef<THREE.Group>(null);
  const signPanelRef = useRef<THREE.Group>(null);

  const { signCanvas, signTex, stripTex } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 584;
    renderFinishSignCanvas(canvas, 10, totalDurationSec, estimatedTss, false);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return {
      signCanvas: canvas,
      signTex: tex,
      stripTex: createFinishStripTexture(),
    };
  }, [totalDurationSec, estimatedTss]);

  const lastRenderedKeyRef = useRef<string>('');

  useEffect(() => {
    return () => {
      signTex.dispose();
      stripTex.dispose();
    };
  }, [signTex, stripTex]);

  useFrame((state) => {
    const group = groupRef.current;
    if (!group) return;

    const rt = runtimeRef.current;
    const duration = rt.workoutDurationSec || totalDurationSec;
    if (duration <= 0) {
      group.visible = false;
      return;
    }

    const remainingSec = Math.max(0, duration - rt.workoutElapsedSec);
    // Position along road: negative Z is ahead, positive Z is behind cyclist/camera
    const finishZ = -remainingSec * REF_ROAD_SPEED_MPS + rt.finishPassDist;

    // Show sign once within 255m ahead until it clears behind the camera (+14m)
    const isVisible = finishZ > -255 && finishZ < 14;
    group.visible = isVisible;
    if (!isVisible) return;

    // Anchor on the exact road spline curve & elevation at finishZ
    sampleRoadAtZ(rt.distance, finishZ, _sample, rt.elevationProfile, rt.workoutElapsedSec);
    group.position.set(_sample.x, _sample.y, finishZ);
    group.rotation.set(0, -Math.atan(_sample.slopeX) * 0.75, 0);

    // Subtle floating hover bob for the overhead billboard
    if (signPanelRef.current) {
      signPanelRef.current.position.y = 5.45 + Math.sin(state.clock.elapsedTime * 2.1) * 0.14;
    }

    // Re-render 7-segment display only when integer countdown second or crossed state changes
    const crossed = remainingSec <= 0.05;
    const displaySec = Math.max(0, Math.ceil(remainingSec));
    const displayTss = Math.round(rt.liveTss) || estimatedTss;
    const key = `${displaySec}:${crossed ? 1 : 0}:${displayTss}`;
    if (key !== lastRenderedKeyRef.current) {
      lastRenderedKeyRef.current = key;
      renderFinishSignCanvas(signCanvas, displaySec, duration, displayTss, crossed);
      signTex.needsUpdate = true;
    }
  });

  return (
    <group ref={groupRef} visible={false}>
      {/* Glowing neon checkered Finish Line threshold flush across the road deck */}
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[ROAD_WIDTH, 1.45]} />
        <meshBasicMaterial
          map={stripTex}
          transparent
          opacity={0.94}
          toneMapped={false}
        />
      </mesh>

      {/* Faint holographic vertical light guide rails on far left & right road curbs */}
      <mesh position={[-ROAD_WIDTH * 0.5 - 0.15, 1.5, 0]}>
        <boxGeometry args={[0.07, 3.0, 0.07]} />
        <meshBasicMaterial
          color="#3be8ff"
          transparent
          opacity={0.35}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh position={[ROAD_WIDTH * 0.5 + 0.15, 1.5, 0]}>
        <boxGeometry args={[0.07, 3.0, 0.07]} />
        <meshBasicMaterial
          color="#ff48c4"
          transparent
          opacity={0.35}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Floating Synthwave Arcade Finish Billboard */}
      <group ref={signPanelRef} position={[0, 5.45, 0]}>
        {/* Slim dark housing depth backing */}
        <mesh position={[0, 0, -0.16]}>
          <boxGeometry args={[9.9, 5.64, 0.22]} />
          <meshStandardMaterial
            color="#0b0820"
            emissive="#1c0f40"
            emissiveIntensity={0.6}
            roughness={0.35}
            metalness={0.7}
          />
        </mesh>

        {/* Emissive top cyan & bottom magenta neon rim strips for Bloom punch */}
        <mesh position={[0, 2.84, -0.06]}>
          <boxGeometry args={[9.75, 0.11, 0.12]} />
          <meshStandardMaterial
            color="#5ef2ff"
            emissive="#5ef2ff"
            emissiveIntensity={2.5}
            toneMapped={false}
          />
        </mesh>
        <mesh position={[0, -2.84, -0.06]}>
          <boxGeometry args={[9.75, 0.11, 0.12]} />
          <meshStandardMaterial
            color="#ff4dd8"
            emissive="#ff4dd8"
            emissiveIntensity={2.5}
            toneMapped={false}
          />
        </mesh>

        {/* Front-facing retro 7-segment LED display plane */}
        <mesh position={[0, 0, 0.02]}>
          <planeGeometry args={[10.2, 5.82]} />
          <meshBasicMaterial
            map={signTex}
            transparent
            toneMapped={false}
          />
        </mesh>

        {/* Rear face so the sign stays solid as it glides past overhead */}
        <mesh position={[0, 0, -0.28]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[10.2, 5.82]} />
          <meshBasicMaterial
            map={signTex}
            transparent
            opacity={0.72}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}
