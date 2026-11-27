import type { ZoneNumber } from '../core/zones';
import type { AppScreen, SceneryTheme, WorkoutRunState } from '../store/useAppStore';

export interface AudioGainInput {
  enabled: boolean;
  muted: boolean;
  masterVolume: number;
  menuVolume: number;
  rideVolume: number;
  screen: AppScreen;
  runState: WorkoutRunState;
}

export interface SynthwaveMixParams {
  bpm: number;
  filterCutoffHz: number;
  filterQ: number;
  padLevel: number;
  bassLevel: number;
  arpLevel: number;
  delayMix: number;
  rootMidiOffset: number;
  isDriving: boolean;
}

/**
 * 4-bar classic synthwave minor progression (Am9 -> Fmaj7 -> Cmaj7 -> G6)
 * expressed in MIDI note numbers relative to A minor (rootMidiOffset = 0).
 */
export interface SynthwaveBarChord {
  bassMidi: number;
  padMidis: readonly [number, number, number, number];
  arpMidis: readonly [number, number, number, number, number, number, number, number];
}

export const SYNTHWAVE_PROGRESSION: readonly SynthwaveBarChord[] = [
  // Bar 0: Am9
  {
    bassMidi: 45, // A2
    padMidis: [57, 60, 64, 71], // A3, C4, E4, B4
    arpMidis: [69, 72, 76, 79, 83, 79, 76, 72],
  },
  // Bar 1: Fmaj7
  {
    bassMidi: 41, // F2
    padMidis: [53, 57, 60, 64], // F3, A3, C4, E4
    arpMidis: [65, 69, 72, 76, 81, 76, 72, 69],
  },
  // Bar 2: Cmaj7
  {
    bassMidi: 48, // C3
    padMidis: [55, 60, 64, 71], // G3, C4, E4, B4
    arpMidis: [72, 76, 79, 83, 84, 83, 79, 76],
  },
  // Bar 3: G6
  {
    bassMidi: 43, // G2
    padMidis: [55, 59, 62, 69], // G3, B3, D4, A4
    arpMidis: [67, 71, 74, 76, 79, 76, 74, 71],
  },
];

export const DEFAULT_AUDIO_MASTER_VOLUME = 0.65;
export const DEFAULT_AUDIO_MENU_VOLUME = 0.55;
export const DEFAULT_AUDIO_RIDE_VOLUME = 0.75;

/**
 * Clamp any volume slider input safely into [0, 1].
 */
export function clampAudioVolume(value: unknown, fallback = DEFAULT_AUDIO_MASTER_VOLUME): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.max(0, Math.min(1, fallback));
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Convert a MIDI note number to frequency in Hz (A4 = 69 = 440 Hz).
 */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Compute final perceptual master gain [0..0.85] combining master volume,
 * context volume (main menu vs ride), mute/enabled toggles, and gentle pause ducking.
 */
export function computeEffectiveMasterGain(input: AudioGainInput): number {
  if (!input.enabled || input.muted) return 0;

  const master = clampAudioVolume(input.masterVolume, DEFAULT_AUDIO_MASTER_VOLUME);
  const contextVol =
    input.screen === 'ride'
      ? clampAudioVolume(input.rideVolume, DEFAULT_AUDIO_RIDE_VOLUME)
      : clampAudioVolume(input.menuVolume, DEFAULT_AUDIO_MENU_VOLUME);

  const linear = master * contextVol;
  if (linear <= 0.0001) return 0;

  // Gently duck ambient ride music when paused/idle on the ride screen
  const pauseDuck =
    input.screen === 'ride' && input.runState !== 'running' ? 0.65 : 1.0;

  // Perceptual volume taper (smoother quiet control, headroom cap at 0.85)
  const perceptual = Math.pow(linear, 1.55) * 0.85 * pauseDuck;
  return Math.max(0, Math.min(0.85, perceptual));
}

/**
 * Compute subtle musical key offset per scenery theme so each world has its own harmonic mood.
 */
export function getThemeRootOffset(theme: SceneryTheme): number {
  switch (theme) {
    case 'neon-city':
      return 0; // A minor
    case 'palm-grove':
      return -4; // F minor (warm dusk)
    case 'cloud-horizon':
      return 5; // D minor (expansive bright)
    case 'causeway-embankment':
      return -9; // C minor (deep maritime twilight)
  }
}

/**
 * Compute adaptive synthwave synthesizer mix & tempo parameters for Main Menu vs active Rides.
 */
export function computeSynthwaveMixParams(opts: {
  screen: AppScreen;
  runState: WorkoutRunState;
  zone: ZoneNumber;
  sceneryTheme: SceneryTheme;
}): SynthwaveMixParams {
  const rootMidiOffset = getThemeRootOffset(opts.sceneryTheme);

  // Main Menu & Workout Library: lush, dreamy slow-burn ambient synthwave pads
  if (opts.screen !== 'ride') {
    return {
      bpm: 86,
      filterCutoffHz: 960,
      filterQ: 1.6,
      padLevel: 0.56,
      bassLevel: 0.22,
      arpLevel: 0.14,
      delayMix: 0.34,
      rootMidiOffset,
      isDriving: false,
    };
  }

  // Ride screen while paused/idle/completed: mellow floating cruise
  if (opts.runState !== 'running') {
    return {
      bpm: 92,
      filterCutoffHz: 1120,
      filterQ: 1.8,
      padLevel: 0.52,
      bassLevel: 0.25,
      arpLevel: 0.16,
      delayMix: 0.32,
      rootMidiOffset,
      isDriving: false,
    };
  }

  // Active Ride: scales tempo, filter brightness, bass drive & arpeggio energy with Coggan zone
  const zoneNorm = Math.max(0, Math.min(1, (opts.zone - 1) / 5)); // 0 at Z1 .. 1 at Z6/Z7
  const bpmByZone: Record<ZoneNumber, number> = {
    1: 96,
    2: 106,
    3: 114,
    4: 120,
    5: 126,
    6: 132,
    7: 136,
  };

  return {
    bpm: bpmByZone[opts.zone] ?? 108,
    filterCutoffHz: Math.round(1200 + zoneNorm * 2200),
    filterQ: 2.0 + zoneNorm * 2.2,
    padLevel: 0.44 - zoneNorm * 0.06,
    bassLevel: 0.32 + zoneNorm * 0.22,
    arpLevel: 0.18 + zoneNorm * 0.24,
    delayMix: 0.28 + zoneNorm * 0.08,
    rootMidiOffset,
    isDriving: true,
  };
}
