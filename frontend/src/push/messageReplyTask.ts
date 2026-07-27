/**
 * messageReplyTask.ts
 *
 * Headless JS task that sends a chat reply typed directly into the Android
 * notification's inline "Reply" box (RemoteInput). The native
 * `MessageReplyReceiver` → `MessageReplyHeadlessService` (HeadlessJsTaskService)
 * launches this task with `{ conversationId, text }` even when the app is
 * killed/backgrounded.
 *
 * The Smilers backend performs the E2EE encryption server-side on
 * `messages.send` (the mobile app always sends PLAIN text — see the chat
 * screen), so the reply only needs an authenticated Convex mutation. After the
 * send we fire a best-effort recipient push (mirrors the app's sender-side
 * notifyPush) so the other party is alerted just like a normal message.
 *
 * Registered at module scope from index.js so it exists in every JS context.
 */

import { AppState, Platform } from 'react-native';
import { AppRegistry } from 'react-native';

export const MESSAGE_REPLY_TASK = 'SmilersMessageReply';

async function handleMessageReply(data: { conversationId?: string; text?: string } = {}) {
  const conversationId = String(data?.conversationId || '').trim();
  const text = String(data?.text || '').trim();
  if (!conversationId || !text) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SecureStore = require('expo-secure-store');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ConvexHttpClient } = require('convex/browser');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { anyApi } = require('convex/server');

    const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
    if (!convexUrl) {
      console.warn('[reply] no EXPO_PUBLIC_CONVEX_URL — cannot send');
      return;
    }
    const token = await SecureStore.getItemAsync('smilers_id_token');
    if (!token) {
      console.warn('[reply] no auth token in SecureStore — cannot send');
      return;
    }
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(token);

    // 1) Send the reply (backend encrypts + fans out via Convex reactivity).
    await client.mutation(anyApi.messages.send, {
      conversationId,
      type: 'text',
      text,
    });
    console.log('[reply] sent to conv=', conversationId);

    // 2) Best-effort recipient push so the other party is alerted even if
    //    they're offline (mirrors the app's sender-side notifyPush). All
    //    wrapped so a push failure never fails the reply itself.
    try {
      const me: any = await client.query(anyApi.users.getCurrentUser, {}).catch(() => null);
      let conv: any = null;
      try {
        conv = await client.query(anyApi.conversations.getConversation, { conversationId });
      } catch {
        /* optional */
      }
      const myId = String(me?._id || '');
      const rawParticipants: any[] = Array.isArray(conv?.participants)
        ? conv.participants
        : Array.isArray(conv?.members)
          ? conv.members
          : [];
      const recipients = rawParticipants
        .map((p: any) => String(p?._id || p?.userId || p || ''))
        .filter((id: string) => id && id !== myId);
      // Direct fallback: getConversation may expose only otherUserId.
      if (recipients.length === 0 && conv?.otherUserId && String(conv.otherUserId) !== myId) {
        recipients.push(String(conv.otherUserId));
      }

      if (recipients.length > 0) {
        const isGroup = String(conv?.type || '').toLowerCase() === 'group';
        const senderName = String(me?.name || me?.displayName || 'Smilers user');
        const groupName = String(conv?.name || conv?.title || '');
        const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
        if (backendUrl) {
          await fetch(`${backendUrl}/api/notify-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipients,
              event: 'message',
              title: isGroup ? groupName || 'Group chat' : senderName,
              message: isGroup ? `${senderName}: ${text}` : text,
              conversation_id: conversationId,
              sender_phone: me?.phone || null,
              sender_id: myId || null,
              conversation_type: isGroup ? 'group' : 'direct',
              conversation_name: isGroup ? groupName || null : null,
            }),
          }).catch(() => {});
        }
      }
    } catch (pushErr: any) {
      console.warn('[reply] recipient push failed (non-fatal):', pushErr?.message || pushErr);
    }
  } catch (e: any) {
    console.warn('[reply] send failed:', e?.message || e);
  }
}

// Register the headless task so the native HeadlessJsTaskService can launch it.
if (Platform.OS === 'android') {
  try {
    AppRegistry.registerHeadlessTask(MESSAGE_REPLY_TASK, () => handleMessageReply);
  } catch (e: any) {
    // Avoid crashing at import if AppRegistry isn't ready in some context.
    void AppState; // keep import used
    console.warn('[reply] registerHeadlessTask failed:', e?.message || e);
  }
}
