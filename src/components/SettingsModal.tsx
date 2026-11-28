import { ChangeEvent, useRef, useState } from 'react';
import {
  Gauge,
  Keyboard,
  Layers,
  Monitor,
  Music2,
  RefreshCw,
  Route,
  Sliders,
  Square,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { MusicZone, ZONE_BPM } from '../audio/musicEngineLogic';
import {
  BIKE_LINE_ART_POINTS,
  GPS_ROUTE_PRESETS,
  GpsRoutePresetId,
} from '../recording/gpsRoutes';
import { traceImageFileToNormalizedPath } from '../recording/lineArtTracer';
import {
  QualityLevel,
  SceneryCycleMinutes,
  SceneryTheme,
  useAppStore,
} from '../store/useAppStore';
import { FtpInput } from './FtpInput';
import { GpsRoutePreviewSvg } from './GpsRoutePreviewSvg';
import { PWAInstallButton } from './PWAInstallButton';

const SCENERY_OPTIONS: Array<{ id: SceneryTheme; title: string; subtitle: string }> = [
  {
    id: 'neon-city',
    title: 'Neon City',
    subtitle: 'Striped pink/orange sun, lit skyscrapers, wide sidewalks, purple ground mist',
  },
  {
    id: 'palm-grove',
    title: 'Palm Grove',
    subtitle: 'Cyan & pink low-poly palms, level neon grid floor, wireframe mountains, striped sun',
  },
  {
    id: 'cloud-horizon',
    title: 'Cloud Horizon',
    subtitle: 'White-cyan sun orb, digital rain streaks, 2D sunset cloud sprites, blue horizon grid',
  },
  {
    id: 'causeway-embankment',
    title: 'Island Causeway',
    subtitle: 'Raised stone sea embankment inspired by Lüttmoorsiel–Nordstrandischmoor, tidal water & timber groynes',
  },
];

const QUALITY_OPTIONS: Array<{ id: QualityLevel; label: string; desc: string }> = [
  { id: 'low', label: 'Low', desc: 'Max FPS · No bloom, streaks, or glossy reflections' },
  { id: 'medium', label: 'Medium', desc: 'Balanced · Bloom + streaks, reduced density' },
  { id: 'high', label: 'High', desc: 'Full Synthwave · Reflections, bloom, aberration & streaks' },
];

const SCENERY_CYCLE_OPTIONS: Array<{ value: SceneryCycleMinutes; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
];

const GPS_DISTANCE_OPTIONS: Array<{ km: number; label: string }> = [
  { km: 0, label: 'Auto Fit' },
  { km: 5, label: '5 km' },
  { km: 10, label: '10 km' },
  { km: 15, label: '15 km' },
  { km: 20, label: '20 km' },
  { km: 30, label: '30 km' },
];

const MUSIC_TEST_ZONES: Array<{ zone: MusicZone; label: string; desc: string }> = [
  { zone: 1, label: 'Z1', desc: 'Warm detuned pad, sparse soft arp, closed filter & large reverb' },
  { zone: 2, label: 'Z2', desc: 'Adds root-note bass, soft kick & filtered shaker' },
  { zone: 3, label: 'Z3', desc: 'Adds 4-on-floor kick, beats 2/4 claps, off-beat hats & 16th pluck arp' },
  { zone: 4, label: 'Z4', desc: 'Adds driving 8th bass, open hats, lead melody, open filter & sidechain pump' },
  { zone: 5, label: 'Z5', desc: 'Adds 16th bass, snare rolls, bright supersaw lead, high arp & saturation' },
];

export function SettingsModal() {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const ftp = useAppStore((s) => s.ftp);
  const setFtp = useAppStore((s) => s.setFtp);
  const sceneryTheme = useAppStore((s) => s.sceneryTheme);
  const setSceneryTheme = useAppStore((s) => s.setSceneryTheme);
  const sceneryCycleMinutes = useAppStore((s) => s.sceneryCycleMinutes);
  const setSceneryCycleMinutes = useAppStore((s) => s.setSceneryCycleMinutes);
  const gpsRoutePreset = useAppStore((s) => s.gpsRoutePreset);
  const setGpsRoutePreset = useAppStore((s) => s.setGpsRoutePreset);
  const gpsRouteTargetKm = useAppStore((s) => s.gpsRouteTargetKm);
  const setGpsRouteTargetKm = useAppStore((s) => s.setGpsRouteTargetKm);
  const customGpsRouteName = useAppStore((s) => s.customGpsRouteName);
  const customGpsRoutePoints = useAppStore((s) => s.customGpsRoutePoints);
  const setCustomGpsRoute = useAppStore((s) => s.setCustomGpsRoute);
  const activeGpsRoute = useAppStore((s) => s.activeGpsRoute);
  const quality = useAppStore((s) => s.quality);
  const qualityOverride = useAppStore((s) => s.qualityOverride);
  const autoDetectedQuality = useAppStore((s) => s.autoDetectedQuality);
  const autoQualityReason = useAppStore((s) => s.autoQualityReason);
  const setQuality = useAppStore((s) => s.setQuality);
  const setQualityAuto = useAppStore((s) => s.setQualityAuto);
  const minimalMode = useAppStore((s) => s.minimalMode);
  const setMinimalMode = useAppStore((s) => s.setMinimalMode);
  const showDiagnostics = useAppStore((s) => s.showDiagnostics);
  const setShowDiagnostics = useAppStore((s) => s.setShowDiagnostics);
  const showHoloCards = useAppStore((s) => s.showHoloCards);
  const setShowHoloCards = useAppStore((s) => s.setShowHoloCards);
  const showFps = useAppStore((s) => s.showFps);
  const setShowFps = useAppStore((s) => s.setShowFps);
  const showGraph = useAppStore((s) => s.showGraph);
  const setShowGraph = useAppStore((s) => s.setShowGraph);
  const autoPauseEnabled = useAppStore((s) => s.autoPauseEnabled);
  const setAutoPauseEnabled = useAppStore((s) => s.setAutoPauseEnabled);
  const cadenceMatchingEnabled = useAppStore((s) => s.cadenceMatchingEnabled);
  const setCadenceMatchingEnabled = useAppStore((s) => s.setCadenceMatchingEnabled);
  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const setAudioEnabled = useAppStore((s) => s.setAudioEnabled);
  const audioMuted = useAppStore((s) => s.audioMuted);
  const toggleAudioMute = useAppStore((s) => s.toggleAudioMute);
  const audioMasterVolume = useAppStore((s) => s.audioMasterVolume);
  const setAudioMasterVolume = useAppStore((s) => s.setAudioMasterVolume);
  const audioMenuVolume = useAppStore((s) => s.audioMenuVolume);
  const setAudioMenuVolume = useAppStore((s) => s.setAudioMenuVolume);
  const audioRideVolume = useAppStore((s) => s.audioRideVolume);
  const setAudioRideVolume = useAppStore((s) => s.setAudioRideVolume);
  const musicFollowMode = useAppStore((s) => s.musicFollowMode);
  const setMusicFollowMode = useAppStore((s) => s.setMusicFollowMode);
  const musicTestZone = useAppStore((s) => s.musicTestZone);
  const setMusicTestZone = useAppStore((s) => s.setMusicTestZone);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleLineArtUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError(null);
    setUploadStatus('Tracing line drawing into 1:1 GPS route...');
    try {
      const traced = await traceImageFileToNormalizedPath(file);
      const baseName = file.name.replace(/\.[^.]+$/, '').trim() || 'Custom Drawing';
      setCustomGpsRoute(baseName, traced.points, traced.closedLoop);
      setUploadStatus(
        `Traced "${baseName}" (${traced.points.length} GPS waypoints, ${Math.round(traced.edgeCoverage * 100)}% stroke coverage)`
      );
    } catch (err) {
      setUploadStatus(null);
      setUploadError(
        err instanceof Error ? err.message : 'Could not trace drawing. Try a crisp dark-on-light line image.'
      );
    }
  };

  const previewPoints =
    gpsRoutePreset === 'custom-drawing' && customGpsRoutePoints.length >= 2
      ? customGpsRoutePoints
      : gpsRoutePreset === 'bike-line-art'
        ? BIKE_LINE_ART_POINTS
        : null;

  const isAudioAudible = audioEnabled && !audioMuted && audioMasterVolume > 0;
  const masterPct = Math.round(audioMasterVolume * 100);
  const menuPct = Math.round(audioMenuVolume * 100);
  const ridePct = Math.round(audioRideVolume * 100);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      data-testid="settings-modal"
    >
      <div className="neon-frame-hud rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cyan-500/30 shrink-0">
          <div className="flex items-center gap-2.5">
            <Sliders className="w-5 h-5 text-cyan-300" />
            <h2 id="settings-modal-title" className="font-display text-lg font-bold text-white uppercase tracking-wider">
              Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              setMusicTestZone(null);
              setActiveModal(null);
            }}
            className="w-12 h-12 rounded-md border border-cyan-500/40 text-slate-200 hover:bg-cyan-500/20 flex items-center justify-center"
            aria-label="Close settings dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="synth-scroll flex-1 overflow-y-auto p-5 space-y-6">
          {/* Rider FTP */}
          <section className="space-y-2">
            <label htmlFor="settings-ftp-input" className="font-display text-xs font-bold tracking-[0.16em] text-cyan-300 uppercase flex items-center gap-2">
              <Gauge className="w-4 h-4" />
              Functional Threshold Power (FTP)
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFtp(ftp - 5)}
                className="min-h-[48px] min-w-[52px] rounded-md bg-[#110e2d] border border-cyan-500/45 font-display text-sm font-bold text-cyan-200 hover:bg-cyan-500/20"
              >
                −5
              </button>
              <FtpInput
                id="settings-ftp-input"
                value={ftp}
                onChange={setFtp}
                className="min-h-[48px] w-28 rounded-md bg-[#070516] border-2 border-cyan-400/70 text-center font-display text-lg font-bold tabular-nums text-white focus:outline-none focus:border-cyan-300"
                data-testid="settings-ftp-input"
              />
              <button
                type="button"
                onClick={() => setFtp(ftp + 5)}
                className="min-h-[48px] min-w-[52px] rounded-md bg-[#110e2d] border border-cyan-500/45 font-display text-sm font-bold text-cyan-200 hover:bg-cyan-500/20"
              >
                +5
              </button>
              <span className="text-sm text-slate-300 ml-1">
                Watts (persisted locally · updates all step targets immediately)
              </span>
            </div>
          </section>

          {/* Synthwave Ambient Audio */}
          <section className="space-y-3" data-testid="settings-audio-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-xs font-bold tracking-[0.16em] text-cyan-300 uppercase flex items-center gap-2">
                {isAudioAudible ? <Volume2 className="w-4 h-4 text-cyan-300" /> : <VolumeX className="w-4 h-4 text-slate-400" />}
                Synthwave Ambient Audio
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleAudioMute}
                  className={`min-h-[40px] px-3 rounded-md font-display text-xs font-bold border flex items-center gap-1.5 transition-colors ${
                    audioMuted || !audioEnabled
                      ? 'bg-[#070516] border-slate-600 text-slate-300 hover:border-cyan-400/50'
                      : 'bg-pink-500/20 border-pink-400/75 text-pink-100 hover:bg-pink-500/30'
                  }`}
                  data-testid="settings-audio-mute"
                >
                  {audioMuted || !audioEnabled ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                  {audioMuted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={audioEnabled}
                  onClick={() => setAudioEnabled(!audioEnabled)}
                  className={`min-h-[40px] min-w-[74px] px-3 rounded-md font-display text-xs font-bold border transition-colors ${
                    audioEnabled
                      ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                      : 'bg-[#070516] border-slate-600 text-slate-400'
                  }`}
                  data-testid="toggle-audio-enabled"
                >
                  {audioEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>

            <div className={`rounded-lg bg-[#0a0820] border border-cyan-500/30 p-4 space-y-3.5 transition-opacity ${audioEnabled ? 'opacity-100' : 'opacity-55'}`}>
              {/* Master Volume */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="slider-master-volume" className="font-semibold text-white">
                    Master Volume
                  </label>
                  <span className="font-display font-bold tabular-nums text-cyan-300" data-testid="readout-master-volume">
                    {masterPct}%
                  </span>
                </div>
                <input
                  id="slider-master-volume"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={masterPct}
                  disabled={!audioEnabled}
                  onChange={(e) => setAudioMasterVolume(Number(e.target.value) / 100)}
                  aria-label="Master volume"
                  data-testid="slider-master-volume"
                  className="w-full h-2.5 rounded-lg bg-[#161238] accent-cyan-400 cursor-pointer disabled:cursor-not-allowed"
                />
              </div>

              {/* Main Menu Volume */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="slider-menu-volume" className="font-semibold text-slate-200">
                    Main Menu Volume
                  </label>
                  <span className="font-display font-bold tabular-nums text-pink-300" data-testid="readout-menu-volume">
                    {menuPct}%
                  </span>
                </div>
                <input
                  id="slider-menu-volume"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={menuPct}
                  disabled={!audioEnabled}
                  onChange={(e) => setAudioMenuVolume(Number(e.target.value) / 100)}
                  aria-label="Main menu volume"
                  data-testid="slider-menu-volume"
                  className="w-full h-2.5 rounded-lg bg-[#161238] accent-pink-400 cursor-pointer disabled:cursor-not-allowed"
                />
              </div>

              {/* Ride Volume */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="slider-ride-volume" className="font-semibold text-slate-200">
                    Ride Volume
                  </label>
                  <span className="font-display font-bold tabular-nums text-cyan-300" data-testid="readout-ride-volume">
                    {ridePct}%
                  </span>
                </div>
                <input
                  id="slider-ride-volume"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={ridePct}
                  disabled={!audioEnabled}
                  onChange={(e) => setAudioRideVolume(Number(e.target.value) / 100)}
                  aria-label="Ride volume"
                  data-testid="slider-ride-volume"
                  className="w-full h-2.5 rounded-lg bg-[#161238] accent-cyan-400 cursor-pointer disabled:cursor-not-allowed"
                />
              </div>

              {/* Music Follows: Target Power vs Actual Power (3s avg) */}
              <div className="pt-2 border-t border-cyan-500/20 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-white">Music Follows</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={!audioEnabled}
                      onClick={() => setMusicFollowMode('target')}
                      data-testid="music-follow-target"
                      className={`min-h-[36px] px-3 rounded-md font-display text-xs font-bold border transition-colors disabled:cursor-not-allowed ${
                        musicFollowMode === 'target'
                          ? 'bg-cyan-500/25 border-cyan-400 text-white'
                          : 'bg-[#070516] border-slate-700 text-slate-300 hover:border-cyan-400/50'
                      }`}
                    >
                      Target Power
                    </button>
                    <button
                      type="button"
                      disabled={!audioEnabled}
                      onClick={() => setMusicFollowMode('actual')}
                      data-testid="music-follow-actual"
                      className={`min-h-[36px] px-3 rounded-md font-display text-xs font-bold border transition-colors disabled:cursor-not-allowed ${
                        musicFollowMode === 'actual'
                          ? 'bg-pink-500/25 border-pink-400 text-white'
                          : 'bg-[#070516] border-slate-700 text-slate-300 hover:border-pink-400/50'
                      }`}
                    >
                      Actual Power (3s Avg)
                    </button>
                  </div>
                </div>
              </div>

              {/* Adaptive Music Zone Test Panel (Z1..Z5) */}
              <div className="pt-2 border-t border-cyan-500/20 space-y-2" data-testid="music-test-panel">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <Music2 className="w-3.5 h-3.5 text-pink-300" />
                    Test Adaptive Music Zones (A Minor · Tone.js)
                  </span>
                  {musicTestZone !== null && (
                    <button
                      type="button"
                      onClick={() => setMusicTestZone(null)}
                      data-testid="music-test-stop"
                      className="min-h-[30px] px-2.5 rounded bg-pink-500/20 border border-pink-400/70 text-pink-100 hover:bg-pink-500/35 font-display text-[11px] font-bold flex items-center gap-1"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      Stop Test
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-5 gap-1.5">
                  {MUSIC_TEST_ZONES.map((item) => {
                    const active = musicTestZone === item.zone;
                    return (
                      <button
                        key={item.zone}
                        type="button"
                        disabled={!audioEnabled}
                        onClick={() => setMusicTestZone(active ? null : item.zone)}
                        data-testid={`music-test-z${item.zone}`}
                        className={`min-h-[44px] py-1.5 px-1 rounded-md border font-display text-center transition-colors disabled:cursor-not-allowed ${
                          active
                            ? 'bg-pink-500/30 border-pink-400 text-white shadow-[0_0_12px_rgba(255,42,157,0.35)]'
                            : 'bg-[#070516] border-slate-700 text-slate-200 hover:border-cyan-400/60'
                        }`}
                      >
                        <div className="text-xs font-extrabold">{item.label}</div>
                        <div className="text-[10px] tabular-nums text-cyan-300/90">
                          {ZONE_BPM[item.zone]} BPM
                        </div>
                      </button>
                    );
                  })}
                </div>

                <p className="text-[11px] text-slate-300/90 leading-snug" data-testid="music-test-description">
                  {musicTestZone !== null
                    ? `Auditioning Z${musicTestZone} (${ZONE_BPM[musicTestZone]} BPM): ${MUSIC_TEST_ZONES[musicTestZone - 1].desc}`
                    : 'Click Z1–Z5 to preview each procedural synthwave layer without riding. Menu music crossfades into adaptive ride music automatically; press M to mute.'}
                </p>
              </div>
            </div>
          </section>

          {/* Scenery Theme */}
          <section className="space-y-2.5">
            <h3 className="font-display text-xs font-bold tracking-[0.16em] text-pink-300 uppercase flex items-center gap-2">
              <Layers className="w-4 h-4" />
              3D Scenery Theme
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {SCENERY_OPTIONS.map((opt) => {
                const active = sceneryTheme === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSceneryTheme(opt.id)}
                    className={`min-h-[92px] p-3.5 rounded-lg border-2 text-left transition-colors ${
                      active
                        ? 'bg-pink-500/20 border-pink-400 text-white shadow-[0_0_16px_rgba(255,42,157,0.28)]'
                        : 'bg-[#0a0820] border-slate-700/80 text-slate-300 hover:border-cyan-400/50'
                    }`}
                    data-testid={`theme-btn-${opt.id}`}
                  >
                    <div className="font-display text-sm font-bold">{opt.title}</div>
                    <p className="text-xs text-slate-300/85 mt-1 leading-snug">{opt.subtitle}</p>
                  </button>
                );
              })}
            </div>
            {/* Seamless Mid-Ride Scenery Auto-Cycle */}
            <div className="rounded-lg bg-[#0a0820] border border-pink-500/30 p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-bold text-white">
                  <RefreshCw className="w-3.5 h-3.5 text-pink-300" />
                  Auto-Switch Scenery Mid-Ride
                </div>
                <div className="flex items-center gap-1.5">
                  {SCENERY_CYCLE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSceneryCycleMinutes(opt.value)}
                      data-testid={`scenery-cycle-${opt.value}`}
                      className={`min-h-[36px] px-2.5 rounded-md font-display text-xs font-bold border transition-colors ${
                        sceneryCycleMinutes === opt.value
                          ? 'bg-pink-500/25 border-pink-400 text-white'
                          : 'bg-[#070516] border-slate-700 text-slate-300 hover:border-cyan-400/50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-snug">
                Seamlessly transitions to the next 3D world through a horizon mist veil without dropping frames.
              </p>
            </div>
          </section>

          {/* GPS Art Line-Drawing Route & In-Game Corners */}
          <section className="space-y-3" data-testid="settings-gps-route-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-xs font-bold tracking-[0.16em] text-cyan-300 uppercase flex items-center gap-2">
                <Route className="w-4 h-4" />
                GPS Art Route &amp; In-Game Corners
              </h3>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.svg,.webp,image/*"
                  onChange={handleLineArtUpload}
                  className="hidden"
                  data-testid="gps-route-file-input"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="btn-upload-line-drawing"
                  className="min-h-[38px] px-3 rounded-md bg-cyan-500/20 border border-cyan-400/75 text-cyan-100 hover:bg-cyan-500/30 font-display text-xs font-bold flex items-center gap-1.5 transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Upload Line Drawing
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {GPS_ROUTE_PRESETS.map((preset) => {
                const active = gpsRoutePreset === preset.id;
                const isCustomEmpty =
                  preset.id === 'custom-drawing' && customGpsRoutePoints.length < 2;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      if (isCustomEmpty) {
                        fileInputRef.current?.click();
                      } else {
                        setGpsRoutePreset(preset.id as GpsRoutePresetId);
                      }
                    }}
                    data-testid={`gps-preset-${preset.id}`}
                    className={`min-h-[78px] p-3 rounded-lg border-2 text-left transition-colors ${
                      active
                        ? 'bg-cyan-500/20 border-cyan-400 text-white shadow-[0_0_14px_rgba(0,240,255,0.25)]'
                        : 'bg-[#0a0820] border-slate-700/80 text-slate-300 hover:border-cyan-400/50'
                    }`}
                  >
                    <div className="font-display text-xs font-bold">
                      {preset.id === 'custom-drawing' && customGpsRouteName
                        ? customGpsRouteName
                        : preset.name}
                    </div>
                    <p className="text-[11px] text-slate-300/80 mt-1 leading-tight">
                      {preset.subtitle}
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Distance scale + Live 1:1 GPS Plot Preview */}
            <div className="rounded-lg bg-[#0a0820] border border-cyan-500/30 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-200">
                  Drawing Scale Distance
                  {activeGpsRoute ? (
                    <span className="text-cyan-300 font-display ml-1.5 tabular-nums">
                      ({(activeGpsRoute.totalLengthM / 1000).toFixed(1)} km)
                    </span>
                  ) : null}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {GPS_DISTANCE_OPTIONS.map((opt) => (
                    <button
                      key={opt.km}
                      type="button"
                      onClick={() => setGpsRouteTargetKm(opt.km)}
                      data-testid={`gps-dist-${opt.km}`}
                      className={`min-h-[34px] px-2.5 rounded font-display text-[11px] font-bold border transition-colors ${
                        gpsRouteTargetKm === opt.km
                          ? 'bg-cyan-500/25 border-cyan-400 text-white'
                          : 'bg-[#070516] border-slate-700 text-slate-300 hover:border-cyan-400/50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {previewPoints ? (
                <div
                  className="rounded-md border border-cyan-500/25 bg-[#060414] p-2"
                  data-testid="settings-gps-preview"
                >
                  <GpsRoutePreviewSvg
                    points={previewPoints}
                    height={96}
                    label="1:1 GPS Art route preview"
                  />
                </div>
              ) : (
                <div className="rounded-md border border-cyan-500/20 bg-[#060414] px-3 py-3 text-xs text-slate-400 text-center">
                  Classic Ura-shima coastal GPS loop active (~4.4 km repeating laps with gentle road sweep).
                </div>
              )}

              {uploadStatus && (
                <p className="text-xs text-emerald-300 font-medium">{uploadStatus}</p>
              )}
              {uploadError && (
                <p className="text-xs text-pink-300 font-medium">{uploadError}</p>
              )}
              <p className="text-[11px] text-slate-400 leading-snug">
                Recorded .FIT GPS coordinates match the line drawing 1:1 on Strava. In-game 3D corners mirror the straights and turns while softening tiny-radius 180° hairpins into sharp, rideable bends.
              </p>
            </div>
          </section>

          {/* Graphics Quality & Adaptive Governor */}
          <section className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-xs font-bold tracking-[0.16em] text-cyan-300 uppercase flex items-center gap-2">
                <Monitor className="w-4 h-4" />
                Graphics Quality
              </h3>
              <span className="text-[11px] text-slate-400">
                {qualityOverride === null
                  ? `Auto (${autoDetectedQuality.toUpperCase()}) · ${autoQualityReason}`
                  : `Manual override · Adaptive governor active`}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                type="button"
                onClick={setQualityAuto}
                className={`min-h-[68px] p-3 rounded-lg border text-left transition-colors ${
                  qualityOverride === null
                    ? 'bg-emerald-500/20 border-emerald-400 text-white'
                    : 'bg-[#0a0820] border-slate-700/80 text-slate-300 hover:border-cyan-400/50'
                }`}
                data-testid="quality-btn-auto"
              >
                <div className="font-display text-sm font-bold">
                  Auto ({autoDetectedQuality[0].toUpperCase() + autoDetectedQuality.slice(1)})
                </div>
                <div className="text-[11px] text-slate-300/80 mt-0.5 leading-tight">
                  Hardware + benchmark detected, degrades automatically if slow
                </div>
              </button>
              {QUALITY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setQuality(opt.id)}
                  className={`min-h-[68px] p-3 rounded-lg border text-left transition-colors ${
                    qualityOverride === opt.id
                      ? 'bg-cyan-500/20 border-cyan-400 text-white'
                      : 'bg-[#0a0820] border-slate-700/80 text-slate-300 hover:border-cyan-400/50'
                  }`}
                  data-testid={`quality-btn-${opt.id}`}
                >
                  <div className="font-display text-sm font-bold">{opt.label}</div>
                  <div className="text-[11px] text-slate-300/80 mt-0.5 leading-tight">{opt.desc}</div>
                </button>
              ))}
            </div>
          </section>

          {/* Ride & Display Toggles */}
          <section className="space-y-2">
            <div className="flex items-center justify-between p-3.5 rounded-lg bg-[#0a0820] border border-emerald-400/35">
              <div>
                <div className="text-sm font-bold text-white">Cadence Matching (3D Cyclist RPM)</div>
                <div className="text-xs text-slate-400">
                  Matches the 3D cyclist crank and leg speed 1:1 to your connected Bluetooth cadence sensor
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={cadenceMatchingEnabled}
                onClick={() => setCadenceMatchingEnabled(!cadenceMatchingEnabled)}
                className={`min-h-[48px] min-w-[78px] px-3 rounded-md font-display text-xs font-bold border ${
                  cadenceMatchingEnabled
                    ? 'bg-emerald-500/25 border-emerald-400 text-emerald-100'
                    : 'bg-[#070516] border-slate-600 text-slate-400'
                }`}
                data-testid="toggle-cadence-matching"
              >
                {cadenceMatchingEnabled ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="flex items-center justify-between p-3.5 rounded-lg bg-[#0a0820] border border-pink-500/35">
              <div>
                <div className="text-sm font-bold text-white">Auto-Pause When Pedalling Stops (5s)</div>
                <div className="text-xs text-slate-400">
                  Automatically pauses after 5 seconds at 0 W and 0 rpm, and resumes when you pedal again
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoPauseEnabled}
                onClick={() => setAutoPauseEnabled(!autoPauseEnabled)}
                className={`min-h-[48px] min-w-[78px] px-3 rounded-md font-display text-xs font-bold border ${
                  autoPauseEnabled
                    ? 'bg-pink-500/25 border-pink-400 text-pink-100'
                    : 'bg-[#070516] border-slate-600 text-slate-400'
                }`}
                data-testid="toggle-auto-pause"
              >
                {autoPauseEnabled ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="flex items-center justify-between p-3.5 rounded-lg bg-[#0a0820] border border-cyan-500/25">
              <div>
                <div className="text-sm font-bold text-white">In-World Holographic Data Cards</div>
                <div className="text-xs text-slate-400">
                  Floating CADENCE, SPEED, % FTP, and TARGET cards beside the cyclist
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showHoloCards}
                onClick={() => setShowHoloCards(!showHoloCards)}
                className={`min-h-[44px] min-w-[78px] px-3 rounded-md font-display text-xs font-bold border ${
                  showHoloCards
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                    : 'bg-[#070516] border-slate-600 text-slate-400'
                }`}
                data-testid="toggle-holo-cards"
              >
                {showHoloCards ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="flex items-center justify-between p-3.5 rounded-lg bg-[#0a0820] border border-cyan-500/25">
              <div>
                <div className="text-sm font-bold text-white">HUD-Only Minimal Mode (Phones)</div>
                <div className="text-xs text-slate-400">
                  Unmounts the 3D WebGL world for maximum battery life while keeping ERG, graph, and FIT recording
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={minimalMode}
                onClick={() => setMinimalMode(!minimalMode)}
                className={`min-h-[44px] min-w-[78px] px-3 rounded-md font-display text-xs font-bold border ${
                  minimalMode
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                    : 'bg-[#070516] border-slate-600 text-slate-400'
                }`}
                data-testid="toggle-minimal-mode"
              >
                {minimalMode ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="flex items-center justify-between p-3.5 rounded-lg bg-[#0a0820] border border-cyan-500/25">
              <div>
                <div className="text-sm font-bold text-white">Show FPS Counter</div>
                <div className="text-xs text-slate-400">
                  Displays real-time frame rate inside the 3D viewport corner
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showFps}
                onClick={() => setShowFps(!showFps)}
                className={`min-h-[44px] min-w-[78px] px-3 rounded-md font-display text-xs font-bold border ${
                  showFps
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                    : 'bg-[#070516] border-slate-600 text-slate-400'
                }`}
                data-testid="toggle-fps"
              >
                {showFps ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="flex items-center justify-between p-3.5 rounded-lg bg-[#0a0820] border border-cyan-500/25">
              <div>
                <div className="text-sm font-bold text-white">Performance Diagnostics Overlay</div>
                <div className="text-xs text-slate-400">
                  Shows frame time, long-task count, max sample gap, and step-to-ERG write latency
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showDiagnostics}
                onClick={() => setShowDiagnostics(!showDiagnostics)}
                className={`min-h-[44px] min-w-[78px] px-3 rounded-md font-display text-xs font-bold border ${
                  showDiagnostics
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                    : 'bg-[#070516] border-slate-600 text-slate-400'
                }`}
                data-testid="toggle-diagnostics"
              >
                {showDiagnostics ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="flex items-center justify-between p-3.5 rounded-lg bg-[#0a0820] border border-cyan-500/25">
              <div>
                <div className="text-sm font-bold text-white">Power &amp; Heart Rate History Graph</div>
                <div className="text-xs text-slate-400">
                  Show scrolling dual-axis telemetry graph below the 3D world
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showGraph}
                onClick={() => setShowGraph(!showGraph)}
                className={`min-h-[44px] min-w-[78px] px-3 rounded-md font-display text-xs font-bold border ${
                  showGraph
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                    : 'bg-[#070516] border-slate-600 text-slate-400'
                }`}
              >
                {showGraph ? 'ON' : 'OFF'}
              </button>
            </div>
          </section>

          {/* Installable Offline App (PWA) */}
          <section className="rounded-lg bg-[#09071a] border border-cyan-500/30 p-3.5 space-y-2.5" data-testid="settings-pwa-section">
            <div className="flex items-center justify-between gap-2">
              <div className="font-display text-xs font-bold tracking-[0.14em] text-cyan-300 uppercase">
                Offline App (PWA)
              </div>
              <span className="text-[11px] text-slate-400">
                Cached for offline rides &amp; local FIT export
              </span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Install Endless Horizon Cycling as a standalone app on desktop, Android, or iOS so
              workouts, Bluetooth ERG control, and local .FIT recording keep working without an
              internet connection.
            </p>
            <PWAInstallButton />
          </section>

          {/* Keyboard Shortcuts Reference */}
          <section className="rounded-lg bg-[#09071a] border border-slate-700/80 p-3.5">
            <div className="font-display text-xs font-bold tracking-[0.14em] text-slate-300 uppercase flex items-center gap-1.5 mb-2">
              <Keyboard className="w-4 h-4 text-cyan-300" />
              Ride Keyboard Shortcuts
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-xs text-slate-300">
              <div><strong className="text-cyan-300">Space</strong> · Start / Pause</div>
              <div><strong className="text-cyan-300">↑ / ↓</strong> · ±1% / Free Ride ±5W</div>
              <div><strong className="text-cyan-300">→ / ←</strong> · Skip / Prev Step</div>
              <div><strong className="text-cyan-300">G</strong> · Toggle Graph</div>
              <div><strong className="text-cyan-300">H</strong> · Toggle Holo Cards</div>
              <div><strong className="text-cyan-300">M</strong> · Mute / Unmute Audio</div>
              <div><strong className="text-cyan-300">F</strong> · Fullscreen</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
