/**
 * useEmergentPush — registers the device's native FCM/APNs token with the
 * Emergent-managed push relay (via FastAPI /api/register-push).
 *
 * Why this exists separately from `usePushNotifications`:
 *   - `usePushNotifications` was built against the legacy Expo-push +
 *     Convex pipeline. It still handles channel setup, tap routing, and
 *     foreground display behavior — all of which we want to KEEP.
 *   - This hook handles ONLY the Emergent-managed registration so that
 *     server-side pushes triggered via `/api/send-push-internal` can
 *     deliver to this device via FCM/APNs directly.
 *
 * Per the Emergent push playbook:
 *   1. Request permission FIRST.
 *   2. Get the native token via `getDevicePushTokenAsync()` — NOT the
 *      Expo wrapper token.
 *   3. POST `{ user_id, platform, device_token }` to /api/register-push.
 *   4. Re-register on every app open (tokens can rotate).
 *
 * Web/SSR-safe: early-returns on web.
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { useAuth } from '../providers/AuthProvider';
import { recordDiagnostic } from '../lib/diagnostics';
import {
  applyNotificationChannelPrefs,
  getChannelIdsForPrefs,
  readRingtonePrefs,
} from './notificationChannels';

const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || '';

type RegisterState =
  | 'idle'
  | 'waiting-auth'
  | 'requesting-permission'
  | 'permission-denied'
  | 'acquiring-token'
  | 'registering'
  | 'registered'
  | 'error';

let lastDeviceToken: string | null = null;
let lastRegisteredUserId: string | null = null;
let lastRegisteredAt = 0;

/**
 * iter-182: re-POST the registration for the last known device/user —
 * used by the Ringtones screen right after the user changes a tone so
 * the backend immediately learns the NEW tone-versioned channel ids
 * (instead of waiting for the next app foreground). Best-effort.
 */
export async function reregisterPushDevice(): Promise<void> {
  if (Platform.OS === 'web') return;
  const token = lastDeviceToken;
  const userId = lastRegisteredUserId;
  if (!token || !userId) return;
  // Bust the 5-minute throttle so future register() calls also re-POST.
  lastRegisteredAt = 0;
  try {
    await postRegisterPush({
      userId,
      platform: Platform.OS as 'ios' | 'android',
      deviceToken: token,
    });
    lastRegisteredAt = Date.now();
  } catch (errorValue: any) {
    try {
      recordDiagnostic({
        tag: 'NOTIFY',
        source: 'emergentPush/reregister',
        message: `re-register after tone change failed: ${errorValue?.message || errorValue}`,
      });
    } catch {}
  }
}

async function postRegisterPush(opts: {
  userId: string;
  platform: 'ios' | 'android';
  deviceToken: string;
}): Promise<void> {
  if (!BACKEND_URL) {
    throw new Error('EXPO_PUBLIC_BACKEND_URL is not configured.');
  }
  // iter-182: ensure the tone-versioned channels EXIST before telling the
  // backend to target them, then include their ids in the registration so
  // FCM pushes route into the channel carrying the user's selected sound.
  let channelIds: { callChannelId: string; messageChannelId: string } | null = null;
  if (opts.platform === 'android') {
    try {
      const prefs = await readRingtonePrefs();
      await applyNotificationChannelPrefs(prefs);
      channelIds = getChannelIdsForPrefs(prefs);
    } catch {
      channelIds = null;
    }
  }
  const url = `${BACKEND_URL}/api/register-push`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: opts.userId,
        platform: opts.platform,
        device_token: opts.deviceToken,
        ...(channelIds
          ? {
              call_channel_id: channelIds.callChannelId,
              message_channel_id: channelIds.messageChannelId,
            }
          : {}),
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      let detail = '';
      try {
        const json = await resp.json();
        detail = (json && (json.detail || json.message)) || '';
      } catch {}
      throw new Error(
        `register-push HTTP ${resp.status}${detail ? `: ${detail}` : ''}`,
      );
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ensurePermissionGranted(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const current = await Notifications.getPermissionsAsync();
  const isGranted =
    current.granted ||
    current.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    current.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL;
  if (isGranted) return true;
  if (current.canAskAgain === false) return false;
  const next = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return (
    next.granted ||
    next.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    next.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    next.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

/**
 * Returns the current state machine + a manual `retry()` so the
 * Notifications diagnostic screen can re-trigger registration on demand.
 */
export function useEmergentPush() {
  const { isAuthenticated, userInfo } = useAuth();
  const stateRef = useRef<RegisterState>('idle');
  const inFlightRef = useRef<Promise<void> | null>(null);

  const userId = userInfo?.sub || null;

  const register = useCallback(async () => {
    if (Platform.OS === 'web') {
      stateRef.current = 'idle';
      return;
    }
    if (!isAuthenticated || !userId) {
      stateRef.current = 'waiting-auth';
      return;
    }
    if (!Device.isDevice) {
      // Emulators do not get real push tokens; skip silently.
      stateRef.current = 'idle';
      return;
    }
    // Deduplicate concurrent registrations
    if (inFlightRef.current) return inFlightRef.current;

    inFlightRef.current = (async () => {
      try {
        stateRef.current = 'requesting-permission';
        const granted = await ensurePermissionGranted();
        if (!granted) {
          stateRef.current = 'permission-denied';
          try {
            recordDiagnostic({
              tag: 'NOTIFY',
              source: 'emergentPush/register',
              message: 'permission denied — skipping registration',
            });
          } catch {}
          return;
        }

        stateRef.current = 'acquiring-token';
        // Per Emergent push playbook — native FCM/APNs token, NOT Expo wrapper.
        const tokenResp = await Notifications.getDevicePushTokenAsync();
        const deviceToken = (tokenResp as any)?.data;
        if (!deviceToken || typeof deviceToken !== 'string') {
          throw new Error('getDevicePushTokenAsync returned an empty token');
        }

        // Throttle redundant re-registrations for the same user+token
        // within a 5-minute window.
        const now = Date.now();
        if (
          lastDeviceToken === deviceToken &&
          lastRegisteredUserId === userId &&
          now - lastRegisteredAt < 5 * 60 * 1000
        ) {
          stateRef.current = 'registered';
          return;
        }

        stateRef.current = 'registering';
        await postRegisterPush({
          userId,
          platform: Platform.OS as 'ios' | 'android',
          deviceToken,
        });

        lastDeviceToken = deviceToken;
        lastRegisteredUserId = userId;
        lastRegisteredAt = now;
        stateRef.current = 'registered';
        try {
          recordDiagnostic({
            tag: 'NOTIFY',
            source: 'emergentPush/register',
            message: `registered native token (preview: ${deviceToken.slice(0, 12)}…) for user ${userId.slice(0, 8)}…`,
          });
        } catch {}
      } catch (errorValue: any) {
        stateRef.current = 'error';
        try {
          recordDiagnostic({
            tag: 'NOTIFY',
            source: 'emergentPush/register',
            message: `register failed: ${errorValue?.message || errorValue}`,
          });
        } catch {}
        // Swallow — registration retries will fire on next foreground.
      } finally {
        inFlightRef.current = null;
      }
    })();
    return inFlightRef.current;
  }, [isAuthenticated, userId]);

  // 1) Register once on auth ready
  useEffect(() => {
    if (Platform.OS === 'web') return;
    void register();
  }, [register]);

  // 2) Re-register when token rotates (FCM/APNs occasionally rotates)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Notifications.addPushTokenListener(() => {
      // Bust the throttle so the next register() actually re-POSTs.
      lastDeviceToken = null;
      void register();
    });
    return () => {
      sub.remove();
    };
  }, [register]);

  // 3) Re-register on app foreground (covers token rotation + backend resets)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const handler = (next: AppStateStatus) => {
      if (next === 'active') void register();
    };
    const sub = AppState.addEventListener('change', handler);
    return () => {
      sub.remove();
    };
  }, [register]);
}

/**
 * Trigger a self-test push for the currently-signed-in user. Used by the
 * Notifications diagnostics screen.
 *
 * iter-129: backend now returns a structured FCM v1 delivery result so
 * the diagnostic UI can show definitive success/error per token, not
 * just an opaque "queued" message.
 */
export async function triggerEmergentSelfTestPush(userId: string): Promise<{
  status: string;
  fcm?: {
    attempted: boolean;
    token_count?: number;
    success_count?: number;
    error_count?: number;
    errors?: string[];
  };
}> {
  if (!BACKEND_URL) {
    throw new Error('EXPO_PUBLIC_BACKEND_URL is not configured.');
  }
  const resp = await fetch(`${BACKEND_URL}/api/self-test-push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  let body: any = null;
  try {
    body = await resp.json();
  } catch {}
  if (!resp.ok) {
    const detail = (body && (body.detail || body.message)) || '';
    throw new Error(
      `self-test-push HTTP ${resp.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return body || { status: 'accepted' };
}
