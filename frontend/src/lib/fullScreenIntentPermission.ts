/**
 * fullScreenIntentPermission (iter-215)
 * ------------------------------------------------------------------
 * Android 14 (API 34) introduced a new runtime-granted permission
 * called `USE_FULL_SCREEN_INTENT`. We declare it in app.json so the
 * permission is bound to the app, BUT on Android 14+ devices Google
 * silently downgrades any `fullScreenAction` notification to a
 * heads-up banner unless the user has ALSO granted the permission
 * via Settings → Apps → Smilers → "Full-screen notifications".
 *
 * The user-visible symptom is exactly what the user reported:
 *   - Rings + heads-up banner appear ✓
 *   - But on a LOCKED phone, the screen does NOT wake up ✗
 *
 * This module:
 *   1. Detects whether the device runs Android 14+ (where the runtime
 *      grant matters) — older Android versions auto-grant from the
 *      manifest declaration.
 *   2. Routes the user to the Settings page where they grant it.
 *   3. Remembers (via AsyncStorage) whether we've already prompted so
 *      we don't pester them on every launch.
 *
 * No native code required — we use `expo-intent-launcher` to open the
 * exact Settings activity (`MANAGE_APP_USE_FULL_SCREEN_INTENT`).
 */

import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PROMPTED_KEY = '@smilers/full-screen-intent-prompted-v1';

/**
 * Android 14+ (API 34+) is the only OS that requires the runtime grant.
 * Older versions auto-grant from the manifest declaration.
 *
 * We expose this as a function (not a const) so it's re-evaluated if
 * the OS reports a different value at any later point.
 */
export function isAndroid14Plus(): boolean {
  if (Platform.OS !== 'android') return false;
  // Platform.Version on Android is the API level as a number.
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
  return apiLevel >= 34;
}

/**
 * Returns true if we should consider asking the user to grant the
 * permission. The actual grant state cannot be queried from JS
 * without a custom native module — so this is a heuristic:
 *
 *   - Android <14 → false (permission auto-granted from manifest)
 *   - iOS → false (no such permission)
 *   - Android 14+ → true (we can't tell if granted; safer to allow ask)
 *
 * Callers that need a one-shot prompt should combine this with
 * `wasAlreadyPrompted()` to avoid pestering the user every launch.
 */
export function shouldAskForFullScreenIntent(): boolean {
  return isAndroid14Plus();
}

export async function wasAlreadyPrompted(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(PROMPTED_KEY);
    return v === '1';
  } catch {
    return false;
  }
}

export async function markPrompted(): Promise<void> {
  try {
    await AsyncStorage.setItem(PROMPTED_KEY, '1');
  } catch {
    /* swallow */
  }
}

export async function clearPromptMemory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PROMPTED_KEY);
  } catch {
    /* swallow */
  }
}

/**
 * Opens the Android Settings page where the user can grant Smilers
 * the "Allow full-screen notifications" permission.
 *
 * On Android 14+:
 *   action = android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT
 *   data   = package:com.smilers.app
 *
 * On older Android (or fallback path), we open the regular app
 * notification settings page — which is still useful since the user
 * can dig into the relevant channel from there.
 *
 * Returns true if an Activity was launched, false otherwise (so the
 * caller can show a manual-instructions Alert as fallback).
 */
export async function openFullScreenIntentSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;

  const packageName =
    Application.applicationId ||
    (Platform as any).constants?.PackageName ||
    'com.smilers.app';

  // Android 14+ specific intent.
  if (isAndroid14Plus()) {
    try {
      await IntentLauncher.startActivityAsync(
        'android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT',
        { data: `package:${packageName}` },
      );
      return true;
    } catch (errorValue: any) {
      // Falls through to the app-notification-settings path below.
      // eslint-disable-next-line no-console
      console.log('[full-screen-intent] MANAGE_APP_USE_FULL_SCREEN_INTENT failed:', errorValue?.message);
    }
  }

  // Fallback: open the app's main notification settings — same place
  // the user can find Full-screen notifications a couple of taps down.
  try {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.APP_NOTIFICATION_SETTINGS,
      { extra: { 'android.provider.extra.APP_PACKAGE': packageName } },
    );
    return true;
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.log('[full-screen-intent] APP_NOTIFICATION_SETTINGS failed:', errorValue?.message);
  }

  return false;
}
