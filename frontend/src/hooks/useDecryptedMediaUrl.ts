/**
 * E2EE media decryption pipeline for chat bubbles.
 *
 * When a message has `encrypted: true`, its `mediaUrl` does NOT point at the
 * plain media file — it points at the AES-GCM ciphertext bytes that were
 * uploaded to Convex storage. To render/play that media we must:
 *
 *   1. Download the encrypted bytes (as ArrayBuffer) over HTTPS.
 *   2. Decrypt them with `decryptBytes(bytes, iv, passphrase, salt)` using the
 *      conversation's E2EE key material.
 *   3. Materialize the plaintext bytes into a URI the React Native renderers
 *      can consume:
 *        - For images we use a `data:` URI (works directly with <Image>).
 *        - For audio/file we write the bytes to a local cache file and return
 *          its `file://` URI so expo-av can stream it.
 *
 * Plain (non-encrypted) messages still take the synchronous path through
 * `getMessageMediaUrl(msg)` for free.
 */

import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { File, Directory, Paths } from 'expo-file-system';
// Legacy module still exposes `createDownloadResumable` with byte-level progress
// callbacks (the new File API has no progress hook).
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { decryptBytes } from '../lib/e2eeCrypto';
import { getMessageMediaUrl } from './useResolvedStorageUrl';
import type { E2EEStatus } from './useConversationE2EE';

export interface DecryptedMediaResult {
  url: string | null;
  loading: boolean;
  error: string | null;
  /** True when decryption is intentionally deferred (large file) and hasn't
   *  been triggered yet — the UI should show a "tap to open" affordance. */
  deferred?: boolean;
  /** Kicks off deferred decryption (no-op if already armed/decrypted). */
  decrypt?: () => void;
  /** Byte-level download progress while fetching a large encrypted blob. */
  progress?: { received: number; total: number } | null;
}

// Files at/above this size are NOT auto-decrypted on render — decrypting a big
// blob with pure-JS AES-GCM blocks the JS thread for seconds and can OOM (the
// 13 MB document bug + chat-list freezes). They decrypt lazily on first open.
const LAZY_DECRYPT_MIN_BYTES = 3 * 1024 * 1024; // 3 MB

// Process-wide cache so the same encrypted message isn't fetched + decrypted
// twice during a chat session (e.g. when the list re-renders).
const decryptedCache = new Map<string, string>();

function inferImageMime(msg: any): string {
  if (typeof msg?.mimeType === 'string' && msg.mimeType.length > 0) return msg.mimeType;
  return 'image/jpeg';
}

function inferExtension(msg: any, fallback: string): string {
  // Prefer the explicit fileName extension, then mimeType, then a sensible
  // default per media type. expo-av cares about audio extensions on Android.
  const fileName: string = typeof msg?.fileName === 'string' ? msg.fileName : '';
  const fromName = fileName.includes('.') ? fileName.split('.').pop() : '';
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  const mime: string = typeof msg?.mimeType === 'string' ? msg.mimeType : '';
  if (mime) {
    if (mime.includes('mp4')) return 'm4a';
    if (mime.includes('mpeg')) return 'mp3';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('aac')) return 'aac';
    if (mime.includes('png')) return 'png';
    if (mime.includes('jpeg')) return 'jpg';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('pdf')) return 'pdf';
  }
  return fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  // Fallback for very old environments
  // eslint-disable-next-line no-undef
  return (global as any).Buffer
    ? (global as any).Buffer.from(binary, 'binary').toString('base64')
    : '';
}

async function fetchEncryptedBytes(
  url: string,
  onProgress?: (received: number, total: number) => void
): Promise<Uint8Array> {
  // NATIVE (iter-410): stream the ciphertext straight to disk and read it back
  // with the native `bytes()` reader. React Native's `fetch(...).arrayBuffer()`
  // routes large bodies through a blob→base64→decode path that roughly TRIPLES
  // peak memory, which OOMs / throws on big files (the user's 13 MB document
  // failed here while small files worked). Streaming to disk keeps peak memory
  // at ~1x and skips base64 entirely.
  if (Platform.OS !== 'web') {
    let outUri: string | null = null;
    try {
      const dir = new Directory(Paths.cache, 'smilers-e2ee-dl');
      try {
        dir.create({ intermediates: true, idempotent: true });
      } catch {
        // directory already exists
      }

      const legacy: any = LegacyFileSystem;
      const cacheBase: string | undefined = legacy?.cacheDirectory;
      // Preferred: resumable download exposes byte-level progress (iter-411).
      if (cacheBase && typeof legacy.createDownloadResumable === 'function') {
        const destUri = `${cacheBase}smilers-e2ee-dl/dl_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}.bin`;
        const task = legacy.createDownloadResumable(
          url,
          destUri,
          {},
          (p: any) => {
            if (!onProgress) return;
            const total = Number(p?.totalBytesExpectedToWrite) || 0;
            const received = Number(p?.totalBytesWritten) || 0;
            onProgress(received, total);
          }
        );
        const res = await task.downloadAsync();
        outUri = res?.uri || destUri;
      } else {
        // Fallback stream (no progress).
        const temp = await File.downloadFileAsync(url, dir);
        outUri = temp.uri;
      }

      const f = new File(outUri);
      const bytes = await f.bytes();
      try {
        f.delete();
      } catch {
        // best-effort cleanup
      }
      return bytes;
    } catch (e: any) {
      // Any FS/download error → fall back to the fetch path below so behaviour
      // never regresses vs. the previous implementation.
      console.warn(
        '[useDecryptedMediaUrl] stream-to-disk download failed, falling back to fetch:',
        e?.message || e
      );
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download encrypted media (HTTP ${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function writeDecryptedToCache(
  bytes: Uint8Array,
  cacheKey: string,
  extension: string
): string {
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  const safeKey = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = new File(Paths.cache, 'smilers-e2ee', `${safeKey}.${safeExt}`);
  try {
    // Ensure the directory exists; idempotent across calls.
    file.parentDirectory.create({ intermediates: true, idempotent: true });
  } catch {
    // ignore, directory likely already exists
  }
  try {
    file.create({ overwrite: true });
  } catch {
    // ignore: file may already exist — write() will overwrite content anyway
  }
  file.writeBytes(bytes);
  return file.uri;
}

// Persistent decrypted-file cache size cap. Large files can pile up on disk;
// keep total under CACHE_CAP_BYTES, evicting the OLDEST files down to
// CACHE_TARGET_BYTES (headroom) when exceeded.
const CACHE_CAP_BYTES = 200 * 1024 * 1024; // 200 MB
const CACHE_TARGET_BYTES = 150 * 1024 * 1024; // evict down to 150 MB
let lastPruneAt = 0;

/**
 * Best-effort LRU eviction of the on-disk decrypted cache so large-file
 * caching never bloats device storage. Throttled to run at most every 5 min.
 */
export async function pruneDecryptedCache(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastPruneAt < 5 * 60 * 1000) return;
  lastPruneAt = now;
  try {
    const dir = new Directory(Paths.cache, 'smilers-e2ee');
    if (!dir.exists) return;
    const files = dir
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => ({ f, size: f.size ?? 0, mtime: f.modificationTime ?? 0 }));
    let total = files.reduce((sum, x) => sum + x.size, 0);
    if (total <= CACHE_CAP_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime); // oldest first
    const deletedUris: string[] = [];
    for (const item of files) {
      if (total <= CACHE_TARGET_BYTES) break;
      try {
        deletedUris.push(item.f.uri);
        item.f.delete();
        total -= item.size;
      } catch {
        // skip files we can't delete
      }
    }
    // Drop any in-memory entries that pointed at evicted files so they get
    // re-materialized on next open instead of returning a dead URI.
    if (deletedUris.length) {
      for (const [key, value] of decryptedCache) {
        if (deletedUris.includes(value)) decryptedCache.delete(key);
      }
    }
  } catch {
    // best-effort — never throw from cache maintenance
  }
}
// Returns the URI of a previously-decrypted cache file if it still exists on
// disk (survives app restarts / in-memory cache clears), so re-opening a large
// file is instant — no re-download, no re-decrypt. Uses the same deterministic
// path scheme as writeDecryptedToCache.
function existingDecryptedCacheUri(cacheKey: string, extension: string): string | null {
  try {
    const safeExt = extension.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = new File(Paths.cache, 'smilers-e2ee', `${safeKey}.${safeExt}`);
    if (file.exists && (file.size ?? 0) > 0) return file.uri;
  } catch {
    // treat any FS error as "no cache"
  }
  return null;
}

/**
 * Returns a renderable URL for a chat message, transparently handling E2EE
 * decryption when `msg.encrypted === true`. Non-encrypted messages return
 * synchronously without any extra network round-trip.
 */
export function useDecryptedMediaUrl(msg: any, e2ee: E2EEStatus | null | undefined): DecryptedMediaResult {
  const isEncrypted = !!(msg && msg.encrypted === true);
  const rawUrl = getMessageMediaUrl(msg);
  const messageId: string | undefined = msg?._id;
  const iv: string | undefined = msg?.iv;
  const type: string = msg?.type || 'file';
  const passphrase = e2ee?.passphrase || null;
  const salt = e2ee?.salt || null;

  // Large documents/videos defer decryption until the user opens them.
  const fileSize: number = typeof msg?.fileSize === 'number' ? msg.fileSize : 0;
  const isLazy =
    isEncrypted &&
    (type === 'file' || type === 'video') &&
    fileSize >= LAZY_DECRYPT_MIN_BYTES;

  const initialUrl = !isEncrypted
    ? rawUrl
    : messageId && decryptedCache.has(messageId)
      ? decryptedCache.get(messageId)!
      : null;

  const [url, setUrl] = useState<string | null>(initialUrl);
  const [loading, setLoading] = useState<boolean>(isEncrypted && !initialUrl && !isLazy);
  const [error, setError] = useState<string | null>(null);
  // For lazy files: only decrypt once the user has armed it (tapped open).
  const [armed, setArmed] = useState<boolean>(!isLazy);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const cancelledRef = useRef(false);
  const lastPctRef = useRef(0);

  useEffect(() => {
    cancelledRef.current = false;

    // Plain message: just track raw URL synchronously.
    if (!isEncrypted) {
      setUrl(rawUrl);
      setLoading(false);
      setError(null);
      return () => {
        cancelledRef.current = true;
      };
    }

    // Encrypted but we already decrypted in this process — reuse it.
    if (messageId && decryptedCache.has(messageId)) {
      setUrl(decryptedCache.get(messageId)!);
      setLoading(false);
      setError(null);
      return () => {
        cancelledRef.current = true;
      };
    }

    // Persistent disk cache: a prior decrypt of this message may still be on
    // disk (images use data URIs so they're skipped). Reusing it makes
    // re-opening instant — no re-download, no re-decrypt — even for lazy files.
    if (messageId && type !== 'image') {
      const ext = inferExtension(msg, type === 'voice' || type === 'audio' ? 'm4a' : 'bin');
      const cachedUri = existingDecryptedCacheUri(messageId, ext);
      if (cachedUri) {
        decryptedCache.set(messageId, cachedUri);
        setUrl(cachedUri);
        setLoading(false);
        setError(null);
        return () => {
          cancelledRef.current = true;
        };
      }
    }

    // Large file whose decryption hasn't been triggered yet — stay idle so the
    // chat list never blocks/OOMs decrypting a big blob on render.
    if (isLazy && !armed) {
      setUrl(null);
      setLoading(false);
      setError(null);
      return () => {
        cancelledRef.current = true;
      };
    }

    // Encrypted, but we don't yet have the key material from the conversation.
    if (!rawUrl || !iv || !passphrase || !salt) {
      setUrl(null);
      setLoading(!!rawUrl); // still loading if we have a URL but no key yet
      setError(null);
      return () => {
        cancelledRef.current = true;
      };
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        lastPctRef.current = 0;
        const ciphertext = await fetchEncryptedBytes(rawUrl, (received, total) => {
          if (cancelledRef.current) return;
          // Throttle re-renders: only update when progress advances ≥2% (or on
          // the final byte) to keep the chat list smooth.
          const pct = total > 0 ? received / total : 0;
          if (pct - lastPctRef.current >= 0.02 || (total > 0 && received >= total)) {
            lastPctRef.current = pct;
            setProgress({ received, total });
          }
        });
        if (cancelledRef.current) return;
        setProgress(null);
        const plaintext = decryptBytes(ciphertext, iv, passphrase, salt);
        if (cancelledRef.current) return;

        let materializedUrl: string;
        if (type === 'image') {
          // Images render fine from data URIs in React Native + Web.
          const mime = inferImageMime(msg);
          materializedUrl = `data:${mime};base64,${bytesToBase64(plaintext)}`;
        } else {
          // Audio / voice / file / video: write to cache file and return file:// URI.
          const ext = inferExtension(msg, type === 'voice' || type === 'audio' ? 'm4a' : 'bin');
          materializedUrl = writeDecryptedToCache(
            plaintext,
            messageId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ext
          );
        }

        if (cancelledRef.current) return;
        if (messageId) decryptedCache.set(messageId, materializedUrl);
        setUrl(materializedUrl);
        setLoading(false);
        // Opportunistically keep the on-disk cache under its size cap (throttled
        // internally). Only meaningful for the file-backed (non-image) path.
        if (type !== 'image') void pruneDecryptedCache();
      } catch (errorValue: any) {
        if (cancelledRef.current) return;
        // eslint-disable-next-line no-console
        console.warn('[useDecryptedMediaUrl] decryption failed:', errorValue?.message || errorValue);
        setError(errorValue?.message || 'Decryption failed');
        setLoading(false);
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEncrypted, rawUrl, iv, passphrase, salt, messageId, type, armed, isLazy]);

  const decrypt = () => setArmed(true);
  return { url, loading, error, deferred: isLazy && !url, decrypt, progress };
}

/** Clear all on-disk decrypted media cache entries. Best-effort. */
export function clearDecryptedMediaCache(): void {
  decryptedCache.clear();
}
