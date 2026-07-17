/**
 * localReadState — on-device "this conversation has been read" overlay.
 *
 * WHY: The chat list's unread badge is driven by the backend
 * `messages.getUnreadCounts` query. On some accounts that count does not clear
 * after `messages.markRead` fires on chat-open, so the red badge lingers
 * forever even though the user already opened & read the chat. This module lets
 * the client suppress the badge locally the moment a chat is opened
 * (or swipe-marked / mark-all-read), and automatically re-show it when a
 * genuinely NEWER message arrives (its activity timestamp exceeds the stored
 * "read up to" time). It is purely additive display state — it never touches
 * read receipts / ticks, so it cannot regress those.
 *
 * The stored value per conversation is the "read up to" activity timestamp (ms).
 * A conversation is considered locally-read while its latest activity is <= that.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'smilers_local_read_v1';

let map: Record<string, number> = {};
let loaded = false;
const listeners = new Set<() => void>();

export async function loadLocalRead(): Promise<Record<string, number>> {
  if (loaded) return map;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') map = parsed as Record<string, number>;
    }
  } catch {
    /* ignore corrupt/locked storage — start empty */
  }
  loaded = true;
  return map;
}

export function getLocalReadMap(): Record<string, number> {
  return map;
}

function notify() {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* listener errors must never break a read update */
    }
  });
}

/** Mark a conversation read up to `activityMs` (defaults to now). No-ops if we
 *  already have an equal/newer read stamp. */
export function markLocallyRead(conversationId: string, activityMs?: number): void {
  if (!conversationId) return;
  const ts = typeof activityMs === 'number' && Number.isFinite(activityMs) && activityMs > 0 ? activityMs : Date.now();
  const prev = map[conversationId] || 0;
  if (ts <= prev) return;
  map = { ...map, [conversationId]: ts };
  notify();
  AsyncStorage.setItem(KEY, JSON.stringify(map)).catch(() => {});
}

/** Undo a local-read (used by the swipe "Undo" flow). */
export function clearLocalRead(conversationId: string): void {
  if (!conversationId || !(conversationId in map)) return;
  const next = { ...map };
  delete next[conversationId];
  map = next;
  notify();
  AsyncStorage.setItem(KEY, JSON.stringify(map)).catch(() => {});
}

export function subscribeLocalRead(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Best-effort "last activity" timestamp (ms) for a conversation/group row,
 *  handling both numeric (Convex _creationTime / ms) and ISO-string fields. */
export function conversationLastActivityMs(item: any): number {
  const raw =
    item?.lastMessageAt ??
    item?.lastMessageTime ??
    item?.lastMessage?._creationTime ??
    item?.lastMessage?.createdAt ??
    item?.updatedAt ??
    item?._creationTime;
  if (raw == null) return 0;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

/** True when the conversation has been locally read and no newer message has
 *  arrived since (i.e. suppress its unread badge). */
export function isLocallyRead(
  readMap: Record<string, number>,
  conversationId: string,
  lastActivityMs: number,
): boolean {
  const readAt = readMap?.[conversationId];
  if (!readAt) return false;
  return (lastActivityMs || 0) <= readAt;
}
