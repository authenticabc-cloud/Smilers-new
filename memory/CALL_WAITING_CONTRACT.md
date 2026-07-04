# Call Waiting — shared contract (native ⇄ web) — iter-325/327

Goal: while User A is on an active 1:1 call (call #1), a second call (call #2)
arrives. A must be offered 4 choices without losing call #1:

  (a) End current & Accept incoming
  (b) Hold current & Accept incoming        ← true media hold
  (c) Decline incoming, continue current
  (d) Hold incoming & continue current; resume the held call when #1 ends

Twilio is OFF → all 1:1 calls use the LEGACY WebRTC stack (`/call/[conversationId]`),
Convex signaling keyed by `signaling.poll({ callId })`, and mutations
`calls.answerCall` / `calls.endCall` / `calls.declineCall`.

## Phase 1 (SHIPPED, native)
- `src/lib/call/activeCallRegistry.ts` — module singleton tracking the current
  active call so the global incoming-call listener does NOT hijack it.
- `src/push/useIncomingCallListener.ts` — bails (no navigation) when
  `hasOtherActiveCall(incomingId, incomingConv)` is true.
- `app/call/[conversationId].tsx` — subscribes to `calls.getIncomingCall`,
  detects a genuine SECOND ringing call, renders `CallWaitingOverlay`.
- Options wired: (a) End & Accept  → `handleHangup()` then
  `router.push('/call/<conv2>?...&answer=1')` (auto-answers), (c) Decline →
  `declineCall({ callId: call2 })`.

## Phase 2 (TRUE HOLD — options b & d) — REQUIRES DECISION

Each call already has an INDEPENDENT signaling channel (`signaling.poll({callId})`),
so two concurrent WebRTC sessions are technically possible on the client.

### "Hold" definition (media)
A held call keeps its RTCPeerConnection ALIVE but silent:
- local audio track `.enabled = false` (mic muted)
- local video track `.enabled = false` (camera paused)
- remote audio track `.enabled = false` (we don't hear them)
- UI shows "On hold" + a Resume/Swap affordance
- InCallManager (mobile audio session) stays owned by the FOREGROUND (non-held)
  call only — the held call has no audio, so there is no device-audio conflict.

### Swap / resume
- (b) Hold #1, answer #2 → #2 becomes foreground, #1 held. Tapping the held
  banner swaps (hold #2, resume #1).
- (d) Answer #2 into HELD state, #1 stays foreground. When #1 ends
  (`status: ended`), auto-resume #2 (unmute + bring foreground).

### OPEN QUESTION for the web agent
Does the shared Convex backend need an explicit HOLD state, or is hold purely a
CLIENT-side media concern?
- If purely client-side (recommended): NO backend change needed. Each client
  independently mutes its own tracks; the remote simply hears silence. Both
  web + native implement identical media-hold locally. The `calls` row stays
  `active` for both #1 and #2.
- If a visible "On hold" indicator must be shown to the OTHER party, the
  backend needs a `calls.setHold({ callId, held: boolean })` mutation + a
  `held` field on the calls row that both clients render.

RECOMMENDATION: implement hold as a CLIENT-side media concern (no backend
dependency, no new signaling), and (optionally, later) add a `held` flag purely
for the "other party sees On hold" cosmetic.
