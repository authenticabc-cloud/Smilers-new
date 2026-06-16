/**
 * messageMedia.ts — helpers for the iter-125 "Share / Download / Set as
 * profile photo" actions on chat messages. Centralised here so both
 * the message-action-sheet (long-press on any message) and the
 * full-screen photo viewer use the same logic and the same error
 * surface.
 *
 * Backend contract (per the iter-125 web↔mobile spec):
 *   api.messages.getMediaUrl({ messageId })
 *     → { url, type, fileName?, mimeType?, fileSize? }
 *   api.messages.setMediaAsProfilePhoto({ messageId })
 *     → { url }
 *
 * For text-only messages we skip the backend call and share the
 * `message.text` string directly via the native share sheet.
 */
import { Alert, Platform, Share } from 'react-native';
import * as FileSystem from 'expo-file-system';
// iter-141: expo-file-system v19+ split the API into a new namespace and
// a legacy compatibility layer. `FileSystem.cacheDirectory` /
// `downloadAsync` live on the LEGACY module; the new module exposes
// `Paths.cache` instead. We import both so the helper works regardless
// of which version is bundled.
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { ConvexReactClient } from 'convex/react';
import { api } from '../convexApi';

type MediaInfo = {
  url: string | null;
  type?: 'text' | 'image' | 'video' | 'audio' | 'file' | 'voice';
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
};

/**
 * Fetch the media URL for any message. Prefers the explicit
 * `messages.getMediaUrl` endpoint; falls back to fields already
 * present on the message row (storageId/fileUrl) for the common case
 * where the backend endpoint isn't deployed yet.
 */
async function fetchMediaInfo(
  client: ConvexReactClient,
  messageId: string,
  fallbackMsg?: any,
): Promise<MediaInfo | null> {
  try {
    const info = await client.query((api as any).messages.getMediaUrl, { messageId });
    if (info && typeof info === 'object') return info as MediaInfo;
  } catch {
    // Endpoint not deployed — fall through to fallback.
  }
  if (!fallbackMsg) return null;
  const url =
    (typeof fallbackMsg.fileUrl === 'string' && fallbackMsg.fileUrl) ||
    (typeof fallbackMsg.mediaUrl === 'string' && fallbackMsg.mediaUrl) ||
    null;
  if (!url) return null;
  return {
    url,
    type: fallbackMsg.kind || fallbackMsg.type || 'file',
    fileName: fallbackMsg.fileName,
    mimeType: fallbackMsg.mimeType,
    fileSize: fallbackMsg.fileSize,
  };
}

/** Pick a safe filename based on the media info + a fallback extension. */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'audio/mpeg': '.mp3',
  'audio/m4a': '.m4a',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
};

const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|mp4|mov|webm|3gp|m4v|mp3|m4a|aac|ogg|wav)$/i;

/** Best extension we can infer for this media (mime → url → type default). */
function inferMediaExt(info: MediaInfo): string | null {
  if (info.mimeType && EXT_BY_MIME[info.mimeType.toLowerCase()]) {
    return EXT_BY_MIME[info.mimeType.toLowerCase()];
  }
  // Try the URL path (before any query string).
  if (info.url) {
    const m = info.url.split('?')[0].match(MEDIA_EXT_RE);
    if (m) return m[0].toLowerCase();
  }
  // Type-based defaults — Android's MediaStore REQUIRES a recognizable
  // media extension to allow DCIM placement (iter-182: "Primary
  // directory DCIM not allowed" save errors came from extension-less /
  // .bin files).
  if (info.type === 'image') return '.jpg';
  if (info.type === 'video') return '.mp4';
  if (info.type === 'audio' || info.type === 'voice') return '.m4a';
  return null;
}

function safeFileName(info: MediaInfo, fallbackExt = '.bin'): string {
  const inferredExt = inferMediaExt(info);
  if (info.fileName && info.fileName.trim().length > 0) {
    let name = info.fileName.replace(/[^\w.\-]+/g, '_').slice(0, 120);
    // iter-182: a fileName WITHOUT a media extension (e.g. "IMG_2031" or
    // "photo.bin") makes saveToLibraryAsync classify the file as
    // non-media → DCIM rejected. Append the inferred extension.
    if (inferredExt && !MEDIA_EXT_RE.test(name)) {
      name = `${name}${inferredExt}`;
    }
    return name;
  }
  return `smilers_${Date.now()}${inferredExt || fallbackExt}`;
}

/**
 * Download a remote URL to the app cache and return the file:// URI.
 * Used by share + download flows so the OS can actually read the file
 * (most Android share targets can't read https URLs directly).
 */
async function downloadToCache(info: MediaInfo): Promise<string | null> {
  if (!info.url) return null;
  const fileName = safeFileName(info);
  // iter-141: prefer LegacyFileSystem (v19+'s back-compat module) since
  // its `cacheDirectory` + `downloadAsync` are still the most reliable
  // way to grab a remote file to a local path on Android. Fall back to
  // the newer FileSystem module if the legacy import is unavailable.
  const fs: any = LegacyFileSystem || FileSystem;
  const cacheDir =
    fs?.cacheDirectory ||
    fs?.documentDirectory ||
    (FileSystem as any).cacheDirectory ||
    (FileSystem as any).documentDirectory;
  if (!cacheDir) {
    throw new Error('No writable cache directory available on this platform.');
  }
  const target = `${cacheDir}${fileName}`;
  // Remove any stale file at the same path so the download doesn't
  // silently fail on iOS (expo-file-system refuses to overwrite).
  try {
    await fs.deleteAsync(target, { idempotent: true });
  } catch {}
  const downloadFn = fs.downloadAsync || (FileSystem as any).downloadAsync;
  if (typeof downloadFn !== 'function') {
    throw new Error('File download is not supported in this build.');
  }
  const result = await downloadFn(info.url, target);
  if (result?.status && result.status >= 400) {
    throw new Error(`Download failed (HTTP ${result.status}).`);
  }
  return result?.uri || target;
}

/**
 * Share a message via the device's native share sheet. Handles both
 * text-only messages (passes `message.text`) and media messages
 * (downloads to cache, then shares the local file URI).
 *
 * Returns `true` on success, `false` if the user cancelled.
 */
export async function shareMessage(args: {
  client: ConvexReactClient;
  message: any;
}): Promise<boolean> {
  const { client, message } = args;
  if (!message) return false;

  // Text-only: skip the backend round-trip.
  const kind = message.kind || message.type || (message.text && !message.storageId ? 'text' : null);
  const text = typeof message.text === 'string' ? message.text : '';
  if (kind === 'text' || (!message.storageId && !message.fileUrl && !message.mediaUrl)) {
    try {
      const res = await Share.share({ message: text || 'Shared from Smilers' });
      return res.action !== Share.dismissedAction;
    } catch (errorValue: any) {
      Alert.alert('Share failed', errorValue?.message || 'Unknown error');
      return false;
    }
  }

  // Media path: fetch URL, download, then share.
  let info: MediaInfo | null = null;
  try {
    info = await fetchMediaInfo(client, String(message._id), message);
  } catch (errorValue: any) {
    Alert.alert('Share failed', errorValue?.message || 'Could not fetch media URL');
    return false;
  }
  if (!info || !info.url) {
    Alert.alert('Share failed', 'This message has no shareable media.');
    return false;
  }

  let cacheUri: string | null = null;
  try {
    cacheUri = await downloadToCache(info);
  } catch (errorValue: any) {
    // Fall back to sharing the message text + URL as text.
    try {
      const res = await Share.share({
        message: (text ? `${text}\n\n` : '') + info.url,
      });
      return res.action !== Share.dismissedAction;
    } catch {
      Alert.alert('Share failed', errorValue?.message || 'Unknown error');
      return false;
    }
  }
  if (!cacheUri) {
    Alert.alert('Share failed', 'Could not prepare the file for sharing.');
    return false;
  }

  // Prefer expo-sharing (richer mime-type + dialog title support); fall
  // back to RN's Share API on platforms where Sharing isn't available.
  try {
    const sharingAvailable = await Sharing.isAvailableAsync();
    if (sharingAvailable) {
      await Sharing.shareAsync(cacheUri, {
        mimeType: info.mimeType || undefined,
        dialogTitle: text ? `Share: ${text.slice(0, 60)}` : 'Share with…',
        UTI: info.mimeType?.startsWith('image/')
          ? 'public.image'
          : info.mimeType?.startsWith('video/')
            ? 'public.movie'
            : undefined,
      });
      return true;
    }
    // RN Share fallback — only supports `url` on iOS reliably.
    const res = await Share.share(
      Platform.OS === 'ios'
        ? { url: cacheUri, message: text || undefined }
        : { message: `${text ? text + '\n\n' : ''}${info.url}` },
    );
    return res.action !== Share.dismissedAction;
  } catch (errorValue: any) {
    Alert.alert('Share failed', errorValue?.message || 'Unknown error');
    return false;
  }
}

/**
 * Materialize an already-decrypted media URI (passed in by the renderer —
 * e.g. the chat ImageViewer's E2EE-decrypted `src`) into a local file://
 * path that MediaLibrary can save. This is the fix for "saved file won't
 * open": E2EE chats serve AES-GCM CIPHERTEXT at the storage URL, so
 * re-downloading that URL and saving it produces an unreadable file. The
 * renderer already holds the decrypted bytes — save THOSE instead.
 *
 *   - `file://` URIs (decrypted audio/video cache files, or local picks) → as-is.
 *   - `data:` URIs (E2EE images render as base64 data URIs) → decode to a cache file.
 *   - `https://` / `content://` → return null so the caller downloads normally
 *     (plaintext / non-encrypted media).
 */
async function materializeDecryptedUri(localUri: string, info: MediaInfo): Promise<string | null> {
  if (!localUri) return null;
  if (localUri.startsWith('file://')) return localUri;
  if (localUri.startsWith('data:')) {
    const commaIdx = localUri.indexOf(',');
    if (commaIdx < 0) return null;
    const base64 = localUri.slice(commaIdx + 1);
    const fs: any = LegacyFileSystem || FileSystem;
    const cacheDir =
      fs?.cacheDirectory || fs?.documentDirectory || (FileSystem as any).cacheDirectory;
    if (!cacheDir) return null;
    const fileName = safeFileName(info, '.jpg');
    const target = `${cacheDir}${fileName}`;
    try {
      await fs.deleteAsync(target, { idempotent: true });
    } catch {}
    await fs.writeAsStringAsync(target, base64, { encoding: 'base64' });
    return target;
  }
  return null; // remote URL — let downloadToCache handle it
}

/**
 * Save a message's media (photo, video, etc.) to the device's gallery.
 * Requests permission first, returns `true` if saved, `false` if the
 * user denied permission OR the message has no media.
 */
export async function saveMessageMediaToGallery(args: {
  client: ConvexReactClient;
  message: any;
  /**
   * Already-decrypted local URI from the renderer (E2EE `data:`/`file://`).
   * When present it is saved DIRECTLY so E2EE media doesn't get saved as
   * unreadable ciphertext. Falls back to downloading when absent/remote.
   */
  localUri?: string | null;
}): Promise<boolean> {
  const { client, message, localUri } = args;
  if (!message) return false;

  let info: MediaInfo | null = null;
  try {
    info = await fetchMediaInfo(client, String(message._id), message);
  } catch (errorValue: any) {
    Alert.alert('Download failed', errorValue?.message || 'Could not fetch media URL');
    return false;
  }
  // Synthesize a minimal info from the message when the backend gives us
  // no URL but the renderer already handed us decrypted bytes.
  if ((!info || !info.url) && localUri) {
    info = {
      url: info?.url || null,
      type: message.kind || message.type || 'image',
      fileName: message.fileName,
      mimeType: message.mimeType,
      fileSize: message.fileSize,
    };
  }
  if (!info || (!info.url && !localUri)) {
    Alert.alert('Nothing to save', 'This message has no media to save.');
    return false;
  }

  // Best practice: check existing permissions, ask if undetermined, and
  // hard-stop on permanent deny.
  const existing = await MediaLibrary.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    if (existing.canAskAgain === false) {
      Alert.alert(
        'Permission needed',
        'Smilers needs permission to save to your gallery. Open Settings to enable it.',
      );
      return false;
    }
    const req = await MediaLibrary.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return false;

  let cacheUri: string | null = null;
  // Prefer the already-decrypted URI when the renderer provided it — this
  // is the fix for E2EE "Couldn't open file" (storage URL = ciphertext).
  if (localUri) {
    try {
      cacheUri = await materializeDecryptedUri(localUri, info);
    } catch {
      cacheUri = null;
    }
  }
  if (!cacheUri) {
    if (!info.url) {
      Alert.alert('Download failed', 'Could not prepare the file.');
      return false;
    }
    try {
      cacheUri = await downloadToCache(info);
    } catch (errorValue: any) {
      Alert.alert('Download failed', errorValue?.message || 'Unknown error');
      return false;
    }
  }
  if (!cacheUri) {
    Alert.alert('Download failed', 'Could not prepare the file.');
    return false;
  }

  try {
    // iter-144: Android 14+ scoped storage rejects createAssetAsync
    // writing to DCIM via `content://media/external/file`. The newer
    // `saveToLibraryAsync` API is designed for scoped storage and
    // takes a file:// URI directly. Fall back to createAssetAsync only
    // if the new API is unavailable (older expo-media-library bundles).
    if (typeof (MediaLibrary as any).saveToLibraryAsync === 'function') {
      await (MediaLibrary as any).saveToLibraryAsync(cacheUri);
      return true;
    }
    const asset = await MediaLibrary.createAssetAsync(cacheUri);
    // Best-effort: also drop into a Smilers album so users can find
    // saved photos easily. Failure here doesn't block success.
    try {
      const album = await MediaLibrary.getAlbumAsync('Smilers');
      if (album) {
        await MediaLibrary.addAssetsToAlbumAsync([asset], album.id, false);
      } else {
        await MediaLibrary.createAlbumAsync('Smilers', asset, false);
      }
    } catch {}
    return true;
  } catch (errorValue: any) {
    Alert.alert('Save failed', errorValue?.message || 'Unknown error');
    return false;
  }
}

/**
 * Use the message's image as the current user's profile photo. Backend
 * validates that the message is an image and updates `users.avatar` +
 * `users.avatarStorageId`.
 */
export async function setMessageImageAsProfilePhoto(args: {
  client: ConvexReactClient;
  message: any;
}): Promise<boolean> {
  const { client, message } = args;
  if (!message?._id) return false;

  // Pre-flight client-side guard so we don't waste a network round-trip.
  const kind = message.kind || message.type;
  if (kind && kind !== 'image') {
    Alert.alert(
      'Only images',
      'Only image messages can be set as your profile photo.',
    );
    return false;
  }

  try {
    const res = await client.mutation(
      (api as any).messages.setMediaAsProfilePhoto,
      { messageId: message._id },
    );
    // Success — caller can refresh user data if it cares. We swallow
    // the response intentionally; the avatar will refresh via the
    // user query subscription automatically.
    void res;
    return true;
  } catch (errorValue: any) {
    const msg = String(errorValue?.message || errorValue || '');
    // Map known backend error codes to friendlier copy.
    if (/only.*image/i.test(msg)) {
      Alert.alert('Only images', 'Only image messages can be set as your profile photo.');
    } else if (/no.*media|no.*storage/i.test(msg)) {
      Alert.alert('No image', 'This message doesn\u2019t have a saved image.');
    } else if (/not.*authenticated/i.test(msg) || /UNAUTHENTICATED/.test(msg)) {
      Alert.alert('Sign in required', 'Please sign in again to update your profile photo.');
    } else if (/not.*found/i.test(msg)) {
      Alert.alert('Message not found', 'The original message could not be found.');
    } else {
      Alert.alert('Update failed', msg || 'Unknown error');
    }
    return false;
  }
}
