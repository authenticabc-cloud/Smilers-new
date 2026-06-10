/**
 * offlineCache — iter 160 offline persistence.
 *
 * Thin AsyncStorage-backed key/value cache for Convex query results so the
 * chats list (and later, messages) hydrate instantly on cold launch even
 * with no network. New messages still require connectivity.
 *
 * Design:
 *   - Pure async, no React deps — safe to import anywhere.
 *   - Namespaced keys (`smilers:offline:<scope>:<key>`) to avoid collisions
 *     with other AsyncStorage clients.
 *   - Optional per-entry TTL (defaults to 30 days) so stale data doesn't
 *     linger forever after a user signs out or switches device.
 *   - Web safe-no-ops: AsyncStorage on web is implemented over localStorage
 *     which has a ~5 MB quota; we guard writes against quota errors.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const NAMESPACE = 'smilers:offline:v1';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface Envelope<T> {
  v: number;          // schema version
  ts: number;         // epoch ms when written
  ttl: number;        // ttl in ms (0 = never expires)
  data: T;
}

function makeKey(scope: string, key: string): string {
  return `${NAMESPACE}:${scope}:${key}`;
}

/**
 * Read a previously-cached value for the given scope+key. Returns
 * `null` when:
 *   - Nothing has been cached yet
 *   - The cached envelope is malformed
 *   - The entry has expired per its TTL
 *   - AsyncStorage threw (e.g. quota / locked)
 */
export async function readCache<T>(scope: string, key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(makeKey(scope, key));
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    if (!env || typeof env !== 'object' || env.v !== 1) return null;
    if (env.ttl > 0 && Date.now() - env.ts > env.ttl) {
      // Stale — fire-and-forget cleanup.
      AsyncStorage.removeItem(makeKey(scope, key)).catch(() => {});
      return null;
    }
    return env.data;
  } catch {
    return null;
  }
}

/**
 * Persist a value for the given scope+key. Silent on failure so the
 * caller can never block the UI on AsyncStorage errors.
 */
export async function writeCache<T>(
  scope: string,
  key: string,
  data: T,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
  try {
    const env: Envelope<T> = {
      v: 1,
      ts: Date.now(),
      ttl: ttlMs,
      data,
    };
    await AsyncStorage.setItem(makeKey(scope, key), JSON.stringify(env));
  } catch {
    /* swallow: quota, locked, etc. */
  }
}

/** Remove a single cached entry. */
export async function clearCache(scope: string, key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(makeKey(scope, key));
  } catch {
    /* swallow */
  }
}

/** Remove every cached entry under a scope (e.g. on sign-out). */
export async function clearScope(scope: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const prefix = `${NAMESPACE}:${scope}:`;
    const matching = keys.filter((k) => k.startsWith(prefix));
    if (matching.length) {
      await AsyncStorage.multiRemove(matching);
    }
  } catch {
    /* swallow */
  }
}
