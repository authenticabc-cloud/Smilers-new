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
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Crypto from 'expo-crypto';

// Deferred/lazy access — see AuthProvider.tsx for why: expo-secure-store's
// own binding calls requireNativeModule('ExpoSecureStore') at module scope,
// which can throw if native module registration hasn't finished yet on an
// iOS cold start. Proxy defers the actual require() to first real use.
const SecureStore: typeof import('expo-secure-store') = new Proxy({} as any, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-secure-store')[prop];
  },
});

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') return btoa(binary);
  return (global as any).Buffer
    ? (global as any).Buffer.from(bytes).toString('base64')
    : '';
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

/** True if the derived AES key for this passphrase+salt is already cached. */
export function hasDerivedKey(passphrase: string, saltB64: string): boolean {
  return keyCache.has(cacheKey(passphrase, saltB64));
}

// In-flight async derivations, deduped per key so concurrent callers share
// the same PBKDF2 run instead of each kicking off a fresh 100k-iteration pass.
const pendingDerivations = new Map<string, Promise<Uint8Array>>();

// How many HMAC iterations to run before yielding control back to the event
// loop. Yielding via `setTimeout` (a MACROtask) — not a Promise microtask —
// is what actually lets React Native deliver queued touch/press events while
// the key derives, so the UI stays responsive.
const YIELD_EVERY = 3000;

const macrotaskYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * PBKDF2-HMAC-SHA256 that periodically yields to the MACROtask queue.
 *
 * Byte-for-byte identical output to `@noble/hashes` `pbkdf2` (verified), but
 * because it awaits `setTimeout(0)` every few thousand iterations the JS
 * thread returns to the event loop in between — so button taps, navigation,
 * and the composer stay responsive instead of freezing for the ~1-3s the
 * derivation takes on a phone. `dkLen` == hLen (32) → single output block.
 */
async function pbkdf2Sha256Yielding(
  passphraseBytes: Uint8Array,
  salt: Uint8Array
): Promise<Uint8Array> {
  // Feature-detect the (internal but long-stable) noble cloneable-hash API we
  // rely on for the fast, incremental HMAC loop. If a future @noble/hashes
  // version removes it, fall back to the public sync `pbkdf2` — correctness is
  // preserved; only the one-time (SecureStore-persisted) derivation may block.
  const probe: any = hmac.create(sha256, passphraseBytes);
  if (typeof probe._cloneInto !== 'function' || typeof probe.digestInto !== 'function') {
    return pbkdf2(sha256, passphraseBytes, salt, { c: PBKDF2_ITERATIONS, dkLen: KEY_LEN });
  }
  const blockIndex = new Uint8Array(4);
  blockIndex[3] = 1; // INT_32_BE(1) — only one 32-byte block needed
  const u = new Uint8Array(KEY_LEN);
  const PRFSalt = hmac.create(sha256, passphraseBytes).update(salt);
  (PRFSalt as any)._cloneInto().update(blockIndex).digestInto(u); // U1
  const T = u.slice();
  const PRF: any = hmac.create(sha256, passphraseBytes);
  let prfW = PRF._cloneInto();
  for (let i = 1; i < PBKDF2_ITERATIONS; i++) {
    prfW = PRF._cloneInto(prfW);
    prfW.update(u).digestInto(u); // Ui = PRF(pass, Ui-1)
    for (let j = 0; j < KEY_LEN; j++) T[j] ^= u[j];
    if (i % YIELD_EVERY === 0) {
      await macrotaskYield();
    }
  }
  return T;
}

/**
 * Derive (and cache) the AES key WITHOUT freezing the UI.
 *
 * PBKDF2 with 100k SHA-256 iterations in pure JS takes ~1-3s on a mid-range
 * phone. Running it synchronously inside a render/useMemo froze the whole UI
 * (back button, call buttons, composer) for that entire time whenever a chat
 * was opened for the first time in a session — exactly the "controls are
 * unresponsive for seconds when I open a chat" report. Two-part fix:
 *   1. Persist the derived key in SecureStore so it is computed at most ONCE
 *      per conversation-key ever (subsequent opens, incl. cold starts, are
 *      instant — no PBKDF2 at all).
 *   2. For the first-ever derivation, run a macrotask-yielding PBKDF2 so the
 *      UI keeps handling taps while the key derives in the background.
 */
export async function deriveKeyAsync(
  passphrase: string,
  saltB64: string
): Promise<Uint8Array> {
  const ck = cacheKey(passphrase, saltB64);
  const cached = keyCache.get(ck);
  if (cached) return cached;
  const inFlight = pendingDerivations.get(ck);
  if (inFlight) return inFlight;
  const storeKey = `e2ee_dk_${ck}`;
  const promise = (async () => {
    try {
      // Fast path: persisted from a previous session → no PBKDF2 at all.
      const persisted = await SecureStore.getItemAsync(storeKey);
      if (persisted) {
        const bytes = base64ToBytes(persisted);
        if (bytes.length === KEY_LEN) {
          keyCache.set(ck, bytes);
          return bytes;
        }
      }
    } catch {
      // SecureStore unavailable (e.g. web preview) — fall through to derive.
    }
    const salt = base64ToBytes(saltB64);
    const passphraseBytes = new TextEncoder().encode(passphrase);
    const derived = await pbkdf2Sha256Yielding(passphraseBytes, salt);
    keyCache.set(ck, derived);
    try {
      await SecureStore.setItemAsync(storeKey, bytesToBase64(derived));
    } catch {
      // Non-fatal — in-memory cache still serves this session.
    }
    return derived;
  })()
    .then((derived) => {
      pendingDerivations.delete(ck);
      return derived;
    })
    .catch((errorValue) => {
      pendingDerivations.delete(ck);
      throw errorValue;
    });
  pendingDerivations.set(ck, promise);
  return promise;
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

/**
 * Self-describing envelope for a passphrase-encrypted backup blob (e.g. the
 * encrypted Diary export). Contains everything needed to decrypt given the
 * passphrase, so the file is portable and future-restorable.
 */
export interface EncryptedEnvelope {
  v: 1;
  alg: 'AES-GCM-256';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
}

/**
 * Encrypt a UTF-8 string with a user passphrase into a portable envelope.
 * Fresh random salt + IV per call; key derivation uses the same non-blocking
 * (macrotask-yielding) PBKDF2 as the rest of the app so a big export never
 * freezes the UI. Not persisted to SecureStore (the salt is one-off).
 */
export async function encryptStringWithPassphraseAsync(
  plaintext: string,
  passphrase: string
): Promise<EncryptedEnvelope> {
  const salt = Crypto.getRandomBytes(16);
  const iv = Crypto.getRandomBytes(12);
  const key = await pbkdf2Sha256Yielding(new TextEncoder().encode(passphrase), salt);
  const ciphertext = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext));
  return {
    v: 1,
    alg: 'AES-GCM-256',
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

/**
 * Decrypt an {@link EncryptedEnvelope} produced by
 * `encryptStringWithPassphraseAsync` back into the original UTF-8 string.
 * Throws if the passphrase is wrong or the blob is tampered.
 */
export async function decryptEnvelopeWithPassphraseAsync(
  envelope: EncryptedEnvelope,
  passphrase: string
): Promise<string> {
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const key = await pbkdf2Sha256Yielding(new TextEncoder().encode(passphrase), salt);
  return bytesToUtf8(gcm(key, iv).decrypt(ciphertext));
}
