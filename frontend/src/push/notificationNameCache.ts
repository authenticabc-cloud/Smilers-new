/**
 * notificationNameCache — bridges the in-app device-contact name resolution
 * to the BACKGROUND notification handlers.
 *
 * Problem: message push notifications carry the sender's Smilers/Google
 * account name, but the chat list shows the name saved in the user's DEVICE
 * contacts. The background/headless notification code can't use the
 * `deviceContactIndex` React context (no React) and can't query all contacts
 * cheaply, so notifications showed the account name instead.
 *
 * Fix: while the app is in the foreground, `ConversationRow` already resolves
 * each 1:1 conversation's display name (device-contact first). It calls
 * `cacheConversationName(conversationId, name)` here, persisting a small
 * `conversationId → name` map to AsyncStorage. The notification handlers then
 * read it (sync from memory in-process, or from AsyncStorage in a headless
 * task) and override the sender name.
 *
 * Only 1:1 conversations are cached — for a GROUP the resolved name is the
 * group name, not the message sender, so overriding there would be wrong.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'smilers_convo_name_cache_v1';
const MAX_ENTRIES = 500;

let mem: Record<string, string> | null = null;
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    mem = raw ? JSON.parse(raw) : {};
  } catch {
    mem = {};
  }
  loaded = true;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      const entries = Object.entries(mem || {});
      // Bound the map so it can't grow forever.
      const trimmed = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
    } catch {
      /* best effort */
    }
  }, 900);
}

/** Persist the display name the chat list shows for a 1:1 conversation. */
export function cacheConversationName(
  conversationId: string | null | undefined,
  name: string | null | undefined,
): void {
  const id = (conversationId || '').trim();
  const value = (name || '').trim();
  if (!id || !value) return;
  ensureLoaded().then(() => {
    if (!mem) mem = {};
    if (mem[id] === value) return;
    mem[id] = value;
    scheduleFlush();
  });
}

/** Look up the cached name for a conversation (async — reads AsyncStorage in
 *  a fresh/headless JS context). Returns '' on miss. */
export async function getCachedConversationName(
  conversationId: string | null | undefined,
): Promise<string> {
  const id = (conversationId || '').trim();
  if (!id) return '';
  await ensureLoaded();
  return (mem && mem[id]) || '';
}
