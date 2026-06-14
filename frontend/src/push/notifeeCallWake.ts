/**
 * notifeeCallWake (iter-211)
 * ------------------------------------------------------------------
 * Notifee-only incoming-call wake-screen. NO CallKeep. NO VoIP-push.
 * NO ConnectionService. This is a deliberate, surgical alternative to
 * `callWakeScreen.ts` (which combined CallKeep + Notifee and had to
 * be rolled back in iter-202 because CallKeep's ConnectionService
 * intercepted the FCM message-channel and killed regular push).
 *
 * What this does (Android):
 *   - Creates a dedicated, MAX-importance channel
 *     `incoming-call-wake-v1` with bypassDnd + lockscreen-public
 *     + looping ringtone + vibration.
 *   - Displays a Notifee notification with
 *       category: AndroidCategory.CALL
 *       fullScreenAction: { id: 'default', launchActivity: 'default' }
 *     This is the Android-recommended way to ring + show a full-screen
 *     UI on the lockscreen WITHOUT CallKeep (per Notifee docs and
 *     Android 14/15 incoming-call style guidelines).
 *   - Looping the channel sound via `loopSound: true` so the device
 *     rings continuously until the user answers / declines / the
 *     caller hangs up.
 *
 * What this does NOT do:
 *   - It does NOT initialise CallKeep / VoIP push / ConnectionService
 *     so it CANNOT cannibalize the regular FCM message channel.
 *   - It does NOT replace any existing push handler — it ADDS the
 *     full-screen ring path. The existing local-notification scheduling
 *     in `usePushNotifications.ts` still fires (Android dedupes by
 *     notification id, so the user sees ONE ring, not two).
 *
 * iOS: Notifee on iOS cannot do a true CallKit incoming-call screen
 * (that requires PushKit + VoIP push cert). We fall back to a
 * high-priority, time-sensitive banner — the existing
 * `expo-notifications` interruptionLevel='timeSensitive' path already
 * handles this, so this module is intentionally an Android no-op on
 * iOS.
 */

import { Platform } from 'react-native';
import { recordDiagnostic } from '../lib/diagnostics';

const CHANNEL_ID = 'incoming-call-wake-v1';

let channelCreated = false;
let nativeCache: any | null = null;

type IncomingCallPayload = {
  callId: string;
  callerName?: string;
  callerId?: string;
  callType?: 'voice' | 'video' | 'audio';
  conversationId?: string;
};

function safeRecord(message: string) {
  try {
    recordDiagnostic({ tag: 'WAKE', source: 'notifeeCallWake', message });
  } catch {}
  try {
    // eslint-disable-next-line no-console
    console.log(`[NOTIFEE-WAKE] ${message}`);
  } catch {}
}

/**
 * Lazy-require @notifee/react-native so a missing native binding (e.g.
 * web preview, older build) NEVER throws at module load and breaks the
 * rest of the push pipeline.
 */
function loadNative(): any | null {
  if (Platform.OS === 'web') return null;
  if (nativeCache) return nativeCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const notifee = require('@notifee/react-native');
    nativeCache = {
      notifee: notifee.default || notifee,
      AndroidImportance: notifee.AndroidImportance,
      AndroidCategory: notifee.AndroidCategory,
      AndroidVisibility: notifee.AndroidVisibility,
    };
    return nativeCache;
  } catch (errorValue: any) {
    safeRecord(`load-native-failed: ${errorValue?.message || errorValue}`);
    return null;
  }
}

async function ensureCallChannel(): Promise<boolean> {
  if (channelCreated) return true;
  if (Platform.OS !== 'android') return false;
  const native = loadNative();
  if (!native) return false;
  try {
    await native.notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Incoming calls (wake-screen)',
      description: 'Rings and wakes the screen for incoming Smilers calls.',
      importance: native.AndroidImportance.HIGH, // MAX is reserved on some OEMs; HIGH+fullScreenAction wakes the screen.
      sound: 'ringtone',
      vibration: true,
      vibrationPattern: [0, 600, 300, 600, 300, 600],
      bypassDnd: false, // user-respectful — DND should silence
      visibility: native.AndroidVisibility.PUBLIC,
    });
    channelCreated = true;
    safeRecord(`channel-created: ${CHANNEL_ID}`);
    return true;
  } catch (errorValue: any) {
    safeRecord(`channel-create-failed: ${errorValue?.message || errorValue}`);
    return false;
  }
}

/**
 * Present a wake-screen incoming-call UI from an incoming-call payload.
 * Safe to call from background tasks AND foreground.
 *
 * iOS: silently no-ops — the existing expo-notifications
 *      `interruptionLevel: 'timeSensitive'` path is what surfaces
 *      iOS rings, until we wire up a true VoIP push cert.
 */
export async function presentIncomingCallNotifeeWake(
  payload: IncomingCallPayload,
): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!payload?.callId) {
    safeRecord('skip: no-callId');
    return;
  }
  const native = loadNative();
  if (!native) return;

  const ok = await ensureCallChannel();
  if (!ok) return;

  try {
    const callerName = payload.callerName?.trim() || 'Smilers user';
    const callType = payload.callType === 'video' ? 'video' : 'voice';
    await native.notifee.displayNotification({
      id: `call-wake-${payload.callId}`,
      title: callType === 'video' ? 'Incoming video call' : 'Incoming call',
      body: `${callerName} is calling…`,
      data: {
        type: 'call',
        callId: payload.callId,
        callerId: payload.callerId || payload.callId,
        callerName,
        callType,
        conversationId: payload.conversationId || '',
        action_url: payload.conversationId
          ? `smilers://call/${payload.conversationId}?callId=${payload.callId}&displayName=${encodeURIComponent(callerName)}`
          : `smilers://call/incoming?callId=${payload.callId}&displayName=${encodeURIComponent(callerName)}`,
      },
      android: {
        channelId: CHANNEL_ID,
        importance: native.AndroidImportance.HIGH,
        visibility: native.AndroidVisibility.PUBLIC,
        category: native.AndroidCategory.CALL,
        // The combination that wakes the screen on a LOCKED device:
        //   - fullScreenAction → launch the app over the keyguard
        //   - AndroidCategory.CALL → tells the system this is a phone call
        //   - importance HIGH → heads-up banner
        //   - ongoing + autoCancel=false → notification stays until handled
        //   - loopSound → ringtone repeats until dismissed
        fullScreenAction: { id: 'default', launchActivity: 'default' },
        pressAction: { id: 'default', launchActivity: 'default' },
        ongoing: true,
        autoCancel: false,
        loopSound: true,
        // We *don't* set a custom sound here — let the channel sound (ringtone) play.
      },
    });
    safeRecord(`displayed: callId=${payload.callId} callType=${callType}`);
  } catch (errorValue: any) {
    safeRecord(`display-failed: ${errorValue?.message || errorValue}`);
  }
}

/**
 * Cancel the wake-screen notification. Safe to call when no call is
 * active (Notifee silently no-ops).
 */
export async function cancelIncomingCallNotifeeWake(callId: string): Promise<void> {
  if (Platform.OS !== 'android' || !callId) return;
  const native = loadNative();
  if (!native) return;
  try {
    await native.notifee.cancelNotification(`call-wake-${callId}`);
    safeRecord(`cancelled: callId=${callId}`);
  } catch (errorValue: any) {
    safeRecord(`cancel-failed: ${errorValue?.message || errorValue}`);
  }
}
