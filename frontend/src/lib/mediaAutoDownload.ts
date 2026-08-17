/**
 * mediaAutoDownload — per-type "auto-download & save to device" for received
 * chat media (user request, iter-223).
 *
 * The user can independently toggle auto-saving of Photos / Videos / Audio /
 * Documents (all OFF by default). When a toggle is ON, any INCOMING media of
 * that type is saved to the device the first time its bubble renders with a
 * decrypted/loaded URI:
 *   - photos / videos / audio → the system gallery (expo-media-library)
 *   - documents → an app "SmilersDownloads" folder (no public gallery exists
 *     for arbitrary files; SAF export stays a manual action)
 *
 * Saving is SILENT (no alerts / no permission prompts mid-scroll): if the
 * gallery permission hasn't been granted yet we skip rather than interrupt the
 * user. A persisted set of saved message ids prevents re-saving duplicates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { recordMessageMediaArtifact } from './deletedMediaPurge';

export type AutoDownloadType = 'photos' | 'videos' | 'audio' | 'documents';

export interface AutoDownloadPrefs {
  photos: boolean;
  videos: boolean;
  audio: boolean;
  documents: boolean;
}

export const AUTO_DOWNLOAD_DEFAULTS: AutoDownloadPrefs = {
  photos: false,
  videos: false,
  audio: false,
  documents: false,
};

export const AUTO_DOWNLOAD_META: { key: AutoDownloadType; label: string; sub: string; icon: string }[] = [
  { key: 'photos', label: 'Photos', sub: 'Save received photos to your gallery', icon: 'image-outline' },
  { key: 'videos', label: 'Videos', sub: 'Save received videos to your gallery', icon: 'videocam-outline' },
  { key: 'audio', label: 'Audio', sub: 'Save received voice notes & audio', icon: 'musical-notes-outline' },
  { key: 'documents', label: 'Documents', sub: 'Save received files to Smilers Downloads', icon: 'document-outline' },
];

const PREFS_KEY = 'smilers.autoDownloadPrefs.v1';
const SAVED_KEY = 'smilers.autoDownloadSaved.v1';

// ── In-memory caches + a tiny pub/sub so the settings screen and the bubble
//    hooks share one source of truth without re-reading AsyncStorage. ──
let cachedPrefs: AutoDownloadPrefs | null = null;
const prefsListeners = new Set<(p: AutoDownloadPrefs) => void>();

let savedIds: Set<string> | null = null;
const savingInFlight = new Set<string>();

async function loadPrefs(): Promise<AutoDownloadPrefs> {
  if (cachedPrefs) return cachedPrefs;
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    cachedPrefs = raw
      ? { ...AUTO_DOWNLOAD_DEFAULTS, ...(JSON.parse(raw) as Partial<AutoDownloadPrefs>) }
      : { ...AUTO_DOWNLOAD_DEFAULTS };
  } catch {
    cachedPrefs = { ...AUTO_DOWNLOAD_DEFAULTS };
  }
  return cachedPrefs;
}

async function persistPrefs(next: AutoDownloadPrefs): Promise<void> {
  cachedPrefs = next;
  prefsListeners.forEach((fn) => {
    try {
      fn(next);
    } catch {
      /* ignore */
    }
  });
  try {
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

async function ensureSavedLoaded(): Promise<Set<string>> {
  if (savedIds) return savedIds;
  try {
    const raw = await AsyncStorage.getItem(SAVED_KEY);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    savedIds = new Set(Array.isArray(arr) ? arr.slice(-2000) : []);
  } catch {
    savedIds = new Set();
  }
  return savedIds;
}

async function markSaved(id: string): Promise<void> {
  const set = await ensureSavedLoaded();
  set.add(id);
  try {
    // Cap the persisted list so it can't grow without bound.
    const arr = Array.from(set).slice(-2000);
    await AsyncStorage.setItem(SAVED_KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

/** Map a message's media `type` onto an auto-download pref bucket. */
export function mediaTypeToBucket(type: string | undefined | null): AutoDownloadType | null {
  switch ((type || '').toLowerCase()) {
    case 'image':
      return 'photos';
    case 'video':
      return 'videos';
    case 'audio':
    case 'voice':
      return 'audio';
    case 'file':
    case 'document':
      return 'documents';
    default:
      return null;
  }
}

// ── File materialisation helpers ─────────────────────────────────────────
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
};

function inferExt(msg: any, bucket: AutoDownloadType): string {
  const mime = typeof msg?.mimeType === 'string' ? msg.mimeType.toLowerCase() : '';
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const name = typeof msg?.fileName === 'string' ? msg.fileName : '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 6) return name.slice(dot).toLowerCase();
  if (bucket === 'photos') return '.jpg';
  if (bucket === 'videos') return '.mp4';
  if (bucket === 'audio') return '.m4a';
  return '.bin';
}

/** Turn a decrypted/loaded src (data:/file:/http) into a local file:// path. */
async function toLocalFile(src: string, msg: any, bucket: AutoDownloadType): Promise<string | null> {
  const fs: any = LegacyFileSystem;
  if (src.startsWith('file://')) return src;
  const cacheDir = fs?.cacheDirectory || fs?.documentDirectory;
  if (!cacheDir) return null;
  const ext = inferExt(msg, bucket);
  const target = `${cacheDir}smilers_autodl_${Date.now()}${ext}`;
  try {
    await fs.deleteAsync(target, { idempotent: true });
  } catch {
    /* ignore */
  }
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    if (comma < 0) return null;
    await fs.writeAsStringAsync(target, src.slice(comma + 1), { encoding: 'base64' });
    return target;
  }
  // http(s) / content:// — download to cache.
  const dl = fs?.downloadAsync;
  if (typeof dl !== 'function') return null;
  try {
    const res = await dl(src, target);
    if (res?.status && res.status >= 400) return null;
    return res?.uri || target;
  } catch {
    return null;
  }
}

async function saveDocument(src: string, msg: any): Promise<boolean> {
  const fs: any = LegacyFileSystem;
  const local = await toLocalFile(src, msg, 'documents');
  if (!local) return false;
  const dir = `${fs.documentDirectory}SmilersDownloads/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    /* exists */
  }
  const rawName =
    (typeof msg?.fileName === 'string' && msg.fileName.replace(/[^\w.\-]+/g, '_')) ||
    `smilers_${Date.now()}${inferExt(msg, 'documents')}`;
  try {
    await fs.copyAsync({ from: local, to: `${dir}${rawName}` });
    // Track the app-owned copy so it can be purged if the sender deletes
    // this message for everyone.
    await recordMessageMediaArtifact(String(msg?._id || ''), `${dir}${rawName}`);
    return true;
  } catch {
    return false;
  }
}

async function saveToGallery(src: string, msg: any, bucket: AutoDownloadType): Promise<boolean> {
  // Silent: only proceed if permission is ALREADY granted.
  let perm = await MediaLibrary.getPermissionsAsync();
  if (perm.status !== 'granted') return false;
  const local = await toLocalFile(src, msg, bucket);
  if (!local) return false;
  // Track the staged app-cache copy so it can be purged on delete-for-everyone.
  await recordMessageMediaArtifact(String(msg?._id || ''), local);
  if (typeof (MediaLibrary as any).saveToLibraryAsync === 'function') {
    await (MediaLibrary as any).saveToLibraryAsync(local);
  } else {
    await MediaLibrary.createAssetAsync(local);
  }
  return true;
}

/**
 * React hook: call inside each media bubble renderer. When the bubble belongs
 * to the other user, its type's auto-download toggle is ON, and the decrypted
 * `src` is ready, the media is saved once (silently).
 */
export function useAutoDownloadMedia(params: {
  msg: any;
  isMine: boolean;
  src: string | null | undefined;
  mediaType: string | undefined | null;
}): void {
  const { msg, isMine, src, mediaType } = params;
  const doneRef = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (isMine) return; // only auto-save RECEIVED media
    if (!src) return;
    if (doneRef.current) return;
    const id = String(msg?._id || '');
    if (!id) return;
    const bucket = mediaTypeToBucket(mediaType);
    if (!bucket) return;

    let cancelled = false;
    (async () => {
      const saved = await ensureSavedLoaded();
      if (saved.has(id) || savingInFlight.has(id)) {
        doneRef.current = true;
        return;
      }
      const prefs = await loadPrefs();
      if (!prefs[bucket]) return;
      if (cancelled) return;
      doneRef.current = true;
      savingInFlight.add(id);
      try {
        const ok =
          bucket === 'documents'
            ? await saveDocument(src, msg)
            : await saveToGallery(src, msg, bucket);
        if (ok) await markSaved(id);
      } catch {
        /* swallow — auto-download is best-effort */
      } finally {
        savingInFlight.delete(id);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src, isMine, msg, mediaType]);
}

/**
 * Imperative (hook-free) counterpart of `useAutoDownloadMedia` — used by the
 * push background task so received media can be saved to the device the moment
 * it arrives, even when no chat screen is mounted (or the app is killed).
 *
 * Respects the same per-type toggles + one-time dedup as the hook. `src` may be
 * a `file://` (already-decrypted), `data:` or `http(s)` URI. Returns true when a
 * file was actually saved. Best-effort: never throws.
 */
export async function saveReceivedMediaToDevice(params: {
  msg: any;
  src: string;
  mediaType?: string | null;
}): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const { msg, src } = params;
  const id = String(msg?._id || '');
  if (!id || !src) return false;
  const bucket = mediaTypeToBucket(params.mediaType ?? msg?.type);
  if (!bucket) return false;
  try {
    const saved = await ensureSavedLoaded();
    if (saved.has(id) || savingInFlight.has(id)) return false;
    const prefs = await loadPrefs();
    if (!prefs[bucket]) return false;
    savingInFlight.add(id);
    try {
      const ok =
        bucket === 'documents'
          ? await saveDocument(src, msg)
          : await saveToGallery(src, msg, bucket);
      if (ok) await markSaved(id);
      return ok;
    } finally {
      savingInFlight.delete(id);
    }
  } catch {
    return false;
  }
}

/** Best-effort file extension for a decrypted-in-memory media blob so the OS
 *  gallery categorises it correctly. Mirrors `inferExt` for the background path. */
export function inferMediaExtension(msg: any): string {
  const bucket = mediaTypeToBucket(msg?.type) || 'documents';
  return inferExt(msg, bucket);
}


/** Settings-screen hook: read + update the per-type toggles. */
export function useAutoDownloadPrefs() {
  const [prefs, setPrefs] = useState<AutoDownloadPrefs>(cachedPrefs || AUTO_DOWNLOAD_DEFAULTS);
  const [loading, setLoading] = useState(!cachedPrefs);

  useEffect(() => {
    let mounted = true;
    loadPrefs().then((p) => {
      if (mounted) {
        setPrefs(p);
        setLoading(false);
      }
    });
    const listener = (p: AutoDownloadPrefs) => setPrefs({ ...p });
    prefsListeners.add(listener);
    return () => {
      mounted = false;
      prefsListeners.delete(listener);
    };
  }, []);

  const setPref = useCallback(async (key: AutoDownloadType, value: boolean) => {
    const current = await loadPrefs();
    const next = { ...current, [key]: value };
    setPrefs(next);
    await persistPrefs(next);
    // When the user turns ON a gallery type, ask for the gallery permission
    // up-front so subsequent received media can be saved silently.
    if (value && key !== 'documents' && Platform.OS !== 'web') {
      try {
        const existing = await MediaLibrary.getPermissionsAsync();
        if (existing.status !== 'granted' && existing.canAskAgain) {
          await MediaLibrary.requestPermissionsAsync();
        }
      } catch {
        /* ignore */
      }
    }
  }, []);

  return { prefs, loading, setPref };
}
