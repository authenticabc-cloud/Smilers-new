/**
 * lastRoute — remember the conversation the user was last viewing so a full
 * app restart (process killed by the OS, force-close, crash) reopens it
 * instead of dumping them back on the Chats list.
 *
 * Scope is deliberately narrow: we only remember/restore a CHAT conversation
 * (the flow the user explicitly asked for) to avoid interfering with the app's
 * intricate cold-start routing for incoming calls, share-intents and deep
 * links. Backgrounding/foregrounding never loses the navigation stack (React
 * Navigation keeps it in memory), so this only matters on a true cold start.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'smilers:last_route:v1';
// Only auto-resume a route saved within this window — resuming a chat you
// opened days ago would feel wrong.
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

interface LastRoute {
  path: string; // e.g. "/chat/abc123"
  at: number;
}

export async function rememberChatRoute(path: string): Promise<void> {
  try {
    if (!path || !path.startsWith('/chat/')) return;
    const value: LastRoute = { path, at: Date.now() };
    await AsyncStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

export async function consumeResumableChatRoute(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastRoute;
    if (!parsed?.path || !parsed.path.startsWith('/chat/')) return null;
    if (!parsed.at || Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed.path;
  } catch {
    return null;
  }
}
