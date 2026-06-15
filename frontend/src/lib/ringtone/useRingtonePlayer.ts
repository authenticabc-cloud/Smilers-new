import { useEffect, useRef } from 'react';
import { Platform, Vibration } from 'react-native';
import {
  AudioModule,
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioSource,
} from 'expo-audio';
import { readStoredJson } from '../settingsStorage';
import { DEFAULT_RING_ID, getRingSource, type RingId } from './ringCatalog';

const RINGTONE_PREFS_KEY = 'smilers_ringtone_prefs';

// Phone-ring style vibration pattern: short pause, long pulse, short pause, long pulse...
const RING_VIBRATION_PATTERN = [0, 1000, 500, 1000, 500];

// iter-216 safety net: if `active` stays true for longer than a typical
// missed-call window, we force-stop the ringer regardless. This protects
// the user from a phantom ring that survives the caller hanging up — the
// Convex subscription that controls `active` may stall, but this timer
// is local-only and cannot stall.
const MAX_RING_DURATION_MS = 60_000;

interface RingPrefs {
  ringtone: RingId;
  notificationSound: RingId;
  vibrate: boolean;
}

interface UseRingtonePlayerOptions {
  vibrate?: boolean;
}

const DEFAULT_PREFS: RingPrefs = {
  ringtone: DEFAULT_RING_ID,
  notificationSound: 'smilers_notification',
  vibrate: true,
};

/**
 * useRingtonePlayer
 *
 * When `active` is true:
 *  - Loads the user's selected ringtone (from local prefs / Convex profile)
 *  - Plays it in loop AT THE SYSTEM RINGER VOLUME (no longer hardcoded to 1.0
 *    — iter-216 — so the device volume rocker actually controls how loud
 *    it rings).
 *  - HONOURS silent / vibrate device modes via `playsInSilentMode: false`
 *    (iter-216) — when the user has their phone in silent or vibrate-only
 *    mode the sound is suppressed by the OS, while the separate Vibration
 *    API call below keeps haptics working in vibrate mode.
 *  - Vibrates the device in a phone-call cadence (unless user disabled vibrate)
 *  - Auto-stops at 60s as a safety net against a phantom ring outliving
 *    the caller hanging up (iter-216).
 *
 * Stops both immediately when `active` flips to false or the hook unmounts.
 * Safe on web (no-ops). Uses `expo-audio` (expo-av was deprecated in SDK 54).
 */
export function useRingtonePlayer(active: boolean, options?: UseRingtonePlayerOptions): void {
  const playerRef = useRef<AudioPlayer | null>(null);
  const isPlayingRef = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    let cancelled = false;
    let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

    const start = async () => {
      if (isPlayingRef.current) return;
      isPlayingRef.current = true;

      try {
        // Load user prefs (falls back to defaults if missing)
        const stored = ((await readStoredJson(RINGTONE_PREFS_KEY, null)) as RingPrefs | null) || null;
        const prefs: RingPrefs = stored ? { ...DEFAULT_PREFS, ...stored } : DEFAULT_PREFS;
        const ringSource = getRingSource(prefs.ringtone);
        const shouldVibrate = options?.vibrate ?? (prefs.vibrate !== false);
        const isSilent = ringSource === null;

        // iter-216 SILENT MODE RESPECT: `playsInSilentMode: false` lets the OS
        // suppress audio when the user has flipped the silent switch (iOS) or
        // chosen the silent/vibrate ringer mode (Android). The separate
        // Vibration.vibrate() call below still fires, so vibrate-only mode
        // still vibrates — exactly the behaviour the user requested.
        try {
          await setAudioModeAsync({
            playsInSilentMode: false,
            allowsRecording: false,
            shouldPlayInBackground: true,
            interruptionMode: 'duckOthers',
            shouldRouteThroughEarpiece: false,
          });
        } catch (audioModeError: any) {
          console.warn('ringtone setAudioModeAsync failed:', audioModeError?.message);
        }

        if (!isSilent && ringSource) {
          try {
            const player = createAudioPlayer(ringSource as AudioSource);
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
            // iter-216 RINGER VOLUME RESPECT: we no longer hard-set
            // player.volume = 1.0. Leaving it at the default means the system
            // ringer volume (the volume rocker, the device "Sound" slider)
            // controls how loud the ringtone is — matching the user's
            // expectation that "lowering ring volume on device should affect
            // the app's ringing too".
            try {
              player.play();
            } catch (playError: any) {
              console.warn('ringtone play failed:', playError?.message);
            }
          } catch (createError: any) {
            console.warn('ringtone create failed:', createError?.message);
          }
        }

        if (shouldVibrate) {
          Vibration.vibrate(RING_VIBRATION_PATTERN, true);
        }
      } catch (errorValue: any) {
        console.warn('useRingtonePlayer start failed:', errorValue?.message);
      }
    };

    const stop = async () => {
      isPlayingRef.current = false;
      try {
        Vibration.cancel();
      } catch {}
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
      // iter-216 safety net: cap the ring at 60s. If the caller hangs up
      // and the Convex subscription stalls (so `active` doesn't flip to
      // false), this still kills the ringer.
      maxDurationTimer = setTimeout(() => {
        if (!cancelled) {
          console.log('[ringtone] max duration 60s hit — auto-stopping');
          void stop();
        }
      }, MAX_RING_DURATION_MS);
    } else {
      void stop();
    }

    return () => {
      cancelled = true;
      if (maxDurationTimer) clearTimeout(maxDurationTimer);
      void stop();
    };
  }, [active, options?.vibrate]);
}

// AudioModule import kept to ensure the native module is bundled.
void AudioModule;
