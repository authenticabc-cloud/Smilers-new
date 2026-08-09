/**
 * voicePlaybackMode — configure expo-audio so voice notes and translated
 * audio actually produce sound, and keep playing when the user leaves the
 * conversation or backgrounds the app. Called right before playback starts.
 *
 * `shouldPlayInBackground: true` pairs with the "audio" UIBackgroundMode
 * declared for iOS.
 */
import { setAudioModeAsync } from 'expo-audio';
import { recordDiagnostic } from '../diagnostics';

// NOTE (2026-08-08): this used to latch on a module-level `applied` flag so it
// ran exactly ONCE per app launch, and it never set `allowsRecording`.
// That combination silently killed playback: recording paths across the app
// (chat composer, diary, devotionals/compose, VoiceCommandLauncher,
// EmergencyCaptureService, calls) set `allowsRecording: true`, which puts the
// iOS session in PlayAndRecord — audio then routes to the EARPIECE at low
// volume, which users report as "audio is not playing". Because of the latch,
// playback never reconfigured the session afterwards, so the app stayed broken
// until the next cold start. Re-applying before every play is cheap and is
// what expo-audio expects.
export async function ensureVoicePlaybackMode(): Promise<void> {
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      // Force the session back to a playback-only category. Without this a
      // prior recording leaves PlayAndRecord active and playback is inaudible.
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch (err: any) {
    // Previously swallowed silently, which is why no diagnostic ever showed why
    // audio was dead in production. Surface it.
    recordDiagnostic({
      tag: 'AUDIO',
      source: 'voicePlaybackMode',
      message: `setAudioModeAsync failed: ${err?.message || String(err)}`,
    });
  }
}
