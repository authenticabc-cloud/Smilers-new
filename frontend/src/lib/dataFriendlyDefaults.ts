/**
 * dataFriendlyDefaults — iter 163 (data-friendly tuning).
 *
 * Centralised recommended options for expo-image-picker / expo-document-picker
 * so every upload site in the app picks bandwidth-friendly defaults by default.
 *
 * Rationale: full-resolution camera photos from modern phones easily exceed
 * 5–10 MB each. Sending those untouched over a Convex file upload (especially
 * on a metered cellular connection) makes the app feel slow and burns the
 * user\u2019s data. These defaults bring a typical photo down to ~250–600 KB
 * with no visible quality loss at chat-bubble sizes.
 *
 * Usage:
 *   import { IMAGE_PICKER_OPTIONS_CHAT, IMAGE_PICKER_OPTIONS_AVATAR } from
 *     '../src/lib/dataFriendlyDefaults';
 *
 *   const result = await ImagePicker.launchImageLibraryAsync(
 *     IMAGE_PICKER_OPTIONS_CHAT,
 *   );
 *
 * The quality value below is the *encode* quality applied by ImagePicker
 * itself (0..1 \u2192 JPEG q ~70). Combined with allowsEditing it nudges
 * users to crop down further on iOS.
 */

import type { ImagePickerOptions, MediaTypeOptions } from 'expo-image-picker';

const ImagesOnly = 'Images' as unknown as MediaTypeOptions;
const VideosOnly = 'Videos' as unknown as MediaTypeOptions;
const ImagesAndVideos = 'All' as unknown as MediaTypeOptions;

/**
 * Defaults for in-chat photo sends.
 * - quality 0.7: ~70% JPEG quality (visually identical at chat sizes)
 * - allowsEditing true: lets users crop to a sensible frame
 * - exif false: strips GPS / device metadata from the photo (privacy + size)
 */
export const IMAGE_PICKER_OPTIONS_CHAT: ImagePickerOptions = {
  mediaTypes: ImagesOnly,
  quality: 0.7,
  allowsEditing: true,
  allowsMultipleSelection: false,
  exif: false,
  base64: false,
};

/** Multi-select variant of CHAT (gallery picker). */
export const IMAGE_PICKER_OPTIONS_CHAT_MULTI: ImagePickerOptions = {
  ...IMAGE_PICKER_OPTIONS_CHAT,
  allowsMultipleSelection: true,
  selectionLimit: 10,
  // Editing is disabled by ImagePicker when multi-select is enabled anyway.
  allowsEditing: false,
};

/**
 * Avatar uploads — tighter compression (small displayed size) and forced
 * square aspect ratio.
 */
export const IMAGE_PICKER_OPTIONS_AVATAR: ImagePickerOptions = {
  mediaTypes: ImagesOnly,
  quality: 0.6,
  allowsEditing: true,
  aspect: [1, 1],
  exif: false,
  base64: false,
};

/** Video clips in chat. Lower per-frame quality \u2192 dramatically smaller. */
export const VIDEO_PICKER_OPTIONS_CHAT: ImagePickerOptions = {
  mediaTypes: VideosOnly,
  quality: 0.5,
  allowsEditing: false,
  videoMaxDuration: 60,
  base64: false,
};

/** Mixed photo + video picker. */
export const MIXED_MEDIA_PICKER_OPTIONS: ImagePickerOptions = {
  mediaTypes: ImagesAndVideos,
  quality: 0.7,
  videoMaxDuration: 60,
  exif: false,
  base64: false,
};

/**
 * Recommended upload-size limits enforced client-side. Match (or stay
 * just under) the Convex storage upload cap to surface a friendly error
 * before the network roundtrip wastes data.
 */
export const MAX_UPLOAD_BYTES = {
  image: 8 * 1024 * 1024,        //  8 MB
  video: 25 * 1024 * 1024,       // 25 MB
  audio: 10 * 1024 * 1024,       // 10 MB
  // iter-195: raised 100 MB → 250 MB once uploads STREAM from disk
  // (FileSystem.uploadAsync) instead of loading the whole file into RAM.
  // User request: allow very large files (bigger than Telegram's 2 GB free
  // tier). Convex storage accepts large files via signed upload URLs and the
  // stream-from-disk path keeps memory flat, so we lift the document cap to
  // 2 GB. (Very large uploads still depend on a stable connection.)
  document: 2 * 1024 * 1024 * 1024, // 2 GB
} as const;

/**
 * Pretty-print a byte count for user-facing size errors:
 *   formatBytes(523_400) \u2192 "511 KB"
 *   formatBytes(8_500_000) \u2192 "8.1 MB"
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Throws a user-friendly error if a file exceeds its category limit.
 * Callers catch and surface via Alert.alert in their existing flow.
 */
export function assertUploadSize(
  bytes: number,
  category: keyof typeof MAX_UPLOAD_BYTES,
): void {
  const limit = MAX_UPLOAD_BYTES[category];
  if (bytes > limit) {
    throw new Error(
      `That ${category} is ${formatBytes(bytes)} — bigger than the ${formatBytes(limit)} limit. Please choose a smaller one.`,
    );
  }
}
