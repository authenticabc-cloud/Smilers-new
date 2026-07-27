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
import { readStoredJson, writeStoredJson, removeStoredValue } from './settingsStorage';
import { fetchWithRetryAfter } from './fetchWithRetryAfter';

const TRANSCRIBE_ENDPOINT = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}/api/transcribe`;
const TRANSCRIBE_UPLOAD_ENDPOINT = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}/api/transcribe/upload`;

/** SecureStore (native) / localStorage (web) cache key prefix for
 *  transcription results. Keyed by storageId so the cache hits regardless
 *  of whether Convex's sendMessage returned the new message id or not. */
const TRANSCRIPT_CACHE_PREFIX = 'smilers_transcript_';

/** Persisted index of the arg-shape that `messages.setTranscription` last
 *  accepted. Convex arg validators reject unknown fields with a SERVER-SIDE
 *  error that shows up in the backend logs. The brute-force retry loop below
 *  discovers the accepted shape, but if we re-discover on EVERY voice message
 *  we spam the Convex logs with validation errors. Caching the working index
 *  collapses that to (at most) a one-time discovery per device. */
const SET_TRANSCRIPTION_SHAPE_KEY = 'smilers_settranscription_shape_idx';
let cachedSetTranscriptionShapeIdx: number | null = null;

async function loadSetTranscriptionShapeIdx(): Promise<number | null> {
  if (cachedSetTranscriptionShapeIdx !== null) return cachedSetTranscriptionShapeIdx;
  try {
    const value = (await readStoredJson(SET_TRANSCRIPTION_SHAPE_KEY, null)) as number | null;
    if (typeof value === 'number' && value >= 0) {
      cachedSetTranscriptionShapeIdx = value;
      return value;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function saveSetTranscriptionShapeIdx(idx: number): Promise<void> {
  if (cachedSetTranscriptionShapeIdx === idx) return;
  cachedSetTranscriptionShapeIdx = idx;
  try {
    await writeStoredJson(SET_TRANSCRIPTION_SHAPE_KEY, idx);
  } catch {
    /* ignore */
  }
}

export interface TranscriptionSegment {
  start: number; // seconds
  end: number;   // seconds
  text: string;
}

export interface CachedTranscription {
  text: string;
  language: string;
  status: 'pending' | 'ready' | 'error';
  error?: string;
  segments?: TranscriptionSegment[];
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

/**
 * Remove any locally-cached transcript for a message's audio.
 *
 * Used to honour the sender's "hide transcript" privacy toggle on the
 * RECIPIENT side: when the sender hides a voice note's transcript the backend
 * strips it from the recipient's read, but the recipient's phone may have
 * ALREADY transcribed the audio on-device and cached it here — so we must
 * purge that local copy too, otherwise the text would still be visible.
 */
export async function clearCachedTranscription(
  storageId: string | null | undefined,
): Promise<void> {
  if (!storageId) return;
  try {
    await removeStoredValue(`${TRANSCRIPT_CACHE_PREFIX}${storageId}`);
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
  /** Local file URI (file://...) of the PLAINTEXT audio/video BEFORE upload
   *  + encryption. When provided we POST it directly to /api/transcribe/upload
   *  so Whisper sees the actual media instead of the AES-GCM ciphertext that
   *  E2EE-encrypted messages have at their `mediaUrl`. */
  localFileUri?: string | null;
  /** Filename hint (e.g. 'voice-1234.m4a') used by the multipart endpoint to
   *  infer the codec extension. Defaults to .m4a for voice notes. */
  fileName?: string | null;
  /** Optional ISO-639-1 hint sent to Whisper to improve accuracy. */
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
  const { convex, messageId, languageHint, storageId, localFileUri, fileName } = args;
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

  let transcription = '';
  let language = 'unknown';
  let segments: TranscriptionSegment[] | undefined = undefined;
  try {
    if (localFileUri && /^file:\/\//i.test(localFileUri)) {
      // Multipart upload path — used for E2EE-encrypted messages because the
      // remote `mediaUrl` would be AES-GCM ciphertext that Whisper can't read.
      const inferredName = fileName || extractFileName(localFileUri) || 'voice.m4a';
      const mime = mimeFromName(inferredName);
      const form = new FormData();
      // React Native FormData expects the file object shape: { uri, name, type }.
      // Cast to `any` because RN's FormData type signature differs from web.
      form.append('file', { uri: localFileUri, name: inferredName, type: mime } as any);
      if (languageHint) form.append('language_hint', languageHint);

      const response = await fetchWithRetryAfter(TRANSCRIBE_UPLOAD_ENDPOINT, {
        method: 'POST',
        body: form as any,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Backend returned ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
      }
      const payload = (await response.json()) as {
        text?: string;
        language?: string;
        segments?: TranscriptionSegment[];
      };
      transcription = (payload?.text || '').trim();
      language = payload?.language || 'unknown';
      segments = Array.isArray(payload?.segments) ? payload.segments : undefined;
    } else {
      // URL fetch path — works for plaintext (non-E2EE) Convex-stored media.
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
      const response = await fetchWithRetryAfter(TRANSCRIBE_ENDPOINT, {
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
        segments?: TranscriptionSegment[];
      };
      transcription = (payload?.text || '').trim();
      language = payload?.language || 'unknown';
      segments = Array.isArray(payload?.segments) ? payload.segments : undefined;
    }

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
      segments,
    });
    if (messageId) {
      // Convex arg validators REJECT unknown/extra fields — so if the web
      // backend's `setTranscription` doesn't define `transcriptionSegments`
      // (or `transcriptionLanguage`), the FULL payload throws and NOTHING is
      // persisted. The sender still sees the transcript (local cache) but the
      // recipient never does. Retry with progressively smaller arg shapes so
      // the transcript actually lands on the Convex message for the recipient.
      const attempts: Array<Record<string, any>> = [
        {
          messageId,
          transcription,
          transcriptionLanguage: language,
          transcriptionStatus: 'ready',
          transcriptionSegments: segments,
        },
        {
          messageId,
          transcription,
          transcriptionLanguage: language,
          transcriptionStatus: 'ready',
        },
        { messageId, transcription, transcriptionStatus: 'ready' },
        { messageId, transcription },
      ];
      let persisted = false;
      // Start from the previously-discovered working shape (if any) so we
      // don't re-trigger Convex arg-validation errors — which are logged
      // SERVER-SIDE — on every single voice message. Fall back to brute-force
      // discovery (and persist the winner) only when no cache exists or the
      // cached shape stops working (e.g. backend schema changed).
      const cachedIdx = await loadSetTranscriptionShapeIdx();
      const order =
        cachedIdx !== null && cachedIdx < attempts.length
          ? [cachedIdx, ...attempts.map((_, i) => i).filter((i) => i !== cachedIdx)]
          : attempts.map((_, i) => i);
      for (const idx of order) {
        try {
          await convex.mutation((api as any).messages.setTranscription, attempts[idx]);
          persisted = true;
          await saveSetTranscriptionShapeIdx(idx);
          break;
        } catch {
          // try the next, smaller arg set
        }
      }
      if (!persisted) {
        // eslint-disable-next-line no-console
        console.warn(
          '[transcribe] setTranscription rejected every arg shape — recipient will not see the transcript (local cache only).',
        );
      }
    }
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[transcribe] failed:', errorValue?.message || errorValue);
    await failPatch(convex, messageId, errorValue?.message || 'Unknown error', storageId);
  }
}

function extractFileName(uri: string): string {
  const trimmed = uri.split('?')[0];
  const segments = trimmed.split('/');
  const last = segments[segments.length - 1] || '';
  return last.includes('.') ? last : '';
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  return 'application/octet-stream';
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
