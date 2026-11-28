/**
 * Pure, deterministic state machine and musical configuration for the Tone.js
 * Adaptive Synthwave Music Engine (A minor, 8-bar variation, Zones 1..5).
 *
 * Kept 100% free of Web Audio / DOM APIs so every rule (zone mapping, 3-second
 * hysteresis, layer budgets, quality scaling, and 5-second interval anticipation)
 * can be verified by fast deterministic unit tests.
 */

import { getPowerZone, ZoneNumber } from '../core/zones';

export type MusicZone = 1 | 2 | 3 | 4 | 5;
export type MusicFollowMode = 'target' | 'actual';
export type AudioQualityLevel = 'low' | 'medium' | 'high';

export const MUSIC_HYSTERESIS_SEC = 3.0;
export const MUSIC_LOOKAHEAD_SEC = 0.3;

export const ZONE_BPM: Record<MusicZone, number> = {
  1: 90,
  2: 100,
  3: 110,
  4: 122,
  5: 132,
};

export interface MusicLayerProfile {
  bpm: number;
  pad: number;
  softArp: number;
  bass: number;
  kick: number;
  shaker: number;
  clap: number;
  hatClosed: number;
  hatOpen: number;
  pluckArp: number;
  lead: number;
  highArp: number;
  snareRoll: number;
  filterCutoffHz: number;
  reverbWet: number;
  sidechainDepth: number;
  saturationWet: number;
  bassSubdivision: 'none' | 'root' | '8th' | '16th';
  kickPattern: 'none' | 'soft' | 'four-on-floor';
}

export const ZONE_LAYER_PROFILES: Record<MusicZone, MusicLayerProfile> = {
  // Z1: warm detuned pad, sparse soft arpeggio, no kick, low-pass filter mostly closed, large reverb. ~90 BPM.
  1: {
    bpm: 90,
    pad: 0.62,
    softArp: 0.28,
    bass: 0,
    kick: 0,
    shaker: 0,
    clap: 0,
    hatClosed: 0,
    hatOpen: 0,
    pluckArp: 0,
    lead: 0,
    highArp: 0,
    snareRoll: 0,
    filterCutoffHz: 740,
    reverbWet: 0.52,
    sidechainDepth: 0,
    saturationWet: 0,
    bassSubdivision: 'none',
    kickPattern: 'none',
  },
  // Z2: adds root-note bass, a soft kick, a shaker. ~100 BPM.
  2: {
    bpm: 100,
    pad: 0.56,
    softArp: 0.24,
    bass: 0.44,
    kick: 0.42,
    shaker: 0.26,
    clap: 0,
    hatClosed: 0,
    hatOpen: 0,
    pluckArp: 0,
    lead: 0,
    highArp: 0,
    snareRoll: 0,
    filterCutoffHz: 1180,
    reverbWet: 0.42,
    sidechainDepth: 0.08,
    saturationWet: 0,
    bassSubdivision: 'root',
    kickPattern: 'soft',
  },
  // Z3: adds four-on-the-floor kick, claps on beats 2 & 4, off-beat hats, 16th-note pluck arpeggio. ~110 BPM.
  3: {
    bpm: 110,
    pad: 0.5,
    softArp: 0.14,
    bass: 0.52,
    kick: 0.66,
    shaker: 0.22,
    clap: 0.48,
    hatClosed: 0.36,
    hatOpen: 0,
    pluckArp: 0.38,
    lead: 0,
    highArp: 0,
    snareRoll: 0,
    filterCutoffHz: 1950,
    reverbWet: 0.34,
    sidechainDepth: 0.2,
    saturationWet: 0.02,
    bassSubdivision: 'root',
    kickPattern: 'four-on-floor',
  },
  // Z4: adds driving 8th-note bass, open hats, lead melody, fully open filter & sidechain-style pumping. ~122 BPM.
  4: {
    bpm: 122,
    pad: 0.48,
    softArp: 0.08,
    bass: 0.64,
    kick: 0.78,
    shaker: 0.18,
    clap: 0.56,
    hatClosed: 0.38,
    hatOpen: 0.36,
    pluckArp: 0.42,
    lead: 0.44,
    highArp: 0,
    snareRoll: 0,
    filterCutoffHz: 4600,
    reverbWet: 0.28,
    sidechainDepth: 0.52,
    saturationWet: 0.06,
    bassSubdivision: '8th',
    kickPattern: 'four-on-floor',
  },
  // Z5: adds 16th-note bass, snare rolls, bright supersaw lead, extra high arpeggio & light saturation. ~132 BPM.
  5: {
    bpm: 132,
    pad: 0.46,
    softArp: 0.06,
    bass: 0.72,
    kick: 0.86,
    shaker: 0.2,
    clap: 0.62,
    hatClosed: 0.42,
    hatOpen: 0.44,
    pluckArp: 0.46,
    lead: 0.56,
    highArp: 0.34,
    snareRoll: 0.52,
    filterCutoffHz: 6800,
    reverbWet: 0.24,
    sidechainDepth: 0.62,
    saturationWet: 0.16,
    bassSubdivision: '16th',
    kickPattern: 'four-on-floor',
  },
};

export interface AdaptiveBarChord {
  name: string;
  root: string;
  rootOctaveUp: string;
  padNotes: readonly string[];
  arpNotes: readonly string[];
  highArpNotes: readonly string[];
  leadLine: readonly (string | null)[]; // 8 eighth-note slots per bar
}

/**
 * 8-bar A minor synthwave progression:
 * Bars 0..3: Am -> F -> C -> G (classic anthem loop)
 * Bars 4..7: Am9 -> Fmaj7 -> Cmaj7 -> G6/G7sus4 (8-bar harmonic & melodic variation)
 */
export const AM_CHORD_PROGRESSION_8BAR: readonly AdaptiveBarChord[] = [
  // Bar 0: Am
  {
    name: 'Am',
    root: 'A1',
    rootOctaveUp: 'A2',
    padNotes: ['A3', 'C4', 'E4', 'A4'],
    arpNotes: ['A3', 'C4', 'E4', 'A4', 'E4', 'C4', 'E4', 'G4'],
    highArpNotes: ['A4', 'C5', 'E5', 'A5', 'E5', 'C5', 'E5', 'G5'],
    leadLine: ['E5', null, 'C5', 'D5', 'E5', null, 'G5', 'E5'],
  },
  // Bar 1: F
  {
    name: 'F',
    root: 'F1',
    rootOctaveUp: 'F2',
    padNotes: ['F3', 'A3', 'C4', 'E4'],
    arpNotes: ['F3', 'A3', 'C4', 'F4', 'C4', 'A3', 'C4', 'E4'],
    highArpNotes: ['F4', 'A4', 'C5', 'F5', 'C5', 'A4', 'C5', 'E5'],
    leadLine: ['F5', null, 'E5', 'C5', 'A4', null, 'C5', 'D5'],
  },
  // Bar 2: C
  {
    name: 'C',
    root: 'C2',
    rootOctaveUp: 'C3',
    padNotes: ['G3', 'C4', 'E4', 'G4'],
    arpNotes: ['C4', 'E4', 'G4', 'C5', 'G4', 'E4', 'G4', 'B4'],
    highArpNotes: ['C5', 'E5', 'G5', 'C6', 'G5', 'E5', 'G5', 'B5'],
    leadLine: ['E5', null, 'G5', 'A5', 'G5', null, 'E5', 'C5'],
  },
  // Bar 3: G
  {
    name: 'G',
    root: 'G1',
    rootOctaveUp: 'G2',
    padNotes: ['G3', 'B3', 'D4', 'G4'],
    arpNotes: ['G3', 'B3', 'D4', 'G4', 'D4', 'B3', 'D4', 'F#4'],
    highArpNotes: ['G4', 'B4', 'D5', 'G5', 'D5', 'B4', 'D5', 'G5'],
    leadLine: ['D5', null, 'B4', 'C5', 'D5', null, 'G5', 'D5'],
  },
  // Bar 4: Am9 (8-bar variation)
  {
    name: 'Am9',
    root: 'A1',
    rootOctaveUp: 'A2',
    padNotes: ['A3', 'C4', 'E4', 'B4'],
    arpNotes: ['A3', 'E4', 'B4', 'C5', 'B4', 'E4', 'C4', 'E4'],
    highArpNotes: ['A4', 'E5', 'B5', 'C6', 'B5', 'E5', 'C5', 'E5'],
    leadLine: ['A5', null, 'G5', 'E5', 'C5', 'D5', 'E5', null],
  },
  // Bar 5: Fmaj7 (variation)
  {
    name: 'Fmaj7',
    root: 'F1',
    rootOctaveUp: 'F2',
    padNotes: ['F3', 'A3', 'C4', 'E4'],
    arpNotes: ['F3', 'C4', 'E4', 'A4', 'E4', 'C4', 'A3', 'C4'],
    highArpNotes: ['F4', 'C5', 'E5', 'A5', 'E5', 'C5', 'A4', 'C5'],
    leadLine: ['F5', 'G5', 'A5', null, 'G5', 'E5', 'C5', null],
  },
  // Bar 6: Cmaj7 (variation)
  {
    name: 'Cmaj7',
    root: 'C2',
    rootOctaveUp: 'C3',
    padNotes: ['G3', 'C4', 'E4', 'B4'],
    arpNotes: ['C4', 'G4', 'B4', 'E5', 'B4', 'G4', 'E4', 'G4'],
    highArpNotes: ['C5', 'G5', 'B5', 'E6', 'B5', 'G5', 'E5', 'G5'],
    leadLine: ['G5', null, 'A5', 'B5', 'C6', null, 'B5', 'G5'],
  },
  // Bar 7: G6 turnaround (variation)
  {
    name: 'G6',
    root: 'G1',
    rootOctaveUp: 'G2',
    padNotes: ['G3', 'B3', 'D4', 'E4'],
    arpNotes: ['G3', 'D4', 'E4', 'G4', 'B4', 'G4', 'D4', 'B3'],
    highArpNotes: ['G4', 'D5', 'E5', 'G5', 'B5', 'G5', 'D5', 'B4'],
    leadLine: ['D5', 'E5', 'G5', null, 'E5', 'D5', 'B4', 'D5'],
  },
];

/**
 * Map any Coggan zone (1..7) into adaptive music zone (1..5).
 * Zones 5, 6, and 7 all map to Zone 5.
 */
export function mapCogganToMusicZone(zone: number): MusicZone {
  if (zone <= 1) return 1;
  if (zone === 2) return 2;
  if (zone === 3) return 3;
  if (zone === 4) return 4;
  return 5;
}

/**
 * Apply quality budget overrides:
 * Quality 'low' disables reverb and the extra high arpeggio & lead layers
 * (keeping CPU usage minimal, especially on touch devices).
 */
export function computeEffectiveMusicLayers(
  zone: MusicZone,
  quality: AudioQualityLevel,
  isTouchDevice = false
): MusicLayerProfile {
  const base = ZONE_LAYER_PROFILES[zone];
  if (quality === 'low') {
    return {
      ...base,
      reverbWet: 0,
      highArp: 0,
      lead: 0,
      saturationWet: 0,
    };
  }
  if (quality === 'medium' && isTouchDevice) {
    return {
      ...base,
      reverbWet: base.reverbWet * 0.65,
      highArp: base.highArp * 0.75,
    };
  }
  return { ...base };
}

/**
 * Compute duration in seconds for a smooth 4-bar tempo ramp at the average BPM.
 */
export function computeFourBarRampSeconds(fromBpm: number, toBpm: number): number {
  const avgBpm = Math.max(60, (fromBpm + toBpm) * 0.5);
  // 4 bars x 4 beats/bar = 16 beats
  return (16 * 60) / avgBpm;
}

export interface ZoneHysteresisState {
  activeZone: MusicZone;
  candidateZone: MusicZone;
  candidateElapsedSec: number;
}

export function createZoneHysteresisState(initialZone: MusicZone = 1): ZoneHysteresisState {
  return {
    activeZone: initialZone,
    candidateZone: initialZone,
    candidateElapsedSec: 0,
  };
}

export interface ZoneHysteresisResult {
  nextState: ZoneHysteresisState;
  changed: boolean;
  previousZone: MusicZone;
  activeZone: MusicZone;
  direction: 'up' | 'down' | 'none';
}

/**
 * 3-second zone hysteresis filter:
 * Only switches activeZone after the new candidateZone has been continuously stable
 * for at least MUSIC_HYSTERESIS_SEC (3.0 s).
 */
export function stepZoneHysteresis(
  state: ZoneHysteresisState,
  candidateZone: MusicZone,
  dtSec: number,
  thresholdSec = MUSIC_HYSTERESIS_SEC
): ZoneHysteresisResult {
  const safeDt = Math.max(0, dtSec);
  if (candidateZone === state.activeZone) {
    return {
      nextState: {
        activeZone: state.activeZone,
        candidateZone: state.activeZone,
        candidateElapsedSec: 0,
      },
      changed: false,
      previousZone: state.activeZone,
      activeZone: state.activeZone,
      direction: 'none',
    };
  }

  const nextElapsed =
    candidateZone === state.candidateZone ? state.candidateElapsedSec + safeDt : safeDt;

  if (nextElapsed >= thresholdSec) {
    const direction = candidateZone > state.activeZone ? 'up' : 'down';
    return {
      nextState: {
        activeZone: candidateZone,
        candidateZone,
        candidateElapsedSec: 0,
      },
      changed: true,
      previousZone: state.activeZone,
      activeZone: candidateZone,
      direction,
    };
  }

  return {
    nextState: {
      activeZone: state.activeZone,
      candidateZone,
      candidateElapsedSec: nextElapsed,
    },
    changed: false,
    previousZone: state.activeZone,
    activeZone: state.activeZone,
    direction: 'none',
  };
}

/**
 * Resolve the target music zone (1..5) from either:
 * - 'target': current workout step's base target zone (ignoring intensity offset, same as road colour)
 *             or active Free Ride zone
 * - 'actual': live 3-second average power relative to rider FTP
 */
export function resolveMusicCandidateZone(opts: {
  followMode: MusicFollowMode;
  rideMode: 'workout' | 'freeride';
  targetStepZone: ZoneNumber;
  freeRideZone: ZoneNumber;
  power3sAvg: number;
  ftp: number;
}): MusicZone {
  if (opts.followMode === 'actual') {
    const fraction = opts.ftp > 0 ? Math.max(0, opts.power3sAvg / opts.ftp) : 0;
    return mapCogganToMusicZone(getPowerZone(fraction).zone);
  }
  const sourceZone = opts.rideMode === 'freeride' ? opts.freeRideZone : opts.targetStepZone;
  return mapCogganToMusicZone(sourceZone);
}

/**
 * Determine whether the 5-second interval anticipation riser & snare build should fire:
 * Active during the last 5 seconds before a workout step that steps UP one or more music zones.
 */
export function evaluateIntervalAnticipation(opts: {
  runState: 'idle' | 'running' | 'paused' | 'completed';
  rideMode: 'workout' | 'freeride';
  countdownSec: number | null;
  currentMusicZone: MusicZone;
  nextStepPowerLow: number | null;
}): { active: boolean; nextMusicZone: MusicZone | null } {
  if (
    opts.runState !== 'running' ||
    opts.rideMode !== 'workout' ||
    opts.countdownSec === null ||
    opts.countdownSec < 1 ||
    opts.countdownSec > 5 ||
    opts.nextStepPowerLow === null
  ) {
    return { active: false, nextMusicZone: null };
  }

  const nextMusicZone = mapCogganToMusicZone(getPowerZone(opts.nextStepPowerLow).zone);
  if (nextMusicZone > opts.currentMusicZone) {
    return { active: true, nextMusicZone };
  }
  return { active: false, nextMusicZone: null };
}
