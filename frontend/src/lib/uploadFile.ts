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
 */
export async function uploadFile(
  convex: ConvexReactClient,
  uri: string,
  mime: string,
  uploadUrlMutation: any = api.messages.generateUploadUrl
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

  const response = await fetch(uri);
  const blob = await response.blob();
  const result = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: blob,
  });

  if (!result.ok) {
    const errBody = await result.text().catch(() => '');
    throw new Error(`Upload failed (${result.status})${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
  }

  const json = await result.json();
  const storageId = (json && (json.storageId || json.id)) as string | undefined;
  if (!storageId) {
    throw new Error('Upload returned no storageId');
  }

  return storageId;
}
