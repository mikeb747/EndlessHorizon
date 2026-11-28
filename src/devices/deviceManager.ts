import {
  loadSavedDevices,
  removeSavedDevice,
  runTrainerReconnectRecovery,
  saveSavedDevices,
  SavedDeviceRole,
  upsertSavedDevice,
} from './devicePersistence';
import { SimulatedHeartRate, SimulatedTrainer } from './simulatedDevices';
import {
  CadenceDevice,
  CadenceStatusSnapshot,
  CadenceTelemetry,
  HeartRateDevice,
  HeartRateStatusSnapshot,
  HeartRateTelemetry,
  SavedDeviceRecord,
  TrainerDevice,
  TrainerStatusSnapshot,
  TrainerTelemetry,
} from './types';
import {
  getGrantedBluetoothDevices,
  isSilentBleReconnectSupported,
  WebBluetoothCadenceDevice,
  WebBluetoothHeartRateDevice,
  WebBluetoothTrainerDevice,
} from './webBluetoothDevices';

export interface DeviceManagerCallbacks {
  onTrainerTelemetry: (data: TrainerTelemetry) => void;
  onTrainerStatus: (status: TrainerStatusSnapshot) => void;
  onHeartRateTelemetry: (data: HeartRateTelemetry) => void;
  onHeartRateStatus: (status: HeartRateStatusSnapshot) => void;
  onCadenceTelemetry: (data: CadenceTelemetry) => void;
  onCadenceStatus: (status: CadenceStatusSnapshot) => void;
  onSavedDevicesChange?: (devices: SavedDeviceRecord[]) => void;
  getFtp: () => number;
  getRecoveryErgState?: () => { isRunning: boolean; targetWatts: number | null };
}

/**
 * Central device coordinator. All UI and workout engine calls go through this
 * manager and the TrainerDevice / HeartRateDevice / CadenceDevice interfaces.
 * Supports simulated devices as well as real Web Bluetooth FTMS trainers,
 * BLE Heart Rate Monitors (0x180D), and BLE Cadence Sensors (CSC 0x1816 / CP 0x1818),
 * plus remembered device persistence and silent/manual auto-reconnection.
 */
export class DeviceManager {
  private callbacks: DeviceManagerCallbacks;
  private trainer: TrainerDevice;
  private hrMonitor: HeartRateDevice;
  private cadenceSensor: CadenceDevice;

  private simTrainer: SimulatedTrainer;
  private simHr: SimulatedHeartRate;
  private bleTrainer: WebBluetoothTrainerDevice;
  private bleHr: WebBluetoothHeartRateDevice;
  private bleCadence: WebBluetoothCadenceDevice;

  private trainerUnsubs: Array<() => void> = [];
  private hrUnsubs: Array<() => void> = [];
  private cadenceUnsubs: Array<() => void> = [];
  private trainerReconnectUnsub: (() => void) | null = null;

  private savedDevices: SavedDeviceRecord[] = [];
  private lastErgTargetWatts: number | null = null;
  private trainerSessionActive = false;
  private lastErgWriteLatencyMs = 0;

  constructor(callbacks: DeviceManagerCallbacks) {
    this.callbacks = callbacks;
    this.savedDevices = loadSavedDevices();

    this.simTrainer = new SimulatedTrainer();
    this.simHr = new SimulatedHeartRate(() => {
      const ftp = Math.max(100, callbacks.getFtp());
      return this.simTrainer.getInstantPower() / ftp;
    });
    this.bleTrainer = new WebBluetoothTrainerDevice();
    this.bleHr = new WebBluetoothHeartRateDevice();
    this.bleCadence = new WebBluetoothCadenceDevice();

    this.trainerReconnectUnsub = this.bleTrainer.onReconnected(() => {
      void this.handleBleTrainerReconnected();
    });

    this.trainer = this.simTrainer;
    this.hrMonitor = this.simHr;
    this.cadenceSensor = this.bleCadence;

    this.bindTrainer(this.trainer);
    this.bindHeartRate(this.hrMonitor);
    this.bindCadence(this.cadenceSensor);
    this.callbacks.onSavedDevicesChange?.(this.getSavedDevices());
  }

  private async handleBleTrainerReconnected(): Promise<void> {
    if (this.trainer !== this.bleTrainer) return;
    const external = this.callbacks.getRecoveryErgState?.();
    const shouldResume = external ? external.isRunning : this.trainerSessionActive;
    const targetWatts = external?.targetWatts ?? this.lastErgTargetWatts;
    await runTrainerReconnectRecovery(this.bleTrainer, targetWatts, shouldResume);
  }

  private rememberDevice(role: SavedDeviceRole, id: string | null, name: string | null): void {
    if (!id) return;
    const record: SavedDeviceRecord = {
      id,
      name: name || (role === 'trainer' ? 'FTMS Smart Trainer' : role === 'hr' ? 'BLE Heart Rate Monitor' : 'BLE Cadence Sensor'),
      lastConnectedAt: Date.now(),
      role,
    };
    this.savedDevices = upsertSavedDevice(this.savedDevices, record);
    saveSavedDevices(this.savedDevices);
    this.callbacks.onSavedDevicesChange?.(this.getSavedDevices());
  }

  private bindTrainer(device: TrainerDevice): void {
    this.trainerUnsubs.forEach((fn) => fn());
    this.trainerUnsubs = [
      device.onTelemetry(this.callbacks.onTrainerTelemetry),
      device.onStatusChange(this.callbacks.onTrainerStatus),
    ];
    this.callbacks.onTrainerStatus(device.getStatus());
  }

  private bindHeartRate(device: HeartRateDevice): void {
    this.hrUnsubs.forEach((fn) => fn());
    this.hrUnsubs = [
      device.onTelemetry(this.callbacks.onHeartRateTelemetry),
      device.onStatusChange(this.callbacks.onHeartRateStatus),
    ];
    this.callbacks.onHeartRateStatus(device.getStatus());
  }

  private bindCadence(device: CadenceDevice): void {
    this.cadenceUnsubs.forEach((fn) => fn());
    this.cadenceUnsubs = [
      device.onTelemetry(this.callbacks.onCadenceTelemetry),
      device.onStatusChange(this.callbacks.onCadenceStatus),
    ];
    this.callbacks.onCadenceStatus(device.getStatus());
  }

  getTrainer(): TrainerDevice {
    return this.trainer;
  }

  getHeartRateMonitor(): HeartRateDevice {
    return this.hrMonitor;
  }

  getCadenceSensor(): CadenceDevice {
    return this.cadenceSensor;
  }

  getSavedDevices(): SavedDeviceRecord[] {
    return this.savedDevices.map((d) => ({ ...d }));
  }

  isSilentAutoReconnectAvailable(): boolean {
    return isSilentBleReconnectSupported();
  }

  forgetSavedDevice(deviceId: string): void {
    this.savedDevices = removeSavedDevice(this.savedDevices, deviceId);
    saveSavedDevices(this.savedDevices);
    this.callbacks.onSavedDevicesChange?.(this.getSavedDevices());
  }

  /**
   * Startup silent auto-reconnect using navigator.bluetooth.getDevices() + watchAdvertisements().
   * Only connects devices the user previously paired and remembered in localStorage.
   */
  async attemptSilentAutoReconnect(): Promise<{ trainer: boolean; hr: boolean; cadence: boolean }> {
    const result = { trainer: false, hr: false, cadence: false };
    if (this.savedDevices.length === 0 || !isSilentBleReconnectSupported()) {
      return result;
    }

    const granted = await getGrantedBluetoothDevices();
    if (granted.length === 0) return result;
    const byId = new Map(granted.map((d) => [d.id, d]));

    const savedTrainer = this.savedDevices.find((d) => d.role === 'trainer');
    const savedHr = this.savedDevices.find((d) => d.role === 'hr');
    const savedCadence = this.savedDevices.find((d) => d.role === 'cadence');

    const tasks: Array<Promise<void>> = [];

    if (savedTrainer && byId.has(savedTrainer.id)) {
      const bleDev = byId.get(savedTrainer.id)!;
      tasks.push(
        (async () => {
          if (this.trainer !== this.bleTrainer) {
            await this.trainer.disconnect();
            this.trainer = this.bleTrainer;
            this.bindTrainer(this.trainer);
          }
          const ok = await this.bleTrainer.connectExistingDevice(bleDev, true);
          if (ok) {
            await this.bleTrainer.requestControl();
            this.rememberDevice('trainer', bleDev.id, bleDev.name || savedTrainer.name);
            result.trainer = true;
          }
        })()
      );
    }

    if (savedHr && byId.has(savedHr.id)) {
      const bleDev = byId.get(savedHr.id)!;
      tasks.push(
        (async () => {
          if (this.hrMonitor !== this.bleHr) {
            await this.hrMonitor.disconnect();
            this.hrMonitor = this.bleHr;
            this.bindHeartRate(this.hrMonitor);
          }
          const ok = await this.bleHr.connectExistingDevice(bleDev, true);
          if (ok) {
            this.rememberDevice('hr', bleDev.id, bleDev.name || savedHr.name);
            result.hr = true;
          }
        })()
      );
    }

    if (savedCadence && byId.has(savedCadence.id)) {
      const bleDev = byId.get(savedCadence.id)!;
      tasks.push(
        (async () => {
          const ok = await this.bleCadence.connectExistingDevice(bleDev, true);
          if (ok) {
            this.rememberDevice('cadence', bleDev.id, bleDev.name || savedCadence.name);
            result.cadence = true;
          }
        })()
      );
    }

    await Promise.all(tasks);
    return result;
  }

  /**
   * User-triggered "Reconnect last devices" action.
   * Uses silent getDevices() when available; falls back to BLE device chooser for any
   * remembered device role not yet connected when getDevices() is unavailable.
   */
  async reconnectLastDevices(): Promise<{ trainer: boolean; hr: boolean; cadence: boolean }> {
    const result = await this.attemptSilentAutoReconnect();
    const savedTrainer = this.savedDevices.find((d) => d.role === 'trainer');
    const savedHr = this.savedDevices.find((d) => d.role === 'hr');
    const savedCadence = this.savedDevices.find((d) => d.role === 'cadence');

    if (savedTrainer && !result.trainer && this.bleTrainer.getStatus().status !== 'connected') {
      result.trainer = await this.connectBleTrainer();
    }
    if (savedHr && !result.hr && this.bleHr.getStatus().status !== 'connected') {
      result.hr = await this.connectBleHeartRate();
    }
    if (savedCadence && !result.cadence && this.bleCadence.getStatus().status !== 'connected') {
      result.cadence = await this.connectBleCadence();
    }

    return result;
  }

  async connectAllSimulated(): Promise<void> {
    if (this.trainer !== this.simTrainer) {
      await this.trainer.disconnect();
      this.trainer = this.simTrainer;
      this.bindTrainer(this.trainer);
    }
    if (this.hrMonitor !== this.simHr) {
      await this.hrMonitor.disconnect();
      this.hrMonitor = this.simHr;
      this.bindHeartRate(this.hrMonitor);
    }
    await Promise.all([this.trainer.connect(), this.hrMonitor.connect()]);
    await this.trainer.requestControl();
  }

  async connectBleTrainer(): Promise<boolean> {
    if (this.trainer !== this.bleTrainer) {
      await this.trainer.disconnect();
      this.trainer = this.bleTrainer;
      this.bindTrainer(this.trainer);
    }
    await this.bleTrainer.connect();
    const st = this.bleTrainer.getStatus();
    if (st.status === 'connected') {
      this.rememberDevice('trainer', st.deviceId, st.deviceName);
      await this.bleTrainer.requestControl();
      return true;
    }
    return false;
  }

  async connectBleHeartRate(): Promise<boolean> {
    if (this.hrMonitor !== this.bleHr) {
      await this.hrMonitor.disconnect();
      this.hrMonitor = this.bleHr;
      this.bindHeartRate(this.hrMonitor);
    }
    await this.bleHr.connect();
    const st = this.bleHr.getStatus();
    if (st.status === 'connected') {
      this.rememberDevice('hr', st.deviceId, st.deviceName);
      return true;
    }
    return false;
  }

  async connectBleCadence(): Promise<boolean> {
    await this.bleCadence.connect();
    const st = this.bleCadence.getStatus();
    if (st.status === 'connected') {
      this.rememberDevice('cadence', st.deviceId, st.deviceName);
      return true;
    }
    return false;
  }

  async disconnectCadence(): Promise<void> {
    await this.cadenceSensor.disconnect();
  }

  async disconnectAll(): Promise<void> {
    this.trainerSessionActive = false;
    await Promise.all([
      this.trainer.disconnect(),
      this.hrMonitor.disconnect(),
      this.cadenceSensor.disconnect(),
    ]);
  }

  getLastErgWriteLatencyMs(): number {
    return this.lastErgWriteLatencyMs;
  }

  async sendErgTarget(watts: number, stepChangedAtMs?: number): Promise<void> {
    this.lastErgTargetWatts = Math.max(0, Math.round(watts));
    if (this.trainer.getStatus().status === 'connected') {
      const startMs = stepChangedAtMs ?? Date.now();
      await this.trainer.setTargetPower(this.lastErgTargetWatts);
      this.lastErgWriteLatencyMs = Math.max(0, Date.now() - startMs);
    }
  }

  async startTrainer(): Promise<void> {
    this.trainerSessionActive = true;
    if (this.trainer.getStatus().status === 'connected') {
      await this.trainer.startResume();
    }
  }

  async pauseTrainer(): Promise<void> {
    this.trainerSessionActive = false;
    if (this.trainer.getStatus().status === 'connected') {
      await this.trainer.setTargetPower(50);
      await this.trainer.stopPause();
    }
  }

  async stopTrainer(): Promise<void> {
    this.trainerSessionActive = false;
    if (this.trainer.getStatus().status === 'connected') {
      await this.trainer.stopPause();
    }
  }

  dispose(): void {
    this.trainerUnsubs.forEach((fn) => fn());
    this.hrUnsubs.forEach((fn) => fn());
    this.cadenceUnsubs.forEach((fn) => fn());
    this.trainerReconnectUnsub?.();
    this.trainerUnsubs = [];
    this.hrUnsubs = [];
    this.cadenceUnsubs = [];
    this.trainerReconnectUnsub = null;
    this.simTrainer.dispose();
    this.simHr.dispose();
    this.bleTrainer.dispose();
    this.bleHr.dispose();
    this.bleCadence.dispose();
  }
}
