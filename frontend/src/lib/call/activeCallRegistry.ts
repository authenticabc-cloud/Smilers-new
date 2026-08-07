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

// ── "Answered recently" registry ──────────────────────────────────────────
// The missed-call listener (useIncomingCallListener) fires a missed-call
// notification when a ringing record disappears and its own `userAnsweredRef`
// is false. But that ref is ONLY set on the Twilio/WebRTC foreground answer
// path — a call answered from the native notification "Answer" button or via
// the Stream in-app UI bypasses it, so a genuinely-answered call that then
// ends looked "unanswered" and produced a FALSE missed-call push.
//
// Any call screen that goes active records itself here (via setActiveCall).
// The missed-call listener then consults `wasCallAnsweredRecently()` as a
// reliable cross-path signal: if a screen was active for this call/conversation
// within the TTL, it was answered → suppress the missed-call.
const answeredRecently = new Map<string, number>();
const ANSWERED_TTL_MS = 120000; // 2 min — well past the 5s missed-call debounce.

function pruneAnswered(): void {
  const now = Date.now();
  for (const [key, ts] of answeredRecently) {
    if (now - ts > ANSWERED_TTL_MS) answeredRecently.delete(key);
  }
}

export function markCallAnswered(
  callId: string | null | undefined,
  conversationId: string | null | undefined,
): void {
  const now = Date.now();
  if (callId) answeredRecently.set(`call:${callId}`, now);
  if (conversationId) answeredRecently.set(`conv:${conversationId}`, now);
  pruneAnswered();
}

export function wasCallAnsweredRecently(
  callId: string | null | undefined,
  conversationId: string | null | undefined,
): boolean {
  pruneAnswered();
  const now = Date.now();
  const byCall = callId ? answeredRecently.get(`call:${callId}`) : undefined;
  const byConv = conversationId ? answeredRecently.get(`conv:${conversationId}`) : undefined;
  const ts = Math.max(byCall || 0, byConv || 0);
  return !!ts && now - ts <= ANSWERED_TTL_MS;
}

export function setActiveCall(info: ActiveCallInfo | null): void {
  current = info && (info.callId || info.conversationId) ? info : null;
  // A call becoming active means it was answered/started — record it so the
  // missed-call listener can tell "hung up after answering" apart from a
  // genuinely missed ring, regardless of WHICH answer path was taken.
  if (current) markCallAnswered(current.callId, current.conversationId);
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
