import { powerToSpeedKmh } from '../core/zones';
import {
  HeartRateDevice,
  HeartRateStatusSnapshot,
  HeartRateTelemetry,
  TrainerDevice,
  TrainerStatusSnapshot,
  TrainerTelemetry,
} from './types';

/**
 * Simulated smart trainer modeling a Wahoo KICKR V4 over FTMS ERG mode.
 * Follows target watts with realistic flywheel lag, micro-cadence oscillation,
 * and plausible virtual speed.
 */
export class SimulatedTrainer implements TrainerDevice {
  readonly isSimulated = true;

  private status: TrainerStatusSnapshot = {
    status: 'disconnected',
    deviceId: 'sim-kickr-v4',
    deviceName: 'Simulated KICKR V4 (FTMS)',
    ergControlActive: false,
    ergControlWarning: null,
    signalStrength: 0,
    isSimulated: true,
  };

  private telemetryListeners = new Set<(data: TrainerTelemetry) => void>();
  private statusListeners = new Set<(status: TrainerStatusSnapshot) => void>();

  private intervalId: number | null = null;
  private targetWatts = 0;
  private currentPower = 0;
  private currentCadence = 0;
  private isPedaling = false;
  private phase = 0;

  getStatus(): TrainerStatusSnapshot {
    return { ...this.status };
  }

  async connect(): Promise<void> {
    if (this.status.status === 'connected') return;
    this.emitStatus({ status: 'connecting', signalStrength: 45 });
    await new Promise((r) => setTimeout(r, 120));
    this.emitStatus({
      status: 'connected',
      signalStrength: 96,
      ergControlActive: true,
      ergControlWarning: null,
    });
    this.startLoop();
  }

  async disconnect(): Promise<void> {
    this.stopLoop();
    this.isPedaling = false;
    this.targetWatts = 0;
    this.currentPower = 0;
    this.currentCadence = 0;
    this.emitStatus({
      status: 'disconnected',
      ergControlActive: false,
      signalStrength: 0,
    });
  }

  async requestControl(): Promise<boolean> {
    if (this.status.status !== 'connected') return false;
    this.emitStatus({ ergControlActive: true, ergControlWarning: null });
    return true;
  }

  async startResume(): Promise<void> {
    if (this.status.status !== 'connected') return;
    this.isPedaling = true;
    this.emitStatus({ ergControlActive: true });
  }

  async stopPause(): Promise<void> {
    this.isPedaling = false;
    this.targetWatts = 0;
  }

  async setTargetPower(watts: number): Promise<void> {
    this.targetWatts = Math.max(0, Math.round(watts));
    if (this.targetWatts > 0 && this.status.status === 'connected') {
      this.isPedaling = true;
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

  getInstantPower(): number {
    return this.currentPower;
  }

  dispose(): void {
    this.stopLoop();
    this.telemetryListeners.clear();
    this.statusListeners.clear();
  }

  private emitStatus(patch: Partial<TrainerStatusSnapshot>): void {
    this.status = { ...this.status, ...patch };
    const snap = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snap);
    }
  }

  private startLoop(): void {
    if (this.intervalId !== null) return;
    this.intervalId = window.setInterval(() => {
      this.phase += 0.35;
      const desiredPower = this.isPedaling ? this.targetWatts : 0;

      // Realistic KICKR flywheel + human torque lag (~1.8s settling)
      const alpha = desiredPower > this.currentPower ? 0.32 : 0.38;
      this.currentPower += (desiredPower - this.currentPower) * alpha;

      // Natural pedaling variance (±3–6 W) when active
      let reportedPower = 0;
      if (this.isPedaling && desiredPower > 0) {
        const wave = Math.sin(this.phase * 1.7) * 2.8 + Math.cos(this.phase * 0.63) * 1.9;
        const jitter = (Math.random() - 0.5) * 4.5;
        reportedPower = Math.max(0, Math.round(this.currentPower + wave + jitter));
      } else {
        reportedPower = Math.max(0, Math.round(this.currentPower));
        if (reportedPower < 3) {
          this.currentPower = 0;
          reportedPower = 0;
        }
      }

      // Plausible cadence tracking effort (84–99 rpm)
      const desiredCadence =
        this.isPedaling && desiredPower > 0
          ? Math.min(104, Math.max(82, 84 + (desiredPower / 320) * 15))
          : 0;
      this.currentCadence += (desiredCadence - this.currentCadence) * 0.28;
      const reportedCadence =
        this.currentCadence < 5
          ? 0
          : Math.round(this.currentCadence + Math.sin(this.phase * 0.9) * 1.5);

      const speedKmh = powerToSpeedKmh(reportedPower);

      const payload: TrainerTelemetry = {
        instantPower: reportedPower,
        cadence: reportedCadence,
        speedKmh,
        timestampMs: Date.now(),
      };
      for (const listener of this.telemetryListeners) {
        listener(payload);
      }
    }, 500);
  }

  private stopLoop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

/**
 * Simulated Heart Rate Monitor responding physiologically to power output / FTP
 * with cardiac lag and subtle beat-to-beat variability.
 */
export class SimulatedHeartRate implements HeartRateDevice {
  readonly isSimulated = true;

  private status: HeartRateStatusSnapshot = {
    status: 'disconnected',
    deviceId: 'sim-hrm-chest',
    deviceName: 'Simulated HRM Strap',
    signalStrength: 0,
    isSimulated: true,
    errorMessage: null,
  };

  private telemetryListeners = new Set<(data: HeartRateTelemetry) => void>();
  private statusListeners = new Set<(status: HeartRateStatusSnapshot) => void>();
  private intervalId: number | null = null;
  private currentHr = 68;
  private effortRatioProvider: () => number;

  constructor(effortRatioProvider: () => number) {
    this.effortRatioProvider = effortRatioProvider;
  }

  getStatus(): HeartRateStatusSnapshot {
    return { ...this.status };
  }

  async connect(): Promise<void> {
    if (this.status.status === 'connected') return;
    this.emitStatus({ status: 'connecting', signalStrength: 40 });
    await new Promise((r) => setTimeout(r, 100));
    this.emitStatus({ status: 'connected', signalStrength: 94 });
    this.startLoop();
  }

  async disconnect(): Promise<void> {
    this.stopLoop();
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
    this.stopLoop();
    this.telemetryListeners.clear();
    this.statusListeners.clear();
  }

  private emitStatus(patch: Partial<HeartRateStatusSnapshot>): void {
    this.status = { ...this.status, ...patch };
    const snap = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snap);
    }
  }

  private startLoop(): void {
    if (this.intervalId !== null) return;
    this.intervalId = window.setInterval(() => {
      const ratio = Math.max(0, Math.min(1.6, this.effortRatioProvider()));
      // Map effort ratio (0 -> 66 bpm, 0.7 -> 132 bpm, 1.0 -> 162 bpm, 1.3 -> 182 bpm)
      const targetHr = ratio <= 0.05 ? 68 : Math.min(188, 72 + ratio * 88);
      const tau = targetHr > this.currentHr ? 0.08 : 0.055;
      this.currentHr += (targetHr - this.currentHr) * tau;
      const noise = (Math.random() - 0.5) * 1.6;
      const bpm = Math.round(Math.max(52, Math.min(195, this.currentHr + noise)));

      const payload: HeartRateTelemetry = {
        heartRate: bpm,
        timestampMs: Date.now(),
      };
      for (const listener of this.telemetryListeners) {
        listener(payload);
      }
    }, 1000);
  }

  private stopLoop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
