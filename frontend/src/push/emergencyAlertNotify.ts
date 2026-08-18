/**
 * Emergency alert notifications — LOUD + REPEAT-until-opened so trustees never
 * miss one.
 *
 * - Dedicated Android channel at MAX importance, bypasses Do-Not-Disturb, strong
 *   vibration, and uses the loud `smilers_never_cry` tone (same as calls).
 * - On arrival we present the alert PLUS schedule a few timed repeats; opening
 *   the alert (viewer / tap) cancels the remaining repeats.
 * - Repeat identifiers are persisted so they can be cancelled even after the app
 *   was killed while the repeats were firing.
 *
 * iOS note: truly overriding silent/DND requires Apple's Critical Alerts
 * entitlement (special approval). Without it we use `timeSensitive`, which is
 * the loudest we can do on iOS unentitled.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const EMERGENCY_CHANNEL = 'emergency-v1';
const EMERGENCY_SOUND = 'smilers_never_cry';
const REPEAT_COUNT = 4; // repeats after the first alert
const REPEAT_EVERY_SEC = 30;
const REPEAT_KEY = (alertId: string) => `smilers.emergency.repeatIds.${alertId}`;

export async function ensureEmergencyChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(EMERGENCY_CHANNEL, {
      name: 'Emergency alerts',
      importance: Notifications.AndroidImportance.MAX,
      sound: EMERGENCY_SOUND,
      vibrationPattern: [0, 600, 300, 600, 300, 600],
      lightColor: '#DC2626',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
      enableVibrate: true,
      enableLights: true,
      showBadge: true,
    });
  } catch {
    /* best-effort */
  }
}

/** Present the emergency banner (sticky, loud) + schedule repeats until opened. */
export async function presentEmergencyAlert(payload: Record<string, any>): Promise<void> {
  const alertId = String(payload?.alertId || payload?.emergencyId || '');
  const title = (typeof payload?.title === 'string' && payload.title) || '🚨 Emergency alert';
  const body =
    (typeof payload?.body === 'string' && payload.body) ||
    (typeof payload?.senderName === 'string' && `${payload.senderName} needs help — tap to view`) ||
    'Someone who trusts you needs help — tap to view';

  await ensureEmergencyChannel();

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: payload,
      sound: EMERGENCY_SOUND,
      priority: Notifications.AndroidNotificationPriority.MAX,
      vibrate: [0, 600, 300, 600, 300, 600],
      interruptionLevel: 'timeSensitive',
      sticky: true,
      autoDismiss: false,
    } as any,
    trigger: Platform.OS === 'android' ? ({ channelId: EMERGENCY_CHANNEL } as any) : null,
  });

  if (!alertId) return;
  // Schedule timed repeats so it keeps ringing until the trustee opens it.
  const ids: string[] = [];
  for (let i = 1; i <= REPEAT_COUNT; i++) {
    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          data: payload,
          sound: EMERGENCY_SOUND,
          priority: Notifications.AndroidNotificationPriority.MAX,
          vibrate: [0, 600, 300, 600, 300, 600],
          interruptionLevel: 'timeSensitive',
        } as any,
        trigger: {
          seconds: i * REPEAT_EVERY_SEC,
          channelId: Platform.OS === 'android' ? EMERGENCY_CHANNEL : undefined,
        } as any,
      });
      ids.push(id);
    } catch {
      /* best-effort */
    }
  }
  try {
    await AsyncStorage.setItem(REPEAT_KEY(alertId), JSON.stringify(ids));
  } catch {
    /* best-effort */
  }
}

/** Cancel any pending repeat notifications for an alert (called when opened). */
export async function cancelEmergencyRepeats(alertId: string): Promise<void> {
  if (!alertId) return;
  try {
    const raw = await AsyncStorage.getItem(REPEAT_KEY(alertId));
    const ids: string[] = raw ? JSON.parse(raw) : [];
    await Promise.all(
      (Array.isArray(ids) ? ids : []).map((id) =>
        Notifications.cancelScheduledNotificationAsync(String(id)).catch(() => {}),
      ),
    );
    await AsyncStorage.removeItem(REPEAT_KEY(alertId));
  } catch {
    /* best-effort */
  }
}
