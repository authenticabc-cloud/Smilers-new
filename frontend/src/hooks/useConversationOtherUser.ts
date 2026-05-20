import { useConvex } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../convexApi';

/**
 * Returns the "other user" object for a direct conversation, hydrated with
 * the full user profile (name, avatar, phone, email, isOnline, lastSeen, …).
 *
 * IMPORTANT: This hook resolves the other user **imperatively** via
 * `convex.query(...)` inside a useEffect, NOT via `useQuery`. Using
 * `useQuery` here was found to crash the call screen for the receiver as
 * soon as they answered — Convex `useQuery` throws on render when the
 * backend call errors out for any reason (e.g. a transient auth blip
 * during the WebRTC handshake), which unmounts the entire call screen.
 * Imperative resolution lets us catch errors and gracefully degrade.
 *
 * Why this exists in the first place:
 *   The Smilers Convex backend has TWO conversation queries:
 *     - `api.conversations.listConversations` returns each conv with
 *       `otherUser` already populated (used by the web app).
 *     - `api.conversations.getConversation` (singular, by id) does NOT
 *       populate `otherUser` — it returns only the bare conversation
 *       record plus `participants: Id<"users">[]`.
 *
 *   The native chat / call screens use the singular `getConversation`,
 *   which is why the header showed "Chat" / "Unknown" instead of the
 *   actual contact name and presence. This hook bridges that gap by
 *   resolving the other participant via `api.users.getUserById`.
 */
export function useConversationOtherUser(
  conversation: any | null | undefined,
  currentUserId: string | null | undefined
): any | null {
  const convex = useConvex();

  // If the conversation already embeds otherUser (e.g. via listConversations),
  // use it directly and skip the imperative lookup entirely.
  const embedded = useMemo(() => {
    if (
      conversation?.otherUser &&
      typeof conversation.otherUser === 'object'
    ) {
      return conversation.otherUser;
    }
    return null;
  }, [conversation]);

  const otherUserId = useMemo<string | null>(() => {
    if (embedded) return null;
    if (!conversation) return null;
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
  }, [conversation, currentUserId, embedded]);

  const [fetched, setFetched] = useState<any | null>(null);

  useEffect(() => {
    if (embedded || !otherUserId) {
      // Nothing to resolve — keep prior value
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const next = await convex.query(api.users.getUserById as any, {
          userId: otherUserId,
        });
        if (!cancelled) {
          setFetched(next || null);
        }
      } catch (errorValue: any) {
        // Backend hiccup, transient auth, deleted user, …
        // Stay silent — UI will fall back to placeholders / initials.
        if (!cancelled) {
          console.warn(
            '[useConversationOtherUser] getUserById failed:',
            errorValue?.data?.message || errorValue?.message || errorValue
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, embedded, otherUserId]);

  return embedded || fetched;
}
