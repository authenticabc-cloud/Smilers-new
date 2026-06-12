# WEB AGENT — Screen Share `sendSignal` Server Error (URGENT)

> Hand this doc to the web app agent. The mobile side of screen sharing is
> now fully working up to the signaling step: capture starts, the Android
> MediaProjection picker appears, the WebRTC offer + ICE candidates are
> created. But **every** `screenSharing.sendSignal` mutation call returns a
> generic Convex **Server Error** — including AFTER the receiver accepted
> the request — so the offer never reaches the viewer and the receiver
> hangs on "Connecting to screen…".

## Evidence from a real device session (2026-06-12)

Sharer-side debug log (mobile app):

```
14:01:58  CALL  startPeerConnection begin (screen-only sharer)
14:02:01  CALL  display media acquired (MediaProjection OK)
14:02:02  SIG   → offer rejected — queued, retrying every 2.5s until the
                recipient accepts. Backend said: [CONVEX M(screenSharing:sendSignal)]
                [Request ID: …] Server Error
14:02:05+ SIG   → offer rejected (same error, every 2.5s retry)
          …continues failing for 60s+ WHILE the receiver was already on the
          "Watching shared screen / Connecting to screen…" screen (i.e. the
          receiver HAD accepted via screenSharing.acceptScreenShare — that
          mutation succeeded).
```

Key facts:
- `screenSharing.requestScreenShare` works (returns an id; the receiver gets
  the incoming-share modal).
- `screenSharing.acceptScreenShare` works (receiver transitions to viewer).
- `screenSharing.sendSignal` throws an UNCAUGHT error server-side — Convex
  masks it as "Server Error" with no detail. It fails both BEFORE and AFTER
  acceptance.

## Exactly what the mobile app sends

```ts
// sharer → viewer (offer + ICE), viewer → sharer (answer + ICE)
await convex.mutation(api.screenSharing.sendSignal, {
  sessionId: "<the id returned by requestScreenShare>", // SAME id the receiver
                                                        // used in acceptScreenShare
  toUserId:  "<the OTHER party's Convex users _id>",
  type:      "offer" | "answer" | "ice-candidate",
  payload:   "<JSON.stringify'd SDP or ICE candidate>",  // string
});
```

The viewer polls/subscribes via `api.screenSharing.pollSignals` and marks
consumed via `api.screenSharing.markSignalsConsumed` (those names exist —
they do not throw).

## What we need from you

1. **Open `convex/screenSharing.ts` and inspect `sendSignal`.** Find the
   uncaught throw. Most likely candidates:
   - `ctx.db.get(args.sessionId)` typed to a different table than the id we
     pass (we pass the id returned by `requestScreenShare` — if accept
     creates a SEPARATE `screenShareSessions` row and `sendSignal` expects
     THAT id, that's the mismatch).
   - A status guard that throws for non-"active" sessions (it must accept
     signals for BOTH `pending` and `accepted/active` — WebRTC offers are
     created by the sharer immediately).
   - An args validator mismatch (e.g. `v.id("...")` vs the string we send,
     or a `v.union(v.literal("offer"), v.literal("answer"), v.literal("iceCandidate"))`
     that doesn't include `"ice-candidate"` with a dash).
2. **Make `sendSignal` accept the contract above**, or reply with the exact
   corrected contract (function name + args + which id to use) and we'll
   match it on mobile within minutes.
3. **Wrap internal errors in `ConvexError` with a `code`** so the mobile
   debug overlay can show the real reason instead of "Server Error".

## Acceptance test

Two phones: A requests screen share to B → B accepts → within ~3 seconds
A's queued offer must be ACCEPTED by `sendSignal` (HTTP success), B receives
it via `pollSignals`, sends back an `answer`, and the stream renders.
