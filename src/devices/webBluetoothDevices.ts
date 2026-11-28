import { powerToSpeedKmh } from '../core/zones';
import {
  BLE_CONNECT_TIMEOUT_MS,
  BLE_MAX_RETRIES,
  BLE_WRITE_TIMEOUT_MS,
  CoalescingErgQueue,
  CONTROL_NOT_PERMITTED_MESSAGE,
  FTMS_OP_REQUEST_CONTROL,
  FTMS_OP_SET_TARGET_POWER,
  FTMS_OP_START_RESUME,
  FTMS_OP_STOP_PAUSE,
  FtmsControlPointResponse,
  parseFtmsControlPointResponse,
  withBluetoothRetry,
  withBluetoothTimeout,
} from './bleHardening';
import {
  CrankRevState,
  createCrankRevState,
  parseCscMeasurement,
  parseCyclingPowerMeasurement,
  parseFtmsIndoorBikeData,
  parseHeartRateMeasurement,
} from './bleParsers';
import { computeReconnectBackoffMs, waitForBleAdvertisement } from './devicePersistence';
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
const SERVICE_DEVICE_INFO = 0x180a;

const SERVICE_CSC = 0x1816;
const CHAR_CSC_MEASUREMENT = 0x2a5b;

const SERVICE_CYCLING_POWER = 0x1818;
const CHAR_CYCLING_POWER_MEASUREMENT = 0x2a63;

const SERVICE_FTMS = 0x1826;
const CHAR_FTMS_INDOOR_BIKE_DATA = 0x2ad2;
const CHAR_FTMS_CONTROL_POINT = 0x2ad9;

const SERVICE_HEART_RATE = 0x180d;
const CHAR_HEART_RATE_MEASUREMENT = 0x2a37;

export interface BleCharacteristicLike {
  value?: DataView;
  startNotifications: () => Promise<BleCharacteristicLike>;
  stopNotifications?: () => Promise<void>;
  writeValueWithResponse?: (value: BufferSource) => Promise<void>;
  writeValue?: (value: BufferSource) => Promise<void>;
  addEventListener: (event: string, cb: (ev: Event) => void) => void;
  removeEventListener: (event: string, cb: (ev: Event) => void) => void;
}

export interface BleServiceLike {
  getCharacteristic: (uuid: number | string) => Promise<BleCharacteristicLike>;
}

export interface BleGattServerLike {
  connected: boolean;
  connect: () => Promise<BleGattServerLike>;
  disconnect: () => void;
  getPrimaryService: (uuid: number | string) => Promise<BleServiceLike>;
}

export interface BleDeviceLike {
  id: string;
  name?: string;
  gatt?: BleGattServerLike;
  watchAdvertisements?: (options?: { signal?: AbortSignal }) => Promise<void>;
  addEventListener: (event: string, cb: () => void) => void;
  removeEventListener: (event: string, cb: () => void) => void;
}

interface WebBluetoothNavigator extends Navigator {
  bluetooth?: {
    requestDevice: (options: Record<string, unknown>) => Promise<BleDeviceLike>;
    getDevices?: () => Promise<BleDeviceLike[]>;
  };
}

function getWebBluetooth() {
  if (typeof navigator === 'undefined') return null;
  return (navigator as WebBluetoothNavigator).bluetooth ?? null;
}

export function isSilentBleReconnectSupported(): boolean {
  const bt = getWebBluetooth();
  return Boolean(bt && typeof bt.getDevices === 'function');
}

export async function getGrantedBluetoothDevices(): Promise<BleDeviceLike[]> {
  const bt = getWebBluetooth();
  if (!bt || typeof bt.getDevices !== 'function') return [];
  try {
    return await bt.getDevices();
  } catch {
    return [];
  }
}

function formatBluetoothError(err: unknown, fallback: string): { message: string; isCancelled: boolean } {
  const message =
    err instanceof Error && err.message.trim().length > 0 ? err.message.trim() : fallback;
  const lower = message.toLowerCase();
  const isCancelled =
    lower.includes('user cancelled') ||
    lower.includes('user canceled') ||
    lower.includes('chooser cancelled') ||
    lower.includes('chooser canceled');
  return { message, isCancelled };
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
 * - Dedicated CSC Cadence Sensors (Service 0x1816 / Characteristic 0x2A5B)
 * - Cycling Power Meters with crank cadence (Service 0x1818 / Characteristic 0x2A63)
 * Every GATT step is wrapped in 8s timeout + up to 3 retries.
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
  private coastTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private userInitiatedDisconnect = false;

  private telemetryListeners = new Set<(data: CadenceTelemetry) => void>();
  private statusListeners = new Set<(status: CadenceStatusSnapshot) => void>();

  private handleDisconnected = () => {
    this.cleanupCharacteristics();
    this.emitTelemetry(0);

    if (this.userInitiatedDisconnect || !this.device) {
      this.cleanupDevice();
      this.emitStatus({
        status: 'disconnected',
        signalStrength: 0,
      });
      return;
    }

    this.reconnectAttempt = 0;
    this.emitStatus({
      status: 'reconnecting',
      signalStrength: 0,
      errorMessage: 'Cadence sensor disconnected. Reconnecting…',
    });
    this.scheduleReconnect();
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
        errorMessage:
          'Web Bluetooth API is unavailable in this browser. Use Chrome or Edge over HTTPS/localhost.',
      });
      return;
    }

    this.clearReconnectTimer();
    this.userInitiatedDisconnect = false;

    try {
      this.emitStatus({ status: 'connecting', errorMessage: null });
      const device = await bt.requestDevice({
        filters: [{ services: [SERVICE_CSC] }, { services: [SERVICE_CYCLING_POWER] }],
        optionalServices: [SERVICE_CSC, SERVICE_CYCLING_POWER, SERVICE_DEVICE_INFO],
      });
      await this.attachToDevice(device);
    } catch (err) {
      this.cleanupCharacteristics();
      this.cleanupDevice();
      const { message, isCancelled } = formatBluetoothError(
        err,
        'Failed to pair Bluetooth cadence sensor.'
      );
      this.emitStatus({
        status: 'disconnected',
        signalStrength: 0,
        errorMessage: isCancelled ? null : message,
      });
    }
  }

  async connectExistingDevice(device: BleDeviceLike, silent = true): Promise<boolean> {
    this.clearReconnectTimer();
    this.userInitiatedDisconnect = false;
    try {
      this.emitStatus({
        status: silent ? 'reconnecting' : 'connecting',
        deviceId: device.id,
        deviceName: device.name || this.status.deviceName || 'BLE Cadence Sensor',
        errorMessage: null,
      });
      await waitForBleAdvertisement(device, 3500);
      await this.attachToDevice(device);
      return true;
    } catch (err) {
      this.cleanupCharacteristics();
      const { message } = formatBluetoothError(
        err,
        'Could not reconnect to saved Bluetooth cadence sensor.'
      );
      this.emitStatus({
        status: 'disconnected',
        signalStrength: 0,
        errorMessage: silent ? null : message,
      });
      return false;
    }
  }

  private async attachToDevice(device: BleDeviceLike): Promise<void> {
    if (!device.gatt) {
      throw new Error('Selected Bluetooth device does not expose a GATT server.');
    }

    if (this.device !== device) {
      this.cleanupDevice();
      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnected);
    }

    const gatt = device.gatt;
    const server = await withBluetoothRetry(() => gatt.connect(), {
      stepLabel: 'Cadence gatt.connect',
      timeoutMs: BLE_CONNECT_TIMEOUT_MS,
      maxAttempts: BLE_MAX_RETRIES,
    });

    let char: BleCharacteristicLike | null = null;
    let cscErr: unknown = null;

    try {
      const cscService = await withBluetoothRetry(() => server.getPrimaryService(SERVICE_CSC), {
        stepLabel: 'Cadence getPrimaryService(0x1816)',
        timeoutMs: BLE_CONNECT_TIMEOUT_MS,
        maxAttempts: BLE_MAX_RETRIES,
      });
      char = await withBluetoothRetry(() => cscService.getCharacteristic(CHAR_CSC_MEASUREMENT), {
        stepLabel: 'Cadence getCharacteristic(0x2A5B)',
        timeoutMs: BLE_CONNECT_TIMEOUT_MS,
        maxAttempts: BLE_MAX_RETRIES,
      });
      this.mode = 'csc';
    } catch (err) {
      cscErr = err;
      try {
        const cpService = await withBluetoothRetry(
          () => server.getPrimaryService(SERVICE_CYCLING_POWER),
          {
            stepLabel: 'Cadence getPrimaryService(0x1818)',
            timeoutMs: BLE_CONNECT_TIMEOUT_MS,
            maxAttempts: BLE_MAX_RETRIES,
          }
        );
        char = await withBluetoothRetry(
          () => cpService.getCharacteristic(CHAR_CYCLING_POWER_MEASUREMENT),
          {
            stepLabel: 'Cadence getCharacteristic(0x2A63)',
            timeoutMs: BLE_CONNECT_TIMEOUT_MS,
            maxAttempts: BLE_MAX_RETRIES,
          }
        );
        this.mode = 'power';
      } catch (cpErr) {
        const detail =
          cpErr instanceof Error
            ? cpErr.message
            : cscErr instanceof Error
              ? cscErr.message
              : 'CSC (0x1816) and Cycling Power (0x1818) services not found.';
        throw new Error(`Cadence service unavailable: ${detail}`);
      }
    }

    this.crankState = createCrankRevState();
    this.lastRpm = 0;
    this.lastCrankEventMs = Date.now();

    this.characteristic = char;
    this.characteristic.addEventListener('characteristicvaluechanged', this.handleNotification);
    await withBluetoothRetry(() => char!.startNotifications(), {
      stepLabel: 'Cadence startNotifications',
      timeoutMs: BLE_CONNECT_TIMEOUT_MS,
      maxAttempts: BLE_MAX_RETRIES,
    });

    this.reconnectAttempt = 0;
    this.startCoastWatchdog();
    this.emitStatus({
      status: 'connected',
      deviceId: device.id,
      deviceName: device.name || 'BLE Cadence Sensor',
      signalStrength: 92,
      errorMessage: null,
    });
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const targetDevice = this.device;
    if (!targetDevice || this.userInitiatedDisconnect) return;

    const delayMs = computeReconnectBackoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.device || this.userInitiatedDisconnect) return;
      void (async () => {
        try {
          await waitForBleAdvertisement(targetDevice, Math.min(3000, delayMs));
          await this.attachToDevice(targetDevice);
        } catch (err) {
          if (this.userInitiatedDisconnect || !this.device) return;
          const { message } = formatBluetoothError(err, 'Reconnect attempt failed.');
          this.emitStatus({
            status: 'reconnecting',
            signalStrength: 0,
            errorMessage: `Cadence reconnect retry #${this.reconnectAttempt}: ${message}`,
          });
          this.scheduleReconnect();
        }
      })();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async disconnect(): Promise<void> {
    this.userInitiatedDisconnect = true;
    this.clearReconnectTimer();
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanupCharacteristics();
    this.cleanupDevice();
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
    this.coastTimer = setInterval(() => {
      const nowMs = Date.now();
      if (this.lastRpm > 0 && nowMs - this.lastCrankEventMs >= 2800) {
        this.lastRpm = 0;
        this.emitTelemetry(0, nowMs);
      }
    }, 500);
  }

  private stopCoastWatchdog(): void {
    if (this.coastTimer !== null) {
      clearInterval(this.coastTimer);
      this.coastTimer = null;
    }
  }

  private cleanupCharacteristics(): void {
    this.stopCoastWatchdog();
    if (this.characteristic) {
      this.characteristic.removeEventListener(
        'characteristicvaluechanged',
        this.handleNotification
      );
      this.characteristic = null;
    }
    this.crankState = createCrankRevState();
    this.lastRpm = 0;
  }

  private cleanupDevice(): void {
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected);
      this.device = null;
    }
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

interface PendingControlPointWaiter {
  requestOpCode: number;
  resolve: (resp: FtmsControlPointResponse) => void;
}

/**
 * Real Web Bluetooth Smart Trainer over FTMS (Service 0x1826) with automatic
 * fallback to Cycling Power (Service 0x1818) when FTMS is missing.
 * - Every GATT step wrapped in 8s timeout + up to 3 retries
 * - Coalescing ERG queue (4s per-write timeout, drops stale target power commands)
 * - Listens on FTMS Control Point (0x2AD9) for 0x80 Response Code indications
 * - Sets ergControlActive ONLY when Request Control (0x00) returns 0x01 Success
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
  private cyclingPowerChar: BleCharacteristicLike | null = null;
  private controlPointChar: BleCharacteristicLike | null = null;
  private cpCrankState: CrankRevState = createCrankRevState();
  private powerMode: 'ftms' | 'cycling-power' = 'ftms';
  private lastPower = 0;
  private lastCadence = 0;
  private lastSpeed = 0;

  private ergQueue: CoalescingErgQueue;
  private controlWaiters: PendingControlPointWaiter[] = [];

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private userInitiatedDisconnect = false;

  private telemetryListeners = new Set<(data: TrainerTelemetry) => void>();
  private statusListeners = new Set<(status: TrainerStatusSnapshot) => void>();
  private reconnectListeners = new Set<() => void>();
  private writeLatencyListeners = new Set<(latencyMs: number) => void>();

  constructor(options?: { writeTimeoutMs?: number; maxRetries?: number; retryDelayMs?: number }) {
    this.ergQueue = new CoalescingErgQueue({
      writeTimeoutMs: options?.writeTimeoutMs ?? BLE_WRITE_TIMEOUT_MS,
      maxRetries: options?.maxRetries ?? BLE_MAX_RETRIES,
      retryDelayMs: options?.retryDelayMs ?? 120,
      onWriteLatency: (latencyMs) => {
        for (const cb of this.writeLatencyListeners) {
          cb(latencyMs);
        }
      },
    });
  }

  onErgWriteLatency(listener: (latencyMs: number) => void): () => void {
    this.writeLatencyListeners.add(listener);
    return () => this.writeLatencyListeners.delete(listener);
  }

  getPowerMode(): 'ftms' | 'cycling-power' {
    return this.powerMode;
  }

  private handleDisconnected = () => {
    this.cleanupCharacteristics();

    if (this.userInitiatedDisconnect || !this.device) {
      this.cleanupDevice();
      this.emitStatus({
        status: 'disconnected',
        ergControlActive: false,
        signalStrength: 0,
      });
      return;
    }

    this.reconnectAttempt = 0;
    this.emitStatus({
      status: 'reconnecting',
      ergControlActive: false,
      signalStrength: 0,
      ergControlWarning: 'Trainer connection dropped. Reconnecting automatically…',
    });
    this.scheduleReconnect();
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

    this.emitTrainerTelemetry();
  };

  private handleCyclingPowerData = (event: Event) => {
    const target = event.target as unknown as BleCharacteristicLike | null;
    const value = target?.value;
    if (!value) return;

    const parsed = parseCyclingPowerMeasurement(value, this.cpCrankState);
    this.cpCrankState = parsed.cadence.nextState;
    if (parsed.instantPowerW !== null) this.lastPower = parsed.instantPowerW;
    if (parsed.cadence.newEvent && parsed.cadence.rpm !== null) {
      this.lastCadence = parsed.cadence.rpm;
    }
    this.lastSpeed = powerToSpeedKmh(this.lastPower);

    this.emitTrainerTelemetry();
  };

  private emitTrainerTelemetry(): void {
    const payload: TrainerTelemetry = {
      instantPower: this.lastPower,
      cadence: this.lastCadence,
      speedKmh: this.lastSpeed,
      timestampMs: Date.now(),
    };
    for (const listener of this.telemetryListeners) {
      listener(payload);
    }
  }

  private handleControlPointResponse = (event: Event) => {
    const target = event.target as unknown as BleCharacteristicLike | null;
    const value = target?.value;
    if (!value) return;

    const resp = parseFtmsControlPointResponse(value);
    if (!resp) return;

    // Update ERG status strictly from FTMS 0x80 responses
    if (resp.controlNotPermitted) {
      this.emitStatus({
        ergControlActive: false,
        ergControlWarning: CONTROL_NOT_PERMITTED_MESSAGE,
      });
    } else if (resp.requestOpCode === FTMS_OP_REQUEST_CONTROL) {
      this.emitStatus({
        ergControlActive: resp.success,
        ergControlWarning: resp.success ? null : resp.errorMessage,
      });
    } else if (!resp.success && resp.errorMessage) {
      this.emitStatus({
        ergControlWarning: resp.errorMessage,
      });
    }

    // Resolve any pending waiter matching this requestOpCode
    const idx = this.controlWaiters.findIndex((w) => w.requestOpCode === resp.requestOpCode);
    if (idx !== -1) {
      const [waiter] = this.controlWaiters.splice(idx, 1);
      waiter.resolve(resp);
    }
  };

  private waitForControlPointResponse(
    requestOpCode: number,
    timeoutMs = BLE_WRITE_TIMEOUT_MS
  ): Promise<FtmsControlPointResponse> {
    let waiterRef: PendingControlPointWaiter | null = null;
    const promise = new Promise<FtmsControlPointResponse>((resolve) => {
      waiterRef = { requestOpCode, resolve };
      this.controlWaiters.push(waiterRef);
    });

    return withBluetoothTimeout(
      promise,
      timeoutMs,
      `FTMS Control Point 0x80 response for opCode 0x${requestOpCode.toString(16)}`
    ).finally(() => {
      if (waiterRef) {
        const idx = this.controlWaiters.indexOf(waiterRef);
        if (idx !== -1) this.controlWaiters.splice(idx, 1);
      }
    });
  }

  getStatus(): TrainerStatusSnapshot {
    return { ...this.status };
  }

  onReconnected(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
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

    this.clearReconnectTimer();
    this.userInitiatedDisconnect = false;

    try {
      this.emitStatus({ status: 'connecting', ergControlWarning: null });
      // Never wrap requestDevice in a timeout (user chooser stays open as long as needed)
      const device = await bt.requestDevice({
        filters: [{ services: [SERVICE_FTMS] }, { services: [SERVICE_CYCLING_POWER] }],
        optionalServices: [SERVICE_FTMS, SERVICE_CYCLING_POWER, SERVICE_DEVICE_INFO],
      });
      await this.attachToDevice(device, false);
    } catch (err) {
      this.cleanupCharacteristics();
      this.cleanupDevice();
      const { message, isCancelled } = formatBluetoothError(
        err,
        'Failed to connect to Bluetooth smart trainer.'
      );
      this.emitStatus({
        status: 'disconnected',
        ergControlActive: false,
        signalStrength: 0,
        ergControlWarning: isCancelled ? null : message,
      });
    }
  }

  async connectExistingDevice(device: BleDeviceLike, silent = true): Promise<boolean> {
    this.clearReconnectTimer();
    this.userInitiatedDisconnect = false;
    try {
      this.emitStatus({
        status: silent ? 'reconnecting' : 'connecting',
        deviceId: device.id,
        deviceName: device.name || this.status.deviceName || 'FTMS Smart Trainer',
        ergControlWarning: null,
      });
      await waitForBleAdvertisement(device, 4000);
      await this.attachToDevice(device, false);
      return true;
    } catch (err) {
      this.cleanupCharacteristics();
      const { message } = formatBluetoothError(
        err,
        'Could not reconnect to saved Bluetooth trainer.'
      );
      this.emitStatus({
        status: 'disconnected',
        ergControlActive: false,
        signalStrength: 0,
        ergControlWarning: silent ? null : message,
      });
      return false;
    }
  }

  /**
   * Exposed for deterministic unit testing and internal GATT attach.
   */
  async attachToDevice(device: BleDeviceLike, isReconnect: boolean): Promise<void> {
    if (!device.gatt) {
      throw new Error('Selected trainer does not expose a GATT server.');
    }

    if (this.device !== device) {
      this.cleanupDevice();
      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnected);
    }

    const gatt = device.gatt;
    const server = await withBluetoothRetry(() => gatt.connect(), {
      stepLabel: 'Trainer gatt.connect',
      timeoutMs: BLE_CONNECT_TIMEOUT_MS,
      maxAttempts: BLE_MAX_RETRIES,
    });

    let ftmsService: BleServiceLike | null = null;
    try {
      ftmsService = await withBluetoothRetry(() => server.getPrimaryService(SERVICE_FTMS), {
        stepLabel: 'Trainer getPrimaryService(FTMS 0x1826)',
        timeoutMs: BLE_CONNECT_TIMEOUT_MS,
        maxAttempts: BLE_MAX_RETRIES,
      });
    } catch {
      ftmsService = null;
    }

    if (ftmsService) {
      this.powerMode = 'ftms';
      const bikeData = await withBluetoothRetry(
        () => ftmsService!.getCharacteristic(CHAR_FTMS_INDOOR_BIKE_DATA),
        {
          stepLabel: 'Trainer getCharacteristic(0x2AD2)',
          timeoutMs: BLE_CONNECT_TIMEOUT_MS,
          maxAttempts: BLE_MAX_RETRIES,
        }
      );

      this.bikeDataChar = bikeData;
      this.bikeDataChar.addEventListener('characteristicvaluechanged', this.handleBikeData);
      await withBluetoothRetry(() => bikeData.startNotifications(), {
        stepLabel: 'Trainer startNotifications(0x2AD2)',
        timeoutMs: BLE_CONNECT_TIMEOUT_MS,
        maxAttempts: BLE_MAX_RETRIES,
      });

      try {
        const cp = await withBluetoothRetry(
          () => ftmsService!.getCharacteristic(CHAR_FTMS_CONTROL_POINT),
          {
            stepLabel: 'Trainer getCharacteristic(0x2AD9)',
            timeoutMs: BLE_CONNECT_TIMEOUT_MS,
            maxAttempts: BLE_MAX_RETRIES,
          }
        );
        this.controlPointChar = cp;
        this.controlPointChar.addEventListener(
          'characteristicvaluechanged',
          this.handleControlPointResponse
        );
        await withBluetoothRetry(() => cp.startNotifications(), {
          stepLabel: 'Trainer startNotifications(0x2AD9)',
          timeoutMs: BLE_CONNECT_TIMEOUT_MS,
          maxAttempts: BLE_MAX_RETRIES,
        });
      } catch {
        this.controlPointChar = null;
      }

      this.reconnectAttempt = 0;
      this.emitStatus({
        status: 'connected',
        deviceId: device.id,
        deviceName: device.name || 'FTMS Smart Trainer',
        signalStrength: 94,
        ergControlActive: false,
        ergControlWarning: this.controlPointChar
          ? null
          : 'Trainer FTMS Control Point (0x2AD9) unavailable; ERG control disabled.',
      });
    } else {
      // Fallback: Cycling Power Service (0x1818) when FTMS (0x1826) is missing
      const cpService = await withBluetoothRetry(
        () => server.getPrimaryService(SERVICE_CYCLING_POWER),
        {
          stepLabel: 'Trainer fallback getPrimaryService(Cycling Power 0x1818)',
          timeoutMs: BLE_CONNECT_TIMEOUT_MS,
          maxAttempts: BLE_MAX_RETRIES,
        }
      );
      const cpChar = await withBluetoothRetry(
        () => cpService.getCharacteristic(CHAR_CYCLING_POWER_MEASUREMENT),
        {
          stepLabel: 'Trainer fallback getCharacteristic(0x2A63)',
          timeoutMs: BLE_CONNECT_TIMEOUT_MS,
          maxAttempts: BLE_MAX_RETRIES,
        }
      );
      this.powerMode = 'cycling-power';
      this.cpCrankState = createCrankRevState();
      this.cyclingPowerChar = cpChar;
      this.cyclingPowerChar.addEventListener(
        'characteristicvaluechanged',
        this.handleCyclingPowerData
      );
      await withBluetoothRetry(() => cpChar.startNotifications(), {
        stepLabel: 'Trainer fallback startNotifications(0x2A63)',
        timeoutMs: BLE_CONNECT_TIMEOUT_MS,
        maxAttempts: BLE_MAX_RETRIES,
      });

      this.reconnectAttempt = 0;
      this.emitStatus({
        status: 'connected',
        deviceId: device.id,
        deviceName: device.name || 'Cycling Power Meter',
        signalStrength: 92,
        ergControlActive: false,
        ergControlWarning:
          'FTMS unavailable — connected via Cycling Power (0x1818) for live power (no ERG resistance control).',
      });
    }

    if (isReconnect) {
      for (const listener of this.reconnectListeners) {
        listener();
      }
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const targetDevice = this.device;
    if (!targetDevice || this.userInitiatedDisconnect) return;

    const delayMs = computeReconnectBackoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.device || this.userInitiatedDisconnect) return;
      void (async () => {
        try {
          await waitForBleAdvertisement(targetDevice, Math.min(3500, delayMs));
          await this.attachToDevice(targetDevice, true);
        } catch (err) {
          if (this.userInitiatedDisconnect || !this.device) return;
          const { message } = formatBluetoothError(err, 'Reconnect attempt failed.');
          this.emitStatus({
            status: 'reconnecting',
            ergControlActive: false,
            signalStrength: 0,
            ergControlWarning: `Trainer reconnecting (attempt #${this.reconnectAttempt}): ${message}`,
          });
          this.scheduleReconnect();
        }
      })();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async disconnect(): Promise<void> {
    this.userInitiatedDisconnect = true;
    this.clearReconnectTimer();
    this.ergQueue.clear();
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanupCharacteristics();
    this.cleanupDevice();
    this.emitStatus({
      status: 'disconnected',
      ergControlActive: false,
      signalStrength: 0,
    });
  }

  async requestControl(): Promise<boolean> {
    const char = this.controlPointChar;
    if (!char) {
      this.emitStatus({ ergControlActive: false });
      return false;
    }

    try {
      let response: FtmsControlPointResponse | null = null;
      await this.ergQueue.enqueueControl('FTMS requestControl(0x00)', async () => {
        const responsePromise = this.waitForControlPointResponse(
          FTMS_OP_REQUEST_CONTROL,
          BLE_WRITE_TIMEOUT_MS
        );
        await writeCharacteristic(char, new Uint8Array([FTMS_OP_REQUEST_CONTROL]));
        response = await responsePromise;
      });

      const resolved = response as FtmsControlPointResponse | null;
      if (resolved && resolved.success) {
        this.emitStatus({ ergControlActive: true, ergControlWarning: null });
        return true;
      }

      const warning = resolved?.controlNotPermitted
        ? CONTROL_NOT_PERMITTED_MESSAGE
        : resolved?.errorMessage ?? 'Unable to acquire FTMS ERG control.';
      this.emitStatus({ ergControlActive: false, ergControlWarning: warning });
      return false;
    } catch (err) {
      this.emitStatus({
        ergControlActive: false,
        ergControlWarning: err instanceof Error ? err.message : 'Unable to acquire FTMS ERG control.',
      });
      return false;
    }
  }

  async startResume(): Promise<void> {
    const char = this.controlPointChar;
    if (!char) return;
    try {
      await this.ergQueue.enqueueControl('FTMS startResume(0x07)', () =>
        writeCharacteristic(char, new Uint8Array([FTMS_OP_START_RESUME]))
      );
    } catch (err) {
      this.emitStatus({
        ergControlWarning: err instanceof Error ? err.message : 'FTMS start/resume write failed.',
      });
    }
  }

  async stopPause(): Promise<void> {
    const char = this.controlPointChar;
    if (!char) return;
    try {
      await this.ergQueue.enqueueControl('FTMS stopPause(0x08)', () =>
        writeCharacteristic(char, new Uint8Array([FTMS_OP_STOP_PAUSE, 0x02]))
      );
    } catch {
      // Ignore stop write timeouts on teardown
    }
  }

  async setTargetPower(watts: number): Promise<void> {
    const char = this.controlPointChar;
    if (!char) return;
    const clamped = Math.max(0, Math.min(2000, Math.round(watts)));
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, FTMS_OP_SET_TARGET_POWER);
    view.setInt16(1, clamped, true);
    const bytes = new Uint8Array(buf);

    try {
      await this.ergQueue.enqueueTargetPower(clamped, () => writeCharacteristic(char, bytes));
    } catch (err) {
      this.emitStatus({
        ergControlWarning: err instanceof Error ? err.message : 'FTMS target power write failed.',
      });
    }
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
    this.reconnectListeners.clear();
    this.writeLatencyListeners.clear();
  }

  private cleanupCharacteristics(): void {
    this.ergQueue.clear();
    this.controlWaiters = [];
    if (this.bikeDataChar) {
      this.bikeDataChar.removeEventListener('characteristicvaluechanged', this.handleBikeData);
      this.bikeDataChar = null;
    }
    if (this.cyclingPowerChar) {
      this.cyclingPowerChar.removeEventListener(
        'characteristicvaluechanged',
        this.handleCyclingPowerData
      );
      this.cyclingPowerChar = null;
    }
    if (this.controlPointChar) {
      this.controlPointChar.removeEventListener(
        'characteristicvaluechanged',
        this.handleControlPointResponse
      );
      this.controlPointChar = null;
    }
  }

  private cleanupDevice(): void {
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
 * Real Web Bluetooth Heart Rate Monitor (Service 0x180D / Characteristic 0x2A37)
 * with 8s timeouts, 3x retries, explicit error surfacing, and exponential backoff reconnect.
 */
export class WebBluetoothHeartRateDevice implements HeartRateDevice {
  readonly isSimulated = false;

  private status: HeartRateStatusSnapshot = {
    status: 'disconnected',
    deviceId: null,
    deviceName: null,
    signalStrength: 0,
    isSimulated: false,
    errorMessage: null,
  };

  private device: BleDeviceLike | null = null;
  private hrChar: BleCharacteristicLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private userInitiatedDisconnect = false;

  private telemetryListeners = new Set<(data: HeartRateTelemetry) => void>();
  private statusListeners = new Set<(status: HeartRateStatusSnapshot) => void>();

  private handleDisconnected = () => {
    this.cleanupCharacteristics();

    if (this.userInitiatedDisconnect || !this.device) {
      this.cleanupDevice();
      this.emitStatus({ status: 'disconnected', signalStrength: 0 });
      return;
    }

    this.reconnectAttempt = 0;
    this.emitStatus({
      status: 'reconnecting',
      signalStrength: 0,
      errorMessage: 'Heart rate monitor disconnected. Reconnecting…',
    });
    this.scheduleReconnect();
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
    if (!bt) {
      this.emitStatus({
        status: 'disconnected',
        signalStrength: 0,
        errorMessage:
          'Web Bluetooth API is unavailable in this browser. Use Chrome or Edge over HTTPS/localhost.',
      });
      return;
    }

    this.clearReconnectTimer();
    this.userInitiatedDisconnect = false;

    try {
      this.emitStatus({ status: 'connecting', errorMessage: null });
      const device = await bt.requestDevice({
        filters: [{ services: [SERVICE_HEART_RATE] }],
        optionalServices: [SERVICE_HEART_RATE, SERVICE_DEVICE_INFO],
      });
      await this.attachToDevice(device);
    } catch (err) {
      this.cleanupCharacteristics();
      this.cleanupDevice();
      const { message, isCancelled } = formatBluetoothError(
        err,
        'Failed to pair Bluetooth heart rate monitor.'
      );
      this.emitStatus({
        status: 'disconnected',
        signalStrength: 0,
        errorMessage: isCancelled ? null : message,
      });
    }
  }

  async connectExistingDevice(device: BleDeviceLike, silent = true): Promise<boolean> {
    this.clearReconnectTimer();
    this.userInitiatedDisconnect = false;
    try {
      this.emitStatus({
        status: silent ? 'reconnecting' : 'connecting',
        deviceId: device.id,
        deviceName: device.name || this.status.deviceName || 'BLE Heart Rate Monitor',
        errorMessage: null,
      });
      await waitForBleAdvertisement(device, 3500);
      await this.attachToDevice(device);
      return true;
    } catch (err) {
      this.cleanupCharacteristics();
      const { message } = formatBluetoothError(
        err,
        'Could not reconnect to saved Bluetooth heart rate monitor.'
      );
      this.emitStatus({
        status: 'disconnected',
        signalStrength: 0,
        errorMessage: silent ? null : message,
      });
      return false;
    }
  }

  private async attachToDevice(device: BleDeviceLike): Promise<void> {
    if (!device.gatt) {
      throw new Error('Selected HRM device does not expose a GATT server.');
    }

    if (this.device !== device) {
      this.cleanupDevice();
      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnected);
    }

    const gatt = device.gatt;
    const server = await withBluetoothRetry(() => gatt.connect(), {
      stepLabel: 'HRM gatt.connect',
      timeoutMs: BLE_CONNECT_TIMEOUT_MS,
      maxAttempts: BLE_MAX_RETRIES,
    });
    const service = await withBluetoothRetry(() => server.getPrimaryService(SERVICE_HEART_RATE), {
      stepLabel: 'HRM getPrimaryService(0x180D)',
      timeoutMs: BLE_CONNECT_TIMEOUT_MS,
      maxAttempts: BLE_MAX_RETRIES,
    });
    const char = await withBluetoothRetry(
      () => service.getCharacteristic(CHAR_HEART_RATE_MEASUREMENT),
      {
        stepLabel: 'HRM getCharacteristic(0x2A37)',
        timeoutMs: BLE_CONNECT_TIMEOUT_MS,
        maxAttempts: BLE_MAX_RETRIES,
      }
    );

    this.hrChar = char;
    this.hrChar.addEventListener('characteristicvaluechanged', this.handleHrValue);
    await withBluetoothRetry(() => char.startNotifications(), {
      stepLabel: 'HRM startNotifications(0x2A37)',
      timeoutMs: BLE_CONNECT_TIMEOUT_MS,
      maxAttempts: BLE_MAX_RETRIES,
    });

    this.reconnectAttempt = 0;
    this.emitStatus({
      status: 'connected',
      deviceId: device.id,
      deviceName: device.name || 'BLE Heart Rate Monitor',
      signalStrength: 95,
      errorMessage: null,
    });
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const targetDevice = this.device;
    if (!targetDevice || this.userInitiatedDisconnect) return;

    const delayMs = computeReconnectBackoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.device || this.userInitiatedDisconnect) return;
      void (async () => {
        try {
          await waitForBleAdvertisement(targetDevice, Math.min(3000, delayMs));
          await this.attachToDevice(targetDevice);
        } catch (err) {
          if (this.userInitiatedDisconnect || !this.device) return;
          const { message } = formatBluetoothError(err, 'Reconnect attempt failed.');
          this.emitStatus({
            status: 'reconnecting',
            signalStrength: 0,
            errorMessage: `HRM reconnect retry #${this.reconnectAttempt}: ${message}`,
          });
          this.scheduleReconnect();
        }
      })();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async disconnect(): Promise<void> {
    this.userInitiatedDisconnect = true;
    this.clearReconnectTimer();
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanupCharacteristics();
    this.cleanupDevice();
    this.emitStatus({ status: 'disconnected', signalStrength: 0, errorMessage: null });
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

  private cleanupCharacteristics(): void {
    if (this.hrChar) {
      this.hrChar.removeEventListener('characteristicvaluechanged', this.handleHrValue);
      this.hrChar = null;
    }
  }

  private cleanupDevice(): void {
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
