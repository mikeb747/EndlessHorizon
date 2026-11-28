import test from 'node:test';
import assert from 'node:assert/strict';
import { getPowerZone, getTargetWatts, getEffectiveFtp, powerToSpeedKmh, formatClock, ZoneNumber } from './zones';
import { parseZwoWorkout } from './zwoParser';
import { BUILT_IN_HIIT_ZWO, BUILT_IN_WORKOUTS } from './builtInWorkouts';
import {
  clampFreeRideCenterWatts,
  computeFreeRideTargetWatts,
  createFreeRideTerrain,
  FREE_RIDE_MAX_GRADE,
  FREE_RIDE_MIN_GRADE,
  getZoneWattRange,
  sampleFreeRideGrade,
} from './freeRide';
import { AUTO_PAUSE_DELAY_SEC, evaluateAutoPause } from './autoPause';
import { evaluateWorkoutAtTime, RollingPowerBuffer, calculateLiveTss } from './workoutEngine';
import { WorkoutWallClock } from './workoutClock';
import { clampFtp, WorkoutEngine, WorkerLike } from '../logic/WorkoutEngine';
import {
  buildWorkoutElevationProfile,
  CAUSEWAY_EMBANKMENT_DROP_M,
  CAUSEWAY_EMBANKMENT_TOE_X,
  CLOUD_HORIZON_BUSH_SPACING_M,
  CLOUD_HORIZON_SPRITE_COUNT,
  computeBuildingCenterOffset,
  computeCornerLeanAngle,
  computeForwardScrollOffset,
  computeLinearRoadT,
  computeRoadSegmentZ,
  computeSpeedStreakParams,
  createWorldRuntime,
  getZoneGradient,
  MAX_VISIBLE_HEADING_RAD,
  NEON_CITY_BUILDING_MAX_JITTER,
  NEON_CITY_BUILDING_MAX_WIDTH,
  NEON_CITY_CURB_GAP,
  NEON_CITY_MIN_BUILDING_FRONT_X,
  NEON_CITY_SIDEWALK_PAVED_WIDTH,
  NEON_CITY_SIDEWALK_TOTAL_WIDTH,
  NEON_CITY_SIDEWALK_WIDTH,
  PALM_GROVE_AVG_SPACING_M,
  PALM_GROVE_CLIFF_WIDTH,
  ROAD_HALF_WIDTH,
  ROAD_SEGMENTS,
  ROAD_Z_FAR,
  ROAD_Z_NEAR,
  ROAD_Z_SPAN,
  sampleGradeAtTime,
  sampleRoadAtZ,
  SKY_DOME_RADIUS,
  updateRoadCurveLut,
  WORLD_CAMERA_NEAR,
} from '../world/roadMath';
import {
  DEGRADATION_ORDER,
  detectRecommendedQuality,
  getEffectiveRenderConfig,
  GraphicsGovernor,
} from '../world/graphicsGovernor';
import {
  createRoadProfileUniformArray,
  getUnifiedSkyThemeParams,
  packRoadProfileUniforms,
  ROAD_PROFILE_COUNT,
  ROAD_SEGMENT_Z,
} from '../world/roadShaderHelpers';
import type {
  WorkoutEngineWorkerCommand,
  WorkoutEngineWorkerEvent,
} from '../workers/workoutEngine.worker';
import {
  CHECKPOINT_INTERVAL_MS,
  finalizeRecoveryToSavedRide,
  RideRecorder,
} from '../recording/rideRecorder';
import { assembleRecoveryFromChunks } from '../recording/rideStorage';
import {
  IncrementalTssTracker,
  LiveTelemetryBuffer,
  RideHistoryBuffer,
  TelemetryRingReadout,
} from '../recording/telemetryBuffer';
import { buildFitFileName, encodeRideToFit, verifyFitBinary } from '../recording/fitEncoder';
import {
  BIKE_LINE_ART_POINTS,
  compileGpsRoute,
  MAX_IN_GAME_CURVATURE,
  sampleCompiledRouteCurvature,
  sampleCompiledRouteGps,
} from '../recording/gpsRoutes';
import { verifyStravaUploadAccess } from '../server/uploadAuth';
import { traceLineDrawingRgba } from '../recording/lineArtTracer';
import {
  FIT_SPORT_CYCLING,
  FIT_SUB_SPORT_VIRTUAL_ACTIVITY,
  formatFitActivityName,
  getSceneryDisplayName,
} from '../recording/types';
import { URASHIMA_CENTER_LAT, URASHIMA_CENTER_LON, VIRTUAL_START_ALTITUDE_M } from '../recording/virtualGps';
import {
  createCrankRevState,
  parseCscMeasurement,
  parseCyclingPowerMeasurement,
  parseFtmsIndoorBikeData,
  parseHeartRateMeasurement,
} from '../devices/bleParsers';
import {
  computeReconnectBackoffMs,
  loadSavedDevices,
  removeSavedDevice,
  runTrainerReconnectRecovery,
  saveSavedDevices,
  upsertSavedDevice,
} from '../devices/devicePersistence';
import {
  CoalescingErgQueue,
  CONTROL_NOT_PERMITTED_MESSAGE,
  FTMS_OP_REQUEST_CONTROL,
  FTMS_OP_RESPONSE_CODE,
  FTMS_RESULT_CONTROL_NOT_PERMITTED,
  FTMS_RESULT_SUCCESS,
  parseFtmsControlPointResponse,
  withBluetoothRetry,
  withBluetoothTimeout,
} from '../devices/bleHardening';
import {
  BleCharacteristicLike,
  BleDeviceLike,
  WebBluetoothCadenceDevice,
  WebBluetoothHeartRateDevice,
  WebBluetoothTrainerDevice,
} from '../devices/webBluetoothDevices';
import {
  createCadenceMatcherState,
  solveTwoBoneLegIK,
  stepCadenceMatcher,
} from '../world/cadenceMatcher';
import {
  AM_CHORD_PROGRESSION_8BAR,
  computeEffectiveMusicLayers,
  computeFourBarRampSeconds,
  createZoneHysteresisState,
  evaluateIntervalAnticipation,
  mapCogganToMusicZone,
  resolveMusicCandidateZone,
  stepZoneHysteresis,
  ZONE_BPM,
} from '../audio/musicEngineLogic';
import {
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN,
  computeAdaptiveCameraFraming,
  computeFogCullDistance,
  extractFrustumPlanes,
  isAabbInFrustum,
  isSphereInFrustum,
} from '../world/frustumCuller';
import {
  clampAudioVolume,
  computeEffectiveMasterGain,
  computeSynthwaveMixParams,
  DEFAULT_AUDIO_MASTER_VOLUME,
  getThemeRootOffset,
  midiToFreq,
} from '../audio/synthwaveMath';
import * as THREE from 'three';

test('Coggan power zones map accurately across all 7 zones', () => {
  assert.equal(getPowerZone(0.50).zone, 1);
  assert.equal(getPowerZone(0.68).zone, 2);
  assert.equal(getPowerZone(0.84).zone, 3);
  assert.equal(getPowerZone(0.95).zone, 4);
  assert.equal(getPowerZone(1.12).zone, 5);
  assert.equal(getPowerZone(1.26).zone, 6);
  assert.equal(getPowerZone(1.65).zone, 7);
});

test('target watts scales with FTP and intensity offset', () => {
  assert.equal(getEffectiveFtp(250, 0), 250);
  assert.equal(getEffectiveFtp(250, 4), 260);
  assert.equal(getTargetWatts(0.92, 250, 0), 230);
  assert.equal(getTargetWatts(1.26, 250, 0), 315);
  assert.equal(getTargetWatts(0.496, 250, 0), 124);
  assert.equal(getTargetWatts(1.0, 250, -2), 245);
  assert.equal(getTargetWatts(1.0, 250, 2), 255);
});

test('ZWO parser builds grouped tree and flattened execution timeline', () => {
  const workout = parseZwoWorkout(BUILT_IN_HIIT_ZWO, 'test-hiit');
  assert.equal(workout.name, 'HIIT30/15 for Time Trial Power Profile');
  assert.equal(workout.author, 'octaperformance');
  assert.ok(workout.tags.includes('HIIT'));
  assert.ok(workout.tags.includes('Time Trial'));

  // 9 top-level tree nodes: Warmup, Primer, Recovery, Block 1, Rec 1, Block 2, Rec 2, Block 3, Cooldown
  assert.equal(workout.tree.length, 9);
  assert.equal(workout.tree[0].type, 'step');
  assert.equal(workout.tree[3].type, 'group');
  if (workout.tree[3].type === 'group') {
    assert.equal(workout.tree[3].repeat, 13);
    assert.equal(workout.tree[3].childrenTemplate.length, 2);
    assert.equal(workout.tree[3].childrenTemplate[0].duration, 30);
    assert.equal(workout.tree[3].childrenTemplate[1].duration, 15);
  }

  // Timeline: 1 + 1 + 1 + 26 + 1 + 26 + 1 + 26 + 1 = 84 flattened steps
  assert.equal(workout.timeline.length, 84);
  // Total duration: 600 + 120 + 180 + 3*(13*45) + 2*180 + 300 = 3315 s (55:15)
  assert.equal(workout.totalDuration, 3315);
  assert.ok(workout.estimatedTss > 40 && workout.estimatedTss < 120);
});

test('workout engine interpolates ramps and triggers 5-second countdown cues', () => {
  const workout = parseZwoWorkout(BUILT_IN_HIIT_ZWO, 'test-hiit');

  // Halfway through 600s warmup (0.54 -> 0.82 => 0.68 = 170W @ 250W FTP)
  const midWarmup = evaluateWorkoutAtTime(workout.timeline, 300, 250, 0);
  assert.ok(midWarmup);
  assert.equal(midWarmup.stepIndex, 0);
  assert.equal(midWarmup.targetWatts, 170);
  assert.equal(midWarmup.zone.zone, 2);
  assert.equal(midWarmup.countdownSec, null);

  // 3 seconds before Warmup ends -> countdown cue = 3
  const countdownSnap = evaluateWorkoutAtTime(workout.timeline, 597, 250, 0);
  assert.ok(countdownSnap);
  assert.equal(countdownSnap.countdownSec, 3);

  // Into Threshold primer (step 1: 600..720 @ 0.92 -> 230W, Z4 Threshold)
  const primerSnap = evaluateWorkoutAtTime(workout.timeline, 610, 250, 0);
  assert.ok(primerSnap);
  assert.equal(primerSnap.stepIndex, 1);
  assert.equal(primerSnap.targetWatts, 230);
  assert.equal(primerSnap.zone.zone, 4);

  // First HIIT ON interval (starts at 900s, 1.26 FTP -> 315W, Z6 Anaerobic)
  const hiitSnap = evaluateWorkoutAtTime(workout.timeline, 905, 250, 0);
  assert.ok(hiitSnap);
  assert.equal(hiitSnap.step.repeatIndex, 1);
  assert.equal(hiitSnap.step.repeatTotal, 13);
  assert.equal(hiitSnap.targetWatts, 315);
  assert.equal(hiitSnap.zone.zone, 6);
});

test('3-second rolling power buffer averages only samples within 3000ms window', () => {
  const buf = new RollingPowerBuffer(3000);
  assert.equal(buf.push(200, 1000), 200);
  assert.equal(buf.push(260, 2000), 230);
  assert.equal(buf.push(290, 3000), 250);
  // Sample at 5000ms drops t=1000ms (cutoff 2000ms) -> avg(260, 290, 350) = 300
  assert.equal(buf.push(350, 5000), 300);
});

test('physics speed estimator and live TSS produce realistic cycling metrics', () => {
  assert.equal(powerToSpeedKmh(0), 0);
  const speed250 = powerToSpeedKmh(250);
  assert.ok(speed250 > 33 && speed250 < 41, `Expected ~37 km/h at 250W, got ${speed250}`);

  const steadyHour = new Array(3600).fill(250);
  assert.equal(calculateLiveTss(steadyHour, 250), 100);
  assert.equal(formatClock(3315), '55:15');
});

test('WorkoutEngine manages nested timeline, FTP/intensity targets, and worker protocol', () => {
  const workout = parseZwoWorkout(BUILT_IN_HIIT_ZWO, 'test-engine');
  const sentCommands: WorkoutEngineWorkerCommand[] = [];
  const ergLog: Array<{ targetWatts: number; reason: string }> = [];
  const stateTicks: number[] = [];
  let completed = false;

  let workerMessageHandler: ((event: MessageEvent<WorkoutEngineWorkerEvent>) => void) | null = null;
  let terminated = false;

  const mockWorker: WorkerLike = {
    postMessage(cmd) {
      sentCommands.push(cmd);
    },
    terminate() {
      terminated = true;
    },
    set onmessage(fn: ((event: MessageEvent<WorkoutEngineWorkerEvent>) => void) | null) {
      workerMessageHandler = fn;
    },
    get onmessage() {
      return workerMessageHandler;
    },
  };

  const engine = new WorkoutEngine(workout, {
    ftp: 250,
    intensityOffsetPct: 0,
    useWorker: true,
    workerFactory: () => mockWorker,
    callbacks: {
      onStateUpdate: (ev) => stateTicks.push(ev.elapsedSec),
      onErgCommand: (ev) => ergLog.push({ targetWatts: ev.targetWatts, reason: ev.reason }),
      onComplete: () => {
        completed = true;
      },
    },
  });

  // Nested tree navigation: jump straight to HIIT Block 1 repeat group
  const hiitGroup = engine.getNestedTree()[3];
  assert.equal(hiitGroup.type, 'group');
  const hiitSnap = engine.jumpToNode(hiitGroup.id);
  assert.ok(hiitSnap);
  assert.equal(engine.getTargetPower(), 315);
  const repeatCtx = engine.getActiveRepeatContext();
  assert.ok(repeatCtx);
  assert.equal(repeatCtx.currentRep, 1);
  assert.equal(repeatCtx.totalReps, 13);

  // Changing FTP to 315W and +2% intensity recomputes target power accurately
  assert.equal(clampFtp(315), 315);
  assert.equal(clampFtp(40), 80);
  assert.equal(clampFtp(900), 600);
  engine.setFtp(315);
  engine.adjustIntensity(2);
  assert.equal(engine.getEffectiveFtp(), 321);
  // effectiveFtp = round(315 * 1.02) = 321; round(1.26 * 321) = 404 W
  assert.equal(engine.getTargetPower(), 404);

  // Start dispatches LOAD_WORKOUT + START to worker and immediate ERG command
  engine.start();
  assert.ok(sentCommands.some((c) => c.type === 'LOAD_WORKOUT'));
  assert.ok(sentCommands.some((c) => c.type === 'START'));
  assert.equal(ergLog[ergLog.length - 1]?.reason, 'start');
  assert.equal(ergLog[ergLog.length - 1]?.targetWatts, 404);

  // Simulate worker emitting an ERG keep-alive heartbeat & state update
  const dispatchWorkerEvent = (data: WorkoutEngineWorkerEvent) => {
    assert.ok(mockWorker.onmessage, 'Expected WorkoutEngine to register onmessage handler');
    mockWorker.onmessage({ data } as MessageEvent<WorkoutEngineWorkerEvent>);
  };

  dispatchWorkerEvent({
    type: 'ERG_KEEPALIVE',
    targetWatts: 404,
    elapsedSec: 905,
    nowMs: Date.now(),
  });
  assert.equal(ergLog[ergLog.length - 1]?.reason, 'keep-alive');

  const updatedSnap = evaluateWorkoutAtTime(workout.timeline, 905, 315, 2);
  dispatchWorkerEvent({
    type: 'STATE_UPDATE',
    elapsedSec: 905,
    dtSec: 1,
    runState: 'running',
    snapshot: updatedSnap,
    stepChanged: false,
    shouldSendErg: false,
    nowMs: Date.now(),
  });
  assert.equal(engine.getElapsedSec(), 905);
  assert.deepEqual(stateTicks, [905]);

  // Simulate worker completion event
  dispatchWorkerEvent({
    type: 'COMPLETED',
    elapsedSec: workout.totalDuration,
    snapshot: evaluateWorkoutAtTime(workout.timeline, workout.totalDuration, 315, 2),
    nowMs: Date.now(),
  });
  assert.equal(completed, true);
  assert.equal(engine.getRunState(), 'completed');

  engine.dispose();
  assert.equal(terminated, true);
});

test('zone gradients are steeper overall and +10% steeper for Zone 5+ on Neon City', () => {
  assert.equal(getZoneGradient(1), 0.0);
  assert.equal(getZoneGradient(2), 0.03);
  assert.equal(getZoneGradient(3), 0.06);
  assert.equal(getZoneGradient(4), 0.1);
  assert.equal(getZoneGradient(5, 'palm-grove'), 0.22);
  assert.equal(getZoneGradient(6, 'cloud-horizon'), 0.22);
  assert.equal(getZoneGradient(7, 'causeway-embankment'), 0.22);

  // Neon City Zone 5+ is exactly +10% steeper (32% vs 22%)
  assert.ok(Math.abs(getZoneGradient(5, 'neon-city') - getZoneGradient(5, 'palm-grove') - 0.1) < 1e-9);
  assert.equal(getZoneGradient(5, 'neon-city'), 0.32);
  assert.equal(getZoneGradient(6, 'neon-city'), 0.32);
  assert.equal(getZoneGradient(7, 'neon-city'), 0.32);

  const workout = parseZwoWorkout(BUILT_IN_HIIT_ZWO, 'test-elev');
  const profile = buildWorkoutElevationProfile(workout, 'palm-grove');
  const neonProfile = buildWorkoutElevationProfile(workout, 'neon-city');

  // Start of Warmup (t=5s, Z1 Active Recovery) -> completely flat (0%)
  assert.equal(sampleGradeAtTime(profile, 5), 0);
  // Mid Warmup (t=300s, 68% FTP = Z2 Endurance) -> 3%
  assert.ok(Math.abs(sampleGradeAtTime(profile, 300) - 0.03) < 1e-5);
  // Threshold Primer (t=660s, 92% FTP = Z4 Threshold) -> 10%
  assert.ok(Math.abs(sampleGradeAtTime(profile, 660) - 0.1) < 1e-5);
  // HIIT Block 1 Work (t=915s, 126% FTP = Z6 Anaerobic) -> 22% (other worlds) vs 32% (Neon City)
  assert.ok(Math.abs(sampleGradeAtTime(profile, 915) - 0.22) < 1e-5);
  assert.ok(Math.abs(sampleGradeAtTime(neonProfile, 915) - 0.32) < 1e-5);

  // Verify 50m ahead during steady 22% climb rises ~11m, and 32% Neon City climb rises ~16m
  const flatSample = sampleRoadAtZ(0, -50, { x: 0, y: 0, slopeX: 0, slopeY: 0 }, profile, 5);
  assert.ok(Math.abs(flatSample.y) < 0.01, `Expected flat road at Z1, got y=${flatSample.y}`);

  const climbSample = sampleRoadAtZ(0, -50, { x: 0, y: 0, slopeX: 0, slopeY: 0 }, profile, 910);
  assert.ok(
    climbSample.y > 10.5 && climbSample.y < 11.5,
    `Expected ~11m vertical rise over 50m on 22% climb, got y=${climbSample.y}`
  );
  const neonClimbSample = sampleRoadAtZ(0, -50, { x: 0, y: 0, slopeX: 0, slopeY: 0 }, neonProfile, 910);
  assert.ok(
    neonClimbSample.y > 15.2 && neonClimbSample.y < 16.8,
    `Expected ~16m vertical rise over 50m on 32% Neon City climb, got y=${neonClimbSample.y}`
  );
});

test('RideRecorder tracks HR/Power/Cadence/Speed/Distance/Altitude and auto-splits Laps on step changes', () => {
  const recorder = new RideRecorder();
  const startMs = Date.UTC(2026, 4, 10, 8, 30, 0);
  recorder.beginSession('hiit-1', 'HIIT30/15 Test', 250, startMs, 0, 'Warmup');

  // 5 seconds in step 0 (flat 0% grade, 150W, 36 km/h = 10 m/s)
  for (let i = 1; i <= 5; i++) {
    recorder.recordSample({
      timestampMs: startMs + i * 1000,
      dtSec: 1,
      elapsedSec: i,
      power: 150,
      heartRate: 128 + i,
      cadence: 86,
      speedKmh: 36,
      gradePct: 0,
      stepIndex: 0,
      stepLabel: 'Warmup',
    });
  }

  // 5 seconds in step 1 (Z4 8% grade, 240W, 36 km/h = 10 m/s -> +0.8 m/s altitude = +4 m climb)
  for (let i = 6; i <= 10; i++) {
    recorder.recordSample({
      timestampMs: startMs + i * 1000,
      dtSec: 1,
      elapsedSec: i,
      power: 240,
      heartRate: 155,
      cadence: 92,
      speedKmh: 36,
      gradePct: 8,
      stepIndex: 1,
      stepLabel: 'Threshold Primer',
    });
  }

  // 5 seconds in step 2 (Z6 20% grade, 320W, 36 km/h = 10 m/s -> +2.0 m/s altitude = +10 m climb)
  for (let i = 11; i <= 15; i++) {
    recorder.recordSample({
      timestampMs: startMs + i * 1000,
      dtSec: 1,
      elapsedSec: i,
      power: 320,
      heartRate: 172,
      cadence: 96,
      speedKmh: 36,
      gradePct: 20,
      stepIndex: 2,
      stepLabel: 'HIIT Block 1 - Work',
    });
  }

  const ride = recorder.finalize(startMs + 15000);
  assert.ok(ride);
  assert.equal(ride.startTimeMs, startMs);
  assert.equal(ride.sport, FIT_SPORT_CYCLING);
  assert.equal(ride.subSport, FIT_SUB_SPORT_VIRTUAL_ACTIVITY);
  assert.equal(ride.records.length, 15);
  assert.equal(ride.laps.length, 3);
  assert.equal(ride.laps[0].stepLabel, 'Warmup');
  assert.equal(ride.laps[0].avgPower, 150);
  assert.equal(ride.laps[1].stepLabel, 'Threshold Primer');
  assert.equal(ride.laps[1].avgPower, 240);
  assert.equal(ride.laps[2].stepLabel, 'HIIT Block 1 - Work');
  assert.equal(ride.laps[2].avgPower, 320);
  assert.equal(ride.totalDistanceM, 150);
  assert.equal(ride.totalAscentM, 14);
  assert.equal(ride.maxPower, 320);
  assert.equal(ride.maxHeartRate, 172);
  assert.equal(ride.uploadedToStrava, false);

  // Encode to Garmin FIT binary and verify header, CRCs, enums, Ura-shima GPS, and virtual altitude
  const fitBytes = encodeRideToFit(ride);
  const summary = verifyFitBinary(fitBytes);
  assert.equal(summary.validHeaderSignature, true);
  assert.equal(summary.headerCrcValid, true);
  assert.equal(summary.fileCrcValid, true);
  assert.equal(summary.dataSizeMatches, true);
  assert.equal(summary.messageCountsByGlobalNum[20], 15, 'Expected 15 FIT record messages');
  assert.equal(summary.messageCountsByGlobalNum[19], 3, 'Expected 3 FIT lap messages');
  assert.equal(summary.messageCountsByGlobalNum[18], 1, 'Expected 1 FIT session message');
  assert.equal(summary.sessionSport, 2, 'Expected sport = 2 (cycling)');
  assert.equal(summary.sessionSubSport, 58, 'Expected sub_sport = 58 (virtual_activity)');
  assert.deepEqual(summary.lapSports, [2, 2, 2]);
  assert.deepEqual(summary.lapSubSports, [58, 58, 58]);

  assert.ok(summary.firstRecordLatDeg !== null && Math.abs(summary.firstRecordLatDeg - URASHIMA_CENTER_LAT) < 0.02);
  assert.ok(summary.firstRecordLonDeg !== null && Math.abs(summary.firstRecordLonDeg - URASHIMA_CENTER_LON) < 0.02);
  assert.ok(
    summary.firstRecordAltitudeM !== null &&
      Math.abs(summary.firstRecordAltitudeM - VIRTUAL_START_ALTITUDE_M) < 0.3
  );
  assert.ok(
    summary.lastRecordAltitudeM !== null &&
      Math.abs(summary.lastRecordAltitudeM - (VIRTUAL_START_ALTITUDE_M + 14)) < 0.3
  );

  const fileName = buildFitFileName(ride);
  assert.ok(fileName.startsWith('EndlessHorizon_HIIT30-15-Test_'));
  assert.ok(fileName.endsWith('.fit'));
});

test('default library contains HIIT30/15 plus Progressions, pyramids, and SS with efforts', () => {
  assert.equal(BUILT_IN_WORKOUTS.length, 4);
  const names = BUILT_IN_WORKOUTS.map((w) => w.name);
  assert.ok(names.includes('HIIT30/15 for Time Trial Power Profile'));
  assert.ok(names.includes('Progressions'));
  assert.ok(names.includes('pyramids'));
  assert.ok(names.includes('SS with efforts'));

  const progressions = BUILT_IN_WORKOUTS.find((w) => w.name === 'Progressions')!;
  assert.equal(progressions.timeline.length, 19);
  assert.equal(progressions.totalDuration, 3600);

  const pyramids = BUILT_IN_WORKOUTS.find((w) => w.name === 'pyramids')!;
  assert.ok(pyramids.timeline.length > 25);
  assert.ok(pyramids.totalDuration > 3000);

  const ssWithEfforts = BUILT_IN_WORKOUTS.find((w) => w.name === 'SS with efforts')!;
  assert.ok(ssWithEfforts.timeline.length >= 20);
  assert.ok(ssWithEfforts.totalDuration > 3000);
});

test('Free Ride undulating terrain stays strictly <= 15% gradient across seeds and distances', () => {
  const seeds = [1, 42, 1984, 99999, 1234567];
  for (const seed of seeds) {
    const terrain = createFreeRideTerrain(seed);
    let minObserved = Infinity;
    let maxObserved = -Infinity;

    for (let dist = 0; dist <= 25000; dist += 17) {
      const grade = sampleFreeRideGrade(terrain, dist);
      assert.ok(
        grade <= FREE_RIDE_MAX_GRADE + 1e-9,
        `Seed ${seed} at ${dist}m exceeded 15% grade: ${(grade * 100).toFixed(2)}%`
      );
      assert.ok(
        grade >= FREE_RIDE_MIN_GRADE - 1e-9,
        `Seed ${seed} at ${dist}m dropped below min grade: ${(grade * 100).toFixed(2)}%`
      );
      if (grade < minObserved) minObserved = grade;
      if (grade > maxObserved) maxObserved = grade;
    }

    // Must undulate meaningfully (both climbs and descents)
    assert.ok(maxObserved > 0.05, `Expected climbs > 5% for seed ${seed}, got ${maxObserved}`);
    assert.ok(minObserved < -0.04, `Expected descents < -4% for seed ${seed}, got ${minObserved}`);

    // Confirm roadMath integration uses the Free Ride terrain smoothly
    const sample = sampleRoadAtZ(500, -40, { x: 0, y: 0, slopeX: 0, slopeY: 0 }, null, 0, terrain);
    assert.ok(Number.isFinite(sample.y));
    assert.ok(Math.abs(sample.slopeY) <= FREE_RIDE_MAX_GRADE + 1e-6);
  }
});

test('Free Ride ERG target stays strictly within selected zone range and supports ±5W mid-range shifts', () => {
  const zones: ZoneNumber[] = [1, 2, 3, 4, 5, 6, 7];
  const ftp = 250;
  const grades = [-0.14, -0.08, 0, 0.06, 0.12, 0.15];
  const offsets = [-200, -15, -5, 0, 5, 15, 200];

  for (const z of zones) {
    const range = getZoneWattRange(z, ftp);
    assert.ok(range.minWatts < range.maxWatts);
    assert.ok(range.midWatts >= range.minWatts && range.midWatts <= range.maxWatts);

    // +5W and -5W shift the mid-range center cleanly by 5W
    const up5 = clampFreeRideCenterWatts(z, ftp, 5);
    const down5 = clampFreeRideCenterWatts(z, ftp, -5);
    assert.equal(up5.centerWatts, Math.min(range.maxWatts, range.midWatts + 5));
    assert.equal(down5.centerWatts, Math.max(range.minWatts, range.midWatts - 5));

    for (const offset of offsets) {
      const clamped = clampFreeRideCenterWatts(z, ftp, offset);
      assert.ok(clamped.centerWatts >= range.minWatts && clamped.centerWatts <= range.maxWatts);

      for (const grade of grades) {
        const target = computeFreeRideTargetWatts(z, ftp, offset, grade);
        assert.ok(
          target >= range.minWatts && target <= range.maxWatts,
          `Zone ${z} target ${target}W escaped [${range.minWatts}, ${range.maxWatts}] at offset=${offset}, grade=${grade}`
        );
      }
    }
  }
});

test('Auto-Pause triggers after 5 consecutive seconds of 0W/0rpm, resets on pedalling, and respects toggle', () => {
  assert.equal(AUTO_PAUSE_DELAY_SEC, 5);

  // Disabled setting never triggers auto-pause
  const disabled = evaluateAutoPause({
    enabled: false,
    isRunning: true,
    isAutoPaused: false,
    instantPower: 0,
    cadence: 0,
    dtSec: 10,
    zeroPedalSec: 4,
  });
  assert.equal(disabled.shouldAutoPause, false);
  assert.equal(disabled.zeroPedalSec, 0);

  // Accumulate 4 seconds at 0W / 0rpm -> not paused yet
  let zeroSec = 0;
  for (let i = 0; i < 4; i++) {
    const res = evaluateAutoPause({
      enabled: true,
      isRunning: true,
      isAutoPaused: false,
      instantPower: 0,
      cadence: 0,
      dtSec: 1,
      zeroPedalSec: zeroSec,
    });
    assert.equal(res.shouldAutoPause, false);
    zeroSec = res.zeroPedalSec;
  }
  assert.equal(zeroSec, 4);

  // Resuming pedalling before 5s resets timer
  const pedalled = evaluateAutoPause({
    enabled: true,
    isRunning: true,
    isAutoPaused: false,
    instantPower: 140,
    cadence: 85,
    dtSec: 1,
    zeroPedalSec: zeroSec,
  });
  assert.equal(pedalled.shouldAutoPause, false);
  assert.equal(pedalled.zeroPedalSec, 0);

  // Reaching 5s triggers auto-pause
  const triggered = evaluateAutoPause({
    enabled: true,
    isRunning: true,
    isAutoPaused: false,
    instantPower: 0,
    cadence: 0,
    dtSec: 1,
    zeroPedalSec: 4,
  });
  assert.equal(triggered.shouldAutoPause, true);
  assert.equal(triggered.zeroPedalSec, 5);

  // Pedalling again while auto-paused triggers auto-resume
  const resumed = evaluateAutoPause({
    enabled: true,
    isRunning: false,
    isAutoPaused: true,
    instantPower: 120,
    cadence: 75,
    dtSec: 0.25,
    zeroPedalSec: 5,
  });
  assert.equal(resumed.shouldAutoResume, true);
  assert.equal(resumed.zeroPedalSec, 0);
});

test('ground grid UV scroll offset advances positively so lines move down the screen toward rider', () => {
  const repeatY = 42;
  const spanM = 240;
  const off0 = computeForwardScrollOffset(0, repeatY, spanM);
  const off1 = computeForwardScrollOffset(1.0, repeatY, spanM);
  const off2 = computeForwardScrollOffset(2.5, repeatY, spanM);
  assert.equal(off0, 0);
  assert.ok(off1 > off0 && off1 < 1, `Expected positive forward offset, got ${off1}`);
  assert.ok(off2 > off1 && off2 < 1, `Expected monotonic increase within tile, got ${off2}`);

  // Advancing by 1 full tile wraps cleanly back near 0
  const tileMeters = spanM / repeatY;
  const wrapped = computeForwardScrollOffset(tileMeters, repeatY, spanM);
  assert.ok(wrapped < 1e-9 || Math.abs(wrapped - 1) < 1e-9);
});

test('speed streaks are hidden in Zone 1 & Zone 2 and accelerate across Zone 3+', () => {
  const z1 = computeSpeedStreakParams(1, 10, 0.1, 'high');
  const z2 = computeSpeedStreakParams(2, 10, 0.25, 'high');
  assert.equal(z1.visible, false);
  assert.equal(z1.activeCount, 0);
  assert.equal(z2.visible, false);
  assert.equal(z2.activeCount, 0);

  const z3 = computeSpeedStreakParams(3, 10, 0.36, 'high');
  const z4 = computeSpeedStreakParams(4, 10, 0.54, 'high');
  const z5 = computeSpeedStreakParams(5, 10, 0.72, 'high');
  const z6 = computeSpeedStreakParams(6, 10, 0.9, 'high');
  const z7 = computeSpeedStreakParams(7, 10, 1.0, 'high');

  assert.equal(z3.visible, true);
  assert.ok(z3.activeCount > 0);
  assert.ok(z4.travelSpeed > z3.travelSpeed);
  assert.ok(z5.travelSpeed > z4.travelSpeed);
  assert.ok(z6.travelSpeed > z5.travelSpeed);
  assert.ok(z7.travelSpeed > z6.travelSpeed);
});

test('Cloud Horizon low-poly bushes are 16x less frequent than Palm Grove palms', () => {
  const ratio = CLOUD_HORIZON_BUSH_SPACING_M / PALM_GROVE_AVG_SPACING_M;
  assert.ok(Math.abs(ratio - 16) < 1e-6, `Expected 16x spacing ratio, got ${ratio}`);
});

test('BLE parsers decode CSC cadence (with 16-bit rollover), FTMS bike data, Cycling Power, and HRM accurately', () => {
  // 1) BLE CSC 0x2A5B: Crank-only (flags=0x02), 2 revs in 1.333s (1365 ticks @ 1024Hz) => ~90.0 RPM
  let crankState = createCrankRevState();
  const csc1 = new DataView(new ArrayBuffer(5));
  csc1.setUint8(0, 0x02);
  csc1.setUint16(1, 65535, true); // right before uint16 rollover
  csc1.setUint16(3, 65000, true);
  const res1 = parseCscMeasurement(csc1, crankState);
  assert.equal(res1.hasCrankData, true);
  assert.equal(res1.rpm, null); // first baseline packet
  crankState = res1.nextState;

  // Next packet wraps both crank revs (65535 -> 1 = +2 revs) and event time (65000 -> 829 = +1365 ticks = 1.333s)
  const csc2 = new DataView(new ArrayBuffer(5));
  csc2.setUint8(0, 0x02);
  csc2.setUint16(1, 1, true);
  csc2.setUint16(3, (65000 + 1365) & 0xffff, true);
  const res2 = parseCscMeasurement(csc2, crankState);
  assert.equal(res2.newEvent, true);
  assert.ok(res2.rpm !== null && Math.abs(res2.rpm - 90) < 0.2, `Expected ~90 rpm, got ${res2.rpm}`);

  // 2) BLE FTMS Indoor Bike Data 0x2AD2: speed present (bit 0=0), cadence present (bit 2=1), power present (bit 6=1)
  const ftms = new DataView(new ArrayBuffer(8));
  ftms.setUint16(0, 0x0044, true); // bit 2 (cadence) + bit 6 (power), bit 0 = 0 (speed present)
  ftms.setUint16(2, 3450, true); // 34.50 km/h
  ftms.setUint16(4, 184, true); // 184 * 0.5 = 92.0 rpm
  ftms.setInt16(6, 245, true); // 245 W
  const parsedFtms = parseFtmsIndoorBikeData(ftms);
  assert.equal(parsedFtms.speedKmh, 34.5);
  assert.equal(parsedFtms.cadenceRpm, 92);
  assert.equal(parsedFtms.instantPowerW, 245);

  // 3) BLE Cycling Power 0x2A63 with crank revolution data (bit 5 = 0x0020)
  let cpState = createCrankRevState();
  const cp1 = new DataView(new ArrayBuffer(8));
  cp1.setUint16(0, 0x0020, true);
  cp1.setInt16(2, 210, true);
  cp1.setUint16(4, 100, true);
  cp1.setUint16(6, 1000, true);
  cpState = parseCyclingPowerMeasurement(cp1, cpState).cadence.nextState;

  const cp2 = new DataView(new ArrayBuffer(8));
  cp2.setUint16(0, 0x0020, true);
  cp2.setInt16(2, 215, true);
  cp2.setUint16(4, 101, true); // +1 rev
  cp2.setUint16(6, 1000 + 1024, true); // +1.000s => exact 60 RPM
  const parsedCp = parseCyclingPowerMeasurement(cp2, cpState);
  assert.equal(parsedCp.instantPowerW, 215);
  assert.equal(parsedCp.cadence.rpm, 60);

  // 4) BLE HRM 0x2A37 (8-bit BPM)
  const hr = new DataView(new ArrayBuffer(2));
  hr.setUint8(0, 0x00);
  hr.setUint8(1, 152);
  assert.equal(parseHeartRateMeasurement(hr), 152);
});

test('cadenceMatcher locks 3D model crank angular velocity 1:1 to Bluetooth sensor RPM and coasts on stale packets', () => {
  const matcher = createCadenceMatcherState();
  let nowMs = 10000;

  // Ramp to exact 90 RPM over 2 seconds of 60Hz frames
  for (let i = 0; i < 120; i++) {
    nowMs += 16.6667;
    stepCadenceMatcher(
      matcher,
      {
        sensorRpm: 90,
        lastPacketMs: nowMs - 100,
        nowMs,
        enabled: true,
        fallbackRpm: 0,
      },
      1 / 60
    );
  }
  assert.ok(Math.abs(matcher.currentRpm - 90) < 0.2, `Expected lock to 90 RPM, got ${matcher.currentRpm}`);

  // Over exactly 1.000s at 90 RPM, crank must rotate 1.5 revolutions = 3π radians
  const radStart = matcher.crankRad;
  for (let i = 0; i < 60; i++) {
    nowMs += 16.6667;
    stepCadenceMatcher(
      matcher,
      {
        sensorRpm: 90,
        lastPacketMs: nowMs - 50,
        nowMs,
        enabled: true,
        fallbackRpm: 0,
      },
      1 / 60
    );
  }
  const deltaRad = matcher.crankRad - radStart;
  const expectedRad = (90 / 60) * Math.PI * 2;
  assert.ok(
    Math.abs(deltaRad - expectedRad) < 0.02,
    `Expected ${expectedRad.toFixed(3)} rad/s at 90 RPM, got ${deltaRad.toFixed(3)}`
  );

  // Stop sending fresh packets (>3000ms stale): matcher must coast cleanly to 0 RPM
  const stalePacketMs = nowMs;
  nowMs += 3500;
  for (let i = 0; i < 180; i++) {
    nowMs += 16.6667;
    stepCadenceMatcher(
      matcher,
      {
        sensorRpm: 90,
        lastPacketMs: stalePacketMs,
        nowMs,
        enabled: true,
        fallbackRpm: 0,
      },
      1 / 60
    );
  }
  assert.equal(matcher.staleZeroed, true);
  assert.equal(matcher.currentRpm, 0);
});

test('solveTwoBoneLegIK maintains exact bone lengths and forward-bending knee across full 360° crank stroke', () => {
  const hipY = 1.03;
  const hipZ = 0.19;
  const thighLen = 0.44;
  const shinLen = 0.43;

  for (let deg = 0; deg < 360; deg += 15) {
    const theta = (deg * Math.PI) / 180;
    const pedalY = 0.38 + 0.165 * Math.cos(theta);
    const pedalZ = 0.06 - 0.165 * Math.sin(theta);
    const pose = solveTwoBoneLegIK(hipY, hipZ, pedalY, pedalZ, thighLen, shinLen);

    assert.ok(Number.isFinite(pose.kneeY) && Number.isFinite(pose.kneeZ));
    // Knee must bend forward (-Z) relative to hip
    assert.ok(pose.kneeZ < hipZ, `Knee bent backward at ${deg}°: kneeZ=${pose.kneeZ}, hipZ=${hipZ}`);

    const actualThigh = Math.hypot(pose.kneeY - hipY, pose.kneeZ - hipZ);
    const actualShin = Math.hypot(pedalY - pose.kneeY, pedalZ - pose.kneeZ);
    assert.ok(Math.abs(actualThigh - thighLen) < 1e-4, `Thigh length drift at ${deg}°: ${actualThigh}`);
    assert.ok(Math.abs(actualShin - shinLen) < 1e-4, `Shin length drift at ${deg}°: ${actualShin}`);
  }
});

test('non-linear road LOD allocates denser near segments, preserves linear world-meter UVs, and extends draw distance', () => {
  assert.ok(ROAD_Z_SPAN >= 260, `Expected extended road draw span >= 260m, got ${ROAD_Z_SPAN}`);
  assert.ok(WORLD_CAMERA_NEAR >= 0.4, `Expected near plane >= 0.4 for depth precision, got ${WORLD_CAMERA_NEAR}`);
  assert.ok(SKY_DOME_RADIUS > ROAD_Z_SPAN, 'Sky dome must enclose full road draw distance');
  assert.ok(PALM_GROVE_CLIFF_WIDTH >= 600, 'Palm Grove cliffs must cover ultrawide horizontal frustum');

  // Monotonic decreasing Z from ROAD_Z_NEAR to ROAD_Z_FAR, denser near camera than near horizon
  const z0 = computeRoadSegmentZ(0, ROAD_SEGMENTS);
  const z1 = computeRoadSegmentZ(1, ROAD_SEGMENTS);
  const zPrev = computeRoadSegmentZ(ROAD_SEGMENTS - 1, ROAD_SEGMENTS);
  const zLast = computeRoadSegmentZ(ROAD_SEGMENTS, ROAD_SEGMENTS);

  assert.equal(z0, ROAD_Z_NEAR);
  assert.equal(zLast, ROAD_Z_FAR);

  const nearStep = z0 - z1;
  const farStep = zPrev - zLast;
  assert.ok(
    nearStep > 0 && farStep > nearStep * 2,
    `Expected denser near segments (${nearStep.toFixed(2)}m) than far (${farStep.toFixed(2)}m)`
  );

  // Linear world-meter UV t stays strictly linear with world Z even under non-linear vertex spacing
  const tNear = computeLinearRoadT(ROAD_Z_NEAR);
  const tMid = computeLinearRoadT((ROAD_Z_NEAR + ROAD_Z_FAR) * 0.5);
  const tFar = computeLinearRoadT(ROAD_Z_FAR);
  assert.equal(tNear, 0);
  assert.ok(Math.abs(tMid - 0.5) < 1e-9);
  assert.equal(tFar, 1);
});

test('Neon City buildings sit cleanly behind the full raised sidewalk across all building widths', () => {
  const widths = [3.5, 4.2, 5.8, 8.0];
  for (const w of widths) {
    const center = computeBuildingCenterOffset(w, NEON_CITY_MIN_BUILDING_FRONT_X, 0);
    const frontFaceX = center - w * 0.5;
    const clearSidewalkWidth = frontFaceX - (ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP);
    assert.ok(
      clearSidewalkWidth >= NEON_CITY_SIDEWALK_WIDTH,
      `Expected >= ${NEON_CITY_SIDEWALK_WIDTH}m sidewalk clearance for width ${w}, got ${clearSidewalkWidth.toFixed(2)}m`
    );
  }
});

test('frustumCuller accurately rejects behind-camera, off-axis, and far instances while keeping visible objects', () => {
  const cam = new THREE.PerspectiveCamera(54, 0.82, 0.45, 320);
  cam.position.set(0, 2.4, 5.0);
  cam.lookAt(0, 1.4, -14);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();

  const projScreen = new THREE.Matrix4().multiplyMatrices(
    cam.projectionMatrix,
    cam.matrixWorldInverse
  );
  const planes = extractFrustumPlanes(projScreen.elements, new Float32Array(24));

  // Directly ahead on the boulevard -> visible
  assert.equal(isSphereInFrustum(planes, 0, 2, -30, 2), true);
  assert.equal(isAabbInFrustum(planes, 10, 12, -45, 3, 12, 3), true);

  // Behind the camera -> culled
  assert.equal(isSphereInFrustum(planes, 0, 2, 12, 2), false);
  assert.equal(isAabbInFrustum(planes, 10, 10, 14, 3, 10, 3), false);

  // Far off to the side outside narrow portrait FOV -> culled
  assert.equal(isSphereInFrustum(planes, 95, 5, -25, 3), false);
  assert.equal(isAabbInFrustum(planes, -140, 18, -60, 4, 18, 4), false);

  // Beyond far clipping plane -> culled
  assert.equal(isSphereInFrustum(planes, 0, 5, -400, 4), false);

  // Tighter FOV culls strictly more off-axis instances than a wide FOV
  const narrowCam = new THREE.PerspectiveCamera(46, 0.82, 0.45, 320);
  narrowCam.position.copy(cam.position);
  narrowCam.lookAt(0, 1.4, -14);
  narrowCam.updateProjectionMatrix();
  narrowCam.updateMatrixWorld();
  const wideCam = new THREE.PerspectiveCamera(78, 0.82, 0.45, 320);
  wideCam.position.copy(cam.position);
  wideCam.lookAt(0, 1.4, -14);
  wideCam.updateProjectionMatrix();
  wideCam.updateMatrixWorld();

  const narrowPlanes = extractFrustumPlanes(
    new THREE.Matrix4().multiplyMatrices(narrowCam.projectionMatrix, narrowCam.matrixWorldInverse).elements,
    new Float32Array(24)
  );
  const widePlanes = extractFrustumPlanes(
    new THREE.Matrix4().multiplyMatrices(wideCam.projectionMatrix, wideCam.matrixWorldInverse).elements,
    new Float32Array(24)
  );

  let narrowVisible = 0;
  let wideVisible = 0;
  for (let x = -180; x <= 180; x += 12) {
    if (isAabbInFrustum(narrowPlanes, x, 10, -80, 3, 10, 3)) narrowVisible += 1;
    if (isAabbInFrustum(widePlanes, x, 10, -80, 3, 10, 3)) wideVisible += 1;
  }
  assert.ok(
    narrowVisible < wideVisible,
    `Expected tighter FOV to draw fewer peripheral instances (${narrowVisible} vs ${wideVisible})`
  );

  // Adaptive FOV stays bounded across portrait, tablet, and ultrawide
  for (const aspect of [0.6, 0.82, 1.33, 1.6, 2.34, 3.2]) {
    const framing = computeAdaptiveCameraFraming(aspect, 3.5);
    assert.ok(
      framing.fov >= CAMERA_FOV_MIN && framing.fov <= CAMERA_FOV_MAX,
      `Aspect ${aspect} produced out-of-bounds FOV ${framing.fov}`
    );
  }

  // Fog cull distance shrinks monotonically with denser fog
  assert.ok(computeFogCullDistance(0.008) < computeFogCullDistance(0.004));
});

test('Neon City extended sidewalk doubles paved width and eliminates all under-building floor gaps', () => {
  // Paved sidewalk is ~2x the open walkway width and slides cleanly beneath building fronts
  assert.ok(
    NEON_CITY_SIDEWALK_PAVED_WIDTH >= NEON_CITY_SIDEWALK_WIDTH * 2,
    `Expected paved sidewalk >= 2x walkway (${NEON_CITY_SIDEWALK_WIDTH * 2}m), got ${NEON_CITY_SIDEWALK_PAVED_WIDTH}m`
  );
  const pavedOuterX = ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP + NEON_CITY_SIDEWALK_PAVED_WIDTH;
  assert.ok(
    pavedOuterX > NEON_CITY_MIN_BUILDING_FRONT_X + 2.0,
    `Expected paved sidewalk (${pavedOuterX.toFixed(2)}m) to extend well beneath building fronts (${NEON_CITY_MIN_BUILDING_FRONT_X}m)`
  );

  // Total floor apron extends beyond the deepest possible building back edge so zero gaps can ever appear
  const maxBuildingBackX =
    NEON_CITY_MIN_BUILDING_FRONT_X + NEON_CITY_BUILDING_MAX_JITTER + NEON_CITY_BUILDING_MAX_WIDTH;
  const totalFloorOuterX = ROAD_HALF_WIDTH + NEON_CITY_CURB_GAP + NEON_CITY_SIDEWALK_TOTAL_WIDTH;
  assert.ok(
    totalFloorOuterX > maxBuildingBackX + 5.0,
    `Expected continuous floor outer X (${totalFloorOuterX.toFixed(2)}m) > deepest building back edge (${maxBuildingBackX.toFixed(2)}m)`
  );
});

test('Island Causeway embankment and Cloud Horizon 2D cloud sprite geometry budgets are valid', () => {
  // Raised embankment drops cleanly to Wadden Sea level with a wide sloped armor bank
  assert.ok(CAUSEWAY_EMBANKMENT_DROP_M >= 2.0, 'Embankment must visibly rise above sea level');
  assert.ok(
    CAUSEWAY_EMBANKMENT_TOE_X >= ROAD_HALF_WIDTH + 5.0,
    'Embankment slope toe must extend cleanly outward from road shoulder'
  );

  // Instanced 2D quad cloud sprites (2 tris each) are >10x cheaper than old 48x36 = 1,728 3D dodecahedron tris
  const spriteTriangles = CLOUD_HORIZON_SPRITE_COUNT * 2;
  const legacy3dTriangles = 48 * 36;
  assert.ok(
    spriteTriangles * 10 < legacy3dTriangles,
    `Expected 2D cloud sprites (${spriteTriangles} tris) to be >10x cheaper than 3D (${legacy3dTriangles} tris)`
  );
});

test('synthwave audio volume clamping, gain routing, pause ducking, and zone-adaptive mix parameters', () => {
  // Volume clamping handles out-of-range & non-finite inputs safely
  assert.equal(clampAudioVolume(-0.5, 0.5), 0);
  assert.equal(clampAudioVolume(1.8, 0.5), 1);
  assert.equal(clampAudioVolume(Number.NaN, DEFAULT_AUDIO_MASTER_VOLUME), DEFAULT_AUDIO_MASTER_VOLUME);
  assert.equal(clampAudioVolume(undefined, 0.4), 0.4);

  // MIDI A4 = 69 -> 440 Hz, A3 = 57 -> 220 Hz
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-6);
  assert.ok(Math.abs(midiToFreq(57) - 220) < 1e-6);

  // Disabled or muted always yields 0 gain
  assert.equal(
    computeEffectiveMasterGain({
      enabled: false,
      muted: false,
      masterVolume: 0.8,
      menuVolume: 0.7,
      rideVolume: 0.9,
      screen: 'menu',
      runState: 'idle',
    }),
    0
  );
  assert.equal(
    computeEffectiveMasterGain({
      enabled: true,
      muted: true,
      masterVolume: 0.8,
      menuVolume: 0.7,
      rideVolume: 0.9,
      screen: 'ride',
      runState: 'running',
    }),
    0
  );

  // Main Menu uses menuVolume; Ride uses rideVolume; full volume is perceptually capped <= 0.85
  const menuGain = computeEffectiveMasterGain({
    enabled: true,
    muted: false,
    masterVolume: 1,
    menuVolume: 0.5,
    rideVolume: 1,
    screen: 'menu',
    runState: 'idle',
  });
  const rideRunningGain = computeEffectiveMasterGain({
    enabled: true,
    muted: false,
    masterVolume: 1,
    menuVolume: 0.5,
    rideVolume: 1,
    screen: 'ride',
    runState: 'running',
  });
  const ridePausedGain = computeEffectiveMasterGain({
    enabled: true,
    muted: false,
    masterVolume: 1,
    menuVolume: 0.5,
    rideVolume: 1,
    screen: 'ride',
    runState: 'paused',
  });

  assert.ok(menuGain > 0 && menuGain < rideRunningGain);
  assert.ok(rideRunningGain <= 0.85 + 1e-9);
  assert.ok(ridePausedGain > 0 && ridePausedGain < rideRunningGain, 'Paused ride should gently duck volume');

  // Menu mix is dreamy/relaxed; Ride mix scales BPM, bass pulse, arp, and filter cutoff monotonically with Coggan zone
  const menuMix = computeSynthwaveMixParams({
    screen: 'menu',
    runState: 'idle',
    zone: 2,
    sceneryTheme: 'neon-city',
  });
  const rideZ1 = computeSynthwaveMixParams({
    screen: 'ride',
    runState: 'running',
    zone: 1,
    sceneryTheme: 'neon-city',
  });
  const rideZ4 = computeSynthwaveMixParams({
    screen: 'ride',
    runState: 'running',
    zone: 4,
    sceneryTheme: 'neon-city',
  });
  const rideZ7 = computeSynthwaveMixParams({
    screen: 'ride',
    runState: 'running',
    zone: 7,
    sceneryTheme: 'neon-city',
  });

  assert.equal(menuMix.bpm, 86);
  assert.ok(rideZ1.bpm >= menuMix.bpm);
  assert.ok(rideZ4.bpm > rideZ1.bpm && rideZ7.bpm > rideZ4.bpm);
  assert.ok(rideZ4.filterCutoffHz > rideZ1.filterCutoffHz && rideZ7.filterCutoffHz > rideZ4.filterCutoffHz);
  assert.ok(rideZ7.bassLevel > rideZ1.bassLevel);
  assert.ok(rideZ7.arpLevel > menuMix.arpLevel);

  // Scenery themes provide distinct musical key transpositions
  const offsets = new Set([
    getThemeRootOffset('neon-city'),
    getThemeRootOffset('palm-grove'),
    getThemeRootOffset('cloud-horizon'),
    getThemeRootOffset('causeway-embankment'),
  ]);
  assert.equal(offsets.size, 4);
});

test('FIT Activity Name formats Free Ride and Workout with scenery and encodes into binary FIT sport & workout messages', () => {
  assert.equal(
    formatFitActivityName({
      rideMode: 'freeride',
      workoutName: 'Free Ride',
      sceneryTheme: 'neon-city',
    }),
    'Free Ride - Neon City'
  );
  assert.equal(
    formatFitActivityName({
      rideMode: 'workout',
      workoutName: 'Progressions',
      sceneryTheme: 'palm-grove',
    }),
    'Progressions - Palm Grove'
  );
  assert.equal(
    formatFitActivityName({
      rideMode: 'freeride',
      workoutName: 'Free Ride',
      sceneryTheme: 'cloud-horizon',
      visitedSceneries: ['neon-city', 'palm-grove', 'cloud-horizon'],
    }),
    'Free Ride - Neon City + 2 Worlds'
  );
  assert.equal(getSceneryDisplayName('causeway-embankment'), 'Island Causeway');

  // Verify binary FIT embeds Activity Name cleanly into both sport (global 12) and workout (global 26)
  const recorder = new RideRecorder();
  const t0 = Date.UTC(2026, 10, 27, 20, 33, 0);
  recorder.beginSession('freeride-session', 'Free Ride', 250, t0, 2, 'Free Ride · Z2 Endurance', {
    activityName: 'Free Ride - Island Causeway',
    sceneryName: 'Island Causeway',
  });
  for (let i = 0; i < 6; i++) {
    recorder.recordSample({
      timestampMs: t0 + (i + 1) * 1000,
      dtSec: 1,
      elapsedSec: i + 1,
      power: 190,
      heartRate: 138,
      cadence: 88,
      speedKmh: 36,
      gradePct: 1,
      stepIndex: 2,
      stepLabel: 'Free Ride · Z2 Endurance',
    });
  }
  const ride = recorder.finalize(t0 + 6000);
  assert.ok(ride);
  assert.equal(ride.activityName, 'Free Ride - Island Causeway');

  const bytes = encodeRideToFit(ride);
  const summary = verifyFitBinary(bytes);
  assert.equal(summary.validHeaderSignature, true);
  assert.equal(summary.headerCrcValid, true);
  assert.equal(summary.fileCrcValid, true);
  assert.equal(summary.sportActivityName, 'Free Ride - Island Causeway');
  assert.equal(summary.workoutActivityName, 'Free Ride - Island Causeway');

  const fileName = buildFitFileName(ride);
  assert.ok(
    fileName.startsWith('EndlessHorizon_Free-Ride-Island-Causeway_'),
    `Unexpected FIT filename: ${fileName}`
  );
});

test('lineArtTracer extracts an ordered polyline from RGBA pixels and Single-Line Bike produces 1:1 conformal GPS plot', () => {
  // 1) Synthetic 64x64 white canvas with a crisp dark L-shaped single-stroke line
  const w = 64;
  const h = 64;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const paintDark = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && px < w && py >= 0 && py < h) {
          const idx = (py * w + px) * 4;
          rgba[idx] = 10;
          rgba[idx + 1] = 10;
          rgba[idx + 2] = 10;
          rgba[idx + 3] = 255;
        }
      }
    }
  };
  for (let x = 8; x <= 48; x++) paintDark(x, 52);
  for (let y = 52; y >= 12; y--) paintDark(48, y);

  const traced = traceLineDrawingRgba(rgba, w, h);
  assert.ok(traced.points.length >= 3, `Expected >= 3 traced points, got ${traced.points.length}`);
  assert.ok(traced.edgeCoverage >= 0.9, `Expected >= 90% coverage, got ${traced.edgeCoverage}`);

  // 2) Verify built-in Single-Line Bike GPS Art path preserves 1:1 conformal aspect ratio around Ura-shima
  assert.ok(BIKE_LINE_ART_POINTS.length > 100);
  assert.ok(BIKE_LINE_ART_POINTS[0].x < 0.05 && BIKE_LINE_ART_POINTS[0].y < 0.05);
  const lastPt = BIKE_LINE_ART_POINTS[BIKE_LINE_ART_POINTS.length - 1];
  assert.ok(lastPt.x > 2.3 && lastPt.y < 0.05);

  const compiled = compileGpsRoute('bike-line-art', 'Single-Line Bike', BIKE_LINE_ART_POINTS, 15000, false);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (let d = 0; d <= compiled.totalLengthM; d += 25) {
    const pt = sampleCompiledRouteGps(compiled, d);
    if (pt.latDeg < minLat) minLat = pt.latDeg;
    if (pt.latDeg > maxLat) maxLat = pt.latDeg;
    if (pt.lonDeg < minLon) minLon = pt.lonDeg;
    if (pt.lonDeg > maxLon) maxLon = pt.lonDeg;
  }
  const cosLat = Math.cos((URASHIMA_CENTER_LAT * Math.PI) / 180);
  const gpsAspect = ((maxLon - minLon) * cosLat) / (maxLat - minLat);
  const srcMinX = Math.min(...BIKE_LINE_ART_POINTS.map((p) => p.x));
  const srcMaxX = Math.max(...BIKE_LINE_ART_POINTS.map((p) => p.x));
  const srcMinY = Math.min(...BIKE_LINE_ART_POINTS.map((p) => p.y));
  const srcMaxY = Math.max(...BIKE_LINE_ART_POINTS.map((p) => p.y));
  const srcAspect = (srcMaxX - srcMinX) / (srcMaxY - srcMinY);
  assert.ok(
    Math.abs(gpsAspect - srcAspect) < 0.03,
    `Expected conformal 1:1 GPS aspect (${srcAspect.toFixed(3)}), got ${gpsAspect.toFixed(3)}`
  );
});

test('GPS Art corner curvature stays bounded on tight 180-deg hairpins and drives smooth non-folding 3D road bends', () => {
  // Construct a sharp 180-degree right hairpin (goes East, makes a tiny-radius U-turn right, returns West)
  const hairpinPts = [
    { x: 0, y: 0.5 },
    { x: 1.0, y: 0.5 },
    { x: 1.02, y: 0.48 },
    { x: 1.0, y: 0.46 },
    { x: 0, y: 0.46 },
  ];
  const hairpin = compileGpsRoute('custom-drawing', 'Sharp Hairpin', hairpinPts, 4000, false);

  let maxAbsK = 0;
  let peakRightK = 0;
  for (let d = 0; d <= hairpin.totalLengthM; d += 10) {
    const k = sampleCompiledRouteCurvature(hairpin, d);
    assert.ok(Number.isFinite(k));
    if (Math.abs(k) > maxAbsK) maxAbsK = Math.abs(k);
    if (k > peakRightK) peakRightK = k;
  }
  assert.ok(
    maxAbsK <= MAX_IN_GAME_CURVATURE + 1e-6,
    `Expected bounded curvature <= ${MAX_IN_GAME_CURVATURE}, got ${maxAbsK}`
  );
  assert.ok(
    peakRightK > MAX_IN_GAME_CURVATURE * 0.5,
    `Expected strong positive (right-turn) curvature into right hairpin, got ${peakRightK}`
  );

  // Drive WorldRuntimeState curve LUT right before the hairpin apex (~1940m)
  const rt = createWorldRuntime();
  rt.gpsRoute = hairpin;
  rt.distance = 1940;
  updateRoadCurveLut(rt);
  assert.equal(rt.curveLutReady, true);

  // At rider position (z = 0), centerline stays anchored near x = 0
  const atBike = sampleRoadAtZ(rt.distance, 0, { x: 0, y: 0, slopeX: 0, slopeY: 0 }, null, 0, null, rt);
  assert.ok(Math.abs(atBike.x) < 0.25, `Expected road anchored near x=0 at bike, got ${atBike.x}`);

  // Ahead into the right hairpin (z = -120m), road bends cleanly to +X (right) with bounded non-folding slope
  const ahead = sampleRoadAtZ(rt.distance, -120, { x: 0, y: 0, slopeX: 0, slopeY: 0 }, null, 0, null, rt);
  assert.ok(ahead.x > 10, `Expected visible right corner bend (+X > 10m), got ${ahead.x.toFixed(2)}m`);
  const maxAllowedSlope = Math.tan(MAX_VISIBLE_HEADING_RAD) + 1e-4;
  assert.ok(
    Math.abs(ahead.slopeX) <= maxAllowedSlope,
    `Expected non-folding road slope <= ${maxAllowedSlope.toFixed(3)}, got ${ahead.slopeX.toFixed(3)}`
  );
});

test('computeCornerLeanAngle leans bike INTO corners (negative Z roll for right turns, positive Z roll for left turns)', () => {
  // Stopped bike stands upright
  assert.equal(computeCornerLeanAngle(0.02, true, 0), 0);
  assert.equal(computeCornerLeanAngle(-0.02, true, 0.4), 0);

  // Right turn (curvature > 0) -> negative rotation.z in Three.js tilts top of bike RIGHT (+X)
  const rightGpsLean = computeCornerLeanAngle(0.015, true, 10);
  assert.ok(rightGpsLean < 0 && rightGpsLean >= -0.28, `Expected negative roll for right GPS corner, got ${rightGpsLean}`);
  const rightDefaultLean = computeCornerLeanAngle(0.12, false, 10);
  assert.ok(rightDefaultLean < 0 && rightDefaultLean >= -0.22);

  // Left turn (curvature < 0) -> positive rotation.z tilts top of bike LEFT (-X)
  const leftGpsLean = computeCornerLeanAngle(-0.015, true, 10);
  assert.ok(leftGpsLean > 0 && leftGpsLean <= 0.28, `Expected positive roll for left GPS corner, got ${leftGpsLean}`);
  const leftDefaultLean = computeCornerLeanAngle(-0.12, false, 10);
  assert.ok(leftDefaultLean > 0 && leftDefaultLean <= 0.22);
});

test('adaptive music engine logic maps Z5/6/7->Z5, enforces 3s hysteresis, 5s interval anticipation, and Low quality budget', () => {
  // Key of A minor 8-bar progression starts with Am, F, C, G
  assert.equal(AM_CHORD_PROGRESSION_8BAR.length, 8);
  assert.deepEqual(
    AM_CHORD_PROGRESSION_8BAR.slice(0, 4).map((c) => c.name),
    ['Am', 'F', 'C', 'G']
  );

  // Zones 5, 6, 7 all map to MusicZone 5
  assert.equal(mapCogganToMusicZone(1), 1);
  assert.equal(mapCogganToMusicZone(4), 4);
  assert.equal(mapCogganToMusicZone(5), 5);
  assert.equal(mapCogganToMusicZone(6), 5);
  assert.equal(mapCogganToMusicZone(7), 5);

  // Exact BPM ladder & smooth 4-bar ramp duration
  assert.deepEqual(ZONE_BPM, { 1: 90, 2: 100, 3: 110, 4: 122, 5: 132 });
  const rampSec = computeFourBarRampSeconds(100, 120);
  assert.ok(rampSec > 8.5 && rampSec < 9.0, `Expected ~8.73s 4-bar ramp, got ${rampSec}`);

  // Quality Low disables reverb, extra high arp, lead, and saturation
  const lowZ5 = computeEffectiveMusicLayers(5, 'low', true);
  assert.equal(lowZ5.reverbWet, 0);
  assert.equal(lowZ5.highArp, 0);
  assert.equal(lowZ5.lead, 0);
  assert.equal(lowZ5.saturationWet, 0);
  assert.ok(lowZ5.kick > 0 && lowZ5.bass > 0);

  // 3-second hysteresis ignores brief spikes and switches only after 3.0s stability
  let hState = createZoneHysteresisState(2);
  let res = stepZoneHysteresis(hState, 4, 2.5);
  assert.equal(res.changed, false);
  assert.equal(res.activeZone, 2);
  hState = res.nextState;

  // Brief dip back resets timer
  res = stepZoneHysteresis(hState, 2, 0.25);
  assert.equal(res.changed, false);
  hState = res.nextState;

  // Continuous 3.0s at Z4 triggers UP switch
  res = stepZoneHysteresis(hState, 4, 1.5);
  assert.equal(res.changed, false);
  res = stepZoneHysteresis(res.nextState, 4, 1.5);
  assert.equal(res.changed, true);
  assert.equal(res.activeZone, 4);
  assert.equal(res.direction, 'up');

  // Target vs Actual (3s avg) resolution
  assert.equal(
    resolveMusicCandidateZone({
      followMode: 'target',
      rideMode: 'workout',
      targetStepZone: 4,
      freeRideZone: 2,
      power3sAvg: 120,
      ftp: 250,
    }),
    4
  );
  assert.equal(
    resolveMusicCandidateZone({
      followMode: 'actual',
      rideMode: 'workout',
      targetStepZone: 4,
      freeRideZone: 2,
      power3sAvg: 300, // 120% FTP -> Z5/Z6 -> MusicZone 5
      ftp: 250,
    }),
    5
  );

  // 5-second interval anticipation fires only when next step steps UP a music zone
  const stepUp = evaluateIntervalAnticipation({
    runState: 'running',
    rideMode: 'workout',
    countdownSec: 5,
    currentMusicZone: 2,
    nextStepPowerLow: 0.95, // Z4
  });
  assert.equal(stepUp.active, true);
  assert.equal(stepUp.nextMusicZone, 4);

  const stepDown = evaluateIntervalAnticipation({
    runState: 'running',
    rideMode: 'workout',
    countdownSec: 4,
    currentMusicZone: 4,
    nextStepPowerLow: 0.5, // Z1
  });
  assert.equal(stepDown.active, false);
});

test('Step 1: RideRecorder emits append-only delta chunks, reassembles out-of-order chunks, resumes, and exports valid FIT', () => {
  const recorder = new RideRecorder();
  const t0 = Date.UTC(2026, 10, 27, 10, 0, 0);
  recorder.beginSession('w-step1', 'Progressions', 250, t0, 0, 'Warmup', {
    activityName: 'Progressions - Neon City',
    sceneryName: 'Neon City',
    sessionId: 'sess-step1-test',
  });

  const storedChunks = [];
  let latestMeta = null;

  // Record 7 seconds in step 0 -> triggers checkpoint 0
  for (let i = 1; i <= 7; i++) {
    recorder.recordSample({
      timestampMs: t0 + i * 1000,
      dtSec: 1,
      elapsedSec: i,
      power: 160 + i,
      heartRate: 130 + i,
      cadence: 88,
      speedKmh: 32,
      gradePct: 2,
      stepIndex: 0,
      stepLabel: 'Warmup',
    });
  }
  assert.equal(recorder.shouldCheckpoint(t0 + 5000, CHECKPOINT_INTERVAL_MS), false);
  assert.equal(recorder.shouldCheckpoint(t0 + 7000, CHECKPOINT_INTERVAL_MS), true);

  const p0 = recorder.extractCheckpointDelta({
    rideMode: 'workout',
    sceneryTheme: 'neon-city',
    visitedSceneries: ['neon-city'],
    elapsedSec: 7,
    freeRideZone: 2,
    freeRideOffsetWatts: 0,
    nowMs: t0 + 7000,
  });
  assert.ok(p0 && p0.chunk);
  assert.equal(p0.chunk.seq, 0);
  assert.equal(p0.chunk.samples.length, 7);
  assert.equal(p0.chunk.closedLaps.length, 0);
  storedChunks.push(p0.chunk);
  latestMeta = p0.meta;

  // Immediately extracting again with no new samples returns null (append-only, no duplicates)
  assert.equal(
    recorder.extractCheckpointDelta({
      rideMode: 'workout',
      sceneryTheme: 'neon-city',
      visitedSceneries: ['neon-city'],
      elapsedSec: 7,
      freeRideZone: 2,
      freeRideOffsetWatts: 0,
      nowMs: t0 + 7500,
    }),
    null
  );

  // Transition to step 1 and record 8 more seconds -> chunk 1 contains ONLY the 8 new samples + 1 closed lap
  for (let i = 8; i <= 15; i++) {
    recorder.recordSample({
      timestampMs: t0 + i * 1000,
      dtSec: 1,
      elapsedSec: i,
      power: 245,
      heartRate: 158,
      cadence: 92,
      speedKmh: 36,
      gradePct: 6,
      stepIndex: 1,
      stepLabel: 'Threshold Block',
    });
  }
  const p1 = recorder.extractCheckpointDelta({
    rideMode: 'workout',
    sceneryTheme: 'neon-city',
    visitedSceneries: ['neon-city'],
    elapsedSec: 15,
    freeRideZone: 2,
    freeRideOffsetWatts: 0,
    nowMs: t0 + 15000,
  });
  assert.ok(p1 && p1.chunk);
  assert.equal(p1.chunk.seq, 1);
  assert.equal(p1.chunk.samples.length, 8);
  assert.equal(p1.chunk.closedLaps.length, 1);
  assert.equal(p1.chunk.closedLaps[0].stepLabel, 'Warmup');
  storedChunks.push(p1.chunk);
  latestMeta = p1.meta;

  // Simulate tab crash & recovery with out-of-order + duplicate chunks
  const recovery = assembleRecoveryFromChunks(latestMeta, [storedChunks[1], storedChunks[0], storedChunks[1]]);
  assert.equal(recovery.chunks.length, 2);
  assert.equal(recovery.samples.length, 15);
  assert.equal(recovery.laps.length, 1);
  assert.equal(recovery.samples[0].elapsedSec, 1);
  assert.equal(recovery.samples[14].elapsedSec, 15);

  // Option A: Save & export unfinished ride directly to valid FIT
  const recoveredSavedRide = finalizeRecoveryToSavedRide(recovery);
  assert.equal(recoveredSavedRide.records.length, 15);
  assert.equal(recoveredSavedRide.laps.length, 2);
  assert.equal(recoveredSavedRide.activityName, 'Progressions - Neon City');
  const fitSummary = verifyFitBinary(encodeRideToFit(recoveredSavedRide));
  assert.equal(fitSummary.validHeaderSignature, true);
  assert.equal(fitSummary.headerCrcValid, true);
  assert.equal(fitSummary.fileCrcValid, true);
  assert.equal(fitSummary.messageCountsByGlobalNum[20], 15);
  assert.equal(fitSummary.messageCountsByGlobalNum[19], 2);

  // Option B: Resume recording seamlessly into a fresh RideRecorder instance after reload
  const resumed = new RideRecorder();
  resumed.restoreFromRecovery(recovery, null);
  assert.equal(resumed.getRecordCount(), 15);
  assert.equal(resumed.getLapCount(), 2);
  for (let i = 16; i <= 20; i++) {
    resumed.recordSample({
      timestampMs: t0 + i * 1000,
      dtSec: 1,
      elapsedSec: i,
      power: 260,
      heartRate: 162,
      cadence: 94,
      speedKmh: 38,
      gradePct: 6,
      stepIndex: 1,
      stepLabel: 'Threshold Block',
    });
  }
  const p2 = resumed.extractCheckpointDelta({
    rideMode: 'workout',
    sceneryTheme: 'neon-city',
    visitedSceneries: ['neon-city'],
    elapsedSec: 20,
    freeRideZone: 2,
    freeRideOffsetWatts: 0,
    nowMs: t0 + 20000,
  });
  assert.ok(p2 && p2.chunk);
  assert.equal(p2.chunk.seq, 2);
  assert.equal(p2.chunk.samples.length, 5);

  const finalRide = resumed.finalize(t0 + 20000);
  assert.ok(finalRide);
  assert.equal(finalRide.records.length, 20);
  assert.equal(finalRide.laps.length, 2);
});

test('Step 2: saved device persistence, exponential backoff schedule, trainer reconnect ERG recovery, and HR/Cadence error surfacing', async () => {
  // 1) localStorage persistence with upsert & role replacement
  const storeMap = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => storeMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storeMap.set(k, v);
    },
  };

  let list = loadSavedDevices(mockStorage);
  assert.deepEqual(list, []);

  list = upsertSavedDevice(list, { id: 'kickr-1', name: 'Wahoo KICKR V4', lastConnectedAt: 1000, role: 'trainer' });
  list = upsertSavedDevice(list, { id: 'hrm-1', name: 'Polar H10', lastConnectedAt: 2000, role: 'hr' });
  list = upsertSavedDevice(list, { id: 'kickr-2', name: 'Wahoo KICKR V6', lastConnectedAt: 3000, role: 'trainer' });
  saveSavedDevices(list, mockStorage);

  const reloaded = loadSavedDevices(mockStorage);
  assert.equal(reloaded.length, 2, 'New trainer should replace prior trainer role');
  assert.equal(reloaded[0].id, 'kickr-2');
  assert.equal(reloaded[1].id, 'hrm-1');

  const afterRemove = removeSavedDevice(reloaded, 'hrm-1');
  assert.equal(afterRemove.length, 1);

  // 2) Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((n) => computeReconnectBackoffMs(n)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000]
  );

  // 3) Trainer reconnect recovery calls requestControl -> startResume -> setTargetPower in exact order
  const callOrder: string[] = [];
  const recovery = await runTrainerReconnectRecovery(
    {
      requestControl: async () => {
        callOrder.push('requestControl');
        return true;
      },
      startResume: async () => {
        callOrder.push('startResume');
      },
      setTargetPower: async (w) => {
        callOrder.push(`setTargetPower:${w}`);
      },
    },
    265,
    true
  );
  assert.deepEqual(callOrder, ['requestControl', 'startResume', 'setTargetPower:265']);
  assert.equal(recovery.controlGranted, true);
  assert.equal(recovery.started, true);
  assert.equal(recovery.targetResentWatts, 265);

  // 4) HR and Cadence devices surface explicit error messages rather than swallowing failures
  const hr = new WebBluetoothHeartRateDevice();
  await hr.connect();
  assert.ok(
    hr.getStatus().errorMessage && hr.getStatus().errorMessage!.includes('Web Bluetooth'),
    `Expected explicit HR error message, got: ${hr.getStatus().errorMessage}`
  );
  const cad = new WebBluetoothCadenceDevice();
  await cad.connect();
  assert.ok(
    cad.getStatus().errorMessage && cad.getStatus().errorMessage!.includes('Web Bluetooth'),
    `Expected explicit Cadence error message, got: ${cad.getStatus().errorMessage}`
  );
});

test('Step 3: BLE timeouts/retries, coalescing ERG queue, FTMS 0x80 Control Point responses, and Cycling Power fallback', async () => {
  // 1) Step-labelled timeout rejects cleanly
  await assert.rejects(
    withBluetoothTimeout(new Promise(() => undefined), 25, 'gatt.connect'),
    /\[BLE gatt\.connect\] Timed out after 25ms/
  );

  // 2) Retry succeeds on 3rd attempt
  let attempts = 0;
  const retriedVal = await withBluetoothRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient GATT busy');
      return 'ok';
    },
    { stepLabel: 'getCharacteristic', timeoutMs: 200, maxAttempts: 3, retryDelayMs: 5 }
  );
  assert.equal(retriedVal, 'ok');
  assert.equal(attempts, 3);

  // 3) CoalescingErgQueue keeps only the latest target power and recovers cleanly from a stuck write timeout
  const writtenWatts: number[] = [];
  const queue = new CoalescingErgQueue({ writeTimeoutMs: 40, maxRetries: 1, retryDelayMs: 5 });

  let firstAttemptStuck = true;
  const p1 = queue.enqueueTargetPower(150, () => {
    if (firstAttemptStuck) {
      firstAttemptStuck = false;
      return new Promise(() => undefined); // hangs forever -> triggers 40ms timeout!
    }
    writtenWatts.push(150);
    return Promise.resolve();
  }).catch(() => undefined);

  // While p1 is stuck, enqueue 3 rapid targets; only the latest (320W) should be written!
  const p2 = queue.enqueueTargetPower(200, async () => {
    writtenWatts.push(200);
  });
  const p3 = queue.enqueueTargetPower(260, async () => {
    writtenWatts.push(260);
  });
  const p4 = queue.enqueueTargetPower(320, async () => {
    writtenWatts.push(320);
  });
  await Promise.all([p1, p2, p3, p4]);
  assert.deepEqual(writtenWatts, [320]);
  assert.equal(queue.getDroppedTargetsCount(), 3);

  // 4) Parse FTMS 0x80 response codes (Success vs Control Not Permitted)
  const okView = new DataView(new Uint8Array([FTMS_OP_RESPONSE_CODE, FTMS_OP_REQUEST_CONTROL, FTMS_RESULT_SUCCESS]).buffer);
  const okResp = parseFtmsControlPointResponse(okView);
  assert.ok(okResp && okResp.success && !okResp.controlNotPermitted);

  const deniedView = new DataView(new Uint8Array([FTMS_OP_RESPONSE_CODE, FTMS_OP_REQUEST_CONTROL, FTMS_RESULT_CONTROL_NOT_PERMITTED]).buffer);
  const deniedResp = parseFtmsControlPointResponse(deniedView);
  assert.ok(deniedResp && !deniedResp.success && deniedResp.controlNotPermitted);
  assert.equal(deniedResp.errorMessage, CONTROL_NOT_PERMITTED_MESSAGE);

  // 5) WebBluetoothTrainerDevice sets ergControlActive ONLY when Request Control returns 0x01, and shows exact message on 0x05
  let cpListener: ((ev: Event) => void) | null = null;
  let nextControlResultCode = FTMS_RESULT_CONTROL_NOT_PERMITTED;

  const mockControlChar: BleCharacteristicLike = {
    addEventListener: (_ev, cb) => {
      cpListener = cb;
    },
    removeEventListener: () => {
      cpListener = null;
    },
    startNotifications: async () => mockControlChar,
    writeValueWithResponse: async (buf) => {
      const arr = new Uint8Array(buf instanceof ArrayBuffer ? buf : (buf as ArrayBufferView).buffer);
      const opCode = arr[0];
      const respBytes = new Uint8Array([FTMS_OP_RESPONSE_CODE, opCode, nextControlResultCode]);
      const dv = new DataView(respBytes.buffer);
      queueMicrotask(() => {
        cpListener?.({ target: { value: dv } } as unknown as Event);
      });
    },
  };

  const mockBikeDataChar: BleCharacteristicLike = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    startNotifications: async () => mockBikeDataChar,
  };

  const ftmsTrainerDevice: BleDeviceLike = {
    id: 'mock-kickr',
    name: 'Mock KICKR',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    gatt: {
      connected: true,
      connect: async () => ftmsTrainerDevice.gatt!,
      disconnect: () => undefined,
      getPrimaryService: async (uuid) => {
        if (uuid === 0x1826) {
          return {
            getCharacteristic: async (charUuid) =>
              charUuid === 0x2ad2 ? mockBikeDataChar : mockControlChar,
          };
        }
        throw new Error('Service not found');
      },
    },
  };

  const trainer = new WebBluetoothTrainerDevice({ writeTimeoutMs: 250, maxRetries: 1, retryDelayMs: 5 });
  await trainer.attachToDevice(ftmsTrainerDevice, false);
  assert.equal(trainer.getStatus().ergControlActive, false);

  // Control Not Permitted (0x05) -> ergControlActive stays false and exact user message is shown
  const denied = await trainer.requestControl();
  assert.equal(denied, false);
  assert.equal(trainer.getStatus().ergControlActive, false);
  assert.equal(trainer.getStatus().ergControlWarning, CONTROL_NOT_PERMITTED_MESSAGE);

  // Success (0x01) -> ergControlActive flips true and warning clears
  nextControlResultCode = FTMS_RESULT_SUCCESS;
  const granted = await trainer.requestControl();
  assert.equal(granted, true);
  assert.equal(trainer.getStatus().ergControlActive, true);
  assert.equal(trainer.getStatus().ergControlWarning, null);

  // 6) Cycling Power (0x1818) fallback when FTMS (0x1826) is missing
  const cpListenerHolder: { fn: ((ev: Event) => void) | null } = { fn: null };
  const mockCyclingPowerChar: BleCharacteristicLike = {
    addEventListener: (_ev, cb) => {
      cpListenerHolder.fn = cb;
    },
    removeEventListener: () => {
      cpListenerHolder.fn = null;
    },
    startNotifications: async () => mockCyclingPowerChar,
  };

  const cpOnlyDevice: BleDeviceLike = {
    id: 'mock-stages',
    name: 'Stages Power Meter',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    gatt: {
      connected: true,
      connect: async () => cpOnlyDevice.gatt!,
      disconnect: () => undefined,
      getPrimaryService: async (uuid) => {
        if (uuid === 0x1818) {
          return {
            getCharacteristic: async () => mockCyclingPowerChar,
          };
        }
        throw new Error('FTMS service missing');
      },
    },
  };

  const cpTrainer = new WebBluetoothTrainerDevice({ writeTimeoutMs: 250, maxRetries: 1, retryDelayMs: 5 });
  let receivedPower = 0;
  cpTrainer.onTelemetry((t) => {
    receivedPower = t.instantPower;
  });
  await cpTrainer.attachToDevice(cpOnlyDevice, false);
  assert.equal(cpTrainer.getPowerMode(), 'cycling-power');
  assert.equal(cpTrainer.getStatus().status, 'connected');
  assert.equal(cpTrainer.getStatus().ergControlActive, false);

  // Emit a 275W Cycling Power packet
  const cpPkt = new DataView(new ArrayBuffer(4));
  cpPkt.setUint16(0, 0x0000, true);
  cpPkt.setInt16(2, 275, true);
  cpListenerHolder.fn?.({ target: { value: cpPkt } } as unknown as Event);
  assert.equal(receivedPower, 275);
});

test('34. Step 4 – Zero-alloc telemetry ring buffer, wall-clock 1 Hz gap filling, unclamped WorkoutWallClock & O(1) incremental TSS', () => {
  // 1) LiveTelemetryBuffer ring writes, arrival timestamps & 3s rolling average
  const buf = new LiveTelemetryBuffer(3000);
  buf.pushTrainer(200, 88, 34.2, 10_000, 'ble-trainer', false);
  buf.pushHeartRate(142, 10_200);
  buf.pushTrainer(260, 90, 36.1, 11_000, 'ble-trainer', false);
  buf.pushCadence(94, 11_100);
  // Dedicated cadence sensor overrides trainer cadence when connected
  buf.pushTrainer(230, 82, 35.0, 12_000, 'ble-trainer', true);

  assert.equal(buf.instantPower, 230);
  assert.equal(buf.power3sAvg, 230); // avg(200, 260, 230) = 230
  assert.equal(buf.heartRate, 142);
  assert.equal(buf.cadence, 94);
  assert.equal(buf.cadenceSource, 'ble-cadence');
  assert.equal(buf.lastTrainerMs, 12_000);
  assert.equal(buf.lastHrMs, 10_200);
  assert.equal(buf.lastCadenceMs, 11_100);
  assert.equal(buf.getRingCount(), 5);

  const readout: TelemetryRingReadout = { power: 0, heartRate: 0, cadence: 0, speedKmh: 0, timestampMs: 0 };
  assert.equal(buf.readLatest(0, readout), true);
  assert.equal(readout.power, 230);
  assert.equal(readout.timestampMs, 12_000);
  assert.equal(buf.readLatest(4, readout), true);
  assert.equal(readout.power, 200);
  assert.equal(readout.timestampMs, 10_000);

  // 2) RideRecorder wall-clock 1 Hz gap filling across a 5.3 s main-thread stall
  const rec = new RideRecorder();
  const baseTs = 1_760_000_000_000;
  rec.beginSession('w-step4', 'Threshold Test', 250, baseTs, 0, 'Warmup');
  const s0 = rec.recordOnWallClock({
    timestampMs: baseTs,
    dtSec: 1,
    elapsedSec: 1,
    power: 210,
    heartRate: 138,
    cadence: 88,
    speedKmh: 33,
    gradePct: 3,
    stepIndex: 0,
    stepLabel: 'Warmup',
  });
  assert.equal(s0.length, 1);
  assert.equal(s0[0].filled, undefined);

  // Simulate a 5.3-second main-thread stall before the next tick arrives
  const stalledBatch = rec.recordOnWallClock({
    timestampMs: baseTs + 5300,
    dtSec: 5.3,
    elapsedSec: 6.3,
    power: 245,
    heartRate: 148,
    cadence: 92,
    speedKmh: 36,
    gradePct: 6,
    stepIndex: 1,
    stepLabel: 'Interval 1',
  });

  // 4 filled samples (+1s, +2s, +3s, +4s holding 210W) + 1 fresh live sample (+5.3s at 245W)
  assert.equal(stalledBatch.length, 5);
  for (let i = 0; i < 4; i++) {
    assert.equal(stalledBatch[i].filled, true);
    assert.equal(stalledBatch[i].power, 210);
    assert.equal(stalledBatch[i].heartRate, 138);
  }
  assert.equal(stalledBatch[4].filled, undefined);
  assert.equal(stalledBatch[4].power, 245);
  assert.equal(rec.getFilledSampleCount(), 4);
  assert.ok(rec.getMaxSampleGapMs() <= 1400, `Expected max gap <= 1400ms, got ${rec.getMaxSampleGapMs()}`);

  // Intentional 20-second pause must NOT backfill or inflate maxSampleGapMs
  rec.notifyPaused();
  rec.notifyResumed();
  const afterPause = rec.recordOnWallClock({
    timestampMs: baseTs + 25_300,
    dtSec: 1,
    elapsedSec: 7.3,
    power: 220,
    heartRate: 130,
    cadence: 86,
    speedKmh: 34,
    gradePct: 3,
    stepIndex: 1,
    stepLabel: 'Interval 1',
  });
  assert.equal(afterPause.length, 1);
  assert.equal(afterPause[0].filled, undefined);
  assert.ok(rec.getMaxSampleGapMs() <= 1400);

  // 3) WorkoutWallClock: no 2s clamp, pause accounting, and resumeGapSec reporting
  const clock = new WorkoutWallClock();
  clock.load(1800, 0);
  clock.start(100_000);
  let p = clock.poll(101_000);
  assert.equal(p.elapsedSec, 1);
  assert.equal(p.resumeGapSec, 0);

  // 12-second tab sleep / CPU freeze: advances full 12 s without clamping to 2 s
  p = clock.poll(113_000);
  assert.equal(p.elapsedSec, 13);
  assert.equal(p.dtSec, 12);
  assert.equal(p.resumeGapSec, 12);

  // Pause for 30 seconds -> elapsed must stay frozen at 13 s when resumed
  clock.pause(113_000);
  clock.start(143_000);
  p = clock.poll(145_000);
  assert.equal(p.elapsedSec, 15);
  assert.equal(clock.getAccumulatedPausedMs(), 30_000);

  // 4) IncrementalTssTracker matches batch calculateLiveTss exactly, and RideHistoryBuffer tracks averages
  const tssTracker = new IncrementalTssTracker();
  const histBuf = new RideHistoryBuffer();
  const samplePowers: number[] = [];

  for (let sec = 1; sec <= 90; sec++) {
    const w = sec <= 25 ? 160 : sec <= 60 ? 290 : 195;
    samplePowers.push(w);
    tssTracker.pushPower(w);
    histBuf.push(sec, w, 140 + (sec % 15), 250, 88);

    if (sec === 10 || sec === 29 || sec === 30 || sec === 60 || sec === 90) {
      assert.equal(
        tssTracker.getLiveTss(250),
        calculateLiveTss(samplePowers, 250),
        `Incremental TSS mismatch at sec=${sec}`
      );
    }
  }

  assert.equal(histBuf.length, 90);
  assert.equal(histBuf.peakPower, 290);
  assert.ok(histBuf.getAvgPower() > 200);
  assert.ok(histBuf.getAvgHeartRate() >= 140);
});

test('35. Step 5 – Hardware quality auto-detection, ordered GraphicsGovernor degradation, longtask triggers, mid-interval upgrade lock & Low 30 fps cap', () => {
  // 1) Auto-detection across phone, tablet, high-end desktop, and slow CPU benchmark
  const phone = detectRecommendedQuality({
    isTouchDevice: true,
    screenMinDim: 390,
    hardwareConcurrency: 4,
    deviceMemoryGb: 4,
    benchmarkMs: 12,
  });
  assert.equal(phone.quality, 'low');
  assert.equal(phone.isCompactPhone, true);

  const tablet = detectRecommendedQuality({
    isTouchDevice: true,
    screenMinDim: 820,
    hardwareConcurrency: 8,
    deviceMemoryGb: 8,
    benchmarkMs: 8,
  });
  assert.equal(tablet.quality, 'medium');
  assert.equal(tablet.isCompactPhone, false);

  const desktop = detectRecommendedQuality({
    isTouchDevice: false,
    screenMinDim: 1080,
    hardwareConcurrency: 12,
    deviceMemoryGb: 16,
    benchmarkMs: 3.5,
  });
  assert.equal(desktop.quality, 'high');

  const throttledDesktop = detectRecommendedQuality({
    isTouchDevice: false,
    screenMinDim: 1440,
    hardwareConcurrency: 8,
    deviceMemoryGb: 16,
    benchmarkMs: 32,
  });
  assert.equal(throttledDesktop.quality, 'low');

  // 2) Low quality enforces 30 fps cap, DPR 1.0, and post-FX off out of the box
  const lowCfg = getEffectiveRenderConfig('low', 0, false);
  assert.equal(lowCfg.fpsCap, 30);
  assert.equal(lowCfg.dprMax, 1);
  assert.equal(lowCfg.bloom, false);
  assert.equal(lowCfg.chromaticAberration, false);

  // 3) Ordered degradation ladder: DPR -> chromaticAberration -> bloom -> scenery -> fpsCap30
  assert.deepEqual([...DEGRADATION_ORDER], [
    'dpr',
    'chromaticAberration',
    'bloom',
    'scenery',
    'fpsCap30',
  ]);

  const gov = new GraphicsGovernor({
    degradeCooldownMs: 1000,
    upgradeHoldMs: 2000,
    longTaskWindowMs: 3000,
    longTaskTriggerCount: 2,
    frameBudget60Ms: 22,
  });
  gov.setBaseQuality('high');

  let now = 10_000;
  // Warm up EMA above 22 ms budget, then step through each degradation stage strictly in order
  for (let w = 0; w < 6; w++) {
    now += 40;
    gov.recordFrame(34, now, { isMidInterval: true });
  }
  const observedStages: number[] = [];
  for (let step = 1; step <= 5; step++) {
    if (step > 1) {
      now += 1050;
      gov.recordFrame(34, now, { isMidInterval: true });
    }
    observedStages.push(gov.getStage());
    const cfg = gov.getConfig(false);
    if (step === 1) {
      assert.equal(cfg.dprMax, 1.0);
      assert.equal(cfg.chromaticAberration, true);
      assert.equal(cfg.bloom, true);
      assert.equal(cfg.sceneryScale, 1.0);
      assert.equal(cfg.fpsCap, 60);
    } else if (step === 2) {
      assert.equal(cfg.chromaticAberration, false);
      assert.equal(cfg.bloom, true);
    } else if (step === 3) {
      assert.equal(cfg.bloom, false);
      assert.equal(cfg.sceneryScale, 1.0);
    } else if (step === 4) {
      assert.equal(cfg.sceneryScale, 0.5);
      assert.equal(cfg.fpsCap, 60);
    } else if (step === 5) {
      assert.equal(cfg.fpsCap, 30);
    }
  }
  assert.deepEqual(observedStages, [1, 2, 3, 4, 5]);

  // 4) Mid-interval upgrade lock: fast frames MUST NEVER raise quality while isMidInterval is true
  for (let f = 0; f < 80; f++) {
    now += 100;
    gov.recordFrame(8, now, { isMidInterval: true });
  }
  assert.equal(gov.getStage(), 5, 'Governor must never raise quality mid-interval');

  // 5) Once idle / Z1 recovery (isMidInterval: false), sustained fast frames step back up cleanly
  for (let f = 0; f < 40; f++) {
    now += 100;
    gov.recordFrame(8, now, { isMidInterval: false });
  }
  assert.ok(gov.getStage() < 5, `Expected governor to recover outside interval, got stage ${gov.getStage()}`);

  // 6) PerformanceObserver longtask trigger steps down even when EMA frame time looks normal
  const ltGov = new GraphicsGovernor({ degradeCooldownMs: 500, longTaskTriggerCount: 2 });
  ltGov.setBaseQuality('high');
  ltGov.recordLongTask(75, 50_000);
  ltGov.recordLongTask(82, 50_200);
  ltGov.recordFrame(15, 50_300, { isMidInterval: true });
  assert.equal(ltGov.getStage(), 1);
  assert.equal(ltGov.getDiagnostics().longTaskCount, 2);
});

test('36. Step 6 – GPU road shader profile uniform packing (zero alloc) and unified sky/sun/stars shader parameters', () => {
  // 1) Profile uniform array matches ROAD_SEGMENTS + 1 and reuses exact Vector4 instances in-place
  const profile = createRoadProfileUniformArray();
  assert.equal(profile.length, ROAD_PROFILE_COUNT);
  assert.equal(ROAD_PROFILE_COUNT, ROAD_SEGMENTS + 1);
  const firstRef = profile[0];
  const lastRef = profile[ROAD_PROFILE_COUNT - 1];

  const rt = createWorldRuntime();
  rt.distance = 245.5;
  rt.freeRideTerrain = createFreeRideTerrain(1337);
  rt.gpsRoute = compileGpsRoute('bike-line-art', 'Single-Line Bike', BIKE_LINE_ART_POINTS, 22000);
  updateRoadCurveLut(rt);

  packRoadProfileUniforms(rt, profile);

  // Confirm zero object replacement (in-place mutation)
  assert.equal(profile[0], firstRef);
  assert.equal(profile[ROAD_PROFILE_COUNT - 1], lastRef);

  // Every packed vec4 must match sampleRoadAtZ (x, y, slopeX, slopeY) bit-for-bit
  const expected = { x: 0, y: 0, slopeX: 0, slopeY: 0 };
  for (let i = 0; i < ROAD_PROFILE_COUNT; i++) {
    sampleRoadAtZ(
      rt.distance,
      ROAD_SEGMENT_Z[i],
      expected,
      rt.elevationProfile,
      rt.workoutElapsedSec,
      rt.freeRideTerrain
    );
    assert.ok(Math.abs(profile[i].x - expected.x) < 1e-6);
    assert.ok(Math.abs(profile[i].y - expected.y) < 1e-6);
    assert.ok(Math.abs(profile[i].z - expected.slopeX) < 1e-6);
    assert.ok(Math.abs(profile[i].w - expected.slopeY) < 1e-6);
  }

  // 2) Unified sky/sun/stars shader exposes distinct shader index and valid sun framing for all 4 themes
  const themes = ['neon-city', 'palm-grove', 'cloud-horizon', 'causeway-embankment'] as const;
  const seenIndices = new Set<number>();
  for (const theme of themes) {
    const p = getUnifiedSkyThemeParams(theme);
    seenIndices.add(p.shaderIndex);
    assert.ok(p.sunBaseElev > 0.05 && p.sunBaseElev < 0.3);
    assert.ok(p.sunAngularRadius > 0.1 && p.sunAngularRadius < 0.4);
    assert.ok(p.haloColorHex.startsWith('#') && p.haloColorHex.length === 7);
  }
  assert.equal(seenIndices.size, 4);
});

test('37. Step 7 & Final Acceptance – Strava upload auth guard + 60-minute throttled ride with forced reload recovery, <=1.5s max gap, <=250ms ERG latency & valid FIT', async () => {
  // 1) Strava upload endpoint guard: shared-secret mode
  const noSecretRes = verifyStravaUploadAccess({
    providedSecret: undefined,
    configuredSecret: 'neon-peloton-secret-42',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:3000',
    forwardedForHeader: undefined,
  });
  assert.equal(noSecretRes.allowed, false);
  assert.equal(noSecretRes.statusCode, 401);
  assert.equal(noSecretRes.requiresSecret, true);

  const wrongSecretRes = verifyStravaUploadAccess({
    providedSecret: 'wrong-secret',
    configuredSecret: 'neon-peloton-secret-42',
    remoteAddress: '203.0.113.10',
    hostHeader: 'trainer.example.com',
    forwardedForHeader: '203.0.113.10',
  });
  assert.equal(wrongSecretRes.allowed, false);
  assert.equal(wrongSecretRes.statusCode, 401);

  const validSecretRes = verifyStravaUploadAccess({
    providedSecret: 'neon-peloton-secret-42',
    configuredSecret: 'neon-peloton-secret-42',
    remoteAddress: '203.0.113.10',
    hostHeader: 'trainer.example.com',
    forwardedForHeader: '203.0.113.10',
  });
  assert.equal(validSecretRes.allowed, true);
  assert.equal(validSecretRes.statusCode, 200);

  // 2) Strava upload endpoint guard: localhost-only fallback when STRAVA_UPLOAD_SECRET is unset
  const localOk = verifyStravaUploadAccess({
    providedSecret: undefined,
    configuredSecret: '',
    remoteAddress: '::ffff:127.0.0.1',
    hostHeader: 'localhost:3000',
    forwardedForHeader: undefined,
  });
  assert.equal(localOk.allowed, true);
  assert.equal(localOk.statusCode, 200);

  const remoteBlocked = verifyStravaUploadAccess({
    providedSecret: undefined,
    configuredSecret: '',
    remoteAddress: '198.51.100.24',
    hostHeader: 'trainer.example.com',
    forwardedForHeader: undefined,
  });
  assert.equal(remoteBlocked.allowed, false);
  assert.equal(remoteBlocked.statusCode, 403);

  const proxiedBlocked = verifyStravaUploadAccess({
    providedSecret: undefined,
    configuredSecret: '',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:3000',
    forwardedForHeader: '203.0.113.99, 127.0.0.1',
  });
  assert.equal(proxiedBlocked.allowed, false);
  assert.equal(proxiedBlocked.statusCode, 403);

  // 3) Full 60-minute (3600 s) acceptance ride under 4x CPU throttle stalls & mid-ride tab reload
  const ftp = 260;
  const stepDurationSec = 300; // 12 x 5-min steps = 3600 s
  const stepTargets = [
    { label: 'Warmup Z2', pct: 0.65 },
    { label: 'Tempo Z3', pct: 0.82 },
    { label: 'Threshold Z4', pct: 0.98 },
    { label: 'Recovery Z1', pct: 0.5 },
    { label: 'VO2 Max Z5', pct: 1.12 },
    { label: 'Recovery Z1', pct: 0.5 },
    { label: 'Threshold Z4', pct: 1.0 },
    { label: 'Tempo Z3', pct: 0.84 },
    { label: 'VO2 Max Z5', pct: 1.15 },
    { label: 'Recovery Z1', pct: 0.52 },
    { label: 'Threshold Z4', pct: 0.96 },
    { label: 'Cooldown Z1', pct: 0.48 },
  ];

  const t0 = Date.UTC(2026, 10, 28, 8, 0, 0);
  const clock = new WorkoutWallClock();
  clock.load(3600, 0);
  clock.start(t0);

  const telemetry = new LiveTelemetryBuffer(3000);
  const ergQueue = new CoalescingErgQueue({ writeTimeoutMs: 250, maxRetries: 2, retryDelayMs: 5 });
  const governor = new GraphicsGovernor({
    degradeCooldownMs: 1000,
    upgradeHoldMs: 5000,
    frameBudget60Ms: 22,
    longTaskTriggerCount: 2,
  });
  governor.setBaseQuality('high');

  let recorder = new RideRecorder();
  recorder.beginSession('accept-60m', '60m Acceptance Block', ftp, t0, 0, stepTargets[0].label, {
    activityName: '60m Acceptance Block - Neon City',
    sceneryName: 'Neon City',
    sessionId: 'sess-accept-60m',
  });

  type DeltaPayload = NonNullable<ReturnType<RideRecorder['extractCheckpointDelta']>>;
  const chunks: NonNullable<DeltaPayload['chunk']>[] = [];
  let latestMeta: DeltaPayload['meta'] | null = null;
  let lastStepIndex = -1;
  let maxErgLatencyMs = 0;
  let ergWritesCount = 0;
  let reloadedOnce = false;

  // Simulate wall-clock ticks across 3600 s, injecting 4 s main-thread stalls every 120 s
  let elapsedSimSec = 0;
  while (elapsedSimSec < 3600) {
    const isStall = elapsedSimSec > 0 && elapsedSimSec % 120 === 0;
    const tickJumpSec = isStall ? 4 : 1;
    elapsedSimSec = Math.min(3600, elapsedSimSec + tickJumpSec);
    const nowMs = t0 + elapsedSimSec * 1000;

    const polled = clock.poll(nowMs);
    const stepIndex = Math.min(stepTargets.length - 1, Math.floor((polled.elapsedSec - 1) / stepDurationSec));
    const step = stepTargets[Math.max(0, stepIndex)];
    const targetWatts = Math.round(ftp * step.pct);

    // Feed BLE telemetry into zero-alloc ring buffer
    telemetry.pushTrainer(targetWatts, 90, powerToSpeedKmh(targetWatts), nowMs, 'ble-trainer', false);
    telemetry.pushHeartRate(130 + Math.round(step.pct * 35), nowMs);

    // Trigger ERG write on every step transition and verify <= 250 ms latency
    if (stepIndex !== lastStepIndex) {
      lastStepIndex = stepIndex;
      const writeStart = performance.now();
      await ergQueue.enqueueTargetPower(targetWatts, async () => {
        // Fast async BLE write acknowledgement (~1 ms)
        await Promise.resolve();
      });
      const writeLatencyMs = performance.now() - writeStart;
      if (writeLatencyMs > maxErgLatencyMs) maxErgLatencyMs = writeLatencyMs;
      ergWritesCount += 1;
    }

    // Feed 4x CPU throttle pressure to the GraphicsGovernor
    if (isStall) {
      governor.recordLongTask(85, nowMs);
      governor.recordLongTask(92, nowMs + 50);
    }
    governor.recordFrame(isStall ? 68 : 36, nowMs, { isMidInterval: step.pct >= 0.8 });

    // Sample recorder on wall-clock seconds (automatically backfills 4 s stalls at 1 Hz)
    recorder.recordOnWallClock({
      timestampMs: nowMs,
      dtSec: polled.dtSec,
      elapsedSec: polled.elapsedSec,
      power: telemetry.instantPower,
      heartRate: telemetry.heartRate,
      cadence: telemetry.cadence,
      speedKmh: telemetry.speedKmh,
      gradePct: step.pct >= 1.0 ? 7 : 2,
      stepIndex,
      stepLabel: step.label,
    });

    // Periodic append-only IndexedDB checkpoint every ~7 s
    if (recorder.shouldCheckpoint(nowMs, CHECKPOINT_INTERVAL_MS)) {
      const delta = recorder.extractCheckpointDelta({
        rideMode: 'workout',
        sceneryTheme: 'neon-city',
        visitedSceneries: ['neon-city'],
        elapsedSec: polled.elapsedSec,
        freeRideZone: 2,
        freeRideOffsetWatts: 0,
        nowMs,
      });
      if (delta?.chunk) {
        chunks.push(delta.chunk);
        latestMeta = delta.meta;
      }
    }

    // Simulate forced browser tab reload at the 30-minute mark (t = 1805 s)
    if (!reloadedOnce && elapsedSimSec >= 1805) {
      reloadedOnce = true;
      assert.ok(
        recorder.getMaxSampleGapMs() <= 1500,
        `Expected pre-reload max sample gap <= 1500 ms, got ${recorder.getMaxSampleGapMs()} ms`
      );
      // Flush final pre-crash delta just before forced reload (simulating pagehide/checkpoint)
      const preReloadDelta = recorder.extractCheckpointDelta({
        rideMode: 'workout',
        sceneryTheme: 'neon-city',
        visitedSceneries: ['neon-city'],
        elapsedSec: polled.elapsedSec,
        freeRideZone: 2,
        freeRideOffsetWatts: 0,
        nowMs,
      });
      if (preReloadDelta?.chunk) {
        chunks.push(preReloadDelta.chunk);
        latestMeta = preReloadDelta.meta;
      }

      assert.ok(latestMeta, 'Expected checkpoint metadata before forced reload');
      const recovered = assembleRecoveryFromChunks(latestMeta, chunks);
      const freshRecorder = new RideRecorder();
      freshRecorder.restoreFromRecovery(recovered, null);
      recorder = freshRecorder;
    }
  }

  assert.ok(
    recorder.getMaxSampleGapMs() <= 1500,
    `Expected post-reload max sample gap <= 1500 ms, got ${recorder.getMaxSampleGapMs()} ms`
  );

  const finalRide = recorder.finalize(t0 + 3600 * 1000);
  assert.ok(finalRide, 'Final 60-minute ride should finalize cleanly');
  assert.ok(finalRide.records.length >= 3590, `Expected ~3600 1 Hz records, got ${finalRide.records.length}`);
  assert.equal(finalRide.laps.length, 12, 'All 12 workout steps should be preserved as laps across reload');

  // Verify no recorded gap > 1.5 s across the entire 60-minute ride
  let maxRecordedGapMs = 0;
  for (let i = 1; i < finalRide.records.length; i++) {
    const gap = finalRide.records[i].timestampMs - finalRide.records[i - 1].timestampMs;
    if (gap > maxRecordedGapMs) maxRecordedGapMs = gap;
  }
  assert.ok(
    maxRecordedGapMs <= 1500,
    `Expected max recorded gap <= 1500 ms across 60-min ride, got ${maxRecordedGapMs} ms`
  );

  // Verify every step change wrote ERG within 250 ms
  assert.equal(ergWritesCount, 12);
  assert.ok(maxErgLatencyMs <= 250, `Expected ERG write latency <= 250 ms, got ${maxErgLatencyMs.toFixed(2)} ms`);

  // Verify GraphicsGovernor lowered quality under 4x CPU throttle without affecting ride integrity
  assert.ok(
    governor.getStage() >= 3,
    `Expected GraphicsGovernor to degrade >= stage 3 under 4x throttle, got stage ${governor.getStage()}`
  );

  // Verify valid Garmin .FIT binary export after reload recovery
  const fitBytes = encodeRideToFit(finalRide);
  const fitVerification = verifyFitBinary(fitBytes);
  assert.equal(fitVerification.validHeaderSignature, true);
  assert.equal(fitVerification.headerCrcValid, true);
  assert.equal(fitVerification.fileCrcValid, true);
  assert.equal(fitVerification.messageCountsByGlobalNum[19], 12);
  assert.equal(fitVerification.messageCountsByGlobalNum[20], finalRide.records.length);
});













