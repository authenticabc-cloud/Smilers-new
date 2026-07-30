/**
 * chatBackup — REAL encrypted backup of the user's chats + call logs.
 *
 * The Smilers chat data lives on the external Convex backend. If the server
 * ever trims/loses history, the user previously had NO way to recover it. This
 * module reads EVERY conversation (paginating through all messages) plus its
 * call logs, serialises them, and writes an AES-GCM-256 encrypted envelope
 * (same format + PIN as the Diary backup) to the app's persistent document
 * directory. The file is portable: shared to another device and decrypted with
 * the same App Lock PIN, it yields a readable archive of the user's history.
 *
 * Everything here is best-effort and defensive — a backup must NEVER crash the
 * app. Media/voice/docs are stored as REFERENCES (storageId/mediaUrl/fileName),
 * not raw bytes (the bytes are E2EE on the server and can be re-downloaded).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import {
  decryptEnvelopeWithPassphraseAsync,
  encryptStringWithPassphraseAsync,
  type EncryptedEnvelope,
} from '../e2eeCrypto';
import { api } from '../../convexApi';

export const CHAT_BACKUP_PREFIX = 'smilers-chat-';
export const CHAT_BACKUP_DIR = `${LegacyFileSystem.documentDirectory || ''}SmilersBackups/`;
const RETAIN = 4; // keep the newest N chat backups
const PAGE_SIZE = 200; // messages fetched per Convex page

export interface ChatBackupIncludeOpts {
  includeMedia?: boolean;
  includeVoice?: boolean;
  includeDocs?: boolean;
}

export interface ChatBackupProgress {
  phase: 'conversations' | 'messages' | 'encrypting' | 'writing' | 'done';
  current: number;
  total: number;
  label?: string;
}

interface ConversationBackup {
  id: string;
  name: string | null;
  type: string | null;
  messages: any[];
  callLogs: any[];
}

interface ChatBackupPayload {
  app: 'Smilers';
  type: 'chat-backup';
  version: 1;
  exportedAt: string;
  conversationCount: number;
  messageCount: number;
  callLogCount: number;
  conversations: ConversationBackup[];
}

function isAudio(m: any): boolean {
  const mt = String(m?.mimeType || '');
  return m?.type === 'voice' || m?.type === 'audio' || mt.startsWith('audio/');
}
function isImageOrVideo(m: any): boolean {
  const mt = String(m?.mimeType || '');
  return mt.startsWith('image/') || mt.startsWith('video/') || m?.type === 'image' || m?.type === 'video';
}
function isDoc(m: any): boolean {
  const mt = String(m?.mimeType || '');
  return (
    m?.type === 'file' ||
    (!!(m?.storageId || m?.fileName) && !isAudio(m) && !isImageOrVideo(m) && !mt.startsWith('image/'))
  );
}

/**
 * Reduce a raw message doc to the fields worth backing up, honouring the
 * "what to include" toggles (text is ALWAYS kept; excluded attachment types
 * have their media reference stripped but the message row is retained so the
 * timeline stays complete).
 */
function slimMessage(m: any, opts: ChatBackupIncludeOpts): any {
  const keepMedia =
    (opts.includeMedia !== false && isImageOrVideo(m)) ||
    (opts.includeVoice !== false && isAudio(m)) ||
    (opts.includeDocs === true && isDoc(m));
  return {
    id: String(m?._id || ''),
    senderId: m?.senderId ?? m?.userId ?? null,
    type: m?.type ?? 'text',
    text: typeof m?.text === 'string' ? m.text : null,
    createdAt: m?._creationTime ?? m?.createdAt ?? null,
    mimeType: m?.mimeType ?? null,
    fileName: m?.fileName ?? null,
    audioDuration: m?.audioDuration ?? null,
    // Only carry the media reference when its type is included.
    storageId: keepMedia ? m?.storageId ?? null : null,
    mediaUrl: keepMedia ? m?.mediaUrl ?? m?.fileUrl ?? m?.url ?? null : null,
    forwarded: !!m?.isForwarded,
  };
}

/** Fetch EVERY message of a conversation by walking the Convex pagination cursor. */
async function fetchAllMessages(convex: any, conversationId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  // Hard safety cap: 200 pages (40k messages) so a runaway never hangs.
  for (let i = 0; i < 200; i += 1) {
    let page: any;
    try {
      page = await convex.query(api.messages.list, {
        conversationId,
        paginationOpts: { numItems: PAGE_SIZE, cursor },
      });
    } catch {
      break;
    }
    const rows = Array.isArray(page?.page) ? page.page : Array.isArray(page) ? page : [];
    out.push(...rows);
    cursor = page?.continueCursor ?? null;
    if (page?.isDone === true || !cursor || rows.length === 0) break;
  }
  return out;
}

/**
 * Build the full backup payload. `onProgress` is called as it walks
 * conversations so the UI can show a live "Backing up N of M" indicator.
 */
export async function buildChatBackupPayload(
  convex: any,
  opts: ChatBackupIncludeOpts,
  onProgress?: (p: ChatBackupProgress) => void,
): Promise<ChatBackupPayload> {
  onProgress?.({ phase: 'conversations', current: 0, total: 0, label: 'Reading conversations…' });
  let conversations: any[] = [];
  try {
    const res = await convex.query(api.conversations.listConversations, {});
    conversations = Array.isArray(res) ? res : [];
  } catch {
    conversations = [];
  }

  const backups: ConversationBackup[] = [];
  let messageCount = 0;
  let callLogCount = 0;
  const total = conversations.length;
  for (let i = 0; i < conversations.length; i += 1) {
    const c = conversations[i];
    const id = String(c?._id || '');
    if (!id) continue;
    onProgress?.({
      phase: 'messages',
      current: i + 1,
      total,
      label: `Backing up chat ${i + 1} of ${total}…`,
    });
    const rawMessages = await fetchAllMessages(convex, id);
    const messages = rawMessages.map((m) => slimMessage(m, opts));
    let callLogs: any[] = [];
    try {
      const logs = await convex.query(api.calls.listCallLogsForConversation, { conversationId: id });
      callLogs = Array.isArray(logs)
        ? logs.map((l: any) => ({
            id: String(l?._id || ''),
            direction: l?.direction ?? null,
            outcome: l?.outcome ?? l?.status ?? null,
            isVideo: !!l?.isVideo,
            durationSeconds: l?.durationSeconds ?? l?.duration ?? null,
            createdAt: l?._creationTime ?? l?.createdAt ?? null,
          }))
        : [];
    } catch {
      callLogs = [];
    }
    messageCount += messages.length;
    callLogCount += callLogs.length;
    backups.push({
      id,
      name: c?.name ?? c?.otherUser?.name ?? c?.otherParticipant?.name ?? null,
      type: c?.type ?? (c?.isGroup ? 'group' : 'direct'),
      messages,
      callLogs,
    });
  }

  return {
    app: 'Smilers',
    type: 'chat-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    conversationCount: backups.length,
    messageCount,
    callLogCount,
    conversations: backups,
  };
}

async function ensureBackupDir(): Promise<boolean> {
  if (!LegacyFileSystem.documentDirectory) return false;
  try {
    const info = await LegacyFileSystem.getInfoAsync(CHAT_BACKUP_DIR);
    if (!info.exists) {
      await LegacyFileSystem.makeDirectoryAsync(CHAT_BACKUP_DIR, { intermediates: true });
    }
    return true;
  } catch {
    return true; // likely already exists
  }
}

async function pruneOldBackups(): Promise<void> {
  try {
    const files = (await LegacyFileSystem.readDirectoryAsync(CHAT_BACKUP_DIR))
      .filter((f) => f.startsWith(CHAT_BACKUP_PREFIX))
      .sort();
    if (files.length > RETAIN) {
      for (const f of files.slice(0, files.length - RETAIN)) {
        try {
          await LegacyFileSystem.deleteAsync(CHAT_BACKUP_DIR + f, { idempotent: true });
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Encrypt the payload with the PIN and write it to the persistent backup dir. */
export async function writeEncryptedChatBackup(
  payload: ChatBackupPayload,
  pin: string,
  auto: boolean,
  onProgress?: (p: ChatBackupProgress) => void,
): Promise<string> {
  onProgress?.({ phase: 'encrypting', current: 0, total: 0, label: 'Encrypting…' });
  const envelope = await encryptStringWithPassphraseAsync(JSON.stringify(payload), pin);
  const fileBody = JSON.stringify({
    app: 'Smilers',
    type: 'chat-backup-encrypted',
    auto,
    note: 'Encrypted with your Smilers App Lock PIN (AES-GCM-256, PBKDF2-SHA256).',
    exportedAt: payload.exportedAt,
    conversationCount: payload.conversationCount,
    messageCount: payload.messageCount,
    callLogCount: payload.callLogCount,
    ...envelope,
  });
  onProgress?.({ phase: 'writing', current: 0, total: 0, label: 'Saving…' });
  await ensureBackupDir();
  const path = `${CHAT_BACKUP_DIR}${CHAT_BACKUP_PREFIX}${Date.now()}.smchat.json`;
  await LegacyFileSystem.writeAsStringAsync(path, fileBody);
  await pruneOldBackups();
  onProgress?.({ phase: 'done', current: 1, total: 1 });
  return path;
}

export interface LocalBackupFile {
  uri: string;
  name: string;
  ts: number;
}

/** All local chat backups, newest first. */
export async function listLocalChatBackups(): Promise<LocalBackupFile[]> {
  try {
    if (!LegacyFileSystem.documentDirectory) return [];
    const info = await LegacyFileSystem.getInfoAsync(CHAT_BACKUP_DIR);
    if (!info.exists) return [];
    const files = (await LegacyFileSystem.readDirectoryAsync(CHAT_BACKUP_DIR)).filter((f) =>
      f.startsWith(CHAT_BACKUP_PREFIX),
    );
    return files
      .map((name) => {
        const m = name.match(/(\d{10,})/);
        const ts = m ? Number(m[1]) : 0;
        return { uri: CHAT_BACKUP_DIR + name, name, ts };
      })
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

export async function getLatestChatBackupUri(): Promise<string | null> {
  const list = await listLocalChatBackups();
  return list.length ? list[0].uri : null;
}

/** Decrypt an encrypted chat backup file with the PIN. Throws on wrong PIN. */
export async function decryptChatBackup(uri: string, pin: string): Promise<ChatBackupPayload> {
  const raw = await LegacyFileSystem.readAsStringAsync(uri);
  let file: any;
  try {
    file = JSON.parse(raw);
  } catch {
    throw new Error('This file is not a valid Smilers backup.');
  }
  if (file?.type !== 'chat-backup-encrypted' || !file?.ciphertext || !file?.salt || !file?.iv) {
    throw new Error('This is not an encrypted Smilers chat backup.');
  }
  const envelope: EncryptedEnvelope = {
    v: file.v || 1,
    alg: file.alg || 'AES-GCM-256',
    kdf: file.kdf || 'PBKDF2-SHA256',
    iterations: Number(file.iterations) || 100000,
    salt: file.salt,
    iv: file.iv,
    ciphertext: file.ciphertext,
  };
  let plaintext: string;
  try {
    plaintext = await decryptEnvelopeWithPassphraseAsync(envelope, pin);
  } catch {
    throw new Error('Wrong PIN, or this backup was made with a different PIN.');
  }
  return JSON.parse(plaintext) as ChatBackupPayload;
}

/** Render a decrypted backup into a readable, shareable plain-text archive. */
export function chatBackupToReadableText(payload: ChatBackupPayload): string {
  const lines: string[] = [
    '# Smilers Chat Backup',
    `Exported: ${new Date(payload.exportedAt).toLocaleString()}`,
    `Conversations: ${payload.conversationCount} · Messages: ${payload.messageCount} · Call logs: ${payload.callLogCount}`,
    '',
  ];
  for (const c of payload.conversations || []) {
    lines.push('', '========================================');
    lines.push(`${c.type === 'group' ? '👥' : '💬'} ${c.name || 'Conversation'}`);
    lines.push('========================================');
    const rows = [...(c.messages || [])].sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    );
    for (const m of rows) {
      const t = m.createdAt ? new Date(m.createdAt).toLocaleString() : '';
      let body = m.text || '';
      if (!body) {
        if (m.type === 'voice' || m.type === 'audio') body = '[voice note]';
        else if (m.mimeType?.startsWith?.('image/')) body = '[photo]';
        else if (m.mimeType?.startsWith?.('video/')) body = '[video]';
        else if (m.fileName) body = `[file: ${m.fileName}]`;
        else body = `[${m.type}]`;
      }
      lines.push(`[${t}] ${body}`);
    }
    for (const l of c.callLogs || []) {
      const t = l.createdAt ? new Date(l.createdAt).toLocaleString() : '';
      const kind = l.isVideo ? 'Video call' : 'Voice call';
      lines.push(`[${t}] ☎ ${kind} · ${l.outcome || l.direction || ''}`);
    }
  }
  return lines.join('\n');
}

// ─── Auto-backup scheduler (opportunistic, runs on app open when due) ────────

type Frequency = 'off' | 'daily' | 'weekly' | 'monthly';
type Network = 'wifi' | 'any';
const FREQ_MS: Record<Frequency, number> = {
  off: Infinity,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

function lastAtKey(userId: string): string {
  return `smilers.chat.autobackup.${userId}.lastAt`;
}

async function isOnAllowedNetwork(network: Network): Promise<boolean> {
  if (network === 'any') return true;
  try {
    const NetInfo = (await import('@react-native-community/netinfo')).default;
    const state = await NetInfo.fetch();
    return state?.type === 'wifi';
  } catch {
    // If we can't tell, don't block the backup.
    return true;
  }
}

export interface AutoBackupSettings {
  autoBackup?: boolean;
  frequency?: Frequency;
  network?: Network;
  includeMedia?: boolean;
  includeVoice?: boolean;
  includeDocs?: boolean;
}

/**
 * Run an automatic chat backup if one is DUE for this user, respecting the
 * frequency + Wi-Fi-only preference. Safe to call on every app foreground /
 * chats-screen focus — no-ops when not due, when auto-backup is off, when no
 * App Lock PIN is set, or when on a disallowed network. Never throws.
 *
 * Returns true if a backup was actually written, so callers can refresh the
 * "last backup" timestamp shown in the UI.
 */
export async function maybeRunAutoChatBackup(
  convex: any,
  userId: string | null | undefined,
  settings: AutoBackupSettings,
  pin: string,
): Promise<boolean> {
  try {
    if (!convex || !userId) return false;
    if (!settings?.autoBackup) return false;
    const freq = (settings.frequency || 'off') as Frequency;
    if (freq === 'off') return false;
    if (!pin) return false; // no key to encrypt with

    const last = Number(await AsyncStorage.getItem(lastAtKey(userId))) || 0;
    if (Date.now() - last < FREQ_MS[freq]) return false; // not due yet

    if (!(await isOnAllowedNetwork((settings.network || 'wifi') as Network))) return false;

    const payload = await buildChatBackupPayload(convex, {
      includeMedia: settings.includeMedia,
      includeVoice: settings.includeVoice,
      includeDocs: settings.includeDocs,
    });
    // Nothing to back up — still stamp so we don't rebuild every open.
    if (payload.conversationCount === 0) {
      await AsyncStorage.setItem(lastAtKey(userId), String(Date.now()));
      return false;
    }
    await writeEncryptedChatBackup(payload, pin, true);
    await AsyncStorage.setItem(lastAtKey(userId), String(Date.now()));
    return true;
  } catch {
    return false; // background maintenance must never surface an error
  }
}

/** Persist the auto-backup timestamp (used after a successful manual backup). */
export async function stampAutoBackupNow(userId: string | null | undefined): Promise<void> {
  try {
    if (!userId) return;
    await AsyncStorage.setItem(lastAtKey(userId), String(Date.now()));
  } catch {
    /* ignore */
  }
}
