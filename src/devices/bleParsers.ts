/**
 * Pure binary parsers for standard Bluetooth Low Energy cycling telemetry profiles:
 * - CSC Measurement (0x2A5B, Service 0x1816) — dedicated Bluetooth cadence sensors (Wahoo RPM, Garmin, Magene, etc.)
 * - FTMS Indoor Bike Data (0x2AD2, Service 0x1826) — smart trainers (Wahoo KICKR, Tacx, Elite, etc.)
 * - Cycling Power Measurement (0x2A63, Service 0x1818) — crank/pedal power meters with crank revolution cadence
 * - Heart Rate Measurement (0x2A37, Service 0x180D) — BLE chest straps and optical HRM bands
 */

export interface CrankRevState {
  cumulativeRevs: number;
  lastEventTime1024: number;
  initialized: boolean;
}

export interface ParsedCrankCadenceResult {
  hasCrankData: boolean;
  /** Newly computed RPM, or null if no new crank revolution occurred in this packet */
  rpm: number | null;
  /** True when the packet carried a new crank revolution event (resets coasting timeout) */
  newEvent: boolean;
  nextState: CrankRevState;
}

export interface ParsedFtmsBikeData {
  speedKmh: number | null;
  cadenceRpm: number | null;
  instantPowerW: number | null;
}

export interface ParsedCyclingPowerData {
  instantPowerW: number;
  cadence: ParsedCrankCadenceResult;
}

export function createCrankRevState(): CrankRevState {
  return {
    cumulativeRevs: 0,
    lastEventTime1024: 0,
    initialized: false,
  };
}

/**
 * Compute RPM from 16-bit cumulative crank revolutions and 1/1024-second event timestamps,
 * handling uint16 wraparound safely per Bluetooth SIG CSC / Cycling Power specification.
 */
export function computeRpmFromCrankRevs(
  cumulativeRevs: number,
  lastEventTime1024: number,
  prev: CrankRevState
): ParsedCrankCadenceResult {
  const nextState: CrankRevState = {
    cumulativeRevs: cumulativeRevs & 0xffff,
    lastEventTime1024: lastEventTime1024 & 0xffff,
    initialized: true,
  };

  if (!prev.initialized) {
    return {
      hasCrankData: true,
      rpm: null,
      newEvent: false,
      nextState,
    };
  }

  const deltaRevs = (nextState.cumulativeRevs - prev.cumulativeRevs + 65536) & 0xffff;
  const deltaTicks = (nextState.lastEventTime1024 - prev.lastEventTime1024 + 65536) & 0xffff;

  // No crank revolution since last notification (coasting or duplicate packet)
  if (deltaRevs === 0 || deltaTicks === 0) {
    return {
      hasCrankData: true,
      rpm: null,
      newEvent: false,
      nextState,
    };
  }

  // Guard against implausible spike on reconnect / packet loss
  const deltaSec = deltaTicks / 1024;
  const rawRpm = (deltaRevs / deltaSec) * 60;
  if (!Number.isFinite(rawRpm) || rawRpm <= 0 || rawRpm > 240) {
    return {
      hasCrankData: true,
      rpm: null,
      newEvent: false,
      nextState,
    };
  }

  return {
    hasCrankData: true,
    rpm: Math.round(rawRpm * 10) / 10,
    newEvent: true,
    nextState,
  };
}

/**
 * Parse BLE CSC Measurement characteristic (0x2A5B).
 * Byte 0: Flags
 *  - Bit 0 (0x01): Wheel Revolution Data Present (uint32 wheel revs + uint16 wheel event time = 6 bytes)
 *  - Bit 1 (0x02): Crank Revolution Data Present (uint16 crank revs + uint16 crank event time = 4 bytes)
 */
export function parseCscMeasurement(
  data: DataView,
  prevState: CrankRevState
): ParsedCrankCadenceResult {
  if (data.byteLength < 1) {
    return { hasCrankData: false, rpm: null, newEvent: false, nextState: prevState };
  }

  const flags = data.getUint8(0);
  const hasWheelData = (flags & 0x01) !== 0;
  const hasCrankData = (flags & 0x02) !== 0;

  if (!hasCrankData) {
    return { hasCrankData: false, rpm: null, newEvent: false, nextState: prevState };
  }

  const offset = 1 + (hasWheelData ? 6 : 0);
  if (data.byteLength < offset + 4) {
    return { hasCrankData: false, rpm: null, newEvent: false, nextState: prevState };
  }

  const cumulativeCrankRevs = data.getUint16(offset, true);
  const lastCrankEventTime = data.getUint16(offset + 2, true);
  return computeRpmFromCrankRevs(cumulativeCrankRevs, lastCrankEventTime, prevState);
}

/**
 * Parse BLE Cycling Power Measurement characteristic (0x2A63).
 * Bytes 0..1: Flags (uint16 LE)
 * Bytes 2..3: Instantaneous Power (sint16 LE, Watts)
 * Optional fields precede Crank Revolution Data (Bit 5 = 0x0020):
 *  - Bit 0 (0x0001): Pedal Power Balance (1 byte)
 *  - Bit 2 (0x0004): Accumulated Torque (2 bytes)
 *  - Bit 4 (0x0010): Wheel Revolution Data (6 bytes)
 *  - Bit 5 (0x0020): Crank Revolution Data (uint16 revs + uint16 time 1/1024s = 4 bytes)
 */
export function parseCyclingPowerMeasurement(
  data: DataView,
  prevState: CrankRevState
): ParsedCyclingPowerData {
  if (data.byteLength < 4) {
    return {
      instantPowerW: 0,
      cadence: { hasCrankData: false, rpm: null, newEvent: false, nextState: prevState },
    };
  }

  const flags = data.getUint16(0, true);
  const instantPowerW = Math.max(0, data.getInt16(2, true));
  let offset = 4;

  if ((flags & 0x0001) !== 0) offset += 1; // Pedal Power Balance
  if ((flags & 0x0004) !== 0) offset += 2; // Accumulated Torque
  if ((flags & 0x0010) !== 0) offset += 6; // Wheel Revolution Data

  const hasCrankData = (flags & 0x0020) !== 0;
  if (!hasCrankData || data.byteLength < offset + 4) {
    return {
      instantPowerW,
      cadence: { hasCrankData: false, rpm: null, newEvent: false, nextState: prevState },
    };
  }

  const cumulativeCrankRevs = data.getUint16(offset, true);
  const lastCrankEventTime = data.getUint16(offset + 2, true);
  return {
    instantPowerW,
    cadence: computeRpmFromCrankRevs(cumulativeCrankRevs, lastCrankEventTime, prevState),
  };
}

/**
 * Parse BLE FTMS Indoor Bike Data characteristic (0x2AD2).
 * Bytes 0..1: Flags (uint16 LE)
 *  - Bit 0 (0x0001): More Data (0 = Instantaneous Speed present, 2 bytes, 0.01 km/h)
 *  - Bit 1 (0x0002): Average Speed present (2 bytes)
 *  - Bit 2 (0x0004): Instantaneous Cadence present (2 bytes, 0.5 rpm)
 *  - Bit 3 (0x0008): Average Cadence present (2 bytes)
 *  - Bit 4 (0x0010): Total Distance present (3 bytes)
 *  - Bit 5 (0x0020): Resistance Level present (2 bytes)
 *  - Bit 6 (0x0040): Instantaneous Power present (2 bytes, sint16 W)
 */
export function parseFtmsIndoorBikeData(data: DataView): ParsedFtmsBikeData {
  if (data.byteLength < 2) {
    return { speedKmh: null, cadenceRpm: null, instantPowerW: null };
  }

  const flags = data.getUint16(0, true);
  let offset = 2;

  let speedKmh: number | null = null;
  let cadenceRpm: number | null = null;
  let instantPowerW: number | null = null;

  // Bit 0 === 0 means Instantaneous Speed IS present
  if ((flags & 0x0001) === 0 && offset + 2 <= data.byteLength) {
    speedKmh = Math.round((data.getUint16(offset, true) * 0.01) * 10) / 10;
    offset += 2;
  }

  if ((flags & 0x0002) !== 0) offset += 2; // Average Speed

  if ((flags & 0x0004) !== 0 && offset + 2 <= data.byteLength) {
    cadenceRpm = Math.round((data.getUint16(offset, true) * 0.5) * 10) / 10;
    offset += 2;
  }

  if ((flags & 0x0008) !== 0) offset += 2; // Average Cadence
  if ((flags & 0x0010) !== 0) offset += 3; // Total Distance (uint24)
  if ((flags & 0x0020) !== 0) offset += 2; // Resistance Level

  if ((flags & 0x0040) !== 0 && offset + 2 <= data.byteLength) {
    instantPowerW = Math.max(0, data.getInt16(offset, true));
  }

  return { speedKmh, cadenceRpm, instantPowerW };
}

/**
 * Parse BLE Heart Rate Measurement characteristic (0x2A37).
 */
export function parseHeartRateMeasurement(data: DataView): number | null {
  if (data.byteLength < 2) return null;
  const flags = data.getUint8(0);
  const is16Bit = (flags & 0x01) !== 0;
  if (is16Bit) {
    if (data.byteLength < 3) return null;
    return data.getUint16(1, true);
  }
  return data.getUint8(1);
}
