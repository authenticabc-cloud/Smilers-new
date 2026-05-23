# Convex Backend Instructions — Voice & Video Calls: Answer Crash Fix

## Symptom

When a user receives an incoming voice or video call and taps **Answer**,
the mobile app crashes (or freezes with a black screen and no audio/video
ever flows). The mobile WebRTC plumbing is already in place
(`/app/frontend/src/lib/webrtc/CallSession.ts`); the failure is happening
in the **signaling / call-state handoff** between the two clients.

## Root cause analysis (best guess from mobile logs)

The mobile client calls `api.calls.answerCall({ callId })` on tap, then
expects:

1. The call row's `status` to transition `"ringing" → "active"` so the
   caller's live query sees the answer and runs `setRemoteDescription`.
2. The `api.signaling.send` exchange (`offer` from caller → `answer` from
   callee → `iceCandidate` from both sides) to flow without dropped
   messages.
3. The Convex `api.calls.getActiveCall` (or equivalent) live query to
   re-emit the call row with `status: "active"` so both clients pull the
   peer's `userId` for the WebRTC peer-connection setup.

When any of the above fails partially:
* The mobile callee's `answerCall` resolves but the caller-side never
  re-renders → the callee renders the call screen but no remote stream
  arrives, then the WebRTC session times out and React throws because
  `remoteStreamURL` becomes a stale reference.
* If `answerCall` throws on the server (e.g. validator rejects an
  already-answered call), the mobile catch-block today just `console.warn`s
  and continues into the call screen — leading to a "phantom" call that
  immediately crashes when the peer connection can't negotiate.

## Backend changes required

### 1. Make `api.calls.answerCall` **idempotent and forgiving**

```ts
export const answerCall = mutation({
  args: { callId: v.string() },
  handler: async (ctx, { callId }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");

    const call = await ctx.db
      .query("calls")
      .withIndex("by_callId", (q) => q.eq("callId", callId))
      .unique();
    if (!call) {
      // Don't throw — the call may have been cleaned up by the caller already.
      return { status: "missing" } as const;
    }
    if (call.calleeUserId !== user._id) {
      throw new Error("Not authorised to answer this call");
    }

    // Idempotent: already-answered just returns active.
    if (call.status === "active") {
      return { status: "active", callId } as const;
    }
    if (call.status === "ended" || call.status === "declined" || call.status === "missed") {
      return { status: call.status } as const;
    }

    await ctx.db.patch(call._id, {
      status: "active",
      answeredAt: Date.now(),
    });

    // Bump signaling channel so caller picks up "answered" event on its
    // live query (ensure the index supports listening on by-callId).
    return { status: "active", callId } as const;
  },
});
```

Key fixes:
* **Don't throw** when the call row is gone — return `{status:"missing"}`.
* **Idempotent** — re-tapping Answer just returns the active state.
* **Persists `answeredAt`** so the mobile can show a stable "Connected" timer.

### 2. Ensure `api.calls.getActiveCall` is a **live query**

Whatever query the mobile uses to track the current call (probably
`getActiveCall` or `getCallById`) MUST be a Convex `query` (not an
action) and re-emit when `status` changes. Both clients listen on it via
`useQuery` and trigger their WebRTC steps as soon as `status === "active"`.

If today it's only re-emitting on the **callee's** side, also index by
`callerUserId` so the caller's `useQuery` sees the transition too:

```ts
.index("by_callId", ["callId"])
.index("by_caller", ["callerUserId", "status"])
.index("by_callee", ["calleeUserId", "status"])
```

### 3. `api.signaling.send` should be **forgiving on race conditions**

If the offer/answer arrives before the call row transitions to active
(common when the network is fast), the mutation must NOT throw a "call
not active" error. Accept the message, store it, and let the caller's
peer side drain it as soon as it's ready.

```ts
export const send = mutation({
  args: {
    callId: v.string(),
    type: v.union(
      v.literal("offer"),
      v.literal("answer"),
      v.literal("iceCandidate"),
    ),
    payload: v.string(),
  },
  handler: async (ctx, { callId, type, payload }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");
    await ctx.db.insert("callSignaling", {
      callId,
      fromUserId: user._id,
      type,
      payload,
      consumed: false,
      createdAt: Date.now(),
    });
  },
});
```

No call-row lookup inside `send` — just append. The live `subscribe`
query (subscribe to `callSignaling.by_callId where fromUserId != me and
consumed == false`) does the validation client-side.

### 4. Add `api.calls.heartbeat({ callId })` (optional but recommended)

Every 5–10s while in an active call the mobile pings:

```ts
export const heartbeat = mutation({
  args: { callId: v.string() },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.query("calls").withIndex("by_callId", (q) => q.eq("callId", callId)).unique();
    if (!call || call.status !== "active") return;
    await ctx.db.patch(call._id, { lastHeartbeat: Date.now() });
  },
});
```

A scheduled function (`cronJobs.interval("60s")`) marks calls with
`lastHeartbeat < now - 60_000` as `ended` so dead calls clean themselves
up — preventing the "phantom call" state that's currently crashing the
mobile when it boots up to a zombie row.

### 5. `api.calls.endCall` must also be idempotent

Same pattern as `answerCall`: don't throw if already ended, don't throw
if the row is gone. Mobile already wraps the call in try/catch but the
unhandled promise rejection still bubbles into the React error boundary
on some Android builds.

```ts
export const endCall = mutation({
  args: { callId: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { callId, reason }) => {
    const call = await ctx.db
      .query("calls")
      .withIndex("by_callId", (q) => q.eq("callId", callId))
      .unique();
    if (!call) return null;
    if (call.status === "ended") return null;
    await ctx.db.patch(call._id, {
      status: "ended",
      endedAt: Date.now(),
      endReason: reason || "user_ended",
    });
    return null;
  },
});
```

---

## Schema

```ts
calls: defineTable({
  callId: v.string(),
  callerUserId: v.id("users"),
  calleeUserId: v.id("users"),
  type: v.union(v.literal("voice"), v.literal("video")),
  status: v.union(
    v.literal("ringing"),
    v.literal("active"),
    v.literal("ended"),
    v.literal("declined"),
    v.literal("missed"),
  ),
  createdAt: v.number(),
  answeredAt: v.optional(v.number()),
  endedAt: v.optional(v.number()),
  endReason: v.optional(v.string()),
  lastHeartbeat: v.optional(v.number()),
})
  .index("by_callId", ["callId"])
  .index("by_caller", ["callerUserId", "status"])
  .index("by_callee", ["calleeUserId", "status"]),

callSignaling: defineTable({
  callId: v.string(),
  fromUserId: v.id("users"),
  type: v.union(
    v.literal("offer"),
    v.literal("answer"),
    v.literal("iceCandidate"),
  ),
  payload: v.string(),
  consumed: v.boolean(),
  createdAt: v.number(),
}).index("by_callId", ["callId", "consumed"]),
```

---

## Mobile-side guarantees already in place

* The mobile call screen wraps `answerCall` in `try / catch` and
  surfaces a friendly alert if the mutation throws — but the underlying
  React tree still crashes when the WebRTC peer can't negotiate. The
  idempotent fixes above prevent that path entirely.
* The mobile already does `cleanupSignaling({ callId })` on
  end/decline; with idempotent backend mutations, double-cleanup calls
  are safe.
* The mobile WebRTC session (`/app/frontend/src/lib/webrtc/CallSession.ts`)
  already has a 30s ICE-gathering timeout that ends the call gracefully
  if no remote candidates arrive — the heartbeat (4) closes the loop on
  the backend side.

---

## Smoke test the web team can run before declaring "fixed"

1. Caller initiates a video call → callee's mobile rings.
2. Callee taps Answer rapidly (3 taps in a row) — `answerCall` must be
   idempotent and the second/third tap must NOT throw.
3. Caller closes the app while callee is mid-answer — backend marks the
   call as ended after 60s via heartbeat cron, both sides see it as
   `"ended"` on next live-query emission. Mobile screens dismiss
   gracefully.
4. Network blips mid-call: mobile keeps pinging `heartbeat`; backend
   keeps `lastHeartbeat` fresh; on reconnect the call state remains
   `active`.
5. Caller hangs up before callee accepts: backend marks the row
   `ended`/`missed`. Callee's incoming-call modal dismisses without a
   crash.
