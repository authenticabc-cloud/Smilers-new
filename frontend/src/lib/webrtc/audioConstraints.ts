/**
 * Shared voice-focused audio capture constraints for ALL react-native-webrtc
 * call paths (1:1 voice/video AND group mesh calls).
 *
 * IMPORTANT: the web app's getUserMedia constraints do NOT carry over to the
 * native app — react-native-webrtc has its own capture pipeline, so the same
 * clarity settings must be requested here.
 *
 * react-native-webrtc (libwebrtc) honors the STANDARD top-level flags below.
 * The legacy Chrome `mandatory: { googEchoCancellation: ... }` style is largely
 * ignored by modern libwebrtc and can even cause the constraint set to be
 * misparsed (silently disabling processing) — so we deliberately use the clean
 * standard form.
 *
 *  - echoCancellation (AEC)  → ALWAYS on. This is what kills the echo where your
 *                              mic re-captures the other person's voice from your
 *                              speaker. Never user-disableable.
 *  - noiseSuppression (NS)   → removes background noise (user-toggleable).
 *  - autoGainControl (AGC)   → levels quiet/loud voices (follows the NS toggle).
 *  - channelCount: 1 (mono)  → voice-focused capture.
 */
import { readStoredString, writeStoredString } from '../settingsStorage';

export const NOISE_CANCELLATION_KEY = 'smilers_call_noise_suppression';

// In-memory cache (default ON). Loaded from storage at app start via
// loadNoiseCancellationPref() so getVoiceAudioConstraints() stays synchronous.
let _noiseSuppressionEnabled = true;

export async function loadNoiseCancellationPref(): Promise<void> {
  try {
    const v = await readStoredString(NOISE_CANCELLATION_KEY);
    _noiseSuppressionEnabled = v !== '0';
  } catch {
    _noiseSuppressionEnabled = true;
  }
}

export async function setNoiseCancellationPref(enabled: boolean): Promise<void> {
  _noiseSuppressionEnabled = enabled;
  try {
    await writeStoredString(NOISE_CANCELLATION_KEY, enabled ? '1' : '0');
  } catch {
    /* best effort */
  }
}

export function isNoiseCancellationEnabled(): boolean {
  return _noiseSuppressionEnabled;
}

/** Build the audio capture constraints for a call. Echo cancellation is
 *  always on; noise suppression / auto-gain follow the user's toggle. */
export function getVoiceAudioConstraints(): any {
  return {
    echoCancellation: true,
    noiseSuppression: _noiseSuppressionEnabled,
    autoGainControl: _noiseSuppressionEnabled,
    channelCount: 1,
  };
}
