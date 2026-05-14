import { ConvexReactClient } from 'convex/react';
import { api } from '../convexApi';

/**
 * Upload a local file (file:// URI from ImagePicker / Camera) to Convex storage
 * and return the resulting storageId.
 */
export async function uploadFile(
  convex: ConvexReactClient,
  uri: string,
  mime: string
): Promise<string> {
  const uploadUrl: string = await convex.mutation(api.files.generateUploadUrl, {});
  const response = await fetch(uri);
  const blob = await response.blob();
  const result = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: blob,
  });

  if (!result.ok) {
    throw new Error(`Upload failed (${result.status})`);
  }

  const json = await result.json();
  const storageId = (json && (json.storageId || json.id)) as string | undefined;
  if (!storageId) {
    throw new Error('Upload returned no storageId');
  }

  return storageId;
}