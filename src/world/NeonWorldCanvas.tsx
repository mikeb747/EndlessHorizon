import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { sampleFreeRideGrade } from '../core/freeRide';
import {
  getActiveZone,
  QualityLevel,
  SceneryTheme,
  useAppStore,
} from '../store/useAppStore';
import { isSoftwareWebGl, SoftwareGlPacer } from './detectSoftwareGl';
import { stepCadenceMatcher } from './cadenceMatcher';
import { FinishSign } from './FinishSign';
import { computeAdaptiveCameraFraming, extractFrustumPlanes } from './frustumCuller';
import { HoloDataCards } from './HoloDataCards';
import { NeonCyclist } from './NeonCyclist';
import { NeonRoad } from './NeonRoad';
import {
  buildWorkoutElevationProfile,
  createWorldRuntime,
  getRoadCurvatureAt,
  getZoneGradient,
  REF_ROAD_SPEED_MPS,
  ROAD_Z_SPAN,
  sampleGradeAtTime,
  WORLD_CAMERA_FAR,
  WORLD_CAMERA_NEAR,
  WorkoutElevationProfile,
  WorldRuntimeState,
} from './roadMath';
import { SceneryThemes } from './SceneryThemes';
import { SpeedEffects } from './SpeedEffects';

const THEME_PALETTE: Record<
  SceneryTheme,
  {
    bg: string;
    fog: string;
    fogDensity: number;
    key: string;
    fillSky: string;
    fillGround: string;
  }
> = {
  'neon-city': {
    bg: '#090418',
    fog: '#190a36',
    fogDensity: 0.0046,
    key: '#ff8a4c',
    fillSky: '#4f38a8',
    fillGround: '#1a0a36',
  },
  'palm-grove': {
    bg: '#120724',
    fog: '#260d42',
    fogDensity: 0.0048,
    key: '#ff9068',
    fillSky: '#2aa4c4',
    fillGround: '#240b38',
  },
  'cloud-horizon': {
    bg: '#190a36',
    fog: '#3a165e',
    fogDensity: 0.0038,
    key: '#8ceeff',
    fillSky: '#c458c8',
    fillGround: '#101c48',
  },
  'causeway-embankment': {
    bg: '#081326',
    fog: '#162744',
    fogDensity: 0.0035,
    key: '#ff9c6e',
    fillSky: '#46a8c8',
    fillGround: '#0a1c30',
  },
};

const _aberrationVec = new THREE.Vector2(0, 0);
const _projScreenMatrix = new THREE.Matrix4();

function StudioEnvironment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmrem.dispose();
    return () => {
      scene.environment = null;
      envTex.dispose();
    };
  }, [gl, scene]);

  return null;
}

/**
 * Adapts camera FOV & follow distance to container aspect ratio (tall 1146x1392,
 * tablet 1280x800, or ultrawide) so both road edges and the bike stay framed.
 * Also advances the shared WorldRuntimeState cleanly inside useFrame.
 */
function SceneDriver({
  runtimeRef,
  viewportRef,
  elevationProfile,
  demoMode,
  showFps,
  onFpsSample,
}: {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  elevationProfile: WorkoutElevationProfile | null;
  demoMode: boolean;
  showFps: boolean;
  onFpsSample: (fps: number) => void;
}) {
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera);
  const size = useThree((s) => s.size);

  const fpsCounterRef = useRef({ frames: 0, elapsed: 0 });
  const domSyncAccumRef = useRef(0);

  useFrame((_, delta) => {
    const dt = Math.min(0.1, delta);
    const state = useAppStore.getState();
    const rt = runtimeRef.current;

    // Bind active elevation source (Free Ride undulating terrain vs structured workout profile)
    const isFreeRide = !demoMode && state.rideMode === 'freeride';
    rt.freeRideTerrain = isFreeRide ? state.freeRideTerrain : null;
    rt.elevationProfile = demoMode || isFreeRide ? null : elevationProfile;
    rt.workoutDurationSec = state.activeWorkout.totalDuration;

    // Smoothly advance workoutElapsedSec between 1 Hz engine ticks with zero lag at any FPS
    if (!demoMode) {
      const storeElapsed = state.elapsedSec;
      if (state.runState === 'running') {
        if (storeElapsed !== rt.lastStoreElapsed) {
          rt.lastStoreElapsed = storeElapsed;
          rt.subSecAccum = 0;
        } else {
          rt.subSecAccum = Math.min(0.98, rt.subSecAccum + dt);
        }
        rt.workoutElapsedSec = isFreeRide
          ? storeElapsed + rt.subSecAccum
          : Math.min(state.activeWorkout.totalDuration, storeElapsed + rt.subSecAccum);
        rt.finishPassDist = 0;
      } else if (state.runState === 'completed' && !isFreeRide) {
        rt.lastStoreElapsed = state.activeWorkout.totalDuration;
        rt.subSecAccum = 0;
        rt.workoutElapsedSec = state.activeWorkout.totalDuration;
        // Glide past the floating Finish Sign after crossing the line
        rt.finishPassDist = Math.min(18, rt.finishPassDist + REF_ROAD_SPEED_MPS * dt);
      } else {
        rt.lastStoreElapsed = storeElapsed;
        rt.subSecAccum = 0;
        rt.workoutElapsedSec = storeElapsed;
        rt.finishPassDist = 0;
      }
    }

    // Detect step-start interval pulse for road edge flash & ring shockwave
    if (state.intervalPulseCount !== rt.lastPulseCount) {
      rt.lastPulseCount = state.intervalPulseCount;
      rt.intervalBurst = 1.0;
      rt.edgeFlash = 1.0;
    }

    rt.intervalBurst = Math.max(0, rt.intervalBurst - dt * 1.15);
    rt.edgeFlash = Math.max(0, rt.edgeFlash - dt * 1.7);

    // Compute forward motion speed:
    // - In demoMode (Main Menu background): gentle cruise speed
    // - In ride screen: proportional to trainer virtual speed (keeps coasting briefly at finish)
    const isFinishCoast = !demoMode && state.runState === 'completed' && rt.finishPassDist < 16;
    const targetSpeedKmh = demoMode
      ? 34
      : isFinishCoast
        ? 30
        : state.runState === 'running' && state.instantPower > 2
          ? Math.max(state.speedKmh, 14)
          : 0;
    const targetSpeedMps = targetSpeedKmh / 3.6;

    const damp = 1 - Math.exp(-3.6 * dt);
    rt.speedMps += (targetSpeedMps - rt.speedMps) * damp;
    rt.distance += rt.speedMps * dt;

    // Wheel rotation (700c wheel radius ~0.35m)
    rt.wheelRad += (rt.speedMps / 0.35) * dt;

    // 1:1 Bluetooth Cadence Matching: sync 3D cyclist crank & leg RPM directly to sensor RPM
    // (tracks live Bluetooth cadence even while warming up in idle/paused, and coasts smoothly to 0)
    const fallbackRpm = demoMode
      ? 86
      : isFinishCoast
        ? 70
        : state.runState === 'running' && state.instantPower > 2
          ? 88
          : 0;
    const sensorRpm = demoMode
      ? 86
      : isFinishCoast
        ? Math.max(state.cadence, 68)
        : state.cadence;
    const matched = stepCadenceMatcher(
      rt.cadenceMatcher,
      {
        sensorRpm,
        lastPacketMs: demoMode ? 0 : state.cadenceTimestampMs,
        nowMs: Date.now(),
        enabled: !demoMode && state.cadenceMatchingEnabled,
        fallbackRpm,
      },
      dt
    );
    rt.cadenceRad = matched.crankRad;
    rt.modelCadenceRpm = matched.currentRpm;

    // Sync live model RPM, camera FOV, and frustum culling counts to DOM at ~4 Hz (zero React re-renders)
    domSyncAccumRef.current += dt;
    if (domSyncAccumRef.current >= 0.25) {
      domSyncAccumRef.current = 0;
      if (viewportRef.current) {
        viewportRef.current.setAttribute('data-model-rpm', String(Math.round(rt.modelCadenceRpm)));
        viewportRef.current.setAttribute('data-fov', camera.fov.toFixed(1));
        viewportRef.current.setAttribute('data-drawn-instances', String(rt.drawnInstances));
        viewportRef.current.setAttribute('data-culled-instances', String(rt.culledInstances));
      }
    }

    // Double-peak pedal pulse (left & right power strokes)
    const rawPulse = Math.pow(Math.abs(Math.sin(rt.cadenceRad)), 3);
    rt.pedalPulse = rt.modelCadenceRpm > 5 ? rawPulse : 0;

    // Intensity scalar & active zone number (speed streaks hidden in Z1/Z2, active & faster in Z3+)
    const zoneNum = isFreeRide ? state.freeRideZone : state.activeSnapshot?.zone.zone ?? 2;
    rt.zoneNumber = demoMode ? 3 : zoneNum;
    const targetIntensity = demoMode
      ? 0.35
      : THREE.MathUtils.clamp((zoneNum - 1) / 5.5, 0.08, 1.0);
    rt.intensityNorm += (targetIntensity - rt.intensityNorm) * (1 - Math.exp(-2.5 * dt));

    // Smooth current road gradient (workout zone grade or undulating Free Ride terrain <= 15%)
    const targetGrade = !demoMode
      ? rt.freeRideTerrain
        ? sampleFreeRideGrade(rt.freeRideTerrain, rt.distance)
        : rt.elevationProfile
          ? sampleGradeAtTime(rt.elevationProfile, rt.workoutElapsedSec)
          : 0
      : 0;
    rt.currentGrade += (targetGrade - rt.currentGrade) * (1 - Math.exp(-4.5 * dt));
    rt.pitchAngle = Math.atan(rt.currentGrade);

    // Smooth banking lean into upcoming road curves
    const targetLean =
      rt.speedMps > 0.5 ? THREE.MathUtils.clamp(getRoadCurvatureAt(rt.distance), -0.22, 0.22) : 0;
    rt.leanAngle += (targetLean - rt.leanAngle) * (1 - Math.exp(-4.0 * dt));

    // Bounded adaptive forward FOV (46°..66°) limits peripheral overdraw while preserving road framing
    const aspect = Math.max(0.45, size.width / Math.max(1, size.height));
    const speedFovKick = rt.intensityNorm * Math.min(1, rt.speedMps / 11) * 3.8;
    const framing = computeAdaptiveCameraFraming(aspect, speedFovKick);

    // Dynamic climbing camera pitch: keep full bike & circuit ring grounded while framing steep climbs
    const climbCamY = framing.camY - rt.currentGrade * 1.1;
    const climbLookY = 1.38 + rt.currentGrade * 9.0;

    const nextFov = camera.fov + (framing.fov - camera.fov) * (1 - Math.exp(-5 * dt));
    const fovChanged = Math.abs(nextFov - camera.fov) > 0.002;
    if (fovChanged) {
      camera.fov = nextFov;
    }
    camera.position.x += (-rt.leanAngle * 1.15 - camera.position.x) * (1 - Math.exp(-4 * dt));
    camera.position.y += (climbCamY - camera.position.y) * (1 - Math.exp(-5 * dt));
    camera.position.z += (framing.camZ - camera.position.z) * (1 - Math.exp(-5 * dt));
    camera.lookAt(0, climbLookY, -14);
    if (fovChanged) {
      camera.updateProjectionMatrix();
    }

    // Extract normalized 6-plane camera frustum ONCE per frame for all instanced scenery culling
    camera.updateMatrixWorld();
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    extractFrustumPlanes(_projScreenMatrix.elements, rt.frustumPlanes);
    rt.frustumReady = true;
    rt.cameraZ = camera.position.z;
    rt.drawnInstances = 0;
    rt.culledInstances = 0;

    // Optional FPS telemetry sampling (~2 Hz)
    if (showFps) {
      fpsCounterRef.current.frames += 1;
      fpsCounterRef.current.elapsed += delta;
      if (fpsCounterRef.current.elapsed >= 0.5) {
        const measured = Math.round(
          fpsCounterRef.current.frames / fpsCounterRef.current.elapsed
        );
        onFpsSample(measured);
        fpsCounterRef.current.frames = 0;
        fpsCounterRef.current.elapsed = 0;
      }
    }
  });

  return null;
}

function PostEffects({
  quality,
  intensityNorm,
}: {
  quality: QualityLevel;
  intensityNorm: number;
}) {
  if (quality === 'low') return null;

  const bloomIntensity = quality === 'high' ? 0.95 + intensityNorm * 0.55 : 0.72 + intensityNorm * 0.3;
  const aberrAmount = quality === 'high' ? 0.0005 + intensityNorm * 0.0022 : 0;
  _aberrationVec.set(aberrAmount, aberrAmount * 0.65);

  return (
    <EffectComposer multisampling={0}>
      <Bloom
        mipmapBlur
        luminanceThreshold={0.85}
        intensity={bloomIntensity}
        radius={0.62}
      />
      {quality === 'high' ? (
        <ChromaticAberration
          blendFunction={BlendFunction.NORMAL}
          offset={_aberrationVec}
          radialModulation={false}
          modulationOffset={0.15}
        />
      ) : (
        <></>
      )}
    </EffectComposer>
  );
}

interface NeonWorldCanvasProps {
  demoMode?: boolean;
}

export function NeonWorldCanvas({ demoMode = false }: NeonWorldCanvasProps) {
  const sceneryTheme = useAppStore((s) => s.sceneryTheme);
  const quality = useAppStore((s) => s.quality);
  const showHoloCards = useAppStore((s) => s.showHoloCards);
  const showFps = useAppStore((s) => s.showFps);
  const fps = useAppStore((s) => s.fps);
  const setFps = useAppStore((s) => s.setFps);
  const cadence = useAppStore((s) => s.cadence);
  const cadenceMatchingEnabled = useAppStore((s) => s.cadenceMatchingEnabled);
  const cadenceSource = useAppStore((s) => s.cadenceSource);
  const speedKmh = useAppStore((s) => s.speedKmh);
  const power3sAvg = useAppStore((s) => s.power3sAvg);
  const ftp = useAppStore((s) => s.ftp);
  const activeWorkout = useAppStore((s) => s.activeWorkout);
  const liveTss = useAppStore((s) => s.liveTss);
  const activeSnapshot = useAppStore((s) => s.activeSnapshot);
  const runState = useAppStore((s) => s.runState);
  const rideMode = useAppStore((s) => s.rideMode);
  const freeRideGrade = useAppStore((s) => s.freeRideGrade);
  const freeRideTargetWatts = useAppStore((s) => s.freeRideTargetWatts);
  const autoPaused = useAppStore((s) => s.autoPaused);
  const zone = useAppStore(getActiveZone);

  const [contextLost, setContextLost] = useState(false);
  const softwareGl = useMemo(() => isSoftwareWebGl(), []);
  const runtimeRef = useRef<WorldRuntimeState>(createWorldRuntime());
  const viewportRef = useRef<HTMLDivElement>(null);
  const elevationProfile = useMemo(
    () => (demoMode ? null : buildWorkoutElevationProfile(activeWorkout)),
    [activeWorkout, demoMode]
  );

  const palette = THEME_PALETTE[sceneryTheme];
  const ftpPct = ftp > 0 ? Math.round((power3sAvg / ftp) * 100) : 0;
  const targetWatts =
    rideMode === 'freeride'
      ? freeRideTargetWatts
      : activeSnapshot?.targetWatts ?? Math.round(ftp * 0.68);
  const countdownSec =
    !demoMode && rideMode === 'workout' && runState === 'running'
      ? activeSnapshot?.countdownSec ?? null
      : null;
  const nextStep = activeSnapshot?.nextStep ?? null;
  const gradePct =
    rideMode === 'freeride'
      ? Math.round(freeRideGrade * 1000) / 10
      : Math.round(getZoneGradient(zone.zone) * 100);
  const gradeLabel =
    Math.abs(gradePct) < 0.2
      ? 'FLAT 0%'
      : gradePct > 0
        ? `+${gradePct.toFixed(rideMode === 'freeride' ? 1 : 0)}% GRADE`
        : `${gradePct.toFixed(1)}% DESCENT`;

  // Cap DPR at 1.5 on GPUs for steady 60 fps, 1.0 on software WebGL
  const maxDpr = softwareGl ? 1 : quality === 'low' ? 1 : 1.5;

  return (
    <div
      ref={viewportRef}
      className="relative w-full h-full overflow-hidden bg-[#070414]"
      data-testid="neon-world-viewport"
      data-theme={sceneryTheme}
      data-zone={zone.code}
      data-speed-streaks={zone.zone >= 3 && quality !== 'low' ? 'active' : 'hidden'}
      data-cadence-matching={cadenceMatchingEnabled ? 'on' : 'off'}
      data-sensor-rpm={Math.round(cadence)}
      data-cadence-source={cadenceSource}
      data-draw-distance={ROAD_Z_SPAN}
    >
      {contextLost ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#09051a] text-cyan-200 p-6 text-center">
          <div>
            <p className="font-display text-lg text-cyan-300">WebGL Context Interrupted</p>
            <p className="text-sm text-slate-300 mt-1">
              Restoring 3D synthwave renderer automatically...
            </p>
          </div>
        </div>
      ) : (
        <Canvas
          frameloop={softwareGl ? 'demand' : 'always'}
          dpr={[1, maxDpr]}
          camera={{
            fov: 60,
            near: WORLD_CAMERA_NEAR,
            far: WORLD_CAMERA_FAR,
            position: [0, 2.25, 4.7],
          }}
          gl={{
            antialias: !softwareGl && quality !== 'low',
            powerPreference: 'high-performance',
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.12,
          }}
          onCreated={({ gl }) => {
            const canvas = gl.domElement;
            const handleLost = (e: Event) => {
              e.preventDefault();
              setContextLost(true);
            };
            const handleRestored = () => setContextLost(false);
            canvas.addEventListener('webglcontextlost', handleLost, false);
            canvas.addEventListener('webglcontextrestored', handleRestored, false);
          }}
        >
          <color attach="background" args={[palette.bg]} />
          <fogExp2 attach="fog" args={[palette.fog, palette.fogDensity]} />

          <StudioEnvironment />
          <hemisphereLight args={[palette.fillSky, palette.fillGround, 1.15]} />
          <directionalLight position={[12, 22, 16]} intensity={1.55} color={palette.key} />
          <directionalLight position={[-10, 8, -18]} intensity={1.1} color="#00f0ff" />

          <SceneDriver
            runtimeRef={runtimeRef}
            viewportRef={viewportRef}
            elevationProfile={elevationProfile}
            demoMode={demoMode}
            showFps={showFps && !demoMode}
            onFpsSample={setFps}
          />
          <SoftwareGlPacer enabled={softwareGl} />

          <SceneryThemes
            runtimeRef={runtimeRef}
            sceneryTheme={sceneryTheme}
            quality={quality}
          />
          <NeonRoad
            runtimeRef={runtimeRef}
            zoneHex={zone.hex}
            sceneryTheme={sceneryTheme}
            quality={quality}
          />
          {!demoMode && rideMode === 'workout' && (
            <FinishSign
              runtimeRef={runtimeRef}
              totalDurationSec={activeWorkout.totalDuration}
              estimatedTss={Math.round(liveTss) || activeWorkout.estimatedTss}
            />
          )}
          <NeonCyclist runtimeRef={runtimeRef} zoneHex={zone.hex} />
          <SpeedEffects runtimeRef={runtimeRef} quality={quality} />

          {!demoMode && (
            <HoloDataCards
              visible={showHoloCards}
              cadence={cadence}
              speedKmh={speedKmh}
              ftpPct={ftpPct}
              targetWatts={targetWatts}
              zoneHex={zone.hex}
              runtimeRef={runtimeRef}
            />
          )}

          {!softwareGl && (
            <PostEffects
              quality={quality}
              intensityNorm={Math.min(1, Math.max(0, (zone.zone - 1) / 5.5))}
            />
          )}
        </Canvas>
      )}

      {/* Subtle Zone & Grade Banner + 5-Second Step-Change Countdown Cue */}
      {!demoMode && (
        <>
          <div className="pointer-events-none absolute top-3 left-3 right-3 flex items-start justify-between gap-2 z-10">
            <div
              className="px-3 py-1 rounded border text-xs font-display tracking-wider uppercase flex items-center gap-2"
              style={{
                backgroundColor: 'rgba(8, 7, 24, 0.84)',
                borderColor: zone.borderHex,
                color: zone.glowHex,
                boxShadow: `0 0 12px ${zone.bgTint}`,
              }}
              data-testid="zone-grade-banner"
            >
              <span>
                {rideMode === 'freeride' ? 'FREE RIDE · ' : ''}
                {zone.code} {zone.name}
              </span>
              <span className="text-slate-400">·</span>
              <span className="tabular-nums text-cyan-200">{gradeLabel}</span>
            </div>

            {showFps && (
              <div className="px-2.5 py-1 rounded border border-cyan-500/40 bg-[#080718]/85 text-xs font-display tabular-nums text-cyan-300">
                {fps} FPS
              </div>
            )}
          </div>

          {countdownSec !== null && (
            <div
              className="pointer-events-none absolute inset-x-0 top-12 flex flex-col items-center z-20"
              data-testid="step-countdown-cue"
            >
              <div
                className="px-5 py-2.5 rounded-lg border-2 text-center"
                style={{
                  backgroundColor: 'rgba(8, 6, 22, 0.9)',
                  borderColor: '#ff8c1a',
                  boxShadow: '0 0 24px rgba(255, 140, 26, 0.55)',
                }}
              >
                <div className="font-display text-3xl sm:text-4xl font-extrabold tabular-nums text-amber-300 text-glow-amber">
                  {countdownSec}
                </div>
                {nextStep && (
                  <div className="text-xs sm:text-sm font-semibold tracking-wide text-slate-200 mt-0.5">
                    Next: {nextStep.label} ·{' '}
                    {Math.round(nextStep.powerLow * ftp * (1 + useAppStore.getState().intensityOffsetPct / 100))} W
                  </div>
                )}
              </div>
            </div>
          )}

          {runState === 'paused' && (
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#060412]/45 z-10"
              data-testid="paused-overlay"
            >
              <div className="neon-frame-magenta rounded-xl px-7 py-4 text-center">
                <div className="font-display text-2xl font-bold tracking-widest text-pink-300 text-glow-magenta">
                  {autoPaused ? 'AUTO-PAUSED' : 'PAUSED'}
                </div>
                <div className="text-sm text-slate-300 mt-1">
                  {autoPaused
                    ? 'Pedalling stopped for 5s · Start pedalling or press Resume to continue'
                    : 'Press Space or Resume to continue · ERG set to safe standby (50 W)'}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
