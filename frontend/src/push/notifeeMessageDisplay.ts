/**
 * notifeeMessageDisplay — Android message notifications that BUNDLE into one
 * collapsible entry per conversation (WhatsApp-style), instead of stacking as
 * many separate notifications.
 *
 * expo-notifications cannot set an Android notification `group`/`groupSummary`,
 * so message notifications are rendered through @notifee/react-native (already
 * used for calls). Grouping requires:
 *   1. Every child notification for a conversation sharing the same `groupId`.
 *   2. One extra "summary" notification for that group with `groupSummary: true`.
 * Android then collapses the children under the summary; expanding shows them.
 *
 * Grouping is per-conversation (groupId = `msg-grp-<conversationId>`), so each
 * chat gets its own expandable bundle.
 *
 * TAP ROUTING: children/summary use `pressAction: { id: 'default' }` and carry
 * `{ type: 'message', conversationId }` in `data`. The notifee event handlers
 * in `notifeeCallWake.ts` route `type === 'message'` presses to /chat/<id>.
 *
 * NATIVE-ONLY: no-ops on web and returns false if the native notifee module is
 * unavailable, so callers can fall back to the expo-notifications path. Can only
 * be validated on a real device build (not Expo Go / web preview).
 */

import { Platform } from 'react-native';

const MESSAGE_CHANNEL_ID = 'messages-v4-message_notification';
const MESSAGE_SOUND = 'message_notification';

type NativeCache = {
  notifee: any;
  AndroidImportance: any;
  AndroidVisibility: any;
  AndroidStyle: any;
  AndroidGroupAlertBehavior: any;
};

let nativeCache: NativeCache | null | undefined;
let channelReady = false;

function loadNative(): NativeCache | null {
  if (Platform.OS !== 'android') return null;
  if (nativeCache !== undefined) return nativeCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notifee = require('@notifee/react-native');
    nativeCache = {
      notifee: notifee.default || notifee,
      AndroidImportance: notifee.AndroidImportance || { DEFAULT: 3, HIGH: 4 },
      AndroidVisibility: notifee.AndroidVisibility || { SECRET: -1, PRIVATE: 0, PUBLIC: 1 },
      AndroidStyle: notifee.AndroidStyle || { BIGTEXT: 0, INBOX: 3, MESSAGING: 4 },
      AndroidGroupAlertBehavior: notifee.AndroidGroupAlertBehavior || {
        ALL: 0,
        SUMMARY: 1,
        CHILDREN: 2,
      },
    };
  } catch {
    nativeCache = null;
  }
  return nativeCache;
}

async function ensureChannel(native: NativeCache): Promise<void> {
  if (channelReady) return;
  try {
    await native.notifee.createChannel({
      id: MESSAGE_CHANNEL_ID,
      name: 'Messages',
      importance: native.AndroidImportance.HIGH,
      sound: MESSAGE_SOUND,
      vibration: true,
      vibrationPattern: [250, 250],
      lightColor: '#E4B53B',
      visibility: native.AndroidVisibility.PRIVATE,
      badge: true,
    });
  } catch {
    // Android channels are persistent; a throw usually means it already exists.
  }
  channelReady = true;
}

export type GroupedMessageInput = {
  title: string;
  body: string;
  conversationId: string;
  /** Full push payload — forwarded as notifee `data` for tap routing. */
  data: Record<string, any>;
  /** Stable-ish unique id for this child; defaults to a timestamped id. */
  childId?: string;
};

/**
 * Display a message notification for a conversation. Uses ONE stable
 * notification per conversation (id = `msg-conv-<conversationId>`) that is
 * UPDATED in place as new messages arrive — never a child + separate summary.
 *
 * WHY (duplicate-notification root cause): the previous implementation posted a
 * per-message "child" notification PLUS a "group summary" notification. Android
 * renders a group summary as its OWN standalone notification whenever the group
 * doesn't have enough children to collapse (and the child/summary counting
 * raced across the killed-app headless JS contexts that each FCM spins up),
 * which is exactly the "message notification rendered twice" the user kept
 * seeing. A single stable-id notification per conversation makes duplicates
 * structurally impossible: re-posting the same id UPDATES the existing entry.
 *
 * Accumulated message lines are persisted in the notification's own `data`
 * (`linesJson`), so even a fresh headless process can read the currently
 * displayed notification, append the new line, and re-post — WhatsApp-style
 * "N new messages" with a preview of the latest lines.
 *
 * Returns true on success, false if notifee is unavailable (caller should then
 * fall back to expo-notifications).
 */
export async function displayGroupedMessageNotification(
  input: GroupedMessageInput,
): Promise<boolean> {
  const native = loadNative();
  if (!native) return false;

  const { title, body, conversationId, data } = input;
  if (!conversationId) return false;

  try {
    await ensureChannel(native);

    const notificationId = `msg-conv-${conversationId}`;
    const routeData = { ...data, type: 'message', conversationId };

    // Pull the currently-displayed notification for this conversation (if any)
    // so we can append to its accumulated lines. Persisting the lines in the
    // notification's own data means this works across the separate headless JS
    // processes each FCM push may run in (in-memory state would be lost).
    let priorLines: string[] = [];
    let convName = title;
    try {
      const displayed = await native.notifee.getDisplayedNotifications();
      const existing = (Array.isArray(displayed) ? displayed : []).find(
        (d: any) => d?.id === notificationId || d?.notification?.id === notificationId,
      );
      const existingData = existing?.notification?.data || existing?.data;
      if (existingData?.linesJson) {
        const parsed = JSON.parse(String(existingData.linesJson));
        if (Array.isArray(parsed)) priorLines = parsed.map((s) => String(s)).filter(Boolean);
      }
      const existingTitle = existing?.notification?.title;
      if (typeof existingTitle === 'string' && existingTitle.trim()) {
        convName = existingTitle.trim();
      }
    } catch {
      /* no prior notification — start fresh */
    }

    // Append this message and cap the visible history at 6 lines (matches the
    // OS default). Guard against the SAME FCM being processed twice (a killed
    // app can wake for both onMessageReceived and handleIntent) by skipping an
    // exact-duplicate consecutive line.
    const nextLines = [...priorLines];
    if (nextLines[nextLines.length - 1] !== body) {
      nextLines.push(body);
    }
    const lines = nextLines.slice(-6);
    const msgCount = nextLines.length;

    const summaryBody = msgCount >= 2 ? `${msgCount} new messages` : body;

    await native.notifee.displayNotification({
      id: notificationId,
      title: convName,
      body: summaryBody,
      data: { ...routeData, linesJson: JSON.stringify(lines), msgCount: String(msgCount) },
      android: {
        channelId: MESSAGE_CHANNEL_ID,
        importance: native.AndroidImportance.HIGH,
        visibility: native.AndroidVisibility.PRIVATE,
        pressAction: { id: 'default', launchActivity: 'default' },
        sound: MESSAGE_SOUND,
        // Only alert (sound/vibrate) for the FIRST message in a burst so an
        // in-place update for message 2..N doesn't re-buzz repeatedly.
        onlyAlertOnce: msgCount > 1,
        autoCancel: true,
        showTimestamp: true,
        style:
          msgCount >= 2
            ? { type: native.AndroidStyle.INBOX, lines, title: convName, summary: summaryBody }
            : { type: native.AndroidStyle.BIGTEXT, text: body },
      },
    });

    // Bump the launcher badge for background/killed posts; the foreground
    // reactive sync (chats screen) corrects the exact total on next open.
    await incrementAppBadgeCount();

    return true;
  } catch {
    return false;
  }
}

/**
 * Clear a conversation's message notifications (children + group summary) when
 * the user opens that chat, so read messages don't linger in the shade.
 * Handles BOTH the notifee-grouped notifications and the expo-notifications
 * fallback. Safe/no-op on web or when a module is missing.
 */
export async function clearConversationNotifications(conversationId: string): Promise<void> {
  if (Platform.OS !== 'android' || !conversationId) return;
  const groupId = `msg-grp-${conversationId}`;

  // 1) notifee-displayed notifications for this conversation's group.
  const native = loadNative();
  if (native) {
    try {
      const displayed = await native.notifee.getDisplayedNotifications();
      const toCancel = (Array.isArray(displayed) ? displayed : []).filter((d: any) => {
        const n = d?.notification;
        const gid = n?.android?.groupId;
        const convo = n?.data?.conversationId;
        return gid === groupId || convo === conversationId;
      });
      await Promise.all(
        toCancel.map((d: any) =>
          d?.id ? native.notifee.cancelNotification(d.id).catch(() => {}) : Promise.resolve(),
        ),
      );
      // Belt-and-braces: cancel the well-known ids even if not listed.
      await native.notifee.cancelNotification(`msg-conv-${conversationId}`).catch(() => {});
      await native.notifee.cancelNotification(`msg-summary-${conversationId}`).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  // 2) expo-notifications fallback (used on builds without notifee).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Notifications = require('expo-notifications');
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      (Array.isArray(presented) ? presented : [])
        .filter((n: any) => {
          const data = n?.request?.content?.data || {};
          return String(data?.conversationId || '') === conversationId;
        })
        .map((n: any) =>
          Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {}),
        ),
    );
  } catch {
    /* best effort */
  }
}

/**
 * Set the app-icon (launcher) unread badge count. Uses notifee on Android
 * (OEM-launcher dependent) and expo-notifications for the iOS badge. A count
 * of 0 clears the badge. Best-effort / no-op when a module is missing.
 */
export async function setAppBadgeCount(count: number): Promise<void> {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const native = loadNative();
  if (native) {
    try {
      await native.notifee.setBadgeCount(n);
    } catch {
      /* best effort */
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Notifications = require('expo-notifications');
    await Notifications.setBadgeCountAsync(n);
  } catch {
    /* best effort */
  }
}

/**
 * Increment the launcher badge by one (used when a message notification is
 * posted while the app is backgrounded/killed and no reactive unread total is
 * running). The foreground reactive sync corrects the exact value on next open.
 */
export async function incrementAppBadgeCount(): Promise<void> {
  const native = loadNative();
  if (native && typeof native.notifee.incrementBadgeCount === 'function') {
    try {
      await native.notifee.incrementBadgeCount(1);
      return;
    } catch {
      /* fall through */
    }
  }
  // No incrementBadgeCount available — best-effort read + set via notifee.
  if (native && typeof native.notifee.getBadgeCount === 'function') {
    try {
      const current = Number(await native.notifee.getBadgeCount()) || 0;
      await native.notifee.setBadgeCount(current + 1);
    } catch {
      /* best effort */
    }
  }
}
