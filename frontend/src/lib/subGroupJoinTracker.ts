import { readStoredString, writeStoredString } from './settingsStorage';

/**
 * Tracks which sub groups the current user has already been seen as a member of,
 * per mother group, so we can show a "You joined X" toast ONLY on a genuinely
 * new membership (not on first load / existing memberships). Persisted locally.
 */
const KEY = 'smilers.subgroups.joined.v1';

let cache: Record<string, string[]> | null = null;

export async function loadJoinTracker(): Promise<void> {
  if (cache) return;
  try {
    const raw = await readStoredString(KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
}

async function persist() {
  try {
    await writeStoredString(KEY, JSON.stringify(cache || {}));
  } catch {}
}

/**
 * Compares the caller's CURRENT active sub-group memberships under a mother
 * group against what we last saw. Returns the ids that are newly joined.
 * On the very first observation for a parent, it seeds silently (returns []).
 */
export function detectNewlyJoined(parentId: string, currentIds: string[]): string[] {
  if (!cache) return [];
  const stored = cache[parentId];
  if (stored === undefined) {
    cache[parentId] = currentIds;
    void persist();
    return [];
  }
  const storedSet = new Set(stored);
  const newly = currentIds.filter((id) => !storedSet.has(id));
  const changed = newly.length > 0 || currentIds.length !== stored.length;
  cache[parentId] = currentIds;
  if (changed) void persist();
  return newly;
}
