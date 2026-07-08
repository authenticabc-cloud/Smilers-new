/**
 * activeCallRegistry — a tiny module-level singleton that tracks whether the
 * user is CURRENTLY on an active 1:1 call screen, and which call/conversation
 * it is.
 *
 * Why: the global `useIncomingCallListener` deep-links to the incoming-call /
 * call screen the instant a new "ringing" record appears. When the user is
 * ALREADY on a call, that navigation would yank them off the ongoing call
 * (a broken experience). With this registry the listener can detect "I'm
 * already in a call" and defer to the active call screen, which renders an
 * in-call "Call Waiting" overlay instead (see app/call/[conversationId].tsx).
 */

export type ActiveCallInfo = {
  callId: string | null;
  conversationId: string | null;
};

let current: ActiveCallInfo | null = null;
const listeners = new Set<(info: ActiveCallInfo | null) => void>();

export function setActiveCall(info: ActiveCallInfo | null): void {
  current = info && (info.callId || info.conversationId) ? info : null;
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch {
      /* ignore listener errors */
    }
  });
}

export function getActiveCall(): ActiveCallInfo | null {
  return current;
}

/** True when the user is on an active call whose id/conversation differs from
 *  the supplied incoming candidate (i.e. a genuine SECOND call). */
export function hasOtherActiveCall(
  incomingCallId: string | null | undefined,
  incomingConversationId: string | null | undefined,
): boolean {
  if (!current) return false;
  const sameCall =
    !!incomingCallId && !!current.callId && String(incomingCallId) === String(current.callId);
  const sameConv =
    !!incomingConversationId &&
    !!current.conversationId &&
    String(incomingConversationId) === String(current.conversationId);
  return !sameCall && !sameConv;
}

export function subscribeActiveCall(fn: (info: ActiveCallInfo | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
