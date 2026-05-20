import { useQuery } from 'convex/react';
import { useMemo } from 'react';
import { api } from '../convexApi';

/**
 * Returns the "other user" object for a direct conversation, hydrated with
 * the full user profile (name, avatar, phone, email, isOnline, lastSeen, …).
 *
 * Why this exists:
 *   The Smilers Convex backend has TWO conversation queries:
 *     - `api.conversations.listConversations` returns each conv with
 *       `otherUser` already populated (used by the web app for chat lists).
 *     - `api.conversations.getConversation` (singular, by id) does NOT
 *       populate `otherUser` — it returns only the bare conversation record
 *       plus the `participants: Id<"users">[]` array.
 *
 *   The native chat / call screens use the singular `getConversation`,
 *   which is why the header showed "Chat" / "Unknown" instead of the
 *   actual contact name and online status. This hook bridges that gap by
 *   resolving the other participant via `api.users.getUserById`, which
 *   returns the user record with staleness-corrected `isOnline` and
 *   `lastSeen`.
 */
export function useConversationOtherUser(
  conversation: any | null | undefined,
  currentUserId: string | null | undefined
): any | null {
  const otherUserId = useMemo<string | null>(() => {
    if (!conversation) return null;

    // 1) Some conversation responses may already include otherUser — short-circuit
    const embedded = conversation.otherUser;
    if (embedded && typeof embedded === 'object') {
      // Caller will see the fully-hydrated `embedded` directly below
      return null;
    }

    // 2) Otherwise, derive the other participant from the participants array
    const participants = Array.isArray(conversation.participants)
      ? conversation.participants
      : [];
    const me = currentUserId ? String(currentUserId) : '';
    for (const id of participants) {
      const stringId = String(id);
      if (stringId && stringId !== me) {
        return stringId;
      }
    }
    return null;
  }, [conversation, currentUserId]);

  const fetched = useQuery(
    api.users.getUserById,
    otherUserId ? { userId: otherUserId as any } : 'skip'
  ) as any | null | undefined;

  return useMemo(() => {
    if (conversation?.otherUser && typeof conversation.otherUser === 'object') {
      return conversation.otherUser;
    }
    return fetched || null;
  }, [conversation?.otherUser, fetched]);
}
