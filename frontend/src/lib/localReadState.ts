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
const BASELINE_KEY = 'smilers_local_read_baseline_v1';

let map: Record<string, number> = {};
let baselineMap: Record<string, number> = {};
let loaded = false;
const listeners = new Set<() => void>();
let baselineFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
  try {
    const rawB = await AsyncStorage.getItem(BASELINE_KEY);
    if (rawB) {
      const parsedB = JSON.parse(rawB);
      if (parsedB && typeof parsedB === 'object') baselineMap = parsedB as Record<string, number>;
    }
  } catch {
    /* ignore */
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
  clearReadBaseline(conversationId);
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

// ── Baseline "already-read" count ────────────────────────────────────────
// The backend `getUnreadCounts` does NOT reliably clear after markRead on some
// accounts, so once a NEWER message arrives the raw count would resurrect the
// whole already-read bulk as unread. We snapshot the backend count WHILE a
// conversation is locally-read (the "already-read watermark"); when a new
// message flips it back to unread, the true new-message count is
// `max(0, backend - baseline)`. Tracking the watermark continuously also
// handles accounts where the backend DOES clear (baseline follows it down).

function scheduleBaselineFlush(): void {
  if (baselineFlushTimer) return;
  baselineFlushTimer = setTimeout(() => {
    baselineFlushTimer = null;
    AsyncStorage.setItem(BASELINE_KEY, JSON.stringify(baselineMap)).catch(() => {});
  }, 800);
}

/** Record the already-read backend count for a conversation that is currently
 *  locally-read. Call this whenever the row is in the read state. */
export function noteReadBaseline(conversationId: string, backendCount: number): void {
  if (!conversationId) return;
  const c = Number(backendCount) || 0;
  if (baselineMap[conversationId] === c) return;
  baselineMap = { ...baselineMap, [conversationId]: c };
  scheduleBaselineFlush();
}

/** Clear the baseline (used when a local-read is undone). */
export function clearReadBaseline(conversationId: string): void {
  if (!conversationId || !(conversationId in baselineMap)) return;
  const next = { ...baselineMap };
  delete next[conversationId];
  baselineMap = next;
  scheduleBaselineFlush();
}

/**
 * Effective unread count for a conversation row:
 *   - locally-read (no newer activity) → 0
 *   - otherwise → new messages since the last read = max(0, backend - baseline)
 */
export function effectiveUnread(
  readMap: Record<string, number>,
  conversationId: string,
  lastActivityMs: number,
  backendCount: number,
): number {
  const b = Number(backendCount) || 0;
  if (isLocallyRead(readMap, conversationId, lastActivityMs)) return 0;
  const baseline = baselineMap[conversationId] || 0;
  // Stale backend (never cleared) keeps climbing → subtract the already-read
  // baseline. If the backend dropped BELOW the baseline it has reset/cleared
  // on its own → trust it directly (avoids under-counting to 0).
  return b >= baseline ? b - baseline : b;
}

/** Baseline-only unread for contexts without the last-activity timestamp
 *  (e.g. the app-badge total computed from inside an open chat). */
export function unreadMinusBaseline(conversationId: string, backendCount: number): number {
  const b = Number(backendCount) || 0;
  const baseline = baselineMap[conversationId] || 0;
  return b >= baseline ? b - baseline : b;
}
