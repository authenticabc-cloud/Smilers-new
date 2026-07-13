/**
 * pendingChatLink — when a signed-OUT user taps someone's personal chat link
 * (`/u/<id>`), we stash the target user id here, send them through sign-in,
 * then resume straight into the chat once they're authenticated.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'smilers:pending_chat_with:v1';
// Only resume a target stashed recently — resuming a link tapped an hour ago
// after the user did other things would feel wrong.
const MAX_AGE_MS = 30 * 60 * 1000;

interface PendingChatWith {
  userId: string;
  at: number;
}

export async function stashPendingChatWith(userId: string): Promise<void> {
  try {
    if (!userId) return;
    const value: PendingChatWith = { userId: String(userId), at: Date.now() };
    await AsyncStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

export async function consumePendingChatWith(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    await AsyncStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as PendingChatWith;
    if (!parsed?.userId || !parsed.at) return null;
    if (Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}
