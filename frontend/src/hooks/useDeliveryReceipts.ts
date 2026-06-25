/**
 * useDeliveryReceipts — global "delivered" (GREEN dot) marker.
 *
 * Problem this solves: the recipient previously only called
 * `markDelivered` from inside the open chat (same moment as `markRead`),
 * so the status jumped straight from YELLOW (sent) to BLUE (read) and the
 * GREEN (delivered) phase was never observable by the sender. The push
 * "received" listener also only fires in the FOREGROUND and the background
 * task can't run a Convex mutation reliably.
 *
 * Web parity: the web client keeps a live Convex subscription open at all
 * times, so any incoming message is marked delivered immediately. We mirror
 * that by mounting this hook ONCE near the top of the authenticated tree
 * (alongside the presence heartbeat). While the app is foreground +
 * authenticated, it watches `listConversations` and calls
 * `messages.markDelivered({ conversationId })` whenever a conversation's
 * last-message time advances — regardless of which screen the user is on.
 *
 * `markDelivered` excludes the sender server-side, so marking my own
 * conversations is a harmless no-op. Calls are de-duped per conversation by
 * last-message time so we don't spam the backend on every render.
 */

import { useEffect, useRef } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';

export function useDeliveryReceipts() {
  const { isAuthenticated } = useAuth();
  const conversations = useQuery(
    api.conversations.listConversations,
    isAuthenticated ? {} : 'skip',
  ) as any[] | undefined;
  const markDelivered = useMutation((api as any).messages?.markDelivered);
  const sigRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!isAuthenticated || !markDelivered || !Array.isArray(conversations)) return;
    conversations.forEach((c: any) => {
      const id = String(c?._id || c?.id || '');
      if (!id) return;
      const t = Number(c?.lastMessageTime || c?.lastMessageAt || c?.updatedAt || 0);
      // Re-mark whenever the latest message advances (a new incoming message
      // bumps lastMessageTime). For deployments where the field is absent the
      // signature stays 0 → we still mark once on first sight.
      if (sigRef.current.get(id) === t) return;
      sigRef.current.set(id, t);
      try {
        (markDelivered as any)({ conversationId: id }).catch(() => {});
      } catch {
        /* swallow */
      }
    });
  }, [conversations, markDelivered, isAuthenticated]);
}
