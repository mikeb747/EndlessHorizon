/**
 * Adaptive Zone-Reactive Synthwave Music Engine powered by Tone.js (Web Audio).
 * 100% procedural synthesis — zero external audio files or assets.
 *
 * Public contract:
 *   start(), stop(), setZone(zone: 1|2|3|4|5), setVolume(v), setEnabled(bool), duck(amount)
 * Plus ride-lifecycle helpers for bar-quantized transitions, 5s interval anticipation,
 * quality scaling, menu crossfade, and Settings Z1..Z5 auditioning.
 */

import * as Tone from 'tone';
import {
  AM_CHORD_PROGRESSION_8BAR,
  AudioQualityLevel,
  computeEffectiveMusicLayers,
  computeFourBarRampSeconds,
  MUSIC_LOOKAHEAD_SEC,
  MusicLayerProfile,
  MusicZone,
  ZONE_BPM,
} from './musicEngineLogic';

export type { MusicZone };

class AdaptiveMusicEngine {
  private initialized = false;
  private started = false;
  private enabled = true;
  private muted = false;
  private paused = false;
  private volume = 0.72;
  private duckAmount = 0; // 0 = no duck, 1 = fully ducked
  private quality: AudioQualityLevel = 'high';
  private isTouchDevice = false;

  private activeZone: MusicZone = 1;
  private queuedZone: MusicZone | null = null;
  private pendingTransitionDir: 'up' | 'down' | 'none' = 'none';
  private anticipationActive = false;
  private anticipationCountdown = 0;

  // Step counter: 0..127 (8 bars x 16 sixteenth-notes per bar)
  private step16 = 0;
  private lastStepTime = 0;
  private loop: Tone.Loop | null = null;

  // Audio buses & effects
  private masterGain: Tone.Gain | null = null;
  private duckGain: Tone.Gain | null = null;
  private limiter: Tone.Limiter | null = null;
  private harmonicFilter: Tone.Filter | null = null;
  private saturation: Tone.Distortion | null = null;
  private reverb: Tone.Reverb | null = null;
  private reverbSend: Tone.Gain | null = null;
  private sidechainGain: Tone.Gain | null = null;

  // Per-layer gain buses (ramped smoothly, never hard cuts)
  private padBus: Tone.Gain | null = null;
  private softArpBus: Tone.Gain | null = null;
  private bassBus: Tone.Gain | null = null;
  private kickBus: Tone.Gain | null = null;
  private shakerBus: Tone.Gain | null = null;
  private clapBus: Tone.Gain | null = null;
  private hatClosedBus: Tone.Gain | null = null;
  private hatOpenBus: Tone.Gain | null = null;
  private pluckArpBus: Tone.Gain | null = null;
  private leadBus: Tone.Gain | null = null;
  private highArpBus: Tone.Gain | null = null;
  private snareBus: Tone.Gain | null = null;
  private fxBus: Tone.Gain | null = null;

  // Low-polyphony procedural synthesizers
  private padSynth: Tone.PolySynth<Tone.Synth> | null = null;
  private softArpSynth: Tone.Synth | null = null;
  private bassSynth: Tone.MonoSynth | null = null;
  private kickSynth: Tone.MembraneSynth | null = null;
  private shakerSynth: Tone.NoiseSynth | null = null;
  private clapSynth: Tone.NoiseSynth | null = null;
  private hatClosedSynth: Tone.NoiseSynth | null = null;
  private hatOpenSynth: Tone.NoiseSynth | null = null;
  private pluckArpSynth: Tone.Synth | null = null;
  private leadSynth: Tone.Synth | null = null;
  private highArpSynth: Tone.Synth | null = null;
  private snareSynth: Tone.NoiseSynth | null = null;
  private riserSynth: Tone.NoiseSynth | null = null;
  private riserFilter: Tone.Filter | null = null;
  private impactSynth: Tone.MembraneSynth | null = null;

  private activeProfile: MusicLayerProfile = computeEffectiveMusicLayers(1, 'high', false);

  /**
   * Start Tone.js AudioContext (must be triggered after first user click/gesture)
   * and begin the bar-quantized adaptive synthwave Transport.
   */
  public start(): void {
    if (typeof window === 'undefined') return;
    if (!this.enabled) return;

    void Tone.start()
      .then(() => {
        if (!this.enabled) return;
        this.ensureGraph();
        if (!this.initialized) return;

        Tone.getContext().lookAhead = MUSIC_LOOKAHEAD_SEC;
        const transport = Tone.getTransport();
        if (!this.started) {
          this.step16 = 0;
          transport.bpm.value = ZONE_BPM[this.activeZone];
          this.applyLayerProfile(this.getEffectiveZone(), 0.9);
          this.loop?.start(0);
          transport.start('+0.06');
          this.started = true;
        }
        this.applyMasterGain(0.85);
      })
      .catch(() => {
        // Autoplay blocked prior to gesture; will retry on next gesture/call
      });
  }

  /**
   * Smoothly fade out and stop the Tone.js Transport.
   */
  public stop(fadeSec = 1.1): void {
    this.anticipationActive = false;
    this.queuedZone = null;
    this.pendingTransitionDir = 'none';
    if (!this.initialized || !this.started) return;

    const now = Tone.now();
    this.masterGain?.gain.cancelScheduledValues(now);
    this.masterGain?.gain.rampTo(0.0001, Math.max(0.08, fadeSec), now);

    const stopDelayMs = Math.round(Math.max(100, fadeSec * 1000) + 80);
    window.setTimeout(() => {
      if (!this.started) return;
      // Only stop Transport if we were not restarted during the fade
      if (this.masterGain && this.masterGain.gain.value <= 0.002) {
        this.loop?.stop();
        Tone.getTransport().stop();
        this.started = false;
      }
    }, stopDelayMs);
  }

  /**
   * Request a zone change (1..5). Quantized to the next bar boundary with
   * smooth 4-bar tempo ramping and musical riser/sweep transition cues.
   */
  public setZone(zone: MusicZone, immediateBarCue = false): void {
    const clamped: MusicZone = Math.max(1, Math.min(5, Math.round(zone))) as MusicZone;
    if (clamped === this.activeZone && this.queuedZone === null) return;

    const dir: 'up' | 'down' | 'none' =
      clamped > this.activeZone ? 'up' : clamped < this.activeZone ? 'down' : 'none';
    this.queuedZone = clamped;
    this.pendingTransitionDir = dir;

    // If transport isn't running yet, apply immediately as starting zone
    if (!this.started || !this.initialized) {
      this.activeZone = clamped;
      this.queuedZone = null;
      this.pendingTransitionDir = 'none';
      return;
    }

    // Trigger immediate transition swell when auditioning in Settings or stepping down
    if (immediateBarCue && dir === 'down') {
      this.triggerDownwardSweep(Tone.now() + 0.03);
    }
  }

  /**
   * Set music volume in [0, 1] with smooth gain ramp.
   */
  public setVolume(v: number): void {
    const safe = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.72;
    this.volume = safe;
    this.applyMasterGain(0.22);
  }

  /**
   * Enable or disable adaptive music cleanly (silent mode for riders playing own music).
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stop(0.35);
    } else if (this.started) {
      this.applyMasterGain(0.45);
    }
  }

  /**
   * Mute/unmute quickly (e.g. keyboard shortcut M).
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterGain(0.18);
  }

  /**
   * Smoothly duck output volume by amount [0..1] (0 = full volume, 1 = silent).
   */
  public duck(amount: number): void {
    const clamped = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.duckAmount = clamped;
    if (!this.duckGain) return;
    const target = Math.max(0.0001, 1 - clamped);
    this.duckGain.gain.rampTo(target, 0.35);
  }

  /**
   * Pause/resume musical behavior: when paused, smoothly fade layers down to the Z1 pad layer.
   */
  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.initialized || !this.started) return;

    if (paused) {
      this.anticipationActive = false;
      this.applyLayerProfile(1, 1.1);
    } else {
      this.applyLayerProfile(this.activeZone, 0.9);
    }
  }

  /**
   * Update graphics/performance quality budget (Low disables reverb, high arp & lead).
   */
  public setQuality(quality: AudioQualityLevel, isTouchDevice = false): void {
    this.quality = quality;
    this.isTouchDevice = isTouchDevice;
    if (!this.initialized) return;
    this.applyLayerProfile(this.getEffectiveZone(), 0.4);
  }

  /**
   * Sync 5-second interval anticipation riser & snare build before stepping UP a zone.
   */
  public setIntervalAnticipation(active: boolean, countdownSec = 0): void {
    const wasActive = this.anticipationActive;
    this.anticipationActive = active && !this.paused;
    this.anticipationCountdown = countdownSec;

    if (this.anticipationActive && !wasActive && this.initialized && this.started) {
      this.triggerRiserSwell(Tone.now() + 0.04, Math.max(1.8, countdownSec));
    }
  }

  /**
   * Play crisp sub-drop impact hit on workout step-up downbeat and immediately snap into new zone.
   */
  public triggerStepImpact(newZone: MusicZone): void {
    this.anticipationActive = false;
    if (!this.initialized || !this.started || !this.enabled || this.muted) return;

    const now = Tone.now() + 0.02;
    this.impactSynth?.triggerAttackRelease('A1', '2n', now, 0.85);
    this.hatOpenSynth?.triggerAttackRelease('4n', now, 0.45);

    if (newZone !== this.activeZone) {
      const prevBpm = ZONE_BPM[this.activeZone];
      this.activeZone = newZone;
      this.queuedZone = null;
      this.pendingTransitionDir = 'none';
      const targetBpm = ZONE_BPM[newZone];
      Tone.getTransport().bpm.rampTo(targetBpm, computeFourBarRampSeconds(prevBpm, targetBpm));
      this.applyLayerProfile(this.getEffectiveZone(), 0.45);
    }
  }

  public isRunning(): boolean {
    return this.started;
  }

  public getActiveZone(): MusicZone {
    return this.activeZone;
  }

  private getEffectiveZone(): MusicZone {
    return this.paused ? 1 : this.activeZone;
  }

  private applyMasterGain(rampSec: number): void {
    if (!this.masterGain) return;
    const audible = this.enabled && !this.muted;
    // Perceptual volume curve with safe headroom cap (0.72)
    const target = audible && this.volume > 0.001 ? Math.pow(this.volume, 1.45) * 0.72 : 0.0001;
    this.masterGain.gain.rampTo(target, rampSec);
  }

  private ensureGraph(): void {
    if (this.initialized) return;

    try {
      Tone.getContext().lookAhead = MUSIC_LOOKAHEAD_SEC;

      this.limiter = new Tone.Limiter(-2).toDestination();
      this.masterGain = new Tone.Gain(0.0001).connect(this.limiter);
      this.duckGain = new Tone.Gain(Math.max(0.0001, 1 - this.duckAmount)).connect(this.masterGain);

      this.saturation = new Tone.Distortion({ distortion: 0.22, wet: 0 }).connect(this.duckGain);
      this.harmonicFilter = new Tone.Filter({
        type: 'lowpass',
        frequency: 740,
        Q: 1.4,
      }).connect(this.saturation);

      this.sidechainGain = new Tone.Gain(1).connect(this.harmonicFilter);

      // Large ambient synthwave reverb (bypassed on Low quality via reverbSend = 0)
      this.reverb = new Tone.Reverb({ decay: 4.2, preDelay: 0.03, wet: 1 });
      this.reverbSend = new Tone.Gain(0.45);
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(this.duckGain);

      // Individual layer gain buses (all ramped smoothly, never hard cuts)
      this.padBus = new Tone.Gain(0.55).connect(this.sidechainGain);
      this.padBus.connect(this.reverbSend);

      this.softArpBus = new Tone.Gain(0.24).connect(this.harmonicFilter);
      this.softArpBus.connect(this.reverbSend);

      this.bassBus = new Tone.Gain(0.0001).connect(this.sidechainGain);
      this.pluckArpBus = new Tone.Gain(0.0001).connect(this.harmonicFilter);
      this.pluckArpBus.connect(this.reverbSend);

      this.leadBus = new Tone.Gain(0.0001).connect(this.harmonicFilter);
      this.leadBus.connect(this.reverbSend);

      this.highArpBus = new Tone.Gain(0.0001).connect(this.harmonicFilter);
      this.highArpBus.connect(this.reverbSend);

      // Rhythm & FX buses go cleanly to duckGain (punchy, unfiltered kick/snare/hats)
      this.kickBus = new Tone.Gain(0.0001).connect(this.duckGain);
      this.shakerBus = new Tone.Gain(0.0001).connect(this.duckGain);
      this.clapBus = new Tone.Gain(0.0001).connect(this.duckGain);
      this.clapBus.connect(this.reverbSend);
      this.hatClosedBus = new Tone.Gain(0.0001).connect(this.duckGain);
      this.hatOpenBus = new Tone.Gain(0.0001).connect(this.duckGain);
      this.snareBus = new Tone.Gain(0.0001).connect(this.duckGain);
      this.fxBus = new Tone.Gain(0.45).connect(this.duckGain);
      this.fxBus.connect(this.reverbSend);

      // Warm detuned pad (low polyphony = 8 voices: 4-note chord + smooth 4-note release tail)
      this.padSynth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'fatsawtooth', count: 2, spread: 18 },
        envelope: { attack: 0.35, decay: 0.35, sustain: 0.78, release: 0.85 },
      }).connect(this.padBus);
      this.padSynth.maxPolyphony = 8;

      // Sparse dreamy soft arpeggio (Z1..Z2)
      this.softArpSynth = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.02, decay: 0.35, sustain: 0.15, release: 0.6 },
      }).connect(this.softArpBus);

      // Analog MonoSynth bass (root -> 8th -> 16th)
      this.bassSynth = new Tone.MonoSynth({
        oscillator: { type: 'sawtooth' },
        filter: { type: 'lowpass', Q: 2.2, rolloff: -24 },
        filterEnvelope: {
          attack: 0.008,
          decay: 0.18,
          sustain: 0.25,
          release: 0.12,
          baseFrequency: 110,
          octaves: 2.6,
        },
        envelope: { attack: 0.006, decay: 0.16, sustain: 0.35, release: 0.08 },
      }).connect(this.bassBus);

      // Synthwave punch kick
      this.kickSynth = new Tone.MembraneSynth({
        pitchDecay: 0.045,
        octaves: 5,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 0.28, sustain: 0.01, release: 0.18 },
      }).connect(this.kickBus);

      // Filtered shaker
      const shakerFilter = new Tone.Filter({ type: 'highpass', frequency: 5200 }).connect(
        this.shakerBus
      );
      this.shakerSynth = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.004, decay: 0.045, sustain: 0, release: 0.02 },
      }).connect(shakerFilter);

      // Retro synthwave clap on beats 2 & 4
      const clapFilter = new Tone.Filter({ type: 'bandpass', frequency: 1450, Q: 1.4 }).connect(
        this.clapBus
      );
      this.clapSynth = new Tone.NoiseSynth({
        noise: { type: 'pink' },
        envelope: { attack: 0.003, decay: 0.15, sustain: 0, release: 0.08 },
      }).connect(clapFilter);

      // Off-beat closed hi-hat
      const closedHatFilter = new Tone.Filter({ type: 'highpass', frequency: 7400 }).connect(
        this.hatClosedBus
      );
      this.hatClosedSynth = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.002, decay: 0.04, sustain: 0, release: 0.02 },
      }).connect(closedHatFilter);

      // Open hi-hat (Z4+)
      const openHatFilter = new Tone.Filter({ type: 'highpass', frequency: 6200 }).connect(
        this.hatOpenBus
      );
      this.hatOpenSynth = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.003, decay: 0.24, sustain: 0.02, release: 0.14 },
      }).connect(openHatFilter);

      // 16th-note pluck arpeggio (Z3+)
      this.pluckArpSynth = new Tone.Synth({
        oscillator: { type: 'sawtooth' },
        envelope: { attack: 0.004, decay: 0.12, sustain: 0.05, release: 0.1 },
      }).connect(this.pluckArpBus);

      // Supersaw synthwave lead (Z4 melody -> Z5 bright supersaw)
      this.leadSynth = new Tone.Synth({
        oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
        envelope: { attack: 0.025, decay: 0.25, sustain: 0.55, release: 0.35 },
      }).connect(this.leadBus);

      // High sparkling arpeggio (Z5)
      this.highArpSynth = new Tone.Synth({
        oscillator: { type: 'square' },
        envelope: { attack: 0.003, decay: 0.09, sustain: 0.04, release: 0.08 },
      }).connect(this.highArpBus);

      // Snare for fills, rolls & interval anticipation builds
      const snareFilter = new Tone.Filter({ type: 'bandpass', frequency: 1900, Q: 0.9 }).connect(
        this.snareBus
      );
      this.snareSynth = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.002, decay: 0.11, sustain: 0, release: 0.05 },
      }).connect(snareFilter);

      // Riser / reverse cymbal swell synth
      this.riserFilter = new Tone.Filter({ type: 'bandpass', frequency: 600, Q: 1.8 }).connect(
        this.fxBus
      );
      this.riserSynth = new Tone.NoiseSynth({
        noise: { type: 'pink' },
        envelope: { attack: 0.8, decay: 0.3, sustain: 0.2, release: 0.4 },
      }).connect(this.riserFilter);

      // Sub impact drop on step-up downbeat
      this.impactSynth = new Tone.MembraneSynth({
        pitchDecay: 0.14,
        octaves: 4,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.004, decay: 0.7, sustain: 0.01, release: 0.4 },
      }).connect(this.fxBus);

      // 16th-note master sequencer on Tone.Transport
      this.loop = new Tone.Loop((time) => {
        this.onSixteenthStep(time);
      }, '16n');

      this.initialized = true;
    } catch {
      this.initialized = false;
    }
  }

  private applyLayerProfile(zone: MusicZone, rampSec: number, scheduleTime?: number): void {
    const profile = computeEffectiveMusicLayers(zone, this.quality, this.isTouchDevice);
    this.activeProfile = profile;
    const t = Math.max(0.08, rampSec);
    const at = scheduleTime ?? Tone.now();

    this.padBus?.gain.rampTo(Math.max(0.0001, profile.pad), t, at);
    this.softArpBus?.gain.rampTo(Math.max(0.0001, profile.softArp), t, at);
    this.bassBus?.gain.rampTo(Math.max(0.0001, profile.bass), t, at);
    this.kickBus?.gain.rampTo(Math.max(0.0001, profile.kick), t, at);
    this.shakerBus?.gain.rampTo(Math.max(0.0001, profile.shaker), t, at);
    this.clapBus?.gain.rampTo(Math.max(0.0001, profile.clap), t, at);
    this.hatClosedBus?.gain.rampTo(Math.max(0.0001, profile.hatClosed), t, at);
    this.hatOpenBus?.gain.rampTo(Math.max(0.0001, profile.hatOpen), t, at);
    this.pluckArpBus?.gain.rampTo(Math.max(0.0001, profile.pluckArp), t, at);
    this.leadBus?.gain.rampTo(Math.max(0.0001, profile.lead), t, at);
    this.highArpBus?.gain.rampTo(Math.max(0.0001, profile.highArp), t, at);
    this.snareBus?.gain.rampTo(Math.max(0.0001, profile.snareRoll || 0.4), t, at);

    this.harmonicFilter?.frequency.rampTo(profile.filterCutoffHz, t * 1.15, at);
    this.reverbSend?.gain.rampTo(Math.max(0.0001, profile.reverbWet), t, at);
    if (this.saturation) {
      this.saturation.wet.rampTo(profile.saturationWet, t, at);
    }
  }

  private triggerRiserSwell(time: number, durationSec = 1.6): void {
    if (!this.riserSynth || !this.riserFilter) return;
    this.riserFilter.frequency.cancelScheduledValues(time);
    this.riserFilter.frequency.setValueAtTime(320, time);
    this.riserFilter.frequency.exponentialRampToValueAtTime(4200, time + durationSec);
    this.riserSynth.triggerAttackRelease(durationSec, time, 0.42);
  }

  private triggerDownwardSweep(time: number): void {
    if (!this.riserSynth || !this.riserFilter || !this.harmonicFilter) return;
    // Filter sweep down + reverse-cymbal-style noise swell
    this.riserFilter.frequency.cancelScheduledValues(time);
    this.riserFilter.frequency.setValueAtTime(3400, time);
    this.riserFilter.frequency.exponentialRampToValueAtTime(520, time + 1.1);
    this.riserSynth.triggerAttackRelease(1.0, time, 0.34);
  }

  private onSixteenthStep(rawTime: number): void {
    // Guarantee strictly monotonic Web Audio timestamps even under heavy browser frame jitter
    const time = rawTime > this.lastStepTime + 0.002 ? rawTime : this.lastStepTime + 0.005;
    this.lastStepTime = time;

    const stepInBar = this.step16 % 16;
    const barIndex = Math.floor(this.step16 / 16) % AM_CHORD_PROGRESSION_8BAR.length;

    // 1) Bar-quantized zone switch at the exact downbeat (stepInBar === 0)
    if (stepInBar === 0 && this.queuedZone !== null && !this.paused) {
      const prevZone = this.activeZone;
      const nextZone = this.queuedZone;
      const prevBpm = ZONE_BPM[prevZone];
      const nextBpm = ZONE_BPM[nextZone];

      this.activeZone = nextZone;
      this.queuedZone = null;
      this.pendingTransitionDir = 'none';

      // Ramp tempo smoothly over 4 bars
      const fourBarSec = computeFourBarRampSeconds(prevBpm, nextBpm);
      Tone.getTransport().bpm.rampTo(nextBpm, fourBarSec, time);
      this.applyLayerProfile(nextZone, 1.1, time);

      if (nextZone > prevZone) {
        this.impactSynth?.triggerAttackRelease('A1', '4n', time, 0.55);
      }
    }

    // 2) Preceding-bar transition cues when a zone change is queued for the next bar
    if (this.queuedZone !== null && !this.paused) {
      if (this.pendingTransitionDir === 'up') {
        if (stepInBar === 8) {
          this.triggerRiserSwell(time, 0.95);
        }
        // Drum fill on last beat of preceding bar (steps 12..15)
        if (stepInBar >= 12) {
          const vel = 0.35 + (stepInBar - 12) * 0.16;
          this.snareSynth?.triggerAttackRelease('16n', time, vel);
        }
      } else if (this.pendingTransitionDir === 'down' && stepInBar === 8) {
        this.triggerDownwardSweep(time);
      }
    }

    const chord = AM_CHORD_PROGRESSION_8BAR[barIndex];
    const p = this.activeProfile;
    const beatDurSec = 60 / Math.max(60, Tone.getTransport().bpm.value);

    // 3) Sidechain-style pumping on beats 1..4 in Z4 & Z5
    if (stepInBar % 4 === 0 && p.sidechainDepth > 0.05 && this.sidechainGain) {
      const dip = Math.max(0.25, 1 - p.sidechainDepth);
      this.sidechainGain.gain.cancelScheduledValues(time);
      this.sidechainGain.gain.setValueAtTime(dip, time);
      this.sidechainGain.gain.linearRampToValueAtTime(1.0, time + beatDurSec * 0.72);
    }

    // 4) Pad chord on downbeat of each bar (full 1-bar sustain)
    if (stepInBar === 0 && p.pad > 0.01) {
      this.padSynth?.triggerAttackRelease(chord.padNotes as string[], '1m', time, 0.52);
    }

    // 5) Sparse soft arpeggio (Z1..Z2 atmospheric sparkle)
    if (p.softArp > 0.01 && (stepInBar === 0 || stepInBar === 6 || stepInBar === 12)) {
      const note = chord.arpNotes[(stepInBar / 2) % chord.arpNotes.length];
      this.softArpSynth?.triggerAttackRelease(note, '4n', time, 0.42);
    }

    // 6) Bassline by zone subdivision: root (Z2-3), driving 8th (Z4), 16th (Z5)
    if (p.bass > 0.01) {
      if (p.bassSubdivision === 'root' && (stepInBar === 0 || stepInBar === 8)) {
        this.bassSynth?.triggerAttackRelease(chord.root, '4n', time, 0.72);
      } else if (p.bassSubdivision === '8th' && stepInBar % 2 === 0) {
        const note = stepInBar % 4 === 2 ? chord.rootOctaveUp : chord.root;
        this.bassSynth?.triggerAttackRelease(note, '8n', time, stepInBar % 4 === 0 ? 0.85 : 0.68);
      } else if (p.bassSubdivision === '16th') {
        const note = stepInBar % 4 === 2 ? chord.rootOctaveUp : chord.root;
        this.bassSynth?.triggerAttackRelease(note, '16n', time, stepInBar % 4 === 0 ? 0.9 : 0.66);
      }
    }

    // 7) Kick drum (soft half-bar pulse in Z2, four-on-the-floor in Z3..Z5)
    if (p.kick > 0.01) {
      if (p.kickPattern === 'soft' && (stepInBar === 0 || stepInBar === 8)) {
        this.kickSynth?.triggerAttackRelease('C1', '8n', time, 0.55);
      } else if (p.kickPattern === 'four-on-floor' && stepInBar % 4 === 0) {
        this.kickSynth?.triggerAttackRelease('C1', '8n', time, 0.85);
      }
    }

    // 8) Shaker (Z2+)
    if (p.shaker > 0.01 && stepInBar % 2 === 1) {
      this.shakerSynth?.triggerAttackRelease('32n', time, stepInBar % 4 === 3 ? 0.42 : 0.25);
    }

    // 9) Claps on beats 2 & 4 (Z3+)
    if (p.clap > 0.01 && (stepInBar === 4 || stepInBar === 12)) {
      this.clapSynth?.triggerAttackRelease('16n', time, 0.72);
    }

    // 10) Off-beat closed hats (Z3+) & open hats (Z4+)
    if (p.hatClosed > 0.01 && stepInBar % 4 === 2) {
      if (p.hatOpen > 0.01 && (stepInBar === 6 || stepInBar === 14)) {
        this.hatOpenSynth?.triggerAttackRelease('8n', time, 0.56);
      } else {
        this.hatClosedSynth?.triggerAttackRelease('32n', time, 0.54);
      }
    }

    // 11) 16th-note pluck arpeggio (Z3+)
    if (p.pluckArp > 0.01) {
      const arpNote = chord.arpNotes[stepInBar % chord.arpNotes.length];
      this.pluckArpSynth?.triggerAttackRelease(arpNote, '16n', time, stepInBar % 4 === 0 ? 0.62 : 0.44);
    }

    // 12) Lead melody / supersaw lead (Z4..Z5, skipped on Low quality via p.lead = 0)
    if (p.lead > 0.01 && stepInBar % 2 === 0) {
      const leadNote = chord.leadLine[stepInBar / 2];
      if (leadNote) {
        this.leadSynth?.triggerAttackRelease(leadNote, '8n', time, 0.58);
      }
    }

    // 13) Extra high arpeggio (Z5 only, skipped on Low quality via p.highArp = 0)
    if (p.highArp > 0.01 && stepInBar % 2 === 0) {
      const hiNote = chord.highArpNotes[(stepInBar / 2) % chord.highArpNotes.length];
      this.highArpSynth?.triggerAttackRelease(hiNote, '16n', time, 0.42);
    }

    // 14) Z5 turnaround snare rolls (every 4th bar beats 3-4)
    if (p.snareRoll > 0.01 && barIndex % 4 === 3 && stepInBar >= 10) {
      const vel = 0.28 + ((stepInBar - 10) / 6) * 0.52;
      this.snareSynth?.triggerAttackRelease('16n', time, vel);
    }

    // 15) 5-second interval anticipation snare build (quarter -> 8th -> 16th acceleration!)
    if (this.anticipationActive && !this.paused) {
      const cd = this.anticipationCountdown;
      const shouldHit =
        cd >= 4
          ? stepInBar % 4 === 0
          : cd >= 2
            ? stepInBar % 2 === 0
            : true;
      if (shouldHit) {
        const vel = Math.min(0.88, 0.35 + (5 - cd) * 0.12);
        this.snareSynth?.triggerAttackRelease('16n', time, vel);
      }
    }

    this.step16 = (this.step16 + 1) % 128;
  }
}

export const musicEngine = new AdaptiveMusicEngine();
