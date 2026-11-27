import type { ZoneNumber } from '../core/zones';
import type { AppScreen, SceneryTheme, WorkoutRunState } from '../store/useAppStore';
import {
  computeEffectiveMasterGain,
  computeSynthwaveMixParams,
  midiToFreq,
  SYNTHWAVE_PROGRESSION,
  SynthwaveMixParams,
} from './synthwaveMath';

export interface SynthwavePlayerState {
  enabled: boolean;
  muted: boolean;
  masterVolume: number;
  menuVolume: number;
  rideVolume: number;
  screen: AppScreen;
  runState: WorkoutRunState;
  zone: ZoneNumber;
  sceneryTheme: SceneryTheme;
}

/**
 * Self-contained procedural Web Audio API Synthwave Ambient Player.
 * Generates warm detuned analog pads, rolling bass pulses, and shimmering dotted-8th
 * echo arpeggios with zero external audio asset dependencies.
 *
 * Respects browser autoplay policies: unlocks cleanly on the first pointer or keyboard
 * interaction, and suspends its AudioContext whenever muted or volume is 0 to save CPU.
 */
class SynthwaveAmbientPlayer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private padBus: GainNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private delaySend: GainNode | null = null;
  private delayNode: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;
  private lfoOsc: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;

  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private currentStep = 0; // 0..31 (4 bars x 8 eighth-notes per bar)
  private unlocked = false;

  private state: SynthwavePlayerState = {
    enabled: true,
    muted: false,
    masterVolume: 0.65,
    menuVolume: 0.55,
    rideVolume: 0.75,
    screen: 'menu',
    runState: 'idle',
    zone: 2,
    sceneryTheme: 'neon-city',
  };

  private mix: SynthwaveMixParams = computeSynthwaveMixParams({
    screen: 'menu',
    runState: 'idle',
    zone: 2,
    sceneryTheme: 'neon-city',
  });

  public updateState(next: SynthwavePlayerState): void {
    this.state = next;
    this.mix = computeSynthwaveMixParams({
      screen: next.screen,
      runState: next.runState,
      zone: next.zone,
      sceneryTheme: next.sceneryTheme,
    });

    const targetGain = computeEffectiveMasterGain(next);

    if (!this.ctx) {
      // Wait for user gesture unlock before creating AudioContext (avoids autoplay warnings)
      if (this.unlocked && targetGain > 0) {
        this.ensureGraph();
        this.applyLiveParams(targetGain);
        this.startScheduler();
      }
      return;
    }

    if (targetGain <= 0) {
      this.applyLiveParams(0);
      this.stopScheduler();
      if (this.ctx.state === 'running') {
        void this.ctx.suspend().catch(() => {});
      }
      return;
    }

    if (this.unlocked) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      this.applyLiveParams(targetGain);
      this.startScheduler();
    }
  }

  /**
   * Call from any user pointer/keyboard gesture to unlock Web Audio playback cleanly.
   */
  public unlockFromGesture(): void {
    this.unlocked = true;
    const targetGain = computeEffectiveMasterGain(this.state);
    if (targetGain <= 0) return;

    this.ensureGraph();
    if (!this.ctx) return;

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    this.applyLiveParams(targetGain, 0.9);
    this.startScheduler();
  }

  public isActive(): boolean {
    return this.ctx !== null && this.ctx.state === 'running' && this.schedulerTimer !== null;
  }

  public dispose(): void {
    this.stopScheduler();
    if (this.lfoOsc) {
      try {
        this.lfoOsc.stop();
      } catch {
        // Ignore already stopped oscillator
      }
      this.lfoOsc.disconnect();
      this.lfoOsc = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.masterGain = null;
    this.compressor = null;
    this.padBus = null;
    this.padFilter = null;
    this.delaySend = null;
    this.delayNode = null;
    this.delayFeedback = null;
    this.lfoGain = null;
  }

  private ensureGraph(): void {
    if (this.ctx || typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      this.ctx = ctx;

      // Soft dynamics compressor protects against any multi-voice peaking
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.knee.value = 18;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.015;
      compressor.release.value = 0.2;
      compressor.connect(ctx.destination);
      this.compressor = compressor;

      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      masterGain.connect(compressor);
      this.masterGain = masterGain;

      // Warm lush filter for synthwave pad bus
      const padFilter = ctx.createBiquadFilter();
      padFilter.type = 'lowpass';
      padFilter.frequency.value = this.mix.filterCutoffHz;
      padFilter.Q.value = this.mix.filterQ;
      padFilter.connect(masterGain);
      this.padFilter = padFilter;

      const padBus = ctx.createGain();
      padBus.gain.value = 1.0;
      padBus.connect(padFilter);
      this.padBus = padBus;

      // Slow analog filter sweep LFO
      const lfoOsc = ctx.createOscillator();
      lfoOsc.type = 'sine';
      lfoOsc.frequency.value = 0.09;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 260;
      lfoOsc.connect(lfoGain);
      lfoGain.connect(padFilter.frequency);
      lfoOsc.start();
      this.lfoOsc = lfoOsc;
      this.lfoGain = lfoGain;

      // Wide retro dotted-8th filtered echo bus
      const delaySend = ctx.createGain();
      delaySend.gain.value = this.mix.delayMix;

      const delayNode = ctx.createDelay(1.2);
      delayNode.delayTime.value = 0.375;

      const delayDamp = ctx.createBiquadFilter();
      delayDamp.type = 'lowpass';
      delayDamp.frequency.value = 2100;

      const delayFeedback = ctx.createGain();
      delayFeedback.gain.value = 0.34;

      delaySend.connect(delayNode);
      delayNode.connect(delayDamp);
      delayDamp.connect(delayFeedback);
      delayFeedback.connect(delayNode);
      delayDamp.connect(masterGain);

      this.delaySend = delaySend;
      this.delayNode = delayNode;
      this.delayFeedback = delayFeedback;
    } catch {
      this.ctx = null;
    }
  }

  private applyLiveParams(targetGain: number, rampSec = 0.35): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setTargetAtTime(Math.max(0, targetGain), now, Math.max(0.05, rampSec * 0.35));

    if (this.padFilter) {
      this.padFilter.frequency.setTargetAtTime(this.mix.filterCutoffHz, now, 0.45);
      this.padFilter.Q.setTargetAtTime(this.mix.filterQ, now, 0.45);
    }

    if (this.delaySend && this.delayNode) {
      this.delaySend.gain.setTargetAtTime(this.mix.delayMix, now, 0.4);
      // Sync echo cleanly to dotted eighth note of current BPM
      const dottedEighthSec = (60 / this.mix.bpm) * 0.75;
      this.delayNode.delayTime.setTargetAtTime(
        Math.max(0.2, Math.min(0.85, dottedEighthSec)),
        now,
        0.5
      );
    }
  }

  private startScheduler(): void {
    if (this.schedulerTimer !== null || !this.ctx) return;
    this.nextStepTime = this.ctx.currentTime + 0.08;
    this.schedulerTimer = setInterval(() => this.scheduleAhead(), 110);
  }

  private stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private scheduleAhead(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const lookaheadSec = 0.28;
    const eighthNoteSec = 60 / this.mix.bpm / 2;

    while (this.nextStepTime < this.ctx.currentTime + lookaheadSec) {
      this.triggerStep(this.currentStep, this.nextStepTime, eighthNoteSec);
      this.nextStepTime += eighthNoteSec;
      this.currentStep = (this.currentStep + 1) % 32;
    }
  }

  private triggerStep(stepIndex: number, time: number, stepDur: number): void {
    if (!this.ctx || !this.masterGain || !this.padBus || !this.delaySend) return;

    const barIndex = Math.floor(stepIndex / 8) % SYNTHWAVE_PROGRESSION.length;
    const stepInBar = stepIndex % 8;
    const chord = SYNTHWAVE_PROGRESSION[barIndex];
    const transpose = this.mix.rootMidiOffset;

    // 1) Bar-downbeat lush warm 4-voice synthwave pad
    if (stepInBar === 0) {
      const barDur = stepDur * 8;
      this.triggerPadChord(chord.padMidis, transpose, time, barDur);
    }

    // 2) Rolling analog bassline: steady 8ths during active rides, spacious half-notes in menu
    const shouldPlayBass = this.mix.isDriving ? true : stepInBar === 0 || stepInBar === 4;
    if (shouldPlayBass) {
      const accent = stepInBar % 4 === 0 ? 1.0 : 0.76;
      const bassDur = this.mix.isDriving ? stepDur * 0.88 : stepDur * 3.6;
      this.triggerBassPulse(chord.bassMidi + transpose, time, bassDur, accent);
    }

    // 3) Crystalline retro synth arpeggio: sparse dreamy twinkle in menu, rhythmic pulse during rides
    const shouldPlayArp = this.mix.isDriving
      ? stepInBar % 2 === 0 || this.mix.bpm >= 114
      : stepInBar === 2 || stepInBar === 6;
    if (shouldPlayArp) {
      const arpMidi = chord.arpMidis[stepInBar] + transpose;
      this.triggerArpNote(arpMidi, time, stepDur * 1.15);
    }
  }

  private triggerPadChord(
    midis: readonly [number, number, number, number],
    transpose: number,
    time: number,
    duration: number
  ): void {
    if (!this.ctx || !this.padBus || !this.delaySend) return;
    const ctx = this.ctx;
    const voiceGain = ctx.createGain();
    const peak = (this.mix.padLevel / midis.length) * 0.42;

    voiceGain.gain.setValueAtTime(0.0001, time);
    voiceGain.gain.linearRampToValueAtTime(peak, time + Math.min(1.1, duration * 0.28));
    voiceGain.gain.setValueAtTime(peak * 0.9, time + duration * 0.72);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.45);

    voiceGain.connect(this.padBus);
    voiceGain.connect(this.delaySend);

    for (let i = 0; i < midis.length; i++) {
      const freq = midiToFreq(midis[i] + transpose);

      const oscA = ctx.createOscillator();
      oscA.type = i % 2 === 0 ? 'sawtooth' : 'triangle';
      oscA.frequency.setValueAtTime(freq, time);
      oscA.detune.setValueAtTime(-6.5, time);
      oscA.connect(voiceGain);
      oscA.start(time);
      oscA.stop(time + duration + 0.5);

      const oscB = ctx.createOscillator();
      oscB.type = 'sawtooth';
      oscB.frequency.setValueAtTime(freq, time);
      oscB.detune.setValueAtTime(6.5, time);
      oscB.connect(voiceGain);
      oscB.start(time);
      oscB.stop(time + duration + 0.5);
    }
  }

  private triggerBassPulse(midi: number, time: number, duration: number, accent: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const peakCutoff = this.mix.isDriving ? 560 + accent * 260 : 320;
    filter.frequency.setValueAtTime(peakCutoff, time);
    filter.frequency.exponentialRampToValueAtTime(145, time + Math.min(0.24, duration));
    filter.Q.value = 2.4;

    const gain = ctx.createGain();
    const peak = this.mix.bassLevel * accent * 0.34;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(freq, time);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freq * 0.5, time);

    const subGain = ctx.createGain();
    subGain.gain.value = 0.55;

    saw.connect(filter);
    sub.connect(subGain);
    subGain.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    saw.start(time);
    sub.start(time);
    saw.stop(time + duration + 0.04);
    sub.stop(time + duration + 0.04);
  }

  private triggerArpNote(midi: number, time: number, duration: number): void {
    if (!this.ctx || !this.masterGain || !this.delaySend) return;
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(3600, this.mix.filterCutoffHz * 1.35), time);
    filter.frequency.exponentialRampToValueAtTime(680, time + duration);

    const gain = ctx.createGain();
    const peak = this.mix.arpLevel * 0.19;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, time);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    gain.connect(this.delaySend);

    osc.start(time);
    osc.stop(time + duration + 0.05);
  }
}

export const synthwaveAudioPlayer = new SynthwaveAmbientPlayer();
