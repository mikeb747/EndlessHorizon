import { useState } from 'react';
import {
  Award,
  Check,
  Clock,
  Download,
  Flag,
  FolderArchive,
  Home,
  Mountain,
  RotateCcw,
} from 'lucide-react';
import { formatClock } from '../core/zones';
import { downloadRideFitFile } from '../recording/rideStorage';
import { useAppStore } from '../store/useAppStore';

function formatStartTime(ms: number | null): string {
  if (!ms) return '--';
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RideSummaryModal() {
  const activeWorkout = useAppStore((s) => s.activeWorkout);
  const elapsedSec = useAppStore((s) => s.elapsedSec);
  const liveTss = useAppStore((s) => s.liveTss);
  const calories = useAppStore((s) => s.calories);
  const totalWorkKj = useAppStore((s) => s.totalWorkKj);
  const history = useAppStore((s) => s.history);
  const lastCompletedRide = useAppStore((s) => s.lastCompletedRide);
  const resetWorkout = useAppStore((s) => s.resetWorkout);
  const setScreen = useAppStore((s) => s.setScreen);
  const setActiveModal = useAppStore((s) => s.setActiveModal);

  const [savedFileName, setSavedFileName] = useState<string | null>(null);

  const durationSec = lastCompletedRide?.totalTimerSec ?? Math.round(elapsedSec);
  const distanceKm = ((lastCompletedRide?.totalDistanceM ?? 0) / 1000).toFixed(2);
  const avgSpeedKmh = (lastCompletedRide?.avgSpeedKmh ?? 0).toFixed(1);
  const ascentM = lastCompletedRide?.totalAscentM ?? 0;
  const avgPower =
    lastCompletedRide?.avgPower ??
    (history.length > 0
      ? Math.round(history.reduce((sum, h) => sum + h.power, 0) / history.length)
      : 0);
  const maxPower = lastCompletedRide?.maxPower ?? 0;
  const avgHr =
    lastCompletedRide?.avgHeartRate ??
    (history.length > 0
      ? Math.round(history.reduce((sum, h) => sum + h.heartRate, 0) / history.length)
      : 0);
  const maxHr = lastCompletedRide?.maxHeartRate ?? 0;
  const avgCadence = lastCompletedRide?.avgCadence ?? 0;
  const tss = lastCompletedRide?.tss ?? liveTss;
  const workKj = Math.round(lastCompletedRide?.totalWorkKj ?? totalWorkKj);
  const totalCalories = lastCompletedRide?.calories ?? calories;
  const laps = lastCompletedRide?.laps ?? [];
  const startTimeLabel = formatStartTime(lastCompletedRide?.startTimeMs ?? null);

  const handleSaveFit = () => {
    if (!lastCompletedRide) return;
    const fileName = downloadRideFitFile(lastCompletedRide);
    setSavedFileName(fileName);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-labelledby="summary-modal-title"
      data-testid="ride-summary-modal"
    >
      <div className="neon-frame-hud rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-cyan-500/25 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Award className="w-8 h-8 text-cyan-300 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-bold tracking-[0.16em] text-pink-300 uppercase">
                Ride Summary · Virtual Cycling (FIT)
              </div>
              <h2
                id="summary-modal-title"
                className="font-display text-lg sm:text-xl font-extrabold text-white truncate"
              >
                {lastCompletedRide?.workoutName ?? activeWorkout.name}
              </h2>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-400 mt-0.5">
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-cyan-300" />
                  Started {startTimeLabel}
                </span>
                <span>·</span>
                <span>Ura-shima Virtual GPS</span>
                <span>·</span>
                <span>{laps.length} {laps.length === 1 ? 'Lap' : 'Laps'}</span>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-emerald-400/50 bg-emerald-950/50 px-3 py-1.5 text-xs font-semibold text-emerald-200 flex items-center gap-1.5 shrink-0">
            <Check className="w-3.5 h-3.5 text-emerald-300" />
            Saved for Later Upload
          </div>
        </div>

        {/* Scrollable body */}
        <div className="px-6 py-4 space-y-4 overflow-y-auto synth-scroll">
          {/* Primary Metric Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="rounded-lg bg-[#0a0820] border border-cyan-500/35 p-3">
              <div className="text-[11px] uppercase text-slate-400 font-bold">Duration</div>
              <div className="font-display text-lg font-bold tabular-nums text-white mt-0.5">
                {formatClock(durationSec)}
              </div>
            </div>
            <div className="rounded-lg bg-[#0a0820] border border-cyan-500/35 p-3">
              <div className="text-[11px] uppercase text-slate-400 font-bold">Distance</div>
              <div className="font-display text-lg font-bold tabular-nums text-cyan-300 mt-0.5">
                {distanceKm} km
              </div>
            </div>
            <div className="rounded-lg bg-[#0a0820] border border-cyan-500/35 p-3">
              <div className="text-[11px] uppercase text-slate-400 font-bold">Avg Speed</div>
              <div className="font-display text-lg font-bold tabular-nums text-white mt-0.5">
                {avgSpeedKmh} km/h
              </div>
            </div>
            <div className="rounded-lg bg-[#0a0820] border border-pink-500/35 p-3">
              <div className="text-[11px] uppercase text-slate-400 font-bold flex items-center gap-1">
                <Mountain className="w-3 h-3 text-pink-300" />
                Elevation
              </div>
              <div className="font-display text-lg font-bold tabular-nums text-pink-300 mt-0.5">
                +{ascentM} m
              </div>
            </div>

            <div className="rounded-lg bg-[#0a0820] border border-cyan-500/35 p-3">
              <div className="text-[11px] uppercase text-slate-400 font-bold">Avg / Max Power</div>
              <div className="font-display text-lg font-bold tabular-nums text-cyan-300 mt-0.5">
                {avgPower} W
                {maxPower > 0 && (
                  <span className="text-xs text-slate-400 font-sans ml-1">/ {maxPower}</span>
                )}
              </div>
            </div>
            <div className="rounded-lg bg-[#0a0820] border border-pink-500/35 p-3">
              <div className="text-[11px] uppercase text-slate-400 font-bold">Avg / Max HR</div>
              <div className="font-display text-lg font-bold tabular-nums text-pink-300 mt-0.5">
                {avgHr > 0 ? `${avgHr} bpm` : '--'}
                {maxHr > 0 && (
                  <span className="text-xs text-slate-400 font-sans ml-1">/ {maxHr}</span>
                )}
              </div>
            </div>
            <div className="rounded-lg bg-[#0a0820] border border-cyan-500/35 p-3">
              <div className="text-[11px] uppercase text-slate-400 font-bold">Avg Cadence</div>
              <div className="font-display text-lg font-bold tabular-nums text-white mt-0.5">
                {avgCadence > 0 ? `${avgCadence} rpm` : '--'}
              </div>
            </div>
            <div className="rounded-lg bg-[#0a0820] border border-cyan-500/35 p-3">
              <div className="text-[11px] uppercase text-slate-400 font-bold">TSS / Work</div>
              <div className="font-display text-lg font-bold tabular-nums text-amber-300 mt-0.5">
                {tss.toFixed(1)}
                <span className="text-xs text-slate-400 font-sans ml-1.5">
                  {workKj} kJ · {totalCalories} kcal
                </span>
              </div>
            </div>
          </div>

          {/* Recorded Laps Table (split at each workout step change) */}
          {laps.length > 0 && (
            <div className="rounded-lg bg-[#08061a] border border-cyan-500/25 overflow-hidden">
              <div className="px-3.5 py-2 border-b border-cyan-500/20 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-300">
                <span className="flex items-center gap-1.5">
                  <Flag className="w-3.5 h-3.5 text-cyan-300" />
                  Recorded Laps ({laps.length})
                </span>
                <span className="text-[11px] font-normal text-slate-400 normal-case">
                  Auto-split on workout step changes
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto synth-scroll">
                <table className="w-full text-left text-xs tabular-nums">
                  <thead className="bg-[#0d0a26] text-[10px] uppercase tracking-wider text-slate-400 sticky top-0">
                    <tr>
                      <th className="px-3 py-1.5">#</th>
                      <th className="px-3 py-1.5">Step</th>
                      <th className="px-3 py-1.5 text-right">Time</th>
                      <th className="px-3 py-1.5 text-right">Dist</th>
                      <th className="px-3 py-1.5 text-right">Avg W</th>
                      <th className="px-3 py-1.5 text-right">Avg HR</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cyan-500/15 text-slate-200">
                    {laps.map((lap) => (
                      <tr key={lap.lapIndex}>
                        <td className="px-3 py-1.5 text-slate-400 font-semibold">
                          {lap.lapIndex + 1}
                        </td>
                        <td className="px-3 py-1.5 truncate max-w-[180px]">{lap.stepLabel}</td>
                        <td className="px-3 py-1.5 text-right">
                          {formatClock(lap.totalTimerSec)}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {(lap.totalDistanceM / 1000).toFixed(2)} km
                        </td>
                        <td className="px-3 py-1.5 text-right text-cyan-300 font-semibold">
                          {lap.avgPower} W
                        </td>
                        <td className="px-3 py-1.5 text-right text-pink-300">
                          {lap.avgHeartRate > 0 ? `${lap.avgHeartRate}` : '--'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {savedFileName && (
            <div
              className="rounded-lg border border-cyan-400/50 bg-cyan-950/40 px-3.5 py-2 text-xs text-cyan-200 flex items-center gap-2"
              data-testid="fit-download-confirmation"
            >
              <Check className="w-4 h-4 text-cyan-300 shrink-0" />
              <span>
                Exported <strong className="text-white">{savedFileName}</strong> (Cycling · Virtual
                Activity, ready for Strava).
              </span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-cyan-500/25 bg-[#08061a]/90 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSaveFit}
              disabled={!lastCompletedRide}
              data-testid="btn-save-fit"
              className="min-h-[48px] px-5 rounded-md bg-gradient-to-r from-cyan-500 to-pink-500 text-slate-950 hover:brightness-110 disabled:opacity-50 font-display text-xs font-extrabold uppercase tracking-wider flex items-center gap-2 shadow-[0_0_20px_rgba(0,240,255,0.35)]"
            >
              <Download className="w-4 h-4" />
              Save FIT (.fit)
            </button>

            <button
              type="button"
              onClick={() => setActiveModal('rides')}
              data-testid="btn-open-saved-rides"
              className="min-h-[48px] px-4 rounded-md bg-[#110e2d] border border-pink-500/45 text-pink-200 hover:bg-pink-500/15 font-display text-xs font-bold uppercase tracking-wider flex items-center gap-2"
            >
              <FolderArchive className="w-4 h-4" />
              Saved Rides
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                resetWorkout();
                setScreen('menu');
              }}
              className="min-h-[48px] px-4 rounded-md bg-[#110e2d] border border-cyan-500/45 text-slate-200 hover:bg-cyan-500/15 font-display text-xs font-bold uppercase tracking-wider flex items-center gap-2"
            >
              <Home className="w-4 h-4" />
              Main Menu
            </button>
            <button
              type="button"
              onClick={() => {
                resetWorkout();
                setActiveModal(null);
              }}
              className="min-h-[48px] px-4 rounded-md bg-cyan-500/20 border border-cyan-400/75 text-white hover:bg-cyan-500/35 font-display text-xs font-bold uppercase tracking-wider flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Ride Again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
