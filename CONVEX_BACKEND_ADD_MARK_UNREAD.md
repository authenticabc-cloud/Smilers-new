# 🔧 Backend: add `messages.markUnread` mutation

**Why:** The native app now has swipe-to-read on the Chats & Groups lists with an
**Undo** snackbar. Undo calls `api.messages.markUnread({ conversationId })`,
which does not exist yet on the shared Convex backend. Until it's deployed, the
Undo button no-ops (swallowed error) — read still works, only revert is missing.

**Where:** External Convex backend (shared with web) — `convex/messages.ts`.

## Contract

`markUnread({ conversationId }) → void` — marks the conversation UNREAD for the
**calling user only** (mirror of the existing `markRead`). It should make
`getUnreadCounts` return a count ≥ 1 for that conversation for this user.

## Implementation (mirror `markRead`)

Look at how `markRead` records "read" state (typically a per-user
`lastReadAt`/`lastReadMessageId` on a membership/read-cursor doc, or a
`readBy` list on messages). `markUnread` reverses just enough of that so the
conversation counts as unread again for the caller. Two common shapes:

**A. Read-cursor model** (a `conversationReads`/membership doc holds
`lastReadTime` per user):
```ts
export const markUnread = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");

    // Find the newest message in the conversation.
    const latest = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .first();
    if (!latest) return; // nothing to be unread about

    // Move this user's read cursor to JUST BEFORE the latest message so
    // getUnreadCounts sees ≥ 1 unread.
    const readDoc = await ctx.db
      .query("conversationReads")
      .withIndex("by_user_conversation", (q) =>
        q.eq("userId", userId).eq("conversationId", conversationId),
      )
      .unique();
    const beforeLatest = latest._creationTime - 1;
    if (readDoc) {
      await ctx.db.patch(readDoc._id, { lastReadTime: beforeLatest });
    } else {
      await ctx.db.insert("conversationReads", {
        userId,
        conversationId,
        lastReadTime: beforeLatest,
      });
    }
  },
});
```

**B. `readBy` array on messages:** remove `userId` from the latest message's
`readBy` (and/or set the membership `unread` flag/count to 1) so the same
`getUnreadCounts` logic reports it unread.

> Use whichever field/index names your existing `markRead` and
> `getUnreadCounts` already rely on — the goal is simply: after `markUnread`,
> `getUnreadCounts` returns ≥ 1 for `{ userId, conversationId }`.

## Verify
1. As user A, open a chat (unread → 0). Call `markUnread({ conversationId })`.
2. `getUnreadCounts` returns ≥ 1 for that conversation for user A.
3. Other users' unread counts are unaffected.
4. Native: swipe-to-read → tap **UNDO** → the row's unread badge/emphasis
   returns and the tab/app badge increments back.
