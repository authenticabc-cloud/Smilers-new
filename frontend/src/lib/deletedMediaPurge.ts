/**
 * deletedMediaPurge — native side of "Delete for everyone → corrupt the file".
 *
 * The web app already does the heavy lifting server-side: when the sender deletes
 * a message for everyone, the file is permanently removed from Convex storage
 * (its URL 404s globally) and all media fields are wiped. So the ORIGINAL can no
 * longer be downloaded by anyone.
 *
 * This module handles the one remaining native responsibility named in the
 * contract: purge the APP-OWNED local copies of that message's media so a file
 * the app previously downloaded/cached on this device is removed too.
 *
 * What we can purge (app-owned, deletable silently):
 *   - files written to the app cache dir (share/download/auto-download staging)
 *   - documents auto-saved to the in-app "SmilersDownloads" folder
 * What we CANNOT silently purge:
 *   - photos/videos/audio the user auto-saved to the SYSTEM gallery — the OS
 *     (esp. iOS) forces a confirmation dialog for asset deletion, so we don't
 *     spam the user mid-chat. Those copies are orphaned but the source is gone.
 *
 * We record each app-owned path under its message id at save time, then delete
 * them when the message arrives with `isDeleted === true` (storageId wiped).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LegacyFileSystem from 'expo-file-system/legacy';

const ARTIFACTS_KEY = 'smilers.deletedMediaArtifacts.v1';
const PURGED_KEY = 'smilers.deletedMediaPurged.v1';

// messageId → list of local file:// paths this device created for that message.
type ArtifactMap = Record<string, string[]>;

let artifacts: ArtifactMap | null = null;
let purgedIds: Set<string> | null = null;

async function loadArtifacts(): Promise<ArtifactMap> {
  if (artifacts) return artifacts;
  try {
    const raw = await AsyncStorage.getItem(ARTIFACTS_KEY);
    artifacts = raw ? (JSON.parse(raw) as ArtifactMap) : {};
  } catch {
    artifacts = {};
  }
  return artifacts;
}

async function persistArtifacts(): Promise<void> {
  if (!artifacts) return;
  try {
    await AsyncStorage.setItem(ARTIFACTS_KEY, JSON.stringify(artifacts));
  } catch {
    /* ignore */
  }
}

async function loadPurged(): Promise<Set<string>> {
  if (purgedIds) return purgedIds;
  try {
    const raw = await AsyncStorage.getItem(PURGED_KEY);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    purgedIds = new Set(Array.isArray(arr) ? arr.slice(-3000) : []);
  } catch {
    purgedIds = new Set();
  }
  return purgedIds;
}

/**
 * Record a local file path the app created for a message, so it can be purged
 * if the message is later deleted for everyone. No-ops on web / bad input.
 */
export async function recordMessageMediaArtifact(messageId: string, path?: string | null): Promise<void> {
  if (!messageId || !path || !path.startsWith('file://')) return;
  const map = await loadArtifacts();
  const list = map[messageId] || [];
  if (!list.includes(path)) {
    list.push(path);
    // Cap per-message to avoid unbounded growth from repeated re-downloads.
    map[messageId] = list.slice(-8);
    await persistArtifacts();
  }
}

/**
 * Delete every app-owned local copy recorded for a message. Idempotent: a
 * message is only purged once per device. Safe to call from a render effect.
 */
export async function purgeMessageMedia(messageId: string): Promise<void> {
  if (!messageId) return;
  const purged = await loadPurged();
  if (purged.has(messageId)) return;

  const map = await loadArtifacts();
  const paths = map[messageId] || [];
  const fs: any = LegacyFileSystem;
  for (const p of paths) {
    try {
      await fs.deleteAsync(p, { idempotent: true });
    } catch {
      /* file already gone — fine */
    }
  }

  // Mark purged + drop the record so we never re-scan it.
  delete map[messageId];
  await persistArtifacts();
  purged.add(messageId);
  try {
    await AsyncStorage.setItem(PURGED_KEY, JSON.stringify(Array.from(purged).slice(-3000)));
  } catch {
    /* ignore */
  }
}
