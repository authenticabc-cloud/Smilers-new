import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioSource,
} from 'expo-audio';
import { getRingSource, DEFAULT_RING_ID } from './ringCatalog';

// Safety cap — a ringback should never outlive a reasonable ring window even
// if the `active` flag stalls (e.g. subscription hiccup).
const MAX_RINGBACK_MS = 60_000;

/**
 * useRingbackPlayer — plays the Smilers theme to the CALLER while an outgoing
 * call is ringing (i.e. the callee is reachable and being rung), then stops
 * the moment the call connects, is declined, or ends.
 *
 * WHY expo-audio (not InCallManager): the Stream call screen never starts an
 * InCallManager audio session, so `InCallManager.startRingback('_BUNDLE_')`
 * had no initialised native audio manager and produced NO sound — the exact
 * "caller hears nothing while it says Ringing…" bug. This hook reuses the
 * SAME expo-audio path that already works for the callee's incoming ring, so
 * it reliably produces sound and needs no native session management.
 *
 * `interruptionMode: 'mixWithOthers'` lets it play alongside the WebRTC audio
 * session without fighting for exclusive audio focus; `playsInSilentMode: true`
 * ensures the caller still hears the ringback (matching a normal phone's
 * outgoing tone). No vibration — the caller doesn't need haptics.
 *
 * Safe on web (no-op).
 */
export function useRingbackPlayer(active: boolean): void {
  const playerRef = useRef<AudioPlayer | null>(null);
  const playingRef = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;

    const start = async () => {
      if (playingRef.current) return;
      playingRef.current = true;
      try {
        const source = getRingSource(DEFAULT_RING_ID);
        if (!source) return;
        try {
          await setAudioModeAsync({
            playsInSilentMode: true,
            allowsRecording: false,
            shouldPlayInBackground: true,
            interruptionMode: 'mixWithOthers',
            shouldRouteThroughEarpiece: false,
          });
        } catch (e: any) {
          console.warn('ringback setAudioModeAsync failed:', e?.message);
        }
        const player = createAudioPlayer(source as AudioSource);
        if (cancelled) {
          try {
            player.remove();
          } catch {}
          return;
        }
        playerRef.current = player;
        try {
          player.loop = true;
        } catch {}
        try {
          player.play();
        } catch (e: any) {
          console.warn('ringback play failed:', e?.message);
        }
      } catch (e: any) {
        console.warn('useRingbackPlayer start failed:', e?.message);
      }
    };

    const stop = () => {
      playingRef.current = false;
      const player = playerRef.current;
      playerRef.current = null;
      if (player) {
        try {
          player.pause();
        } catch {}
        try {
          player.remove();
        } catch {}
      }
    };

    if (active) {
      void start();
      maxTimer = setTimeout(() => {
        if (!cancelled) stop();
      }, MAX_RINGBACK_MS);
    } else {
      stop();
    }

    return () => {
      cancelled = true;
      if (maxTimer) clearTimeout(maxTimer);
      stop();
    };
  }, [active]);
}

export default useRingbackPlayer;
