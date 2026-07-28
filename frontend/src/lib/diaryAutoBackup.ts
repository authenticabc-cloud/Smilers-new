/**
 * diaryAutoBackup — silent, automatic weekly encrypted Diary backup.
 *
 * Once a week (per user), if an App Lock PIN is set and there are entries, we
 * write an AES-GCM-256 encrypted snapshot of the Diary to the app's persistent
 * document directory (`SmilersBackups/`). The file uses the SAME envelope
 * format as the manual "Export (encrypted)" action, so the existing
 * "Restore from backup" flow can decrypt it with the PIN. We keep the newest
 * few and prune older ones. Everything here is best-effort and NEVER throws —
 * it runs quietly in the background and must never disrupt the Diary screen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { encryptStringWithPassphraseAsync } from './e2eeCrypto';
import { readDiaryEntries } from './diaryStore';
import { APP_LOCK_PIN_KEY, readStoredString } from './settingsStorage';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RETAIN = 4; // keep the newest N auto-backups
const PREFIX = 'smilers-diary-auto-';
const BACKUP_DIR = `${LegacyFileSystem.documentDirectory || ''}SmilersBackups/`;

function lastAtKey(userId: string): string {
  return `smilers.diary.autobackup.${userId}.lastAt`;
}

/**
 * Run a weekly encrypted backup if one is due. Safe to call on every Diary
 * open — it no-ops when it ran within the last 7 days, when no PIN is set, or
 * when the Diary is empty.
 */
export async function maybeRunWeeklyDiaryBackup(
  userId: string | null | undefined,
): Promise<void> {
  try {
    if (!userId || !LegacyFileSystem.documentDirectory) return;

    const last = Number(await AsyncStorage.getItem(lastAtKey(userId))) || 0;
    if (Date.now() - last < WEEK_MS) return; // not due yet

    const pin = (await readStoredString(APP_LOCK_PIN_KEY)) || '';
    if (!pin) return; // no key to encrypt with — skip silently

    const entries = await readDiaryEntries(userId);
    if (!entries || entries.length === 0) {
      // Nothing to back up, but mark the timestamp so we don't re-check daily.
      await AsyncStorage.setItem(lastAtKey(userId), String(Date.now()));
      return;
    }

    const ordered = [...entries].sort((a, b) => b._creationTime - a._creationTime);
    const payload = {
      app: 'Smilers',
      type: 'diary-backup',
      exportedAt: new Date().toISOString(),
      count: ordered.length,
      entries: ordered.map((e) => ({
        id: e._id,
        kind: e.kind,
        text: e.text ?? null,
        createdAt: e._creationTime,
        attachment: e.attachment ?? null,
        forwardedFrom: e.forwardedFrom ?? null,
      })),
    };
    const envelope = await encryptStringWithPassphraseAsync(JSON.stringify(payload), pin);
    const fileBody = JSON.stringify(
      {
        app: 'Smilers',
        type: 'diary-backup-encrypted',
        auto: true,
        note: 'Automatic weekly backup. Encrypted with your Smilers App Lock PIN (AES-GCM-256).',
        exportedAt: payload.exportedAt,
        count: payload.count,
        ...envelope,
      },
      null,
      2,
    );

    try {
      const info = await LegacyFileSystem.getInfoAsync(BACKUP_DIR);
      if (!info.exists) {
        await LegacyFileSystem.makeDirectoryAsync(BACKUP_DIR, { intermediates: true });
      }
    } catch {
      // directory likely already exists
    }

    const path = `${BACKUP_DIR}${PREFIX}${Date.now()}.smdiary.json`;
    await LegacyFileSystem.writeAsStringAsync(path, fileBody);
    await AsyncStorage.setItem(lastAtKey(userId), String(Date.now()));

    // Prune to the newest RETAIN files (names sort chronologically by timestamp).
    try {
      const files = (await LegacyFileSystem.readDirectoryAsync(BACKUP_DIR))
        .filter((f) => f.startsWith(PREFIX))
        .sort();
      if (files.length > RETAIN) {
        for (const f of files.slice(0, files.length - RETAIN)) {
          try {
            await LegacyFileSystem.deleteAsync(BACKUP_DIR + f, { idempotent: true });
          } catch {
            // skip files we can't delete
          }
        }
      }
    } catch {
      // pruning is best-effort
    }
  } catch {
    // Never throw from background maintenance.
  }
}

/** Absolute URI of the most recent auto-backup file, or null if none exist. */
export async function getLatestAutoBackupUri(): Promise<string | null> {
  try {
    if (!LegacyFileSystem.documentDirectory) return null;
    const info = await LegacyFileSystem.getInfoAsync(BACKUP_DIR);
    if (!info.exists) return null;
    const files = (await LegacyFileSystem.readDirectoryAsync(BACKUP_DIR))
      .filter((f) => f.startsWith(PREFIX))
      .sort();
    if (files.length === 0) return null;
    return BACKUP_DIR + files[files.length - 1];
  } catch {
    return null;
  }
}
