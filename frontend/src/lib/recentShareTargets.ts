/**
 * Recent share targets — remembers who the user last shared to via the
 * OS share sheet so the share picker can pin a "Frequently shared" row.
 *
 * Storage: AsyncStorage, per-user key (same scoping pattern as diaryStore).
 * Each entry is identified by a STABLE id:
 *   - `u:<userId>`        → direct-message recipient (survives the
 *                            contact-row → conversation-row transition)
 *   - `c:<conversationId>` → group chats (no single peer userId)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'smilers_recent_share_targets_';
const MAX_ENTRIES = 8;

export type ShareTargetStat = {
  id: string;
  lastUsedAt: number;
  useCount: number;
};

function keyFor(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `${KEY_PREFIX}${userId}`;
}

export async function getRecentShareTargets(
  userId: string | null | undefined,
): Promise<ShareTargetStat[]> {
  const key = keyFor(userId);
  if (!key) return [];
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) => e && typeof e.id === 'string' && typeof e.lastUsedAt === 'number',
    );
  } catch {
    return [];
  }
}

/** Record a successful share to the given stable target ids. */
export async function recordShareTargets(
  userId: string | null | undefined,
  ids: string[],
): Promise<void> {
  const key = keyFor(userId);
  if (!key || ids.length === 0) return;
  try {
    const existing = await getRecentShareTargets(userId);
    const byId = new Map(existing.map((e) => [e.id, e]));
    const now = Date.now();
    for (const id of ids) {
      const prev = byId.get(id);
      byId.set(id, {
        id,
        lastUsedAt: now,
        useCount: (prev?.useCount || 0) + 1,
      });
    }
    const next = Array.from(byId.values())
      .sort((a, b) => b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_ENTRIES);
    await AsyncStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* best-effort — never block the send flow */
  }
}
