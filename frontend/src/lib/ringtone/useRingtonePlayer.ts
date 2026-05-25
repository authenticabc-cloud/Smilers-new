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
 *  - Plays it in loop
 *  - Vibrates the device in a phone-call cadence (unless user disabled vibrate)
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

        // Configure audio mode so ringtone plays through speaker / ringer channel.
        // expo-audio API: playsInSilentMode / shouldPlayInBackground / shouldRouteThroughEarpiece
        // (replaces expo-av's playsInSilentModeIOS / staysActiveInBackground / playThroughEarpieceAndroid).
        try {
          await setAudioModeAsync({
            playsInSilentMode: true,
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
            try {
              player.volume = 1.0;
            } catch {}
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
    } else {
      void stop();
    }

    return () => {
      cancelled = true;
      void stop();
    };
  }, [active, options?.vibrate]);
}

// AudioModule import kept to ensure the native module is bundled.
void AudioModule;
