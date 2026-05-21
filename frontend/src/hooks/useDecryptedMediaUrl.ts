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
import { File, Paths } from 'expo-file-system';
import { decryptBytes } from '../lib/e2eeCrypto';
import { getMessageMediaUrl } from './useResolvedStorageUrl';
import type { E2EEStatus } from './useConversationE2EE';

export interface DecryptedMediaResult {
  url: string | null;
  loading: boolean;
  error: string | null;
}

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

async function fetchEncryptedBytes(url: string): Promise<Uint8Array> {
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

  const initialUrl = !isEncrypted
    ? rawUrl
    : messageId && decryptedCache.has(messageId)
      ? decryptedCache.get(messageId)!
      : null;

  const [url, setUrl] = useState<string | null>(initialUrl);
  const [loading, setLoading] = useState<boolean>(isEncrypted && !initialUrl);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

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
        const ciphertext = await fetchEncryptedBytes(rawUrl);
        if (cancelledRef.current) return;
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
  }, [isEncrypted, rawUrl, iv, passphrase, salt, messageId, type]);

  return { url, loading, error };
}

/** Clear all on-disk decrypted media cache entries. Best-effort. */
export function clearDecryptedMediaCache(): void {
  decryptedCache.clear();
}
