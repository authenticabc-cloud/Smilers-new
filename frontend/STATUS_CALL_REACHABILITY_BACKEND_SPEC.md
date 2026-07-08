# Backend spec (OPTIONAL upgrade) — bulletproof "Ringing / Not Ringing"

**Owner:** Convex backend (`calls` table). This is an OPTIONAL accuracy upgrade.
The mobile client already ships a presence-based version (see below) that works
for the common cases (callee device off / no internet). Implement this only if
you want it to also correctly show "Ringing" for a callee whose app is
backgrounded but still reachable via push.

## What the client does today (no backend change needed)
During an outgoing ringing call, the caller shows:
- **"Ringing...."** — when the callee's presence says online (`isOnline === true`)
  or presence is unknown.
- **"Not Ringing"** — when the callee's presence is explicitly offline
  (`isOnline === false`), i.e. device off / no internet / app not connected.

Presence comes from the existing `api.users.getUserById` (`isOnline`, `lastSeen`)
— the same signal the chat header's online dot uses.

## Optional upgrade: a real callee "ringing" ack

### 1. Schema — add one field to the `calls` table
```ts
calls: defineTable({
  // …existing fields…
  calleeRingingAt: v.optional(v.number()), // set when the callee's device
                                            // actually starts ringing
})
```

### 2. Mutation — callee marks the call as ringing on their device
```ts
export const markCalleeRinging = mutation({
  args: { callId: v.string() },
  handler: async (ctx, { callId }) => {
    const me = await getCurrentUser(ctx);          // callee
    const call = await ctx.db.query("calls")
      .withIndex("by_callId", q => q.eq("callId", callId)).unique();
    if (!call || call.status !== "ringing") return;
    if (String(call.calleeUserId) !== String(me._id)) return; // only the callee
    if (!call.calleeRingingAt) {
      await ctx.db.patch(call._id, { calleeRingingAt: Date.now() });
    }
  },
});
```

### 3. `getActiveCall` — return `calleeRingingAt`
Ensure the live query that the caller subscribes to includes `calleeRingingAt`
in its returned object so the caller updates reactively.

### Client wiring (mobile — done on our side once the above exists)
- **Callee:** when the incoming-call live query first fires (and/or when the
  device is woken by the call push), call `api.calls.markCalleeRinging({ callId })`.
- **Caller:** prefer the ack over presence:
  - `calleeRingingAt` present → **"Ringing...."**
  - no ack after ~6–8s of ringing → **"Not Ringing"**
  - falls back to the presence heuristic when the field is absent.

### Verify
- Callee online + foreground → caller sees "Ringing....".
- Callee phone off / airplane mode → caller sees "Not Ringing".
- Callee backgrounded but push-reachable → after they’re woken, caller flips to
  "Ringing...." (this is the case presence-only can't cover).
