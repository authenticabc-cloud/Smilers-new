/**
 * enhanceDocument — send a document photo to the backend Gemini "scan" endpoint
 * and get back a scanner-quality polished image written to a local file, ready
 * to upload/send. Used by the compose flow (Send Polished vs Send Original).
 */
import * as LegacyFileSystem from 'expo-file-system/legacy';

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL;

/** Read any image URI (data:/file:/http) into raw base64 + mime type. */
async function uriToBase64(uri: string): Promise<{ base64: string; mimeType: string }> {
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    const mimeType = uri.slice(5, comma).split(';')[0] || 'image/jpeg';
    return { base64: uri.slice(comma + 1), mimeType };
  }
  if (uri.startsWith('file://')) {
    const base64 = await LegacyFileSystem.readAsStringAsync(uri, { encoding: 'base64' as any });
    return { base64, mimeType: 'image/jpeg' };
  }
  const dest = `${LegacyFileSystem.cacheDirectory}docsrc_${Date.now()}.img`;
  const dl = await LegacyFileSystem.downloadAsync(uri, dest);
  const base64 = await LegacyFileSystem.readAsStringAsync(dl.uri, { encoding: 'base64' as any });
  try {
    await LegacyFileSystem.deleteAsync(dl.uri, { idempotent: true });
  } catch {
    /* best-effort */
  }
  return { base64, mimeType: 'image/jpeg' };
}

export interface EnhancedDocument {
  /** Local file:// URI of the polished image (null if the model returned none). */
  imageUri: string | null;
  mimeType: string;
  transcription: string;
}

/** Polish a document photo. Throws on network/server error. */
export async function enhanceDocumentToLocalFile(uri: string): Promise<EnhancedDocument> {
  if (!BACKEND) throw new Error('Backend not configured');
  const { base64, mimeType } = await uriToBase64(uri);
  const res = await fetch(`${BACKEND}/api/documents/enhance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: base64, mimeType }),
  });
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  const data = await res.json();
  const transcription: string = data?.transcription || '';
  if (!data?.enhancedImageBase64) {
    return { imageUri: null, mimeType: 'image/png', transcription };
  }
  const outMime: string = data.enhancedMimeType || 'image/png';
  const ext = outMime.includes('png') ? 'png' : 'jpg';
  const out = `${LegacyFileSystem.cacheDirectory}docpolished_${Date.now()}.${ext}`;
  await LegacyFileSystem.writeAsStringAsync(out, data.enhancedImageBase64, { encoding: 'base64' as any });
  return { imageUri: out, mimeType: outMime, transcription };
}
