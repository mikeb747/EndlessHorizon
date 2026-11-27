import { useEffect } from 'react';
import { ControlsBar } from './ControlsBar';
import { HistoryGraph } from './HistoryGraph';
import { LeftPanel } from './LeftPanel';
import { TopHud } from './TopHud';
import { useAppStore } from '../store/useAppStore';
import { NeonWorldCanvas } from '../world/NeonWorldCanvas';

export function RideScreen() {
  const showGraph = useAppStore((s) => s.showGraph);
  const activeModal = useAppStore((s) => s.activeModal);
  const runState = useAppStore((s) => s.runState);

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
      data-modal-open={activeModal ?? 'none'}
    >
      {/* Top Full-Width Thick Neon-Bordered Telemetry HUD */}
      <TopHud />

      {/* Middle Row: Left Column (Stats + Workout Steps) + Center/Right 3D Neon World */}
      <div className="flex-1 min-h-0 flex gap-2 overflow-hidden">
        <LeftPanel />

        <div className="flex-1 min-w-0 min-h-0 rounded-lg overflow-hidden border-2 border-cyan-500/45 shadow-[0_0_20px_rgba(0,240,255,0.16)]">
          <NeonWorldCanvas />
        </div>
      </div>

      {/* Bottom Power & Heart Rate History Graph (collapsible so 3D world expands) */}
      {showGraph && <HistoryGraph />}

      {/* Bottom Touch-Friendly Controls Bar */}
      <ControlsBar />
    </main>
  );
}
