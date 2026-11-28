/**
 * Pure TypeScript Garmin FIT 2.0 binary file encoder for Strava-compatible
 * virtual cycling activities.
 *
 * Implements:
 * - 14-byte FIT 2.0 header with ".FIT" signature & header CRC-16
 * - Standard Garmin FIT CRC-16 nibble lookup checksum
 * - Messages: file_id, file_creator, device_info, event (timer start/stop),
 *   record (1 Hz HR, power, cadence, speed, distance, virtual altitude, grade,
 *   Ura-shima GPS lat/lon in semicircles), lap (workout step changes),
 *   session (sport=2 cycling, sub_sport=58 virtual_activity), and activity.
 */

import {
  FIT_SPORT_CYCLING,
  FIT_SUB_SPORT_VIRTUAL_ACTIVITY,
  RecordedLap,
  RecordedSample,
  SavedRide,
} from './types';

/** FIT epoch: 1989-12-31T00:00:00Z in Unix seconds */
export const FIT_EPOCH_UNIX_SEC = 631065600;

const SEMICIRCLES_PER_DEGREE = 2147483648 / 180; // 2^31 / 180

// Standard FIT base type IDs (little-endian architecture = 0)
const BASE_ENUM = 0x00;
const BASE_UINT8 = 0x02;
const BASE_STRING = 0x07;
const BASE_SINT16 = 0x83;
const BASE_UINT16 = 0x84;
const BASE_SINT32 = 0x85;
const BASE_UINT32 = 0x86;
const BASE_UINT32Z = 0x8c;

const PRODUCT_NAME_BYTES = 32;
const ACTIVITY_NAME_BYTES = 64;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Invalid sentinels
const INVALID_UINT8 = 0xff;
const INVALID_UINT16 = 0xffff;
const INVALID_SINT16 = 0x7fff;
const INVALID_UINT32 = 0xffffffff;
const INVALID_SINT32 = 0x7fffffff;

// Standard Garmin FIT CRC-16 lookup table
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function computeFitCrc(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = bytes[i];
    // Lower nibble
    let tmp = CRC_TABLE[crc & 0x0f];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0x0f];
    // Upper nibble
    tmp = CRC_TABLE[crc & 0x0f];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0x0f];
  }
  return crc & 0xffff;
}

export function toFitTimestamp(unixMs: number): number {
  const sec = Math.floor(unixMs / 1000) - FIT_EPOCH_UNIX_SEC;
  return Math.max(0, sec);
}

export function degreesToSemicircles(deg: number): number {
  if (!Number.isFinite(deg)) return INVALID_SINT32;
  return Math.round(deg * SEMICIRCLES_PER_DEGREE);
}

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

class BinaryWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(initialCapacity = 16384) {
    this.buffer = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buffer.buffer);
  }

  private ensureCapacity(extra: number): void {
    const needed = this.offset + extra;
    if (needed <= this.buffer.length) return;
    let nextCap = this.buffer.length * 2;
    while (nextCap < needed) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buffer);
    this.buffer = next;
    this.view = new DataView(this.buffer.buffer);
  }

  writeUint8(val: number): void {
    this.ensureCapacity(1);
    this.view.setUint8(this.offset, val & 0xff);
    this.offset += 1;
  }

  writeUint16(val: number): void {
    this.ensureCapacity(2);
    this.view.setUint16(this.offset, val & 0xffff, true);
    this.offset += 2;
  }

  writeSint16(val: number): void {
    this.ensureCapacity(2);
    this.view.setInt16(this.offset, Math.max(-32768, Math.min(32767, val)), true);
    this.offset += 2;
  }

  writeUint32(val: number): void {
    this.ensureCapacity(4);
    this.view.setUint32(this.offset, val >>> 0, true);
    this.offset += 4;
  }

  writeSint32(val: number): void {
    this.ensureCapacity(4);
    this.view.setInt32(this.offset, val | 0, true);
    this.offset += 4;
  }

  /**
   * Write a fixed-size UTF-8 null-terminated FIT string field (zero-padded to byteSize).
   */
  writeFixedString(value: string, byteSize: number): void {
    this.ensureCapacity(byteSize);
    const encoded = textEncoder.encode(value);
    const copyLen = Math.min(encoded.length, Math.max(0, byteSize - 1));
    this.buffer.fill(0, this.offset, this.offset + byteSize);
    this.buffer.set(encoded.subarray(0, copyLen), this.offset);
    this.offset += byteSize;
  }

  writeDefinition(localMesgNum: number, globalMesgNum: number, fields: FieldDef[]): void {
    // Definition message header: bit 6 set (0x40) + local message number (0..15)
    this.writeUint8(0x40 | (localMesgNum & 0x0f));
    this.writeUint8(0); // reserved
    this.writeUint8(0); // architecture: 0 = little-endian
    this.writeUint16(globalMesgNum);
    this.writeUint8(fields.length);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      this.writeUint8(f.num);
      this.writeUint8(f.size);
      this.writeUint8(f.baseType);
    }
  }

  writeDataHeader(localMesgNum: number): void {
    this.writeUint8(localMesgNum & 0x0f);
  }

  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }
}

function encodeAltitude16(altitudeM: number): number {
  if (!Number.isFinite(altitudeM)) return INVALID_UINT16;
  const scaled = Math.round((altitudeM + 500) * 5);
  return Math.max(0, Math.min(65534, scaled));
}

function encodeAltitude32(altitudeM: number): number {
  if (!Number.isFinite(altitudeM)) return INVALID_UINT32;
  const scaled = Math.round((altitudeM + 500) * 5);
  return Math.max(0, scaled);
}

function encodeSpeed16(speedMps: number): number {
  if (!Number.isFinite(speedMps) || speedMps < 0) return INVALID_UINT16;
  return Math.min(65534, Math.round(speedMps * 1000));
}

function encodeSpeed32(speedMps: number): number {
  if (!Number.isFinite(speedMps) || speedMps < 0) return INVALID_UINT32;
  return Math.round(speedMps * 1000);
}

function encodeHr(hr: number): number {
  if (!Number.isFinite(hr) || hr <= 0) return INVALID_UINT8;
  return Math.min(254, Math.round(hr));
}

function encodeCadence(cad: number): number {
  if (!Number.isFinite(cad) || cad < 0) return INVALID_UINT8;
  return Math.min(254, Math.round(cad));
}

function encodePower(watts: number): number {
  if (!Number.isFinite(watts) || watts < 0) return INVALID_UINT16;
  return Math.min(65534, Math.round(watts));
}

function encodeGrade(gradePct: number): number {
  if (!Number.isFinite(gradePct)) return INVALID_SINT16;
  return Math.max(-32767, Math.min(32766, Math.round(gradePct * 100)));
}

const FILE_ID_FIELDS: FieldDef[] = [
  { num: 0, size: 1, baseType: BASE_ENUM }, // type = 4 (activity)
  { num: 1, size: 2, baseType: BASE_UINT16 }, // manufacturer = 255 (development)
  { num: 2, size: 2, baseType: BASE_UINT16 }, // product
  { num: 3, size: 4, baseType: BASE_UINT32Z }, // serial_number
  { num: 4, size: 4, baseType: BASE_UINT32 }, // time_created
  { num: 8, size: PRODUCT_NAME_BYTES, baseType: BASE_STRING }, // product_name
];

const FILE_CREATOR_FIELDS: FieldDef[] = [
  { num: 0, size: 2, baseType: BASE_UINT16 }, // software_version
  { num: 1, size: 1, baseType: BASE_UINT8 }, // hardware_version
];

// Global 12 (sport): carries the Activity / Sport Profile Name read by Strava & Garmin Connect
const SPORT_FIELDS: FieldDef[] = [
  { num: 0, size: 1, baseType: BASE_ENUM }, // sport = 2 (cycling)
  { num: 1, size: 1, baseType: BASE_ENUM }, // sub_sport = 58 (virtual_activity)
  { num: 3, size: ACTIVITY_NAME_BYTES, baseType: BASE_STRING }, // name (Activity Name)
];

// Global 26 (workout): carries wkt_name for Strava & training platforms
const WORKOUT_FIELDS: FieldDef[] = [
  { num: 4, size: 1, baseType: BASE_ENUM }, // sport = 2 (cycling)
  { num: 6, size: 2, baseType: BASE_UINT16 }, // num_valid_steps
  { num: 8, size: ACTIVITY_NAME_BYTES, baseType: BASE_STRING }, // wkt_name (Activity Name)
  { num: 11, size: 1, baseType: BASE_ENUM }, // sub_sport = 58 (virtual_activity)
];

const DEVICE_INFO_FIELDS: FieldDef[] = [
  { num: 253, size: 4, baseType: BASE_UINT32 }, // timestamp
  { num: 0, size: 1, baseType: BASE_UINT8 }, // device_index (0 = creator)
  { num: 2, size: 2, baseType: BASE_UINT16 }, // manufacturer
  { num: 4, size: 2, baseType: BASE_UINT16 }, // product
  { num: 5, size: 2, baseType: BASE_UINT16 }, // software_version
];

const EVENT_FIELDS: FieldDef[] = [
  { num: 253, size: 4, baseType: BASE_UINT32 }, // timestamp
  { num: 0, size: 1, baseType: BASE_ENUM }, // event (0 = timer)
  { num: 1, size: 1, baseType: BASE_ENUM }, // event_type (0 = start, 4 = stop_all)
  { num: 4, size: 1, baseType: BASE_UINT8 }, // event_group
];

const RECORD_FIELDS: FieldDef[] = [
  { num: 253, size: 4, baseType: BASE_UINT32 }, // timestamp
  { num: 0, size: 4, baseType: BASE_SINT32 }, // position_lat (semicircles)
  { num: 1, size: 4, baseType: BASE_SINT32 }, // position_long (semicircles)
  { num: 2, size: 2, baseType: BASE_UINT16 }, // altitude (scale 5, offset 500)
  { num: 3, size: 1, baseType: BASE_UINT8 }, // heart_rate (bpm)
  { num: 4, size: 1, baseType: BASE_UINT8 }, // cadence (rpm)
  { num: 5, size: 4, baseType: BASE_UINT32 }, // distance (scale 100 -> cm)
  { num: 6, size: 2, baseType: BASE_UINT16 }, // speed (scale 1000 -> mm/s)
  { num: 7, size: 2, baseType: BASE_UINT16 }, // power (watts)
  { num: 9, size: 2, baseType: BASE_SINT16 }, // grade (scale 100 -> %)
  { num: 73, size: 4, baseType: BASE_UINT32 }, // enhanced_speed (scale 1000)
  { num: 78, size: 4, baseType: BASE_UINT32 }, // enhanced_altitude (scale 5, offset 500)
];

const LAP_FIELDS: FieldDef[] = [
  { num: 254, size: 2, baseType: BASE_UINT16 }, // message_index
  { num: 253, size: 4, baseType: BASE_UINT32 }, // timestamp (lap end)
  { num: 2, size: 4, baseType: BASE_UINT32 }, // start_time
  { num: 7, size: 4, baseType: BASE_UINT32 }, // total_elapsed_time (ms)
  { num: 8, size: 4, baseType: BASE_UINT32 }, // total_timer_time (ms)
  { num: 9, size: 4, baseType: BASE_UINT32 }, // total_distance (cm)
  { num: 11, size: 2, baseType: BASE_UINT16 }, // total_calories
  { num: 13, size: 2, baseType: BASE_UINT16 }, // avg_speed
  { num: 14, size: 2, baseType: BASE_UINT16 }, // max_speed
  { num: 15, size: 1, baseType: BASE_UINT8 }, // avg_heart_rate
  { num: 16, size: 1, baseType: BASE_UINT8 }, // max_heart_rate
  { num: 17, size: 1, baseType: BASE_UINT8 }, // avg_cadence
  { num: 18, size: 1, baseType: BASE_UINT8 }, // max_cadence
  { num: 19, size: 2, baseType: BASE_UINT16 }, // avg_power
  { num: 20, size: 2, baseType: BASE_UINT16 }, // max_power
  { num: 21, size: 2, baseType: BASE_UINT16 }, // total_ascent (m)
  { num: 22, size: 2, baseType: BASE_UINT16 }, // total_descent (m)
  { num: 24, size: 1, baseType: BASE_ENUM }, // lap_trigger (7 = fitness_equipment)
  { num: 25, size: 1, baseType: BASE_ENUM }, // sport = 2 (cycling)
  { num: 39, size: 1, baseType: BASE_ENUM }, // sub_sport = 58 (virtual_activity)
];

const SESSION_FIELDS: FieldDef[] = [
  { num: 254, size: 2, baseType: BASE_UINT16 }, // message_index
  { num: 253, size: 4, baseType: BASE_UINT32 }, // timestamp
  { num: 2, size: 4, baseType: BASE_UINT32 }, // start_time
  { num: 5, size: 1, baseType: BASE_ENUM }, // sport = 2 (cycling)
  { num: 6, size: 1, baseType: BASE_ENUM }, // sub_sport = 58 (virtual_activity)
  { num: 7, size: 4, baseType: BASE_UINT32 }, // total_elapsed_time (ms)
  { num: 8, size: 4, baseType: BASE_UINT32 }, // total_timer_time (ms)
  { num: 9, size: 4, baseType: BASE_UINT32 }, // total_distance (cm)
  { num: 11, size: 2, baseType: BASE_UINT16 }, // total_calories
  { num: 14, size: 2, baseType: BASE_UINT16 }, // avg_speed
  { num: 15, size: 2, baseType: BASE_UINT16 }, // max_speed
  { num: 16, size: 1, baseType: BASE_UINT8 }, // avg_heart_rate
  { num: 17, size: 1, baseType: BASE_UINT8 }, // max_heart_rate
  { num: 18, size: 1, baseType: BASE_UINT8 }, // avg_cadence
  { num: 19, size: 1, baseType: BASE_UINT8 }, // max_cadence
  { num: 20, size: 2, baseType: BASE_UINT16 }, // avg_power
  { num: 21, size: 2, baseType: BASE_UINT16 }, // max_power
  { num: 22, size: 2, baseType: BASE_UINT16 }, // total_ascent (m)
  { num: 23, size: 2, baseType: BASE_UINT16 }, // total_descent (m)
  { num: 25, size: 2, baseType: BASE_UINT16 }, // first_lap_index
  { num: 26, size: 2, baseType: BASE_UINT16 }, // num_laps
  { num: 34, size: 2, baseType: BASE_UINT16 }, // normalized_power
  { num: 35, size: 2, baseType: BASE_UINT16 }, // training_stress_score (scale 10)
  { num: 36, size: 2, baseType: BASE_UINT16 }, // intensity_factor (scale 1000)
  { num: 48, size: 4, baseType: BASE_UINT32 }, // total_work (joules)
  { num: 110, size: 4, baseType: BASE_UINT32 }, // enhanced_avg_speed
  { num: 111, size: 4, baseType: BASE_UINT32 }, // enhanced_max_speed
];

const ACTIVITY_FIELDS: FieldDef[] = [
  { num: 253, size: 4, baseType: BASE_UINT32 }, // timestamp
  { num: 0, size: 4, baseType: BASE_UINT32 }, // total_timer_time (ms)
  { num: 1, size: 2, baseType: BASE_UINT16 }, // num_sessions
  { num: 2, size: 1, baseType: BASE_ENUM }, // type (0 = manual)
  { num: 3, size: 1, baseType: BASE_ENUM }, // event (26 = activity)
  { num: 4, size: 1, baseType: BASE_ENUM }, // event_type (1 = stop)
  { num: 5, size: 4, baseType: BASE_UINT32 }, // local_timestamp
];

function writeRecordMessage(writer: BinaryWriter, sample: RecordedSample): void {
  writer.writeDataHeader(4);
  writer.writeUint32(toFitTimestamp(sample.timestampMs));
  writer.writeSint32(degreesToSemicircles(sample.latDeg));
  writer.writeSint32(degreesToSemicircles(sample.lonDeg));
  writer.writeUint16(encodeAltitude16(sample.altitudeM));
  writer.writeUint8(encodeHr(sample.heartRate));
  writer.writeUint8(encodeCadence(sample.cadence));
  writer.writeUint32(Math.max(0, Math.round(sample.distanceM * 100)));
  writer.writeUint16(encodeSpeed16(sample.speedMps));
  writer.writeUint16(encodePower(sample.power));
  writer.writeSint16(encodeGrade(sample.gradePct));
  writer.writeUint32(encodeSpeed32(sample.speedMps));
  writer.writeUint32(encodeAltitude32(sample.altitudeM));
}

function writeLapMessage(writer: BinaryWriter, lap: RecordedLap): void {
  writer.writeDataHeader(5);
  writer.writeUint16(lap.lapIndex);
  writer.writeUint32(toFitTimestamp(lap.endTimeMs));
  writer.writeUint32(toFitTimestamp(lap.startTimeMs));
  writer.writeUint32(Math.max(0, Math.round(lap.totalElapsedSec * 1000)));
  writer.writeUint32(Math.max(0, Math.round(lap.totalTimerSec * 1000)));
  writer.writeUint32(Math.max(0, Math.round(lap.totalDistanceM * 100)));
  writer.writeUint16(Math.min(65534, Math.max(0, Math.round(lap.calories))));
  writer.writeUint16(encodeSpeed16(lap.avgSpeedMps));
  writer.writeUint16(encodeSpeed16(lap.maxSpeedMps));
  writer.writeUint8(encodeHr(lap.avgHeartRate));
  writer.writeUint8(encodeHr(lap.maxHeartRate));
  writer.writeUint8(encodeCadence(lap.avgCadence));
  writer.writeUint8(encodeCadence(lap.maxCadence));
  writer.writeUint16(encodePower(lap.avgPower));
  writer.writeUint16(encodePower(lap.maxPower));
  writer.writeUint16(Math.min(65534, Math.max(0, Math.round(lap.totalAscentM))));
  writer.writeUint16(Math.min(65534, Math.max(0, Math.round(lap.totalDescentM))));
  writer.writeUint8(7); // fitness_equipment trigger
  writer.writeUint8(FIT_SPORT_CYCLING);
  writer.writeUint8(FIT_SUB_SPORT_VIRTUAL_ACTIVITY);
}

/**
 * Encode a completed ride into a complete, Strava-ready Garmin FIT 2.0 binary file.
 */
export function encodeRideToFit(ride: SavedRide): Uint8Array {
  const startTs = toFitTimestamp(ride.startTimeMs);
  const endTs = Math.max(startTs, toFitTimestamp(ride.endTimeMs));
  const activityName = (ride.activityName || ride.workoutName || 'Endless Horizon Cycling').trim();
  const writer = new BinaryWriter(Math.max(8192, ride.records.length * 40 + 2560));

  // Local 0 -> file_id (global 0)
  writer.writeDefinition(0, 0, FILE_ID_FIELDS);
  writer.writeDataHeader(0);
  writer.writeUint8(4); // file_type = activity
  writer.writeUint16(255); // manufacturer = development
  writer.writeUint16(1); // product = Endless Horizon Cycling
  writer.writeUint32(19840001); // serial_number
  writer.writeUint32(startTs);
  writer.writeFixedString('Endless Horizon Cycling', PRODUCT_NAME_BYTES);

  // Local 1 -> file_creator (global 49)
  writer.writeDefinition(1, 49, FILE_CREATOR_FIELDS);
  writer.writeDataHeader(1);
  writer.writeUint16(100); // software_version 1.00
  writer.writeUint8(1); // hardware_version

  // Local 2 -> device_info (global 23)
  writer.writeDefinition(2, 23, DEVICE_INFO_FIELDS);
  writer.writeDataHeader(2);
  writer.writeUint32(startTs);
  writer.writeUint8(0); // creator device
  writer.writeUint16(255); // development
  writer.writeUint16(1);
  writer.writeUint16(100);

  // Local 8 -> sport (global 12): sets Activity Name ("Free Ride - Scenery" / "Workout - Scenery")
  writer.writeDefinition(8, 12, SPORT_FIELDS);
  writer.writeDataHeader(8);
  writer.writeUint8(FIT_SPORT_CYCLING);
  writer.writeUint8(FIT_SUB_SPORT_VIRTUAL_ACTIVITY);
  writer.writeFixedString(activityName, ACTIVITY_NAME_BYTES);

  // Local 9 -> workout (global 26): sets wkt_name for platforms reading workout title
  writer.writeDefinition(9, 26, WORKOUT_FIELDS);
  writer.writeDataHeader(9);
  writer.writeUint8(FIT_SPORT_CYCLING);
  writer.writeUint16(Math.max(1, ride.laps.length));
  writer.writeFixedString(activityName, ACTIVITY_NAME_BYTES);
  writer.writeUint8(FIT_SUB_SPORT_VIRTUAL_ACTIVITY);

  // Local 3 -> event (global 21): Timer Start
  writer.writeDefinition(3, 21, EVENT_FIELDS);
  writer.writeDataHeader(3);
  writer.writeUint32(startTs);
  writer.writeUint8(0); // timer
  writer.writeUint8(0); // start
  writer.writeUint8(0); // event_group

  // Local 4 -> record (global 20): 1 Hz telemetry stream
  if (ride.records.length > 0) {
    writer.writeDefinition(4, 20, RECORD_FIELDS);
    for (let i = 0; i < ride.records.length; i++) {
      writeRecordMessage(writer, ride.records[i]);
    }
  }

  // Local 3 -> event (global 21): Timer Stop All
  writer.writeDataHeader(3);
  writer.writeUint32(endTs);
  writer.writeUint8(0); // timer
  writer.writeUint8(4); // stop_all
  writer.writeUint8(0); // event_group

  // Local 5 -> lap (global 19): One lap per workout step segment
  const laps = ride.laps;
  if (laps.length > 0) {
    writer.writeDefinition(5, 19, LAP_FIELDS);
    for (let i = 0; i < laps.length; i++) {
      writeLapMessage(writer, laps[i]);
    }
  }

  // Local 6 -> session (global 18): Overall ride summary
  const avgSpeedMps = ride.avgSpeedKmh / 3.6;
  const maxSpeedMps = ride.maxSpeedKmh / 3.6;
  writer.writeDefinition(6, 18, SESSION_FIELDS);
  writer.writeDataHeader(6);
  writer.writeUint16(0); // message_index
  writer.writeUint32(endTs);
  writer.writeUint32(startTs);
  writer.writeUint8(FIT_SPORT_CYCLING); // 2 = cycling
  writer.writeUint8(FIT_SUB_SPORT_VIRTUAL_ACTIVITY); // 58 = virtual_activity
  writer.writeUint32(Math.max(0, Math.round(ride.totalElapsedSec * 1000)));
  writer.writeUint32(Math.max(0, Math.round(ride.totalTimerSec * 1000)));
  writer.writeUint32(Math.max(0, Math.round(ride.totalDistanceM * 100)));
  writer.writeUint16(Math.min(65534, Math.max(0, Math.round(ride.calories))));
  writer.writeUint16(encodeSpeed16(avgSpeedMps));
  writer.writeUint16(encodeSpeed16(maxSpeedMps));
  writer.writeUint8(encodeHr(ride.avgHeartRate));
  writer.writeUint8(encodeHr(ride.maxHeartRate));
  writer.writeUint8(encodeCadence(ride.avgCadence));
  writer.writeUint8(encodeCadence(ride.maxCadence));
  writer.writeUint16(encodePower(ride.avgPower));
  writer.writeUint16(encodePower(ride.maxPower));
  writer.writeUint16(Math.min(65534, Math.max(0, Math.round(ride.totalAscentM))));
  writer.writeUint16(Math.min(65534, Math.max(0, Math.round(ride.totalDescentM))));
  writer.writeUint16(0); // first_lap_index
  writer.writeUint16(laps.length); // num_laps
  writer.writeUint16(encodePower(ride.normalizedPower));
  writer.writeUint16(Math.min(65534, Math.max(0, Math.round(ride.tss * 10))));
  writer.writeUint16(Math.min(65534, Math.max(0, Math.round(ride.intensityFactor * 1000))));
  writer.writeUint32(Math.max(0, Math.round(ride.totalWorkKj * 1000))); // joules
  writer.writeUint32(encodeSpeed32(avgSpeedMps));
  writer.writeUint32(encodeSpeed32(maxSpeedMps));

  // Local 7 -> activity (global 34)
  const tzOffsetSec = new Date(ride.endTimeMs).getTimezoneOffset() * 60;
  const localTs = Math.max(0, endTs - tzOffsetSec);
  writer.writeDefinition(7, 34, ACTIVITY_FIELDS);
  writer.writeDataHeader(7);
  writer.writeUint32(endTs);
  writer.writeUint32(Math.max(0, Math.round(ride.totalTimerSec * 1000)));
  writer.writeUint16(1); // num_sessions
  writer.writeUint8(0); // manual
  writer.writeUint8(26); // event = activity
  writer.writeUint8(1); // event_type = stop
  writer.writeUint32(localTs);

  const dataBytes = writer.toUint8Array();
  const dataSize = dataBytes.length;

  // Assemble 14-byte FIT header + data records + 2-byte trailing CRC
  const fullFile = new Uint8Array(14 + dataSize + 2);
  const headerView = new DataView(fullFile.buffer);

  headerView.setUint8(0, 14); // header size
  headerView.setUint8(1, 0x20); // protocol version 2.0
  headerView.setUint16(2, 2132, true); // profile version 21.32
  headerView.setUint32(4, dataSize, true); // data size
  // ".FIT" ASCII signature
  fullFile[8] = 0x2e; // '.'
  fullFile[9] = 0x46; // 'F'
  fullFile[10] = 0x49; // 'I'
  fullFile[11] = 0x54; // 'T'
  const headerCrc = computeFitCrc(fullFile, 0, 12);
  headerView.setUint16(12, headerCrc, true);

  fullFile.set(dataBytes, 14);

  const fileCrc = computeFitCrc(fullFile, 14, 14 + dataSize);
  headerView.setUint16(14 + dataSize, fileCrc, true);

  return fullFile;
}

export interface FitVerificationSummary {
  validHeaderSignature: boolean;
  headerCrcValid: boolean;
  fileCrcValid: boolean;
  dataSizeMatches: boolean;
  messageCountsByGlobalNum: Record<number, number>;
  sessionSport: number | null;
  sessionSubSport: number | null;
  sportActivityName: string | null;
  workoutActivityName: string | null;
  lapSports: number[];
  lapSubSports: number[];
  firstRecordLatDeg: number | null;
  firstRecordLonDeg: number | null;
  firstRecordAltitudeM: number | null;
  lastRecordAltitudeM: number | null;
}

function readNullTerminatedString(bytes: Uint8Array, start: number, maxLen: number): string {
  let end = start;
  const limit = Math.min(bytes.length, start + maxLen);
  while (end < limit && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(start, end));
}

/**
 * Lightweight FIT binary parser/validator used by automated unit tests to verify
 * header signature, CRC-16 integrity, message counts, sport/sub_sport enums,
 * Activity Name strings, Ura-shima GPS coordinates, and virtual altitude encoding.
 */
export function verifyFitBinary(bytes: Uint8Array): FitVerificationSummary {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint8(0);
  const dataSize = view.getUint32(4, true);
  const sig = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  const storedHeaderCrc = view.getUint16(12, true);
  const expectedHeaderCrc = computeFitCrc(bytes, 0, 12);
  const storedFileCrc = view.getUint16(headerSize + dataSize, true);
  const expectedFileCrc = computeFitCrc(bytes, headerSize, headerSize + dataSize);

  const defs = new Map<number, { globalNum: number; fields: FieldDef[] }>();
  const counts: Record<number, number> = {};
  let sessionSport: number | null = null;
  let sessionSubSport: number | null = null;
  let sportActivityName: string | null = null;
  let workoutActivityName: string | null = null;
  const lapSports: number[] = [];
  const lapSubSports: number[] = [];
  let firstRecordLatDeg: number | null = null;
  let firstRecordLonDeg: number | null = null;
  let firstRecordAltitudeM: number | null = null;
  let lastRecordAltitudeM: number | null = null;
  let firstRecordSeen = false;

  let pos = headerSize;
  const end = headerSize + dataSize;

  while (pos < end) {
    const hdr = bytes[pos++];
    const isDef = (hdr & 0x40) !== 0;
    const localNum = hdr & 0x0f;

    if (isDef) {
      pos += 2; // reserved + arch
      const globalNum = view.getUint16(pos, true);
      pos += 2;
      const numFields = bytes[pos++];
      const fields: FieldDef[] = [];
      for (let i = 0; i < numFields; i++) {
        fields.push({
          num: bytes[pos++],
          size: bytes[pos++],
          baseType: bytes[pos++],
        });
      }
      defs.set(localNum, { globalNum, fields });
    } else {
      const def = defs.get(localNum);
      if (!def) break;
      counts[def.globalNum] = (counts[def.globalNum] ?? 0) + 1;

      const isFirstRecord = def.globalNum === 20 && !firstRecordSeen;
      for (const f of def.fields) {
        if (def.globalNum === 12) {
          if (f.num === 3) sportActivityName = readNullTerminatedString(bytes, pos, f.size);
        } else if (def.globalNum === 26) {
          if (f.num === 8) workoutActivityName = readNullTerminatedString(bytes, pos, f.size);
        } else if (def.globalNum === 18) {
          if (f.num === 5) sessionSport = view.getUint8(pos);
          if (f.num === 6) sessionSubSport = view.getUint8(pos);
        } else if (def.globalNum === 19) {
          if (f.num === 25) lapSports.push(view.getUint8(pos));
          if (f.num === 39) lapSubSports.push(view.getUint8(pos));
        } else if (def.globalNum === 20) {
          if (isFirstRecord && f.num === 0) {
            firstRecordLatDeg = view.getInt32(pos, true) / SEMICIRCLES_PER_DEGREE;
          }
          if (isFirstRecord && f.num === 1) {
            firstRecordLonDeg = view.getInt32(pos, true) / SEMICIRCLES_PER_DEGREE;
          }
          if (f.num === 2) {
            const altM = view.getUint16(pos, true) / 5 - 500;
            if (isFirstRecord) firstRecordAltitudeM = altM;
            lastRecordAltitudeM = altM;
          }
        }
        pos += f.size;
      }
      if (isFirstRecord) firstRecordSeen = true;
    }
  }

  return {
    validHeaderSignature: headerSize === 14 && sig === '.FIT',
    headerCrcValid: storedHeaderCrc === expectedHeaderCrc,
    fileCrcValid: storedFileCrc === expectedFileCrc,
    dataSizeMatches: bytes.length === headerSize + dataSize + 2,
    messageCountsByGlobalNum: counts,
    sessionSport,
    sessionSubSport,
    sportActivityName,
    workoutActivityName,
    lapSports,
    lapSubSports,
    firstRecordLatDeg,
    firstRecordLonDeg,
    firstRecordAltitudeM,
    lastRecordAltitudeM,
  };
}

export function buildFitFileName(
  ride: Pick<SavedRide, 'workoutName' | 'activityName' | 'startTimeMs'>
): string {
  const d = new Date(ride.startTimeMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
    d.getHours()
  )}-${pad(d.getMinutes())}`;
  const label = ride.activityName || ride.workoutName || 'Ride';
  const slug = label
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `EndlessHorizon_${slug || 'Ride'}_${stamp}.fit`;
}
