/**
 * Shared voice-note recording options.
 *
 * WHY MONO: expo-audio's `RecordingPresets.HIGH_QUALITY` records in STEREO
 * (numberOfChannels: 2). Most phones (especially Android) have a single mono
 * microphone, and asking the platform AAC encoder to produce 2 channels from a
 * mono input can yield a valid-but-SILENT .m4a on many devices — the note
 * "plays" but has no sound. Voice notes are speech, so mono (numberOfChannels:
 * 1) is both correct and far more compatible.
 *
 * We also enable metering so the UI can show a live mic level (and so we can
 * confirm the microphone is actually being captured).
 */
import { RecordingPresets, type RecordingOptions } from 'expo-audio';

export const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  isMeteringEnabled: true,
  android: {
    ...RecordingPresets.HIGH_QUALITY.android,
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    // NOISE CANCELLATION: 'voice_communication' selects the platform's VoIP
    // capture path, which applies hardware/system echo cancellation, noise
    // suppression, and automatic gain control when the device supports it —
    // the same class of processing used for calls, now for voice notes.
    audioSource: 'voice_communication',
  },
  ios: {
    ...RecordingPresets.HIGH_QUALITY.ios,
  },
  web: {
    ...RecordingPresets.HIGH_QUALITY.web,
  },
};
