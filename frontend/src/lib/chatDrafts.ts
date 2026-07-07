/**
 * chatDrafts — per-conversation composer draft persistence.
 *
 * Saves whatever the user has started (typed text, staged photos/files not yet
 * sent, the message they're replying to, an in-progress edit, and text
 * formatting) so that leaving the conversation — to another chat or out of the
 * app entirely — never loses their work. When they return to that conversation
 * the composer is rehydrated exactly where they left off.
 *
 * Storage is a small JSON blob per conversation in AsyncStorage. Draft photo
 * URIs point at the OS image-picker cache; if the OS has since evicted a cached
 * file the send simply fails gracefully (same as any stale pick), so we never
 * block on it — the intent (plan 3a) is "remember the selection and send on
 * resume", not "resume a mid-flight byte transfer".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readStoredJson, writeStoredJson } from './settingsStorage';

export interface PendingImageDraft {
  uri: string;
  mimeType: string;
  caption: string;
}

export interface ChatDraft {
  text?: string;
  replyTo?: any | null;
  pendingImages?: PendingImageDraft[];
  editingMessageId?: string | null;
  draftBold?: boolean;
  draftColor?: string | null;
  updatedAt?: number;
}

const keyFor = (conversationId: string) => `smilers:chat_draft:v1:${conversationId}`;

export function isChatDraftEmpty(draft: ChatDraft | null | undefined): boolean {
  if (!draft) return true;
  const hasText = !!(draft.text && draft.text.trim().length > 0);
  const hasImages = Array.isArray(draft.pendingImages) && draft.pendingImages.length > 0;
  const hasReply = !!draft.replyTo;
  const hasEdit = !!draft.editingMessageId;
  return !hasText && !hasImages && !hasReply && !hasEdit;
}

export async function loadChatDraft(conversationId: string): Promise<ChatDraft | null> {
  if (!conversationId) return null;
  try {
    const draft = await readStoredJson(keyFor(conversationId), null);
    return draft && typeof draft === 'object' ? (draft as ChatDraft) : null;
  } catch {
    return null;
  }
}

export async function saveChatDraft(conversationId: string, draft: ChatDraft): Promise<void> {
  if (!conversationId) return;
  // Never leave an empty shell behind — clear instead so the chat list / next
  // open doesn't think there's a draft when there isn't.
  if (isChatDraftEmpty(draft)) {
    await clearChatDraft(conversationId);
    return;
  }
  try {
    await writeStoredJson(keyFor(conversationId), { ...draft, updatedAt: Date.now() });
  } catch {
    /* best-effort */
  }
}

export async function clearChatDraft(conversationId: string): Promise<void> {
  if (!conversationId) return;
  try {
    await AsyncStorage.removeItem(keyFor(conversationId));
  } catch {
    /* best-effort */
  }
}

export interface DraftPreview {
  text?: string;
  hasImages?: boolean;
}

/**
 * Read every stored conversation draft in one pass and return a map of
 * { conversationId: { text, hasImages } } for the Chats-list "Draft:" preview.
 * Only non-empty drafts are included.
 */
export async function loadAllChatDrafts(): Promise<Record<string, DraftPreview>> {
  const out: Record<string, DraftPreview> = {};
  try {
    const prefix = 'smilers:chat_draft:v1:';
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
    if (keys.length === 0) return out;
    const pairs = await AsyncStorage.multiGet(keys);
    for (const [key, raw] of pairs) {
      if (!raw) continue;
      let draft: ChatDraft | null = null;
      try {
        draft = JSON.parse(raw) as ChatDraft;
      } catch {
        continue;
      }
      if (!draft || isChatDraftEmpty(draft)) continue;
      const conversationId = key.slice(prefix.length);
      out[conversationId] = {
        text: typeof draft.text === 'string' ? draft.text.trim() : '',
        hasImages: Array.isArray(draft.pendingImages) && draft.pendingImages.length > 0,
      };
    }
  } catch {
    /* best-effort */
  }
  return out;
}
