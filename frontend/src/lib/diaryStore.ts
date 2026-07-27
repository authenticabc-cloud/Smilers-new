/**
 * Diary local store — AsyncStorage-backed CRUD for the user's personal
 * "Diary" self-conversation.
 *
 * ── Why local-only (iter-111 privacy fix) ────────────────────────────
 *
 * The iter-109 implementation tried to back Diary with a server-side
 * self-conversation using `api.conversations.getOrCreateDirect({
 * otherUserId: me._id })`. That mutation on the current Convex
 * backend either (a) returned an EXISTING conversation that wasn't
 * actually a self-conversation, or (b) returned a SHARED conversation
 * record that multiple users could land in — leading to a critical
 * privacy leak where one user's Diary view contained another user's
 * messages (PDFs, videos, etc.). See user-uploaded screenshot from
 * 14:08 on 2026-06-04.
 *
 * Until the backend ships a properly-isolated `api.diary.*` namespace,
 * the SAFE-BY-CONSTRUCTION approach is to keep Diary 100% local to
 * THIS device. Every entry is stored under a single AsyncStorage key
 * scoped to the current user — there's no possible cross-user
 * contamination because no Diary data ever leaves the device.
 *
 * Trade-offs accepted:
 *   - Diary does NOT sync across devices yet (will when backend ready).
 *   - Diary entries are LOST if the user uninstalls the app.
 *   - File attachments in Diary are stored as the original `mediaUrl`
 *     reference, NOT re-downloaded — if the source is deleted, the
 *     attachment 404s, just like a forwarded link in any chat app.
 *
 * ── Schema ───────────────────────────────────────────────────────────
 *
 * AsyncStorage key: `smilers.diary.<userId>.entries.v1`
 *   (per-user keyspace so the same device can host multiple accounts
 *    without their Diaries leaking into each other on account switch.)
 *
 * Stored as a JSON array of DiaryEntry objects. The newest entry is
 * appended to the END (the reader reverses for display so the
 * newest-at-bottom chat convention works without re-sorting).
 *
 * ── Capacity guard ───────────────────────────────────────────────────
 *
 * We cap at 500 entries per user to keep AsyncStorage I/O fast. When
 * the cap is hit, the oldest entry is dropped on each new append.
 * (Diary is a notes app, not an unlimited archive — if the user needs
 * more, they can export. Export is on the iter-112 backlog.)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type DiaryEntryKind = 'text' | 'image' | 'video' | 'audio' | 'file' | 'gif';

export interface DiaryAttachment {
  storageId?: string | null;
  mediaUrl?: string | null;
  fileUrl?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  audioDuration?: number | null;
  thumbnailUrl?: string | null;
}

export interface DiaryEntryForwardSource {
  conversationId?: string | null;
  conversationName?: string | null;
  originalSenderName?: string | null;
  originalMessageId?: string | null;
  /** Web-app parity: keep the original timestamp so the user can see WHEN they saved this note. */
  originalCreationTime?: number | null;
}

export interface DiaryEntry {
  /** Local UUIDv4 — never collides with Convex Ids because it carries the 'local-' prefix. */
  _id: string;
  /** When the entry was added to Diary (NOT when the original was sent). */
  _creationTime: number;
  kind: DiaryEntryKind;
  text?: string | null;
  attachment?: DiaryAttachment | null;
  /** Present when this entry was forwarded into Diary from another chat. */
  forwardedFrom?: DiaryEntryForwardSource | null;
  /**
   * iter-397: set true once this local entry has been pushed to the cloud
   * (`api.diary.appendEntry`). We KEEP the local copy (marked) instead of
   * deleting it, so notes can never vanish from the device if the cloud
   * append didn't durably persist or `listEntries` later returns empty.
   * Display de-dupes flushed locals against the cloud copy by content.
   */
  _flushedToCloud?: boolean;
}

const KEY_PREFIX = 'smilers.diary.';
const KEY_SUFFIX = '.entries.v1';
const MAX_ENTRIES_PER_USER = 500;

function keyFor(userId: string | null | undefined): string {
  // Anonymous fallback — should never happen in practice because the
  // Diary screen is only mounted after `me?._id` resolves, but we
  // guard so a stray call doesn't write to a shared 'undefined' bucket.
  const safe = typeof userId === 'string' && userId.length > 0 ? userId : '__anon__';
  return `${KEY_PREFIX}${safe}${KEY_SUFFIX}`;
}

function generateLocalId(): string {
  // Crypto.randomUUID() isn't reliably present on older Android WebViews
  // and Hermes — Math.random + timestamp is sufficient because the only
  // collision risk is two writes within the same millisecond on the
  // same device, and we mix in a 12-bit suffix to push the probability
  // far below "user notices".
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `local-${ts}-${rand}`;
}

export async function readDiaryEntries(userId: string | null | undefined): Promise<DiaryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive filter — drop anything that doesn't look like a DiaryEntry
    // so a corrupted record can't crash the renderer.
    return parsed.filter((entry: any): entry is DiaryEntry => (
      entry &&
      typeof entry === 'object' &&
      typeof entry._id === 'string' &&
      typeof entry._creationTime === 'number'
    ));
  } catch {
    return [];
  }
}

async function writeAll(userId: string | null | undefined, entries: DiaryEntry[]): Promise<void> {
  try {
    // Capacity guard — drop oldest if over the cap.
    const trimmed = entries.length > MAX_ENTRIES_PER_USER
      ? entries.slice(entries.length - MAX_ENTRIES_PER_USER)
      : entries;
    await AsyncStorage.setItem(keyFor(userId), JSON.stringify(trimmed));
  } catch {
    /* swallow — best-effort; next append re-attempts */
  }
}

export async function appendDiaryEntry(
  userId: string | null | undefined,
  partial: Omit<DiaryEntry, '_id' | '_creationTime'> & { _creationTime?: number },
): Promise<DiaryEntry> {
  const existing = await readDiaryEntries(userId);
  const entry: DiaryEntry = {
    _id: generateLocalId(),
    _creationTime: typeof partial._creationTime === 'number' ? partial._creationTime : Date.now(),
    kind: partial.kind,
    text: partial.text ?? null,
    attachment: partial.attachment ?? null,
    forwardedFrom: partial.forwardedFrom ?? null,
  };
  await writeAll(userId, [...existing, entry]);
  return entry;
}

export async function deleteDiaryEntry(
  userId: string | null | undefined,
  entryId: string,
): Promise<void> {
  const existing = await readDiaryEntries(userId);
  await writeAll(userId, existing.filter((e) => e._id !== entryId));
}

/**
 * iter-397: mark a local entry as flushed to the cloud WITHOUT deleting it.
 * Previously the flush deleted the local copy right after the cloud append
 * resolved; if that append didn't durably persist (older build / schema),
 * the note was lost forever. Keeping the marked copy lets the display layer
 * hide it when the cloud returns a match, yet still show it if the cloud
 * doesn't — so a user's own notes can never disappear from their device.
 */
export async function markDiaryEntryFlushed(
  userId: string | null | undefined,
  entryId: string,
): Promise<void> {
  const existing = await readDiaryEntries(userId);
  await writeAll(
    userId,
    existing.map((e) => (e._id === entryId ? { ...e, _flushedToCloud: true } : e)),
  );
}

export async function clearDiary(userId: string | null | undefined): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(userId));
  } catch {
    /* swallow */
  }
}

/**
 * sml-diary-recovery: migrate any entries stranded in the anonymous bucket
 * into the authenticated user's bucket.
 *
 * ROOT CAUSE this recovers: when Convex was briefly unauthenticated (expired
 * OIDC token on cold-start/resume, esp. on slow networks) `me?._id` resolved
 * to null, so diary reads/writes fell back to the `__anon__` keyspace. Notes
 * the user added during that window were saved under `__anon__` and vanished
 * from view the moment `me` resolved to the real id — and never reached the
 * cloud (the append was unauthenticated). This merges those orphaned notes
 * into the real user's bucket (deduped) and clears the anon bucket so it only
 * runs once. Safe/no-op when there's nothing to migrate.
 *
 * Returns the number of entries recovered.
 */
export async function migrateAnonDiaryEntries(
  userId: string | null | undefined,
): Promise<number> {
  const safe = typeof userId === 'string' && userId.length > 0 ? userId : null;
  if (!safe) return 0; // no authenticated user yet — nothing to migrate into
  try {
    const anonRaw = await AsyncStorage.getItem(keyFor(null)); // '__anon__' bucket
    if (!anonRaw) return 0;
    let anonEntries: DiaryEntry[] = [];
    try {
      const parsed = JSON.parse(anonRaw);
      if (Array.isArray(parsed)) {
        anonEntries = parsed.filter(
          (e: any): e is DiaryEntry =>
            e && typeof e === 'object' && typeof e._id === 'string' && typeof e._creationTime === 'number',
        );
      }
    } catch {
      anonEntries = [];
    }
    if (anonEntries.length === 0) {
      // Nothing usable — drop the anon bucket so we don't re-check every mount.
      await AsyncStorage.removeItem(keyFor(null)).catch(() => {});
      return 0;
    }
    const existing = await readDiaryEntries(safe);
    // Dedupe: skip anon entries that already exist by _id, or by
    // (kind + text + creationTime) content match against an existing note.
    const existingIds = new Set(existing.map((e) => e._id));
    const contentKey = (e: DiaryEntry) => `${e.kind}|${e.text ?? ''}|${e._creationTime}`;
    const existingContent = new Set(existing.map(contentKey));
    const toMigrate = anonEntries.filter(
      (e) => !existingIds.has(e._id) && !existingContent.has(contentKey(e)),
    );
    if (toMigrate.length > 0) {
      // Newly-recovered entries were never flushed to cloud, so leave
      // _flushedToCloud unset — the flush effect will push them up next.
      const merged = [...existing, ...toMigrate].sort(
        (a, b) => a._creationTime - b._creationTime,
      );
      await writeAll(safe, merged);
    }
    // Clear the anon bucket regardless so this migration is one-shot.
    await AsyncStorage.removeItem(keyFor(null)).catch(() => {});
    return toMigrate.length;
  } catch {
    return 0;
  }
}

/**
 * sml-diary-recovery-2 (iter-414): USER-TRIGGERED deep recovery.
 *
 * Unlike the one-shot `migrateAnonDiaryEntries` (anon bucket only, clears after),
 * this scans EVERY local Diary bucket on the device — the anon bucket AND any
 * other `smilers.diary.<id>.entries.v1` keyspace left behind by a stale-auth
 * window or a previous account/session — and merges any entries NOT already in
 * the current user's bucket into it (deduped by _id + content). Recovered
 * entries are marked `_flushedToCloud: false` so the Diary screen re-pushes them
 * to the cloud (durable, cross-device). Source buckets are left intact
 * (non-destructive) so nothing can be lost by running it.
 *
 * Returns how many entries were recovered and how many buckets were scanned.
 */
export async function recoverDiaryEntries(
  userId: string | null | undefined,
): Promise<{ recovered: number; scannedBuckets: number }> {
  const safe = typeof userId === 'string' && userId.length > 0 ? userId : null;
  if (!safe) return { recovered: 0, scannedBuckets: 0 };
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const diaryKeys = (allKeys || []).filter(
      (k) => typeof k === 'string' && k.startsWith(KEY_PREFIX) && k.endsWith(KEY_SUFFIX),
    );
    const myKey = keyFor(safe);

    const existing = await readDiaryEntries(safe);
    const existingIds = new Set(existing.map((e) => e._id));
    const contentKey = (e: DiaryEntry) =>
      `${e.kind}|${e.text ?? ''}|${e.attachment?.mediaUrl ?? e.attachment?.storageId ?? ''}|${e._creationTime}`;
    const existingContent = new Set(existing.map(contentKey));

    const recoveredEntries: DiaryEntry[] = [];
    for (const key of diaryKeys) {
      if (key === myKey) continue; // current bucket already loaded
      let raw: string | null = null;
      try {
        raw = await AsyncStorage.getItem(key);
      } catch {
        raw = null;
      }
      if (!raw) continue;
      let entries: DiaryEntry[] = [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          entries = parsed.filter(
            (e: any): e is DiaryEntry =>
              e && typeof e === 'object' && typeof e._id === 'string' && typeof e._creationTime === 'number',
          );
        }
      } catch {
        entries = [];
      }
      for (const e of entries) {
        if (existingIds.has(e._id) || existingContent.has(contentKey(e))) continue;
        existingIds.add(e._id);
        existingContent.add(contentKey(e));
        recoveredEntries.push({ ...e, _flushedToCloud: false });
      }
    }

    if (recoveredEntries.length > 0) {
      const merged = [...existing, ...recoveredEntries].sort(
        (a, b) => a._creationTime - b._creationTime,
      );
      await writeAll(safe, merged);
    }
    return { recovered: recoveredEntries.length, scannedBuckets: diaryKeys.length };
  } catch {
    return { recovered: 0, scannedBuckets: 0 };
  }
}

/**
 * Map a chat message (as the Convex `messages.list` query returns it) into
 * a DiaryEntry, used by the "Save to Diary" forward action so a forwarded
 * message keeps its attachment + text + provenance.
 */
export function chatMessageToDiaryEntry(
  msg: any,
  source: DiaryEntryForwardSource,
): Omit<DiaryEntry, '_id' | '_creationTime'> {
  const kind: DiaryEntryKind = (() => {
    const mt = typeof msg?.mimeType === 'string' ? msg.mimeType : '';
    if (mt.startsWith('image/')) return 'image';
    if (mt.startsWith('video/')) return 'video';
    if (mt.startsWith('audio/')) return 'audio';
    if (typeof msg?.gifUrl === 'string' && msg.gifUrl) return 'gif';
    if (msg?.storageId || msg?.fileName) return 'file';
    return 'text';
  })();
  return {
    kind,
    text: typeof msg?.text === 'string' ? msg.text : null,
    attachment: kind === 'text' ? null : {
      storageId: msg?.storageId ?? null,
      mediaUrl: msg?.mediaUrl ?? msg?.fileUrl ?? msg?.url ?? null,
      fileName: msg?.fileName ?? null,
      mimeType: msg?.mimeType ?? null,
      fileSize: msg?.fileSize ?? null,
      audioDuration: msg?.audioDuration ?? null,
      thumbnailUrl: msg?.thumbnailUrl ?? msg?.thumb ?? null,
    },
    forwardedFrom: source,
  };
}
