# Convex Backend Spec — Unplayed Voice Note Counts (chat list badge)

**Owner:** Web team (shared Convex deployment `https://aware-newt-456.convex.cloud`)
**Consumer:** Native app chat list (`app/(tabs)/chats.tsx` → `ConversationRow`)
**Status:** Native client is already wired and will light up automatically once
this query is deployed. Until then the native side shows nothing (it uses
`useSafeConvexSubscription`, which degrades gracefully to `{}` — no errors, no
retry storm).

---

## What the native app needs

A single **query** that returns, for the authenticated user, a map of
`conversationId → number of received voice notes they have NOT played yet`.

```
api.messages.getUnplayedVoiceCounts
```

### Signature

- **Type:** `query`
- **Args:** none — uses the authenticated user from `ctx.auth` (exactly like the
  existing `api.messages.getUnreadCounts`).
- **Returns:** `Record<string, number>`
  - Key: `conversationId` (the same id strings returned by
    `api.conversations.listConversations`).
  - Value: integer count of unplayed voice notes in that conversation for the
    caller. **Omit conversations whose count is 0** (or return 0 — the client
    treats missing/0 identically).

### Definition of an "unplayed voice note"

For each conversation the caller participates in, count messages where **all**
of the following hold:

1. The message is a **voice/audio note** — i.e. `message.type === "voice"`
   (include `"audio"` too if voice notes are ever stored under that type).
2. The message was **received**, not sent by the caller —
   `message.senderId !== currentUserId`.
3. The message is **not deleted / not expired** (same visibility rules used by
   `getUnreadCounts`).
4. The caller has **not consumed/played** it — i.e. `currentUserId` is NOT in the
   message's consumption set. This is the **same field written by
   `api.messages.markConsumed({ messageId })`**, which the native app already
   calls the moment a voice note starts playing. Use whatever field
   `markConsumed` populates (e.g. `consumedBy` / `consumedByUsers`) and which
   `MessageInfoSheet` reads back as `consumedByUsers`.

### Reference implementation shape

Mirror `getUnreadCounts` as closely as possible (same auth, same conversation
enumeration, same visibility filters) — only the per-message predicate differs:

```ts
export const getUnplayedVoiceCounts = query({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthedUser(ctx);           // same helper getUnreadCounts uses
    if (!me) return {};
    const counts: Record<string, number> = {};
    const convos = await listMyConversations(ctx, me._id);  // same source as getUnreadCounts
    for (const convo of convos) {
      const msgs = await getConversationMessages(ctx, convo._id); // visible, non-deleted
      let n = 0;
      for (const m of msgs) {
        const isVoice = m.type === "voice" || m.type === "audio";
        if (!isVoice) continue;
        if (String(m.senderId) === String(me._id)) continue;      // received only
        const consumed = Array.isArray(m.consumedBy) && m.consumedBy.some(
          (u) => String(u) === String(me._id),
        );
        if (consumed) continue;
        n += 1;
      }
      if (n > 0) counts[String(convo._id)] = n;
    }
    return counts;
  },
});
```

*(Field/collection names above are placeholders — use the real schema. The only
hard requirements are the return shape and the four predicate rules.)*

### Reactivity

It must be a normal Convex `query` (reactive). The native client subscribes with
`watchQuery`, so the badge updates live when a new voice note arrives (count
goes up) and when the user plays one (`markConsumed` fires → count goes down).

---

## Native side (already implemented — for reference)

- `app/(tabs)/chats.tsx`
  ```ts
  const { data: unplayedVoiceCounts } = useSafeConvexSubscription<Record<string, number>>(
    (api as any).messages?.getUnplayedVoiceCounts, {}, {}, !!me?._id,
  );
  // passed per row:
  unplayedVoiceCount={Number((unplayedVoiceCounts as any)?.[String(item._id)]) || 0}
  ```
- `src/components/ConversationRow.tsx` renders a small blue mic pill with the
  number when `unplayedVoiceCount > 0`, to the left of the unread pill.

No further native changes are required once the query ships.
