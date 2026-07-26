/**
 * mutedConversations — per-conversation notification mute (device-local).
 *
 * Muting a chat/group suppresses its message notifications (banner + sound) on
 * THIS device. Stored in AsyncStorage as a plain array of conversation ids so
 * the headless notification renderers (notifee / expo-notifications background
 * tasks) can read it synchronously-ish before deciding to display.
 *
 * Device-local by design: it works offline and instantly, without depending on
 * the external Convex backend. (A future enhancement could sync mutes across a
 * user's devices via Convex.)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'smilers_muted_conversations_v1';

async function readSet(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map((x) => String(x)) : []);
  } catch {
    return new Set();
  }
}

async function writeSet(set: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* best effort */
  }
}

/** All currently-muted conversation ids. */
export async function getMutedConversations(): Promise<string[]> {
  return [...(await readSet())];
}

/** Whether a specific conversation is muted on this device. */
export async function isConversationMuted(conversationId: string | null | undefined): Promise<boolean> {
  if (!conversationId) return false;
  return (await readSet()).has(String(conversationId));
}

/** Mute or unmute a conversation. Returns the new muted state. */
export async function setConversationMuted(
  conversationId: string,
  muted: boolean,
): Promise<boolean> {
  if (!conversationId) return false;
  const set = await readSet();
  if (muted) set.add(String(conversationId));
  else set.delete(String(conversationId));
  await writeSet(set);
  return muted;
}
