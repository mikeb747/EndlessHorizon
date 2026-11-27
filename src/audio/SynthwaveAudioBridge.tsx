import { useEffect } from 'react';
import { getActiveZone, useAppStore } from '../store/useAppStore';
import { synthwaveAudioPlayer } from './synthwaveAudio';

/**
 * Headless audio bridge mounted once in App.tsx.
 * Keeps the procedural synthwave ambient player smoothly synchronized across the
 * Main Menu, Workout Library, and active Rides (including live Coggan zone & scenery mood).
 */
export function SynthwaveAudioBridge() {
  const screen = useAppStore((s) => s.screen);
  const runState = useAppStore((s) => s.runState);
  const sceneryTheme = useAppStore((s) => s.sceneryTheme);
  const zone = useAppStore((s) => getActiveZone(s).zone);

  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const audioMuted = useAppStore((s) => s.audioMuted);
  const audioMasterVolume = useAppStore((s) => s.audioMasterVolume);
  const audioMenuVolume = useAppStore((s) => s.audioMenuVolume);
  const audioRideVolume = useAppStore((s) => s.audioRideVolume);

  // Unlock Web Audio smoothly on the first user click/tap/keypress (Chrome/Edge autoplay safe)
  useEffect(() => {
    const unlock = () => {
      synthwaveAudioPlayer.unlockFromGesture();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Push live state updates whenever screen, ride state, zone, theme, or volumes change
  useEffect(() => {
    synthwaveAudioPlayer.updateState({
      enabled: audioEnabled,
      muted: audioMuted,
      masterVolume: audioMasterVolume,
      menuVolume: audioMenuVolume,
      rideVolume: audioRideVolume,
      screen,
      runState,
      zone,
      sceneryTheme,
    });
  }, [
    audioEnabled,
    audioMuted,
    audioMasterVolume,
    audioMenuVolume,
    audioRideVolume,
    screen,
    runState,
    zone,
    sceneryTheme,
  ]);

  return null;
}
