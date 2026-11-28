import { useMemo } from 'react';
import { Bluetooth, BookOpen, History, Mountain, Play, Route, Settings, SlidersHorizontal, Volume2, VolumeX, Zap } from 'lucide-react';
import { formatClock } from '../core/zones';
import { SceneryTheme, useAppStore } from '../store/useAppStore';
import { getBrowserCompatibility } from '../utils/browserCheck';
import { NeonWorldCanvas } from '../world/NeonWorldCanvas';
import { FtpInput } from './FtpInput';
import { MiniProfileChart } from './MiniProfileChart';

const THEME_OPTIONS: Array<{ id: SceneryTheme; label: string }> = [
  { id: 'neon-city', label: 'Neon City' },
  { id: 'palm-grove', label: 'Palm Grove' },
  { id: 'cloud-horizon', label: 'Cloud Horizon' },
  { id: 'causeway-embankment', label: 'Island Causeway' },
];

export function MainMenu() {
  const activeWorkout = useAppStore((s) => s.activeWorkout);
  const ftp = useAppStore((s) => s.ftp);
  const sceneryTheme = useAppStore((s) => s.sceneryTheme);
  const sceneryCycleMinutes = useAppStore((s) => s.sceneryCycleMinutes);
  const activeGpsRoute = useAppStore((s) => s.activeGpsRoute);
  const trainerStatus = useAppStore((s) => s.trainerStatus);
  const hrStatus = useAppStore((s) => s.hrStatus);
  const savedRidesCount = useAppStore((s) => s.savedRides.length);
  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const audioMuted = useAppStore((s) => s.audioMuted);
  const audioMasterVolume = useAppStore((s) => s.audioMasterVolume);
  const audioMenuVolume = useAppStore((s) => s.audioMenuVolume);

  const setScreen = useAppStore((s) => s.setScreen);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setFtp = useAppStore((s) => s.setFtp);
  const setSceneryTheme = useAppStore((s) => s.setSceneryTheme);
  const startFreeRide = useAppStore((s) => s.startFreeRide);
  const toggleAudioMute = useAppStore((s) => s.toggleAudioMute);

  const isMenuAudioAudible =
    audioEnabled && !audioMuted && audioMasterVolume > 0 && audioMenuVolume > 0;
  const menuEffectivePct = Math.round(audioMasterVolume * audioMenuVolume * 100);

  const compat = useMemo(() => getBrowserCompatibility(), []);

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-[#060412] flex flex-col"
      data-testid="main-menu"
    >
      {/* Live 3D Synthwave Backdrop */}
      <div className="absolute inset-0 pointer-events-none">
        <NeonWorldCanvas demoMode />
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(6,4,18,0.84) 0%, rgba(6,4,18,0.48) 42%, rgba(6,4,18,0.92) 100%)',
          }}
        />
      </div>

      {/* Top Brand Header */}
      <header className="relative z-10 flex items-center px-5 sm:px-8 py-4 border-b border-cyan-500/25 bg-[#070516]/85">
        <span className="font-display text-lg sm:text-2xl font-extrabold tracking-widest text-white text-glow-cyan uppercase whitespace-nowrap shrink-0">
          ENDLESS HORIZON CYCLING
        </span>
      </header>

      {/* Main Content */}
      <main className="relative z-10 flex-1 min-h-0 overflow-y-auto synth-scroll flex flex-col justify-center px-5 sm:px-8 py-6">
        <div className="w-full max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Left Hero Column */}
          <div className="lg:col-span-7 flex flex-col justify-center space-y-5">
            <div>
              <p className="text-xs sm:text-sm font-semibold tracking-[0.2em] text-pink-300 uppercase">
                Indoor ERG Cycling Trainer
              </p>
              <h1
                className="font-display font-extrabold tracking-tight text-white text-glow-cyan mt-2 leading-tight"
                style={{ fontSize: 'clamp(2rem, 4.2vw, 3.35rem)', textWrap: 'balance' }}
              >
                Train Inside the Synthwave Horizon
              </h1>
              <p className="text-base sm:text-lg text-slate-300 mt-3 max-w-xl leading-relaxed">
                Structured ERG interval workouts with real-time Coggan zone illumination,
                3-second power smoothing, and procedural neon worlds tuned for windowed desktop
                and tablet displays.
              </p>
            </div>

            {/* Primary & Secondary Actions */}
            <div className="flex flex-col gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setScreen('ride')}
                  className="min-h-[52px] px-7 rounded-lg bg-gradient-to-r from-cyan-500 to-pink-500 text-slate-950 font-display text-sm font-extrabold tracking-wider uppercase flex items-center gap-2.5 shadow-[0_0_24px_rgba(0,240,255,0.4)] hover:brightness-110 transition-all whitespace-nowrap"
                  data-testid="menu-start-ride"
                >
                  <Play className="w-5 h-5 fill-current" />
                  Ride Workout
                </button>

                <button
                  type="button"
                  onClick={() => startFreeRide(2, false)}
                  className="min-h-[52px] px-5 rounded-lg bg-[#120b2e]/95 border-2 border-pink-400/75 font-display text-xs sm:text-sm font-bold tracking-wider uppercase text-pink-100 hover:bg-pink-500/25 flex items-center gap-2 transition-colors whitespace-nowrap"
                  data-testid="menu-start-freeride"
                >
                  <Mountain className="w-4 h-4 text-pink-300" />
                  Free Ride
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setScreen('library')}
                  className="min-h-[52px] px-5 rounded-lg neon-frame-cyan font-display text-xs sm:text-sm font-bold tracking-wider text-cyan-100 hover:bg-cyan-500/20 flex items-center gap-2 transition-colors whitespace-nowrap"
                  data-testid="menu-open-library"
                >
                  <BookOpen className="w-4 h-4" />
                  Workouts
                </button>

                <button
                  type="button"
                  onClick={() => setActiveModal('rides')}
                  className="min-h-[52px] px-5 rounded-lg neon-frame-cyan font-display text-xs sm:text-sm font-bold tracking-wider text-cyan-100 hover:bg-cyan-500/20 flex items-center gap-2 transition-colors whitespace-nowrap"
                  data-testid="menu-open-saved-rides"
                >
                  <History className="w-4 h-4" />
                  <span>History</span>
                  {savedRidesCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/25 border border-cyan-400/60 font-display text-[11px] font-bold text-cyan-200 tabular-nums">
                      {savedRidesCount}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setActiveModal('devices')}
                  className="min-h-[52px] px-5 rounded-lg bg-[#0d0a24]/90 border border-pink-500/55 font-display text-xs sm:text-sm font-bold tracking-wider text-pink-200 hover:bg-pink-500/20 flex items-center gap-2 transition-colors whitespace-nowrap"
                  data-testid="menu-open-devices"
                >
                  <Bluetooth className="w-4 h-4" />
                  Devices
                </button>
              </div>
            </div>

            {/* Browser & Web Bluetooth Guidance */}
            {!compat.isChromiumDesktopOrAndroid ? (
              <div className="rounded-lg border border-amber-400/60 bg-amber-950/50 px-4 py-3 text-sm text-amber-100">
                You are running {compat.browserLabel}. Endless Horizon Cycling is designed for{' '}
                <strong>Google Chrome or Microsoft Edge</strong> on Windows and Chrome on Android.
                Simulation mode works everywhere, while Web Bluetooth hardware control requires
                Chrome or Edge over HTTPS or localhost.
              </div>
            ) : (
              <p className="text-xs sm:text-sm text-slate-400">
                Stage 1 Simulation Active · Simulated KICKR V4 (FTMS ERG) &amp; HRM ready ·
                Web Bluetooth requires Chrome or Edge on localhost or HTTPS.
              </p>
            )}
          </div>

          {/* Right Column: Selected Workout & Quick Setup Card */}
          <div className="lg:col-span-5 neon-frame-hud rounded-xl p-5 flex flex-col justify-between gap-4">
            <div>
              <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                <span className="font-display tracking-[0.15em] text-cyan-300 uppercase">
                  Ready Workout
                </span>
                <span>
                  {formatClock(activeWorkout.totalDuration)} · {activeWorkout.estimatedTss} TSS
                </span>
              </div>

              <h2 className="font-display text-lg font-bold text-white mt-1.5 leading-snug">
                {activeWorkout.name}
              </h2>
              <p className="text-sm text-slate-400 mt-0.5">
                by {activeWorkout.author}
                {activeWorkout.tags.length > 0 ? ` · ${activeWorkout.tags.join(' · ')}` : ''}
              </p>

              <div className="mt-3">
                <MiniProfileChart workout={activeWorkout} ftp={ftp} height={86} />
              </div>
            </div>

            {/* Quick FTP & World Theme Switcher */}
            <div className="space-y-3 border-t border-cyan-500/25 pt-3.5">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="menu-ftp-input" className="text-xs font-bold tracking-[0.14em] text-slate-300 uppercase flex items-center gap-1.5">
                  <Zap className="w-4 h-4 text-cyan-300" />
                  Rider FTP (W)
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setFtp(ftp - 5)}
                    className="w-11 h-11 rounded bg-[#120e30] border border-cyan-500/45 text-cyan-200 font-display font-bold hover:bg-cyan-500/20"
                    aria-label="Decrease FTP by 5 watts"
                  >
                    −
                  </button>
                  <FtpInput
                    id="menu-ftp-input"
                    value={ftp}
                    onChange={setFtp}
                    data-testid="menu-ftp-input"
                    className="w-20 h-11 rounded bg-[#070516] border border-cyan-400/60 text-center font-display text-base font-bold tabular-nums text-white focus:outline-none focus:border-cyan-300"
                  />
                  <button
                    type="button"
                    onClick={() => setFtp(ftp + 5)}
                    className="w-11 h-11 rounded bg-[#120e30] border border-cyan-500/45 text-cyan-200 font-display font-bold hover:bg-cyan-500/20"
                    aria-label="Increase FTP by 5 watts"
                  >
                    +
                  </button>
                </div>
              </div>

              <div>
                <div className="text-xs font-bold tracking-[0.14em] text-slate-300 uppercase mb-1.5 flex items-center gap-1.5">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-pink-300" />
                  Scenery World
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setSceneryTheme(opt.id)}
                      className={`min-h-[44px] px-2 rounded text-xs font-bold tracking-wide transition-colors border whitespace-nowrap ${
                        sceneryTheme === opt.id
                          ? 'bg-pink-500/25 border-pink-400 text-white'
                          : 'bg-[#0b0920] border-slate-700/70 text-slate-300 hover:border-cyan-400/50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setActiveModal('settings')}
                data-testid="menu-gps-route-summary"
                className="w-full min-h-[42px] px-3 rounded-md bg-[#0b0920] border border-cyan-500/35 hover:border-cyan-400/70 flex items-center justify-between gap-2 text-xs transition-colors"
              >
                <span className="flex items-center gap-1.5 text-slate-300 truncate">
                  <Route className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
                  <span className="truncate">
                    GPS Route:{' '}
                    <strong className="text-cyan-200">
                      {activeGpsRoute
                        ? `${activeGpsRoute.name} · ${(activeGpsRoute.totalLengthM / 1000).toFixed(0)} km`
                        : 'Ura-shima Loop'}
                    </strong>
                  </span>
                </span>
                <span className="text-[11px] font-display text-pink-300 shrink-0">
                  {sceneryCycleMinutes > 0 ? `Cycle ${sceneryCycleMinutes}m` : 'Change'}
                </span>
              </button>

              <div className="flex items-center justify-between text-xs text-slate-300 border-t border-cyan-500/20 pt-2.5">
                <span>
                  Trainer:{' '}
                  <strong className={trainerStatus.status === 'connected' ? 'text-emerald-300' : 'text-amber-300'}>
                    {trainerStatus.status === 'connected' ? 'Simulated ERG Ready' : 'Disconnected'}
                  </strong>
                </span>
                <span>
                  HRM:{' '}
                  <strong className={hrStatus.status === 'connected' ? 'text-emerald-300' : 'text-amber-300'}>
                    {hrStatus.status === 'connected' ? 'Connected' : 'Disconnected'}
                  </strong>
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={toggleAudioMute}
                className={`min-h-[44px] px-3 rounded-md border text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
                  isMenuAudioAudible
                    ? 'bg-cyan-500/15 border-cyan-400/65 text-cyan-100 hover:bg-cyan-500/25'
                    : 'bg-[#110e2d] border-slate-700 text-slate-300 hover:border-cyan-500/45'
                }`}
                aria-label={isMenuAudioAudible ? 'Mute synthwave audio' : 'Unmute synthwave audio'}
                data-testid="menu-audio-toggle"
              >
                {isMenuAudioAudible ? <Volume2 className="w-4 h-4 text-cyan-300" /> : <VolumeX className="w-4 h-4 text-slate-400" />}
                <span>
                  {isMenuAudioAudible
                    ? `Synthwave · ${menuEffectivePct}%`
                    : !audioEnabled
                      ? 'Audio OFF'
                      : 'Audio Muted'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveModal('settings')}
                className="min-h-[44px] px-3 rounded-md bg-[#110e2d] border border-cyan-500/35 text-xs font-bold uppercase tracking-wider text-slate-200 hover:bg-cyan-500/15 flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                data-testid="menu-open-settings"
              >
                <Settings className="w-4 h-4" />
                Settings &amp; Audio
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
