import { ConvexReactClient } from 'convex/react';
import { api } from '../convexApi';

/**
 * Upload a local file (file:// URI from ImagePicker / Camera / Audio Recorder)
 * to Convex storage and return the resulting storageId.
 *
 * NOTE: We always use `api.files.generateUploadUrl` here. Earlier attempts
 * to fall back to `api.ads.generateUploadUrl` were a misdiagnosis — that
 * mutation lives in a different bucket and produces storageIds that
 * `messages:send` cannot resolve, which causes a downstream Convex
 * Server Error. Keep this mutation singular and explicit.
 */
export async function uploadFile(
  convex: ConvexReactClient,
  uri: string,
  mime: string,
  uploadUrlMutation: any = api.files.generateUploadUrl
): Promise<string> {
  let uploadUrl: string;
  try {
    uploadUrl = await convex.mutation(uploadUrlMutation, {});
  } catch (errorValue: any) {
    const msg = errorValue?.message || String(errorValue);
    console.error('[uploadFile] generateUploadUrl failed:', msg);
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
