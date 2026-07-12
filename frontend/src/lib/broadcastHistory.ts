/**
 * broadcastHistory — device-local audit log of admin broadcasts.
 *
 * Each time an admin fires a broadcast from this device we append an entry
 * (message text, recipient/sent/failed counts, timestamp) to an AsyncStorage
 * ring buffer. The admin can review it on the "Broadcast history" screen.
 *
 * NOTE: this is DEVICE-LOCAL only (it records broadcasts sent from THIS device;
 * it is not synced across the admin's devices). A cross-device audit log would
 * require a Convex backend function owned by the web team.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'smilers:broadcast_history:v1';
const MAX_STORED = 50;

export interface BroadcastLogEntry {
  id: string;
  ts: number;
  text: string;
  total: number;
  sent: number;
  failed: number;
}

async function readAll(): Promise<BroadcastLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append a broadcast to the local history (newest kept, capped at MAX_STORED). */
export async function recordBroadcast(entry: Omit<BroadcastLogEntry, 'id' | 'ts'>): Promise<void> {
  try {
    const existing = await readAll();
    const full: BroadcastLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      text: String(entry.text || '').slice(0, 1000),
      total: Number(entry.total) || 0,
      sent: Number(entry.sent) || 0,
      failed: Number(entry.failed) || 0,
    };
    existing.push(full);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(existing.slice(-MAX_STORED)));
  } catch {
    /* best-effort; never block a send */
  }
}

/** Read the broadcast history (newest first). */
export async function getBroadcastHistory(): Promise<BroadcastLogEntry[]> {
  const all = await readAll();
  return [...all].reverse();
}

/** Clear the local broadcast history. */
export async function clearBroadcastHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
