/**
 * ongoingGroupCallStore — tracks GROUP calls this device was rung into so a
 * "Ongoing group call · <name> — tap to join" banner can surface for members who
 * MISSED or DECLINED the ring (they still get a chance to join while it lasts).
 *
 * Recorded at push-receipt (foreground `usePushNotifications` + background
 * `backgroundTaskSetup`) for pushes with conversationType==='group'. Persisted to
 * AsyncStorage so a record made in the killed/background JS context is picked up
 * by the foreground UI. A "Can't join" dismiss is persisted permanently for that
 * callId (unique per call), so the banner never shows again for that specific
 * call. The GroupCallBanner polls the live roster to auto-clear when the call
 * ends or once this user has joined.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type OngoingGroupCall = {
  callId: string;
  conversationId: string;
  streamRoom: string;
  groupName: string;
  isVideo: boolean;
  ts: number;
};

const LIST_KEY = 'ongoingGroupCalls.v1';
const DISMISS_KEY = 'ongoingGroupCalls.dismissed.v1';
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h safety expiry (calls never last this long)

let list: OngoingGroupCall[] = [];
let dismissed: string[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {}
  });
}

async function persist() {
  try {
    await AsyncStorage.multiSet([
      [LIST_KEY, JSON.stringify(list)],
      [DISMISS_KEY, JSON.stringify(dismissed.slice(-200))],
    ]);
  } catch {}
}

/** Load persisted state (idempotent). Also called on app-foreground to pick up
 *  records written by the background/killed JS context. */
export async function loadOngoingGroupCalls(force = false): Promise<void> {
  if (loaded && !force) return;
  loaded = true;
  try {
    const pairs = await AsyncStorage.multiGet([LIST_KEY, DISMISS_KEY]);
    const map = new Map(pairs);
    const l = map.get(LIST_KEY);
    const d = map.get(DISMISS_KEY);
    if (l) list = (JSON.parse(l) as OngoingGroupCall[]).filter((e) => Date.now() - e.ts < MAX_AGE_MS);
    if (d) dismissed = JSON.parse(d) as string[];
  } catch {}
  notify();
}

export function recordIncomingGroupCall(entry: Omit<OngoingGroupCall, 'ts'>): void {
  if (!entry.callId || !entry.streamRoom || !entry.conversationId) return;
  if (dismissed.includes(entry.callId)) return;
  if (list.some((e) => e.callId === entry.callId)) return;
  list = [{ ...entry, ts: Date.now() }, ...list].slice(0, 10);
  void persist();
  notify();
}

/** "Can't join" — hide this call forever for this user. */
export function dismissGroupCall(callId: string): void {
  if (!dismissed.includes(callId)) dismissed.push(callId);
  list = list.filter((e) => e.callId !== callId);
  void persist();
  notify();
}

/** Silently drop (call ended, or user joined) — NOT a permanent dismiss. */
export function removeGroupCall(callId: string): void {
  const before = list.length;
  list = list.filter((e) => e.callId !== callId);
  if (list.length !== before) {
    void persist();
    notify();
  }
}

export function getOngoingGroupCalls(): OngoingGroupCall[] {
  const now = Date.now();
  return list.filter((e) => !dismissed.includes(e.callId) && now - e.ts < MAX_AGE_MS);
}

/** Persisted "Can't join" dismissals (used by the server-driven banner to
 *  honour dismissals across app launches). */
export function getDismissedCallIds(): string[] {
  return [...dismissed];
}

export function subscribeOngoingGroupCalls(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
