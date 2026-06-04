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

export async function clearDiary(userId: string | null | undefined): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(userId));
  } catch {
    /* swallow */
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
