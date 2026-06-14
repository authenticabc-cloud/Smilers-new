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
import { useQuery } from 'convex/react';
import { api } from '../convexApi';
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
// iter-198: the Convex users._id registered alongside the OIDC sub —
// client-triggered pushes (/api/notify-event) address recipients by
// Convex id, so the backend needs this mapping.
let lastConvexUserId: string | null = null;

/**
 * iter-182: re-POST the registration for the last known device/user —
 * used by the Ringtones screen right after the user changes a tone so
 * the backend immediately learns the NEW tone-versioned channel ids
 * (instead of waiting for the next app foreground). Best-effort.
 */
/**
 * iter-200: feed the Convex users._id into the push registration from ANY
 * screen that already loads the current user (chat screen does). The
 * useQuery inside the hook is kept as the primary source, but this setter
 * guarantees the id reaches the backend even if that query is slow or
 * unavailable in the hook's provider context — production tokens were
 * observed with has_convex_id=false despite the hook being mounted.
 */
export function reportConvexUserIdForPush(id: string | null | undefined): void {
  const value = id == null ? '' : String(id).trim();
  if (!value || lastConvexUserId === value) return;
  lastConvexUserId = value;
  // If we already registered without the id, re-POST so the backend can
  // match client-triggered pushes addressed by Convex id.
  void reregisterPushDevice();
}

/**
 * Re-POST the current registration with updated channel ids. Called by
 * the ringtones screen after the user picks a new tone (which creates a
 * new versioned channel) so the BACKEND routes future FCM pushes into
 * the new channel immediately.
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
      convexUserId: lastConvexUserId,
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
  convexUserId?: string | null;
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
        // iter-203 (CRITICAL regression fix): without `convex_user_id` in
        // the registration body, the backend stores push tokens keyed
        // ONLY by the OIDC `user_id`. But `/api/notify-event` resolves
        // message recipients to their Convex `users._id` — so every
        // background / killed-app push lookup returned ZERO tokens and
        // ZERO deliveries (visible in server.err.log as
        // `notify-event: ... tokens=0 delivered=0`). The iter-199 fix
        // for this regressed during a later refactor that dropped this
        // field from the POST payload while keeping the function arg.
        ...(opts.convexUserId
          ? { convex_user_id: opts.convexUserId }
          : {}),
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
  // iter-198: capture the Convex users._id alongside the OIDC sub so the
  // backend can match client-triggered pushes addressed by Convex id.
  const me = useQuery(
    api.users.getCurrentUser,
    isAuthenticated && Platform.OS !== 'web' ? {} : 'skip',
  ) as any | null | undefined;
  const convexUserId: string | null = me?._id ? String(me._id) : null;

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
        // within a 5-minute window — UNLESS the Convex user id just
        // became available (we must persist the id mapping promptly).
        const effectiveConvexUserId = convexUserId || lastConvexUserId;
        const now = Date.now();
        if (
          lastDeviceToken === deviceToken &&
          lastRegisteredUserId === userId &&
          (!effectiveConvexUserId || lastConvexUserId === effectiveConvexUserId) &&
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
          convexUserId: effectiveConvexUserId,
        });

        lastDeviceToken = deviceToken;
        lastRegisteredUserId = userId;
        if (effectiveConvexUserId) lastConvexUserId = effectiveConvexUserId;
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
  }, [isAuthenticated, userId, convexUserId]);

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

  // iter-208 (push reliability — race fix): on cold start the OIDC
  // userId resolves fast but the Convex `me._id` query can take
  // noticeably longer, especially when the socket is reconnecting.
  // That race causes the first /api/register-push to land WITHOUT
  // convex_user_id, and the row stays that way — which makes
  // every subsequent message/call notify-event miss the token
  // lookup (`tokens=0 delivered=0` in server logs).
  //
  // To self-heal, we retry registration on a backoff schedule
  // (5s / 30s / 2min) AS LONG AS we still don't have a convex_user_id
  // persisted. The retries reset the in-process throttle so the
  // backend gets a fresh POST that finally includes the mapping.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!isAuthenticated || !userId) return;
    const delays = [5_000, 30_000, 120_000];
    const timers: any[] = [];
    delays.forEach((delay) => {
      const t = setTimeout(() => {
        // Only retry while the mapping is still unknown — once we've
        // saved a convex_user_id we stop hammering the endpoint.
        if (!lastConvexUserId) {
          lastRegisteredAt = 0; // bust the 5-minute throttle
          void register();
        }
      }, delay);
      timers.push(t);
    });
    return () => timers.forEach((t) => clearTimeout(t));
  }, [isAuthenticated, userId, register]);

  // iter-208: extra safety — every time the Convex `me._id` flips
  // from null to a real value we explicitly bust the throttle and
  // re-register, regardless of how long it took. Without this the
  // arrival of `me._id` 5–30 seconds late could still be silently
  // swallowed by the throttle's "if lastConvexUserId === current" arm.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!convexUserId) return;
    if (lastConvexUserId === convexUserId) return; // already persisted
    lastRegisteredAt = 0;
    void register();
  }, [convexUserId, register]);
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
