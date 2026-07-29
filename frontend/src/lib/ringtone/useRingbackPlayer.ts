import { useEffect } from 'react';
import { Platform } from 'react-native';
import { InCallAudio } from '../webrtc/inCallManager';

/**
 * useRingbackPlayer — plays the Smilers theme to the CALLER while an outgoing
 * call is ringing (callee reachable / being rung), then stops the moment the
 * call connects, is declined, or ends.
 *
 * WHY InCallManager (not expo-audio): on the Stream call screen the WebRTC
 * audio session is active (MODE_IN_COMMUNICATION), which DUCKS/MUTES expo-audio's
 * media-stream playback — so the earlier expo-audio ringback was silent for the
 * caller. InCallManager's `startRingback('_BUNDLE_')` plays on the native
 * VOICE-CALL stream, which stays audible during an active call. The bundled
 * `incallmanager_ringback.mp3` IS the Smilers theme (identical asset), so the
 * caller hears the Smilers ringtone. `startNativeRingback` now also initialises
 * the InCallManager session first (the missing piece that made it silent).
 *
 * Fully defensive: no-op on web / if the native module is missing; never throws.
 */
export function useRingbackPlayer(active: boolean): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!active) return;
    InCallAudio.startRingback();
    return () => {
      InCallAudio.stopRingback();
    };
  }, [active]);
}

export default useRingbackPlayer;
