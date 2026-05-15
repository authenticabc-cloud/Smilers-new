import { useEffect, useRef } from 'react';
import { Platform, Vibration } from 'react-native';
import { Audio } from 'expo-av';
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

const DEFAULT_PREFS: RingPrefs = {
  ringtone: DEFAULT_RING_ID,
  notificationSound: 'smilers_never_cry_2',
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
 * Safe on web (no-ops).
 */
export function useRingtonePlayer(active: boolean): void {
  const soundRef = useRef<Audio.Sound | null>(null);
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
        const shouldVibrate = prefs.vibrate !== false;
        const isSilent = ringSource === null;

        // Configure audio mode so ringtone plays through speaker / ringer channel
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        });

        if (!isSilent && ringSource) {
          const { sound } = await Audio.Sound.createAsync(ringSource as any, {
            isLooping: true,
            volume: 1.0,
          });

          if (cancelled) {
            await sound.unloadAsync().catch(() => {});
            return;
          }

          soundRef.current = sound;
          await sound.playAsync().catch(() => {});
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
      const sound = soundRef.current;
      soundRef.current = null;
      if (sound) {
        try {
          await sound.stopAsync();
        } catch {}
        try {
          await sound.unloadAsync();
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
  }, [active]);
}
