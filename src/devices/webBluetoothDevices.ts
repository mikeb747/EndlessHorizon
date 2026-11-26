import { powerToSpeedKmh } from '../core/zones';
import {
  CrankRevState,
  createCrankRevState,
  parseCscMeasurement,
  parseCyclingPowerMeasurement,
  parseFtmsIndoorBikeData,
  parseHeartRateMeasurement,
} from './bleParsers';
import {
  CadenceDevice,
  CadenceStatusSnapshot,
  CadenceTelemetry,
  HeartRateDevice,
  HeartRateStatusSnapshot,
  HeartRateTelemetry,
  TrainerDevice,
  TrainerStatusSnapshot,
  TrainerTelemetry,
} from './types';

// Standard Bluetooth SIG 16-bit UUIDs
const SERVICE_CSC = 0x1816;
const CHAR_CSC_MEASUREMENT = 0x2a5b;

const SERVICE_CYCLING_POWER = 0x1818;
const CHAR_CYCLING_POWER_MEASUREMENT = 0x2a63;

const SERVICE_FTMS = 0x1826;
const CHAR_FTMS_INDOOR_BIKE_DATA = 0x2ad2;
const CHAR_FTMS_CONTROL_POINT = 0x2ad9;

const SERVICE_HEART_RATE = 0x180d;
const CHAR_HEART_RATE_MEASUREMENT = 0x2a37;

interface WebBluetoothNavigator extends Navigator {
  bluetooth?: {
    requestDevice: (options: Record<string, unknown>) => Promise<BleDeviceLike>;
  };
}

interface BleCharacteristicLike {
  value?: DataView;
  startNotifications: () => Promise<BleCharacteristicLike>;
  stopNotifications?: () => Promise<void>;
  writeValueWithResponse?: (value: BufferSource) => Promise<void>;
  writeValue?: (value: BufferSource) => Promise<void>;
  addEventListener: (event: string, cb: (ev: Event) => void) => void;
  removeEventListener: (event: string, cb: (ev: Event) => void) => void;
}

interface BleServiceLike {
  getCharacteristic: (uuid: number | string) => Promise<BleCharacteristicLike>;
}

interface BleGattServerLike {
  connected: boolean;
  connect: () => Promise<BleGattServerLike>;
  disconnect: () => void;
  getPrimaryService: (uuid: number | string) => Promise<BleServiceLike>;
}

interface BleDeviceLike {
  id: string;
  name?: string;
  gatt?: BleGattServerLike;
  addEventListener: (event: string, cb: () => void) => void;
  removeEventListener: (event: string, cb: () => void) => void;
}

function getWebBluetooth() {
  if (typeof navigator === 'undefined') return null;
  return (navigator as WebBluetoothNavigator).bluetooth ?? null;
}

async function writeCharacteristic(
  char: BleCharacteristicLike,
  bytes: Uint8Array<ArrayBuffer>
): Promise<void> {
  if (char.writeValueWithResponse) {
    await char.writeValueWithResponse(bytes);
  } else if (char.writeValue) {
    await char.writeValue(bytes);
  }
}

/**
 * Real Web Bluetooth Cadence Sensor supporting:
 * - Dedicated CSC Cadence Sensors (Service 0x1816 / Characteristic 0x2A5B — Wahoo RPM, Garmin, Magene, etc.)
 * - Cycling Power Meters with crank cadence (Service 0x1818 / Characteristic 0x2A63)
 * Automatically emits 0 RPM if no crank revolution event arrives for 3 seconds (coasting).
 */
export class WebBluetoothCadenceDevice implements CadenceDevice {
  readonly isSimulated = false;

  private status: CadenceStatusSnapshot = {
    status: 'disconnected',
    deviceId: null,
    deviceName: null,
    signalStrength: 0,
    isSimulated: false,
    errorMessage: null,
  };

  private device: BleDeviceLike | null = null;
  private characteristic: BleCharacteristicLike | null = null;
  private mode: 'csc' | 'power' = 'csc';
  private crankState: CrankRevState = createCrankRevState();
  private lastRpm = 0;
  private lastCrankEventMs = 0;
  private coastTimer: number | null = null;

  private telemetryListeners = new Set<(data: CadenceTelemetry) => void>();
  private statusListeners = new Set<(status: CadenceStatusSnapshot) => void>();

  private handleDisconnected = () => {
    this.cleanupGatt();
    this.emitStatus({
      status: 'disconnected',
      signalStrength: 0,
    });
    this.emitTelemetry(0);
  };

  private handleNotification = (event: Event) => {
    const target = event.target as unknown as BleCharacteristicLike | null;
    const value = target?.value;
    if (!value) return;

    const nowMs = Date.now();
    const parsed =
      this.mode === 'csc'
        ? parseCscMeasurement(value, this.crankState)
        : parseCyclingPowerMeasurement(value, this.crankState).cadence;

    this.crankState = parsed.nextState;

    if (parsed.newEvent && parsed.rpm !== null) {
      this.lastRpm = parsed.rpm;
      this.lastCrankEventMs = nowMs;
      this.emitTelemetry(parsed.rpm, nowMs);
    } else if (this.lastRpm > 0 && nowMs - this.lastCrankEventMs >= 2600) {
      this.lastRpm = 0;
      this.emitTelemetry(0, nowMs);
    }
  };

  getStatus(): CadenceStatusSnapshot {
    return { ...this.status };
  }

  async connect(): Promise<void> {
    const bt = getWebBluetooth();
    if (!bt) {
      this.emitStatus({
        status: 'disconnected',
        errorMessage: 'Web Bluetooth API is unavailable in this browser. Use Chrome or Edge over HTTPS/localhost.',
      });
      return;
    }

    try {
      this.emitStatus({ status: 'connecting', errorMessage: null });
      const device = await bt.requestDevice({
        filters: [{ services: [SERVICE_CSC] }, { services: [SERVICE_CYCLING_POWER] }],
        optionalServices: [SERVICE_CSC, SERVICE_CYCLING_POWER],
      });

      if (!device.gatt) {
        throw new Error('Selected Bluetooth device does not expose a GATT server.');
      }

      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnected);

      const server = await device.gatt.connect();
      let char: BleCharacteristicLike | null = null;

      try {
        const cscService = await server.getPrimaryService(SERVICE_CSC);
        char = await cscService.getCharacteristic(CHAR_CSC_MEASUREMENT);
        this.mode = 'csc';
      } catch {
        const cpService = await server.getPrimaryService(SERVICE_CYCLING_POWER);
        char = await cpService.getCharacteristic(CHAR_CYCLING_POWER_MEASUREMENT);
        this.mode = 'power';
      }

      this.crankState = createCrankRevState();
      this.lastRpm = 0;
      this.lastCrankEventMs = Date.now();

      this.characteristic = char;
      this.characteristic.addEventListener('characteristicvaluechanged', this.handleNotification);
      await this.characteristic.startNotifications();

      this.startCoastWatchdog();
      this.emitStatus({
        status: 'connected',
        deviceId: device.id,
        deviceName: device.name || 'BLE Cadence Sensor',
        signalStrength: 92,
        errorMessage: null,
      });
    } catch (err) {
      this.cleanupGatt();
      const message =
        err instanceof Error ? err.message : 'Failed to pair Bluetooth cadence sensor.';
      // Ignore silent cancel when user closes the browser chooser
      const isCancelled = message.toLowerCase().includes('cancel');
      this.emitStatus({
        status: 'disconnected',
        signalStrength: 0,
        errorMessage: isCancelled ? null : message,
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanupGatt();
    this.emitStatus({
      status: 'disconnected',
      signalStrength: 0,
      errorMessage: null,
    });
    this.emitTelemetry(0);
  }

  onTelemetry(listener: (data: CadenceTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  onStatusChange(listener: (status: CadenceStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  dispose(): void {
    void this.disconnect();
    this.telemetryListeners.clear();
    this.statusListeners.clear();
  }

  private startCoastWatchdog(): void {
    this.stopCoastWatchdog();
    this.coastTimer = window.setInterval(() => {
      const nowMs = Date.now();
      if (this.lastRpm > 0 && nowMs - this.lastCrankEventMs >= 2800) {
        this.lastRpm = 0;
        this.emitTelemetry(0, nowMs);
      }
    }, 500);
  }

  private stopCoastWatchdog(): void {
    if (this.coastTimer !== null) {
      window.clearInterval(this.coastTimer);
      this.coastTimer = null;
    }
  }

  private cleanupGatt(): void {
    this.stopCoastWatchdog();
    if (this.characteristic) {
      this.characteristic.removeEventListener(
        'characteristicvaluechanged',
        this.handleNotification
      );
      this.characteristic = null;
    }
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected);
      this.device = null;
    }
    this.crankState = createCrankRevState();
    this.lastRpm = 0;
  }

  private emitStatus(patch: Partial<CadenceStatusSnapshot>): void {
    this.status = { ...this.status, ...patch };
    const snap = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snap);
    }
  }

  private emitTelemetry(cadenceRpm: number, timestampMs = Date.now()): void {
    const payload: CadenceTelemetry = {
      cadenceRpm,
      timestampMs,
    };
    for (const listener of this.telemetryListeners) {
      listener(payload);
    }
  }
}

/**
 * Real Web Bluetooth Smart Trainer over FTMS (Service 0x1826).
 * Reads Indoor Bike Data (0x2AD2) for live Power, Cadence, and Speed,
 * and writes ERG Target Power (OpCode 0x05) to FTMS Control Point (0x2AD9).
 */
export class WebBluetoothTrainerDevice implements TrainerDevice {
  readonly isSimulated = false;

  private status: TrainerStatusSnapshot = {
    status: 'disconnected',
    deviceId: null,
    deviceName: null,
    ergControlActive: false,
    ergControlWarning: null,
    signalStrength: 0,
    isSimulated: false,
  };

  private device: BleDeviceLike | null = null;
  private bikeDataChar: BleCharacteristicLike | null = null;
  private controlPointChar: BleCharacteristicLike | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private lastPower = 0;
  private lastCadence = 0;
  private lastSpeed = 0;

  private telemetryListeners = new Set<(data: TrainerTelemetry) => void>();
  private statusListeners = new Set<(status: TrainerStatusSnapshot) => void>();

  private handleDisconnected = () => {
    this.cleanupGatt();
    this.emitStatus({
      status: 'disconnected',
      ergControlActive: false,
      signalStrength: 0,
    });
  };

  private handleBikeData = (event: Event) => {
    const target = event.target as unknown as BleCharacteristicLike | null;
    const value = target?.value;
    if (!value) return;

    const parsed = parseFtmsIndoorBikeData(value);
    if (parsed.instantPowerW !== null) this.lastPower = parsed.instantPowerW;
    if (parsed.cadenceRpm !== null) this.lastCadence = parsed.cadenceRpm;
    this.lastSpeed =
      parsed.speedKmh !== null ? parsed.speedKmh : powerToSpeedKmh(this.lastPower);

    const payload: TrainerTelemetry = {
      instantPower: this.lastPower,
      cadence: this.lastCadence,
      speedKmh: this.lastSpeed,
      timestampMs: Date.now(),
    };
    for (const listener of this.telemetryListeners) {
      listener(payload);
    }
  };

  getStatus(): TrainerStatusSnapshot {
    return { ...this.status };
  }

  async connect(): Promise<void> {
    const bt = getWebBluetooth();
    if (!bt) {
      this.emitStatus({
        status: 'disconnected',
        ergControlWarning:
          'Web Bluetooth API is unavailable in this browser. Use Chrome or Edge over HTTPS/localhost.',
      });
      return;
    }

    try {
      this.emitStatus({ status: 'connecting', ergControlWarning: null });
      const device = await bt.requestDevice({
        filters: [{ services: [SERVICE_FTMS] }],
        optionalServices: [SERVICE_FTMS],
      });

      if (!device.gatt) {
        throw new Error('Selected trainer does not expose a GATT server.');
      }

      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnected);

      const server = await device.gatt.connect();
      const ftms = await server.getPrimaryService(SERVICE_FTMS);
      const bikeData = await ftms.getCharacteristic(CHAR_FTMS_INDOOR_BIKE_DATA);

      this.bikeDataChar = bikeData;
      this.bikeDataChar.addEventListener('characteristicvaluechanged', this.handleBikeData);
      await this.bikeDataChar.startNotifications();

      try {
        this.controlPointChar = await ftms.getCharacteristic(CHAR_FTMS_CONTROL_POINT);
        await this.controlPointChar.startNotifications();
      } catch {
        this.controlPointChar = null;
      }

      this.emitStatus({
        status: 'connected',
        deviceId: device.id,
        deviceName: device.name || 'FTMS Smart Trainer',
        signalStrength: 94,
        ergControlActive: false,
        ergControlWarning: null,
      });
    } catch (err) {
      this.cleanupGatt();
      const message =
        err instanceof Error ? err.message : 'Failed to connect to Bluetooth FTMS trainer.';
      const isCancelled = message.toLowerCase().includes('cancel');
      this.emitStatus({
        status: 'disconnected',
        ergControlActive: false,
        signalStrength: 0,
        ergControlWarning: isCancelled ? null : message,
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanupGatt();
    this.emitStatus({
      status: 'disconnected',
      ergControlActive: false,
      signalStrength: 0,
    });
  }

  async requestControl(): Promise<boolean> {
    if (!this.controlPointChar) return false;
    try {
      await this.enqueueControlWrite(new Uint8Array([0x00]));
      this.emitStatus({ ergControlActive: true, ergControlWarning: null });
      return true;
    } catch (err) {
      this.emitStatus({
        ergControlActive: false,
        ergControlWarning: err instanceof Error ? err.message : 'Unable to acquire FTMS ERG control.',
      });
      return false;
    }
  }

  async startResume(): Promise<void> {
    if (!this.controlPointChar) return;
    await this.enqueueControlWrite(new Uint8Array([0x07]));
  }

  async stopPause(): Promise<void> {
    if (!this.controlPointChar) return;
    await this.enqueueControlWrite(new Uint8Array([0x08, 0x02]));
  }

  async setTargetPower(watts: number): Promise<void> {
    if (!this.controlPointChar) return;
    const clamped = Math.max(0, Math.min(2000, Math.round(watts)));
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, 0x05); // Set Target Power OpCode
    view.setInt16(1, clamped, true);
    await this.enqueueControlWrite(new Uint8Array(buf));
  }

  onTelemetry(listener: (data: TrainerTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  onStatusChange(listener: (status: TrainerStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  dispose(): void {
    void this.disconnect();
    this.telemetryListeners.clear();
    this.statusListeners.clear();
  }

  private enqueueControlWrite(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const char = this.controlPointChar;
    if (!char) return Promise.resolve();
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => writeCharacteristic(char, bytes));
    return this.writeChain;
  }

  private cleanupGatt(): void {
    if (this.bikeDataChar) {
      this.bikeDataChar.removeEventListener('characteristicvaluechanged', this.handleBikeData);
      this.bikeDataChar = null;
    }
    this.controlPointChar = null;
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected);
      this.device = null;
    }
  }

  private emitStatus(patch: Partial<TrainerStatusSnapshot>): void {
    this.status = { ...this.status, ...patch };
    const snap = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snap);
    }
  }
}

/**
 * Real Web Bluetooth Heart Rate Monitor (Service 0x180D / Characteristic 0x2A37).
 */
export class WebBluetoothHeartRateDevice implements HeartRateDevice {
  readonly isSimulated = false;

  private status: HeartRateStatusSnapshot = {
    status: 'disconnected',
    deviceId: null,
    deviceName: null,
    signalStrength: 0,
    isSimulated: false,
  };

  private device: BleDeviceLike | null = null;
  private hrChar: BleCharacteristicLike | null = null;

  private telemetryListeners = new Set<(data: HeartRateTelemetry) => void>();
  private statusListeners = new Set<(status: HeartRateStatusSnapshot) => void>();

  private handleDisconnected = () => {
    this.cleanupGatt();
    this.emitStatus({ status: 'disconnected', signalStrength: 0 });
  };

  private handleHrValue = (event: Event) => {
    const target = event.target as unknown as BleCharacteristicLike | null;
    const value = target?.value;
    if (!value) return;
    const bpm = parseHeartRateMeasurement(value);
    if (bpm === null) return;
    const payload: HeartRateTelemetry = {
      heartRate: bpm,
      timestampMs: Date.now(),
    };
    for (const listener of this.telemetryListeners) {
      listener(payload);
    }
  };

  getStatus(): HeartRateStatusSnapshot {
    return { ...this.status };
  }

  async connect(): Promise<void> {
    const bt = getWebBluetooth();
    if (!bt) return;

    try {
      this.emitStatus({ status: 'connecting' });
      const device = await bt.requestDevice({
        filters: [{ services: [SERVICE_HEART_RATE] }],
        optionalServices: [SERVICE_HEART_RATE],
      });

      if (!device.gatt) {
        throw new Error('Selected HRM device does not expose a GATT server.');
      }

      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnected);

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_HEART_RATE);
      const char = await service.getCharacteristic(CHAR_HEART_RATE_MEASUREMENT);

      this.hrChar = char;
      this.hrChar.addEventListener('characteristicvaluechanged', this.handleHrValue);
      await this.hrChar.startNotifications();

      this.emitStatus({
        status: 'connected',
        deviceId: device.id,
        deviceName: device.name || 'BLE Heart Rate Monitor',
        signalStrength: 95,
      });
    } catch {
      this.cleanupGatt();
      this.emitStatus({ status: 'disconnected', signalStrength: 0 });
    }
  }

  async disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanupGatt();
    this.emitStatus({ status: 'disconnected', signalStrength: 0 });
  }

  onTelemetry(listener: (data: HeartRateTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  onStatusChange(listener: (status: HeartRateStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  dispose(): void {
    void this.disconnect();
    this.telemetryListeners.clear();
    this.statusListeners.clear();
  }

  private cleanupGatt(): void {
    if (this.hrChar) {
      this.hrChar.removeEventListener('characteristicvaluechanged', this.handleHrValue);
      this.hrChar = null;
    }
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected);
      this.device = null;
    }
  }

  private emitStatus(patch: Partial<HeartRateStatusSnapshot>): void {
    this.status = { ...this.status, ...patch };
    const snap = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snap);
    }
  }
}
