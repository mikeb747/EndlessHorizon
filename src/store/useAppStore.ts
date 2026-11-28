import { create } from 'zustand';
import { MusicFollowMode, MusicZone } from '../audio/musicEngineLogic';
import {
  clampAudioVolume,
  DEFAULT_AUDIO_MASTER_VOLUME,
  DEFAULT_AUDIO_MENU_VOLUME,
  DEFAULT_AUDIO_RIDE_VOLUME,
} from '../audio/synthwaveMath';
import { evaluateAutoPause } from '../core/autoPause';
import { BUILT_IN_WORKOUTS, FREE_RIDE_SESSION_WORKOUT } from '../core/builtInWorkouts';
import {
  clampFreeRideCenterWatts,
  computeFreeRideTargetWatts,
  createFreeRideTerrain,
  FreeRideTerrainProfile,
  sampleFreeRideGrade,
} from '../core/freeRide';
import {
  ActiveStepSnapshot,
  calculateCaloriesFromKj,
} from '../core/workoutEngine';
import { COGGAN_ZONES, getEffectiveFtp, PowerZoneInfo, ZoneNumber } from '../core/zones';
import { ParsedWorkout } from '../core/zwoParser';
import { DeviceManager } from '../devices/deviceManager';
import {
  CadenceSource,
  CadenceStatusSnapshot,
  HeartRateStatusSnapshot,
  SavedDeviceRecord,
  TrainerStatusSnapshot,
} from '../devices/types';
import { WorkoutEngine, WorkoutTickEvent } from '../logic/WorkoutEngine';
import {
  buildActiveGpsRoute,
  CompiledGpsRoute,
  GpsRoutePresetId,
} from '../recording/gpsRoutes';
import type { NormalizedPoint } from '../recording/lineArtTracer';
import { finalizeRecoveryToSavedRide, RideRecorder } from '../recording/rideRecorder';
import {
  appendActiveRideCheckpoint,
  clearActiveRideCheckpoint,
  deleteSavedRide,
  listSavedRides,
  loadUnfinishedRide,
  saveCompletedRide,
} from '../recording/rideStorage';
import {
  liveTelemetryBuffer,
  liveTssTracker,
  rideHistoryBuffer,
} from '../recording/telemetryBuffer';
import {
  formatFitActivityName,
  getSceneryDisplayName,
  SavedRide,
  UnfinishedRideRecovery,
} from '../recording/types';
import { VIRTUAL_START_ALTITUDE_M } from '../recording/virtualGps';
import { getBrowserCompatibility } from '../utils/browserCheck';
import { wakeLockController } from '../utils/wakeLock';
import {
  detectRecommendedQuality,
  graphicsGovernor,
} from '../world/graphicsGovernor';
import { getZoneGradient } from '../world/roadMath';

export type AppScreen = 'menu' | 'library' | 'ride';
export type ModalType = 'devices' | 'settings' | 'summary' | 'rides' | null;
export type SceneryTheme = 'neon-city' | 'palm-grove' | 'cloud-horizon' | 'causeway-embankment';
export type SceneryCycleMinutes = 0 | 5 | 10 | 15;
export type QualityLevel = 'low' | 'medium' | 'high';
export type WorkoutRunState = 'idle' | 'running' | 'paused' | 'completed';
export type RideMode = 'workout' | 'freeride';

export const SCENERY_CYCLE_ORDER: readonly SceneryTheme[] = [
  'neon-city',
  'palm-grove',
  'cloud-horizon',
  'causeway-embankment',
];

export interface RideHistorySample {
  timeSec: number;
  power: number;
  heartRate: number;
  targetWatts: number;
  cadence: number;
}

interface PersistedSettings {
  ftp: number;
  sceneryTheme: SceneryTheme;
  sceneryCycleMinutes: SceneryCycleMinutes;
  gpsRoutePreset: GpsRoutePresetId;
  gpsRouteTargetKm: number;
  customGpsRouteName: string;
  customGpsRoutePoints: NormalizedPoint[];
  customGpsRouteClosed: boolean;
  quality: QualityLevel;
  qualityOverride: QualityLevel | null;
  minimalMode: boolean;
  showDiagnostics: boolean;
  showHoloCards: boolean;
  showFps: boolean;
  showGraph: boolean;
  simulationEnabled: boolean;
  autoPauseEnabled: boolean;
  cadenceMatchingEnabled: boolean;
  audioEnabled: boolean;
  audioMuted: boolean;
  audioMasterVolume: number;
  audioMenuVolume: number;
  audioRideVolume: number;
  musicFollowMode: MusicFollowMode;
}

const STORAGE_KEY = 'neonvelo_settings_v1';
const initialAutoQuality = detectRecommendedQuality();

function loadPersistedSettings(): PersistedSettings {
  const defaults: PersistedSettings = {
    ftp: 250,
    sceneryTheme: 'neon-city',
    sceneryCycleMinutes: 0,
    gpsRoutePreset: 'bike-line-art',
    gpsRouteTargetKm: 15,
    customGpsRouteName: '',
    customGpsRoutePoints: [],
    customGpsRouteClosed: false,
    quality: initialAutoQuality.quality,
    qualityOverride: null,
    minimalMode: false,
    showDiagnostics: false,
    showHoloCards: true,
    showFps: false,
    showGraph: true,
    simulationEnabled: true,
    autoPauseEnabled: true,
    cadenceMatchingEnabled: true,
    audioEnabled: true,
    audioMuted: false,
    audioMasterVolume: DEFAULT_AUDIO_MASTER_VOLUME,
    audioMenuVolume: DEFAULT_AUDIO_MENU_VOLUME,
    audioRideVolume: DEFAULT_AUDIO_RIDE_VOLUME,
    musicFollowMode: 'target',
  };

  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      ftp:
        typeof parsed.ftp === 'number' && parsed.ftp >= 80 && parsed.ftp <= 600
          ? Math.round(parsed.ftp)
          : defaults.ftp,
      sceneryTheme:
        parsed.sceneryTheme === 'neon-city' ||
        parsed.sceneryTheme === 'palm-grove' ||
        parsed.sceneryTheme === 'cloud-horizon' ||
        parsed.sceneryTheme === 'causeway-embankment'
          ? parsed.sceneryTheme
          : defaults.sceneryTheme,
      sceneryCycleMinutes:
        parsed.sceneryCycleMinutes === 0 ||
        parsed.sceneryCycleMinutes === 5 ||
        parsed.sceneryCycleMinutes === 10 ||
        parsed.sceneryCycleMinutes === 15
          ? parsed.sceneryCycleMinutes
          : defaults.sceneryCycleMinutes,
      gpsRoutePreset:
        parsed.gpsRoutePreset === 'urashima-loop' ||
        parsed.gpsRoutePreset === 'bike-line-art' ||
        parsed.gpsRoutePreset === 'custom-drawing'
          ? parsed.gpsRoutePreset
          : defaults.gpsRoutePreset,
      gpsRouteTargetKm:
        typeof parsed.gpsRouteTargetKm === 'number' &&
        Number.isFinite(parsed.gpsRouteTargetKm) &&
        parsed.gpsRouteTargetKm >= 0 &&
        parsed.gpsRouteTargetKm <= 120
          ? Math.round(parsed.gpsRouteTargetKm)
          : defaults.gpsRouteTargetKm,
      customGpsRouteName:
        typeof parsed.customGpsRouteName === 'string'
          ? parsed.customGpsRouteName.slice(0, 64)
          : defaults.customGpsRouteName,
      customGpsRoutePoints: Array.isArray(parsed.customGpsRoutePoints)
        ? parsed.customGpsRoutePoints
            .filter(
              (p): p is NormalizedPoint =>
                Boolean(p) &&
                typeof p.x === 'number' &&
                typeof p.y === 'number' &&
                Number.isFinite(p.x) &&
                Number.isFinite(p.y)
            )
            .slice(0, 600)
        : defaults.customGpsRoutePoints,
      customGpsRouteClosed:
        typeof parsed.customGpsRouteClosed === 'boolean'
          ? parsed.customGpsRouteClosed
          : defaults.customGpsRouteClosed,
      qualityOverride:
        parsed.qualityOverride === 'low' ||
        parsed.qualityOverride === 'medium' ||
        parsed.qualityOverride === 'high'
          ? parsed.qualityOverride
          : null,
      quality:
        parsed.qualityOverride === 'low' ||
        parsed.qualityOverride === 'medium' ||
        parsed.qualityOverride === 'high'
          ? parsed.qualityOverride
          : defaults.quality,
      minimalMode:
        typeof parsed.minimalMode === 'boolean' ? parsed.minimalMode : defaults.minimalMode,
      showDiagnostics:
        typeof parsed.showDiagnostics === 'boolean'
          ? parsed.showDiagnostics
          : defaults.showDiagnostics,
      showHoloCards:
        typeof parsed.showHoloCards === 'boolean'
          ? parsed.showHoloCards
          : defaults.showHoloCards,
      showFps: typeof parsed.showFps === 'boolean' ? parsed.showFps : defaults.showFps,
      showGraph: typeof parsed.showGraph === 'boolean' ? parsed.showGraph : defaults.showGraph,
      simulationEnabled:
        typeof parsed.simulationEnabled === 'boolean'
          ? parsed.simulationEnabled
          : defaults.simulationEnabled,
      autoPauseEnabled:
        typeof parsed.autoPauseEnabled === 'boolean'
          ? parsed.autoPauseEnabled
          : defaults.autoPauseEnabled,
      cadenceMatchingEnabled:
        typeof parsed.cadenceMatchingEnabled === 'boolean'
          ? parsed.cadenceMatchingEnabled
          : defaults.cadenceMatchingEnabled,
      audioEnabled:
        typeof parsed.audioEnabled === 'boolean' ? parsed.audioEnabled : defaults.audioEnabled,
      audioMuted:
        typeof parsed.audioMuted === 'boolean' ? parsed.audioMuted : defaults.audioMuted,
      audioMasterVolume: clampAudioVolume(parsed.audioMasterVolume, defaults.audioMasterVolume),
      audioMenuVolume: clampAudioVolume(parsed.audioMenuVolume, defaults.audioMenuVolume),
      audioRideVolume: clampAudioVolume(parsed.audioRideVolume, defaults.audioRideVolume),
      musicFollowMode:
        parsed.musicFollowMode === 'target' || parsed.musicFollowMode === 'actual'
          ? parsed.musicFollowMode
          : defaults.musicFollowMode,
    };
  } catch {
    return defaults;
  }
}

function savePersistedSettings(settings: PersistedSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors
  }
}

export interface AppState {
  // Navigation & modals
  screen: AppScreen;
  activeModal: ModalType;
  leftDrawerOpen: boolean;

  // Persisted settings
  ftp: number;
  intensityOffsetPct: number;
  sceneryTheme: SceneryTheme;
  sceneryCycleMinutes: SceneryCycleMinutes;
  gpsRoutePreset: GpsRoutePresetId;
  gpsRouteTargetKm: number;
  customGpsRouteName: string;
  customGpsRoutePoints: NormalizedPoint[];
  customGpsRouteClosed: boolean;
  quality: QualityLevel;
  qualityOverride: QualityLevel | null;
  autoDetectedQuality: QualityLevel;
  autoQualityReason: string;
  minimalMode: boolean;
  showDiagnostics: boolean;
  showHoloCards: boolean;
  showFps: boolean;
  showGraph: boolean;
  simulationEnabled: boolean;
  autoPauseEnabled: boolean;
  cadenceMatchingEnabled: boolean;
  audioEnabled: boolean;
  audioMuted: boolean;
  audioMasterVolume: number;
  audioMenuVolume: number;
  audioRideVolume: number;
  musicFollowMode: MusicFollowMode;
  musicTestZone: MusicZone | null;

  // Derived GPS Art route & mid-ride scenery tracking
  activeGpsRoute: CompiledGpsRoute | null;
  visitedSceneries: SceneryTheme[];
  sceneryCycleElapsedSec: number;

  // Ride mode & Free Ride state
  rideMode: RideMode;
  freeRideZone: ZoneNumber;
  freeRideOffsetWatts: number;
  freeRideTerrain: FreeRideTerrainProfile;
  freeRideGrade: number;
  freeRideTargetWatts: number;

  // Auto-pause runtime tracking
  autoPaused: boolean;
  zeroPedalSec: number;

  // Workout catalog & active workout
  workouts: ParsedWorkout[];
  activeWorkout: ParsedWorkout;
  runState: WorkoutRunState;
  elapsedSec: number;
  activeSnapshot: ActiveStepSnapshot | null;
  intervalPulseCount: number;

  // Live telemetry
  instantPower: number;
  power3sAvg: number;
  cadence: number;
  cadenceTimestampMs: number;
  cadenceSource: CadenceSource;
  cadenceSensorRpm: number;
  speedKmh: number;
  heartRate: number;
  liveTss: number;
  totalWorkKj: number;
  calories: number;
  fps: number;

  // Device status
  trainerStatus: TrainerStatusSnapshot;
  hrStatus: HeartRateStatusSnapshot;
  cadenceStatus: CadenceStatusSnapshot;
  savedDevices: SavedDeviceRecord[];
  silentReconnectAvailable: boolean;
  reconnectingLastDevices: boolean;

  // Version counter for preallocated typed-array RideHistoryBuffer (avoids O(N) copies)
  historyVersion: number;
  lastResumeGapSec: number;

  // Live ride recording & persisted completed rides (for FIT export / Strava upload)
  rideStartTimeMs: number | null;
  rideDistanceM: number;
  rideAltitudeM: number;
  rideAscentM: number;
  rideLapCount: number;
  lastCompletedRide: SavedRide | null;
  savedRides: SavedRide[];
  unfinishedRide: UnfinishedRideRecovery | null;

  // Actions
  setScreen: (screen: AppScreen) => void;
  setActiveModal: (modal: ModalType) => void;
  setLeftDrawerOpen: (open: boolean) => void;

  selectWorkout: (workoutId: string, openRide?: boolean) => void;
  startFreeRide: (initialZone?: ZoneNumber, autoStart?: boolean) => void;
  setFreeRideZone: (zone: ZoneNumber) => void;
  adjustFreeRideWatts: (deltaWatts: number) => void;
  resetFreeRideOffset: () => void;

  startWorkout: () => void;
  pauseWorkout: (isAuto?: boolean) => void;
  resumeWorkout: () => void;
  togglePlayPause: () => void;
  skipStep: () => void;
  previousStep: () => void;
  jumpToStep: (stepIndex: number) => void;
  seekToTime: (elapsedSec: number) => void;
  endWorkout: () => void;
  resetWorkout: () => void;

  setFtp: (ftp: number) => void;
  adjustIntensity: (deltaPct: number) => void;
  resetIntensityOffset: () => void;
  setSceneryTheme: (theme: SceneryTheme) => void;
  setSceneryCycleMinutes: (minutes: SceneryCycleMinutes) => void;
  cycleNextScenery: () => void;
  setGpsRoutePreset: (preset: GpsRoutePresetId) => void;
  setGpsRouteTargetKm: (km: number) => void;
  setCustomGpsRoute: (name: string, points: NormalizedPoint[], closedLoop: boolean) => void;
  setQuality: (quality: QualityLevel) => void;
  setQualityAuto: () => void;
  setMinimalMode: (enabled: boolean) => void;
  setShowDiagnostics: (show: boolean) => void;
  setShowHoloCards: (show: boolean) => void;
  setShowFps: (show: boolean) => void;
  setShowGraph: (show: boolean) => void;
  toggleGraph: () => void;
  setAutoPauseEnabled: (enabled: boolean) => void;
  setCadenceMatchingEnabled: (enabled: boolean) => void;
  setAudioEnabled: (enabled: boolean) => void;
  toggleAudioMute: () => void;
  setAudioMasterVolume: (volume: number) => void;
  setAudioMenuVolume: (volume: number) => void;
  setAudioRideVolume: (volume: number) => void;
  setMusicFollowMode: (mode: MusicFollowMode) => void;
  setMusicTestZone: (zone: MusicZone | null) => void;
  setFps: (fps: number) => void;

  setSimulationEnabled: (enabled: boolean) => Promise<void>;
  connectTrainer: () => Promise<void>;
  connectBleTrainer: () => Promise<void>;
  disconnectTrainer: () => Promise<void>;
  connectHeartRate: () => Promise<void>;
  connectBleHeartRate: () => Promise<void>;
  disconnectHeartRate: () => Promise<void>;
  connectBleCadence: () => Promise<void>;
  disconnectCadence: () => Promise<void>;
  reconnectLastDevices: () => Promise<void>;
  forgetSavedDevice: (deviceId: string) => void;
  refreshSavedRides: () => Promise<void>;
  deleteSavedRideById: (rideId: string) => Promise<void>;
  markRideUploadedToStrava: (rideId: string, stravaActivityId?: number | null) => Promise<void>;
  resumeUnfinishedRide: () => void;
  saveUnfinishedRide: () => Promise<void>;
  discardUnfinishedRide: () => Promise<void>;
  initSession: () => void;
}

const initialSettings = loadPersistedSettings();
const initialWorkout = BUILT_IN_WORKOUTS[0];

const rideRecorder = new RideRecorder();
let deviceManager: DeviceManager | null = null;
let hudSyncTimer: number | null = null;
let initialized = false;

export const HUD_SYNC_INTERVAL_MS = 250; // ~4 Hz HUD state flush

export function getRecordingDiagnostics(): {
  maxSampleGapMs: number;
  filledSampleCount: number;
  lastErgWriteLatencyMs: number | null;
} {
  return {
    maxSampleGapMs: rideRecorder.getMaxSampleGapMs(),
    filledSampleCount: rideRecorder.getFilledSampleCount(),
    lastErgWriteLatencyMs: deviceManager?.getLastErgWriteLatencyMs() ?? null,
  };
}

function flushTelemetryBufferToHud(): void {
  if (!liveTelemetryBuffer.dirty) return;
  liveTelemetryBuffer.dirty = false;
  const s = useAppStore.getState();
  const nextPower = liveTelemetryBuffer.instantPower;
  const nextPower3s = liveTelemetryBuffer.power3sAvg;
  const nextHr = liveTelemetryBuffer.heartRate;
  const nextCadence = liveTelemetryBuffer.cadence;
  const nextCadSensor = liveTelemetryBuffer.cadenceSensorRpm;
  const nextCadTs = liveTelemetryBuffer.cadenceTimestampMs;
  const nextCadSrc = liveTelemetryBuffer.cadenceSource;
  const nextSpeed = liveTelemetryBuffer.speedKmh;

  if (
    s.instantPower === nextPower &&
    s.power3sAvg === nextPower3s &&
    s.heartRate === nextHr &&
    s.cadence === nextCadence &&
    s.cadenceSensorRpm === nextCadSensor &&
    s.cadenceTimestampMs === nextCadTs &&
    s.cadenceSource === nextCadSrc &&
    s.speedKmh === nextSpeed
  ) {
    return;
  }

  useAppStore.setState({
    instantPower: nextPower,
    power3sAvg: nextPower3s,
    heartRate: nextHr,
    cadence: nextCadence,
    cadenceSensorRpm: nextCadSensor,
    cadenceTimestampMs: nextCadTs,
    cadenceSource: nextCadSrc,
    speedKmh: nextSpeed,
  });
}

function startHudSyncTimer(): void {
  if (hudSyncTimer !== null || typeof window === 'undefined') return;
  hudSyncTimer = window.setInterval(flushTelemetryBufferToHud, HUD_SYNC_INTERVAL_MS);
}

const workoutEngine = new WorkoutEngine(initialWorkout, {
  ftp: initialSettings.ftp,
  intensityOffsetPct: 0,
  useWorker: typeof window !== 'undefined',
});

const initialSnap = workoutEngine.getSnapshot();
const initialFreeRideTerrain = createFreeRideTerrain();
const initialFreeRideGrade = sampleFreeRideGrade(initialFreeRideTerrain, 0);
const initialFreeRideTargetWatts = computeFreeRideTargetWatts(
  2,
  initialSettings.ftp,
  0,
  initialFreeRideGrade
);

function resolveTargetDistanceKm(
  targetKm: number,
  rideMode: RideMode,
  workoutDurationSec: number
): number {
  if (targetKm > 0) return targetKm;
  // Auto-Fit (0): estimate realistic ride distance (~32 km/h) for workout duration, or 15 km for Free Ride
  if (rideMode === 'workout' && workoutDurationSec > 0) {
    return Math.max(3, Math.round(((workoutDurationSec / 3600) * 32) * 10) / 10);
  }
  return 15;
}

function compileActiveRouteFromConfig(cfg: {
  gpsRoutePreset: GpsRoutePresetId;
  gpsRouteTargetKm: number;
  customGpsRouteName: string;
  customGpsRoutePoints: NormalizedPoint[];
  customGpsRouteClosed: boolean;
  rideMode: RideMode;
  workoutDurationSec: number;
}): CompiledGpsRoute | null {
  return buildActiveGpsRoute({
    presetId: cfg.gpsRoutePreset,
    targetDistanceKm: resolveTargetDistanceKm(
      cfg.gpsRouteTargetKm,
      cfg.rideMode,
      cfg.workoutDurationSec
    ),
    customName: cfg.customGpsRouteName,
    customPoints: cfg.customGpsRoutePoints,
    customClosedLoop: cfg.customGpsRouteClosed,
  });
}

const initialActiveGpsRoute = compileActiveRouteFromConfig({
  gpsRoutePreset: initialSettings.gpsRoutePreset,
  gpsRouteTargetKm: initialSettings.gpsRouteTargetKm,
  customGpsRouteName: initialSettings.customGpsRouteName,
  customGpsRoutePoints: initialSettings.customGpsRoutePoints,
  customGpsRouteClosed: initialSettings.customGpsRouteClosed,
  rideMode: 'workout',
  workoutDurationSec: initialWorkout.totalDuration,
});

function buildCurrentActivityMeta(state: {
  rideMode: RideMode;
  activeWorkout: ParsedWorkout;
  sceneryTheme: SceneryTheme;
  visitedSceneries: SceneryTheme[];
}): { activityName: string; sceneryName: string } {
  const visited =
    state.visitedSceneries.length > 0 ? state.visitedSceneries : [state.sceneryTheme];
  const unique = Array.from(new Set(visited));
  const sceneryName =
    unique.length > 1
      ? `${getSceneryDisplayName(unique[0])} + ${unique.length - 1} Worlds`
      : getSceneryDisplayName(unique[0] ?? state.sceneryTheme);
  const activityName = formatFitActivityName({
    rideMode: state.rideMode,
    workoutName: state.activeWorkout.name,
    sceneryTheme: state.sceneryTheme,
    visitedSceneries: unique,
  });
  return { activityName, sceneryName };
}

function flushActiveRideCheckpoint(force = false): void {
  if (rideRecorder.getStartTimeMs() === null) return;
  const s = useAppStore.getState();
  const payload = rideRecorder.extractCheckpointDelta(
    {
      rideMode: s.rideMode,
      sceneryTheme: s.sceneryTheme,
      visitedSceneries: s.visitedSceneries,
      elapsedSec: s.elapsedSec,
      freeRideZone: s.freeRideZone,
      freeRideOffsetWatts: s.freeRideOffsetWatts,
      nowMs: Date.now(),
    },
    force
  );
  if (!payload) return;
  void appendActiveRideCheckpoint(payload.meta, payload.chunk);
}

function finalizeAndPersistCurrentRide(endTimeMs = Date.now()): SavedRide | null {
  const sessionId = rideRecorder.getSessionId();
  const completed = rideRecorder.finalize(endTimeMs);
  if (!completed) return null;
  const existing = useAppStore.getState().savedRides.filter((r) => r.id !== completed.id);
  useAppStore.setState({
    lastCompletedRide: completed,
    savedRides: [completed, ...existing],
    unfinishedRide: null,
  });
  void saveCompletedRide(completed);
  void clearActiveRideCheckpoint(sessionId || undefined);
  return completed;
}

function ensureDeviceManager(): DeviceManager {
  if (deviceManager) return deviceManager;
  startHudSyncTimer();
  deviceManager = new DeviceManager({
    onTrainerTelemetry: (data) => {
      // Zero-allocation write directly into module-level ring buffer (no React setState here)
      const state = useAppStore.getState();
      const dedicatedCadenceConnected = state.cadenceStatus.status === 'connected';
      const trainerCadenceSource: CadenceSource = state.trainerStatus.isSimulated
        ? 'simulated'
        : 'ble-trainer';

      liveTelemetryBuffer.pushTrainer(
        data.instantPower,
        data.cadence,
        data.speedKmh,
        data.timestampMs,
        trainerCadenceSource,
        dedicatedCadenceConnected
      );

      // Automatically resume if the rider was auto-paused and starts pedalling again
      if (
        state.autoPauseEnabled &&
        state.runState === 'paused' &&
        state.autoPaused &&
        (data.instantPower > 0 || liveTelemetryBuffer.cadence > 0)
      ) {
        state.resumeWorkout();
      }
    },
    onTrainerStatus: (trainerStatus) => {
      const state = useAppStore.getState();
      const nextSource: CadenceSource =
        state.cadenceStatus.status === 'connected'
          ? 'ble-cadence'
          : trainerStatus.status === 'connected'
            ? trainerStatus.isSimulated
              ? 'simulated'
              : 'ble-trainer'
            : 'none';
      liveTelemetryBuffer.cadenceSource = nextSource;
      useAppStore.setState({ trainerStatus, cadenceSource: nextSource });
    },
    onHeartRateTelemetry: (data) => {
      // Zero-allocation direct write into ring buffer (flushed to HUD at ~4 Hz)
      liveTelemetryBuffer.pushHeartRate(data.heartRate, data.timestampMs);
    },
    onHeartRateStatus: (hrStatus) => {
      useAppStore.setState({ hrStatus });
    },
    onCadenceTelemetry: (data) => {
      // Zero-allocation direct write into ring buffer (flushed to HUD at ~4 Hz)
      liveTelemetryBuffer.pushCadence(data.cadenceRpm, data.timestampMs);

      const state = useAppStore.getState();
      if (
        state.autoPauseEnabled &&
        state.runState === 'paused' &&
        state.autoPaused &&
        liveTelemetryBuffer.cadence > 0
      ) {
        state.resumeWorkout();
      }
    },
    onCadenceStatus: (cadenceStatus) => {
      const state = useAppStore.getState();
      const nextSource: CadenceSource =
        cadenceStatus.status === 'connected'
          ? 'ble-cadence'
          : state.trainerStatus.status === 'connected'
            ? state.trainerStatus.isSimulated
              ? 'simulated'
              : 'ble-trainer'
            : 'none';
      liveTelemetryBuffer.cadenceSource = nextSource;
      if (cadenceStatus.status !== 'connected') {
        liveTelemetryBuffer.clearCadence(state.trainerStatus.status === 'connected');
      }
      useAppStore.setState({
        cadenceStatus,
        cadenceSource: nextSource,
        ...(cadenceStatus.status !== 'connected' ? { cadenceSensorRpm: 0 } : {}),
      });
    },
    onSavedDevicesChange: (savedDevices) => {
      useAppStore.setState({ savedDevices });
    },
    getFtp: () => useAppStore.getState().ftp,
    getRecoveryErgState: () => {
      const s = useAppStore.getState();
      const targetWatts =
        s.rideMode === 'freeride'
          ? s.freeRideTargetWatts
          : s.activeSnapshot?.targetWatts ?? null;
      return {
        isRunning: s.runState === 'running',
        targetWatts,
      };
    },
  });
  return deviceManager;
}

function handleEngineStateUpdate(event: WorkoutTickEvent): void {
  const state = useAppStore.getState();
  if (state.runState !== 'running' && event.runState !== 'completed') return;
  if (!event.snapshot) return;

  const dtSec = Math.max(0, event.dtSec);
  // Sample live telemetry directly from the zero-allocation ring buffer
  const powerNow = liveTelemetryBuffer.instantPower;
  const power3sNow = liveTelemetryBuffer.power3sAvg;
  const hrNow = liveTelemetryBuffer.heartRate;
  const cadenceNow = liveTelemetryBuffer.cadence;
  const speedNow = liveTelemetryBuffer.speedKmh;

  // Evaluate 5-second zero-pedalling auto-pause while running
  const autoPauseEval = evaluateAutoPause({
    enabled: state.autoPauseEnabled,
    isRunning: state.runState === 'running',
    isAutoPaused: state.autoPaused,
    instantPower: powerNow,
    cadence: cadenceNow,
    dtSec,
    zeroPedalSec: state.zeroPedalSec,
  });

  if (autoPauseEval.shouldAutoPause) {
    useAppStore.setState({ zeroPedalSec: autoPauseEval.zeroPedalSec });
    state.pauseWorkout(true);
    return;
  }

  // Compute live target watts and road grade based on ride mode
  let targetWatts = event.snapshot.targetWatts;
  let gradePct = getZoneGradient(event.snapshot.zone.zone, state.sceneryTheme) * 100;
  let nextFreeRideGrade = state.freeRideGrade;
  let nextFreeRideTargetWatts = state.freeRideTargetWatts;
  let stepIndexForRecord = event.snapshot.stepIndex;
  let stepLabelForRecord = event.snapshot.step.label;

  if (state.rideMode === 'freeride') {
    nextFreeRideGrade = sampleFreeRideGrade(state.freeRideTerrain, state.rideDistanceM);
    nextFreeRideTargetWatts = computeFreeRideTargetWatts(
      state.freeRideZone,
      state.ftp,
      state.freeRideOffsetWatts,
      nextFreeRideGrade
    );
    targetWatts = nextFreeRideTargetWatts;
    gradePct = nextFreeRideGrade * 100;
    const zoneInfo = COGGAN_ZONES[state.freeRideZone];
    stepIndexForRecord = state.freeRideZone;
    stepLabelForRecord = `Free Ride · ${zoneInfo.code} ${zoneInfo.name}`;

    if (Math.abs(nextFreeRideTargetWatts - state.freeRideTargetWatts) >= 1) {
      const dm = ensureDeviceManager();
      void dm.sendErgTarget(nextFreeRideTargetWatts, event.nowMs);
    }
  }

  // Record 1 Hz telemetry on wall-clock seconds, explicitly filling any missed seconds
  const emittedSamples = rideRecorder.recordOnWallClock({
    timestampMs: event.nowMs,
    dtSec,
    elapsedSec: event.elapsedSec,
    power: powerNow,
    heartRate: hrNow,
    cadence: cadenceNow,
    speedKmh: speedNow,
    gradePct,
    stepIndex: stepIndexForRecord,
    stepLabel: stepLabelForRecord,
  });

  // Push into preallocated typed-array history buffer & O(1) incremental TSS tracker
  for (let i = 0; i < emittedSamples.length; i++) {
    const rec = emittedSamples[i];
    if (rec.filled || dtSec >= 0.5) {
      liveTssTracker.pushPower(rec.power);
    }
    rideHistoryBuffer.push(
      Math.round(rec.elapsedSec),
      rec.filled ? rec.power : power3sNow || rec.power,
      rec.heartRate,
      targetWatts,
      rec.cadence
    );
  }

  const totalWorkKj = rideRecorder.getTotalWorkKj();
  const calories = calculateCaloriesFromKj(totalWorkKj);
  const liveTss = liveTssTracker.getLiveTss(state.ftp);

  // Optional mid-ride automatic scenery rotation (Off / 5 min / 10 min / 15 min)
  let nextSceneryTheme = state.sceneryTheme;
  let nextVisitedSceneries = state.visitedSceneries;
  let nextCycleElapsedSec = state.sceneryCycleElapsedSec;

  if (state.sceneryCycleMinutes > 0 && state.runState === 'running') {
    nextCycleElapsedSec += dtSec;
    const cyclePeriodSec = state.sceneryCycleMinutes * 60;
    if (nextCycleElapsedSec >= cyclePeriodSec) {
      nextCycleElapsedSec = 0;
      const curIdx = SCENERY_CYCLE_ORDER.indexOf(state.sceneryTheme);
      nextSceneryTheme = SCENERY_CYCLE_ORDER[(curIdx + 1) % SCENERY_CYCLE_ORDER.length];
      nextVisitedSceneries = state.visitedSceneries.includes(nextSceneryTheme)
        ? state.visitedSceneries
        : [...state.visitedSceneries, nextSceneryTheme];
      const meta = buildCurrentActivityMeta({
        rideMode: state.rideMode,
        activeWorkout: state.activeWorkout,
        sceneryTheme: nextSceneryTheme,
        visitedSceneries: nextVisitedSceneries,
      });
      rideRecorder.updateMeta(state.ftp, meta.activityName, meta.sceneryName);
    }
  }

  useAppStore.setState({
    elapsedSec: event.elapsedSec,
    activeSnapshot: event.snapshot,
    totalWorkKj,
    calories,
    liveTss,
    historyVersion: rideHistoryBuffer.version,
    lastResumeGapSec: event.resumeGapSec && event.resumeGapSec > 0 ? event.resumeGapSec : state.lastResumeGapSec,
    zeroPedalSec: autoPauseEval.zeroPedalSec,
    freeRideGrade: nextFreeRideGrade,
    freeRideTargetWatts: nextFreeRideTargetWatts,
    sceneryTheme: nextSceneryTheme,
    visitedSceneries: nextVisitedSceneries,
    sceneryCycleElapsedSec: nextCycleElapsedSec,
    rideStartTimeMs: rideRecorder.getStartTimeMs(),
    rideDistanceM: rideRecorder.getDistanceM(),
    rideAltitudeM: rideRecorder.getAltitudeM(),
    rideAscentM: rideRecorder.getTotalAscentM(),
    rideLapCount: rideRecorder.getLapCount(),
    intervalPulseCount: event.stepChanged
      ? state.intervalPulseCount + 1
      : state.intervalPulseCount,
  });

  // Append-only IndexedDB checkpoint every ~7 seconds without blocking the main thread
  if (rideRecorder.shouldCheckpoint(event.nowMs)) {
    flushActiveRideCheckpoint(false);
  }
}

let finishSummaryTimer: ReturnType<typeof setTimeout> | null = null;

function clearFinishSummaryTimer(): void {
  if (finishSummaryTimer !== null) {
    clearTimeout(finishSummaryTimer);
    finishSummaryTimer = null;
  }
}

workoutEngine.setCallbacks({
  onStateUpdate: handleEngineStateUpdate,
  onErgCommand: ({ targetWatts, reason, nowMs }) => {
    const dm = ensureDeviceManager();
    const state = useAppStore.getState();
    const resolvedTarget =
      state.rideMode === 'freeride' ? state.freeRideTargetWatts : targetWatts;
    void dm.sendErgTarget(resolvedTarget, reason === 'step-change' ? nowMs : undefined);
  },
  onComplete: ({ elapsedSec, snapshot, nowMs }) => {
    const dm = ensureDeviceManager();
    void dm.stopTrainer();
    void wakeLockController.release();
    clearFinishSummaryTimer();
    finalizeAndPersistCurrentRide(nowMs);
    const prevPulse = useAppStore.getState().intervalPulseCount;
    useAppStore.setState({
      elapsedSec,
      activeSnapshot: snapshot,
      runState: 'completed',
      intervalPulseCount: prevPulse + 1,
    });
    // Let the cyclist glide cleanly underneath the floating Finish Sign before presenting the summary
    finishSummaryTimer = setTimeout(() => {
      finishSummaryTimer = null;
      const cur = useAppStore.getState();
      if (cur.runState === 'completed' && cur.screen === 'ride' && cur.activeModal === null) {
        useAppStore.setState({ activeModal: 'summary' });
      }
    }, 2000);
  },
});

function persistFromStore(): void {
  const s = useAppStore.getState();
  savePersistedSettings({
    ftp: s.ftp,
    sceneryTheme: s.sceneryTheme,
    sceneryCycleMinutes: s.sceneryCycleMinutes,
    gpsRoutePreset: s.gpsRoutePreset,
    gpsRouteTargetKm: s.gpsRouteTargetKm,
    customGpsRouteName: s.customGpsRouteName,
    customGpsRoutePoints: s.customGpsRoutePoints,
    customGpsRouteClosed: s.customGpsRouteClosed,
    quality: s.quality,
    qualityOverride: s.qualityOverride,
    minimalMode: s.minimalMode,
    showDiagnostics: s.showDiagnostics,
    showHoloCards: s.showHoloCards,
    showFps: s.showFps,
    showGraph: s.showGraph,
    simulationEnabled: s.simulationEnabled,
    autoPauseEnabled: s.autoPauseEnabled,
    cadenceMatchingEnabled: s.cadenceMatchingEnabled,
    audioEnabled: s.audioEnabled,
    audioMuted: s.audioMuted,
    audioMasterVolume: s.audioMasterVolume,
    audioMenuVolume: s.audioMenuVolume,
    audioRideVolume: s.audioRideVolume,
    musicFollowMode: s.musicFollowMode,
  });
}

export const useAppStore = create<AppState>((set, get) => ({
  screen: 'menu',
  activeModal: null,
  leftDrawerOpen: false,

  ftp: initialSettings.ftp,
  intensityOffsetPct: 0,
  sceneryTheme: initialSettings.sceneryTheme,
  sceneryCycleMinutes: initialSettings.sceneryCycleMinutes,
  gpsRoutePreset: initialSettings.gpsRoutePreset,
  gpsRouteTargetKm: initialSettings.gpsRouteTargetKm,
  customGpsRouteName: initialSettings.customGpsRouteName,
  customGpsRoutePoints: initialSettings.customGpsRoutePoints,
  customGpsRouteClosed: initialSettings.customGpsRouteClosed,
  quality: initialSettings.quality,
  qualityOverride: initialSettings.qualityOverride,
  autoDetectedQuality: initialAutoQuality.quality,
  autoQualityReason: initialAutoQuality.reason,
  minimalMode: initialSettings.minimalMode,
  showDiagnostics: initialSettings.showDiagnostics,
  showHoloCards: initialSettings.showHoloCards,
  showFps: initialSettings.showFps,
  showGraph: initialSettings.showGraph,
  simulationEnabled: initialSettings.simulationEnabled,
  autoPauseEnabled: initialSettings.autoPauseEnabled,
  cadenceMatchingEnabled: initialSettings.cadenceMatchingEnabled,
  audioEnabled: initialSettings.audioEnabled,
  audioMuted: initialSettings.audioMuted,
  audioMasterVolume: initialSettings.audioMasterVolume,
  audioMenuVolume: initialSettings.audioMenuVolume,
  audioRideVolume: initialSettings.audioRideVolume,
  musicFollowMode: initialSettings.musicFollowMode,
  musicTestZone: null,

  activeGpsRoute: initialActiveGpsRoute,
  visitedSceneries: [initialSettings.sceneryTheme],
  sceneryCycleElapsedSec: 0,

  rideMode: 'workout',
  freeRideZone: 2,
  freeRideOffsetWatts: 0,
  freeRideTerrain: initialFreeRideTerrain,
  freeRideGrade: initialFreeRideGrade,
  freeRideTargetWatts: initialFreeRideTargetWatts,

  autoPaused: false,
  zeroPedalSec: 0,

  workouts: BUILT_IN_WORKOUTS,
  activeWorkout: initialWorkout,
  runState: 'idle',
  elapsedSec: 0,
  activeSnapshot: initialSnap,
  intervalPulseCount: 0,

  instantPower: 0,
  power3sAvg: 0,
  cadence: 0,
  cadenceTimestampMs: 0,
  cadenceSource: 'none',
  cadenceSensorRpm: 0,
  speedKmh: 0,
  heartRate: 68,
  liveTss: 0,
  totalWorkKj: 0,
  calories: 0,
  fps: 60,

  trainerStatus: {
    status: 'disconnected',
    deviceId: 'sim-kickr-v4',
    deviceName: 'Simulated KICKR V4 (FTMS)',
    ergControlActive: false,
    ergControlWarning: null,
    signalStrength: 0,
    isSimulated: true,
  },
  hrStatus: {
    status: 'disconnected',
    deviceId: 'sim-hrm-chest',
    deviceName: 'Simulated HRM Strap',
    signalStrength: 0,
    isSimulated: true,
    errorMessage: null,
  },
  cadenceStatus: {
    status: 'disconnected',
    deviceId: null,
    deviceName: null,
    signalStrength: 0,
    isSimulated: false,
    errorMessage: null,
  },
  savedDevices: [],
  silentReconnectAvailable: false,
  reconnectingLastDevices: false,

  historyVersion: 0,
  lastResumeGapSec: 0,

  rideStartTimeMs: null,
  rideDistanceM: 0,
  rideAltitudeM: VIRTUAL_START_ALTITUDE_M,
  rideAscentM: 0,
  rideLapCount: 0,
  lastCompletedRide: null,
  savedRides: [],
  unfinishedRide: null,

  initSession: () => {
    if (initialized) return;
    initialized = true;
    graphicsGovernor.setBaseQuality(get().quality);
    graphicsGovernor.startLongTaskObserver();
    const dm = ensureDeviceManager();
    set({
      savedDevices: dm.getSavedDevices(),
      silentReconnectAvailable: dm.isSilentAutoReconnectAvailable(),
    });
    const { simulationEnabled } = get();
    if (simulationEnabled) {
      void dm.connectAllSimulated();
    }
    if (dm.getSavedDevices().length > 0 && dm.isSilentAutoReconnectAvailable()) {
      void dm.attemptSilentAutoReconnect().then((res) => {
        if (res.trainer) {
          set({ simulationEnabled: false });
          persistFromStore();
        }
      });
    }
    void get().refreshSavedRides();

    // Check IndexedDB for any unfinished ride from a previous crash/reload
    void loadUnfinishedRide().then((recovery) => {
      if (
        recovery &&
        (recovery.samples.length > 0 || recovery.meta.elapsedSec >= 1) &&
        rideRecorder.getStartTimeMs() === null
      ) {
        set({ unfinishedRide: recovery });
      }
    });

    // Flush any pending in-progress ride samples when the tab is backgrounded or unloaded
    if (typeof window !== 'undefined') {
      const flushIfActive = () => {
        if (rideRecorder.getStartTimeMs() !== null && get().runState !== 'completed') {
          flushActiveRideCheckpoint(true);
        }
      };
      window.addEventListener('pagehide', flushIfActive);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) flushIfActive();
      });

      const params = new URLSearchParams(window.location.search);
      if (params.get('freeride') === '1') {
        get().startFreeRide(2, true);
      } else if (params.get('finishPreview') === '1') {
        const dur = get().activeWorkout.totalDuration;
        set({ screen: 'ride', rideMode: 'workout' });
        window.setTimeout(() => {
          get().seekToTime(Math.max(0, dur - 7));
          get().startWorkout();
        }, 250);
      } else if (params.get('autostart') === '1') {
        set({ screen: 'ride', rideMode: 'workout' });
        window.setTimeout(() => {
          get().startWorkout();
        }, 250);
      }
    }
  },

  setScreen: (screen) => set({ screen }),
  setActiveModal: (activeModal) =>
    set((state) => ({
      activeModal,
      musicTestZone: activeModal === 'settings' ? state.musicTestZone : null,
    })),
  setLeftDrawerOpen: (leftDrawerOpen) => set({ leftDrawerOpen }),

  selectWorkout: (workoutId, openRide = false) => {
    const state = get();
    const found = state.workouts.find((w) => w.id === workoutId);
    if (!found) return;
    clearFinishSummaryTimer();
    liveTelemetryBuffer.resetRollingPower();
    rideHistoryBuffer.reset();
    liveTssTracker.reset();
    rideRecorder.reset();
    const snap = workoutEngine.loadWorkout(found, {
      ftp: state.ftp,
      intensityOffsetPct: state.intensityOffsetPct,
    });
    const activeGpsRoute = compileActiveRouteFromConfig({
      gpsRoutePreset: state.gpsRoutePreset,
      gpsRouteTargetKm: state.gpsRouteTargetKm,
      customGpsRouteName: state.customGpsRouteName,
      customGpsRoutePoints: state.customGpsRoutePoints,
      customGpsRouteClosed: state.customGpsRouteClosed,
      rideMode: 'workout',
      workoutDurationSec: found.totalDuration,
    });
    set({
      rideMode: 'workout',
      activeWorkout: found,
      activeGpsRoute,
      visitedSceneries: [state.sceneryTheme],
      sceneryCycleElapsedSec: 0,
      runState: 'idle',
      elapsedSec: 0,
      activeSnapshot: snap,
      historyVersion: rideHistoryBuffer.version,
      lastResumeGapSec: 0,
      totalWorkKj: 0,
      calories: 0,
      liveTss: 0,
      autoPaused: false,
      zeroPedalSec: 0,
      rideStartTimeMs: null,
      rideDistanceM: 0,
      rideAltitudeM: VIRTUAL_START_ALTITUDE_M,
      rideAscentM: 0,
      rideLapCount: 0,
      intervalPulseCount: 0,
      screen: openRide ? 'ride' : state.screen,
    });
  },

  startFreeRide: (initialZone = 2, autoStart = false) => {
    clearFinishSummaryTimer();
    liveTelemetryBuffer.resetRollingPower();
    rideHistoryBuffer.reset();
    liveTssTracker.reset();
    rideRecorder.reset();
    const state = get();
    const terrain = createFreeRideTerrain();
    const grade = sampleFreeRideGrade(terrain, 0);
    const ftp = state.ftp;
    const targetWatts = computeFreeRideTargetWatts(initialZone, ftp, 0, grade);
    const snap = workoutEngine.loadWorkout(FREE_RIDE_SESSION_WORKOUT, {
      ftp,
      intensityOffsetPct: 0,
    });
    const activeGpsRoute = compileActiveRouteFromConfig({
      gpsRoutePreset: state.gpsRoutePreset,
      gpsRouteTargetKm: state.gpsRouteTargetKm,
      customGpsRouteName: state.customGpsRouteName,
      customGpsRoutePoints: state.customGpsRoutePoints,
      customGpsRouteClosed: state.customGpsRouteClosed,
      rideMode: 'freeride',
      workoutDurationSec: 0,
    });
    set({
      rideMode: 'freeride',
      activeGpsRoute,
      visitedSceneries: [state.sceneryTheme],
      sceneryCycleElapsedSec: 0,
      freeRideZone: initialZone,
      freeRideOffsetWatts: 0,
      freeRideTerrain: terrain,
      freeRideGrade: grade,
      freeRideTargetWatts: targetWatts,
      runState: 'idle',
      elapsedSec: 0,
      activeSnapshot: snap,
      historyVersion: rideHistoryBuffer.version,
      lastResumeGapSec: 0,
      totalWorkKj: 0,
      calories: 0,
      liveTss: 0,
      autoPaused: false,
      zeroPedalSec: 0,
      rideStartTimeMs: null,
      rideDistanceM: 0,
      rideAltitudeM: VIRTUAL_START_ALTITUDE_M,
      rideAscentM: 0,
      rideLapCount: 0,
      activeModal: null,
      intervalPulseCount: 0,
      screen: 'ride',
    });
    if (autoStart) {
      window.setTimeout(() => {
        get().startWorkout();
      }, 250);
    }
  },

  setFreeRideZone: (zone) => {
    const state = get();
    const targetWatts = computeFreeRideTargetWatts(zone, state.ftp, 0, state.freeRideGrade);
    const zoneInfo = COGGAN_ZONES[zone];
    if (rideRecorder.getStartTimeMs() !== null) {
      rideRecorder.markStepChange(zone, `Free Ride · ${zoneInfo.code} ${zoneInfo.name}`, Date.now());
    }
    set({
      freeRideZone: zone,
      freeRideOffsetWatts: 0,
      freeRideTargetWatts: targetWatts,
      rideLapCount: rideRecorder.getLapCount(),
      intervalPulseCount: state.intervalPulseCount + 1,
    });
    if (state.runState === 'running') {
      void ensureDeviceManager().sendErgTarget(targetWatts);
    }
  },

  adjustFreeRideWatts: (deltaWatts) => {
    const state = get();
    const clamped = clampFreeRideCenterWatts(
      state.freeRideZone,
      state.ftp,
      state.freeRideOffsetWatts + deltaWatts
    );
    const targetWatts = computeFreeRideTargetWatts(
      state.freeRideZone,
      state.ftp,
      clamped.clampedOffsetWatts,
      state.freeRideGrade
    );
    set({
      freeRideOffsetWatts: clamped.clampedOffsetWatts,
      freeRideTargetWatts: targetWatts,
    });
    if (state.runState === 'running') {
      void ensureDeviceManager().sendErgTarget(targetWatts);
    }
  },

  resetFreeRideOffset: () => {
    const state = get();
    const targetWatts = computeFreeRideTargetWatts(
      state.freeRideZone,
      state.ftp,
      0,
      state.freeRideGrade
    );
    set({
      freeRideOffsetWatts: 0,
      freeRideTargetWatts: targetWatts,
    });
    if (state.runState === 'running') {
      void ensureDeviceManager().sendErgTarget(targetWatts);
    }
  },

  startWorkout: () => {
    const state = get();
    const dm = ensureDeviceManager();

    // Reset if starting fresh after completion
    if (state.runState === 'completed') {
      liveTelemetryBuffer.resetRollingPower();
      rideHistoryBuffer.reset();
      liveTssTracker.reset();
      rideRecorder.reset();
      workoutEngine.reset();
      const freshTerrain =
        state.rideMode === 'freeride' ? createFreeRideTerrain() : state.freeRideTerrain;
      const freshGrade =
        state.rideMode === 'freeride' ? sampleFreeRideGrade(freshTerrain, 0) : state.freeRideGrade;
      const freshTarget =
        state.rideMode === 'freeride'
          ? computeFreeRideTargetWatts(state.freeRideZone, state.ftp, state.freeRideOffsetWatts, freshGrade)
          : state.freeRideTargetWatts;
      set({
        elapsedSec: 0,
        historyVersion: rideHistoryBuffer.version,
        lastResumeGapSec: 0,
        totalWorkKj: 0,
        calories: 0,
        liveTss: 0,
        autoPaused: false,
        zeroPedalSec: 0,
        freeRideTerrain: freshTerrain,
        freeRideGrade: freshGrade,
        freeRideTargetWatts: freshTarget,
        rideStartTimeMs: null,
        rideDistanceM: 0,
        rideAltitudeM: VIRTUAL_START_ALTITUDE_M,
        rideAscentM: 0,
        rideLapCount: 0,
        activeModal: null,
      });
    }

    const snap = workoutEngine.start();
    const nowMs = Date.now();
    const currentState = get();
    const isFreeRide = currentState.rideMode === 'freeride';
    const zoneInfo = COGGAN_ZONES[currentState.freeRideZone];
    const isNewSession = rideRecorder.getStartTimeMs() === null;
    const visitedSceneries = isNewSession
      ? [currentState.sceneryTheme]
      : currentState.visitedSceneries;
    const activityMeta = buildCurrentActivityMeta({
      rideMode: currentState.rideMode,
      activeWorkout: currentState.activeWorkout,
      sceneryTheme: currentState.sceneryTheme,
      visitedSceneries,
    });
    rideRecorder.beginSession(
      isFreeRide ? 'freeride-session' : currentState.activeWorkout.id,
      isFreeRide ? 'Free Ride' : currentState.activeWorkout.name,
      currentState.ftp,
      nowMs,
      isFreeRide ? currentState.freeRideZone : snap?.stepIndex ?? 0,
      isFreeRide
        ? `Free Ride · ${zoneInfo.code} ${zoneInfo.name}`
        : snap?.step.label ?? 'Warmup',
      {
        activityName: activityMeta.activityName,
        sceneryName: activityMeta.sceneryName,
        gpsRoute: currentState.activeGpsRoute,
      }
    );

    const ergTarget = isFreeRide
      ? currentState.freeRideTargetWatts
      : snap?.targetWatts ?? 150;

    set({
      runState: 'running',
      musicTestZone: null,
      unfinishedRide: null,
      autoPaused: false,
      zeroPedalSec: 0,
      visitedSceneries,
      ...(isNewSession ? { sceneryCycleElapsedSec: 0 } : {}),
      elapsedSec: workoutEngine.getElapsedSec(),
      activeSnapshot: snap,
      rideStartTimeMs: rideRecorder.getStartTimeMs(),
      rideLapCount: rideRecorder.getLapCount(),
      intervalPulseCount: state.intervalPulseCount + 1,
    });

    if (isNewSession) {
      // Clear any previous unrelated active checkpoint and persist initial metadata
      void clearActiveRideCheckpoint().then(() => {
        flushActiveRideCheckpoint(true);
      });
    }

    const beginTrainer = async () => {
      if (state.simulationEnabled && dm.getTrainer().getStatus().status !== 'connected') {
        await dm.connectAllSimulated();
      }
      await dm.startTrainer();
      await dm.sendErgTarget(ergTarget);
    };
    void beginTrainer();
    void wakeLockController.request();
  },

  pauseWorkout: (isAuto = false) => {
    if (get().runState !== 'running') return;
    workoutEngine.pause();
    rideRecorder.notifyPaused();
    flushActiveRideCheckpoint(true);
    const dm = ensureDeviceManager();
    void dm.pauseTrainer();
    void wakeLockController.release();
    set({ runState: 'paused', autoPaused: isAuto, zeroPedalSec: 0 });
  },

  resumeWorkout: () => {
    if (get().runState !== 'paused') return;
    rideRecorder.notifyResumed();
    get().startWorkout();
  },

  togglePlayPause: () => {
    const state = get();
    if (state.runState === 'running') {
      state.pauseWorkout();
    } else {
      state.startWorkout();
    }
  },

  skipStep: () => {
    const state = get();
    const snap = workoutEngine.skipStep();
    if (snap && rideRecorder.getStartTimeMs() !== null) {
      rideRecorder.markStepChange(snap.stepIndex, snap.step.label, Date.now());
    }
    set({
      elapsedSec: workoutEngine.getElapsedSec(),
      activeSnapshot: snap,
      rideLapCount: rideRecorder.getLapCount(),
      intervalPulseCount: state.intervalPulseCount + 1,
    });
  },

  previousStep: () => {
    const state = get();
    const snap = workoutEngine.previousStep();
    if (!snap) return;
    if (rideRecorder.getStartTimeMs() !== null) {
      rideRecorder.markStepChange(snap.stepIndex, snap.step.label, Date.now());
    }
    set({
      elapsedSec: workoutEngine.getElapsedSec(),
      activeSnapshot: snap,
      rideLapCount: rideRecorder.getLapCount(),
      intervalPulseCount: state.intervalPulseCount + 1,
    });
  },

  jumpToStep: (stepIndex: number) => {
    clearFinishSummaryTimer();
    const state = get();
    const snap = workoutEngine.jumpToStep(stepIndex);
    if (snap && rideRecorder.getStartTimeMs() !== null) {
      rideRecorder.markStepChange(snap.stepIndex, snap.step.label, Date.now());
    }
    set({
      elapsedSec: workoutEngine.getElapsedSec(),
      activeSnapshot: snap,
      rideLapCount: rideRecorder.getLapCount(),
      intervalPulseCount: state.intervalPulseCount + 1,
    });
  },

  seekToTime: (elapsedSec: number) => {
    clearFinishSummaryTimer();
    const state = get();
    const snap = workoutEngine.seek(elapsedSec);
    if (snap && rideRecorder.getStartTimeMs() !== null) {
      rideRecorder.markStepChange(snap.stepIndex, snap.step.label, Date.now());
    }
    set({
      elapsedSec: workoutEngine.getElapsedSec(),
      activeSnapshot: snap,
      rideLapCount: rideRecorder.getLapCount(),
      intervalPulseCount: state.intervalPulseCount + 1,
    });
  },

  endWorkout: () => {
    clearFinishSummaryTimer();
    const state = get();
    // Ensure even an instant-ended ride has a finalized session snapshot if started
    if (rideRecorder.getStartTimeMs() === null) {
      const nowMs = Date.now();
      const isFreeRide = state.rideMode === 'freeride';
      const zoneInfo = COGGAN_ZONES[state.freeRideZone];
      const activityMeta = buildCurrentActivityMeta({
        rideMode: state.rideMode,
        activeWorkout: state.activeWorkout,
        sceneryTheme: state.sceneryTheme,
        visitedSceneries: [state.sceneryTheme],
      });
      rideRecorder.beginSession(
        isFreeRide ? 'freeride-session' : state.activeWorkout.id,
        isFreeRide ? 'Free Ride' : state.activeWorkout.name,
        state.ftp,
        nowMs,
        isFreeRide ? state.freeRideZone : state.activeSnapshot?.stepIndex ?? 0,
        isFreeRide
          ? `Free Ride · ${zoneInfo.code} ${zoneInfo.name}`
          : state.activeSnapshot?.step.label ?? 'Warmup',
        {
          activityName: activityMeta.activityName,
          sceneryName: activityMeta.sceneryName,
          gpsRoute: state.activeGpsRoute,
        }
      );
    }
    finalizeAndPersistCurrentRide(Date.now());
    workoutEngine.stop(true);
    const dm = ensureDeviceManager();
    void dm.stopTrainer();
    void wakeLockController.release();
    set({
      runState: 'completed',
      autoPaused: false,
      zeroPedalSec: 0,
      activeModal: 'summary',
    });
  },

  resetWorkout: () => {
    clearFinishSummaryTimer();
    const oldSessionId = rideRecorder.getSessionId();
    liveTelemetryBuffer.resetRollingPower();
    rideHistoryBuffer.reset();
    liveTssTracker.reset();
    rideRecorder.reset();
    if (oldSessionId) {
      void clearActiveRideCheckpoint(oldSessionId);
    }
    const dm = ensureDeviceManager();
    void dm.stopTrainer();
    void wakeLockController.release();
    const snap = workoutEngine.reset();
    const state = get();
    const nextTerrain =
      state.rideMode === 'freeride' ? createFreeRideTerrain() : state.freeRideTerrain;
    const nextGrade =
      state.rideMode === 'freeride' ? sampleFreeRideGrade(nextTerrain, 0) : state.freeRideGrade;
    const nextTarget =
      state.rideMode === 'freeride'
        ? computeFreeRideTargetWatts(state.freeRideZone, state.ftp, 0, nextGrade)
        : state.freeRideTargetWatts;
    set({
      runState: 'idle',
      autoPaused: false,
      zeroPedalSec: 0,
      elapsedSec: 0,
      activeSnapshot: snap,
      historyVersion: rideHistoryBuffer.version,
      lastResumeGapSec: 0,
      totalWorkKj: 0,
      calories: 0,
      liveTss: 0,
      freeRideOffsetWatts: 0,
      freeRideTerrain: nextTerrain,
      freeRideGrade: nextGrade,
      freeRideTargetWatts: nextTarget,
      rideStartTimeMs: null,
      rideDistanceM: 0,
      rideAltitudeM: VIRTUAL_START_ALTITUDE_M,
      rideAscentM: 0,
      rideLapCount: 0,
      activeModal: null,
      intervalPulseCount: 0,
    });
  },

  setFtp: (rawFtp) => {
    const snap = workoutEngine.setFtp(rawFtp);
    const nextFtp = workoutEngine.getFtp();
    rideRecorder.updateMeta(nextFtp);
    const state = get();
    const clampedFreeRide = clampFreeRideCenterWatts(
      state.freeRideZone,
      nextFtp,
      state.freeRideOffsetWatts
    );
    const nextFreeRideTarget = computeFreeRideTargetWatts(
      state.freeRideZone,
      nextFtp,
      clampedFreeRide.clampedOffsetWatts,
      state.freeRideGrade
    );
    set({
      ftp: nextFtp,
      activeSnapshot: snap,
      freeRideOffsetWatts: clampedFreeRide.clampedOffsetWatts,
      freeRideTargetWatts: nextFreeRideTarget,
    });
    if (state.rideMode === 'freeride' && state.runState === 'running') {
      void ensureDeviceManager().sendErgTarget(nextFreeRideTarget);
    }
    persistFromStore();
  },

  adjustIntensity: (deltaPct) => {
    const snap = workoutEngine.adjustIntensity(deltaPct);
    set({
      intensityOffsetPct: workoutEngine.getIntensityOffsetPct(),
      activeSnapshot: snap,
    });
  },

  resetIntensityOffset: () => {
    const snap = workoutEngine.setIntensityOffset(0);
    set({ intensityOffsetPct: 0, activeSnapshot: snap });
  },

  setSceneryTheme: (sceneryTheme) => {
    const state = get();
    const isActiveRide = rideRecorder.getStartTimeMs() !== null && state.runState !== 'completed';
    const nextVisited = isActiveRide
      ? state.visitedSceneries.includes(sceneryTheme)
        ? state.visitedSceneries
        : [...state.visitedSceneries, sceneryTheme]
      : [sceneryTheme];
    if (isActiveRide) {
      const meta = buildCurrentActivityMeta({
        rideMode: state.rideMode,
        activeWorkout: state.activeWorkout,
        sceneryTheme,
        visitedSceneries: nextVisited,
      });
      rideRecorder.updateMeta(state.ftp, meta.activityName, meta.sceneryName);
    }
    set({
      sceneryTheme,
      visitedSceneries: nextVisited,
      sceneryCycleElapsedSec: 0,
    });
    persistFromStore();
  },

  setSceneryCycleMinutes: (sceneryCycleMinutes) => {
    set({ sceneryCycleMinutes, sceneryCycleElapsedSec: 0 });
    persistFromStore();
  },

  cycleNextScenery: () => {
    const state = get();
    const idx = SCENERY_CYCLE_ORDER.indexOf(state.sceneryTheme);
    const next = SCENERY_CYCLE_ORDER[(idx + 1) % SCENERY_CYCLE_ORDER.length];
    state.setSceneryTheme(next);
  },

  setGpsRoutePreset: (gpsRoutePreset) => {
    const state = get();
    const activeGpsRoute = compileActiveRouteFromConfig({
      gpsRoutePreset,
      gpsRouteTargetKm: state.gpsRouteTargetKm,
      customGpsRouteName: state.customGpsRouteName,
      customGpsRoutePoints: state.customGpsRoutePoints,
      customGpsRouteClosed: state.customGpsRouteClosed,
      rideMode: state.rideMode,
      workoutDurationSec: state.activeWorkout.totalDuration,
    });
    rideRecorder.setGpsRoute(activeGpsRoute);
    set({ gpsRoutePreset, activeGpsRoute });
    persistFromStore();
  },

  setGpsRouteTargetKm: (km) => {
    const clampedKm = Math.max(0, Math.min(120, Math.round(km)));
    const state = get();
    const activeGpsRoute = compileActiveRouteFromConfig({
      gpsRoutePreset: state.gpsRoutePreset,
      gpsRouteTargetKm: clampedKm,
      customGpsRouteName: state.customGpsRouteName,
      customGpsRoutePoints: state.customGpsRoutePoints,
      customGpsRouteClosed: state.customGpsRouteClosed,
      rideMode: state.rideMode,
      workoutDurationSec: state.activeWorkout.totalDuration,
    });
    rideRecorder.setGpsRoute(activeGpsRoute);
    set({ gpsRouteTargetKm: clampedKm, activeGpsRoute });
    persistFromStore();
  },

  setCustomGpsRoute: (name, points, closedLoop) => {
    const state = get();
    const cleanName = (name || 'Custom Line Drawing').trim().slice(0, 64);
    const cleanPoints = points.slice(0, 600);
    const activeGpsRoute = compileActiveRouteFromConfig({
      gpsRoutePreset: 'custom-drawing',
      gpsRouteTargetKm: state.gpsRouteTargetKm,
      customGpsRouteName: cleanName,
      customGpsRoutePoints: cleanPoints,
      customGpsRouteClosed: closedLoop,
      rideMode: state.rideMode,
      workoutDurationSec: state.activeWorkout.totalDuration,
    });
    rideRecorder.setGpsRoute(activeGpsRoute);
    set({
      gpsRoutePreset: 'custom-drawing',
      customGpsRouteName: cleanName,
      customGpsRoutePoints: cleanPoints,
      customGpsRouteClosed: closedLoop,
      activeGpsRoute,
    });
    persistFromStore();
  },

  setQuality: (quality) => {
    graphicsGovernor.setBaseQuality(quality);
    set({ quality, qualityOverride: quality });
    persistFromStore();
  },

  setQualityAuto: () => {
    const autoQ = get().autoDetectedQuality;
    graphicsGovernor.setBaseQuality(autoQ);
    set({ quality: autoQ, qualityOverride: null });
    persistFromStore();
  },

  setMinimalMode: (minimalMode) => {
    set({ minimalMode });
    persistFromStore();
  },

  setShowDiagnostics: (showDiagnostics) => {
    set({ showDiagnostics });
    persistFromStore();
  },

  setShowHoloCards: (showHoloCards) => {
    set({ showHoloCards });
    persistFromStore();
  },

  setShowFps: (showFps) => {
    set({ showFps });
    persistFromStore();
  },

  setShowGraph: (showGraph) => {
    set({ showGraph });
    persistFromStore();
  },

  toggleGraph: () => {
    const next = !get().showGraph;
    set({ showGraph: next });
    persistFromStore();
  },

  setAutoPauseEnabled: (autoPauseEnabled) => {
    set({ autoPauseEnabled, zeroPedalSec: 0 });
    persistFromStore();
  },

  setCadenceMatchingEnabled: (cadenceMatchingEnabled) => {
    set({ cadenceMatchingEnabled });
    persistFromStore();
  },

  setAudioEnabled: (audioEnabled) => {
    set({ audioEnabled });
    persistFromStore();
  },

  toggleAudioMute: () => {
    const state = get();
    if (!state.audioEnabled) {
      set({ audioEnabled: true, audioMuted: false });
    } else {
      set({ audioMuted: !state.audioMuted });
    }
    persistFromStore();
  },

  setAudioMasterVolume: (volume) => {
    set({ audioMasterVolume: clampAudioVolume(volume, DEFAULT_AUDIO_MASTER_VOLUME) });
    persistFromStore();
  },

  setAudioMenuVolume: (volume) => {
    set({ audioMenuVolume: clampAudioVolume(volume, DEFAULT_AUDIO_MENU_VOLUME) });
    persistFromStore();
  },

  setAudioRideVolume: (volume) => {
    set({ audioRideVolume: clampAudioVolume(volume, DEFAULT_AUDIO_RIDE_VOLUME) });
    persistFromStore();
  },

  setMusicFollowMode: (musicFollowMode) => {
    set({ musicFollowMode });
    persistFromStore();
  },

  setMusicTestZone: (musicTestZone) => {
    set({ musicTestZone });
  },

  setFps: (fps) => set({ fps }),

  setSimulationEnabled: async (enabled) => {
    set({ simulationEnabled: enabled });
    persistFromStore();
    const dm = ensureDeviceManager();
    if (enabled) {
      await dm.connectAllSimulated();
      const s = get();
      if (s.runState === 'running' && s.activeSnapshot) {
        await dm.startTrainer();
        const target =
          s.rideMode === 'freeride' ? s.freeRideTargetWatts : s.activeSnapshot.targetWatts;
        await dm.sendErgTarget(target);
      }
    } else {
      await dm.disconnectAll();
      liveTelemetryBuffer.clearAll();
      set({
        instantPower: 0,
        power3sAvg: 0,
        cadence: 0,
        cadenceSensorRpm: 0,
        cadenceTimestampMs: 0,
        speedKmh: 0,
        heartRate: 0,
      });
    }
  },

  connectTrainer: async () => {
    const dm = ensureDeviceManager();
    await dm.getTrainer().connect();
    await dm.getTrainer().requestControl();
    const s = get();
    if (s.runState === 'running' && s.activeSnapshot) {
      await dm.startTrainer();
      const target =
        s.rideMode === 'freeride' ? s.freeRideTargetWatts : s.activeSnapshot.targetWatts;
      await dm.sendErgTarget(target);
    } else if (s.runState === 'paused' && s.autoPaused) {
      await dm.startTrainer();
      const target =
        s.rideMode === 'freeride' ? s.freeRideTargetWatts : s.activeSnapshot?.targetWatts ?? 150;
      await dm.sendErgTarget(target);
    }
  },

  connectBleTrainer: async () => {
    const dm = ensureDeviceManager();
    const connected = await dm.connectBleTrainer();
    if (!connected) return;
    set({ simulationEnabled: false });
    persistFromStore();
    const s = get();
    if (s.runState === 'running' && s.activeSnapshot) {
      await dm.startTrainer();
      const target =
        s.rideMode === 'freeride' ? s.freeRideTargetWatts : s.activeSnapshot.targetWatts;
      await dm.sendErgTarget(target);
    }
  },

  disconnectTrainer: async () => {
    await ensureDeviceManager().getTrainer().disconnect();
    const dedicatedCadenceConnected = get().cadenceStatus.status === 'connected';
    liveTelemetryBuffer.clearTrainer(dedicatedCadenceConnected);
    set({
      instantPower: 0,
      power3sAvg: 0,
      speedKmh: 0,
      ...(dedicatedCadenceConnected ? {} : { cadence: 0, cadenceTimestampMs: 0 }),
    });
  },

  connectHeartRate: async () => {
    await ensureDeviceManager().getHeartRateMonitor().connect();
  },

  connectBleHeartRate: async () => {
    await ensureDeviceManager().connectBleHeartRate();
  },

  disconnectHeartRate: async () => {
    await ensureDeviceManager().getHeartRateMonitor().disconnect();
    liveTelemetryBuffer.clearHeartRate();
    set({ heartRate: 0 });
  },

  connectBleCadence: async () => {
    await ensureDeviceManager().connectBleCadence();
  },

  disconnectCadence: async () => {
    await ensureDeviceManager().disconnectCadence();
    const trainerConnected = get().trainerStatus.status === 'connected';
    liveTelemetryBuffer.clearCadence(trainerConnected);
    set({
      cadenceSensorRpm: 0,
      ...(trainerConnected ? {} : { cadence: 0, cadenceTimestampMs: 0 }),
    });
  },

  reconnectLastDevices: async () => {
    const dm = ensureDeviceManager();
    set({ reconnectingLastDevices: true });
    try {
      const res = await dm.reconnectLastDevices();
      if (res.trainer) {
        set({ simulationEnabled: false });
        persistFromStore();
        const s = get();
        if (s.runState === 'running' && s.activeSnapshot) {
          await dm.startTrainer();
          const target =
            s.rideMode === 'freeride' ? s.freeRideTargetWatts : s.activeSnapshot.targetWatts;
          await dm.sendErgTarget(target);
        }
      }
    } finally {
      set({ reconnectingLastDevices: false });
    }
  },

  forgetSavedDevice: (deviceId: string) => {
    ensureDeviceManager().forgetSavedDevice(deviceId);
  },

  refreshSavedRides: async () => {
    const rides = await listSavedRides();
    set({ savedRides: rides });
  },

  deleteSavedRideById: async (rideId: string) => {
    await deleteSavedRide(rideId);
    set((state) => ({
      savedRides: state.savedRides.filter((r) => r.id !== rideId),
      lastCompletedRide:
        state.lastCompletedRide?.id === rideId ? null : state.lastCompletedRide,
    }));
  },

  markRideUploadedToStrava: async (rideId: string, stravaActivityId = null) => {
    const nowMs = Date.now();
    const state = get();
    const targetRide =
      state.savedRides.find((r) => r.id === rideId) ??
      (state.lastCompletedRide?.id === rideId ? state.lastCompletedRide : null);
    if (!targetRide) return;

    const updated: SavedRide = {
      ...targetRide,
      uploadedToStrava: true,
      uploadedAtMs: nowMs,
      stravaActivityId,
    };
    await saveCompletedRide(updated);
    set((cur) => ({
      savedRides: cur.savedRides.map((r) => (r.id === rideId ? updated : r)),
      lastCompletedRide: cur.lastCompletedRide?.id === rideId ? updated : cur.lastCompletedRide,
    }));
  },

  resumeUnfinishedRide: () => {
    const state = get();
    const recovery = state.unfinishedRide;
    if (!recovery) return;
    clearFinishSummaryTimer();
    liveTelemetryBuffer.resetRollingPower();
    rideHistoryBuffer.reset();
    liveTssTracker.reset();

    const { meta, samples } = recovery;
    const isFreeRide = meta.rideMode === 'freeride';
    const matchedWorkout = isFreeRide
      ? FREE_RIDE_SESSION_WORKOUT
      : state.workouts.find((w) => w.id === meta.workoutId) ?? state.activeWorkout;

    const activeGpsRoute = compileActiveRouteFromConfig({
      gpsRoutePreset: state.gpsRoutePreset,
      gpsRouteTargetKm: state.gpsRouteTargetKm,
      customGpsRouteName: state.customGpsRouteName,
      customGpsRoutePoints: state.customGpsRoutePoints,
      customGpsRouteClosed: state.customGpsRouteClosed,
      rideMode: meta.rideMode,
      workoutDurationSec: isFreeRide ? 0 : matchedWorkout.totalDuration,
    });

    rideRecorder.restoreFromRecovery(recovery, activeGpsRoute);

    workoutEngine.loadWorkout(matchedWorkout, {
      ftp: meta.ftp,
      intensityOffsetPct: state.intensityOffsetPct,
    });
    const snap = workoutEngine.seek(meta.elapsedSec);

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      liveTssTracker.pushPower(s.power);
      rideHistoryBuffer.push(
        Math.round(s.elapsedSec),
        s.power,
        s.heartRate,
        snap?.targetWatts ?? s.power,
        s.cadence
      );
    }

    const freeRideZone = (Math.max(1, Math.min(7, Math.round(meta.freeRideZone || 2))) as ZoneNumber);
    const terrain = isFreeRide ? createFreeRideTerrain() : state.freeRideTerrain;
    const grade = isFreeRide ? sampleFreeRideGrade(terrain, meta.distanceM) : state.freeRideGrade;
    const freeRideTargetWatts = isFreeRide
      ? computeFreeRideTargetWatts(freeRideZone, meta.ftp, meta.freeRideOffsetWatts || 0, grade)
      : state.freeRideTargetWatts;

    set({
      screen: 'ride',
      activeModal: null,
      unfinishedRide: null,
      rideMode: meta.rideMode,
      activeWorkout: isFreeRide ? state.activeWorkout : matchedWorkout,
      activeGpsRoute,
      ftp: meta.ftp,
      sceneryTheme: meta.sceneryTheme,
      visitedSceneries:
        meta.visitedSceneries.length > 0 ? meta.visitedSceneries : [meta.sceneryTheme],
      freeRideZone,
      freeRideOffsetWatts: meta.freeRideOffsetWatts || 0,
      freeRideTerrain: terrain,
      freeRideGrade: grade,
      freeRideTargetWatts,
      runState: 'paused',
      autoPaused: false,
      zeroPedalSec: 0,
      elapsedSec: workoutEngine.getElapsedSec(),
      activeSnapshot: snap,
      historyVersion: rideHistoryBuffer.version,
      lastResumeGapSec: 0,
      totalWorkKj: meta.totalWorkKj,
      calories: calculateCaloriesFromKj(meta.totalWorkKj),
      liveTss: liveTssTracker.getLiveTss(meta.ftp),
      rideStartTimeMs: rideRecorder.getStartTimeMs(),
      rideDistanceM: rideRecorder.getDistanceM(),
      rideAltitudeM: rideRecorder.getAltitudeM(),
      rideAscentM: rideRecorder.getTotalAscentM(),
      rideLapCount: rideRecorder.getLapCount(),
    });

    get().startWorkout();
  },

  saveUnfinishedRide: async () => {
    const state = get();
    const recovery = state.unfinishedRide;
    if (!recovery) return;
    const saved = finalizeRecoveryToSavedRide(recovery);
    await saveCompletedRide(saved);
    await clearActiveRideCheckpoint(recovery.meta.sessionId);
    const existing = get().savedRides.filter((r) => r.id !== saved.id);
    set({
      lastCompletedRide: saved,
      savedRides: [saved, ...existing],
      unfinishedRide: null,
      activeModal: 'summary',
    });
  },

  discardUnfinishedRide: async () => {
    const recovery = get().unfinishedRide;
    await clearActiveRideCheckpoint(recovery?.meta.sessionId);
    set({ unfinishedRide: null });
  },
}));

export function getActiveZone(state: AppState): PowerZoneInfo {
  if (state.rideMode === 'freeride') {
    return COGGAN_ZONES[state.freeRideZone];
  }
  return state.activeSnapshot?.zone ?? COGGAN_ZONES[2];
}

export function getEffectiveFtpFromState(state: AppState): number {
  return getEffectiveFtp(state.ftp, state.intensityOffsetPct);
}
