import { useConvex, useQuery } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../convexApi';

/**
 * Returns the "other user" object for a direct conversation, hydrated with
 * the full user profile (name, avatar, phone, email, isOnline, lastSeen, …).
 *
 * Strategy (in order of reliability):
 *   1. If the supplied `conversation` already embeds otherUser, use it.
 *   2. Otherwise, query `api.conversations.listConversations` and find
 *      the matching conversation — per the web team's spec, this list
 *      query DOES populate `otherUser` on every direct conversation. The
 *      web app uses exactly this query.
 *   3. As a fallback, try `api.users.getUserById` with whatever
 *      participants array the conversation might expose (covers the case
 *      where `listConversations` hasn't returned yet OR uses unexpected
 *      field names).
 *
 * All non-rendering work happens through imperative `convex.query` calls
 * inside useEffect with try/catch so backend failures cannot bubble into
 * the React render tree (which would crash the chat / call screens).
 */

const PARTICIPANT_KEYS = [
  'participants',
  'participantIds',
  'memberIds',
  'userIds',
  'members',
];

function findOtherUserIdFromParticipants(
  conversation: any,
  currentUserId: string | null | undefined
): string | null {
  const me = currentUserId ? String(currentUserId) : '';
  for (const key of PARTICIPANT_KEYS) {
    const list = conversation?.[key];
    if (Array.isArray(list)) {
      for (const entry of list) {
        const id = typeof entry === 'string' ? entry : entry?._id || entry?.id;
        if (id && String(id) !== me) {
          return String(id);
        }
      }
    }
  }
  // Sometimes the backend exposes the other user's id directly
  const direct =
    conversation?.otherUserId ||
    conversation?.otherUser_id ||
    conversation?.userId ||
    null;
  return direct ? String(direct) : null;
}

export function useConversationOtherUser(
  conversation: any | null | undefined,
  currentUserId: string | null | undefined
): any | null {
  const convex = useConvex();
  const conversationId =
    conversation && (conversation._id || conversation.id) ? String(conversation._id || conversation.id) : null;

  // PATH 1 — Conversation already embeds it
  const embedded = useMemo(() => {
    if (
      conversation?.otherUser &&
      typeof conversation.otherUser === 'object'
    ) {
      return conversation.otherUser;
    }
    return null;
  }, [conversation]);

  // PATH 2 — Pull from listConversations (spec-confirmed source of otherUser).
  // This query runs only when we actually need it (no embedded otherUser).
  const conversationList = useQuery(
    api.conversations.listConversations,
    embedded ? 'skip' : ({} as any)
  ) as any[] | undefined;

  const fromList = useMemo(() => {
    if (embedded) return null;
    if (!Array.isArray(conversationList) || !conversationId) return null;
    const match = conversationList.find(
      (c: any) => String(c?._id || c?.id) === conversationId
    );
    const u = match?.otherUser;
    return u && typeof u === 'object' ? u : null;
  }, [conversationList, conversationId, embedded]);

  // PATH 3 — Fallback to getUserById via imperative query
  const [fetchedFallback, setFetchedFallback] = useState<any | null>(null);
  const fallbackUserId = useMemo(() => {
    if (embedded || fromList) return null;
    return findOtherUserIdFromParticipants(conversation, currentUserId);
  }, [conversation, currentUserId, embedded, fromList]);

  useEffect(() => {
    if (!fallbackUserId) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const next: any = await convex.query(api.users.getUserById as any, {
          userId: fallbackUserId,
        });
        if (!cancelled && next) {
          setFetchedFallback(next);
        }
      } catch (errorValue: any) {
        if (!cancelled) {
          console.warn(
            '[useConversationOtherUser] getUserById fallback failed:',
            errorValue?.data?.message || errorValue?.message || errorValue
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, fallbackUserId]);

  return embedded || fromList || fetchedFallback;
}
