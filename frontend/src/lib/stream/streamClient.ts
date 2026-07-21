/**
 * streamClient — singleton GetStream Video client + server-signed token provider.
 *
 * STAGED (Phase 1b): this module is part of the Stream Video migration and is
 * NOT yet imported by the app. It compiles/links only after the destructive
 * package swap (`react-native-webrtc` → `@stream-io/react-native-webrtc` +
 * `@stream-io/video-react-native-sdk`). See /app/memory/STREAM_MIGRATION.md.
 *
 * The API SECRET never ships to the client — tokens are minted by our FastAPI
 * `POST /api/stream/token` (server-side, HS256 with the Stream secret).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
// @ts-expect-error — resolved after Phase 1b package install
import { StreamVideoClient, type User } from '@stream-io/video-react-native-sdk';

const API_KEY = process.env.EXPO_PUBLIC_STREAM_API_KEY || 'sf6v64y8z2q7';
const BACKEND = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

// Cached identity keys — set these at login so the push handler (which runs in
// a headless JS context, outside React) can bootstrap the client.
export const STREAM_USER_ID_KEY = '@stream/userId';
export const STREAM_USER_NAME_KEY = '@stream/userName';

export async function cacheStreamIdentity(userId: string, userName?: string) {
  try {
    await AsyncStorage.setItem(STREAM_USER_ID_KEY, userId);
    if (userName) await AsyncStorage.setItem(STREAM_USER_NAME_KEY, userName);
  } catch {}
}

export async function clearStreamIdentity() {
  try {
    await AsyncStorage.multiRemove([STREAM_USER_ID_KEY, STREAM_USER_NAME_KEY]);
  } catch {}
}

/** Fetch a fresh Stream token for `userId` from our backend. */
async function fetchStreamToken(userId: string): Promise<string> {
  const resp = await fetch(`${BACKEND}/api/stream/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!resp.ok) throw new Error(`stream/token HTTP ${resp.status}`);
  const json = await resp.json();
  return json.token as string;
}

/**
 * Create (or reuse) the singleton Stream client. Returns undefined when the
 * user isn't signed in yet. Uses getOrCreateInstance so the push headless
 * context and the React tree share ONE client.
 */
export async function createStreamVideoClient(): Promise<StreamVideoClient | undefined> {
  const userId = await AsyncStorage.getItem(STREAM_USER_ID_KEY);
  if (!userId) return undefined;
  const userName = (await AsyncStorage.getItem(STREAM_USER_NAME_KEY)) || undefined;

  const user: User = { id: userId, name: userName };
  return StreamVideoClient.getOrCreateInstance({
    apiKey: API_KEY,
    user,
    tokenProvider: () => fetchStreamToken(userId),
    options: { rejectCallWhenBusy: true },
  });
}
