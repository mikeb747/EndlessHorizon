import { create } from 'zustand';
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
  calculateLiveTss,
  RollingPowerBuffer,
} from '../core/workoutEngine';
import { COGGAN_ZONES, getEffectiveFtp, PowerZoneInfo, ZoneNumber } from '../core/zones';
import { ParsedWorkout } from '../core/zwoParser';
import { DeviceManager } from '../devices/deviceManager';
import {
  CadenceSource,
  CadenceStatusSnapshot,
  HeartRateStatusSnapshot,
  TrainerStatusSnapshot,
} from '../devices/types';
import { WorkoutEngine, WorkoutTickEvent } from '../logic/WorkoutEngine';
import { RideRecorder } from '../recording/rideRecorder';
import {
  deleteSavedRide,
  listSavedRides,
  saveCompletedRide,
} from '../recording/rideStorage';
import { SavedRide } from '../recording/types';
import { VIRTUAL_START_ALTITUDE_M } from '../recording/virtualGps';
import { getBrowserCompatibility } from '../utils/browserCheck';
import { wakeLockController } from '../utils/wakeLock';
import { getZoneGradient } from '../world/roadMath';

export type AppScreen = 'menu' | 'library' | 'ride';
export type ModalType = 'devices' | 'settings' | 'summary' | 'rides' | null;
export type SceneryTheme = 'neon-city' | 'palm-grove' | 'cloud-horizon' | 'causeway-embankment';
export type QualityLevel = 'low' | 'medium' | 'high';
export type WorkoutRunState = 'idle' | 'running' | 'paused' | 'completed';
export type RideMode = 'workout' | 'freeride';

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
  quality: QualityLevel;
  showHoloCards: boolean;
  showFps: boolean;
  showGraph: boolean;
  simulationEnabled: boolean;
  autoPauseEnabled: boolean;
  cadenceMatchingEnabled: boolean;
}

const STORAGE_KEY = 'neonvelo_settings_v1';

function loadPersistedSettings(): PersistedSettings {
  const { isTouchDevice } = getBrowserCompatibility();
  const defaults: PersistedSettings = {
    ftp: 250,
    sceneryTheme: 'neon-city',
    quality: isTouchDevice ? 'medium' : 'high',
    showHoloCards: true,
    showFps: false,
    showGraph: true,
    simulationEnabled: true,
    autoPauseEnabled: true,
    cadenceMatchingEnabled: true,
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
      quality:
        parsed.quality === 'low' || parsed.quality === 'medium' || parsed.quality === 'high'
          ? parsed.quality
          : defaults.quality,
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
  quality: QualityLevel;
  showHoloCards: boolean;
  showFps: boolean;
  showGraph: boolean;
  simulationEnabled: boolean;
  autoPauseEnabled: boolean;
  cadenceMatchingEnabled: boolean;

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

  // History for graph & summary
  history: RideHistorySample[];
  powerSamples1Hz: number[];

  // Live ride recording & persisted completed rides (for FIT export / Strava upload)
  rideStartTimeMs: number | null;
  rideDistanceM: number;
  rideAltitudeM: number;
  rideAscentM: number;
  rideLapCount: number;
  lastCompletedRide: SavedRide | null;
  savedRides: SavedRide[];

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
  setQuality: (quality: QualityLevel) => void;
  setShowHoloCards: (show: boolean) => void;
  setShowFps: (show: boolean) => void;
  setShowGraph: (show: boolean) => void;
  toggleGraph: () => void;
  setAutoPauseEnabled: (enabled: boolean) => void;
  setCadenceMatchingEnabled: (enabled: boolean) => void;
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
  refreshSavedRides: () => Promise<void>;
  deleteSavedRideById: (rideId: string) => Promise<void>;
  initSession: () => void;
}

const initialSettings = loadPersistedSettings();
const initialWorkout = BUILT_IN_WORKOUTS[0];

const rollingPower = new RollingPowerBuffer(3000);
const rideRecorder = new RideRecorder();
let deviceManager: DeviceManager | null = null;
let initialized = false;

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

function finalizeAndPersistCurrentRide(endTimeMs = Date.now()): SavedRide | null {
  const completed = rideRecorder.finalize(endTimeMs);
  if (!completed) return null;
  const existing = useAppStore.getState().savedRides.filter((r) => r.id !== completed.id);
  useAppStore.setState({
    lastCompletedRide: completed,
    savedRides: [completed, ...existing],
  });
  void saveCompletedRide(completed);
  return completed;
}

function ensureDeviceManager(): DeviceManager {
  if (deviceManager) return deviceManager;
  deviceManager = new DeviceManager({
    onTrainerTelemetry: (data) => {
      const avg3s = rollingPower.push(data.instantPower, data.timestampMs);
      const state = useAppStore.getState();
      const dedicatedCadenceConnected = state.cadenceStatus.status === 'connected';
      const trainerCadenceSource: CadenceSource = state.trainerStatus.isSimulated
        ? 'simulated'
        : 'ble-trainer';

      const patch: Partial<AppState> = {
        instantPower: data.instantPower,
        power3sAvg: avg3s,
        speedKmh: data.speedKmh,
      };

      // Dedicated BLE Cadence Sensor takes priority over trainer cadence when connected
      if (!dedicatedCadenceConnected) {
        patch.cadence = Math.round(data.cadence);
        patch.cadenceTimestampMs = data.timestampMs;
        patch.cadenceSource = trainerCadenceSource;
      }

      useAppStore.setState(patch);

      const effectiveCadence = dedicatedCadenceConnected ? state.cadence : data.cadence;
      // Automatically resume if the rider was auto-paused and starts pedalling again
      if (
        state.autoPauseEnabled &&
        state.runState === 'paused' &&
        state.autoPaused &&
        (data.instantPower > 0 || effectiveCadence > 0)
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
      useAppStore.setState({ trainerStatus, cadenceSource: nextSource });
    },
    onHeartRateTelemetry: (data) => {
      useAppStore.setState({ heartRate: data.heartRate });
    },
    onHeartRateStatus: (hrStatus) => {
      useAppStore.setState({ hrStatus });
    },
    onCadenceTelemetry: (data) => {
      const state = useAppStore.getState();
      const roundedRpm = Math.round(data.cadenceRpm);
      useAppStore.setState({
        cadenceSensorRpm: roundedRpm,
        cadence: roundedRpm,
        cadenceTimestampMs: data.timestampMs,
        cadenceSource: 'ble-cadence',
      });

      if (
        state.autoPauseEnabled &&
        state.runState === 'paused' &&
        state.autoPaused &&
        roundedRpm > 0
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
      useAppStore.setState({
        cadenceStatus,
        cadenceSource: nextSource,
        ...(cadenceStatus.status !== 'connected' ? { cadenceSensorRpm: 0 } : {}),
      });
    },
    getFtp: () => useAppStore.getState().ftp,
  });
  return deviceManager;
}

function handleEngineStateUpdate(event: WorkoutTickEvent): void {
  const state = useAppStore.getState();
  if (state.runState !== 'running' && event.runState !== 'completed') return;
  if (!event.snapshot) return;

  const dtSec = Math.max(0, event.dtSec);
  const powerNow = state.instantPower;

  // Evaluate 5-second zero-pedalling auto-pause while running
  const autoPauseEval = evaluateAutoPause({
    enabled: state.autoPauseEnabled,
    isRunning: state.runState === 'running',
    isAutoPaused: state.autoPaused,
    instantPower: powerNow,
    cadence: state.cadence,
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
  let gradePct = getZoneGradient(event.snapshot.zone.zone) * 100;
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
      void dm.sendErgTarget(nextFreeRideTargetWatts);
    }
  }

  // Record 1 Hz history & work metrics
  const addedKj = (powerNow * dtSec) / 1000;
  const totalWorkKj = state.totalWorkKj + addedKj;
  const calories = calculateCaloriesFromKj(totalWorkKj);
  const nextPowerSamples =
    dtSec >= 0.5 ? [...state.powerSamples1Hz, powerNow] : state.powerSamples1Hz;
  const liveTss = calculateLiveTss(nextPowerSamples, state.ftp);

  const sample: RideHistorySample = {
    timeSec: Math.round(event.elapsedSec),
    power: state.power3sAvg || powerNow,
    heartRate: state.heartRate,
    targetWatts,
    cadence: state.cadence,
  };

  const lastSample = state.history[state.history.length - 1];
  const nextHistory =
    lastSample && lastSample.timeSec === sample.timeSec
      ? [...state.history.slice(0, -1), sample]
      : [...state.history, sample];

  // Record 1 Hz telemetry stream (HR, Power, Cadence, Speed, Distance, Virtual Altitude & Laps)
  rideRecorder.recordSample({
    timestampMs: event.nowMs,
    dtSec,
    elapsedSec: event.elapsedSec,
    power: powerNow,
    heartRate: state.heartRate,
    cadence: state.cadence,
    speedKmh: state.speedKmh,
    gradePct,
    stepIndex: stepIndexForRecord,
    stepLabel: stepLabelForRecord,
  });

  useAppStore.setState({
    elapsedSec: event.elapsedSec,
    activeSnapshot: event.snapshot,
    totalWorkKj,
    calories,
    liveTss,
    powerSamples1Hz: nextPowerSamples,
    history: nextHistory,
    zeroPedalSec: autoPauseEval.zeroPedalSec,
    freeRideGrade: nextFreeRideGrade,
    freeRideTargetWatts: nextFreeRideTargetWatts,
    rideStartTimeMs: rideRecorder.getStartTimeMs(),
    rideDistanceM: rideRecorder.getDistanceM(),
    rideAltitudeM: rideRecorder.getAltitudeM(),
    rideAscentM: rideRecorder.getTotalAscentM(),
    rideLapCount: rideRecorder.getLapCount(),
    intervalPulseCount: event.stepChanged
      ? state.intervalPulseCount + 1
      : state.intervalPulseCount,
  });
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
  onErgCommand: ({ targetWatts }) => {
    const dm = ensureDeviceManager();
    const state = useAppStore.getState();
    const resolvedTarget =
      state.rideMode === 'freeride' ? state.freeRideTargetWatts : targetWatts;
    void dm.sendErgTarget(resolvedTarget);
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
    quality: s.quality,
    showHoloCards: s.showHoloCards,
    showFps: s.showFps,
    showGraph: s.showGraph,
    simulationEnabled: s.simulationEnabled,
    autoPauseEnabled: s.autoPauseEnabled,
    cadenceMatchingEnabled: s.cadenceMatchingEnabled,
  });
}

export const useAppStore = create<AppState>((set, get) => ({
  screen: 'menu',
  activeModal: null,
  leftDrawerOpen: false,

  ftp: initialSettings.ftp,
  intensityOffsetPct: 0,
  sceneryTheme: initialSettings.sceneryTheme,
  quality: initialSettings.quality,
  showHoloCards: initialSettings.showHoloCards,
  showFps: initialSettings.showFps,
  showGraph: initialSettings.showGraph,
  simulationEnabled: initialSettings.simulationEnabled,
  autoPauseEnabled: initialSettings.autoPauseEnabled,
  cadenceMatchingEnabled: initialSettings.cadenceMatchingEnabled,

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
  },
  cadenceStatus: {
    status: 'disconnected',
    deviceId: null,
    deviceName: null,
    signalStrength: 0,
    isSimulated: false,
    errorMessage: null,
  },

  history: [],
  powerSamples1Hz: [],

  rideStartTimeMs: null,
  rideDistanceM: 0,
  rideAltitudeM: VIRTUAL_START_ALTITUDE_M,
  rideAscentM: 0,
  rideLapCount: 0,
  lastCompletedRide: null,
  savedRides: [],

  initSession: () => {
    if (initialized) return;
    initialized = true;
    const dm = ensureDeviceManager();
    const { simulationEnabled } = get();
    if (simulationEnabled) {
      void dm.connectAllSimulated();
    }
    void get().refreshSavedRides();

    // Support ?autostart=1, ?freeride=1, or ?finishPreview=1 to jump directly into the active ride screen
    if (typeof window !== 'undefined') {
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
  setActiveModal: (activeModal) => set({ activeModal }),
  setLeftDrawerOpen: (leftDrawerOpen) => set({ leftDrawerOpen }),

  selectWorkout: (workoutId, openRide = false) => {
    const found = get().workouts.find((w) => w.id === workoutId);
    if (!found) return;
    clearFinishSummaryTimer();
    rollingPower.reset();
    rideRecorder.reset();
    const snap = workoutEngine.loadWorkout(found, {
      ftp: get().ftp,
      intensityOffsetPct: get().intensityOffsetPct,
    });
    set({
      rideMode: 'workout',
      activeWorkout: found,
      runState: 'idle',
      elapsedSec: 0,
      activeSnapshot: snap,
      history: [],
      powerSamples1Hz: [],
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
      screen: openRide ? 'ride' : get().screen,
    });
  },

  startFreeRide: (initialZone = 2, autoStart = false) => {
    clearFinishSummaryTimer();
    rollingPower.reset();
    rideRecorder.reset();
    const terrain = createFreeRideTerrain();
    const grade = sampleFreeRideGrade(terrain, 0);
    const ftp = get().ftp;
    const targetWatts = computeFreeRideTargetWatts(initialZone, ftp, 0, grade);
    const snap = workoutEngine.loadWorkout(FREE_RIDE_SESSION_WORKOUT, {
      ftp,
      intensityOffsetPct: 0,
    });
    set({
      rideMode: 'freeride',
      freeRideZone: initialZone,
      freeRideOffsetWatts: 0,
      freeRideTerrain: terrain,
      freeRideGrade: grade,
      freeRideTargetWatts: targetWatts,
      runState: 'idle',
      elapsedSec: 0,
      activeSnapshot: snap,
      history: [],
      powerSamples1Hz: [],
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
      rollingPower.reset();
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
        history: [],
        powerSamples1Hz: [],
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
    rideRecorder.beginSession(
      isFreeRide ? 'freeride-session' : currentState.activeWorkout.id,
      isFreeRide ? 'Free Ride · Undulating Terrain' : currentState.activeWorkout.name,
      currentState.ftp,
      nowMs,
      isFreeRide ? currentState.freeRideZone : snap?.stepIndex ?? 0,
      isFreeRide
        ? `Free Ride · ${zoneInfo.code} ${zoneInfo.name}`
        : snap?.step.label ?? 'Warmup'
    );

    const ergTarget = isFreeRide
      ? currentState.freeRideTargetWatts
      : snap?.targetWatts ?? 150;

    set({
      runState: 'running',
      autoPaused: false,
      zeroPedalSec: 0,
      elapsedSec: workoutEngine.getElapsedSec(),
      activeSnapshot: snap,
      rideStartTimeMs: rideRecorder.getStartTimeMs(),
      rideLapCount: rideRecorder.getLapCount(),
      intervalPulseCount: state.intervalPulseCount + 1,
    });

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
    const dm = ensureDeviceManager();
    void dm.pauseTrainer();
    void wakeLockController.release();
    set({ runState: 'paused', autoPaused: isAuto, zeroPedalSec: 0 });
  },

  resumeWorkout: () => {
    if (get().runState !== 'paused') return;
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
      rideRecorder.beginSession(
        isFreeRide ? 'freeride-session' : state.activeWorkout.id,
        isFreeRide ? 'Free Ride · Undulating Terrain' : state.activeWorkout.name,
        state.ftp,
        nowMs,
        isFreeRide ? state.freeRideZone : state.activeSnapshot?.stepIndex ?? 0,
        isFreeRide
          ? `Free Ride · ${zoneInfo.code} ${zoneInfo.name}`
          : state.activeSnapshot?.step.label ?? 'Warmup'
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
    rollingPower.reset();
    rideRecorder.reset();
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
      history: [],
      powerSamples1Hz: [],
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
    set({ sceneryTheme });
    persistFromStore();
  },

  setQuality: (quality) => {
    set({ quality });
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
      rollingPower.reset();
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
    rollingPower.reset();
    const dedicatedCadenceConnected = get().cadenceStatus.status === 'connected';
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
    set({ heartRate: 0 });
  },

  connectBleCadence: async () => {
    await ensureDeviceManager().connectBleCadence();
  },

  disconnectCadence: async () => {
    await ensureDeviceManager().disconnectCadence();
    const trainerConnected = get().trainerStatus.status === 'connected';
    set({
      cadenceSensorRpm: 0,
      ...(trainerConnected ? {} : { cadence: 0, cadenceTimestampMs: 0 }),
    });
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
