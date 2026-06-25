/**
 * Seamless 1:1 → ad-hoc-conference handoff registry.
 *
 * When a 1:1 call is upgraded to a multi-party (mesh) call, we MUST keep the
 * already-connected A↔B `RTCPeerConnection` alive instead of tearing it down
 * and re-negotiating (the web app does the same — see
 * native-adhoc-multiparty-call-contract.json §"seamless handoff"). A rebuilt
 * connection would carry a new DTLS fingerprint, which the peer that adopted
 * the original `pc` cannot accept on a live connection → the pair would break.
 *
 * Because the mesh runs on a different screen (`/group-call`) than the 1:1
 * call (`/call`), this module-level slot carries the live `pc` + media across
 * the screen transition without closing it. The 1:1 engine relinquishes
 * ownership via `CallSession.detachForHandoff()` (so its unmount cleanup won't
 * stop the tracks), stashes here, then the mesh host adopts it on mount.
 */

type Any = any;

export interface CallHandoff {
  callId: string;
  /** The original 1:1 partner's user id — adopted as an already-connected peer. */
  partnerUserId: string;
  pc: Any;
  localStream: Any;
  remoteStream: Any;
  video: boolean;
  ts: number;
}

let pending: CallHandoff | null = null;

/** Stash the live 1:1 connection for the mesh host to adopt. */
export function stashCallHandoff(h: Omit<CallHandoff, 'ts'>): void {
  pending = { ...h, ts: Date.now() };
}

/**
 * Claim a stashed handoff for `callId` (one-shot). Returns null if there's no
 * match or it's stale (>15s — the transition should take well under a second).
 */
export function takeCallHandoff(callId: string): CallHandoff | null {
  if (pending && pending.callId === callId && Date.now() - pending.ts < 15000) {
    const h = pending;
    pending = null;
    return h;
  }
  return null;
}

export function hasPendingHandoff(callId: string): boolean {
  return !!(pending && pending.callId === callId && Date.now() - pending.ts < 15000);
}

export function clearCallHandoff(): void {
  pending = null;
}
