/**
 * notificationChannels — iter-182 single source of truth for Android
 * notification channel ids + creation.
 *
 * WHY VERSIONED CHANNEL IDS:
 * Android notification channels are IMMUTABLE after creation — calling
 * `setNotificationChannelAsync` with a different `sound` on an existing
 * channel id is silently ignored by the OS, and deleting + recreating
 * the same id resurrects the old settings. The ONLY reliable way to
 * change a channel's sound is to use a NEW channel id.
 *
 * So the user's selected ringtone/notification tone is encoded INTO the
 * channel id (`calls-v4-<sound>` / `messages-v4-<sound>`). When the user
 * picks a different tone, a fresh channel is created with the new sound
 * and the device re-registers with the backend so FCM pushes route into
 * the new channel. Old channels stay behind harmlessly.
 *
 * The call channels are created at IMPORTANCE MAX (heads-up + lights the
 * screen on most devices) + bypassDnd + PUBLIC lockscreen — the closest
 * Android gets to a wake-screen ring without a native full-screen-intent
 * service (CallKeep), which is currently blocked by the build pipeline.
 */
import { Platform } from 'react-native';
import { readStoredJson } from '../lib/settingsStorage';

export const RINGTONE_PREFS_KEY = 'smilers_ringtone_prefs';

/** Legacy fixed ids — still created for backward compatibility with
 * pushes sent before the backend learns this device's versioned ids. */
export const LEGACY_CALLS_CHANNEL = 'calls';
export const LEGACY_MESSAGES_CHANNEL = 'messages-v3';

export interface RingtonePrefs {
  ringtone?: string | null;
  notificationSound?: string | null;
  vibrate?: boolean;
}

/** Map a ringtone pref id → bundled res/raw sound basename (undefined = silent). */
export function resolveCallChannelSound(ringtoneId?: string | null): string | undefined {
  switch (ringtoneId) {
    case 'ringtone':
      return 'ringtone';
    case 'smilers_never_cry_1':
      return 'smilers_never_cry_1';
    case 'smilers_never_cry_2':
      return 'smilers_never_cry_2';
    case 'smilers_never_cry_3':
      return 'smilers_never_cry_3';
    case 'smilers_notification':
      return 'smilers_notification';
    case 'silent':
      return undefined;
    case 'smilers_never_cry':
    default:
      return 'smilers_never_cry';
  }
}

export function resolveMessageChannelSound(notificationSoundId?: string | null): string | undefined {
  switch (notificationSoundId) {
    case 'silent':
      return undefined;
    case 'smilers_notification':
    default:
      return 'message_notification';
  }
}

/** Versioned channel ids derived from the current prefs. */
export function getChannelIdsForPrefs(prefs?: RingtonePrefs | null): {
  callChannelId: string;
  messageChannelId: string;
} {
  const callSound = resolveCallChannelSound(prefs?.ringtone) || 'silent';
  const messageSound = resolveMessageChannelSound(prefs?.notificationSound) || 'silent';
  return {
    callChannelId: `calls-v4-${callSound}`,
    messageChannelId: `messages-v4-${messageSound}`,
  };
}

export async function readRingtonePrefs(): Promise<RingtonePrefs | null> {
  try {
    return (await readStoredJson(RINGTONE_PREFS_KEY, null)) as RingtonePrefs | null;
  } catch {
    return null;
  }
}

/**
 * Create (idempotently) the versioned channels for the given prefs.
 * Safe to call repeatedly — recreating a channel with identical params
 * is a no-op on Android.
 */
export async function applyNotificationChannelPrefs(prefs?: RingtonePrefs | null): Promise<void> {
  if (Platform.OS !== 'android') return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Notifications = require('expo-notifications') as typeof import('expo-notifications');
  const { callChannelId, messageChannelId } = getChannelIdsForPrefs(prefs);
  const vibrate = prefs?.vibrate !== false;
  try {
    await Notifications.setNotificationChannelAsync(callChannelId, {
      name: 'Incoming Calls',
      // MAX = heads-up + screen light-up; HIGH only banners.
      importance: Notifications.AndroidImportance.MAX,
      sound: resolveCallChannelSound(prefs?.ringtone),
      vibrationPattern: [0, 1000, 500, 1000, 500, 1000],
      lightColor: '#E4B53B',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
      enableVibrate: vibrate,
      enableLights: true,
      showBadge: false,
    });
    await Notifications.setNotificationChannelAsync(messageChannelId, {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      sound: resolveMessageChannelSound(prefs?.notificationSound),
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#E4B53B',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      enableVibrate: vibrate,
      showBadge: true,
    });
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[channels] applyNotificationChannelPrefs failed:', errorValue?.message);
  }
}
