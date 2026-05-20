import { ConvexReactClient } from 'convex/react';
import { api } from '../convexApi';

/**
 * Upload a local file (file:// URI from ImagePicker / Camera / Audio Recorder)
 * to Convex storage and return the resulting storageId.
 *
 * The Smilers Convex backend has multiple `generateUploadUrl` mutations:
 *   - `api.files.generateUploadUrl`   (preferred, generic)
 *   - `api.ads.generateUploadUrl`     (works; used in the ads composer)
 *
 * `files.generateUploadUrl` has been observed to throw a Convex Server Error
 * intermittently on the production deployment. Convex storage is a single
 * namespace, so a storageId returned from either mutation can be consumed
 * by other queries/mutations (e.g. `api.files.getUrl`) regardless of which
 * URL generator produced it. We therefore retry with `ads.generateUploadUrl`
 * if the primary mutation fails — the resulting storageId remains valid.
 */
async function requestUploadUrl(convex: ConvexReactClient, primaryMutation: any): Promise<string> {
  const attempts: Array<{ label: string; mutation: any }> = [];
  if (primaryMutation) {
    attempts.push({ label: 'primary', mutation: primaryMutation });
  }
  // Always include the proven-working ads fallback unless it IS the primary
  if ((api as any).ads?.generateUploadUrl && primaryMutation !== (api as any).ads.generateUploadUrl) {
    attempts.push({ label: 'ads.generateUploadUrl', mutation: (api as any).ads.generateUploadUrl });
  }

  let lastError: any = null;
  for (const attempt of attempts) {
    try {
      const url = await convex.mutation(attempt.mutation, {});
      if (typeof url === 'string' && url.length > 0) {
        if (attempt.label !== 'primary') {
          console.warn('[uploadFile] using fallback:', attempt.label);
        }
        return url;
      }
      throw new Error('Empty upload URL response');
    } catch (errorValue: any) {
      lastError = errorValue;
      console.warn(
        `[uploadFile] ${attempt.label} failed:`,
        errorValue?.data?.message || errorValue?.message || errorValue
      );
    }
  }

  const detail = lastError?.data?.message || lastError?.message || String(lastError || 'Unknown error');
  throw new Error(`Upload URL unavailable: ${detail}`);
}

export async function uploadFile(
  convex: ConvexReactClient,
  uri: string,
  mime: string,
  uploadUrlMutation: any = api.files.generateUploadUrl
): Promise<string> {
  const uploadUrl = await requestUploadUrl(convex, uploadUrlMutation);

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
