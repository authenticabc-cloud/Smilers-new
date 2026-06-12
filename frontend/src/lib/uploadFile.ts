import { Platform } from 'react-native';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { ConvexReactClient } from 'convex/react';
import { api } from '../convexApi';

/**
 * Upload a local file (file:// URI from ImagePicker / Camera / Audio Recorder)
 * to Convex storage and return the resulting storageId.
 *
 * Backend contract (per Smilers Convex deployment):
 *   - The ONLY upload-URL mutation is `api.messages.generateUploadUrl`
 *     (it works for messages, voice notes, profile photos — all media).
 *   - It returns a pre-signed POST URL as a string.
 *   - POST the file body with the correct Content-Type and the response
 *     JSON contains `storageId` to be used in downstream mutations
 *     (`api.messages.send`, `api.users.updateProfile.avatar`, etc.).
 *
 * Earlier attempts to use `api.files.generateUploadUrl` or
 * `api.ads.generateUploadUrl` were misdiagnoses — `api.messages.*` is the
 * canonical surface.
 *
 * iter-195 (APK-share crash fix): on native we now STREAM the file from
 * disk via FileSystem.uploadAsync instead of `fetch(uri) → blob → POST`.
 * The blob path loaded the ENTIRE file into RAM — fine for photos, but a
 * 185 MB APK OOM-killed the app the moment the user tapped Send
 * ("Smilers has stopped"). Streaming keeps memory flat regardless of size.
 */
export async function uploadFile(
  convex: ConvexReactClient,
  uri: string,
  mime: string,
  uploadUrlMutation: any = api.messages.generateUploadUrl,
  // iter-196: live progress (0..1) + cancellation for large uploads.
  opts?: {
    onProgress?: (fraction: number) => void;
    cancelRef?: { current: null | (() => void) };
  }
): Promise<string> {
  let uploadUrl: string;
  try {
    uploadUrl = await convex.mutation(uploadUrlMutation, {});
  } catch (errorValue: any) {
    const msg = errorValue?.data?.message || errorValue?.message || String(errorValue);
    console.error('[uploadFile] messages.generateUploadUrl failed:', msg);
    throw new Error(`Upload URL unavailable: ${msg}`);
  }

  if (!uploadUrl || typeof uploadUrl !== 'string') {
    throw new Error('Upload URL response was empty');
  }

  const isLocalNativeFile =
    Platform.OS !== 'web' && (uri.startsWith('file://') || uri.startsWith('content://'));

  let status: number;
  let bodyText: string;
  if (isLocalNativeFile) {
    // Streaming path — constant memory, works for 100 MB+ documents/APKs.
    // createUploadTask gives us progress callbacks + cancelAsync (iter-196).
    const task = LegacyFileSystem.createUploadTask(
      uploadUrl,
      uri,
      {
        httpMethod: 'POST',
        headers: { 'Content-Type': mime },
        uploadType: LegacyFileSystem.FileSystemUploadType.BINARY_CONTENT,
      },
      opts?.onProgress
        ? ({ totalBytesSent, totalBytesExpectedToSend }) => {
            if (totalBytesExpectedToSend > 0) {
              opts.onProgress!(Math.min(1, totalBytesSent / totalBytesExpectedToSend));
            }
          }
        : undefined,
    );
    if (opts?.cancelRef) {
      opts.cancelRef.current = () => {
        void task.cancelAsync().catch(() => {});
      };
    }
    let result: LegacyFileSystem.FileSystemUploadResult | undefined;
    try {
      result = (await task.uploadAsync()) ?? undefined;
    } finally {
      if (opts?.cancelRef) opts.cancelRef.current = null;
    }
    if (!result) {
      // cancelAsync resolves uploadAsync with undefined.
      throw new Error('Upload cancelled');
    }
    status = result.status;
    bodyText = result.body || '';
  } else {
    // Web (or remote http uri): blob path is fine — browsers stream blobs.
    const response = await fetch(uri);
    const blob = await response.blob();
    const result = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: blob,
    });
    status = result.status;
    bodyText = await result.text().catch(() => '');
  }

  if (status < 200 || status >= 300) {
    throw new Error(`Upload failed (${status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
  }

  let json: any = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error('Upload returned a non-JSON response');
  }
  const storageId = (json && (json.storageId || json.id)) as string | undefined;
  if (!storageId) {
    throw new Error('Upload returned no storageId');
  }

  return storageId;
}
