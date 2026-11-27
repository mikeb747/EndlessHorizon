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
import { clampFtp, WorkoutEngine, WorkerLike } from '../logic/WorkoutEngine';
import {
  buildWorkoutElevationProfile,
  CAUSEWAY_EMBANKMENT_DROP_M,
  CAUSEWAY_EMBANKMENT_TOE_X,
  CLOUD_HORIZON_BUSH_SPACING_M,
  CLOUD_HORIZON_SPRITE_COUNT,
  computeBuildingCenterOffset,
  computeForwardScrollOffset,
  computeLinearRoadT,
  computeRoadSegmentZ,
  computeSpeedStreakParams,
  getZoneGradient,
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
  WORLD_CAMERA_NEAR,
} from '../world/roadMath';
import type {
  WorkoutEngineWorkerCommand,
  WorkoutEngineWorkerEvent,
} from '../workers/workoutEngine.worker';
import { RideRecorder } from '../recording/rideRecorder';
import { buildFitFileName, encodeRideToFit, verifyFitBinary } from '../recording/fitEncoder';
import { FIT_SPORT_CYCLING, FIT_SUB_SPORT_VIRTUAL_ACTIVITY } from '../recording/types';
import { URASHIMA_CENTER_LAT, URASHIMA_CENTER_LON, VIRTUAL_START_ALTITUDE_M } from '../recording/virtualGps';
import {
  createCrankRevState,
  parseCscMeasurement,
  parseCyclingPowerMeasurement,
  parseFtmsIndoorBikeData,
  parseHeartRateMeasurement,
} from '../devices/bleParsers';
import {
  createCadenceMatcherState,
  solveTwoBoneLegIK,
  stepCadenceMatcher,
} from '../world/cadenceMatcher';
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

test('zone gradients and workout elevation profile map Z1..Z5+ to 0%, 2%, 4%, 8%, 20%', () => {
  assert.equal(getZoneGradient(1), 0.0);
  assert.equal(getZoneGradient(2), 0.02);
  assert.equal(getZoneGradient(3), 0.04);
  assert.equal(getZoneGradient(4), 0.08);
  assert.equal(getZoneGradient(5), 0.2);
  assert.equal(getZoneGradient(6), 0.2);
  assert.equal(getZoneGradient(7), 0.2);

  const workout = parseZwoWorkout(BUILT_IN_HIIT_ZWO, 'test-elev');
  const profile = buildWorkoutElevationProfile(workout);

  // Start of Warmup (t=5s, Z1 Active Recovery) -> completely flat (0%)
  assert.equal(sampleGradeAtTime(profile, 5), 0);
  // Mid Warmup (t=300s, 68% FTP = Z2 Endurance) -> 2%
  assert.ok(Math.abs(sampleGradeAtTime(profile, 300) - 0.02) < 1e-5);
  // Threshold Primer (t=660s, 92% FTP = Z4 Threshold) -> 8%
  assert.ok(Math.abs(sampleGradeAtTime(profile, 660) - 0.08) < 1e-5);
  // HIIT Block 1 Work (t=915s, 126% FTP = Z6 Anaerobic) -> 20%
  assert.ok(Math.abs(sampleGradeAtTime(profile, 915) - 0.2) < 1e-5);

  // Verify 50m ahead during steady 20% climb rises ~10m vertically
  const flatSample = sampleRoadAtZ(0, -50, { x: 0, y: 0, slopeX: 0, slopeY: 0 }, profile, 5);
  assert.ok(Math.abs(flatSample.y) < 0.01, `Expected flat road at Z1, got y=${flatSample.y}`);

  const climbSample = sampleRoadAtZ(0, -50, { x: 0, y: 0, slopeX: 0, slopeY: 0 }, profile, 910);
  assert.ok(
    climbSample.y > 9.5 && climbSample.y < 10.5,
    `Expected ~10m vertical rise over 50m on 20% Z6 climb, got y=${climbSample.y}`
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
  assert.ok(fileName.startsWith('NeonVelo_HIIT30-15-Test_'));
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






