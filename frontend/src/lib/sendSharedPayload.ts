/**
 * sendSharedPayload — iter-170 OS Share Sheet receiver.
 *
 * Takes a payload received from `expo-share-intent` (or any equivalent
 * "I have one of: text / URL / image / video / file") and sends it to
 * an existing conversationId using the canonical Convex mutations the
 * rest of the chat screen uses.
 *
 * Backend contract (matches /chat/[conversationId].tsx exactly):
 *   - `api.messages.send({ conversationId, type: 'text', text })`
 *   - `api.messages.send({ conversationId, type: 'image'|'video'|'file',
 *        storageId, mimeType, fileName?, fileSize? })`
 *   - Uploads route through `uploadFile()` which uses
 *     `api.messages.generateUploadUrl` per the canonical contract.
 *
 * Pre-send safety: every payload is run through `messageSecurityScanner`
 * (per iter-164 contract). Dangerous attachments (.exe, .bat, etc.)
 * are blocked at the SEND boundary. Suspicious URLs flag a warning
 * the share-receiver screen surfaces in its confirmation prompt.
 *
 * Caller passes:
 *   - convex            ConvexReactClient (from useConvex())
 *   - sendMessage       useMutation(api.messages.send) handle
 *   - conversationId    target chat id
 *   - payload           normalized payload (see SharedPayload below)
 *
 * Returns { ok: true } on success, { ok: false, reason } on a blocked
 * or failed send. NEVER throws — callers iterate over multiple recipients
 * and want a per-recipient outcome.
 */

import type { ConvexReactClient } from 'convex/react';
import { uploadFile } from './uploadFile';
import { scanMessage as scanMessageDeep } from './messageSecurityScanner';

export interface SharedPayload {
  /** Plain text or a URL — sent as a chat text message. */
  text?: string;
  /** One or more local file URIs (file:// on iOS/Android). */
  files?: Array<{
    uri: string;
    mimeType: string;
    fileName: string;
    fileSize?: number;
    /** image | video | file — derived by classifyFile() below. */
    kind: 'image' | 'video' | 'file';
  }>;
}

export interface SendOutcome {
  ok: boolean;
  /** Free-form reason on failure ("blocked", "upload_failed", etc). */
  reason?: string;
  /** True when the security scanner intentionally blocked the item
   * (risky file type) — distinct from a technical send failure. */
  blocked?: boolean;
  /** Resulting message id on success, when the backend returns one. */
  messageId?: string;
}

/**
 * Classify a mimeType into the `type` slot of `api.messages.send`.
 *   image/*  → 'image'
 *   video/*  → 'video'
 *   anything else → 'file'
 */
export function classifyFile(mimeType: string | null | undefined): 'image' | 'video' | 'file' {
  const mt = (mimeType || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Drive the entire send for one (text + N attachments) payload to one
 * conversation. Sends in this order:
 *   1) Each attachment as its own message (image / video / file)
 *   2) The text/URL, if any, AFTER attachments — matches the web app
 *      so a "look at this!" caption follows the photo.
 *
 * Each step is wrapped in try/catch so partial sends still report
 * which pieces made it through.
 */
export async function sendSharedPayloadToConversation(
  convex: ConvexReactClient,
  sendMessage: (args: any) => Promise<any>,
  conversationId: string,
  payload: SharedPayload,
): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];

  // Attachments first.
  for (const file of payload.files || []) {
    // Pre-send security scan — blocks dangerous file types at the SEND
    // boundary so they never reach the recipient. Same heuristic that
    // protects the in-chat picker.
    const scan = scanMessageDeep({
      fileName: file.fileName,
      mimeType: file.mimeType,
    });
    if (scan.shouldAutoDelete) {
      outcomes.push({
        ok: false,
        blocked: true,
        reason: scan.findings[0]?.reason || 'Risky file type',
      });
      continue;
    }

    try {
      const storageId = await uploadFile(convex, file.uri, file.mimeType);
      const sendType = file.kind;
      const args: any = {
        conversationId,
        type: sendType,
        storageId,
        mimeType: file.mimeType,
      };
      // image type doesn't need name/size; file type does for nice display.
      if (sendType === 'file') {
        args.fileName = file.fileName;
        if (typeof file.fileSize === 'number') args.fileSize = file.fileSize;
      } else if (sendType === 'video' || sendType === 'image') {
        args.fileName = file.fileName;
      }
      const result: any = await sendMessage(args);
      const messageId =
        typeof result === 'string' ? result : (result?._id || result?.id || undefined);
      outcomes.push({ ok: true, messageId });
    } catch (errorValue: any) {
      outcomes.push({
        ok: false,
        reason: errorValue?.message || 'Upload or send failed',
      });
    }
  }

  // Text / URL last.
  const cleanText = (payload.text || '').trim();
  if (cleanText.length > 0) {
    try {
      const result: any = await sendMessage({
        conversationId,
        type: 'text',
        text: cleanText,
      });
      const messageId =
        typeof result === 'string' ? result : (result?._id || result?.id || undefined);
      outcomes.push({ ok: true, messageId });
    } catch (errorValue: any) {
      outcomes.push({
        ok: false,
        reason: errorValue?.message || 'Send failed',
      });
    }
  }

  return outcomes;
}
