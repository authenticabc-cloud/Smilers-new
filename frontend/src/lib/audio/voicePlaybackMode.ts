/**
 * voicePlaybackMode — configure expo-audio so voice notes and translated
 * audio keep playing when the user leaves the conversation, navigates
 * elsewhere in the app, OR backgrounds the app entirely (until they pause
 * or the clip finishes). Called lazily right before playback starts.
 *
 * `shouldPlayInBackground: true` pairs with the "audio" UIBackgroundMode
 * already declared in app.json (iOS) and lets short clips finish while
 * backgrounded on Android.
 */
import { setAudioModeAsync } from 'expo-audio';

let applied = false;

export async function ensureVoicePlaybackMode(): Promise<void> {
  if (applied) return;
  applied = true;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    });
  } catch {
    // Retry on next play if configuration failed.
    applied = false;
  }
}
