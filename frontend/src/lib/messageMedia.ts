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
function safeFileName(info: MediaInfo, fallbackExt = '.bin'): string {
  if (info.fileName && info.fileName.trim().length > 0) {
    return info.fileName.replace(/[^\w.\-]+/g, '_').slice(0, 120);
  }
  let ext = fallbackExt;
  if (info.mimeType) {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'audio/mpeg': '.mp3',
      'audio/m4a': '.m4a',
      'audio/mp4': '.m4a',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
    };
    ext = map[info.mimeType] || ext;
  }
  return `smilers_${Date.now()}${ext}`;
}

/**
 * Download a remote URL to the app cache and return the file:// URI.
 * Used by share + download flows so the OS can actually read the file
 * (most Android share targets can't read https URLs directly).
 */
async function downloadToCache(info: MediaInfo): Promise<string | null> {
  if (!info.url) return null;
  const fileName = safeFileName(info);
  // expo-file-system Paths API (v19+): use the cache directory.
  const cacheDir = (FileSystem as any).cacheDirectory || (FileSystem as any).documentDirectory;
  if (!cacheDir) {
    throw new Error('No writable cache directory available on this platform.');
  }
  const target = `${cacheDir}${fileName}`;
  // Remove any stale file at the same path so the download doesn't
  // silently fail on iOS (expo-file-system refuses to overwrite).
  try {
    await (FileSystem as any).deleteAsync(target, { idempotent: true });
  } catch {}
  const result = await (FileSystem as any).downloadAsync(info.url, target);
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
 * Save a message's media (photo, video, etc.) to the device's gallery.
 * Requests permission first, returns `true` if saved, `false` if the
 * user denied permission OR the message has no media.
 */
export async function saveMessageMediaToGallery(args: {
  client: ConvexReactClient;
  message: any;
}): Promise<boolean> {
  const { client, message } = args;
  if (!message) return false;

  let info: MediaInfo | null = null;
  try {
    info = await fetchMediaInfo(client, String(message._id), message);
  } catch (errorValue: any) {
    Alert.alert('Download failed', errorValue?.message || 'Could not fetch media URL');
    return false;
  }
  if (!info || !info.url) {
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
  try {
    cacheUri = await downloadToCache(info);
  } catch (errorValue: any) {
    Alert.alert('Download failed', errorValue?.message || 'Unknown error');
    return false;
  }
  if (!cacheUri) {
    Alert.alert('Download failed', 'Could not prepare the file.');
    return false;
  }

  try {
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
