/**
 * Resolves whether the current authenticated user is currently suspended in a
 * given group conversation. Slice B of the Groups spec — suspended users are
 * spectators only: they can still see new messages but cannot send, react,
 * or reply.
 *
 * Data source preference order:
 *   1. `conversation.viewerSuspendedUntil` — best, the backend already
 *      knows who the viewer is and pre-computes the timestamp.
 *   2. `conversation.memberRecords` (or `.members` / `.participants`) — scan
 *      for an entry whose `userId` matches the current user and read
 *      `suspendedUntil`.
 *   3. `conversation.suspendedMembers` — array of `{ userId, suspendedUntil }`.
 *
 * Returns `null` for direct (non-group) chats and unsuspended users so the
 * caller can gate the banner/composer with a simple truthiness check.
 */

import { useMemo } from 'react';

export interface ViewerSuspensionInfo {
  expiresAt: number;
  msRemaining: number;
  label: string;
}

function asTimestamp(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function findSuspendedUntilInList(list: any[] | undefined, viewerUserId: string | null): number | null {
  if (!Array.isArray(list) || !viewerUserId) return null;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const uid = String(entry.userId || entry._id || entry.id || '');
    if (uid !== viewerUserId) continue;
    const stamp = asTimestamp(entry.suspendedUntil || entry.suspendedUntilAt);
    if (stamp) return stamp;
  }
  return null;
}

function formatSuspensionLabel(msRemaining: number, expiresAt: number): string {
  if (msRemaining <= 0) return '';
  const hours = Math.floor(msRemaining / 3_600_000);
  const days = Math.floor(msRemaining / 86_400_000);
  if (days >= 1) {
    const date = new Date(expiresAt);
    const dateLabel = `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    return `Suspended · spectator mode · until ${dateLabel} (${days}d left)`;
  }
  if (hours >= 1) return `Suspended · spectator mode · ${hours}h left`;
  const minutes = Math.max(1, Math.ceil(msRemaining / 60_000));
  return `Suspended · spectator mode · ${minutes}m left`;
}

export function useViewerSuspension(
  conversation: any,
  viewerUserId: string | null | undefined,
): ViewerSuspensionInfo | null {
  return useMemo(() => {
    if (!conversation) return null;
    if (conversation.type && conversation.type !== 'group') return null;
    const viewerId = viewerUserId ? String(viewerUserId) : null;

    let expiresAt: number | null = asTimestamp(conversation.viewerSuspendedUntil);
    if (!expiresAt && viewerId) {
      expiresAt =
        findSuspendedUntilInList(conversation.memberRecords, viewerId) ||
        findSuspendedUntilInList(conversation.members, viewerId) ||
        findSuspendedUntilInList(conversation.participants, viewerId) ||
        findSuspendedUntilInList(conversation.suspendedMembers, viewerId);
    }

    if (!expiresAt) return null;
    const msRemaining = expiresAt - Date.now();
    if (msRemaining <= 0) return null;

    return {
      expiresAt,
      msRemaining,
      label: formatSuspensionLabel(msRemaining, expiresAt),
    };
  }, [conversation, viewerUserId]);
}
