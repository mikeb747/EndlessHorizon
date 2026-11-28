export type DeviceConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface SavedDeviceRecord {
  id: string;
  name: string;
  lastConnectedAt: number;
  role?: 'trainer' | 'hr' | 'cadence';
}

export interface TrainerTelemetry {
  instantPower: number; // Watts
  cadence: number; // RPM
  speedKmh: number; // Virtual km/h
  timestampMs: number;
}

export type CadenceSource = 'ble-cadence' | 'ble-trainer' | 'simulated' | 'none';

export interface HeartRateTelemetry {
  heartRate: number; // BPM
  timestampMs: number;
}

export interface CadenceTelemetry {
  cadenceRpm: number; // RPM (exact sensor RPM, supports fractional precision)
  timestampMs: number;
}

export interface TrainerStatusSnapshot {
  status: DeviceConnectionStatus;
  deviceId: string | null;
  deviceName: string | null;
  ergControlActive: boolean;
  ergControlWarning: string | null;
  signalStrength: number; // 0..100
  isSimulated: boolean;
}

export interface HeartRateStatusSnapshot {
  status: DeviceConnectionStatus;
  deviceId: string | null;
  deviceName: string | null;
  signalStrength: number; // 0..100
  isSimulated: boolean;
  errorMessage: string | null;
}

export interface CadenceStatusSnapshot {
  status: DeviceConnectionStatus;
  deviceId: string | null;
  deviceName: string | null;
  signalStrength: number; // 0..100
  isSimulated: boolean;
  errorMessage: string | null;
}

/**
 * Hardware-agnostic Smart Trainer interface (FTMS / ERG).
 * Supports both SimulatedTrainer and WebBluetoothTrainerDevice (FTMS 0x1826).
 */
export interface TrainerDevice {
  readonly isSimulated: boolean;
  getStatus(): TrainerStatusSnapshot;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  requestControl(): Promise<boolean>;
  startResume(): Promise<void>;
  stopPause(): Promise<void>;
  setTargetPower(watts: number): Promise<void>;
  onTelemetry(listener: (data: TrainerTelemetry) => void): () => void;
  onStatusChange(listener: (status: TrainerStatusSnapshot) => void): () => void;
  dispose(): void;
}

/**
 * Hardware-agnostic Heart Rate Monitor interface (BLE Service 0x180D / 0x2A37).
 * Supports both SimulatedHeartRate and WebBluetoothHeartRateDevice.
 */
export interface HeartRateDevice {
  readonly isSimulated: boolean;
  getStatus(): HeartRateStatusSnapshot;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onTelemetry(listener: (data: HeartRateTelemetry) => void): () => void;
  onStatusChange(listener: (status: HeartRateStatusSnapshot) => void): () => void;
  dispose(): void;
}

/**
 * Hardware-agnostic Cadence Sensor interface (BLE CSC 0x1816 / 0x2A5B or CP 0x1818 / 0x2A63).
 * Used for 1:1 3D cyclist model cadence matching and live HUD/FIT cadence recording.
 */
export interface CadenceDevice {
  readonly isSimulated: boolean;
  getStatus(): CadenceStatusSnapshot;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onTelemetry(listener: (data: CadenceTelemetry) => void): () => void;
  onStatusChange(listener: (status: CadenceStatusSnapshot) => void): () => void;
  dispose(): void;
}
