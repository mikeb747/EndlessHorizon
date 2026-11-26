import { SimulatedHeartRate, SimulatedTrainer } from './simulatedDevices';
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
import {
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
  getFtp: () => number;
}

/**
 * Central device coordinator. All UI and workout engine calls go through this
 * manager and the TrainerDevice / HeartRateDevice / CadenceDevice interfaces.
 * Supports simulated devices as well as real Web Bluetooth FTMS trainers,
 * BLE Heart Rate Monitors (0x180D), and BLE Cadence Sensors (CSC 0x1816 / CP 0x1818).
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

  constructor(callbacks: DeviceManagerCallbacks) {
    this.callbacks = callbacks;
    this.simTrainer = new SimulatedTrainer();
    this.simHr = new SimulatedHeartRate(() => {
      const ftp = Math.max(100, callbacks.getFtp());
      return this.simTrainer.getInstantPower() / ftp;
    });
    this.bleTrainer = new WebBluetoothTrainerDevice();
    this.bleHr = new WebBluetoothHeartRateDevice();
    this.bleCadence = new WebBluetoothCadenceDevice();

    this.trainer = this.simTrainer;
    this.hrMonitor = this.simHr;
    this.cadenceSensor = this.bleCadence;

    this.bindTrainer(this.trainer);
    this.bindHeartRate(this.hrMonitor);
    this.bindCadence(this.cadenceSensor);
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
    if (this.bleTrainer.getStatus().status === 'connected') {
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
    return this.bleHr.getStatus().status === 'connected';
  }

  async connectBleCadence(): Promise<boolean> {
    await this.bleCadence.connect();
    return this.bleCadence.getStatus().status === 'connected';
  }

  async disconnectCadence(): Promise<void> {
    await this.cadenceSensor.disconnect();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([
      this.trainer.disconnect(),
      this.hrMonitor.disconnect(),
      this.cadenceSensor.disconnect(),
    ]);
  }

  async sendErgTarget(watts: number): Promise<void> {
    if (this.trainer.getStatus().status === 'connected') {
      await this.trainer.setTargetPower(watts);
    }
  }

  async startTrainer(): Promise<void> {
    if (this.trainer.getStatus().status === 'connected') {
      await this.trainer.startResume();
    }
  }

  async pauseTrainer(): Promise<void> {
    if (this.trainer.getStatus().status === 'connected') {
      await this.trainer.setTargetPower(50);
      await this.trainer.stopPause();
    }
  }

  async stopTrainer(): Promise<void> {
    if (this.trainer.getStatus().status === 'connected') {
      await this.trainer.stopPause();
    }
  }

  dispose(): void {
    this.trainerUnsubs.forEach((fn) => fn());
    this.hrUnsubs.forEach((fn) => fn());
    this.cadenceUnsubs.forEach((fn) => fn());
    this.trainerUnsubs = [];
    this.hrUnsubs = [];
    this.cadenceUnsubs = [];
    this.simTrainer.dispose();
    this.simHr.dispose();
    this.bleTrainer.dispose();
    this.bleHr.dispose();
    this.bleCadence.dispose();
  }
}
