# Convex fix needed: `messages.markRead` must zero `getUnreadCounts`

## The bug (as seen on mobile)

After the client calls **`messages.markRead({ conversationId })`**, the reactive
query **`messages.getUnreadCounts({})`** does **not** drop that conversation's
count to `0` for some accounts. The stale count then lingers, and as soon as a
newer message arrives the client would resurface the whole already-read bulk as
unread.

The mobile app currently compensates on-device (a persisted "already-read
baseline" subtracted from the backend count). That patch works, but the
**correct** fix is server-side so the count is simply accurate.

## Functions the mobile client uses (the contract — do not rename)

- **Mutation** `messages.markRead({ conversationId })`
  - Called on: chat open, swipe "mark read", and "mark all as read".
  - Must mark **every message in `conversationId` addressed to the caller** as
    read for the caller, so the caller's unread count for that conversation
    becomes `0`.
- **Mutation** `messages.markUnread({ conversationId })`
  - Inverse — makes the conversation show as unread again for the caller.
- **Query** `messages.getUnreadCounts({}) → { [conversationId]: number }`
  - Per-conversation unread counts for the **calling** user. Reactive.

## Required behavior

1. `markRead({ conversationId })` is **per-viewer**. It must update read state
   for the **authenticated caller only**, never the sender.
2. Immediately after `markRead` commits, `getUnreadCounts` (which is reactive)
   must recompute so that `result[conversationId] === 0` for the caller.
3. `markRead` must be **idempotent** — calling it repeatedly is a no-op after
   the first, and never throws.
4. It must cover **all** currently-unread messages in the conversation for the
   caller, including any that arrived between the client's read action and the
   mutation running (read up to "now" / latest message), and must include
   group conversations, not just 1:1.

## Most likely root causes to check

- **`getUnreadCounts` and `markRead` disagree on what "unread" means.**
  They must read/write the **same** field. Common mismatch:
  - `getUnreadCounts` counts messages where `readBy` does **not** contain the
    caller (or `message.readAt == null`), but
  - `markRead` only updates a per-conversation `lastReadAt`/`readCursor` on the
    membership row (or vice-versa).
  Pick ONE model and make both use it. Two clean options:

  **A. Per-message `readBy` set**
  ```ts
  // markRead
  const msgs = await ctx.db
    .query("messages")
    .withIndex("by_conversation", q => q.eq("conversationId", conversationId))
    .filter(q => q.neq(q.field("senderId"), userId))
    .collect();
  for (const m of msgs) {
    if (!(m.readBy ?? []).includes(userId)) {
      await ctx.db.patch(m._id, { readBy: [...(m.readBy ?? []), userId] });
    }
  }
  // getUnreadCounts: count messages where senderId != userId && !readBy.includes(userId)
  ```

  **B. Per-membership read cursor (cheaper, recommended for scale)**
  ```ts
  // markRead — one write per conversation, O(1)
  const now = Date.now();
  const member = await getMembership(ctx, conversationId, userId);
  await ctx.db.patch(member._id, { lastReadAt: now });
  // getUnreadCounts: for each conversation, count messages with
  //   _creationTime > member.lastReadAt && senderId != userId
  ```
  Whichever you choose, **both** functions MUST use the same field.

- **Auth identity mismatch.** If `markRead` writes read state keyed by a
  different id than `getUnreadCounts` reads (e.g. Convex `_id` vs OIDC `subject`
  vs phone), the write "succeeds" but the count never clears. Log the resolved
  `userId` in both and confirm they're identical for the affected accounts.

- **`markRead` scoped to a message id / page**, missing messages that arrived
  just before it ran. Prefer a "read up to now/last message" cursor (option B)
  so it can't leave a residue.

- **Not idempotent / partial writes** — a throw mid-loop (option A over a large
  conversation) leaves some messages unread. Batch/guard so it always completes.

## How to verify the fix

1. As user X in a chat with 10 unread from Y, call `markRead({ conversationId })`.
2. `getUnreadCounts()` for X must now return `0` for that conversation (reactive
   update, no reload).
3. Y sends 1 new message → `getUnreadCounts()` for X returns `1` (not 11).
4. Repeat inside a **group** conversation.

## Once fixed

The mobile "already-read baseline" (`src/lib/localReadState.ts`
`noteReadBaseline` / `effectiveUnread` / `unreadMinusBaseline`) becomes a
harmless no-op (`backend - baseline` where baseline tracks the now-correct
count). It can stay as a safety net or be removed later — no client change is
required to benefit from the server fix.
