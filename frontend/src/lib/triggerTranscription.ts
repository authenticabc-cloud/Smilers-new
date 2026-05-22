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

const TRANSCRIBE_ENDPOINT = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}/api/transcribe`;

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
): Promise<void> {
  try {
    await convex.mutation((api as any).messages.setTranscription, {
      messageId,
      transcriptionStatus: 'pending',
    });
  } catch {
    // Backend may not have shipped the mutation yet — silent fallback.
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
  const { convex, messageId, languageHint } = args;
  if (!messageId) return;
  if (!TRANSCRIBE_ENDPOINT.startsWith('http')) {
    // Backend URL not configured — nothing we can do.
    return;
  }

  await markPending(convex, messageId);

  // Up to 4 short attempts (every 700ms) to resolve the URL — Convex storage
  // returns a signed URL once indexing finishes.
  let mediaUrl: string | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    mediaUrl = await resolveMediaUrl(convex, args);
    if (mediaUrl) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  if (!mediaUrl) {
    await failPatch(convex, messageId, 'Could not resolve media URL');
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
      await failPatch(convex, messageId, 'Empty transcription from Whisper');
      return;
    }
    try {
      await convex.mutation((api as any).messages.setTranscription, {
        messageId,
        transcription,
        transcriptionLanguage: language,
        transcriptionStatus: 'ready',
      });
    } catch {
      // Older backends may not accept `setTranscription` — try a generic
      // patch fallback if exposed, otherwise give up silently.
      try {
        await convex.mutation((api as any).messages.patch, {
          messageId,
          transcription,
          transcriptionLanguage: language,
          transcriptionStatus: 'ready',
        });
      } catch {
        /* swallow */
      }
    }
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[transcribe] failed:', errorValue?.message || errorValue);
    await failPatch(convex, messageId, errorValue?.message || 'Unknown error');
  }
}

async function failPatch(
  convex: ConvexReactClient,
  messageId: string,
  detail: string,
): Promise<void> {
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
