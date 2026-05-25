# 🚨 URGENT Backend Contract — Mobile Blockers (Calls + Screen Share)

> **Audience:** Convex backend / web team
> **Mobile status:** Fully implemented, all defensive guards in place — only the backend pieces below are missing.
> **Why this is P0:** Two flagship features are broken end-to-end in production today.
> The mobile team has already escalated this twice; the user is now blocked.
>
> ⚡ **This is the consolidated, authoritative spec.** It supersedes the
> earlier per-feature drafts (`CONVEX_BACKEND_INSTRUCTIONS_CALL_ANSWER_FIX.md`,
> `CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE_LIST_INCOMING.md`,
> `CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE.md`). If anything below conflicts
> with those older docs, **this document wins**.

---

## TL;DR — Two backend tickets, both required

| # | Symptom | Backend change |
|---|---|---|
| **1** | Receiver's app shows red "Call ended unexpectedly" when they tap **Answer** on a regular voice/video call | Make `api.calls.answerCall` idempotent + add signaling-race tolerance + heartbeat cron. **See § A** |
| **2** | When recipient accepts a screen-share request, the call screen also shows the error fallback. Also, the **screen-share popup itself never arrives** (or arrives long after sharing ended) on the receiver. | Ship `api.screenSharing.listIncoming` + ensure `requestScreenShare` returns `conversationId` in the result. **See § B** |

After these ship, the mobile app needs **zero further changes** for these flows to work.

---

## § A — `api.calls.answerCall` is non-idempotent and signaling has races

### A.1 What the mobile sees today

Receiver taps Answer → `api.calls.answerCall({ callId })` resolves → the Convex live query for `getActiveCall` either:
- Throws a Server Error (the screenshot the user sent: `Q(conversations:getConversation) Server Error`), OR
- Returns a stale row, OR
- The signaling channel rejects the offer/answer because the call row hasn't transitioned to `active` yet.

The mobile React tree then renders the `CallErrorBoundary` fallback ("Call ended unexpectedly"), which is the defensive safety net we built — but the underlying call never connects.

### A.2 Backend changes required

#### A.2.1 Idempotent, forgiving `answerCall`

```ts
// convex/calls.ts
export const answerCall = mutation({
  args: { callId: v.string() },
  handler: async (ctx, { callId }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");

    const call = await ctx.db
      .query("calls")
      .withIndex("by_callId", (q) => q.eq("callId", callId))
      .unique();

    // Don't throw — call may already be cleaned up by the caller.
    if (!call) return { status: "missing" } as const;
    if (call.calleeUserId !== user._id)
      throw new Error("Not authorised to answer this call");

    // Idempotent: a second/third tap returns the active state, no throw.
    if (call.status === "active") return { status: "active", callId } as const;
    if (call.status === "ended" || call.status === "declined" || call.status === "missed")
      return { status: call.status } as const;

    await ctx.db.patch(call._id, { status: "active", answeredAt: Date.now() });
    return { status: "active", callId } as const;
  },
});
```

**Key invariants:**
- Re-tapping Answer **must not throw**.
- A vanished call row returns `{status:"missing"}`, not an exception.
- `answeredAt` is persisted so the mobile can render a stable timer.

#### A.2.2 `getActiveCall` must be a **live query** indexed by both peers

```ts
// convex/calls.ts
export const getActiveCall = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) return null;

    // Returns the most recent non-ended call for this conversation, where
    // the current user is EITHER the caller OR the callee. The index keeps
    // this O(log n) regardless of historical call volume.
    return await ctx.db
      .query("calls")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversationId).neq("status", "ended")
      )
      .filter((q) =>
        q.or(
          q.eq(q.field("callerUserId"), user._id),
          q.eq(q.field("calleeUserId"), user._id)
        )
      )
      .order("desc")
      .first();
  },
});
```

Required index:
```ts
.index("by_conversation_and_status", ["conversationId", "status"])
.index("by_caller", ["callerUserId", "status"])
.index("by_callee", ["calleeUserId", "status"])
```

#### A.2.3 `signaling.send` and `signaling.poll` must be race-tolerant

The offer often arrives **before** the call row transitions to `active` on a fast network. The mutation **must not throw "call not active"** — just append, let the live query drain it.

```ts
// convex/signaling.ts
export const send = mutation({
  args: {
    callId: v.string(),
    type: v.union(v.literal("offer"), v.literal("answer"), v.literal("iceCandidate")),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");
    // NO call-row lookup — just append. Validation happens client-side.
    await ctx.db.insert("callSignaling", {
      ...args,
      fromUserId: user._id,
      consumed: false,
      createdAt: Date.now(),
    });
  },
});

export const poll = query({
  args: { callId: v.string() },
  handler: async (ctx, { callId }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) return [];
    return await ctx.db
      .query("callSignaling")
      .withIndex("by_callId_and_consumed", (q) =>
        q.eq("callId", callId).eq("consumed", false)
      )
      .filter((q) => q.neq(q.field("fromUserId"), user._id))
      .order("asc")
      .take(50);
  },
});

export const markConsumed = mutation({
  args: { ids: v.array(v.id("callSignaling")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row && !row.consumed) await ctx.db.patch(id, { consumed: true });
    }
  },
});
```

Required index:
```ts
callSignaling: defineTable({...})
  .index("by_callId_and_consumed", ["callId", "consumed"])
```

#### A.2.4 Heartbeat + zombie-call cleanup cron

```ts
// convex/calls.ts
export const heartbeat = mutation({
  args: { callId: v.string() },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.query("calls")
      .withIndex("by_callId", (q) => q.eq("callId", callId)).unique();
    if (!call || call.status !== "active") return;
    await ctx.db.patch(call._id, { lastHeartbeat: Date.now() });
  },
});

// convex/crons.ts
crons.interval("zombie-call-cleanup", { seconds: 60 }, internal.calls.cleanupZombies, {});

// convex/calls.ts
export const cleanupZombies = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 90_000; // 90s without heartbeat → dead
    const stale = await ctx.db
      .query("calls")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .filter((q) => q.lt(q.field("lastHeartbeat"), cutoff))
      .collect();
    for (const c of stale) {
      await ctx.db.patch(c._id, { status: "ended", endedAt: Date.now(), endReason: "heartbeat_timeout" });
    }
  },
});
```

Mobile already pings `api.calls.heartbeat({ callId })` every 10 s while in an active call. Without the cron, zombie rows accumulate forever.

#### A.2.5 Idempotent `endCall` and `declineCall`

Same pattern as `answerCall` — both must be safe to call on an already-ended row:

```ts
export const endCall = mutation({
  args: { callId: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { callId, reason }) => {
    const call = await ctx.db.query("calls").withIndex("by_callId", q => q.eq("callId", callId)).unique();
    if (!call || call.status === "ended") return null;
    await ctx.db.patch(call._id, { status: "ended", endedAt: Date.now(), endReason: reason || "user_ended" });
    return null;
  },
});
```

### A.3 Schema for the `calls` table

```ts
calls: defineTable({
  callId: v.string(),                                   // public id used in URLs / signaling
  conversationId: v.id("conversations"),                // foreign key — see § A.2.2 index
  callerUserId: v.id("users"),
  calleeUserId: v.id("users"),
  type: v.union(v.literal("voice"), v.literal("video")),
  status: v.union(
    v.literal("ringing"),
    v.literal("active"),
    v.literal("ended"),
    v.literal("declined"),
    v.literal("missed")
  ),
  createdAt: v.number(),
  answeredAt: v.optional(v.number()),
  endedAt: v.optional(v.number()),
  endReason: v.optional(v.string()),
  lastHeartbeat: v.optional(v.number()),
})
  .index("by_callId", ["callId"])
  .index("by_conversation_and_status", ["conversationId", "status"])
  .index("by_caller", ["callerUserId", "status"])
  .index("by_callee", ["calleeUserId", "status"])
  .index("by_status", ["status"]),
```

### A.4 Smoke test (must pass before declaring "fixed")

1. **Happy path:** Caller initiates a video call → callee rings → callee taps Answer → both sides see active stream within 5 s.
2. **Idempotent answer:** Callee taps Answer 3 times rapidly — second + third taps must NOT throw, both sides still connect.
3. **Race condition:** Caller's offer arrives **before** the call row transitions to `active` — `signaling.send` must accept it; the callee's `signaling.poll` returns it as soon as they're ready.
4. **Caller force-quits mid-call:** within 90 s the heartbeat cron marks the call `ended`, callee's live query re-emits, mobile dismisses the call screen gracefully.
5. **Network blip during call:** mobile keeps pinging `heartbeat`; on reconnect the call is still `active` (lastHeartbeat ≤ 90 s).
6. **Decline:** caller hangs up before callee accepts → backend marks `missed`; callee's incoming-call modal dismisses without a crash.

---

## § B — Screen-share popup never arrives + accept causes "Call ended" fallback

### B.1 What the mobile sees today

- **Sender:** `/screen-share` route → picks a contact → calls `api.screenSharing.requestScreenShare({ conversationId })`. Mutation **succeeds** (so the backend already has the basic endpoint).
- **Recipient:** **Nothing happens.** The `IncomingScreenShareModal` polls `api.screenSharing.listIncoming` (which we suspect isn't shipped) and never sees a row. The user's report: "popup doesn't arrive. At times it arrives a long time after ending sharing."
- When the popup does arrive (rarely) and the user taps Accept, the call screen shows the red "Call ended unexpectedly" fallback. Root cause was traced (and fixed mobile-side) to the call screen querying `api.conversations.getConversation` with the screen-share **session** id instead of the real conversation id.

### B.2 Backend changes required

#### B.2.1 Ship `api.screenSharing.listIncoming` (reactive query)

```ts
// convex/screenSharing.ts — ADDITIVE; keep existing exports as-is.
export const listIncoming = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];                          // mounts before auth in some flows — don't throw

    const me = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!me) return [];

    const sessions = await ctx.db
      .query("screenSharingSessions")
      .withIndex("by_recipient_and_status",
        (q) => q.eq("recipientId", me._id).eq("status", "pending"))
      .order("desc")
      .take(10);

    return Promise.all(sessions.map(async (s) => {
      const requester = await ctx.db.get(s.requesterId);
      return {
        // EVERY field below is consumed by the mobile — please return all of them.
        _id: s._id,                                    // → modal's `shareId`
        conversationId: s.conversationId,              // → REQUIRED for accept-flow routing (see § B.2.3)
        requesterId: s.requesterId,
        requesterName: requester?.name || requester?.displayName || "Unknown",
        requesterAvatar: requester?.avatar || requester?.avatarUrl || null,
        status: s.status,                              // always "pending" here
        includeAudio: !!s.includeAudio,
        createdAt: s.createdAt ?? s._creationTime,
      };
    }));
  },
});
```

Required index:
```ts
screenSharingSessions: defineTable({...})
  .index("by_recipient_and_status", ["recipientId", "status"])
```

**Reactivity guarantee:** Because this is a Convex `query`, the mobile client auto-subscribes and re-emits whenever a row matching the filter is inserted/updated. The mobile already uses the reactive `useQuery_experimental({throwOnError:false})` wrapper — no polling, no timer needed on our side.

#### B.2.2 `requestScreenShare` must return `conversationId`

The mobile mints the URL `/call/<sessionId>?screenOnly=1&convId=<conversationId>`. We need the backend's response to include the `conversationId` we passed in, so the sender can build that URL deterministically.

```ts
export const requestScreenShare = mutation({
  args: { conversationId: v.id("conversations"), includeAudio: v.optional(v.boolean()) },
  handler: async (ctx, { conversationId, includeAudio }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");

    const conv = await ctx.db.get(conversationId);
    if (!conv) throw new Error("Conversation not found");

    // Find the other participant (direct chat case)
    const recipientId = conv.participantIds.find((id: any) => id !== user._id);
    if (!recipientId) throw new Error("No recipient");

    const sessionId = await ctx.db.insert("screenSharingSessions", {
      conversationId,
      requesterId: user._id,
      recipientId,
      status: "pending",
      includeAudio: !!includeAudio,
      createdAt: Date.now(),
    });

    return {
      sessionId,
      conversationId,                                  // ← REQUIRED in response
      status: "pending" as const,
    };
  },
});
```

#### B.2.3 `acceptScreenShare` / `declineScreenShare` — idempotent, return session row

```ts
export const acceptScreenShare = mutation({
  args: { sessionId: v.id("screenSharingSessions") },
  handler: async (ctx, { sessionId }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");
    const session = await ctx.db.get(sessionId);
    if (!session) return { status: "missing" } as const;
    if (session.recipientId !== user._id) throw new Error("Not authorised");

    if (session.status === "accepted")
      return { status: "accepted" as const, sessionId, conversationId: session.conversationId };
    if (session.status === "declined" || session.status === "ended" || session.status === "cancelled")
      return { status: session.status } as const;

    await ctx.db.patch(session._id, { status: "accepted", acceptedAt: Date.now() });
    return { status: "accepted" as const, sessionId, conversationId: session.conversationId };
  },
});

export const declineScreenShare = mutation({
  args: { sessionId: v.id("screenSharingSessions") },
  handler: async (ctx, { sessionId }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");
    const session = await ctx.db.get(sessionId);
    if (!session) return null;
    if (session.recipientId !== user._id) throw new Error("Not authorised");
    if (session.status !== "pending") return null;
    await ctx.db.patch(session._id, { status: "declined", endedAt: Date.now() });
    return null;
  },
});
```

#### B.2.4 Schema for `screenSharingSessions`

```ts
screenSharingSessions: defineTable({
  conversationId: v.id("conversations"),
  requesterId: v.id("users"),
  recipientId: v.id("users"),
  status: v.union(
    v.literal("pending"),
    v.literal("accepted"),
    v.literal("declined"),
    v.literal("ended"),
    v.literal("cancelled")
  ),
  includeAudio: v.boolean(),
  createdAt: v.number(),
  acceptedAt: v.optional(v.number()),
  endedAt: v.optional(v.number()),
})
  .index("by_recipient_and_status", ["recipientId", "status"])    // § B.2.1
  .index("by_requester_and_status", ["requesterId", "status"]),
```

### B.3 Smoke test (must pass before declaring "fixed")

1. Sender A taps Share Screen on a contact → `requestScreenShare` returns `{ sessionId, conversationId, status: "pending" }`.
2. **Within ≤ 2 s**, receiver B's `IncomingScreenShareModal` lights up showing A's name + Accept/Decline.
3. B taps Accept → modal dismisses → B navigates into the screen-share viewer (no red "Call ended" fallback).
4. A and B negotiate over `api.signaling.send` / `poll` (same channel as voice/video calls — `sessionId` is the `callId`).
5. A ends the share → both sides' live queries re-emit the row as `ended`/`cancelled`, screens dismiss.

---

## § C — What's already done on the mobile side (so you know what NOT to ship)

Everything below is **live in the build** as of June 2025 and will work seamlessly with the backend pieces above:

| Feature | Mobile file | Status |
|---|---|---|
| Incoming-screen-share popup | `src/components/IncomingScreenShareModal.tsx` | ✅ subscribes to `api.screenSharing.listIncoming` via reactive `useQuery_experimental({throwOnError:false})`; gracefully no-ops if missing |
| Sender route to call screen with `&convId=` | `app/screen-share.tsx` | ✅ |
| Receiver route to call screen with `&convId=` | `src/components/IncomingScreenShareModal.tsx` | ✅ extracts `conversationId` from session row |
| Call screen tolerant of `getConversation` failures | `app/call/[conversationId].tsx` | ✅ uses `useReactiveSafeConvexQuery` so server errors don't crash |
| `CallErrorBoundary` defense net | `src/components/CallErrorBoundary.tsx` | ✅ |
| WebRTC peer connection / signaling | `src/lib/webrtc/CallSession.ts` | ✅ |
| `api.calls.heartbeat` ping every 10 s | `app/call/[conversationId].tsx` | ✅ ready to call once shipped |
| Idempotent client-side cleanup on end / decline / unmount | `app/call/[conversationId].tsx` | ✅ |
| `expo-audio` migration for SDK 54 | `app/call/[conversationId].tsx` + `src/lib/ringtone/useRingtonePlayer.ts` | ✅ |
| Ringtone suppression in screen-only mode | `app/call/[conversationId].tsx` | ✅ |
| Auto-initiate gated on `!isScreenOnly` | `app/call/[conversationId].tsx` | ✅ |

---

## § D — Priority and rollout order

1. **First:** Ship `api.screenSharing.listIncoming` (1 query, ~30 LoC). This alone fixes the missing popup.
2. **Same release:** Ensure `requestScreenShare` returns `conversationId` and `acceptScreenShare` is idempotent. Together this unblocks the entire screen-share flow.
3. **Second release:** Ship the idempotent `answerCall` + `signaling.send/poll` race tolerance + heartbeat cron. This fixes the regular-call answer crash.
4. **Optional:** Switch `endCall` / `declineCall` / `requestSwitch` / `approveSwitch` / `declineSwitch` to the idempotent pattern for consistency.

Once §1–§3 are out, both flagship features are unblocked without any further mobile changes.

---

## § E — Where to find the existing per-feature contracts

For full historical context (already authored, kept for backward compatibility):

- `/app/CONVEX_BACKEND_INSTRUCTIONS_CALL_ANSWER_FIX.md` — original call-answer fix doc (this consolidates and supersedes it).
- `/app/CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE.md` — original screen-share flow doc.
- `/app/CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE_LIST_INCOMING.md` — original `listIncoming` doc (superseded by § B.2.1 above).
- `/app/CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE_SWITCH.md` — switch-screen-share controls (not blocking today, ship later).

---

**Open questions for the backend team:** none — the mobile contracts above are fully specified. Reply on this doc only if you hit a schema migration concern.

— Mobile team, June 2025
