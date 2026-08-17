/**
 * backgroundMediaDownload.ts
 *
 * Hook-free helper invoked by the push background task (backgroundTaskSetup.ts)
 * so RECEIVED chat media auto-saves to the device the instant its push arrives
 * — even when the app is backgrounded or fully killed (headless JS context).
 *
 * Flow (all best-effort, never throws):
 *   1. Read the OIDC id_token from SecureStore + build a ConvexHttpClient.
 *   2. Fetch the conversation's recent messages (`messages.list`), find the one
 *      the push refers to (by messageId, else the newest media message).
 *   3. Skip if it's mine, or if its type's auto-download toggle is OFF.
 *   4. Resolve the media URL; for E2EE messages, download the ciphertext,
 *      fetch the conversation key (`e2ee.getE2EEStatus`) and decrypt on-device.
 *   5. Save via `saveReceivedMediaToDevice` (gallery / SmilersDownloads),
 *      honouring the same per-type toggles + dedup as the in-chat auto-download.
 *
 * PLATFORM NOTE: Android runs this reliably while the app is killed. iOS
 * restricts Photos writes from a killed app, so on iOS this saves reliably when
 * the app is alive (foreground/backgrounded) and is best-effort when killed.
 */
import { Platform } from 'react-native';

const MEDIA_TYPES = ['image', 'video', 'audio', 'voice', 'file', 'document'];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
  }
  if (typeof btoa === 'function') return btoa(binary);
  const B: any = (globalThis as any).Buffer;
  return B ? B.from(binary, 'binary').toString('base64') : '';
}

export async function maybeBackgroundDownloadMedia(payload: Record<string, any>): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (String(payload?.type || '') !== 'message') return;
    const conversationId = String(payload?.conversationId || '');
    if (!conversationId) return;
    const messageId = String(payload?.messageId || '');

    // 1) Auth + Convex HTTP client (same pattern as the call-declined path).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SecureStore = require('expo-secure-store');
    const token = await SecureStore.getItemAsync('smilers_id_token');
    const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
    if (!token || !convexUrl) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ConvexHttpClient } = require('convex/browser');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { anyApi } = require('convex/server');
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(token);

    // 2) Fetch recent messages and locate the target.
    const page: any = await client.query(anyApi.messages.list, {
      conversationId,
      paginationOpts: { numItems: 8, cursor: null },
    });
    const rows: any[] = Array.isArray(page?.page) ? page.page : Array.isArray(page) ? page : [];
    if (!rows.length) return;

    let msg =
      (messageId && rows.find((r) => String(r?._id) === messageId)) ||
      rows.find((r) => MEDIA_TYPES.includes(String(r?.type)));
    if (!msg || !MEDIA_TYPES.includes(String(msg.type))) return;

    // 3) Never auto-save my OWN outgoing media.
    if (msg?.isMine === true || String(payload?.fromSelf || '') === '1') return;

    // Cheap pref/dedup pre-check so we don't fetch media we won't keep.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mad = require('../lib/mediaAutoDownload');
    const bucket = mad.mediaTypeToBucket(msg.type);
    if (!bucket) return;

    // 4) Resolve the (signed) media URL.
    let mediaUrl: string | null =
      typeof msg.mediaUrl === 'string' && msg.mediaUrl ? msg.mediaUrl : null;
    if (!mediaUrl && msg.storageId) {
      for (const ref of [anyApi.messages.getStorageUrl, anyApi.storage.getUrl]) {
        try {
          const u = await client.query(ref, { storageId: msg.storageId });
          if (typeof u === 'string' && u) {
            mediaUrl = u;
            break;
          }
        } catch {
          /* try next */
        }
      }
    }
    if (!mediaUrl) return;

    let src = mediaUrl;

    // 5) E2EE → download ciphertext + decrypt on-device.
    if (msg.encrypted === true && typeof msg.iv === 'string' && msg.iv) {
      const e2ee: any = await client.query(anyApi.e2ee.getE2EEStatus, { conversationId });
      const passphrase = e2ee?.passphrase;
      const salt = e2ee?.salt;
      if (!passphrase || !salt) return;
      const resp = await fetch(mediaUrl);
      if (!resp.ok) return;
      const buf = await resp.arrayBuffer();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { decryptBytes } = require('../lib/e2eeCrypto');
      const plain: Uint8Array = decryptBytes(buf, msg.iv, passphrase, salt);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LegacyFileSystem = require('expo-file-system/legacy');
      const cacheDir = LegacyFileSystem.cacheDirectory || LegacyFileSystem.documentDirectory;
      if (!cacheDir) return;
      const ext = mad.inferMediaExtension(msg);
      const tmp = `${cacheDir}smilers_bgdl_${Date.now()}${ext}`;
      await LegacyFileSystem.writeAsStringAsync(tmp, bytesToBase64(plain), { encoding: 'base64' });
      src = tmp;
    }

    await mad.saveReceivedMediaToDevice({ msg, src, mediaType: msg.type });
  } catch {
    /* best-effort — background download must never break the notification path */
  }
}
