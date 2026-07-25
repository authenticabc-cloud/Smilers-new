/**
 * ringDelivery — caller-side "did the ring reach their phone?" signal.
 *
 * When the caller fires the WebRTC ring push (`ringWebrtcCall` → POST
 * /api/calls/ring), the backend now returns whether at least one of the
 * callee's registered devices accepted the FCM doorbell. We stash that here,
 * keyed by conversationId, so the in-call screen can reassure the caller with
 * "Reached their phone ✓" instead of an ambiguous silent "Ringing…". This is a
 * DELIVERY signal (FCM accepted), not proof the callee heard it — but it tells
 * the caller the doorbell landed, which curbs the frustrated re-dialing that
 * caused overlapping calls.
 */
export type RingDelivery = {
  delivered: boolean;
  tokenCount: number;
  at: number;
};

const store = new Map<string, RingDelivery>();
const listeners = new Set<() => void>();

export function setRingDelivery(conversationId: string, value: Omit<RingDelivery, 'at'>): void {
  if (!conversationId) return;
  store.set(conversationId, { ...value, at: Date.now() });
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}

export function getRingDelivery(conversationId: string): RingDelivery | null {
  if (!conversationId) return null;
  return store.get(conversationId) || null;
}

export function clearRingDelivery(conversationId: string): void {
  if (conversationId) store.delete(conversationId);
}

/** Subscribe to any ring-delivery change. Returns an unsubscribe fn. */
export function subscribeRingDelivery(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
