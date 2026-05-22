/**
 * Triggers the OpenAI Whisper backend after a voice / video message has been
 * sent. We:
 *   1. Wait until the message's `mediaUrl` is resolvable (Convex auto-resolves
 *      `storageId` → URL within a few hundred ms of the message being created).
 *   2. POST the URL to our backend `/api/transcribe` endpoint.
 *   3. Patch the original message with `transcription` + `transcriptionLanguage`
 *      via Convex mutation `messages.setTranscription`.
 *
 * Every step is wrapped to degrade gracefully — a transcription failure must
 * never block message delivery or crash the chat screen.
 */

import { ConvexReactClient } from 'convex/react';
import { api } from '../convexApi';
import { readStoredJson, writeStoredJson } from './settingsStorage';

const TRANSCRIBE_ENDPOINT = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}/api/transcribe`;

/** SecureStore (native) / localStorage (web) cache key prefix for
 *  transcription results. Keyed by storageId so the cache hits regardless
 *  of whether Convex's sendMessage returned the new message id or not. */
const TRANSCRIPT_CACHE_PREFIX = 'smilers_transcript_';

export interface CachedTranscription {
  text: string;
  language: string;
  status: 'pending' | 'ready' | 'error';
  error?: string;
}

export async function getCachedTranscription(
  storageId: string,
): Promise<CachedTranscription | null> {
  if (!storageId) return null;
  try {
    const value = (await readStoredJson(
      `${TRANSCRIPT_CACHE_PREFIX}${storageId}`,
      null,
    )) as CachedTranscription | null;
    if (value && typeof value === 'object' && typeof value.status === 'string') {
      return value;
    }
  } catch {
    // bad cache row; ignore
  }
  return null;
}

async function setCachedTranscription(
  storageId: string | null | undefined,
  value: CachedTranscription,
): Promise<void> {
  if (!storageId) return;
  try {
    await writeStoredJson(`${TRANSCRIPT_CACHE_PREFIX}${storageId}`, value);
  } catch {
    /* swallow */
  }
}

interface TriggerArgs {
  convex: ConvexReactClient;
  messageId: string;
  mediaUrl?: string | null;
  storageId?: string | null;
  conversationId?: string | null;
  // Optional ISO-639-1 hint sent to Whisper (improves accuracy if known).
  languageHint?: string | null;
}

/** Marks the message as `transcriptionStatus: 'pending'` immediately so the
 *  bubble shows the "Transcribing…" spinner while Whisper runs. */
async function markPending(
  convex: ConvexReactClient,
  messageId: string,
  storageId: string | null | undefined,
): Promise<void> {
  await setCachedTranscription(storageId, { text: '', language: '', status: 'pending' });
  try {
    await convex.mutation((api as any).messages.setTranscription, {
      messageId,
      transcriptionStatus: 'pending',
    });
  } catch {
    // Backend may not have shipped the mutation yet — local cache still
    // drives the bubble UI so the user sees the spinner immediately.
  }
}

async function resolveMediaUrl(
  convex: ConvexReactClient,
  args: TriggerArgs,
): Promise<string | null> {
  if (args.mediaUrl && /^https?:\/\//i.test(args.mediaUrl)) return args.mediaUrl;
  if (!args.storageId) return null;
  // Try Convex's storage.getUrl with the storageId — most Smilers backends
  // expose this as either `api.messages.getStorageUrl` or `api.storage.getUrl`.
  for (const ref of [
    (api as any).messages?.getStorageUrl,
    (api as any).storage?.getUrl,
  ]) {
    if (!ref) continue;
    try {
      const url = (await convex.query(ref, { storageId: args.storageId })) as
        | string
        | null;
      if (typeof url === 'string' && url.length > 0) return url;
    } catch {
      // try next variant
    }
  }
  return null;
}

export async function triggerTranscription(args: TriggerArgs): Promise<void> {
  const { convex, messageId, languageHint, storageId } = args;
  // Even if Convex's sendMessage didn't return a messageId, we still want to
  // run Whisper and cache the result locally so the UI can show the pill.
  if (!TRANSCRIBE_ENDPOINT.startsWith('http')) {
    // Backend URL not configured — nothing we can do.
    return;
  }

  if (messageId) {
    await markPending(convex, messageId, storageId);
  } else {
    await setCachedTranscription(storageId, { text: '', language: '', status: 'pending' });
  }

  // Up to 4 short attempts (every 700ms) to resolve the URL — Convex storage
  // returns a signed URL once indexing finishes.
  let mediaUrl: string | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    mediaUrl = await resolveMediaUrl(convex, args);
    if (mediaUrl) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  if (!mediaUrl) {
    await failPatch(convex, messageId, 'Could not resolve media URL', storageId);
    return;
  }

  try {
    const response = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_url: mediaUrl,
        language_hint: languageHint || undefined,
      }),
    });
    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`);
    }
    const payload = (await response.json()) as {
      text?: string;
      language?: string;
    };
    const transcription = (payload?.text || '').trim();
    const language = payload?.language || 'unknown';
    if (!transcription) {
      await failPatch(convex, messageId, 'Empty transcription from Whisper', storageId);
      return;
    }
    // ALWAYS write to local cache first — guarantees the pill renders on this
    // device even if the Convex mutation doesn't exist yet.
    await setCachedTranscription(storageId, {
      text: transcription,
      language,
      status: 'ready',
    });
    if (messageId) {
      try {
        await convex.mutation((api as any).messages.setTranscription, {
          messageId,
          transcription,
          transcriptionLanguage: language,
          transcriptionStatus: 'ready',
        });
      } catch {
        // Older backends may not accept `setTranscription` — try a generic
        // patch fallback if exposed, otherwise rely on the local cache.
        try {
          await convex.mutation((api as any).messages.patch, {
            messageId,
            transcription,
            transcriptionLanguage: language,
            transcriptionStatus: 'ready',
          });
        } catch {
          /* swallow — local cache still drives the UI */
        }
      }
    }
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[transcribe] failed:', errorValue?.message || errorValue);
    await failPatch(convex, messageId, errorValue?.message || 'Unknown error', storageId);
  }
}

async function failPatch(
  convex: ConvexReactClient,
  messageId: string,
  detail: string,
  storageId?: string | null,
): Promise<void> {
  await setCachedTranscription(storageId, { text: '', language: '', status: 'error', error: detail });
  if (!messageId) return;
  try {
    await convex.mutation((api as any).messages.setTranscription, {
      messageId,
      transcriptionStatus: 'error',
      transcriptionError: detail,
    });
  } catch {
    /* swallow */
  }
}
