import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { solveTwoBoneLegIK } from './cadenceMatcher';
import { WorldRuntimeState } from './roadMath';

const BB_Y = 0.38;
const BB_Z = 0.06;
const CRANK_RADIUS = 0.165;
const HIP_Y = 1.03;
const HIP_Z = 0.19;
const THIGH_LEN = 0.44;
const SHIN_LEN = 0.43;

interface NeonCyclistProps {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  zoneHex: string;
}

const _zoneColor = new THREE.Color('#00e5ff');
const _targetColor = new THREE.Color('#00e5ff');

function createCircuitRingTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);

  // Outer glowing circuit ring
  ctx.strokeStyle = '#00f0ff';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(cx, cy, 108, 0, Math.PI * 2);
  ctx.stroke();

  // Segmented inner arc traces
  ctx.strokeStyle = '#ff2a9d';
  ctx.lineWidth = 4;
  for (let i = 0; i < 6; i++) {
    const start = (i * Math.PI) / 3 + 0.12;
    const end = start + Math.PI / 3 - 0.24;
    ctx.beginPath();
    ctx.arc(cx, cy, 84, start, end);
    ctx.stroke();
  }

  // Radial circuit nodes
  ctx.strokeStyle = '#00f0ff';
  ctx.fillStyle = '#a5f3fc';
  ctx.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x1 = cx + Math.cos(a) * 86;
    const y1 = cy + Math.sin(a) * 86;
    const x2 = cx + Math.cos(a) * 106;
    const y2 = cy + Math.sin(a) * 106;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * 68, cy + Math.sin(a) * 68, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function NeonCyclist({ runtimeRef, zoneHex }: NeonCyclistProps) {
  const slopeGroupRef = useRef<THREE.Group>(null);
  const bikeGroupRef = useRef<THREE.Group>(null);
  const frontWheelRef = useRef<THREE.Group>(null);
  const rearWheelRef = useRef<THREE.Group>(null);
  const crankRef = useRef<THREE.Group>(null);
  const leftThighRef = useRef<THREE.Mesh>(null);
  const rightThighRef = useRef<THREE.Mesh>(null);
  const leftShinRef = useRef<THREE.Mesh>(null);
  const rightShinRef = useRef<THREE.Mesh>(null);
  const leftKneeRef = useRef<THREE.Mesh>(null);
  const rightKneeRef = useRef<THREE.Mesh>(null);
  const leftShoeRef = useRef<THREE.Mesh>(null);
  const rightShoeRef = useRef<THREE.Mesh>(null);

  const pulseRingRef = useRef<THREE.Mesh>(null);
  const burstRingRef = useRef<THREE.Mesh>(null);
  const burstMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const trailRef = useRef<THREE.Mesh>(null);
  const trailMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const circuitTex = useMemo(() => createCircuitRingTexture(), []);

  useEffect(() => {
    return () => {
      circuitTex.dispose();
    };
  }, [circuitTex]);

  useFrame((_, delta) => {
    const dt = Math.min(0.1, delta);
    const rt = runtimeRef.current;

    _targetColor.set(zoneHex);
    _zoneColor.lerp(_targetColor, 1 - Math.exp(-3.5 * dt));

    // Align cyclist + contact rings flush with climbing road pitch (0%..20% grade)
    if (slopeGroupRef.current) {
      slopeGroupRef.current.rotation.x = rt.pitchAngle;
    }

    // Lean bike into corners + subtle high-power pedaling sway gated by live pedalling RPM
    const activePedalScale = Math.min(1, rt.modelCadenceRpm / 45);
    if (bikeGroupRef.current) {
      const pedalRock =
        Math.sin(rt.cadenceRad) * (0.015 + rt.intensityNorm * 0.032) * activePedalScale;
      bikeGroupRef.current.rotation.z = rt.leanAngle + pedalRock;
      bikeGroupRef.current.position.y =
        0.02 + Math.abs(Math.sin(rt.cadenceRad)) * 0.012 * activePedalScale;
    }

    // Spin wheels and crankset proportionally to speed & exact Bluetooth cadence RPM
    if (frontWheelRef.current) {
      frontWheelRef.current.rotation.x = -rt.wheelRad;
    }
    if (rearWheelRef.current) {
      rearWheelRef.current.rotation.x = -rt.wheelRad;
    }
    if (crankRef.current) {
      crankRef.current.rotation.x = -rt.cadenceRad;
    }

    // Exact 2-bone analytical leg IK locked 1:1 to rotating left/right crank spindles
    // (crankRef.rotation.x = -theta maps top pedal (0, +R, 0) -> (0, R*cos(theta), -R*sin(theta)))
    const cL = rt.cadenceRad;
    const cR = rt.cadenceRad + Math.PI;
    const leftPedalY = BB_Y + CRANK_RADIUS * Math.cos(cL);
    const leftPedalZ = BB_Z - CRANK_RADIUS * Math.sin(cL);
    const rightPedalY = BB_Y + CRANK_RADIUS * Math.cos(cR);
    const rightPedalZ = BB_Z - CRANK_RADIUS * Math.sin(cR);

    const leftIK = solveTwoBoneLegIK(HIP_Y, HIP_Z, leftPedalY, leftPedalZ, THIGH_LEN, SHIN_LEN);
    const rightIK = solveTwoBoneLegIK(HIP_Y, HIP_Z, rightPedalY, rightPedalZ, THIGH_LEN, SHIN_LEN);

    if (leftThighRef.current && leftShinRef.current) {
      leftThighRef.current.position.set(-0.125, leftIK.thighMidY, leftIK.thighMidZ);
      leftThighRef.current.rotation.set(leftIK.thighRotX, 0, 0);
      leftShinRef.current.position.set(-0.135, leftIK.shinMidY, leftIK.shinMidZ);
      leftShinRef.current.rotation.set(leftIK.shinRotX, 0, 0);
    }
    if (leftKneeRef.current) {
      leftKneeRef.current.position.set(-0.13, leftIK.kneeY, leftIK.kneeZ);
    }
    if (leftShoeRef.current) {
      leftShoeRef.current.position.set(-0.14, leftPedalY + 0.032, leftPedalZ - 0.02);
      leftShoeRef.current.rotation.set(-0.14 + Math.sin(cL) * 0.14, 0, 0);
    }

    if (rightThighRef.current && rightShinRef.current) {
      rightThighRef.current.position.set(0.125, rightIK.thighMidY, rightIK.thighMidZ);
      rightThighRef.current.rotation.set(rightIK.thighRotX, 0, 0);
      rightShinRef.current.position.set(0.135, rightIK.shinMidY, rightIK.shinMidZ);
      rightShinRef.current.rotation.set(rightIK.shinRotX, 0, 0);
    }
    if (rightKneeRef.current) {
      rightKneeRef.current.position.set(0.13, rightIK.kneeY, rightIK.kneeZ);
    }
    if (rightShoeRef.current) {
      rightShoeRef.current.position.set(0.14, rightPedalY + 0.032, rightPedalZ - 0.02);
      rightShoeRef.current.rotation.set(-0.14 + Math.sin(cR) * 0.14, 0, 0);
    }

    // Circuit ring beneath the bike pulses with each pedal stroke
    if (pulseRingRef.current) {
      const s = 1.0 + rt.pedalPulse * 0.16;
      pulseRingRef.current.scale.set(s, s, 1);
      pulseRingRef.current.rotation.z += dt * (0.25 + rt.speedMps * 0.06);
    }

    // Interval start shockwave ring burst outward
    if (burstRingRef.current && burstMatRef.current) {
      if (rt.intervalBurst > 0.001) {
        burstRingRef.current.visible = true;
        const p = 1 - rt.intervalBurst; // 0 -> 1 expansion
        const scale = 1.0 + p * 6.5;
        burstRingRef.current.scale.set(scale, scale, 1);
        burstMatRef.current.color.copy(_zoneColor);
        burstMatRef.current.opacity = rt.intervalBurst * 0.85;
      } else {
        burstRingRef.current.visible = false;
      }
    }

    // Rear wheel light trail scales with speed & intensity
    if (trailRef.current && trailMatRef.current) {
      const speedNorm = Math.min(1.5, rt.speedMps / 11);
      const trailLen = Math.max(0.01, speedNorm * (3.2 + rt.intensityNorm * 4.5));
      trailRef.current.scale.set(1, 1, trailLen);
      trailRef.current.position.z = 0.82 + trailLen * 0.5;
      trailMatRef.current.opacity = Math.min(0.85, speedNorm * (0.35 + rt.intensityNorm * 0.45));
      trailMatRef.current.color.copy(_zoneColor);
    }
  });

  return (
    <group ref={slopeGroupRef} position={[0, 0, 0]}>
      {/* Grounded soft contact shadow under the bike */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <circleGeometry args={[1.05, 24]} />
        <meshBasicMaterial color="#02010a" transparent opacity={0.62} depthWrite={false} />
      </mesh>

      {/* Glowing circuit-pattern ring pulsing with pedal strokes */}
      <mesh ref={pulseRingRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.038, 0]}>
        <planeGeometry args={[2.5, 2.5]} />
        <meshBasicMaterial
          map={circuitTex}
          transparent
          opacity={0.82}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Outward shockwave burst ring on interval start */}
      <mesh
        ref={burstRingRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.048, 0]}
        visible={false}
      >
        <ringGeometry args={[0.92, 1.12, 36]} />
        <meshBasicMaterial
          ref={burstMatRef}
          color={zoneHex}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Rear wheel glowing light trail */}
      <mesh ref={trailRef} position={[0, 0.34, 2.0]}>
        <boxGeometry args={[0.075, 0.46, 1]} />
        <meshBasicMaterial
          ref={trailMatRef}
          color="#ff2a9d"
          transparent
          opacity={0.5}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Composite Bicycle + Rider Group */}
      <group ref={bikeGroupRef}>
        {/* REAR WHEEL (deep aero rim + neon glow ring + spokes) */}
        <group ref={rearWheelRef} position={[0, 0.37, 0.56]}>
          <mesh rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.35, 0.036, 12, 28]} />
            <meshStandardMaterial color="#101224" roughness={0.65} metalness={0.25} />
          </mesh>
          <mesh rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.31, 0.016, 10, 28]} />
            <meshStandardMaterial
              color="#ff2a9d"
              emissive="#ff2a9d"
              emissiveIntensity={1.6}
              toneMapped={false}
            />
          </mesh>
          {/* Aero disc hub & spokes */}
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.045, 0.045, 0.09, 12]} />
            <meshStandardMaterial color="#272d4a" roughness={0.3} metalness={0.85} />
          </mesh>
          <mesh>
            <boxGeometry args={[0.015, 0.62, 0.025]} />
            <meshStandardMaterial color="#1f2544" roughness={0.35} metalness={0.75} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <boxGeometry args={[0.015, 0.62, 0.025]} />
            <meshStandardMaterial color="#1f2544" roughness={0.35} metalness={0.75} />
          </mesh>
        </group>

        {/* FRONT WHEEL */}
        <group ref={frontWheelRef} position={[0, 0.37, -0.58]}>
          <mesh rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.35, 0.034, 12, 28]} />
            <meshStandardMaterial color="#101224" roughness={0.65} metalness={0.25} />
          </mesh>
          <mesh rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.31, 0.015, 10, 28]} />
            <meshStandardMaterial
              color="#00f0ff"
              emissive="#00f0ff"
              emissiveIntensity={1.5}
              toneMapped={false}
            />
          </mesh>
          <mesh>
            <boxGeometry args={[0.014, 0.62, 0.024]} />
            <meshStandardMaterial color="#1f2544" roughness={0.35} metalness={0.75} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <boxGeometry args={[0.014, 0.62, 0.024]} />
            <meshStandardMaterial color="#1f2544" roughness={0.35} metalness={0.75} />
          </mesh>
        </group>

        {/* AERO CARBON BICYCLE FRAME */}
        {/* Seat tube */}
        <mesh position={[0, 0.68, 0.14]} rotation={[-0.24, 0, 0]}>
          <cylinderGeometry args={[0.024, 0.03, 0.62, 10]} />
          <meshStandardMaterial color="#161b33" roughness={0.28} metalness={0.78} />
        </mesh>
        {/* Down tube */}
        <mesh position={[0, 0.62, -0.18]} rotation={[0.85, 0, 0]}>
          <cylinderGeometry args={[0.028, 0.034, 0.72, 10]} />
          <meshStandardMaterial color="#161b33" roughness={0.28} metalness={0.78} />
        </mesh>
        {/* Top tube with neon cyan accent */}
        <mesh position={[0, 0.91, -0.15]} rotation={[1.52, 0, 0]}>
          <cylinderGeometry args={[0.022, 0.022, 0.58, 10]} />
          <meshStandardMaterial color="#19213e" roughness={0.22} metalness={0.82} />
        </mesh>
        <mesh position={[0, 0.935, -0.15]}>
          <boxGeometry args={[0.018, 0.012, 0.52]} />
          <meshStandardMaterial
            color="#00f0ff"
            emissive="#00f0ff"
            emissiveIntensity={1.6}
            toneMapped={false}
          />
        </mesh>

        {/* Rear seatstays (left & right) */}
        <mesh position={[-0.06, 0.64, 0.36]} rotation={[0.62, 0, 0.08]}>
          <cylinderGeometry args={[0.014, 0.014, 0.6, 8]} />
          <meshStandardMaterial color="#151a30" roughness={0.3} metalness={0.75} />
        </mesh>
        <mesh position={[0.06, 0.64, 0.36]} rotation={[0.62, 0, -0.08]}>
          <cylinderGeometry args={[0.014, 0.014, 0.6, 8]} />
          <meshStandardMaterial color="#151a30" roughness={0.3} metalness={0.75} />
        </mesh>

        {/* Aero front fork */}
        <mesh position={[-0.055, 0.65, -0.49]} rotation={[0.25, 0, 0]}>
          <boxGeometry args={[0.02, 0.58, 0.045]} />
          <meshStandardMaterial color="#151a30" roughness={0.25} metalness={0.8} />
        </mesh>
        <mesh position={[0.055, 0.65, -0.49]} rotation={[0.25, 0, 0]}>
          <boxGeometry args={[0.02, 0.58, 0.045]} />
          <meshStandardMaterial color="#151a30" roughness={0.25} metalness={0.8} />
        </mesh>

        {/* Drop handlebars */}
        <mesh position={[0, 0.98, -0.46]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.018, 0.018, 0.48, 10]} />
          <meshStandardMaterial color="#1c223c" roughness={0.35} metalness={0.7} />
        </mesh>
        <mesh position={[-0.24, 0.93, -0.52]}>
          <boxGeometry args={[0.032, 0.12, 0.12]} />
          <meshStandardMaterial
            color="#00f0ff"
            emissive="#00f0ff"
            emissiveIntensity={1.2}
            toneMapped={false}
          />
        </mesh>
        <mesh position={[0.24, 0.93, -0.52]}>
          <boxGeometry args={[0.032, 0.12, 0.12]} />
          <meshStandardMaterial
            color="#00f0ff"
            emissive="#00f0ff"
            emissiveIntensity={1.2}
            toneMapped={false}
          />
        </mesh>

        {/* Saddle */}
        <mesh position={[0, 1.0, 0.22]}>
          <boxGeometry args={[0.14, 0.045, 0.28]} />
          <meshStandardMaterial color="#101325" roughness={0.6} metalness={0.2} />
        </mesh>

        {/* Spinning Crankset, Crank Arms & Pedals (exact 165mm crank radius) */}
        <group ref={crankRef} position={[0, BB_Y, BB_Z]}>
          <mesh rotation={[0, 0, Math.PI / 2]} position={[0.075, 0, 0]}>
            <cylinderGeometry args={[0.115, 0.115, 0.016, 16]} />
            <meshStandardMaterial color="#384066" roughness={0.28} metalness={0.88} />
          </mesh>
          {/* Left crank arm (+Y at theta=0) */}
          <mesh position={[-0.085, CRANK_RADIUS * 0.5, 0]}>
            <boxGeometry args={[0.022, CRANK_RADIUS, 0.032]} />
            <meshStandardMaterial color="#2a3254" roughness={0.3} metalness={0.85} />
          </mesh>
          <mesh position={[-0.14, CRANK_RADIUS, 0]}>
            <boxGeometry args={[0.095, 0.024, 0.075]} />
            <meshStandardMaterial color="#00f0ff" emissive="#00f0ff" emissiveIntensity={1.1} toneMapped={false} />
          </mesh>
          {/* Right crank arm (-Y at theta=0) */}
          <mesh position={[0.085, -CRANK_RADIUS * 0.5, 0]}>
            <boxGeometry args={[0.022, CRANK_RADIUS, 0.032]} />
            <meshStandardMaterial color="#2a3254" roughness={0.3} metalness={0.85} />
          </mesh>
          <mesh position={[0.14, -CRANK_RADIUS, 0]}>
            <boxGeometry args={[0.095, 0.024, 0.075]} />
            <meshStandardMaterial color="#00f0ff" emissive="#00f0ff" emissiveIntensity={1.1} toneMapped={false} />
          </mesh>
        </group>

        {/* CYCLIST RIDER (Dark Aero Suit + Glowing Cyan Circuit Lines + Glass Visor) */}
        {/* Pelvis / Shorts */}
        <mesh position={[0, 1.08, 0.2]}>
          <capsuleGeometry args={[0.15, 0.14, 8, 14]} />
          <meshStandardMaterial color="#0f1224" roughness={0.72} metalness={0.18} />
        </mesh>

        {/* Articulated Left & Right Legs (2-Bone IK driven by live Bluetooth cadence RPM) */}
        <mesh ref={leftThighRef} position={[-0.125, 0.85, 0.12]}>
          <capsuleGeometry args={[0.068, 0.31, 6, 12]} />
          <meshStandardMaterial color="#131830" roughness={0.55} metalness={0.3} />
        </mesh>
        <mesh ref={rightThighRef} position={[0.125, 0.85, 0.12]}>
          <capsuleGeometry args={[0.068, 0.31, 6, 12]} />
          <meshStandardMaterial color="#131830" roughness={0.55} metalness={0.3} />
        </mesh>

        <mesh ref={leftKneeRef} position={[-0.13, 0.68, -0.04]}>
          <sphereGeometry args={[0.062, 10, 10]} />
          <meshStandardMaterial color="#192142" roughness={0.45} metalness={0.45} />
        </mesh>
        <mesh ref={rightKneeRef} position={[0.13, 0.68, -0.04]}>
          <sphereGeometry args={[0.062, 10, 10]} />
          <meshStandardMaterial color="#192142" roughness={0.45} metalness={0.45} />
        </mesh>

        <mesh ref={leftShinRef} position={[-0.135, 0.56, 0.05]}>
          <capsuleGeometry args={[0.05, 0.33, 6, 12]} />
          <meshStandardMaterial color="#141a34" roughness={0.48} metalness={0.38} />
        </mesh>
        <mesh ref={rightShinRef} position={[0.135, 0.56, 0.05]}>
          <capsuleGeometry args={[0.05, 0.33, 6, 12]} />
          <meshStandardMaterial color="#141a34" roughness={0.48} metalness={0.38} />
        </mesh>

        {/* Aero Cycling Shoes with subtle cyan heel accents for crisp RPM readability from behind */}
        <mesh ref={leftShoeRef} position={[-0.14, BB_Y, BB_Z]}>
          <boxGeometry args={[0.088, 0.068, 0.18]} />
          <meshStandardMaterial
            color="#151b38"
            emissive="#00c8ff"
            emissiveIntensity={0.42}
            roughness={0.38}
            metalness={0.55}
          />
        </mesh>
        <mesh ref={rightShoeRef} position={[0.14, BB_Y, BB_Z]}>
          <boxGeometry args={[0.088, 0.068, 0.18]} />
          <meshStandardMaterial
            color="#151b38"
            emissive="#ff2a9d"
            emissiveIntensity={0.42}
            roughness={0.38}
            metalness={0.55}
          />
        </mesh>

        {/* Aero hunched torso leaning forward toward handlebars (-Z), dorsal back facing camera (+Z) */}
        <group position={[0, 1.32, -0.02]} rotation={[-0.78, 0, 0]}>
          <mesh scale={[1.12, 1.0, 0.85]}>
            <capsuleGeometry args={[0.175, 0.38, 10, 16]} />
            <meshStandardMaterial color="#10152a" roughness={0.42} metalness={0.48} />
          </mesh>

          {/* Sculpted shoulder armor pads */}
          <mesh position={[-0.19, 0.16, 0.02]}>
            <sphereGeometry args={[0.09, 12, 10]} />
            <meshStandardMaterial color="#141c38" roughness={0.35} metalness={0.62} />
          </mesh>
          <mesh position={[0.19, 0.16, 0.02]}>
            <sphereGeometry args={[0.09, 12, 10]} />
            <meshStandardMaterial color="#141c38" roughness={0.35} metalness={0.62} />
          </mesh>

          {/* Glowing cyan circuit-pattern lines on rider's dorsal back (+Z surface facing camera) */}
          <mesh position={[0, 0.02, 0.155]}>
            <boxGeometry args={[0.026, 0.44, 0.02]} />
            <meshStandardMaterial
              color="#00f0ff"
              emissive="#00f0ff"
              emissiveIntensity={2.0}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[-0.088, 0.07, 0.142]} rotation={[0, 0, 0.22]}>
            <boxGeometry args={[0.018, 0.3, 0.02]} />
            <meshStandardMaterial
              color="#00f0ff"
              emissive="#00f0ff"
              emissiveIntensity={1.7}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0.088, 0.07, 0.142]} rotation={[0, 0, -0.22]}>
            <boxGeometry args={[0.018, 0.3, 0.02]} />
            <meshStandardMaterial
              color="#00f0ff"
              emissive="#00f0ff"
              emissiveIntensity={1.7}
              toneMapped={false}
            />
          </mesh>
          {/* Upper shoulder circuit bar & spine nodes */}
          <mesh position={[0, 0.21, 0.14]}>
            <boxGeometry args={[0.29, 0.022, 0.02]} />
            <meshStandardMaterial
              color="#00f0ff"
              emissive="#00f0ff"
              emissiveIntensity={1.8}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, -0.14, 0.145]}>
            <boxGeometry args={[0.16, 0.018, 0.02]} />
            <meshStandardMaterial
              color="#ff2a9d"
              emissive="#ff2a9d"
              emissiveIntensity={1.5}
              toneMapped={false}
            />
          </mesh>
        </group>

        {/* Arms reaching to drop bars */}
        <mesh position={[-0.22, 1.24, -0.28]} rotation={[0.68, 0.14, 0.16]}>
          <capsuleGeometry args={[0.048, 0.46, 6, 10]} />
          <meshStandardMaterial color="#141a32" roughness={0.5} metalness={0.35} />
        </mesh>
        <mesh position={[0.22, 1.24, -0.28]} rotation={[0.68, -0.14, -0.16]}>
          <capsuleGeometry args={[0.048, 0.46, 6, 10]} />
          <meshStandardMaterial color="#141a32" roughness={0.5} metalness={0.35} />
        </mesh>

        {/* Aero Helmet + Reflective Glass Visor */}
        <group position={[0, 1.54, -0.34]} rotation={[0.16, 0, 0]}>
          <mesh scale={[0.92, 0.94, 1.26]}>
            <sphereGeometry args={[0.14, 18, 14]} />
            <meshStandardMaterial color="#181f3a" roughness={0.22} metalness={0.82} />
          </mesh>
          {/* Glowing helmet tail & side visor accents visible from rear */}
          <mesh position={[0, 0.02, 0.155]}>
            <boxGeometry args={[0.085, 0.024, 0.04]} />
            <meshStandardMaterial
              color="#00f0ff"
              emissive="#00f0ff"
              emissiveIntensity={1.8}
              toneMapped={false}
            />
          </mesh>
          {/* Glossy tinted glass visor wrap */}
          <mesh position={[0, -0.02, -0.07]} scale={[1.08, 0.56, 0.78]}>
            <sphereGeometry args={[0.125, 16, 12]} />
            <meshPhysicalMaterial
              color="#00e5ff"
              emissive="#0088b8"
              emissiveIntensity={0.65}
              roughness={0.08}
              metalness={0.9}
              clearcoat={1}
            />
          </mesh>
        </group>
      </group>
    </group>
  );
}
