/**
 * E2EE decryption for Smilers mobile, matching the web app's
 * `src/lib/e2ee-crypto.ts` byte-for-byte:
 *   - Algorithm: AES-GCM-256
 *   - Key derivation: PBKDF2-SHA-256, 100,000 iterations
 *   - IV: 12 bytes (96-bit), base64 encoded
 *   - Salt: base64 encoded, per-conversation
 *
 * Implemented with `@noble/ciphers` + `@noble/hashes` so we don't need any
 * native modules — works inside Expo SDK 54 / React Native + the web preview.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const PBKDF2_ITERATIONS = 100_000;
const KEY_LEN = 32; // 256 bits

function base64ToBytes(base64: string): Uint8Array {
  // React Native / Hermes ships a global `atob` in modern Expo SDKs.
  // Falling back to a small loop avoids any platform quirks.
  let binary: string;
  if (typeof atob === 'function') {
    binary = atob(base64);
  } else {
    // eslint-disable-next-line no-undef
    binary = (global as any).Buffer
      ? (global as any).Buffer.from(base64, 'base64').toString('binary')
      : '';
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  // Fallback: assemble char codes (safe for short messages)
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  try {
    return decodeURIComponent(escape(str));
  } catch {
    return str;
  }
}

const keyCache = new Map<string, Uint8Array>();

function cacheKey(passphrase: string, saltB64: string): string {
  // Passphrase contents are sensitive; use a SHA-256 fingerprint as the
  // map key so we never keep the raw passphrase in memory as a Map key.
  const tag = sha256(new TextEncoder().encode(`${passphrase}|${saltB64}`));
  let hex = '';
  for (let i = 0; i < tag.length; i++) {
    hex += tag[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function deriveKey(passphrase: string, saltB64: string): Uint8Array {
  const ck = cacheKey(passphrase, saltB64);
  const cached = keyCache.get(ck);
  if (cached) return cached;
  const salt = base64ToBytes(saltB64);
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const derived = pbkdf2(sha256, passphraseBytes, salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: KEY_LEN,
  });
  keyCache.set(ck, derived);
  return derived;
}

/**
 * Decrypt a base64 ciphertext + iv pair into a UTF-8 string.
 * Mirrors the web app's `decryptText`.
 */
export function decryptText(
  ciphertextBase64: string,
  ivBase64: string,
  passphrase: string,
  saltBase64: string
): string {
  const key = deriveKey(passphrase, saltBase64);
  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);
  const plain = gcm(key, iv).decrypt(ciphertext);
  return bytesToUtf8(plain);
}

/**
 * Decrypt raw encrypted bytes into the original media bytes (Uint8Array).
 * Mirrors the web app's `decryptBytes`.
 */
export function decryptBytes(
  encrypted: ArrayBuffer | Uint8Array,
  ivBase64: string,
  passphrase: string,
  saltBase64: string
): Uint8Array {
  const key = deriveKey(passphrase, saltBase64);
  const iv = base64ToBytes(ivBase64);
  const bytes =
    encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted);
  return gcm(key, iv).decrypt(bytes);
}

/** Clears the derived-key cache (call on sign-out for hygiene). */
export function clearE2EEKeyCache() {
  keyCache.clear();
}
