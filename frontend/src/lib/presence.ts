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

  if (entity?.online || entity?.isOnline || entity?.otherUser?.online || entity?.otherUser?.isOnline) {
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
