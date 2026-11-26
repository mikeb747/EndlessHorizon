import { ParsedWorkout, parseZwoWorkout } from './zwoParser';

/**
 * Built-in Stage 1 example workout matching Section 4 & Section 6 of the specification:
 * "HIIT30/15 for Time Trial Power Profile" by octaperformance.
 * Includes Warmup (~170W @ 250W FTP), 2 min Threshold primer (230W @ 250W FTP),
 * and three 13x { 30s @ 315W (126% FTP), 15s @ 124W (49.6% FTP) } VO2/Anaerobic blocks.
 */
export const BUILT_IN_HIIT_ZWO = `<workout_file>
  <author>octaperformance</author>
  <name>HIIT30/15 for Time Trial Power Profile</name>
  <description>High-intensity intermittent 30/15 intervals designed to elevate VO2max, repeat anaerobic capacity, and sustainable Time Trial power. Opens with a progressive 10-minute warmup and a 2-minute threshold primer before launching into three 13-rep blocks of 30s at 126% FTP paired with 15s active recovery spins.</description>
  <sportType>bike</sportType>
  <tags>
    <tag name="HIIT" />
    <tag name="Time Trial" />
    <tag name="VO2max" />
    <tag name="Anaerobic" />
  </tags>
  <workout>
    <Warmup Duration="600" PowerLow="0.54" PowerHigh="0.82" Cadence="88" label="Warmup" />
    <SteadyState Duration="120" Power="0.92" Cadence="92" label="Threshold Primer" />
    <SteadyState Duration="180" Power="0.52" Cadence="85" label="Pre-Set Recovery" />
    <IntervalsT Repeat="13" OnDuration="30" OffDuration="15" OnPower="1.26" OffPower="0.496" Cadence="98" CadenceResting="82" label="HIIT Block 1" />
    <SteadyState Duration="180" Power="0.50" Cadence="84" label="Set Recovery 1" />
    <IntervalsT Repeat="13" OnDuration="30" OffDuration="15" OnPower="1.26" OffPower="0.496" Cadence="98" CadenceResting="82" label="HIIT Block 2" />
    <SteadyState Duration="180" Power="0.50" Cadence="84" label="Set Recovery 2" />
    <IntervalsT Repeat="13" OnDuration="30" OffDuration="15" OnPower="1.26" OffPower="0.496" Cadence="98" CadenceResting="82" label="HIIT Block 3" />
    <Cooldown Duration="300" PowerLow="0.65" PowerHigh="0.40" Cadence="82" label="Cooldown" />
  </workout>
</workout_file>`;

export const BUILT_IN_PROGRESSIONS_ZWO = `<workout_file>
	<author>Paul Breen (via TrainingPeaks)</author>
	<name>Progressions</name>
	<description>Warm up
2mins @120w
2mins @ 150
2mins @ 185
x2

Main
Set 1:
2mins @ 200w
2mins @ 230W
2mins @ 255W
2mins @ 275W

5mins L1 recovery

Set 2:
2mins @ 210w
2mins @ 240W
2mins @ 265W
2mins @ 285w
2mins @ 285w

5mins L1 recovery

10mins SS 245-259w

Cool down
10mins L1</description>
	<sportType>bike</sportType>
	<tags>
		<tag name="Progression" />
		<tag name="Threshold" />
		<tag name="Sweet Spot" />
	</tags>
	<workout>
		<Warmup Duration="120" PowerHigh="0.54" PowerLow="0.34">
		</Warmup>
		<SteadyState Duration="120" Power="0.54">
		</SteadyState>
		<SteadyState Duration="120" Power="0.66">
		</SteadyState>
		<SteadyState Duration="120" Power="0.44">
		</SteadyState>
		<SteadyState Duration="120" Power="0.54">
		</SteadyState>
		<SteadyState Duration="120" Power="0.66">
		</SteadyState>
		<SteadyState Duration="120" Power="0.72">
		</SteadyState>
		<SteadyState Duration="120" Power="0.82">
		</SteadyState>
		<SteadyState Duration="120" Power="0.92">
		</SteadyState>
		<SteadyState Duration="120" Power="0.99">
		</SteadyState>
		<SteadyState Duration="300" Power="0.55">
		</SteadyState>
		<SteadyState Duration="120" Power="0.75">
		</SteadyState>
		<SteadyState Duration="120" Power="0.85">
		</SteadyState>
		<SteadyState Duration="120" Power="0.95">
		</SteadyState>
		<SteadyState Duration="120" Power="1.05">
		</SteadyState>
		<SteadyState Duration="120" Power="1.15">
		</SteadyState>
		<SteadyState Duration="300" Power="0.55">
		</SteadyState>
		<SteadyState Duration="600" Power="0.9">
		</SteadyState>
		<Cooldown Duration="600" PowerHigh="0.4" PowerLow="0.6">
		</Cooldown>
	</workout>
</workout_file>`;

export const BUILT_IN_PYRAMIDS_ZWO = `<workout_file>
	<author>Paul Breen (via TrainingPeaks)</author>
	<name>pyramids</name>
	<description>Two aerobic-to-sweet-spot power pyramids separated by 5x30s anaerobic surges at 130% FTP and capped with a 5-minute threshold finisher.</description>
	<sportType>bike</sportType>
	<tags>
		<tag name="Pyramids" />
		<tag name="Threshold" />
		<tag name="VO2max" />
	</tags>
	<workout>
		<Warmup Duration="300" PowerHigh="0.6" PowerLow="0.4">
		</Warmup>
		<IntervalsT Repeat="4" OnDuration="30" OnPower="0.9" OffDuration="30" OffPower="0.55">
		</IntervalsT>
		<SteadyState Duration="180" Power="0.65">
		</SteadyState>
		<SteadyState Duration="180" Power="0.8">
		</SteadyState>
		<SteadyState Duration="300" Power="0.9">
		</SteadyState>
		<SteadyState Duration="180" Power="0.8">
		</SteadyState>
		<SteadyState Duration="180" Power="0.65">
		</SteadyState>
		<IntervalsT Repeat="5" OnDuration="30" OnPower="1.3" OffDuration="30" OffPower="0.55">
		</IntervalsT>
		<SteadyState Duration="180" Power="0.65">
		</SteadyState>
		<SteadyState Duration="180" Power="0.8">
		</SteadyState>
		<SteadyState Duration="300" Power="0.95">
		</SteadyState>
		<SteadyState Duration="180" Power="0.8">
		</SteadyState>
		<SteadyState Duration="180" Power="0.65">
		</SteadyState>
		<SteadyState Duration="300" Power="1">
		</SteadyState>
		<Cooldown Duration="420" PowerHigh="0.45" PowerLow="0.65">
		</Cooldown>
	</workout>
</workout_file>`;

export const BUILT_IN_SS_WITH_EFFORTS_ZWO = `<workout_file>
	<author>Paul Breen (via TrainingPeaks)</author>
	<name>SS with efforts</name>
	<description>Three 10-minute Sweet Spot blocks (8 min at 90% FTP) bookended by 1-minute VO2max efforts at 110% FTP after a progressive warmup and activation surges.</description>
	<sportType>bike</sportType>
	<tags>
		<tag name="Sweet Spot" />
		<tag name="VO2max" />
		<tag name="Endurance" />
	</tags>
	<workout>
		<Warmup Duration="180" PowerHigh="0.6" PowerLow="0.4">
		</Warmup>
		<SteadyState Duration="60" Power="0.6">
		</SteadyState>
		<SteadyState Duration="60" Power="0.67">
		</SteadyState>
		<SteadyState Duration="60" Power="0.73">
		</SteadyState>
		<SteadyState Duration="60" Power="0.8">
		</SteadyState>
		<IntervalsT Repeat="3" OnDuration="30" OnPower="1" OffDuration="60" OffPower="0.55">
		</IntervalsT>
		<SteadyState Duration="150" Power="0.7">
		</SteadyState>
		<SteadyState Duration="60" Power="1.1">
		</SteadyState>
		<SteadyState Duration="480" Power="0.9">
		</SteadyState>
		<SteadyState Duration="60" Power="1.1">
		</SteadyState>
		<SteadyState Duration="240" Power="0.45">
		</SteadyState>
		<SteadyState Duration="60" Power="1.1">
		</SteadyState>
		<SteadyState Duration="480" Power="0.9">
		</SteadyState>
		<SteadyState Duration="60" Power="1.1">
		</SteadyState>
		<SteadyState Duration="240" Power="0.45">
		</SteadyState>
		<SteadyState Duration="60" Power="1.1">
		</SteadyState>
		<SteadyState Duration="480" Power="0.9">
		</SteadyState>
		<SteadyState Duration="60" Power="1.1">
		</SteadyState>
		<SteadyState Duration="120" Power="0.5">
		</SteadyState>
		<SteadyState Duration="120" Power="0.47">
		</SteadyState>
		<SteadyState Duration="120" Power="0.44">
		</SteadyState>
		<SteadyState Duration="120" Power="0.4">
		</SteadyState>
	</workout>
</workout_file>`;

export const BUILT_IN_WORKOUTS: ParsedWorkout[] = [
  parseZwoWorkout(BUILT_IN_HIIT_ZWO, 'builtin-hiit-30-15'),
  parseZwoWorkout(BUILT_IN_PROGRESSIONS_ZWO, 'builtin-progressions'),
  parseZwoWorkout(BUILT_IN_PYRAMIDS_ZWO, 'builtin-pyramids'),
  parseZwoWorkout(BUILT_IN_SS_WITH_EFFORTS_ZWO, 'builtin-ss-with-efforts'),
];

/**
 * Synthetic 24-hour Free Ride workout fed into WorkoutEngine so the Web Worker
 * keeps ticking at 1 Hz and emitting ERG keep-alive heartbeats in Free Ride mode.
 */
export const FREE_RIDE_SESSION_WORKOUT: ParsedWorkout = parseZwoWorkout(
  `<workout_file>
  <author>NeonVelo</author>
  <name>Free Ride</name>
  <description>Undulating open road with on-the-fly Coggan power zone targeting and ±5 W ERG adjustments.</description>
  <sportType>bike</sportType>
  <tags><tag name="Free Ride" /></tags>
  <workout>
    <FreeRide Duration="86400" Power="0.65" label="Free Ride" />
  </workout>
</workout_file>`,
  'freeride-session'
);
