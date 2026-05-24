# Backend Contract — `api.screenSharing.listIncoming`

The native mobile app needs **one additional query** in the existing `convex/screenSharing.ts` module so the global "X wants to share their screen with you" modal can light up across the app (not only inside the specific conversation).

All other screen-sharing endpoints already shipped — the native app is updated to use them. This is the **last missing piece**.

---

## Endpoint

**Path:** `api.screenSharing.listIncoming`
**Type:** `query`
**Args:** `{}` (no arguments)

**Returns:** `Array` of pending sessions where the caller is the **recipient**, enriched with requester info. Empty array if none.

```ts
Array<{
  _id: Id<"screenSharingSessions">,          // session id (will be passed back as `sessionId`)
  conversationId: Id<"conversations">,
  requesterId: Id<"users">,
  requesterName: string,                      // resolved from users table
  requesterAvatar?: string | null,            // optional avatar URL
  status: "pending",                          // always "pending" — see filter below
  createdAt: string,                          // ISO timestamp
  includeAudio?: boolean,                     // pass through if you store it
}>
```

---

## Behavior

1. Get the current user via `ctx.auth.getUserIdentity()` → look up user by `by_token` index.
   - If unauthenticated → return `[]` (don't throw — the modal mounts before auth in some flows).
2. Query `screenSharingSessions` table where:
   - `recipientId === currentUserId`
   - `status === "pending"`
3. For each session, look up the `requesterId` in `users` and attach `requesterName` + `requesterAvatar`.
4. Sort by `createdAt` descending (newest first) so the modal shows the most recent request.
5. Optional: limit to last 10 to keep the query light.

---

## Index requirement

If `screenSharingSessions` doesn't already have one, add:

```ts
.index("by_recipient_and_status", ["recipientId", "status"])
```

Without this the table scan will get slow with many historical sessions.

---

## Reactivity expectation

Because this is a Convex query, it'll **auto-update** in the mobile client whenever a new pending session is inserted or an existing one transitions to `accepted` / `declined` / `cancelled`. No polling, no extra signalling needed.

---

## Mobile usage (already wired)

`/app/frontend/src/components/IncomingScreenShareModal.tsx` already subscribes:

```ts
const { data: incomingRaw } = useSafeConvexQuery<any[]>(
  (api as any).screenSharing?.listIncoming,
  {},
  [],
  isAuthenticated,
);
```

The modal then shows the first pending session with Accept / Decline buttons that call:
- `api.screenSharing.acceptScreenShare({ sessionId })`
- `api.screenSharing.declineScreenShare({ sessionId })`

Both of those are already shipped on your side — only `listIncoming` is missing.

---

## Quick implementation sketch

```ts
// convex/screenSharing.ts (additive — keep existing exports)
export const listIncoming = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const me = await ctx.db
      .query("users")
      .withIndex("by_token", q => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!me) return [];

    const sessions = await ctx.db
      .query("screenSharingSessions")
      .withIndex("by_recipient_and_status",
        q => q.eq("recipientId", me._id).eq("status", "pending"))
      .order("desc")
      .take(10);

    return Promise.all(sessions.map(async (s) => {
      const requester = await ctx.db.get(s.requesterId);
      return {
        ...s,
        requesterName: requester?.name || requester?.displayName || "Unknown",
        requesterAvatar: requester?.avatar || null,
      };
    }));
  },
});
```

---

## Acceptance check

Once shipped, send a screen-share request from one logged-in account → the recipient's native app should show the **Incoming screen share** modal within ~1 second, with the requester's name + Accept/Decline buttons. Tapping either button calls the already-deployed accept/decline mutations and the modal dismisses.

That's it — no other backend work needed for screen sharing on mobile.
