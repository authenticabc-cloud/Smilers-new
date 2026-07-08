/**
 * outbox — local offline send queue for plain-text messages.
 *
 * Mirrors the web app's "offline outbox" behaviour: when a plain-text
 * message fails to reach the server (device offline / Convex unreachable),
 * we persist it to AsyncStorage keyed per-conversation and surface it in the
 * timeline immediately with a RED delivery dot (`__outbox`/`__failed`).
 *
 * The queue is flushed automatically when connectivity returns (NetInfo) or
 * the app comes to the foreground (AppState 'active'). On a successful flush
 * the local entry is removed and the real server message takes its place via
 * the normal Convex reactive query.
 *
 * Scope guard (matches the native delivery-status contract):
 *   - ONLY plain-text messages are queued. E2EE and media messages are NOT
 *     queued here because they need live keys / a live upload session.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const NAMESPACE = 'smilers:outbox:v1';

export interface OutboxMessage {
  /** Local-only id, prefixed so it never collides with a Convex id. */
  _id: string;
  _creationTime: number;
  conversationId: string;
  senderId: string;
  type: 'text';
  text: string;
  replyToId?: string;
  /** RED dot: queued locally, never reached the server. */
  __outbox: true;
  /** Toggled true after a flush attempt fails (still RED). */
  __failed?: boolean;
}

function makeKey(conversationId: string): string {
  return `${NAMESPACE}:${conversationId}`;
}

function makeLocalId(): string {
  return `outbox::${Date.now()}::${Math.random().toString(36).slice(2, 10)}`;
}

/** Read the queued messages for a conversation (oldest-first). */
export async function loadOutbox(conversationId: string): Promise<OutboxMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(makeKey(conversationId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function persist(conversationId: string, list: OutboxMessage[]): Promise<void> {
  try {
    if (list.length === 0) {
      await AsyncStorage.removeItem(makeKey(conversationId));
    } else {
      await AsyncStorage.setItem(makeKey(conversationId), JSON.stringify(list));
    }
  } catch {
    /* swallow: quota / locked */
  }
}

/** Append a new plain-text message to the queue. Returns the updated list. */
export async function enqueueOutbox(
  conversationId: string,
  input: { senderId: string; text: string; replyToId?: string },
): Promise<OutboxMessage[]> {
  const list = await loadOutbox(conversationId);
  const entry: OutboxMessage = {
    _id: makeLocalId(),
    _creationTime: Date.now(),
    conversationId,
    senderId: input.senderId,
    type: 'text',
    text: input.text,
    ...(input.replyToId ? { replyToId: input.replyToId } : {}),
    __outbox: true,
  };
  const next = [...list, entry];
  await persist(conversationId, next);
  return next;
}

/** Remove a single queued message (e.g. after a successful flush). */
export async function removeFromOutbox(
  conversationId: string,
  localId: string,
): Promise<OutboxMessage[]> {
  const list = await loadOutbox(conversationId);
  const next = list.filter((m) => m._id !== localId);
  await persist(conversationId, next);
  return next;
}

/** Mark a queued message as failed (keeps it RED, eligible for next flush). */
export async function markOutboxFailed(
  conversationId: string,
  localId: string,
): Promise<OutboxMessage[]> {
  const list = await loadOutbox(conversationId);
  const next = list.map((m) => (m._id === localId ? { ...m, __failed: true } : m));
  await persist(conversationId, next);
  return next;
}
