/**
 * fileHash — SHA-256 of a local file's PLAINTEXT bytes, lowercase hex.
 *
 * Powers the "Receive once" 🔂 feature: the sender computes this over the
 * plaintext file bytes (BEFORE any E2EE), sends it as `messages.send({ fileHash })`,
 * and the backend uses it to detect when a receiver already got the same file
 * (in any 1:1 or group) and hides the duplicate.
 *
 * Reads the file in chunks so hashing a large document/APK never loads the
 * whole file into RAM (mirrors the streaming upload in uploadFile.ts).
 */
import { Platform } from 'react-native';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// ~512 KB of base64 per read → decoded to ~384 KB of bytes.
const CHUNK_BYTES = 512 * 1024;

function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  if (typeof atob === 'function') {
    binary = atob(base64);
  } else if (typeof (global as any).Buffer !== 'undefined') {
    binary = (global as any).Buffer.from(base64, 'base64').toString('binary');
  } else {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Compute the SHA-256 (lowercase hex) of the file at `uri`. Returns null on
 * any failure so callers can send without a hash (backend simply skips dedup).
 */
export async function computeFileHashFromUri(uri: string): Promise<string | null> {
  try {
    if (!uri) return null;

    // Web: fetch the blob and hash it in one shot.
    if (Platform.OS === 'web') {
      const res = await fetch(uri);
      const buf = new Uint8Array(await res.arrayBuffer());
      return bytesToHex(sha256(buf));
    }

    const info = await LegacyFileSystem.getInfoAsync(uri, { size: true } as any);
    if (!info.exists) return null;
    const size = Number((info as any).size || 0);

    // Small file (or unknown size): single read.
    if (!size || size <= CHUNK_BYTES) {
      const b64 = await LegacyFileSystem.readAsStringAsync(uri, {
        encoding: LegacyFileSystem.EncodingType.Base64,
      });
      return bytesToHex(sha256(base64ToBytes(b64)));
    }

    // Large file: stream in chunks.
    const hasher = sha256.create();
    let pos = 0;
    while (pos < size) {
      const length = Math.min(CHUNK_BYTES, size - pos);
      const b64 = await LegacyFileSystem.readAsStringAsync(uri, {
        encoding: LegacyFileSystem.EncodingType.Base64,
        position: pos,
        length,
      } as any);
      const bytes = base64ToBytes(b64);
      if (bytes.length === 0) break;
      hasher.update(bytes);
      pos += length;
    }
    return bytesToHex(hasher.digest());
  } catch {
    return null;
  }
}
