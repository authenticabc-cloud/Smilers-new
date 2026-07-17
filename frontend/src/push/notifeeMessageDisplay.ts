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
 * Display a message notification that bundles with others from the same
 * conversation. Returns true on success, false if notifee is unavailable
 * (caller should then fall back to expo-notifications).
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

    const groupId = `msg-grp-${conversationId}`;
    const childId =
      input.childId || `msg-${conversationId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const summaryId = `msg-summary-${conversationId}`;
    const routeData = { ...data, type: 'message', conversationId };

    // 1) The individual message (child of the group). Children carry the
    //    sound/vibration; the summary stays silent to avoid double alerts.
    await native.notifee.displayNotification({
      id: childId,
      title,
      body,
      data: routeData,
      android: {
        channelId: MESSAGE_CHANNEL_ID,
        groupId,
        importance: native.AndroidImportance.HIGH,
        visibility: native.AndroidVisibility.PRIVATE,
        pressAction: { id: 'default', launchActivity: 'default' },
        sound: MESSAGE_SOUND,
        autoCancel: true,
        showTimestamp: true,
        style: { type: native.AndroidStyle.BIGTEXT, text: body },
      },
    });

    // 2) The group summary (shown when collapsed). onlyAlertOnce + the CHILDREN
    //    alert behavior keep it from making its own sound each time.
    await native.notifee.displayNotification({
      id: summaryId,
      title,
      body: 'New messages',
      data: routeData,
      android: {
        channelId: MESSAGE_CHANNEL_ID,
        groupId,
        groupSummary: true,
        groupAlertBehavior: native.AndroidGroupAlertBehavior.CHILDREN,
        importance: native.AndroidImportance.HIGH,
        visibility: native.AndroidVisibility.PRIVATE,
        pressAction: { id: 'default', launchActivity: 'default' },
        onlyAlertOnce: true,
        autoCancel: true,
      },
    });

    return true;
  } catch {
    return false;
  }
}
