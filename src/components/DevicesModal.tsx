import { useMemo } from 'react';
import { Bluetooth, Gauge, Heart, Radio, RefreshCw, Signal, Trash2, X, Zap } from 'lucide-react';
import { CadenceSource, DeviceConnectionStatus } from '../devices/types';
import { useAppStore } from '../store/useAppStore';
import { getBrowserCompatibility } from '../utils/browserCheck';

function statusBadgeClass(status: DeviceConnectionStatus): string {
  if (status === 'connected') return 'text-emerald-300';
  if (status === 'reconnecting' || status === 'connecting') return 'text-cyan-300 animate-pulse';
  return 'text-amber-300';
}

function SignalBars({ strength }: { strength: number }) {
  const activeBars = strength >= 80 ? 4 : strength >= 55 ? 3 : strength >= 25 ? 2 : strength > 0 ? 1 : 0;
  return (
    <div className="flex items-end gap-0.5 h-4" aria-label={`Signal strength ${strength}%`}>
      {[1, 2, 3, 4].map((bar) => (
        <span
          key={bar}
          className={`w-1 rounded-xs ${bar <= activeBars ? 'bg-cyan-400' : 'bg-slate-700'}`}
          style={{ height: `${bar * 25}%` }}
        />
      ))}
    </div>
  );
}

const CADENCE_SOURCE_LABELS: Record<CadenceSource, string> = {
  'ble-cadence': 'Bluetooth Cadence Sensor',
  'ble-trainer': 'Bluetooth Trainer (FTMS)',
  simulated: 'Simulated Trainer',
  none: 'No Cadence Source',
};

export function DevicesModal() {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const simulationEnabled = useAppStore((s) => s.simulationEnabled);
  const setSimulationEnabled = useAppStore((s) => s.setSimulationEnabled);
  const cadenceMatchingEnabled = useAppStore((s) => s.cadenceMatchingEnabled);
  const setCadenceMatchingEnabled = useAppStore((s) => s.setCadenceMatchingEnabled);
  const trainerStatus = useAppStore((s) => s.trainerStatus);
  const hrStatus = useAppStore((s) => s.hrStatus);
  const cadenceStatus = useAppStore((s) => s.cadenceStatus);
  const savedDevices = useAppStore((s) => s.savedDevices);
  const silentReconnectAvailable = useAppStore((s) => s.silentReconnectAvailable);
  const reconnectingLastDevices = useAppStore((s) => s.reconnectingLastDevices);
  const cadenceSource = useAppStore((s) => s.cadenceSource);
  const instantPower = useAppStore((s) => s.instantPower);
  const cadence = useAppStore((s) => s.cadence);
  const speedKmh = useAppStore((s) => s.speedKmh);
  const heartRate = useAppStore((s) => s.heartRate);
  const connectTrainer = useAppStore((s) => s.connectTrainer);
  const connectBleTrainer = useAppStore((s) => s.connectBleTrainer);
  const disconnectTrainer = useAppStore((s) => s.disconnectTrainer);
  const connectHeartRate = useAppStore((s) => s.connectHeartRate);
  const connectBleHeartRate = useAppStore((s) => s.connectBleHeartRate);
  const disconnectHeartRate = useAppStore((s) => s.disconnectHeartRate);
  const connectBleCadence = useAppStore((s) => s.connectBleCadence);
  const disconnectCadence = useAppStore((s) => s.disconnectCadence);
  const reconnectLastDevices = useAppStore((s) => s.reconnectLastDevices);
  const forgetSavedDevice = useAppStore((s) => s.forgetSavedDevice);

  const compat = useMemo(() => getBrowserCompatibility(), []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      role="dialog"
      aria-modal="true"
      aria-labelledby="devices-modal-title"
      data-testid="devices-modal"
    >
      <div className="neon-frame-hud rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cyan-500/30 shrink-0">
          <div className="flex items-center gap-2.5">
            <Bluetooth className="w-5 h-5 text-cyan-300" />
            <h2 id="devices-modal-title" className="font-display text-lg font-bold text-white uppercase tracking-wider">
              Devices &amp; Sensors
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setActiveModal(null)}
            className="w-12 h-12 rounded-md border border-cyan-500/40 text-slate-200 hover:bg-cyan-500/20 flex items-center justify-center"
            aria-label="Close devices dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="synth-scroll flex-1 overflow-y-auto p-5 space-y-4">
          {/* Simulation Mode Toggle */}
          <div className="flex items-center justify-between gap-4 p-4 rounded-lg bg-[#0d0a26] border border-pink-500/45">
            <div>
              <div className="font-display text-sm font-bold text-white flex items-center gap-2">
                <Radio className="w-4 h-4 text-pink-400" />
                Simulation Mode
              </div>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                Drives realistic FTMS ERG target tracking, cadence, virtual speed, and heart rate
                without physical hardware, or pair real Bluetooth sensors below.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={simulationEnabled}
              onClick={() => void setSimulationEnabled(!simulationEnabled)}
              className={`min-h-[48px] min-w-[92px] px-4 rounded-md font-display text-xs font-bold uppercase tracking-wider border-2 transition-colors shrink-0 ${
                simulationEnabled
                  ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                  : 'bg-[#09071a] border-slate-600 text-slate-400'
              }`}
              data-testid="toggle-simulation"
            >
              {simulationEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Remembered Bluetooth Devices & Reconnect Last Devices */}
          {savedDevices.length > 0 && (
            <div
              className="rounded-lg p-4 bg-[#0c0924] border border-cyan-400/50 space-y-3"
              data-testid="saved-devices-panel"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-bold tracking-[0.14em] text-cyan-300 uppercase">
                    Remembered Bluetooth Devices
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {silentReconnectAvailable
                      ? 'Silent auto-reconnect is enabled on startup via Web Bluetooth getDevices().'
                      : 'Silent reconnect is unavailable in this browser — click below to reconnect your last sensors.'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={reconnectingLastDevices || !compat.hasWebBluetoothApi}
                  onClick={() => void reconnectLastDevices()}
                  className="min-h-[42px] px-4 rounded-md bg-cyan-500/25 border border-cyan-400 text-cyan-100 text-xs font-bold uppercase tracking-wider hover:bg-cyan-500/35 disabled:opacity-45 flex items-center gap-1.5 whitespace-nowrap"
                  data-testid="btn-reconnect-last-devices"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${reconnectingLastDevices ? 'animate-spin' : ''}`} />
                  {reconnectingLastDevices ? 'Reconnecting…' : 'Reconnect Last Devices'}
                </button>
              </div>
              <div className="space-y-1.5">
                {savedDevices.map((dev) => (
                  <div
                    key={dev.id}
                    className="flex items-center justify-between gap-2 rounded bg-[#070516] px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-semibold text-white">{dev.name}</span>
                      <span className="ml-2 text-[11px] uppercase text-cyan-300/90">
                        {dev.role ?? 'sensor'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => forgetSavedDevice(dev.id)}
                      className="p-1.5 rounded text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors"
                      aria-label={`Forget ${dev.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dedicated Bluetooth Cadence Sensor + Model Cadence Matching Card */}
          <div
            className="rounded-lg p-4 bg-[#0a0820] border border-emerald-400/45 space-y-3"
            data-testid="cadence-sensor-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-bold tracking-[0.14em] text-emerald-300 uppercase flex items-center gap-1.5">
                  <Gauge className="w-4 h-4" />
                  Cadence Sensor · BLE 0x1816 (CSC) / 0x1818
                </div>
                <div className="font-display text-base font-bold text-white mt-0.5">
                  {cadenceStatus.deviceName ?? 'Bluetooth Cadence Sensor'}
                </div>
                <div className="text-xs text-slate-300 mt-0.5 flex flex-wrap items-center gap-2">
                  <span>
                    Status:{' '}
                    <strong className={statusBadgeClass(cadenceStatus.status)}>
                      {cadenceStatus.status.toUpperCase()}
                    </strong>
                  </span>
                  <span>·</span>
                  <span className="text-cyan-300">
                    Active Source: {CADENCE_SOURCE_LABELS[cadenceSource]}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <SignalBars strength={cadenceStatus.signalStrength} />
                {cadenceStatus.status === 'connected' ? (
                  <button
                    type="button"
                    onClick={() => void disconnectCadence()}
                    className="min-h-[48px] px-4 rounded-md bg-rose-500/15 border border-rose-400/60 text-rose-200 text-xs font-bold uppercase tracking-wider hover:bg-rose-500/25"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connectBleCadence()}
                    disabled={!compat.hasWebBluetoothApi}
                    className="min-h-[48px] px-4 rounded-md bg-emerald-500/25 border border-emerald-400 text-emerald-100 text-xs font-bold uppercase tracking-wider hover:bg-emerald-500/35 disabled:opacity-45 disabled:cursor-not-allowed"
                    data-testid="btn-pair-ble-cadence"
                  >
                    Pair BLE Cadence
                  </button>
                )}
              </div>
            </div>

            {cadenceStatus.errorMessage && (
              <div className="rounded border border-amber-400/60 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
                {cadenceStatus.errorMessage}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2 border-t border-emerald-400/20">
              <div className="rounded bg-[#070516] px-3 py-2 flex items-center justify-between">
                <span className="text-xs text-slate-400 uppercase font-semibold">Live Sensor RPM</span>
                <span className="font-display text-xl font-bold tabular-nums text-emerald-300">
                  {cadence} rpm
                </span>
              </div>
              <div className="rounded bg-[#070516] px-3 py-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs text-white font-semibold">3D Model Cadence Match</div>
                  <div className="text-[11px] text-slate-400">1:1 crank &amp; leg RPM lock</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={cadenceMatchingEnabled}
                  onClick={() => setCadenceMatchingEnabled(!cadenceMatchingEnabled)}
                  className={`min-h-[40px] min-w-[68px] px-3 rounded-md font-display text-xs font-bold border ${
                    cadenceMatchingEnabled
                      ? 'bg-emerald-500/25 border-emerald-400 text-emerald-100'
                      : 'bg-[#09071a] border-slate-600 text-slate-400'
                  }`}
                  data-testid="devices-toggle-cadence-matching"
                >
                  {cadenceMatchingEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          </div>

          {/* Smart Trainer Card */}
          <div className="rounded-lg p-4 bg-[#0a0820] border border-cyan-500/40 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-bold tracking-[0.14em] text-cyan-300 uppercase flex items-center gap-1.5">
                  <Zap className="w-4 h-4" />
                  Smart Trainer · FTMS 0x1826
                </div>
                <div className="font-display text-base font-bold text-white mt-0.5">
                  {trainerStatus.deviceName ?? 'Wahoo KICKR V4'}
                </div>
                <div className="text-xs text-slate-300 mt-0.5 flex items-center gap-2">
                  <span>
                    Status:{' '}
                    <strong className={statusBadgeClass(trainerStatus.status)}>
                      {trainerStatus.status.toUpperCase()}
                    </strong>
                  </span>
                  <span>·</span>
                  <span className={trainerStatus.ergControlActive ? 'text-cyan-300 font-semibold' : 'text-slate-400'}>
                    {trainerStatus.ergControlActive ? 'ERG Control Active' : 'ERG Standby'}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <SignalBars strength={trainerStatus.signalStrength} />
                {compat.hasWebBluetoothApi && (
                  <button
                    type="button"
                    onClick={() => void connectBleTrainer()}
                    className="min-h-[48px] px-3.5 rounded-md bg-cyan-500/20 border border-cyan-400/80 text-cyan-100 text-xs font-bold uppercase tracking-wider hover:bg-cyan-500/35"
                    data-testid="btn-pair-ble-trainer"
                  >
                    Pair BLE
                  </button>
                )}
                {trainerStatus.status === 'connected' ? (
                  <button
                    type="button"
                    onClick={() => void disconnectTrainer()}
                    className="min-h-[48px] px-4 rounded-md bg-rose-500/15 border border-rose-400/60 text-rose-200 text-xs font-bold uppercase tracking-wider hover:bg-rose-500/25"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connectTrainer()}
                    className="min-h-[48px] px-4 rounded-md bg-cyan-500/25 border border-cyan-400 text-cyan-100 text-xs font-bold uppercase tracking-wider hover:bg-cyan-500/35"
                  >
                    Connect Sim
                  </button>
                )}
              </div>
            </div>

            {trainerStatus.ergControlWarning && (
              <div className="rounded border border-amber-400/60 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
                {trainerStatus.ergControlWarning}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-cyan-500/20 text-center">
              <div className="rounded bg-[#070516] p-2">
                <div className="text-[11px] text-slate-400 uppercase">Power</div>
                <div className="font-display text-lg font-bold tabular-nums text-white">
                  {instantPower} W
                </div>
              </div>
              <div className="rounded bg-[#070516] p-2">
                <div className="text-[11px] text-slate-400 uppercase">Cadence</div>
                <div className="font-display text-lg font-bold tabular-nums text-cyan-300">
                  {cadence} rpm
                </div>
              </div>
              <div className="rounded bg-[#070516] p-2">
                <div className="text-[11px] text-slate-400 uppercase">Virtual Speed</div>
                <div className="font-display text-lg font-bold tabular-nums text-pink-300">
                  {speedKmh.toFixed(1)} km/h
                </div>
              </div>
            </div>
          </div>

          {/* Heart Rate Monitor Card */}
          <div className="rounded-lg p-4 bg-[#0a0820] border border-pink-500/40 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-bold tracking-[0.14em] text-pink-300 uppercase flex items-center gap-1.5">
                  <Heart className="w-4 h-4" />
                  Heart Rate Monitor · BLE 0x180D
                </div>
                <div className="font-display text-base font-bold text-white mt-0.5">
                  {hrStatus.deviceName ?? 'Heart Rate Sensor'}
                </div>
                <div className="text-xs text-slate-300 mt-0.5">
                  Status:{' '}
                  <strong className={statusBadgeClass(hrStatus.status)}>
                    {hrStatus.status.toUpperCase()}
                  </strong>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <SignalBars strength={hrStatus.signalStrength} />
                {compat.hasWebBluetoothApi && (
                  <button
                    type="button"
                    onClick={() => void connectBleHeartRate()}
                    className="min-h-[48px] px-3.5 rounded-md bg-pink-500/20 border border-pink-400/80 text-pink-100 text-xs font-bold uppercase tracking-wider hover:bg-pink-500/35"
                    data-testid="btn-pair-ble-hrm"
                  >
                    Pair BLE
                  </button>
                )}
                {hrStatus.status === 'connected' ? (
                  <button
                    type="button"
                    onClick={() => void disconnectHeartRate()}
                    className="min-h-[48px] px-4 rounded-md bg-rose-500/15 border border-rose-400/60 text-rose-200 text-xs font-bold uppercase tracking-wider hover:bg-rose-500/25"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connectHeartRate()}
                    className="min-h-[48px] px-4 rounded-md bg-pink-500/25 border border-pink-400 text-pink-100 text-xs font-bold uppercase tracking-wider hover:bg-pink-500/35"
                  >
                    Connect Sim
                  </button>
                )}
              </div>
            </div>

            {hrStatus.errorMessage && (
              <div
                className="rounded border border-amber-400/60 bg-amber-950/50 px-3 py-2 text-xs text-amber-200"
                data-testid="hrm-error-message"
              >
                {hrStatus.errorMessage}
              </div>
            )}

            <div className="rounded bg-[#070516] p-2.5 flex items-center justify-between border-t border-pink-500/20">
              <span className="text-xs text-slate-400 uppercase font-semibold">Live Heart Rate</span>
              <span className="font-display text-xl font-bold tabular-nums text-pink-300">
                {hrStatus.status === 'connected' ? `${heartRate} bpm` : '-- bpm'}
              </span>
            </div>
          </div>

          {/* Web Bluetooth Compatibility Summary */}
          <div className="rounded-lg bg-[#09071a] border border-slate-700/80 p-3.5 text-xs text-slate-300 space-y-1">
            <div className="font-bold text-cyan-300 flex items-center gap-1.5">
              <Signal className="w-3.5 h-3.5" />
              Web Bluetooth Sensors (FTMS 0x1826 · CSC 0x1816 · CP 0x1818 · HRM 0x180D)
            </div>
            <p>
              Pair a dedicated Bluetooth cadence sensor or FTMS trainer directly to drive exact 1:1
              3D cyclist pedalling RPM. When a standalone cadence sensor is paired, it takes
              priority over trainer cadence.
            </p>
            <p className="text-slate-400">
              Browser detected: {compat.browserLabel} · Secure context:{' '}
              {compat.isSecureContext ? 'Yes' : 'No (use HTTPS or localhost)'} · Web Bluetooth API:{' '}
              {compat.hasWebBluetoothApi ? 'Available' : 'Requires Chrome or Edge'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
