import { useEffect, useRef } from 'react';
import { getActiveZone, useAppStore } from '../store/useAppStore';
import { getBrowserCompatibility } from '../utils/browserCheck';
import { musicEngine } from './musicEngine';
import {
  createZoneHysteresisState,
  evaluateIntervalAnticipation,
  mapCogganToMusicZone,
  resolveMusicCandidateZone,
  stepZoneHysteresis,
  ZoneHysteresisState,
} from './musicEngineLogic';
import { synthwaveAudioPlayer } from './synthwaveAudio';

/**
 * Headless audio bridge mounted once in App.tsx.
 * Coordinates seamless crossfading between:
 * 1) Existing ambient Main Menu soundtrack (synthwaveAudioPlayer)
 * 2) Tone.js adaptive zone-reactive ride music (musicEngine) with:
 *    - 3-second zone hysteresis (Target power vs Actual 3s avg power)
 *    - 5-second interval anticipation riser & snare build + downbeat impact hit
 *    - Pause fade to Z1 pad layer & end-of-ride fade out
 *    - Settings Z1–Z5 audition panel & M mute shortcut
 */
export function SynthwaveAudioBridge() {
  const screen = useAppStore((s) => s.screen);
  const runState = useAppStore((s) => s.runState);
  const rideMode = useAppStore((s) => s.rideMode);
  const sceneryTheme = useAppStore((s) => s.sceneryTheme);
  const quality = useAppStore((s) => s.quality);
  const zone = useAppStore((s) => getActiveZone(s).zone);
  const intervalPulseCount = useAppStore((s) => s.intervalPulseCount);
  const countdownSec = useAppStore((s) => s.activeSnapshot?.countdownSec ?? null);
  const nextStepPowerLow = useAppStore((s) => s.activeSnapshot?.nextStep?.powerLow ?? null);

  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const audioMuted = useAppStore((s) => s.audioMuted);
  const audioMasterVolume = useAppStore((s) => s.audioMasterVolume);
  const audioMenuVolume = useAppStore((s) => s.audioMenuVolume);
  const audioRideVolume = useAppStore((s) => s.audioRideVolume);
  const musicFollowMode = useAppStore((s) => s.musicFollowMode);
  const musicTestZone = useAppStore((s) => s.musicTestZone);

  const hysteresisRef = useRef<ZoneHysteresisState>(createZoneHysteresisState(1));
  const lastPulseRef = useRef<number>(intervalPulseCount);
  const anticipationWasActiveRef = useRef<boolean>(false);
  const isTouchRef = useRef<boolean>(false);

  // Detect touch device once for Low/Medium audio quality scaling
  useEffect(() => {
    isTouchRef.current = getBrowserCompatibility().isTouchDevice;
  }, []);

  // Unlock Web Audio cleanly on first user click/tap/keypress (browser autoplay safe)
  useEffect(() => {
    const unlock = () => {
      synthwaveAudioPlayer.unlockFromGesture();
      const s = useAppStore.getState();
      if (!s.audioEnabled) return;
      const shouldRunAdaptive =
        s.musicTestZone !== null ||
        (s.screen === 'ride' && (s.runState === 'running' || s.runState === 'paused'));
      if (shouldRunAdaptive && !musicEngine.isRunning()) {
        musicEngine.start();
      }
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Global keyboard shortcut M to mute/unmute (works across Menu, Library, Settings & Ride)
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
      if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // RideScreen already handles KeyM on the ride screen; avoid double-toggling there
        if (useAppStore.getState().screen !== 'ride') {
          e.preventDefault();
          useAppStore.getState().toggleAudioMute();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Sync volume, mute, enabled, and quality settings into Tone.js adaptive engine
  useEffect(() => {
    musicEngine.setEnabled(audioEnabled);
    musicEngine.setMuted(audioMuted);
    musicEngine.setVolume(audioMasterVolume * audioRideVolume);
    musicEngine.setQuality(quality, isTouchRef.current);
  }, [audioEnabled, audioMuted, audioMasterVolume, audioRideVolume, quality]);

  // Crossfade between Menu ambient soundtrack and Adaptive Tone.js Ride music
  useEffect(() => {
    const isAuditioning = musicTestZone !== null;
    const isRideActive = screen === 'ride' && (runState === 'running' || runState === 'paused');
    const isRideCompleted = screen === 'ride' && runState === 'completed';
    const menuAudioShouldPlay = audioEnabled && !isAuditioning && !isRideActive && !isRideCompleted;

    // 1) Existing ambient menu soundtrack (fades out cleanly when adaptive ride music or Z1-Z5 test starts)
    synthwaveAudioPlayer.updateState({
      enabled: menuAudioShouldPlay,
      muted: audioMuted,
      masterVolume: audioMasterVolume,
      menuVolume: audioMenuVolume,
      rideVolume: audioMenuVolume * 0.65,
      screen: 'menu',
      runState: 'idle',
      zone,
      sceneryTheme,
    });

    // 2) Tone.js adaptive music lifecycle
    if (!audioEnabled) {
      musicEngine.stop(0.35);
      return;
    }

    if (isAuditioning && musicTestZone !== null) {
      musicEngine.setPaused(false);
      musicEngine.setIntervalAnticipation(false, 0);
      musicEngine.setZone(musicTestZone, true);
      musicEngine.start();
      return;
    }

    if (isRideActive) {
      const s = useAppStore.getState();
      const initialZone = resolveMusicCandidateZone({
        followMode: s.musicFollowMode,
        rideMode: s.rideMode,
        targetStepZone: s.activeSnapshot?.zone.zone ?? 2,
        freeRideZone: s.freeRideZone,
        power3sAvg: s.power3sAvg,
        ftp: s.ftp,
      });

      if (!musicEngine.isRunning()) {
        hysteresisRef.current = createZoneHysteresisState(initialZone);
        musicEngine.setZone(initialZone, false);
        musicEngine.start();
      }
      musicEngine.setPaused(runState === 'paused');
      return;
    }

    // Ride completed -> smooth fade out; Menu/Library -> crossfade back to menu music
    musicEngine.setIntervalAnticipation(false, 0);
    musicEngine.stop(isRideCompleted ? 1.5 : 0.95);
  }, [
    audioEnabled,
    audioMuted,
    audioMasterVolume,
    audioMenuVolume,
    screen,
    runState,
    sceneryTheme,
    zone,
    musicTestZone,
  ]);

  // 250ms zone hysteresis loop (3-second stability filter) while riding
  useEffect(() => {
    if (screen !== 'ride' || runState !== 'running' || !audioEnabled || musicTestZone !== null) {
      return;
    }

    const tickMs = 250;
    const timer = window.setInterval(() => {
      const s = useAppStore.getState();
      if (s.screen !== 'ride' || s.runState !== 'running' || s.musicTestZone !== null) return;

      const candidate = resolveMusicCandidateZone({
        followMode: s.musicFollowMode,
        rideMode: s.rideMode,
        targetStepZone: s.activeSnapshot?.zone.zone ?? 2,
        freeRideZone: s.freeRideZone,
        power3sAvg: s.power3sAvg,
        ftp: s.ftp,
      });

      const res = stepZoneHysteresis(hysteresisRef.current, candidate, tickMs / 1000);
      hysteresisRef.current = res.nextState;

      if (res.changed) {
        musicEngine.setZone(res.activeZone);
      }
    }, tickMs);

    return () => window.clearInterval(timer);
  }, [screen, runState, audioEnabled, musicFollowMode, musicTestZone]);

  // 5-second interval anticipation riser + snare build synced to countdown flash
  useEffect(() => {
    if (musicTestZone !== null) return;
    const evalResult = evaluateIntervalAnticipation({
      runState,
      rideMode,
      countdownSec,
      currentMusicZone: hysteresisRef.current.activeZone,
      nextStepPowerLow,
    });
    anticipationWasActiveRef.current = evalResult.active;
    musicEngine.setIntervalAnticipation(evalResult.active, countdownSec ?? 0);
  }, [runState, rideMode, countdownSec, nextStepPowerLow, musicTestZone]);

  // Downbeat impact hit when a workout interval steps UP right after the 5-second countdown
  useEffect(() => {
    if (intervalPulseCount === lastPulseRef.current) return;
    lastPulseRef.current = intervalPulseCount;
    if (screen !== 'ride' || runState !== 'running' || musicTestZone !== null) return;

    const s = useAppStore.getState();
    const nextMusicZone = mapCogganToMusicZone(
      s.rideMode === 'freeride' ? s.freeRideZone : s.activeSnapshot?.zone.zone ?? 2
    );

    if (anticipationWasActiveRef.current || nextMusicZone > hysteresisRef.current.activeZone) {
      anticipationWasActiveRef.current = false;
      hysteresisRef.current = createZoneHysteresisState(nextMusicZone);
      musicEngine.triggerStepImpact(nextMusicZone);
    }
  }, [intervalPulseCount, screen, runState, musicTestZone]);

  return null;
}
