/**
 * notifeeCallWake (iter-211 → iter-217)
 * ------------------------------------------------------------------
 * Notifee-only incoming-call wake-screen. NO CallKeep. NO VoIP-push.
 * NO ConnectionService (CallKeep's ConnectionService cannibalized the
 * FCM message channel in iter-202, so it stays banished).
 *
 * iter-217 — this is now the SOLE renderer of incoming calls on Android.
 * Call pushes are sent DATA-ONLY from the backend, so Android no longer
 * auto-displays a plain (message-tone) notification. This module owns the
 * whole incoming-call experience:
 *   - Looping RINGTONE via a dedicated MAX-importance channel.
 *   - A PERSISTENT, full-screen, ongoing ring with ANSWER / DECLINE
 *     action buttons.
 *   - A MISSED-CALL follow-up notification when the call is unanswered
 *     (ring times out) or declined.
 *   - Background + foreground notifee event handlers so Answer/Decline
 *     work even when the app is killed (Answer launches + routes to the
 *     call screen; Decline ends the Twilio room so the caller stops
 *     ringing).
 *
 * iOS: Notifee can't do a true CallKit screen (needs PushKit + VoIP
 * cert). This module is an intentional Android no-op on iOS — the
 * expo-notifications time-sensitive banner handles iOS.
 */

import { Platform } from 'react-native';
import { recordDiagnostic } from '../lib/diagnostics';

const CHANNEL_ID = 'incoming-call-wake-v1';
const MISSED_CHANNEL_ID = 'missed-calls-v1';
// Ring auto-stops + the missed-call follow-up appears after this long.
const RING_TIMEOUT_MS = 35000;

let channelCreated = false;
let missedChannelCreated = false;
let nativeCache: any | null = null;
let eventsRegistered = false;

// Navigator bridge — the app root sets this so an answered call can route
// into the in-app call screen. Until it's set (cold start), the route is
// stashed in `pendingCallRoute` and consumed on mount.
let callNavigator: ((url: string) => void) | null = null;
let pendingCallRoute: string | null = null;

export function setCallNavigator(fn: ((url: string) => void) | null): void {
  callNavigator = fn;
}

export function consumePendingCallRoute(): string | null {
  const route = pendingCallRoute;
  pendingCallRoute = null;
  return route;
}

type IncomingCallPayload = {
  callId: string;
  callerName?: string;
  callerId?: string;
  callType?: 'voice' | 'video' | 'audio';
  conversationId?: string;
  twilioRoom?: string;
  actionUrl?: string;
  isVideo?: boolean;
};

function safeRecord(message: string): void {
  try {
    recordDiagnostic({ tag: 'WAKE', source: 'notifeeCallWake', message });
  } catch {}
  try {
    // eslint-disable-next-line no-console
    console.log(`[NOTIFEE-WAKE] ${message}`);
  } catch {}
}

/**
 * Lazy-require @notifee/react-native so a missing native binding (web
 * preview / older build) NEVER throws at module load.
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
      EventType: notifee.EventType,
      TriggerType: notifee.TriggerType,
    };
    return nativeCache;
  } catch (errorValue: any) {
    safeRecord(`load-native-failed: ${errorValue?.message || errorValue}`);
    return null;
  }
}

/** Build the in-app route that answers a Twilio call. */
function buildCallRoute(data: any): string {
  const room = String(data?.twilio_room_name || data?.twilioRoom || '');
  const isVideo =
    data?.isVideo === true ||
    String(data?.twilio_is_video) === '1' ||
    String(data?.callType) === 'video';
  const title = encodeURIComponent(String(data?.callerName || 'Smilers user'));
  if (room) {
    return `/twilio-call?room=${encodeURIComponent(room)}&isCaller=0&isVideo=${isVideo ? '1' : '0'}&title=${title}`;
  }
  return String(data?.action_url || '/');
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
      importance: native.AndroidImportance.HIGH,
      sound: 'ringtone',
      vibration: true,
      vibrationPattern: [0, 600, 300, 600, 300, 600],
      bypassDnd: false,
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

async function ensureMissedChannel(): Promise<boolean> {
  if (missedChannelCreated) return true;
  if (Platform.OS !== 'android') return false;
  const native = loadNative();
  if (!native) return false;
  try {
    await native.notifee.createChannel({
      id: MISSED_CHANNEL_ID,
      name: 'Missed calls',
      description: 'Notifications for calls you missed.',
      importance: native.AndroidImportance.HIGH,
      vibration: true,
      visibility: native.AndroidVisibility.PUBLIC,
    });
    missedChannelCreated = true;
    return true;
  } catch (errorValue: any) {
    safeRecord(`missed-channel-failed: ${errorValue?.message || errorValue}`);
    return false;
  }
}

/**
 * Present the full-screen, looping, persistent incoming-call ring with
 * Answer/Decline buttons. Safe from background tasks AND foreground.
 */
export async function presentIncomingCallNotifeeWake(payload: IncomingCallPayload): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!payload?.callId) {
    safeRecord('skip: no-callId');
    return;
  }
  const native = loadNative();
  if (!native) return;

  // Make sure the notifee event handlers are live (idempotent).
  registerNotifeeCallEventHandlers();

  const ok = await ensureCallChannel();
  if (!ok) return;
  await ensureMissedChannel();

  try {
    const callerName = payload.callerName?.trim() || 'Smilers user';
    const isVideo = payload.isVideo === true || payload.callType === 'video';
    const callType = isVideo ? 'video' : 'voice';
    const data: Record<string, string> = {
      type: 'call',
      callId: payload.callId,
      callerId: payload.callerId || payload.callId,
      callerName,
      callType,
      conversationId: payload.conversationId || '',
      twilio_room_name: payload.twilioRoom || '',
      twilio_is_video: isVideo ? '1' : '0',
      action_url: payload.actionUrl || '',
    };

    await native.notifee.displayNotification({
      id: `call-wake-${payload.callId}`,
      title: isVideo ? 'Incoming video call' : 'Incoming call',
      body: `${callerName} is calling…`,
      data,
      android: {
        channelId: CHANNEL_ID,
        importance: native.AndroidImportance.HIGH,
        visibility: native.AndroidVisibility.PUBLIC,
        category: native.AndroidCategory.CALL,
        // Wakes a LOCKED device: fullScreenAction launches over keyguard,
        // category CALL marks it a phone call, ongoing keeps it up, and
        // loopSound rings the channel's ringtone until handled.
        fullScreenAction: { id: 'answer', launchActivity: 'default' },
        pressAction: { id: 'answer', launchActivity: 'default' },
        ongoing: true,
        autoCancel: false,
        loopSound: true,
        // Auto-stops the ring (and shows the missed-call follow-up) if
        // nobody picks up within the timeout.
        timeoutAfter: RING_TIMEOUT_MS,
        actions: [
          { title: 'Answer', pressAction: { id: 'answer', launchActivity: 'default' } },
          { title: 'Decline', pressAction: { id: 'decline' } },
        ],
      },
    });
    safeRecord(
      `displayed: callId=${payload.callId} callType=${callType} room=${data.twilio_room_name || '-'}`,
    );

    // Schedule the missed-call follow-up (inexact alarm → no exact-alarm
    // permission needed). Cancelled on Answer/Decline.
    try {
      const trigger = {
        type: native.TriggerType.TIMESTAMP,
        timestamp: Date.now() + RING_TIMEOUT_MS + 500,
      };
      await native.notifee.createTriggerNotification(
        {
          id: `call-missed-${payload.callId}`,
          title: isVideo ? 'Missed video call' : 'Missed call',
          body: callerName,
          data: { ...data, type: 'missed-call' },
          android: {
            channelId: MISSED_CHANNEL_ID,
            importance: native.AndroidImportance.HIGH,
            visibility: native.AndroidVisibility.PUBLIC,
            pressAction: { id: 'open-chat', launchActivity: 'default' },
          },
        },
        trigger,
      );
      safeRecord(`missed-scheduled: callId=${payload.callId}`);
    } catch (errorValue: any) {
      safeRecord(`missed-schedule-failed: ${errorValue?.message || errorValue}`);
    }
  } catch (errorValue: any) {
    safeRecord(`display-failed: ${errorValue?.message || errorValue}`);
  }
}

/** Immediately post a "Missed call" notification (used on decline). */
async function presentMissedCallNotifee(native: any, data: any): Promise<void> {
  try {
    await ensureMissedChannel();
    const callId = String(data?.callId || '');
    const isVideo = String(data?.twilio_is_video) === '1' || String(data?.callType) === 'video';
    await native.notifee.displayNotification({
      id: `call-missed-${callId}`,
      title: isVideo ? 'Missed video call' : 'Missed call',
      body: String(data?.callerName || 'Smilers user'),
      data: { ...data, type: 'missed-call' },
      android: {
        channelId: MISSED_CHANNEL_ID,
        importance: native.AndroidImportance.HIGH,
        visibility: native.AndroidVisibility.PUBLIC,
        pressAction: { id: 'open-chat', launchActivity: 'default' },
      },
    });
    safeRecord(`missed-displayed: callId=${callId}`);
  } catch (errorValue: any) {
    safeRecord(`missed-display-failed: ${errorValue?.message || errorValue}`);
  }
}

/**
 * Cancel the wake-screen ring AND any pending missed-call follow-up.
 * Safe to call when no call is active.
 */
export async function cancelIncomingCallNotifeeWake(callId: string): Promise<void> {
  if (Platform.OS !== 'android' || !callId) return;
  const native = loadNative();
  if (!native) return;
  try {
    await native.notifee.cancelNotification(`call-wake-${callId}`);
    try {
      await native.notifee.cancelTriggerNotification(`call-missed-${callId}`);
    } catch {}
    safeRecord(`cancelled: callId=${callId}`);
  } catch (errorValue: any) {
    safeRecord(`cancel-failed: ${errorValue?.message || errorValue}`);
  }
}

/** Shared Answer/Decline/press handler for foreground + background events. */
async function handleCallEvent(native: any, type: any, detail: any): Promise<void> {
  const { EventType } = native;
  const notif = detail?.notification;
  const data = notif?.data || {};
  const pressId = detail?.pressAction?.id;
  const kind = String(data?.type || '');
  const callId = String(data?.callId || '');

  if (kind === 'missed-call') {
    if (type === EventType.PRESS) {
      const route = data?.conversationId ? `/chat/${data.conversationId}` : '/';
      if (callNavigator) callNavigator(route);
      else pendingCallRoute = route;
    }
    return;
  }

  if (kind !== 'call') return;

  // DECLINE → end the Twilio room (caller stops ringing) + show missed call.
  if (type === EventType.ACTION_PRESS && pressId === 'decline') {
    safeRecord(`decline: callId=${callId} room=${data?.twilio_room_name || '-'}`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { endTwilioCall } = require('../lib/twilio/twilioApi');
      if (data?.twilio_room_name) await endTwilioCall(String(data.twilio_room_name));
    } catch (errorValue: any) {
      safeRecord(`decline-end-failed: ${errorValue?.message || errorValue}`);
    }
    await cancelIncomingCallNotifeeWake(callId);
    await presentMissedCallNotifee(native, data);
    return;
  }

  // ANSWER (action button, full-screen, or body press) → stop ring + route.
  if ((type === EventType.ACTION_PRESS && pressId === 'answer') || type === EventType.PRESS) {
    safeRecord(`answer: callId=${callId}`);
    await cancelIncomingCallNotifeeWake(callId);
    const route = buildCallRoute(data);
    if (callNavigator) callNavigator(route);
    else pendingCallRoute = route; // cold start → consumed on mount
    return;
  }
}

/**
 * Register notifee's background + foreground event handlers. Idempotent.
 * Called at module load (early) AND when a call is presented, so action
 * button presses work even when the app was killed.
 */
export function registerNotifeeCallEventHandlers(): void {
  if (eventsRegistered) return;
  if (Platform.OS !== 'android') return;
  const native = loadNative();
  if (!native) return;
  try {
    native.notifee.onBackgroundEvent(async ({ type, detail }: any) => {
      try {
        await handleCallEvent(native, type, detail);
      } catch (errorValue: any) {
        safeRecord(`bg-event-failed: ${errorValue?.message || errorValue}`);
      }
    });
    native.notifee.onForegroundEvent(({ type, detail }: any) => {
      handleCallEvent(native, type, detail).catch((errorValue: any) =>
        safeRecord(`fg-event-failed: ${errorValue?.message || errorValue}`),
      );
    });
    eventsRegistered = true;
    safeRecord('events-registered');
  } catch (errorValue: any) {
    safeRecord(`events-register-failed: ${errorValue?.message || errorValue}`);
  }
}

/**
 * On app mount, route an Answer that COLD-STARTED the app (the launching
 * notification isn't delivered through onForegroundEvent).
 */
export async function handleNotifeeInitialCallNotification(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const native = loadNative();
  if (!native) return;
  try {
    const initial = await native.notifee.getInitialNotification();
    if (!initial) return;
    const data = initial?.notification?.data || {};
    const pressId = initial?.pressAction?.id;
    const kind = String(data?.type || '');
    const callId = String(data?.callId || '');

    if (kind === 'call' && (pressId === 'answer' || pressId === 'default')) {
      await cancelIncomingCallNotifeeWake(callId);
      const route = buildCallRoute(data);
      if (callNavigator) callNavigator(route);
      else pendingCallRoute = route;
      safeRecord(`initial-answer-routed: ${route}`);
    } else if (kind === 'missed-call' && pressId === 'open-chat') {
      const route = data?.conversationId ? `/chat/${data.conversationId}` : '/';
      if (callNavigator) callNavigator(route);
      else pendingCallRoute = route;
    }
  } catch (errorValue: any) {
    safeRecord(`initial-notif-failed: ${errorValue?.message || errorValue}`);
  }
}
