function toTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return 0;
}

// Presence freshness window. A user is only shown as "online" when their
// `isOnline` flag is true AND their `lastSeen` is within this window — this
// guards against a stale/cached `isOnline: true` lingering forever after the
// user actually went away. Mirrors the server-side rule (2 minutes).
export const PRESENCE_ONLINE_WINDOW_MS = 120000;

/**
 * Canonical presence check (native-presence-stale-online-contract):
 * show online ONLY if `isOnline === true` AND a `lastSeen` timestamp exists
 * AND `(now - lastSeen) <= 120000ms`. Handles the common entity shapes
 * (raw user, contact row, or a conversation carrying `otherUser`/
 * `otherParticipant`).
 */
export function isPresenceOnline(entity: any): boolean {
  if (!entity) {
    return false;
  }

  const peer = entity?.otherUser ?? entity?.otherParticipant ?? entity;

  const onlineFlag =
    entity?.isOnline === true ||
    entity?.online === true ||
    peer?.isOnline === true ||
    peer?.online === true;

  if (!onlineFlag) {
    return false;
  }

  const lastSeen = toTimestamp(
    peer?.lastSeen ??
      entity?.lastSeen ??
      peer?.lastActiveAt ??
      entity?.lastActiveAt,
  );

  if (!lastSeen) {
    return false;
  }

  return Date.now() - lastSeen <= PRESENCE_ONLINE_WINDOW_MS;
}

export function canShowLastSeen(entity: any): boolean {
  if (!entity) {
    return true;
  }

  const explicit = [
    entity?.canSeeLastSeen,
    entity?.showLastSeen,
    entity?.privacy?.canSeeLastSeen,
    entity?.otherUser?.canSeeLastSeen,
  ].find((value) => typeof value === 'boolean');

  if (typeof explicit === 'boolean') {
    return explicit;
  }

  const privacyValue = [
    entity?.lastSeenVisibility,
    entity?.privacy?.lastSeen,
    entity?.otherUser?.privacy?.lastSeen,
  ].find((value) => typeof value === 'string');

  return privacyValue !== 'nobody';
}

export function formatLastSeenLabel(entity: any, fallback = 'last seen recently'): string {
  if (!entity) {
    return fallback;
  }

  if (isPresenceOnline(entity)) {
    return 'online';
  }

  if (!canShowLastSeen(entity)) {
    return 'last seen hidden';
  }

  const timestamp = toTimestamp(
    entity?.otherUser?.lastSeen ??
      entity?.lastSeen ??
      entity?.lastActiveAt ??
      entity?.updatedAt,
  );

  if (!timestamp) {
    return fallback;
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

  if (diffMinutes < 1) {
    return 'last seen just now';
  }

  if (diffMinutes < 60) {
    return `last seen ${diffMinutes} min ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `last seen ${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `last seen ${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  }

  return `last seen ${new Date(timestamp).toLocaleDateString()}`;
}
