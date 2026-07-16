/**
 * Shared voice-focused audio capture constraints for ALL react-native-webrtc
 * call paths (1:1 voice/video AND group mesh calls).
 *
 * IMPORTANT: the web app's getUserMedia constraints do NOT carry over to the
 * native app — react-native-webrtc has its own capture pipeline. So the same
 * "enhanced voice clarity" the web app enabled must be requested here too.
 *
 * What this enables:
 *  - echoCancellation (AEC)      → kills speakerphone echo
 *  - noiseSuppression (NS)       → removes background noise
 *  - autoGainControl (AGC)       → levels quiet/loud voices automatically
 *  - channelCount: 1 (mono)      → voice-focused capture
 *  - sampleRate: 48000           → studio sample rate
 *  - goog* mandatory flags       → forces WebRTC's APM DSPs + the Android
 *                                  VOICE_COMMUNICATION source where HW AEC/NS
 *                                  reliably kick in.
 */
export const VOICE_AUDIO_CONSTRAINTS: any = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  sourceId: 'default',
  mandatory: {
    googEchoCancellation: true,
    googEchoCancellation2: true,
    googAutoGainControl: true,
    googAutoGainControl2: true,
    googNoiseSuppression: true,
    googNoiseSuppression2: true,
    googHighpassFilter: true,
    googTypingNoiseDetection: true,
  },
};
