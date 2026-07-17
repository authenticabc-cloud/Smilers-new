# 🔧 Backend: add `typing.getTypingForConversations` (batch typing query)

**Why:** The Chats list currently opens **one** `typing.getTypingUsers`
subscription **per visible row**. On long lists that's many concurrent Convex
subscriptions. A single batch query for all visible conversations cuts that to
one subscription.

**Where:** External Convex backend (shared with web) — `convex/typing.ts`.

## Contract

`getTypingForConversations({ conversationIds: Id<"conversations">[] }) →
Record<conversationId, Array<{ userId, name }>>`

- Same "who is typing right now" semantics as the existing
  `getTypingUsers({ conversationId })`, but batched.
- Returns a map keyed by conversationId; each value is the array
  `getTypingUsers` would return for that conversation (recent, non-stale typing
  entries). Conversations with nobody typing may be omitted or return `[]`.
- Must be **reactive** (a Convex `query`) so it re-emits as typing starts/stops.

## Implementation (reuse the existing getTypingUsers logic)

```ts
export const getTypingForConversations = query({
  args: { conversationIds: v.array(v.id("conversations")) },
  handler: async (ctx, { conversationIds }) => {
    const now = Date.now();
    const WINDOW = 6000; // same freshness window getTypingUsers uses
    const result: Record<string, Array<{ userId: string; name: string }>> = {};
    for (const conversationId of conversationIds) {
      const rows = await ctx.db
        .query("typingIndicators") // ← use whatever table getTypingUsers reads
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect();
      const active = rows.filter((r) => now - r.updatedAt < WINDOW);
      if (active.length === 0) continue;
      result[conversationId] = await Promise.all(
        active.map(async (r) => {
          const u = await ctx.db.get(r.userId);
          return { userId: String(r.userId), name: u?.name ?? "Someone" };
        }),
      );
    }
    return result;
  },
});
```

> Mirror the exact table/index/freshness-window and name-resolution that your
> current `getTypingUsers` already uses — only the shape (batched map) is new.

## Then enable on mobile
1. Deploy the query.
2. Set `EXPO_PUBLIC_BATCH_TYPING_ENABLED=true` in `frontend/.env` and rebuild.
   The Chats list switches to the single query and each row stops opening its own
   subscription. If the flag stays `false`, the current per-row behavior is kept
   (no regression).

## Verify
1. With the flag on, two users typing in different chats both show
   "X is typing…" on the correct rows.
2. Only ONE `typing.getTypingForConversations` subscription is active for the
   list (not one per row).
3. Indicators clear within the freshness window after typing stops.
