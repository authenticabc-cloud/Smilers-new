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

import { NativeModules, Platform } from 'react-native';
import { recordDiagnostic } from '../lib/diagnostics';
import { readRingtonePrefs, resolveCallChannelSound } from './notificationChannels';

const MISSED_CHANNEL_ID = 'missed-calls-v1';
// Ring auto-stops + the missed-call follow-up appears after this long.
const RING_TIMEOUT_MS = 35000;

// iter-221: the wake-screen ring channel is now VERSIONED by the user's
// selected ringtone. Android notification channels are immutable after
// creation, so the chosen tone is baked into the channel id
// (`incoming-call-wake-<sound>`). When the user picks a new ringtone a
// fresh channel is created and the ring plays the new tone — previously
// this channel hardcoded `sound: 'ringtone'`, so the chosen tone never
// played and a wrong/“message” tone was heard.
const createdCallChannels = new Set<string>();
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
  callerIdentity?: string;
  callerPhone?: string;
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
 *
 * New Architecture (Fabric/JSI) headless contexts may load the Notifee
 * module but export enum values as undefined because the JS-side constants
 * aren't initialized until the React UI mounts. We supply hardcoded fallbacks
 * for all enum constants so channel creation and displayNotification never
 * throw a "Cannot read property of undefined" TypeError in headless state.
 */
function loadNative(): any | null {
  if (Platform.OS === 'web') return null;
  if (nativeCache) return nativeCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const notifee = require('@notifee/react-native');
    nativeCache = {
      notifee: notifee.default || notifee,
      // Enum fallbacks: official numeric values from Notifee docs (7.x+).
      // In a New-Architecture headless context these exports may be undefined.
      AndroidImportance: notifee.AndroidImportance || { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 },
      AndroidCategory: notifee.AndroidCategory || {
        ALARM: 'alarm', CALL: 'call', EMAIL: 'email', ERROR: 'err',
        EVENT: 'event', MESSAGE: 'msg', NAVIGATION: 'navigation',
        PROGRESS: 'progress', REMINDER: 'reminder', SERVICE: 'service',
        SOCIAL: 'social', STATUS: 'status', TRANSPORT: 'transport',
      },
      AndroidVisibility: notifee.AndroidVisibility || { SECRET: -1, PRIVATE: 0, PUBLIC: 1 },
      EventType: notifee.EventType || {
        UNKNOWN: -1, DISMISSED: 0, PRESS: 1, ACTION_PRESS: 2,
        DELIVERED: 3, APP_BLOCKED: 4, CHANNEL_BLOCKED: 5,
        CHANNEL_GROUP_BLOCKED: 6, TRIGGER_NOTIFICATION_CREATED: 7,
      },
      TriggerType: notifee.TriggerType || { TIMESTAMP: 0, INTERVAL: 1 },
    };
    console.log('[NOTIFEE-WAKE] loadNative: module loaded, AndroidImportance.MAX=', nativeCache.AndroidImportance?.MAX);
    return nativeCache;
  } catch (errorValue: any) {
    safeRecord(`load-native-failed: ${errorValue?.message || errorValue}`);
    console.warn('[NOTIFEE-WAKE] loadNative FAILED:', errorValue?.message || errorValue);
    return null;
  }
}

/** Build the in-app route that answers a Twilio call. */
function buildCallRoute(data: any): string {
  // iter-240: respect the runtime engine flag (EXPO_PUBLIC_USE_TWILIO). When
  // Twilio is disabled the app uses the legacy WebRTC call screen, so an
  // answered call must open /call/<conversationId> — NOT /twilio-call (which
  // would spin on "Connecting" because no Twilio room exists).
  let twilioOn = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    twilioOn = require('../lib/twilio/twilioApi').isTwilioEnabled();
  } catch {}
  const conversationId = String(data?.conversationId || '');
  if (!twilioOn) {
    const name = encodeURIComponent(String(data?.callerName || 'Smilers user'));
    // The user ALREADY tapped "Answer" on the full-screen notification, so the
    // WebRTC/Stream call screen must AUTO-ACCEPT (answer=1) instead of showing
    // Accept/Decline again — that missing flag was the "double-accept required"
    // bug (first Answer just opened the screen; a second in-app tap was needed).
    // Also carry the call type so a voice call never opens the camera.
    const isVideoCall =
      data?.isVideo === true ||
      String(data?.twilio_is_video) === '1' ||
      String(data?.is_video) === 'true' ||
      String(data?.is_video) === '1' ||
      String(data?.callType) === 'video';
    if (conversationId) {
      return (
        `/call/${conversationId}?displayName=${name}` +
        `&type=${isVideoCall ? 'video' : 'voice'}&answer=1`
      );
    }
    return String(data?.action_url || '/');
  }
  const room = String(data?.twilio_room_name || data?.twilioRoom || '');
  const isVideo =
    data?.isVideo === true ||
    String(data?.twilio_is_video) === '1' ||
    String(data?.callType) === 'video';
  const title = encodeURIComponent(String(data?.callerName || 'Smilers user'));
  if (room) {
    // iter-251: route to the in-app incoming-call screen with autoAnswer=1.
    // The user already tapped "Answer" on the Notifee notification, so we skip
    // the buttons and join immediately — but routing through /incoming-call
    // lets it resolve the callee's REAL user id (me._id) so the caller sees a
    // name instead of a `twilio-<room>` code.
    return (
      `/incoming-call?room=${encodeURIComponent(room)}` +
      `&callerId=${encodeURIComponent(String(data?.twilio_caller_identity || data?.callerId || ''))}` +
      `&callerName=${title}` +
      `&isVideo=${isVideo ? '1' : '0'}` +
      `&conversationId=${encodeURIComponent(String(data?.conversationId || ''))}` +
      `&callId=${encodeURIComponent(String(data?.callId || ''))}` +
      `&autoAnswer=1`
    );
  }
  return String(data?.action_url || '/');
}

async function ensureCallChannel(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const native = loadNative();
  if (!native) return null;
  // Resolve the user's selected ringtone → bundled res/raw sound basename.
  let sound: string | undefined;
  try {
    const prefs = await readRingtonePrefs();
    sound = resolveCallChannelSound(prefs?.ringtone);
  } catch {
    sound = 'smilers_never_cry';
  }
  // v4 bump: v3 was created with an invalid vibrationPattern (55 elements,
  // starts with 0). Android channels are immutable — bumping the id forces
  // a fresh channel with the corrected even-count positive-only pattern.
  const channelId = `incoming-call-wake-v4-${sound || 'silent'}`;
  if (createdCallChannels.has(channelId)) return channelId;
  try {
    // iter-260: a notification's vibration plays the channel's pattern ONCE.
    // The old short pattern (~2.4s) felt like a message buzz, not a ringing
    // phone, when the app was backgrounded/swiped (the user-reported P0).
    // `loopSound` loops the AUDIO but NOT the vibration, so we instead bake a
    // LONG repeating buzz pattern (≈ the full RING_TIMEOUT_MS) into the
    // channel so the device keeps vibrating for the whole incoming ring.
    // Channels are immutable on Android O+, hence the `v3` id bump.
    const buzz = 700;   // vibrate
    const pause = 600;  // gap between buzzes (ringtone-like cadence)
    // Notifee requires an EVEN number of POSITIVE (> 0) values.
    // The previous [0, buzz, pause, ...] pattern had 55 elements (odd) and
    // started with 0 — both violations. Start empty and push pairs only.
    const longVibrationPattern: number[] = [];
    const cycles = Math.ceil(RING_TIMEOUT_MS / (buzz + pause));
    for (let i = 0; i < cycles; i += 1) {
      longVibrationPattern.push(buzz, pause);
    }
    // Result: 27 × 2 = 54 elements, all positive, even count ✓
    await native.notifee.createChannel({
      id: channelId,
      name: 'Incoming calls (wake-screen)',
      description: 'Rings and wakes the screen for incoming Smilers calls.',
      importance: native.AndroidImportance.MAX,
      // Play the user's chosen ringtone (undefined => silent channel).
      sound,
      vibration: true,
      vibrationPattern: longVibrationPattern,
      bypassDnd: true,
      visibility: native.AndroidVisibility.PUBLIC,
    });
    createdCallChannels.add(channelId);
    safeRecord(`channel-created: ${channelId} sound=${sound || 'silent'}`);
    return channelId;
  } catch (errorValue: any) {
    safeRecord(`channel-create-failed: ${errorValue?.message || errorValue}`);
    console.warn('[NOTIFEE-WAKE] createChannel threw — assuming channel already exists (Android channels persist):', errorValue?.message || errorValue);
    // Android notification channels are persistent across app restarts. If createChannel
    // throws (e.g. JSI/TurboModule not fully ready in New-Architecture headless context),
    // the channel was almost certainly created during the last foreground session.
    // Mark it so we don't retry, then return the id so displayNotification can proceed.
    createdCallChannels.add(channelId);
    return channelId;
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
  console.log('[NOTIFEE-WAKE] presentIncomingCallNotifeeWake called callId=', payload.callId);
  const native = loadNative();
  if (!native) {
    console.warn('[NOTIFEE-WAKE] loadNative returned null — Notifee unavailable');
    return;
  }

  // Make sure the notifee event handlers are live (idempotent).
  registerNotifeeCallEventHandlers();

  const callChannelId = await ensureCallChannel();
  if (!callChannelId) {
    // loadNative returned null inside ensureCallChannel — throw so the caller
    // falls back to Expo.
    console.warn('[NOTIFEE-WAKE] ensureCallChannel returned null — using Expo fallback');
    throw new Error('notifee-channel-failed');
  }
  console.log('[NOTIFEE-WAKE] channel resolved:', callChannelId);
  await ensureMissedChannel();

  // Guard: if the ring notification is already on screen, do NOT update it.
  // Multiple FCM retries for the same call would otherwise reset timeoutAfter
  // and loopSound on every push, keeping the ring alive indefinitely and
  // preventing the missed-call transition.
  try {
    const displayed = await native.notifee.getDisplayedNotifications();
    const alreadyShowing = displayed.some((n: any) => n.id === `call-wake-${payload.callId}`);
    if (alreadyShowing) {
      safeRecord(`skip: already-showing callId=${payload.callId}`);
      return;
    }
  } catch {
    // getDisplayedNotifications failed — proceed and display anyway.
  }

  let callerName = payload.callerName?.trim() || 'Smilers user';
  // Prefer the DEVICE-CONTACT name over the caller's Google/account name.
  // 1) Fast path: the chat-list cache (populated while the app was open).
  // 2) Robust fallback: resolve directly from the device address book by the
  //    caller's phone number — works even after a cold/killed start when the
  //    in-memory cache is empty (requires the push to carry `callerPhone`).
  try {
    const convId = (payload.conversationId || '').trim();
    if (convId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCachedConversationName } = require('./notificationNameCache');
      const cachedName = await getCachedConversationName(convId);
      if (cachedName) callerName = cachedName;
    }
  } catch {
    /* keep account name */
  }
  try {
    const callerPhone = (payload.callerPhone || '').trim();
    // Only override with the address-book name when we still have the
    // account-name default (the cache hit above already wins if present).
    if (callerPhone && (!callerName || callerName === payload.callerName?.trim() || callerName === 'Smilers user')) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveDeviceNameByPhone } = require('./deviceNameResolver');
      const deviceName = await resolveDeviceNameByPhone(callerPhone);
      if (deviceName) callerName = deviceName;
    }
  } catch {
    /* keep resolved/account name */
  }
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
    twilio_caller_identity: payload.callerIdentity || payload.callerId || '',
    action_url: payload.actionUrl || '',
  };

  console.log('[NOTIFEE-WAKE] calling displayNotification callId=', payload.callId, 'channelId=', callChannelId);
  // displayNotification throws are intentionally NOT caught here so that
  // backgroundTaskSetup.ts can detect the failure (notifeeOk=false) and
  // activate the Expo fallback.
  await native.notifee.displayNotification({
    id: `call-wake-${payload.callId}`,
    title: isVideo ? 'Incoming video call' : 'Incoming call',
    body: `${callerName} is calling…`,
    data,
    android: {
      channelId: callChannelId,
      importance: native.AndroidImportance.HIGH,
      visibility: native.AndroidVisibility.PUBLIC,
      category: native.AndroidCategory.CALL,
      // Wakes a LOCKED device: fullScreenAction launches over keyguard,
      // category CALL marks it a phone call, ongoing keeps it up, and
      // loopSound rings the channel's ringtone until handled.
      fullScreenAction: { id: 'answer', launchActivity: 'default' },
      pressAction: { id: 'answer', launchActivity: 'default' },
      // iter-218 — Issue 2: NOT `ongoing`. An ongoing notification is
      // not removed by `timeoutAfter` on many Android builds, so when the
      // missed-call follow-up fired the original incoming ring lingered
      // beside it (the exact "both notifications show" bug). Non-ongoing
      // still rings full-screen (fullScreenAction + loopSound + MAX
      // heads-up) but lets the OS auto-dismiss it at `timeoutAfter`, and
      // our Answer/Decline handlers cancel it explicitly anyway.
      ongoing: false,
      autoCancel: false,
      loopSound: true,
      // Prevents sound/vibration/fullScreenAction from re-firing when a
      // subsequent FCM retry updates this notification (same id). Without
      // this, every FCM retry during the 36-second ring window restarts
      // the ringtone even though Android only shows one notification.
      onlyAlertOnce: true,
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
  console.log('[NOTIFEE-WAKE] displayNotification SUCCEEDED callId=', payload.callId);

  // Missed-call notification is handled entirely by the native Kotlin layer
  // (SmilersCallNotificationService.handleMissedCallMessage) when the backend
  // sends the missed-call FCM. Do NOT schedule a Notifee trigger here — doing
  // so posted a second notification alongside the Kotlin one (different IDs,
  // different channel namespaces) causing the user to see two missed-call alerts.
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

/**
 * Cancel the ring + post missed-call via the Kotlin native module bridge.
 * Called by useIncomingCallListener when Convex detects the caller cancelled
 * before the 35s timeout. Two layers are cancelled:
 *   1. Notifee ring (JS layer: channel incoming-call-wake-v4-*)
 *   2. Kotlin ring (native layer: channel incoming-call-native-v1)
 * The missed-call notification is posted by the Kotlin native module so it
 * uses the same channel/ID as the ring-timeout path — no duplicates.
 */
export async function cancelRingAndShowMissedCall(params: {
  callId: string;
  callerName?: string;
  conversationId?: string;
  isVideo?: boolean;
}): Promise<void> {
  if (Platform.OS !== 'android' || !params.callId) return;
  // Cancel Notifee ring (JS-layer notification on incoming-call-wake-v4-* channel)
  await cancelIncomingCallNotifeeWake(params.callId);
  // Cancel Kotlin ring + post missed-call via native module bridge
  try {
    const mod = NativeModules.SmilersCallModule;
    if (mod?.handleCallerCancelled) {
      await mod.handleCallerCancelled(
        params.callId,
        params.conversationId || '',
        params.callerName || 'Smilers user',
      );
      safeRecord(`native-cancel-ring: callId=${params.callId}`);
    } else {
      safeRecord('native-cancel-ring: SmilersCallModule not available');
    }
  } catch (e: any) {
    safeRecord(`native-cancel-ring-failed: ${e?.message || e}`);
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

  // iter-260: grouped message notifications (displayed via notifeeMessageDisplay)
  // are routed here too — a body press opens the conversation.
  if (kind === 'message') {
    if (type === EventType.PRESS && data?.conversationId) {
      const route = `/chat/${data.conversationId}`;
      if (callNavigator) callNavigator(route);
      else pendingCallRoute = route;
    }
    return;
  }

  if (kind !== 'call') return;

  // DECLINE → end the Twilio room (caller stops ringing) + cancel the ring.
  // Missed-call notification is owned by Kotlin (SmilersCallNotificationService)
  // via the backend missed-call FCM — do NOT call presentMissedCallNotifee here
  // or the user sees two missed-call notifications.
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
        // Voice-note / translation playback Stop action (media foreground service).
        if (detail?.pressAction?.id === 'stop-playback') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('../lib/audio/playbackNotification').handlePlaybackBackgroundAction(
              'stop-playback',
            );
          } catch {}
          return;
        }
        // Emergency "Stop sharing" action (emergency foreground service).
        if (detail?.pressAction?.id === 'emergency-stop') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            await require('../lib/emergency/emergencyForegroundService').stopEmergencySharing(
              detail?.notification?.data?.alertId,
            );
          } catch {}
          return;
        }
        await handleCallEvent(native, type, detail);
      } catch (errorValue: any) {
        safeRecord(`bg-event-failed: ${errorValue?.message || errorValue}`);
      }
    });
    native.notifee.onForegroundEvent(({ type, detail }: any) => {
      if (detail?.pressAction?.id === 'emergency-stop') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('../lib/emergency/emergencyForegroundService')
            .stopEmergencySharing(detail?.notification?.data?.alertId)
            .catch(() => {});
        } catch {}
        return;
      }
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
    } else if (kind === 'message' && data?.conversationId) {
      const route = `/chat/${data.conversationId}`;
      if (callNavigator) callNavigator(route);
      else pendingCallRoute = route;
    }
  } catch (errorValue: any) {
    safeRecord(`initial-notif-failed: ${errorValue?.message || errorValue}`);
  }
}
