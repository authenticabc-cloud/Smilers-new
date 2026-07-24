import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Per-DEVICE notification preferences.
 *
 * These are intentionally stored locally (AsyncStorage) — NOT on the Convex
 * user profile. The Notifications screen says "notifications you want to
 * receive on THIS device", so the setting is device-scoped by design. Storing
 * them on the shared profile also caused a Convex `users:updateProfile` Server
 * Error (the users schema has no `notifications` field), which blocked the
 * toggles entirely. Local storage removes that backend dependency and lets the
 * push-display layer consult these flags to suppress unwanted notifications.
 */
const KEY = 'smilers_notification_prefs_v1';

export type NotificationPrefs = Record<string, boolean>;

export const NOTIFICATION_PREF_KEYS = [
  'messages',
  'groups',
  'calls',
  'statuses',
  'reactions',
  'mentions',
] as const;

const DEFAULTS: NotificationPrefs = {
  messages: true,
  groups: true,
  calls: true,
  statuses: true,
  reactions: true,
  mentions: true,
};

export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveNotificationPref(
  key: string,
  value: boolean,
): Promise<NotificationPrefs> {
  const current = await loadNotificationPrefs();
  const next = { ...current, [key]: value };
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

/** Whether a given notification type should be shown on this device. */
export async function isNotificationTypeEnabled(key: string): Promise<boolean> {
  const prefs = await loadNotificationPrefs();
  return prefs[key] !== false;
}
