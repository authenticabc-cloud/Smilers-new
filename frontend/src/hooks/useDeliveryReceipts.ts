/**
 * useDeliveryReceipts — global "delivered" (GREEN dot) marker.
 *
 * EXACT port of the web app's global delivery component (verified from the
 * deployed web bundle):
 *
 *   function Ure() {
 *     const e = useQuery(messages.getUnreadCounts, {});   // { convId: count }
 *     const a = useMutation(messages.markDelivered);
 *     const s = useRef({});
 *     useEffect(() => {
 *       if (!e) return;
 *       const r = s.current;
 *       for (const [n, i] of Object.entries(e)) {
 *         const l = r[n] ?? 0;
 *         if (i > l) a({ conversationId: n }).catch(() => {});
 *       }
 *       s.current = { ...e };
 *     }, [e, a]);
 *   }
 *
 * It subscribes to per-conversation unread counts and, whenever a count
 * INCREASES (a new incoming message arrived), marks that conversation
 * delivered — regardless of which screen the user is on. This is why the web
 * shows yellow (sent) → green (delivered) → blue (read); mobile was stuck on
 * yellow because nothing populated `deliveredTo` until the chat was opened.
 *
 * Mounted once near the top of the authenticated tree (PresenceHeartbeat).
 */

import { useEffect, useRef } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';

export function useDeliveryReceipts() {
  const { isAuthenticated } = useAuth();
  const unreadCounts = useQuery(
    (api as any).messages.getUnreadCounts,
    isAuthenticated ? {} : 'skip',
  ) as Record<string, number> | undefined;
  const markDelivered = useMutation((api as any).messages.markDelivered);
  const prevRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!unreadCounts || !markDelivered) return;
    const prev = prevRef.current;
    for (const [conversationId, count] of Object.entries(unreadCounts)) {
      const before = prev[conversationId] ?? 0;
      if ((count as number) > before) {
        try {
          (markDelivered as any)({ conversationId }).catch(() => {});
        } catch {
          /* swallow */
        }
      }
    }
    prevRef.current = { ...unreadCounts };
  }, [unreadCounts, markDelivered]);
}
