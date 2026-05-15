import { useEffect, useRef } from 'react';
import { Platform, Vibration } from 'react-native';
import { Audio } from 'expo-av';

const RINGTONE_ASSET = require('../../../assets/sounds/ringtone.mp3');

// Phone-ring style vibration pattern: short pause, long pulse, short pause, long pulse...
const RING_VIBRATION_PATTERN = [0, 1000, 500, 1000, 500];

/**
 * useRingtonePlayer
 *
 * When `active` is true, plays the ringtone in loop AND vibrates the device in a
 * phone-call cadence. Stops both immediately when `active` flips to false or the
 * hook unmounts. Safe to call on web (no-ops).
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
        // Configure audio mode so ringtone plays through speaker / ringer channel
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        });

        const { sound } = await Audio.Sound.createAsync(
          RINGTONE_ASSET,
          { isLooping: true, volume: 1.0 }
        );

        if (cancelled) {
          await sound.unloadAsync().catch(() => {});
          return;
        }

        soundRef.current = sound;
        await sound.playAsync().catch(() => {});

        // Start a repeating vibration pattern
        Vibration.vibrate(RING_VIBRATION_PATTERN, true);
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
