import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GpsRoutePreviewSvg } from '../components/GpsRoutePreviewSvg';
import { sampleFreeRideGrade } from '../core/freeRide';
import { sampleCompiledRouteProgress } from '../recording/gpsRoutes';
import { liveTelemetryBuffer } from '../recording/telemetryBuffer';
import { getSceneryDisplayName } from '../recording/types';
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
import { EffectiveRenderConfig, graphicsGovernor } from './graphicsGovernor';
import { HoloDataCards } from './HoloDataCards';
import { NeonCyclist } from './NeonCyclist';
import { NeonRoad } from './NeonRoad';
import {
  buildWorkoutElevationProfile,
  computeCornerLeanAngle,
  createWorldRuntime,
  getRoadCurvatureAt,
  getZoneGradient,
  REF_ROAD_SPEED_MPS,
  ROAD_Z_SPAN,
  sampleGradeAtTime,
  setActiveRoadCurveSource,
  updateRoadCurveLut,
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
const _targetBgColor = new THREE.Color();
const _targetFogColor = new THREE.Color();
const _targetKeyColor = new THREE.Color();
const _targetSkyColor = new THREE.Color();
const _targetGroundColor = new THREE.Color();

/**
 * Seamless horizon-mist crossfade rig for mid-ride scenery switching:
 * - Swells exponential fog into a luminous twilight veil (~0.8s)
 * - Swaps renderedTheme cleanly at peak veil (zero double-rendering cost, zero pop-in)
 * - Clears smoothly into the new world's sky, lighting, and fog palette (~1.0s)
 */
function SceneryTransitionRig({
  targetTheme,
  renderedTheme,
  onSwapTheme,
  instant,
}: {
  targetTheme: SceneryTheme;
  renderedTheme: SceneryTheme;
  onSwapTheme: (next: SceneryTheme) => void;
  instant: boolean;
}) {
  const scene = useThree((s) => s.scene);
  const fogRef = useRef<THREE.FogExp2>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);

  const phaseRef = useRef<'idle' | 'in' | 'out'>('idle');
  const progressRef = useRef(0);
  const pendingThemeRef = useRef<SceneryTheme>(targetTheme);
  const initialPalette = THEME_PALETTE[renderedTheme];

  useEffect(() => {
    if (targetTheme === renderedTheme) return;
    if (instant) {
      pendingThemeRef.current = targetTheme;
      phaseRef.current = 'idle';
      progressRef.current = 0;
      onSwapTheme(targetTheme);
      return;
    }
    pendingThemeRef.current = targetTheme;
    phaseRef.current = 'in';
    progressRef.current = 0;
  }, [targetTheme, renderedTheme, instant, onSwapTheme]);

  useFrame((_, delta) => {
    const dt = Math.min(0.1, delta);
    const activePal = THEME_PALETTE[renderedTheme];
    const destPal = THEME_PALETTE[pendingThemeRef.current];

    let targetDensity = activePal.fogDensity;

    if (phaseRef.current === 'in') {
      progressRef.current = Math.min(1, progressRef.current + dt / 0.8);
      const easeIn = progressRef.current * progressRef.current;
      targetDensity = activePal.fogDensity + (0.0175 - activePal.fogDensity) * easeIn;
      if (progressRef.current >= 1) {
        phaseRef.current = 'out';
        progressRef.current = 0;
        onSwapTheme(pendingThemeRef.current);
      }
    } else if (phaseRef.current === 'out') {
      progressRef.current = Math.min(1, progressRef.current + dt / 1.05);
      const easeOut = 1 - Math.pow(1 - progressRef.current, 2);
      targetDensity = 0.0175 + (activePal.fogDensity - 0.0175) * easeOut;
      if (progressRef.current >= 1) {
        phaseRef.current = 'idle';
        progressRef.current = 0;
      }
    }

    const colorPal = phaseRef.current === 'in' ? destPal : activePal;
    const damp = 1 - Math.exp(-3.8 * dt);

    _targetBgColor.set(colorPal.bg);
    _targetFogColor.set(colorPal.fog);
    _targetKeyColor.set(colorPal.key);
    _targetSkyColor.set(colorPal.fillSky);
    _targetGroundColor.set(colorPal.fillGround);

    if (scene.background instanceof THREE.Color) {
      scene.background.lerp(_targetBgColor, damp);
    }
    if (fogRef.current) {
      fogRef.current.color.lerp(_targetFogColor, damp);
      fogRef.current.density += (targetDensity - fogRef.current.density) * (1 - Math.exp(-9 * dt));
    }
    if (keyRef.current) {
      keyRef.current.color.lerp(_targetKeyColor, damp);
    }
    if (hemiRef.current) {
      hemiRef.current.color.lerp(_targetSkyColor, damp);
      hemiRef.current.groundColor.lerp(_targetGroundColor, damp);
    }
  });

  return (
    <>
      <color attach="background" args={[initialPalette.bg]} />
      <fogExp2 ref={fogRef} attach="fog" args={[initialPalette.fog, initialPalette.fogDensity]} />
      <hemisphereLight
        ref={hemiRef}
        args={[initialPalette.fillSky, initialPalette.fillGround, 1.15]}
      />
      <directionalLight
        ref={keyRef}
        position={[12, 22, 16]}
        intensity={1.55}
        color={initialPalette.key}
      />
      <directionalLight position={[-10, 8, -18]} intensity={1.1} color="#00f0ff" />
    </>
  );
}

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
 * Precompile all active Three.js shaders asynchronously during the Main Menu (and on scenery
 * switch) using renderer.compileAsync so entering a ride incurs zero shader compile hitches.
 */
function ShaderPrecompiler({
  enabled,
  sceneryTheme,
}: {
  enabled: boolean;
  sceneryTheme: SceneryTheme;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const compiledThemesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    if (compiledThemesRef.current.has(sceneryTheme)) return;
    compiledThemesRef.current.add(sceneryTheme);

    let cancelled = false;
    const rafId = window.requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        const asyncCompiler = gl as THREE.WebGLRenderer & {
          compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<THREE.Object3D>;
        };
        if (typeof asyncCompiler.compileAsync === 'function') {
          void asyncCompiler.compileAsync(scene, camera).catch(() => undefined);
        } else {
          gl.compile(scene, camera);
        }
      } catch {
        // Ignore shader precompile errors on constrained/lost contexts
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [enabled, sceneryTheme, gl, scene, camera]);

  return null;
}

function FpsCapPacer({
  enabled,
  fpsCap,
}: {
  enabled: boolean;
  fpsCap: 30 | 60;
}) {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    if (!enabled) return;
    let rafId = 0;
    let lastDrawMs = 0;
    const minIntervalMs = 1000 / Math.max(15, fpsCap);

    const tick = (now: number) => {
      if (lastDrawMs === 0 || now - lastDrawMs >= minIntervalMs - 1.5) {
        lastDrawMs = now;
        invalidate();
      }
      rafId = window.requestAnimationFrame(tick);
    };

    invalidate();
    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [enabled, fpsCap, invalidate]);

  return null;
}

/**
 * Adapts camera FOV & follow distance to container aspect ratio (tall 1146x1392,
 * tablet 1280x800, or ultrawide) so both road edges and the bike stay framed.
 * Also advances the shared WorldRuntimeState cleanly inside useFrame and feeds
 * frame timings to the adaptive GraphicsGovernor.
 */
function SceneDriver({
  runtimeRef,
  viewportRef,
  renderConfigRef,
  elevationProfile,
  demoMode,
  softwareGl,
  showFps,
  onFpsSample,
}: {
  runtimeRef: React.MutableRefObject<WorldRuntimeState>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  renderConfigRef: React.MutableRefObject<EffectiveRenderConfig>;
  elevationProfile: WorkoutElevationProfile | null;
  demoMode: boolean;
  softwareGl: boolean;
  showFps: boolean;
  onFpsSample: (fps: number) => void;
}) {
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera);
  const size = useThree((s) => s.size);

  const fpsCounterRef = useRef({ frames: 0, elapsed: 0 });
  const domSyncAccumRef = useRef(0);
  const lastFramePerfRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      setActiveRoadCurveSource(null);
    };
  }, []);

  useFrame((_, delta) => {
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const rawFrameMs = lastFramePerfRef.current > 0 ? nowPerf - lastFramePerfRef.current : delta * 1000;
    lastFramePerfRef.current = nowPerf;

    const dt = Math.min(0.1, delta);
    const state = useAppStore.getState();
    const rt = runtimeRef.current;

    // Apply current governor scenery budget without triggering React re-renders
    rt.sceneryScale = renderConfigRef.current.sceneryScale;

    // Bind active elevation source (Free Ride undulating terrain vs structured workout profile)
    const isFreeRide = !demoMode && state.rideMode === 'freeride';
    rt.freeRideTerrain = isFreeRide ? state.freeRideTerrain : null;
    rt.elevationProfile = demoMode || isFreeRide ? null : elevationProfile;
    rt.workoutDurationSec = state.activeWorkout.totalDuration;
    rt.gpsRoute = demoMode ? null : state.activeGpsRoute;

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

    // Read live power, cadence & speed directly from the zero-allocation ring buffer
    const livePower = liveTelemetryBuffer.instantPower;
    const livePower3s = liveTelemetryBuffer.power3sAvg;
    const liveCadence = liveTelemetryBuffer.cadence;
    const liveSpeedKmh = liveTelemetryBuffer.speedKmh;
    const activeZone = getActiveZone(state);

    rt.livePower = livePower;
    rt.livePower3s = livePower3s;
    rt.liveCadence = liveCadence;
    rt.liveSpeedKmh = liveSpeedKmh;
    rt.liveFtpPct = state.ftp > 0 ? Math.round((livePower3s / state.ftp) * 100) : 0;
    rt.liveTargetWatts = isFreeRide
      ? state.freeRideTargetWatts
      : state.activeSnapshot?.targetWatts ?? Math.round(state.ftp * 0.68);
    rt.liveTss = state.liveTss;
    rt.liveZoneHex = activeZone.hex;

    // Compute forward motion speed:
    // - In demoMode (Main Menu background): gentle cruise speed
    // - In ride screen: proportional to trainer virtual speed (keeps coasting briefly at finish)
    const isFinishCoast = !demoMode && state.runState === 'completed' && rt.finishPassDist < 16;
    const targetSpeedKmh = demoMode
      ? 34
      : isFinishCoast
        ? 30
        : state.runState === 'running' && livePower > 2
          ? Math.max(liveSpeedKmh, 14)
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
        : state.runState === 'running' && livePower > 2
          ? 88
          : 0;
    const sensorRpm = demoMode
      ? 86
      : isFinishCoast
        ? Math.max(liveCadence, 68)
        : liveCadence;
    const matched = stepCadenceMatcher(
      rt.cadenceMatcher,
      {
        sensorRpm,
        lastPacketMs: demoMode ? 0 : liveTelemetryBuffer.cadenceTimestampMs,
        nowMs: Date.now(),
        enabled: !demoMode && state.cadenceMatchingEnabled,
        fallbackRpm,
      },
      dt
    );
    rt.cadenceRad = matched.crankRad;
    rt.modelCadenceRpm = matched.currentRpm;

    // Sync live model RPM, sensor attributes, camera FOV, and frustum culling counts to DOM at ~4 Hz (zero React re-renders)
    domSyncAccumRef.current += dt;
    if (domSyncAccumRef.current >= 0.25) {
      domSyncAccumRef.current = 0;
      if (viewportRef.current) {
        viewportRef.current.setAttribute('data-model-rpm', String(Math.round(rt.modelCadenceRpm)));
        viewportRef.current.setAttribute('data-sensor-rpm', String(Math.round(liveCadence)));
        viewportRef.current.setAttribute('data-cadence-matching', state.cadenceMatchingEnabled ? 'on' : 'off');
        viewportRef.current.setAttribute('data-cadence-source', liveTelemetryBuffer.cadenceSource);
        viewportRef.current.setAttribute('data-gps-route', state.activeGpsRoute?.id ?? 'urashima-loop');
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

    // Update GPS Art road curve LUT once per frame so road, sidewalks, props & finish sign curve identically
    updateRoadCurveLut(rt);
    setActiveRoadCurveSource(rt.curveLutReady ? rt : null);

    // Smooth banking lean INTO upcoming road curves (right turn -> tilts right, left turn -> tilts left)
    const activeCurvature = rt.curveLutReady
      ? rt.currentCurvature
      : getRoadCurvatureAt(rt.distance);
    const targetLean = computeCornerLeanAngle(activeCurvature, rt.curveLutReady, rt.speedMps);
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

    // Report frame time to adaptive GraphicsGovernor (ignore giant spikes right after tab unhide)
    if (!demoMode && rawFrameMs > 1 && rawFrameMs < 240) {
      const isMidInterval = state.runState === 'running' && activeZone.zone >= 2;
      graphicsGovernor.recordFrame(rawFrameMs, Date.now(), {
        isMidInterval,
        softwareGl,
      });
    }

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
  bloom,
  chromaticAberration,
  quality,
  intensityNorm,
}: {
  bloom: boolean;
  chromaticAberration: boolean;
  quality: QualityLevel;
  intensityNorm: number;
}) {
  if (!bloom && !chromaticAberration) return null;

  const bloomIntensity =
    quality === 'high' ? 0.95 + intensityNorm * 0.55 : 0.72 + intensityNorm * 0.3;
  const aberrAmount = chromaticAberration ? 0.0005 + intensityNorm * 0.0022 : 0;
  _aberrationVec.set(aberrAmount, aberrAmount * 0.65);

  return (
    <EffectComposer multisampling={0}>
      {bloom ? (
        <Bloom
          mipmapBlur
          luminanceThreshold={0.85}
          intensity={bloomIntensity}
          radius={0.62}
        />
      ) : (
        <></>
      )}
      {chromaticAberration ? (
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

/**
 * Isolated 2D viewport HUD overlays (Zone/Grade banner, FPS counter, 5s step countdown,
 * scenery transition toast, GPS minimap, and Paused overlay). Keeping these in a sibling
 * component ensures the 3D <Canvas> never re-renders on live telemetry updates.
 */
function ViewportHudOverlays({
  transitionBanner,
}: {
  transitionBanner: string | null;
}) {
  const sceneryTheme = useAppStore((s) => s.sceneryTheme);
  const showFps = useAppStore((s) => s.showFps);
  const fps = useAppStore((s) => s.fps);
  const ftp = useAppStore((s) => s.ftp);
  const intensityOffsetPct = useAppStore((s) => s.intensityOffsetPct);
  const activeSnapshot = useAppStore((s) => s.activeSnapshot);
  const runState = useAppStore((s) => s.runState);
  const rideMode = useAppStore((s) => s.rideMode);
  const freeRideGrade = useAppStore((s) => s.freeRideGrade);
  const autoPaused = useAppStore((s) => s.autoPaused);
  const activeGpsRoute = useAppStore((s) => s.activeGpsRoute);
  const rideDistanceM = useAppStore((s) => s.rideDistanceM);
  const zone = useAppStore(getActiveZone);

  const gpsProgress01 = useMemo(
    () => sampleCompiledRouteProgress(activeGpsRoute, rideDistanceM),
    [activeGpsRoute, rideDistanceM]
  );

  const countdownSec =
    rideMode === 'workout' && runState === 'running'
      ? activeSnapshot?.countdownSec ?? null
      : null;
  const nextStep = activeSnapshot?.nextStep ?? null;
  const gradePct =
    rideMode === 'freeride'
      ? Math.round(freeRideGrade * 1000) / 10
      : Math.round(getZoneGradient(zone.zone, sceneryTheme) * 100);
  const gradeLabel =
    Math.abs(gradePct) < 0.2
      ? 'FLAT 0%'
      : gradePct > 0
        ? `+${gradePct.toFixed(rideMode === 'freeride' ? 1 : 0)}% GRADE`
        : `${gradePct.toFixed(1)}% DESCENT`;

  return (
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
                {Math.round(nextStep.powerLow * ftp * (1 + intensityOffsetPct / 100))} W
              </div>
            )}
          </div>
        </div>
      )}

      {transitionBanner && (
        <div
          className="pointer-events-none absolute inset-x-0 top-12 flex justify-center z-20"
          data-testid="scenery-transition-banner"
        >
          <div className="px-4 py-1.5 rounded-md border border-pink-400/75 bg-[#09051c]/90 text-xs font-display font-bold tracking-[0.18em] text-pink-200 uppercase shadow-[0_0_18px_rgba(255,42,157,0.35)]">
            Entering {transitionBanner}
          </div>
        </div>
      )}

      {activeGpsRoute && (
        <div
          className="pointer-events-none absolute bottom-3 right-3 z-10 w-44 sm:w-52 rounded-lg border border-cyan-500/45 bg-[#08061a]/88 p-2 shadow-[0_0_16px_rgba(0,240,255,0.2)]"
          data-testid="gps-route-minimap"
        >
          <div className="flex items-center justify-between text-[10px] font-display uppercase tracking-wider text-cyan-200 px-0.5 mb-1">
            <span className="truncate">{activeGpsRoute.name}</span>
            <span className="tabular-nums text-pink-300 shrink-0 ml-1">
              {Math.round(gpsProgress01 * 100)}%
            </span>
          </div>
          <GpsRoutePreviewSvg
            points={activeGpsRoute.previewPoints}
            progress01={gpsProgress01}
            height={62}
            label={`${activeGpsRoute.name} live GPS map`}
          />
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
  );
}

interface NeonWorldCanvasProps {
  demoMode?: boolean;
}

export function NeonWorldCanvas({ demoMode = false }: NeonWorldCanvasProps) {
  // Coarse structural settings only — live power, cadence, speed, HR, and history are read
  // directly inside useFrame via liveTelemetryBuffer & runtimeRef with zero React re-renders.
  const sceneryTheme = useAppStore((s) => s.sceneryTheme);
  const quality = useAppStore((s) => s.quality);
  const showHoloCards = useAppStore((s) => s.showHoloCards);
  const showFps = useAppStore((s) => s.showFps);
  const setFps = useAppStore((s) => s.setFps);
  const activeWorkout = useAppStore((s) => s.activeWorkout);
  const rideMode = useAppStore((s) => s.rideMode);
  const zoneHex = useAppStore((s) => getActiveZone(s).hex);
  const zoneCode = useAppStore((s) => getActiveZone(s).code);
  const zoneNumber = useAppStore((s) => getActiveZone(s).zone);

  const [contextLost, setContextLost] = useState(false);
  const [isDocumentHidden, setIsDocumentHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.hidden
  );
  const [renderedTheme, setRenderedTheme] = useState<SceneryTheme>(sceneryTheme);
  const [transitionBanner, setTransitionBanner] = useState<string | null>(null);
  const prevThemeRef = useRef<SceneryTheme>(sceneryTheme);
  const softwareGl = useMemo(() => isSoftwareWebGl(), []);
  const [renderConfig, setRenderConfig] = useState<EffectiveRenderConfig>(() =>
    graphicsGovernor.getConfig(softwareGl)
  );
  const renderConfigRef = useRef<EffectiveRenderConfig>(renderConfig);
  renderConfigRef.current = renderConfig;

  const runtimeRef = useRef<WorldRuntimeState>(createWorldRuntime());
  const viewportRef = useRef<HTMLDivElement>(null);
  const elevationProfile = useMemo(
    () => (demoMode ? null : buildWorkoutElevationProfile(activeWorkout, sceneryTheme)),
    [activeWorkout, demoMode, sceneryTheme]
  );

  // Pause 3D rendering cleanly when tab/app is hidden (workout worker, BLE & recorder continue)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      setIsDocumentHidden(document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Subscribe to adaptive GraphicsGovernor transitions & base quality updates
  useEffect(() => {
    graphicsGovernor.setBaseQuality(quality);
    setRenderConfig(graphicsGovernor.getConfig(softwareGl));
    return graphicsGovernor.subscribe(() => {
      setRenderConfig(graphicsGovernor.getConfig(softwareGl));
    });
  }, [quality, softwareGl]);

  // Show a brief non-blocking horizon banner when scenery transitions mid-ride
  useEffect(() => {
    if (prevThemeRef.current === sceneryTheme) return;
    prevThemeRef.current = sceneryTheme;
    if (demoMode) return;
    setTransitionBanner(getSceneryDisplayName(sceneryTheme));
    const timer = window.setTimeout(() => setTransitionBanner(null), 3400);
    return () => window.clearTimeout(timer);
  }, [sceneryTheme, demoMode]);

  const use30FpsPacer = !isDocumentHidden && !softwareGl && renderConfig.fpsCap === 30;
  const canvasFrameloop: 'always' | 'demand' | 'never' = isDocumentHidden
    ? 'never'
    : softwareGl || use30FpsPacer
      ? 'demand'
      : 'always';

  return (
    <div
      ref={viewportRef}
      className="relative w-full h-full overflow-hidden bg-[#070414]"
      data-testid="neon-world-viewport"
      data-theme={sceneryTheme}
      data-rendered-theme={renderedTheme}
      data-zone={zoneCode}
      data-speed-streaks={zoneNumber >= 3 && quality !== 'low' ? 'active' : 'hidden'}
      data-draw-distance={ROAD_Z_SPAN}
      data-fps-cap={renderConfig.fpsCap}
      data-gov-stage={renderConfig.degradationStage}
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
          frameloop={canvasFrameloop}
          dpr={[1, renderConfig.dprMax]}
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
          <SceneryTransitionRig
            targetTheme={sceneryTheme}
            renderedTheme={renderedTheme}
            onSwapTheme={setRenderedTheme}
            instant={demoMode || softwareGl}
          />

          <StudioEnvironment />
          <ShaderPrecompiler enabled={!softwareGl} sceneryTheme={renderedTheme} />

          <SceneDriver
            runtimeRef={runtimeRef}
            viewportRef={viewportRef}
            renderConfigRef={renderConfigRef}
            elevationProfile={elevationProfile}
            demoMode={demoMode}
            softwareGl={softwareGl}
            showFps={showFps && !demoMode}
            onFpsSample={setFps}
          />
          <SoftwareGlPacer enabled={softwareGl && !isDocumentHidden} />
          <FpsCapPacer enabled={use30FpsPacer} fpsCap={renderConfig.fpsCap} />

          <SceneryThemes
            runtimeRef={runtimeRef}
            sceneryTheme={renderedTheme}
            quality={quality}
          />
          <NeonRoad
            runtimeRef={runtimeRef}
            zoneHex={zoneHex}
            sceneryTheme={renderedTheme}
            quality={quality}
          />
          {!demoMode && rideMode === 'workout' && (
            <FinishSign
              runtimeRef={runtimeRef}
              totalDurationSec={activeWorkout.totalDuration}
              estimatedTss={activeWorkout.estimatedTss}
            />
          )}
          <NeonCyclist runtimeRef={runtimeRef} zoneHex={zoneHex} />
          <SpeedEffects runtimeRef={runtimeRef} quality={quality} />

          {!demoMode && <HoloDataCards visible={showHoloCards} runtimeRef={runtimeRef} />}

          {!softwareGl && (
            <PostEffects
              bloom={renderConfig.bloom}
              chromaticAberration={renderConfig.chromaticAberration}
              quality={quality}
              intensityNorm={Math.min(1, Math.max(0, (zoneNumber - 1) / 5.5))}
            />
          )}
        </Canvas>
      )}

      {!demoMode && <ViewportHudOverlays transitionBanner={transitionBanner} />}
    </div>
  );
}
