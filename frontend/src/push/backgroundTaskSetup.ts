/**
 * backgroundTaskSetup.ts
 *
 * Standalone module with ZERO React / hook dependencies.
 * Imported as the very first side-effect in index.js so it runs in every
 * execution context — including the headless JS process that Expo spins up
 * when a FCM data message arrives while the app is killed.
 *
 * Registers:
 *   1. The Expo TaskManager background notification handler
 *   2. Notifee call event handlers (Answer / Decline / Missed-call)
 *   3. The background task with the OS via Notifications.registerTaskAsync
 */

import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { registerNotifeeCallEventHandlers } from './notifeeCallWake';
import { recordDiagnostic } from '../lib/diagnostics';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BACKGROUND_NOTIFICATION_TASK = 'smilers-background-notification-task';
const CALL_CATEGORY = 'incoming-call';

// ---------------------------------------------------------------------------
// Dedup cache — prevents double-processing the same push in a session
// ---------------------------------------------------------------------------

const backgroundNotificationKeys: Set<string> = new Set();

function trimBackgroundNotificationCache() {
  if (backgroundNotificationKeys.size <= 30) return;
  const oldest = backgroundNotificationKeys.values().next().value;
  if (oldest) backgroundNotificationKeys.delete(oldest);
}

// ---------------------------------------------------------------------------
// Runtime scope guard — shared via globalThis so usePushNotifications.ts
// can update __smilersAppState and the task handler can read it.
// ---------------------------------------------------------------------------

const runtimeScope = globalThis as any as {
  __smilersAppState?: string;
  __smilersNotificationTaskDefined?: boolean;
};

// ---------------------------------------------------------------------------
// Pure utility functions (extracted verbatim from usePushNotifications.ts)
// ---------------------------------------------------------------------------

function safeParseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toNonEmptyString(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

type NotificationPayload = {
  type?: string;
  callId?: string;
  messageId?: string;
  conversationId?: string;
  displayName?: string;
  callerName?: string;
  callerDisplayName?: string;
  senderName?: string;
  senderPhone?: string;
  senderId?: string;
  senderUserId?: string;
  title?: string;
  body?: string;
  sound?: string;
  [key: string]: unknown;
};

function normalizeNotificationPayload(rawValue: unknown): NotificationPayload {
  const baseObject = rawValue && typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : {};
  const nestedData =
    typeof baseObject.data === 'string'
      ? safeParseJson<Record<string, unknown>>(baseObject.data)
      : baseObject.data && typeof baseObject.data === 'object'
        ? (baseObject.data as Record<string, unknown>)
        : null;
  const nestedBody =
    typeof baseObject.body === 'string'
      ? safeParseJson<Record<string, unknown>>(baseObject.body)
      : null;
  return {
    ...(nestedData || {}),
    ...(nestedBody || {}),
    ...baseObject,
  };
}

function getDisplayNameFromPayload(payload: NotificationPayload, fallbackBody?: string) {
  return (
    toNonEmptyString(payload.displayName) ||
    toNonEmptyString(payload.callerDisplayName) ||
    toNonEmptyString(payload.callerName) ||
    toNonEmptyString(payload.senderName) ||
    toNonEmptyString(payload.body) ||
    toNonEmptyString(fallbackBody)
  );
}

function buildNotificationKey(payload: NotificationPayload) {
  const type = toNonEmptyString(payload.type) || 'unknown';
  const primaryId =
    type === 'message'
      ? toNonEmptyString(payload.messageId) ||
        [
          toNonEmptyString(payload.conversationId),
          toNonEmptyString(payload.title),
          toNonEmptyString(payload.body),
        ]
          .filter(Boolean)
          .join(':')
      : toNonEmptyString(payload.callId) ||
        toNonEmptyString(payload.conversationId) ||
        toNonEmptyString(payload.displayName) ||
        toNonEmptyString(payload.title);
  return `${type}:${primaryId}`;
}

function shouldScheduleLocalNotification(taskData: unknown) {
  const taskObject = taskData && typeof taskData === 'object' ? (taskData as Record<string, unknown>) : {};
  const topLevelTitle = toNonEmptyString(taskObject.title);
  const topLevelBody = toNonEmptyString(taskObject.body);
  const notificationContent =
    taskObject.notification && typeof taskObject.notification === 'object'
      ? ((taskObject.notification as any)?.request?.content as Record<string, unknown> | undefined)
      : undefined;
  const contentTitle = toNonEmptyString(notificationContent?.title);
  const contentBody = toNonEmptyString(notificationContent?.body);
  return !(topLevelTitle || topLevelBody || contentTitle || contentBody);
}

// ---------------------------------------------------------------------------
// presentBackgroundLocalNotification
// Extracted verbatim from usePushNotifications.ts — behaviour unchanged.
// ---------------------------------------------------------------------------

export async function presentBackgroundLocalNotification(taskData: unknown) {
  if (Platform.OS === 'web') return;

  const taskObject = taskData && typeof taskData === 'object' ? (taskData as Record<string, unknown>) : {};
  const rawPayload =
    ((taskObject.notification as any)?.request?.content?.data as Record<string, unknown> | undefined) ||
    (taskObject.data as Record<string, unknown> | undefined) ||
    taskObject;
  const payload = normalizeNotificationPayload(rawPayload);

  // Stream Video call pushes (native ringing). Cheap marker check first so we
  // only lazy-load the Stream SDK for actual Stream pushes (never on web — this
  // function already returned above for web). If handled, stop here so our
  // message-notification path doesn't also fire.
  try {
    const sd = (rawPayload || {}) as Record<string, any>;
    if (sd && (sd.sender === 'stream.video' || String(sd.type || '') === 'stream.video')) {
      const { handleStreamCallPush } = await import('../lib/stream/streamPush');
      const handled = await handleStreamCallPush(sd);
      if (handled) return;
    }
  } catch {}

  const type = toNonEmptyString(payload.type);
  if (type !== 'call' && type !== 'message' && type !== 'call-declined') return;

  // call-declined: callee tapped Decline while the CALLER's app is background/killed.
  // Call the Convex declineCall mutation directly via the HTTP client — no React hooks needed.
  // The Kotlin layer also fires a startActivity intent as belt-and-suspenders (see SmilersCallNotificationService).
  if (type === 'call-declined') {
    const callId =
      toNonEmptyString(payload.callId) || toNonEmptyString(payload.conversationId);
    if (callId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const SecureStore = require('expo-secure-store');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ConvexHttpClient } = require('convex/browser');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { anyApi } = require('convex/server');
        const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
        if (convexUrl) {
          const client = new ConvexHttpClient(convexUrl);
          const token = await SecureStore.getItemAsync('smilers_id_token');
          if (token) {
            client.setAuth(token);
            await client.mutation(anyApi.calls.declineCall, { callId });
            console.log('[push] call-declined (background): declineCall succeeded callId=', callId);
          } else {
            console.warn('[push] call-declined (background): no auth token in SecureStore — call will expire via Convex cron');
          }
        }
      } catch (e: any) {
        console.warn('[push] call-declined (background): declineCall failed', e?.message || e);
      }
    }
    return;
  }

  const notificationKey = buildNotificationKey(payload);
  if (!notificationKey || backgroundNotificationKeys.has(notificationKey)) return;

  if (type === 'call') {
    backgroundNotificationKeys.add(notificationKey);
    trimBackgroundNotificationCache();

    const callId = toNonEmptyString(payload.callId) || notificationKey;
    const callerName =
      toNonEmptyString(payload.callerName) ||
      toNonEmptyString(payload.callerDisplayName) ||
      toNonEmptyString(payload.displayName) ||
      toNonEmptyString(payload.senderName) ||
      'Smilers user';
    const callerId = toNonEmptyString(payload.callerId) || callId;
    const isVideo =
      toNonEmptyString(payload.twilio_is_video) === '1' ||
      toNonEmptyString(payload.callType) === 'video';
    const callType: 'voice' | 'video' = isVideo ? 'video' : 'voice';
    const conversationId = toNonEmptyString(payload.conversationId) || '';
    const twilioRoom = toNonEmptyString(payload.twilio_room_name) || '';
    const callerIdentity = toNonEmptyString(payload.twilio_caller_identity) || '';
    const actionUrl = toNonEmptyString(payload.action_url) || '';
    const callerPhone =
      toNonEmptyString(payload.callerPhone) ||
      toNonEmptyString(payload.senderPhone) ||
      toNonEmptyString(payload.phone) ||
      '';

    let notifeeOk = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { presentIncomingCallNotifeeWake } = require('./notifeeCallWake');
      await presentIncomingCallNotifeeWake({
        callId,
        callerId,
        callerName,
        callerIdentity,
        callerPhone,
        callType,
        conversationId,
        twilioRoom,
        actionUrl,
        isVideo,
      });
      notifeeOk = true;
      console.log('[push] notifee call wake succeeded for callId:', callId);
    } catch (errorValue: any) {
      console.warn(
        '[push] notifee call wake FAILED — using expo fallback. callId:',
        callId,
        'error:',
        errorValue?.message,
        errorValue?.stack,
      );
    }

    if (!notifeeOk) {
      const fallbackCallChannel = 'calls-v4-smilers_never_cry';
      if (Platform.OS === 'android') {
        try {
          await Notifications.setNotificationChannelAsync(fallbackCallChannel, {
            name: 'Incoming Calls',
            importance: Notifications.AndroidImportance.MAX,
            sound: 'smilers_never_cry',
            vibrationPattern: [0, 1000, 500, 1000, 500, 1000],
            lightColor: '#E4B53B',
            lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
            bypassDnd: true,
            enableVibrate: true,
            enableLights: true,
            showBadge: false,
          });
        } catch {}

        // Register Answer / Decline action buttons for this category.
        // On Android these appear as expandable notification actions.
        try {
          await Notifications.setNotificationCategoryAsync(CALL_CATEGORY, [
            {
              identifier: 'answer',
              buttonTitle: 'Answer',
              options: { opensAppToForeground: true },
            },
            {
              identifier: 'decline',
              buttonTitle: 'Decline',
              options: { opensAppToForeground: false, isDestructive: true },
            },
          ]);
        } catch {}

        // Cross-process-safe dedup: if a ring notification for this callId is
        // already displayed, skip entirely instead of cancel+reschedule.
        // Cancel+reschedule was restarting the ringtone on every FCM retry
        // during the 36-second ring window (WhatsApp-style: one persistent
        // notification for the entire ring duration).
        try {
          const presented = await Notifications.getPresentedNotificationsAsync();
          console.log('[push] expo fallback dedup: presented count=', presented.length, 'callId=', callId);
          const alreadyRinging = presented.some(
            (n) => (n.request.content.data as any)?.callId === callId,
          );
          if (alreadyRinging) {
            console.log('[push] expo fallback dedup: already ringing — skip');
            return;
          }
        } catch (dedupErr: any) {
          console.warn('[push] expo fallback dedup check failed:', dedupErr?.message || dedupErr);
        }
      }
      await Notifications.scheduleNotificationAsync({
        // Stable identifier derived from callId — Android updates the existing
        // notification in-place instead of stacking a new banner per FCM retry.
        // Without this, every retry created a new random-UUID notification.
        identifier: `call-wake-${callId}`,
        content: {
          title: toNonEmptyString(payload.title) || 'Incoming call',
          body: callerName,
          data: payload,
          sound: 'smilers_never_cry',
          categoryIdentifier: CALL_CATEGORY,
          sticky: true,
          autoDismiss: false,
          priority: Notifications.AndroidNotificationPriority.MAX,
          vibrate: [0, 600, 300, 600, 300, 600],
          interruptionLevel: 'timeSensitive',
        },
        trigger: Platform.OS === 'android' ? { channelId: fallbackCallChannel } : null,
      });
    }
    return;
  }

  // MESSAGE path — always schedule a local notification on the messages channel.
  // The FCM notification payload (if present) is auto-displayed by the OS on the legacy
  // calls channel (calls-v4-smilers_never_cry), which is suppressed to IMPORTANCE_NONE
  // and therefore invisible to the user. We must always post our own local notification.
  // The stable identifier on scheduleNotificationAsync below prevents duplicates when the
  // background task fires from both handleIntent and onMessageReceived for the same FCM.

  // DIAGNOSTIC (Diagnostic Logs screen → tag MSG-PUSH): records whether the
  // incoming message FCM still carried a NOTIFICATION BLOCK. If hasNotifBlock=true
  // the deployed relay is still sending message pushes as notification-type (the OS
  // auto-displays a 2nd "Smilers"/server-title banner) → the relay wasn't redeployed
  // with the data-only fix. hasNotifBlock=false means data-only (single app banner).
  try {
    recordDiagnostic({
      tag: 'MSG-PUSH',
      source: 'bg-task',
      message: `type=${type} hasNotifBlock=${!shouldScheduleLocalNotification(taskObject)} title="${(toNonEmptyString(payload.title) || '').slice(0, 40)}" name="${(getDisplayNameFromPayload(payload) || '').slice(0, 40)}" key=${notificationKey}`,
    });
  } catch {}

  backgroundNotificationKeys.add(notificationKey);
  trimBackgroundNotificationCache();

  let title = toNonEmptyString(payload.title) || 'New message';
  let body = getDisplayNameFromPayload(payload) || 'Open Smilers to view the message';

  // Prefer the DEVICE-CONTACT name over the sender's Google/account name.
  try {
    const accountName = getDisplayNameFromPayload(payload);
    const convId = toNonEmptyString(payload.conversationId);
    const senderPhone =
      toNonEmptyString(payload.senderPhone) ||
      toNonEmptyString((payload as any).senderE164) ||
      toNonEmptyString((payload as any).fromPhone);

    const convDeviceName = convId
      ? await require('./notificationNameCache').getCachedConversationName(convId)
      : '';
    try {
      recordDiagnostic({
        tag: 'MSG-NAME',
        source: 'bg-task',
        message: `convId=${convId || '(none)'} cachedConvName="${convDeviceName || '(miss)'}" senderPhone="${senderPhone || '(none)'}" account="${accountName || '(none)'}"`,
      });
    } catch {}
    // Backend now resolves the DEVICE-CONTACT name and puts it in `data.title`
    // (data-only push — the OS no longer auto-displays an account-name banner).
    // Trust that authoritative title; only fall back to the on-device cache when
    // the backend title is missing/generic OR is just the sender's account name.
    const backendTitleIsResolved =
      !!toNonEmptyString(payload.title) &&
      payload.title !== 'New message' &&
      (!accountName || payload.title !== accountName);
    if (convDeviceName && !backendTitleIsResolved) {
      // 1:1 conversation — the peer is definitively both the title and the
      // sender line, so use the locally-resolved contact name.
      title = convDeviceName;
      if (!body || body === accountName || body === title) body = convDeviceName;
    } else if (convDeviceName) {
      // Backend title is good — keep it, but still fix a body that is only the
      // account name so the sender line matches the (contact-name) title.
      if (!body || body === accountName) body = title;
    } else {
      // Group (or uncached DM) — resolve the SENDER's device name from their
      // phone OR Smilers userId; use it for the sender line only, keeping the
      // group name as the notification title.
      let senderDeviceName = '';
      if (senderPhone) {
        senderDeviceName = await require('./deviceNameResolver').resolveDeviceNameByPhone(senderPhone);
      }
      if (!senderDeviceName) {
        const senderId =
          toNonEmptyString((payload as any).senderId) ||
          toNonEmptyString((payload as any).senderUserId) ||
          toNonEmptyString((payload as any).fromUserId);
        if (senderId) {
          senderDeviceName = await require('./notificationNameCache').getCachedUserName(senderId);
        }
      }
      if (senderDeviceName) {
        if (accountName && body === accountName) body = senderDeviceName;
        if (title === accountName) title = senderDeviceName;
      }
    }
  } catch {
    /* no override — keep account name */
  }
  const groupConversationId = toNonEmptyString(payload.conversationId);
  if (Platform.OS === 'android' && groupConversationId) {
    try {
      const { displayGroupedMessageNotification } = require('./notifeeMessageDisplay');
      const grouped = await displayGroupedMessageNotification({
        title,
        body,
        conversationId: groupConversationId,
        data: payload,
        childId: `msg-${groupConversationId}-${notificationKey}`,
      });
      if (grouped) return;
    } catch {
      // fall through to the expo-notifications path
    }
  }

  const messageChannel = 'messages-v5-message_notification';
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync(messageChannel, {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'message_notification',
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#E4B53B',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
        enableVibrate: true,
        showBadge: true,
      });
    } catch {}
  }
  await Notifications.scheduleNotificationAsync({
    // Stable identifier so that if onMessageReceived and handleIntent both trigger this
    // task for the same data-only FCM (which can happen when the app is background/killed),
    // the second invocation updates the existing notification rather than adding a duplicate.
    identifier: `msg-${notificationKey}`,
    content: {
      title,
      body,
      data: payload,
      sound: 'message_notification',
      autoDismiss: true,
      priority: Notifications.AndroidNotificationPriority.HIGH,
      vibrate: [0, 250, 250, 250],
      interruptionLevel: 'active',
    },
    trigger: Platform.OS === 'android' ? { channelId: messageChannel } : null,
  });
}

// ---------------------------------------------------------------------------
// 1. Register background notification task handler
//    Extracted from usePushNotifications.ts lines 417–451.
//    Running at module scope ensures this executes in headless JS context.
// ---------------------------------------------------------------------------

if (Platform.OS !== 'web' && !runtimeScope.__smilersNotificationTaskDefined) {
  runtimeScope.__smilersNotificationTaskDefined = true;
  TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }: any) => {
    if (error) {
      console.warn('[push] Background notification task error:', error?.message || error);
      return;
    }
    console.log('[push] Background task fired. appState=', runtimeScope.__smilersAppState);

    if (runtimeScope.__smilersAppState === 'active') {
      // iter-248: in the FOREGROUND, only bail for non-CALL pushes. Call pushes
      // are sent data-only, which bypasses the foreground notification listener
      // entirely, and the Convex live-query path has proven unreliable at
      // surfacing the ring — so let CALL pushes fall through to
      // presentBackgroundLocalNotification (the Notifee Answer/Decline ring is
      // idempotent by call id, so it won't double-ring with the Convex path).
      try {
        const probe = normalizeNotificationPayload(
          (data as any)?.notification?.request?.content?.data ||
            (data as any)?.data ||
            data ||
            {},
        );
        if (toNonEmptyString(probe.type) !== 'call') return;
      } catch {
        return;
      }
    }

    try {
      // Create user-preference channels in headless context so the correct
      // sound channel exists before the OS auto-displays any FCM notification.
      const { applyNotificationChannelPrefs, readRingtonePrefs } = require('./notificationChannels');
      const prefs = await readRingtonePrefs();
      await applyNotificationChannelPrefs(prefs);
    } catch (channelError: any) {
      console.warn('[push] applyNotificationChannelPrefs failed:', channelError?.message || channelError);
    }

    try {
      await presentBackgroundLocalNotification(data);
    } catch (taskError: any) {
      console.warn('[push] Background notification scheduling failed:', taskError?.message || taskError);
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Register Notifee call event handlers (Answer / Decline / Missed-call)
//    Must run in all contexts so tapping Answer on a notification while
//    the app is killed correctly opens the call screen.
// ---------------------------------------------------------------------------

registerNotifeeCallEventHandlers();

// ---------------------------------------------------------------------------
// 3. Register background task with the OS
//    registerTaskAsync persists the registration natively after the first
//    call, so subsequent app launches (including headless) don't need to
//    re-call it — but calling it multiple times is harmless.
// ---------------------------------------------------------------------------

if (Platform.OS !== 'web') {
  TaskManager.isTaskRegisteredAsync(BACKGROUND_NOTIFICATION_TASK)
    .then((isRegistered) => {
      if (!isRegistered) {
        return Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
      }
      return null;
    })
    .catch((e: any) => {
      console.warn('[push] backgroundTaskSetup registerTaskAsync failed:', e?.message || e);
    });
}
