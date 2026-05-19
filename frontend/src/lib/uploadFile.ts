import { ConvexReactClient } from 'convex/react';
import { api } from '../convexApi';

async function requestUploadUrl(convex: ConvexReactClient, primaryMutation: any) {
  const attempts = [
    { mutation: primaryMutation, label: 'files.generateUploadUrl' },
    { mutation: (api as any).ads?.generateUploadUrl, label: 'ads.generateUploadUrl' },
  ].filter((entry, index, all) => entry.mutation && all.findIndex((item) => item.mutation === entry.mutation) === index);

  let lastError: any = null;

  for (const attempt of attempts) {
    try {
      return await convex.mutation(attempt.mutation, {});
    } catch (errorValue: any) {
      lastError = errorValue;
      console.warn(`[uploadFile] ${attempt.label} failed:`, errorValue?.message || errorValue);
    }
  }

  throw lastError || new Error('Unable to get an upload URL from Convex');
}

/**
 * Upload a local file (file:// URI from ImagePicker / Camera) to Convex storage
 * and return the resulting storageId.
 */
export async function uploadFile(
  convex: ConvexReactClient,
  uri: string,
  mime: string,
  uploadUrlMutation: any = api.files.generateUploadUrl
): Promise<string> {
  const uploadUrl: string = await requestUploadUrl(convex, uploadUrlMutation);
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