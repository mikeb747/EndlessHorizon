import { useState } from 'react';
import {
  Activity,
  Bluetooth,
  BookOpen,
  Maximize2,
  Minimize2,
  Minus,
  Pause,
  Play,
  Plus,
  Settings,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { clampFreeRideCenterWatts, FREE_RIDE_WATT_STEP } from '../core/freeRide';
import { COGGAN_ZONES } from '../core/zones';
import { getEffectiveFtpFromState, useAppStore } from '../store/useAppStore';

export function ControlsBar() {
  const runState = useAppStore((s) => s.runState);
  const rideMode = useAppStore((s) => s.rideMode);
  const ftp = useAppStore((s) => s.ftp);
  const freeRideZone = useAppStore((s) => s.freeRideZone);
  const freeRideOffsetWatts = useAppStore((s) => s.freeRideOffsetWatts);
  const intensityOffsetPct = useAppStore((s) => s.intensityOffsetPct);
  const effectiveFtp = useAppStore(getEffectiveFtpFromState);
  const showGraph = useAppStore((s) => s.showGraph);
  const trainerStatus = useAppStore((s) => s.trainerStatus);
  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const audioMuted = useAppStore((s) => s.audioMuted);
  const audioMasterVolume = useAppStore((s) => s.audioMasterVolume);
  const audioRideVolume = useAppStore((s) => s.audioRideVolume);

  const togglePlayPause = useAppStore((s) => s.togglePlayPause);
  const previousStep = useAppStore((s) => s.previousStep);
  const skipStep = useAppStore((s) => s.skipStep);
  const endWorkout = useAppStore((s) => s.endWorkout);
  const adjustIntensity = useAppStore((s) => s.adjustIntensity);
  const resetIntensityOffset = useAppStore((s) => s.resetIntensityOffset);
  const adjustFreeRideWatts = useAppStore((s) => s.adjustFreeRideWatts);
  const resetFreeRideOffset = useAppStore((s) => s.resetFreeRideOffset);
  const toggleGraph = useAppStore((s) => s.toggleGraph);
  const toggleAudioMute = useAppStore((s) => s.toggleAudioMute);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setScreen = useAppStore((s) => s.setScreen);

  const isAudioAudible =
    audioEnabled && !audioMuted && audioMasterVolume > 0 && audioRideVolume > 0;

  const isFreeRide = rideMode === 'freeride';
  const freeRideRange = clampFreeRideCenterWatts(freeRideZone, ftp, freeRideOffsetWatts);
  const freeRideZoneInfo = COGGAN_ZONES[freeRideZone];

  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleToggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // Fullscreen may be blocked in embedded iframe
    }
  };

  const offsetText = `${intensityOffsetPct >= 0 ? '+' : ''}${intensityOffsetPct}%`;

  return (
    <footer
      className="neon-frame-cyan rounded-lg px-2.5 py-2 shrink-0 flex flex-wrap items-center justify-between gap-2"
      aria-label="Workout Controls"
    >
      {/* Left: Transport Controls */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={togglePlayPause}
          className={`min-h-[48px] min-w-[106px] px-4 rounded-md font-display text-xs sm:text-sm font-bold tracking-wider uppercase flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
            runState === 'running'
              ? 'bg-amber-500/20 border-2 border-amber-400 text-amber-200 hover:bg-amber-500/30'
              : 'bg-cyan-500/20 border-2 border-cyan-400 text-cyan-100 hover:bg-cyan-500/35'
          }`}
          data-testid="btn-play-pause"
        >
          {runState === 'running' ? (
            <>
              <Pause className="w-4 h-4" />
              Pause
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              {runState === 'paused' ? 'Resume' : 'Start'}
            </>
          )}
        </button>

        {!isFreeRide && (
          <>
            <button
              type="button"
              onClick={previousStep}
              className="min-h-[48px] min-w-[48px] px-2.5 rounded-md bg-[#110e2d] border border-cyan-500/45 text-cyan-200 hover:bg-cyan-500/20 flex items-center justify-center transition-colors shrink-0"
              aria-label="Previous step"
              title="Previous step (Left Arrow)"
              data-testid="btn-prev-step"
            >
              <SkipBack className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={skipStep}
              className="min-h-[48px] min-w-[48px] px-2.5 rounded-md bg-[#110e2d] border border-cyan-500/45 text-cyan-200 hover:bg-cyan-500/20 flex items-center justify-center transition-colors shrink-0"
              aria-label="Skip step"
              title="Skip step (Right Arrow)"
              data-testid="btn-skip-step"
            >
              <SkipForward className="w-5 h-5" />
            </button>
          </>
        )}

        <button
          type="button"
          onClick={endWorkout}
          className="min-h-[48px] px-3 rounded-md bg-rose-500/15 border border-rose-500/55 text-rose-200 hover:bg-rose-500/25 flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-wider transition-colors whitespace-nowrap shrink-0"
          aria-label="End workout"
          data-testid="btn-end-workout"
        >
          <Square className="w-4 h-4" />
          <span className="hidden sm:inline">End</span>
        </button>
      </div>

      {/* Center: Free Ride ±5W Mid-Range Adjuster OR Workout Intensity ±1% */}
      {isFreeRide ? (
        <div className="flex items-center gap-1.5 bg-[#0a0820] border border-pink-500/45 rounded-md p-1">
          <button
            type="button"
            onClick={() => adjustFreeRideWatts(-FREE_RIDE_WATT_STEP)}
            className="min-h-[42px] min-w-[56px] px-2.5 rounded bg-pink-500/15 border border-pink-400/55 text-pink-200 hover:bg-pink-500/30 font-display text-xs font-bold flex items-center justify-center gap-0.5 transition-colors whitespace-nowrap shrink-0"
            aria-label="Decrease Free Ride center by 5 watts"
            title="Decrease center −5 W (Down Arrow)"
            data-testid="btn-freeride-watts-down"
          >
            <Minus className="w-3.5 h-3.5" />
            5 W
          </button>

          <button
            type="button"
            onClick={resetFreeRideOffset}
            className="min-h-[42px] px-3 rounded hover:bg-white/5 flex flex-col items-center justify-center leading-tight"
            title="Click to reset Free Ride mid-range offset to 0 W"
            aria-label={`Free Ride ${freeRideZoneInfo.code} center ${freeRideRange.centerWatts} watts`}
            data-testid="freeride-watts-readout"
          >
            <span className="font-display text-xs font-bold tabular-nums text-pink-300">
              {freeRideZoneInfo.code} · {freeRideRange.centerWatts} W
            </span>
            <span className="text-[11px] font-semibold tabular-nums text-slate-200 whitespace-nowrap">
              {freeRideRange.clampedOffsetWatts >= 0 ? '+' : ''}
              {freeRideRange.clampedOffsetWatts} W ({freeRideRange.minWatts}–{freeRideRange.maxWatts}W)
            </span>
          </button>

          <button
            type="button"
            onClick={() => adjustFreeRideWatts(FREE_RIDE_WATT_STEP)}
            className="min-h-[42px] min-w-[56px] px-2.5 rounded bg-cyan-500/15 border border-cyan-400/55 text-cyan-200 hover:bg-cyan-500/30 font-display text-xs font-bold flex items-center justify-center gap-0.5 transition-colors whitespace-nowrap shrink-0"
            aria-label="Increase Free Ride center by 5 watts"
            title="Increase center +5 W (Up Arrow)"
            data-testid="btn-freeride-watts-up"
          >
            <Plus className="w-3.5 h-3.5" />
            5 W
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 bg-[#0a0820] border border-pink-500/45 rounded-md p-1">
          <button
            type="button"
            onClick={() => adjustIntensity(-1)}
            className="min-h-[42px] min-w-[52px] px-2.5 rounded bg-pink-500/15 border border-pink-400/55 text-pink-200 hover:bg-pink-500/30 font-display text-xs font-bold flex items-center justify-center gap-0.5 transition-colors whitespace-nowrap shrink-0"
            aria-label="Decrease intensity by 1 percent"
            title="Decrease intensity −1% (Down Arrow)"
            data-testid="btn-intensity-down"
          >
            <Minus className="w-3.5 h-3.5" />
            1%
          </button>

          <button
            type="button"
            onClick={resetIntensityOffset}
            className="min-h-[42px] px-3 rounded hover:bg-white/5 flex flex-col items-center justify-center leading-tight"
            title="Click to reset intensity offset to 0%"
            aria-label={`Intensity offset ${offsetText}, effective FTP ${effectiveFtp} watts`}
            data-testid="intensity-readout"
          >
            <span className="font-display text-xs font-bold tabular-nums text-pink-300">
              {offsetText}
            </span>
            <span className="text-[11px] font-semibold tabular-nums text-slate-200 whitespace-nowrap">
              FTP {effectiveFtp} W
            </span>
          </button>

          <button
            type="button"
            onClick={() => adjustIntensity(1)}
            className="min-h-[42px] min-w-[52px] px-2.5 rounded bg-cyan-500/15 border border-cyan-400/55 text-cyan-200 hover:bg-cyan-500/30 font-display text-xs font-bold flex items-center justify-center gap-0.5 transition-colors whitespace-nowrap shrink-0"
            aria-label="Increase intensity by 1 percent"
            title="Increase intensity +1% (Up Arrow)"
            data-testid="btn-intensity-up"
          >
            <Plus className="w-3.5 h-3.5" />
            1%
          </button>
        </div>
      )}

      {/* Right: Utility & Navigation Buttons */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={toggleGraph}
          className={`min-h-[48px] px-3 rounded-md border text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
            showGraph
              ? 'bg-cyan-500/20 border-cyan-400/70 text-cyan-100'
              : 'bg-[#110e2d] border-slate-700 text-slate-300 hover:border-cyan-500/50'
          }`}
          aria-label={showGraph ? 'Hide history graph' : 'Show history graph'}
          data-testid="btn-toggle-graph"
        >
          <Activity className="w-4 h-4" />
          <span className="hidden lg:inline">Graph</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveModal('devices')}
          className={`min-h-[48px] px-3 rounded-md border text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
            trainerStatus.status === 'connected'
              ? 'bg-emerald-500/15 border-emerald-400/55 text-emerald-200 hover:bg-emerald-500/25'
              : 'bg-[#110e2d] border-slate-700 text-slate-300 hover:border-cyan-500/50'
          }`}
          aria-label="Open devices"
          data-testid="btn-open-devices"
        >
          <Bluetooth className="w-4 h-4" />
          <span className="hidden lg:inline">Devices</span>
        </button>

        <button
          type="button"
          onClick={() => setScreen('library')}
          className="min-h-[48px] px-3 rounded-md bg-[#110e2d] border border-cyan-500/40 text-slate-200 hover:bg-cyan-500/15 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          aria-label="Open workout library"
          data-testid="btn-open-library"
        >
          <BookOpen className="w-4 h-4" />
          <span className="hidden lg:inline">Library</span>
        </button>

        <button
          type="button"
          onClick={toggleAudioMute}
          className={`min-h-[48px] min-w-[48px] px-2.5 rounded-md border flex items-center justify-center transition-colors shrink-0 ${
            isAudioAudible
              ? 'bg-cyan-500/20 border-cyan-400/70 text-cyan-100 hover:bg-cyan-500/30'
              : 'bg-[#110e2d] border-slate-700 text-slate-400 hover:border-cyan-500/50 hover:text-slate-200'
          }`}
          aria-label={isAudioAudible ? 'Mute ambient audio' : 'Unmute ambient audio'}
          title="Toggle Ambient Audio (M)"
          data-testid="btn-toggle-audio"
        >
          {isAudioAudible ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => setActiveModal('settings')}
          className="min-h-[48px] px-3 rounded-md bg-[#110e2d] border border-cyan-500/40 text-slate-200 hover:bg-cyan-500/15 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          aria-label="Open settings"
          data-testid="btn-open-settings"
        >
          <Settings className="w-4 h-4" />
          <span className="hidden lg:inline">Settings</span>
        </button>

        <button
          type="button"
          onClick={handleToggleFullscreen}
          className="min-h-[48px] min-w-[48px] px-2.5 rounded-md bg-[#110e2d] border border-cyan-500/40 text-slate-200 hover:bg-cyan-500/15 flex items-center justify-center transition-colors shrink-0"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title="Toggle Fullscreen (F)"
          data-testid="btn-fullscreen"
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>
    </footer>
  );
}
