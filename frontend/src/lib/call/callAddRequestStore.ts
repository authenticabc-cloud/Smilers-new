/**
 * callAddRequestStore — bridges the silent `call-add-request` control push to
 * the in-call UI. A non-admin's "Request to add X" fires a data-only push to
 * every group admin; the push handler drops the parsed request in here, and the
 * live <CallUI> (StreamCallInner) subscribes to surface an Approve / Decline
 * banner to whichever admin(s) are on the call. Mirrors ringDelivery.ts.
 */
export interface PendingAddRequest {
  streamRoom: string;
  conversationId: string;
  requesterIdentity: string;
  requesterName: string;
  targetIdentity: string;
  targetName: string;
  targetPhone: string;
  addPermanently: boolean;
  isVideo: boolean;
  receivedAt: number;
}

let current: PendingAddRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}

export function pushAddRequest(req: Omit<PendingAddRequest, 'receivedAt'>): void {
  if (!req?.streamRoom || !req?.targetIdentity) return;
  current = { ...req, receivedAt: Date.now() };
  emit();
}

export function clearAddRequest(): void {
  current = null;
  emit();
}

export function getAddRequest(): PendingAddRequest | null {
  return current;
}

export function subscribeAddRequest(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
