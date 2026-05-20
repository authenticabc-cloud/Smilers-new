/**
 * Returns the playable/displayable URL for a Smilers chat message.
 *
 * The Convex backend's `messages.list` query auto-resolves a message's
 * `storageId` to a signed download URL and surfaces it as the `mediaUrl`
 * field on each message. The native app must read THAT field directly —
 * it must NOT try to resolve storageId via `api.files.getUrl` (which does
 * not exist on the deployment and was the cause of "stuck loading" /
 * "Message couldn't load" symptoms).
 *
 * For backwards compatibility with any messages that pre-date the
 * server-side resolution change, we also accept the legacy `fileUrl`
 * field as a fallback.
 */
export function getMessageMediaUrl(msg: any): string | null {
  if (!msg || typeof msg !== 'object') return null;
  if (typeof msg.mediaUrl === 'string' && msg.mediaUrl.length > 0) {
    return msg.mediaUrl;
  }
  if (typeof msg.fileUrl === 'string' && msg.fileUrl.length > 0) {
    return msg.fileUrl;
  }
  // Nested attachment patterns occasionally seen in older payloads
  const attachment = msg.attachment || msg.media;
  if (attachment && typeof attachment === 'object') {
    for (const field of ['mediaUrl', 'url', 'fileUrl', 'downloadUrl']) {
      const value = attachment[field];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Returns the duration of a voice / audio message in seconds.
 * The backend field is `duration`; older mobile builds used the
 * client-side name `audioDuration` so we accept that for backcompat too.
 */
export function getMessageDurationSec(msg: any): number {
  if (!msg) return 0;
  if (typeof msg.duration === 'number' && msg.duration > 0) return msg.duration;
  if (typeof msg.audioDuration === 'number' && msg.audioDuration > 0) return msg.audioDuration;
  return 0;
}
