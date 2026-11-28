import { useEffect } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { ControlsBar } from './ControlsBar';
import { DiagnosticsOverlay } from './DiagnosticsOverlay';
import { HistoryGraph } from './HistoryGraph';
import { LeftPanel } from './LeftPanel';
import { TopHud } from './TopHud';
import { getActiveZone, useAppStore } from '../store/useAppStore';
import { NeonWorldCanvas } from '../world/NeonWorldCanvas';
import { getZoneGradient } from '../world/roadMath';

/**
 * Lightweight HUD-only viewport for phones / battery-saving mode.
 * Completely unmounts the WebGL <Canvas> while keeping full ERG control,
 * 1 Hz ride recording, countdowns, and telemetry graph intact.
 */
function MinimalRideViewport() {
  const zone = useAppStore(getActiveZone);
  const sceneryTheme = useAppStore((s) => s.sceneryTheme);
  const rideMode = useAppStore((s) => s.rideMode);
  const freeRideGrade = useAppStore((s) => s.freeRideGrade);
  const freeRideTargetWatts = useAppStore((s) => s.freeRideTargetWatts);
  const activeSnapshot = useAppStore((s) => s.activeSnapshot);
  const power3sAvg = useAppStore((s) => s.power3sAvg);
  const ftp = useAppStore((s) => s.ftp);
  const runState = useAppStore((s) => s.runState);
  const autoPaused = useAppStore((s) => s.autoPaused);
  const setMinimalMode = useAppStore((s) => s.setMinimalMode);

  const targetWatts =
    rideMode === 'freeride'
      ? freeRideTargetWatts
      : activeSnapshot?.targetWatts ?? Math.round(ftp * 0.68);
  const gradePct =
    rideMode === 'freeride'
      ? Math.round(freeRideGrade * 1000) / 10
      : Math.round(getZoneGradient(zone.zone, sceneryTheme) * 100);
  const countdownSec =
    rideMode === 'workout' && runState === 'running'
      ? activeSnapshot?.countdownSec ?? null
      : null;

  return (
    <div
      className="relative w-full h-full flex flex-col items-center justify-center bg-[#070517] p-6 text-center select-none"
      data-testid="minimal-ride-viewport"
    >
      <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2">
        <div
          className="px-3 py-1 rounded border text-xs font-display tracking-wider uppercase flex items-center gap-2"
          style={{
            backgroundColor: 'rgba(8, 7, 24, 0.88)',
            borderColor: zone.borderHex,
            color: zone.glowHex,
          }}
        >
          <Smartphone className="w-3.5 h-3.5" />
          <span>HUD-Only Minimal Mode</span>
        </div>

        <button
          type="button"
          onClick={() => setMinimalMode(false)}
          data-testid="btn-restore-3d-view"
          className="px-3 py-1.5 rounded border border-cyan-400/60 bg-cyan-500/15 hover:bg-cyan-500/25 text-xs font-display font-bold text-cyan-200 flex items-center gap-1.5"
        >
          <Monitor className="w-3.5 h-3.5" />
          Restore 3D World
        </button>
      </div>

      <div className="space-y-3 max-w-md">
        <div
          className="font-display text-sm tracking-[0.2em] uppercase font-bold"
          style={{ color: zone.glowHex }}
        >
          {zone.code} · {zone.name} · {gradePct >= 0 ? `+${gradePct}%` : `${gradePct}%`}
        </div>

        <div className="font-display text-6xl sm:text-7xl font-extrabold tabular-nums text-white">
          {power3sAvg}
          <span className="text-2xl text-cyan-300 ml-2">W</span>
        </div>

        <div className="text-sm font-display text-slate-300 tracking-wider">
          TARGET <span className="text-cyan-300 font-bold tabular-nums">{targetWatts} W</span>
          {activeSnapshot?.step.label && rideMode === 'workout' ? (
            <span className="text-slate-400"> · {activeSnapshot.step.label}</span>
          ) : null}
        </div>

        {countdownSec !== null && (
          <div
            className="inline-block mt-2 px-5 py-2 rounded-lg border-2 border-amber-400 bg-amber-950/50 font-display text-3xl font-extrabold tabular-nums text-amber-300"
            data-testid="step-countdown-cue"
          >
            NEXT IN {countdownSec}
          </div>
        )}

        {runState === 'paused' && (
          <div className="mt-2 px-5 py-2.5 rounded-lg border border-pink-400/75 bg-pink-950/40 text-pink-200 font-display text-sm font-bold tracking-wider uppercase">
            {autoPaused ? 'Auto-Paused · Pedal to Resume' : 'Paused · Press Space or Resume'}
          </div>
        )}
      </div>
    </div>
  );
}

export function RideScreen() {
  const showGraph = useAppStore((s) => s.showGraph);
  const activeModal = useAppStore((s) => s.activeModal);
  const runState = useAppStore((s) => s.runState);
  const minimalMode = useAppStore((s) => s.minimalMode);
  const showDiagnostics = useAppStore((s) => s.showDiagnostics);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const state = useAppStore.getState();

      if (e.key === 'Escape') {
        if (state.activeModal) {
          state.setActiveModal(null);
          return;
        }
        if (state.leftDrawerOpen) {
          state.setLeftDrawerOpen(false);
          return;
        }
        return;
      }

      if (state.activeModal) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          state.togglePlayPause();
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (state.rideMode === 'freeride') {
            state.adjustFreeRideWatts(5);
          } else {
            state.adjustIntensity(1);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (state.rideMode === 'freeride') {
            state.adjustFreeRideWatts(-5);
          } else {
            state.adjustIntensity(-1);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (state.rideMode !== 'freeride') state.skipStep();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (state.rideMode !== 'freeride') state.previousStep();
          break;
        case 'g':
        case 'G':
          e.preventDefault();
          state.toggleGraph();
          break;
        case 'h':
        case 'H':
          e.preventDefault();
          state.setShowHoloCards(!state.showHoloCards);
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          state.setActiveModal('devices');
          break;
        case 's':
        case 'S':
          e.preventDefault();
          state.setActiveModal('settings');
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          state.toggleAudioMute();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          if (!document.fullscreenElement) {
            void document.documentElement.requestFullscreen().catch(() => {});
          } else {
            void document.exitFullscreen().catch(() => {});
          }
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const rideMode = useAppStore((s) => s.rideMode);

  return (
    <main
      className="ride-grid h-screen w-screen overflow-hidden bg-[#060412] p-2 sm:p-2.5 flex flex-col gap-2"
      data-testid="ride-screen"
      data-run-state={runState}
      data-ride-mode={rideMode}
      data-minimal-mode={minimalMode ? 'on' : 'off'}
      data-modal-open={activeModal ?? 'none'}
    >
      {/* Top Full-Width Thick Neon-Bordered Telemetry HUD */}
      <TopHud />

      {/* Middle Row: Left Column (Stats + Workout Steps) + Center/Right 3D Neon World (or Minimal HUD) */}
      <div className="flex-1 min-h-0 flex gap-2 overflow-hidden">
        <LeftPanel />

        <div className="flex-1 min-w-0 min-h-0 rounded-lg overflow-hidden border-2 border-cyan-500/45 shadow-[0_0_20px_rgba(0,240,255,0.16)]">
          {minimalMode ? <MinimalRideViewport /> : <NeonWorldCanvas />}
        </div>
      </div>

      {/* Bottom Power & Heart Rate History Graph (collapsible so 3D world expands) */}
      {showGraph && <HistoryGraph />}

      {/* Bottom Touch-Friendly Controls Bar */}
      <ControlsBar />

      {/* Optional live diagnostics overlay (frame time, long tasks, max sample gap, step->ERG latency) */}
      {showDiagnostics && <DiagnosticsOverlay />}
    </main>
  );
}
