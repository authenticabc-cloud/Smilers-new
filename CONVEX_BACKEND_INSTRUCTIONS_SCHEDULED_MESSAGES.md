# Backend Contract — `api.scheduledMessages.create` Server Error

Mobile app currently fails with `[CONVEX M(scheduledMessages:create)] Server Error` when scheduling a message from a chat. Need the backend team to either (a) align the mutation validator with the args the mobile sends, or (b) tell us the exact expected shape so we can update mobile.

---

## What mobile is sending today

From `/app/frontend/app/chat/[conversationId].tsx` (clock icon on the chat composer) **and** from `/app/frontend/app/scheduled.tsx` (Schedule editor):

```ts
await api.scheduledMessages.create({
  recipient: string,    // recipient display label OR conversation title
  message:   string,    // the message text to send later
  date:      string,    // "YYYY-MM-DD" (local time)
  time:      string,    // "HH:MM" (local time, 24h)
  repeat:    "once" | "daily" | "weekly" | "monthly",
  active:    boolean,   // true = enabled
});
```

For the **chat-composer path**, `conversationId` (an `Id<"conversations">`) is also available — the mobile can include it if your validator expects it.

---

## What we believe the backend currently rejects

Server error suggests the validator does not accept one of these fields. Most likely candidates:

1. `recipient` is **not** in your validator and your schema requires `conversationId` instead.
2. `date` / `time` are split, but your schema expects a single `scheduledAt: string` (ISO-8601).
3. `repeat` allowed values differ (e.g. you only accept `"none" | "daily" | ...`).

---

## Recommended mutation contract (please confirm or amend)

```ts
// convex/scheduledMessages.ts
export const create = mutation({
  args: {
    conversationId: v.id("conversations"),       // REQUIRED — drop `recipient`
    message: v.string(),
    date: v.string(),                            // "YYYY-MM-DD" local
    time: v.string(),                            // "HH:MM" local
    repeat: v.union(
      v.literal("once"),
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("monthly"),
    ),
    active: v.optional(v.boolean()),             // defaults true
    timezone: v.optional(v.string()),            // IANA tz, optional
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    const me = await ctx.db
      .query("users")
      .withIndex("by_token", q => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!me) throw new Error("UNAUTHENTICATED");

    // Verify caller is a member of the conversation.
    const conv = await ctx.db.get(args.conversationId);
    if (!conv) throw new Error("CONVERSATION_NOT_FOUND");
    // (...your existing membership check)

    const id = await ctx.db.insert("scheduledMessages", {
      ownerId: me._id,
      conversationId: args.conversationId,
      message: args.message,
      date: args.date,
      time: args.time,
      repeat: args.repeat,
      active: args.active ?? true,
      timezone: args.timezone,
      createdAt: new Date().toISOString(),
    });
    return id;
  },
});
```

And matching schema:

```ts
scheduledMessages: defineTable({
  ownerId:        v.id("users"),
  conversationId: v.id("conversations"),
  message:        v.string(),
  date:           v.string(),
  time:           v.string(),
  repeat:         v.union(
                    v.literal("once"),
                    v.literal("daily"),
                    v.literal("weekly"),
                    v.literal("monthly"),
                  ),
  active:         v.boolean(),
  timezone:       v.optional(v.string()),
  createdAt:      v.string(),
})
  .index("by_owner", ["ownerId"])
  .index("by_owner_and_active", ["ownerId", "active"])
```

If you already have `scheduledMessages` shipped with `recipient` instead of `conversationId`, just let me know which shape you're keeping and I'll align mobile in the next push.

---

## Also affected — `update`, `remove`, `setActive`, `listMine`

Mobile calls these with:

```ts
api.scheduledMessages.listMine({})
api.scheduledMessages.update({ scheduleId, ...sameFieldsAsCreate })
api.scheduledMessages.remove({ scheduleId })
api.scheduledMessages.setActive({ scheduleId, active })
```

All currently use field name `recipient`. Same alignment needed.

---

## Acceptance check

1. From mobile, open any 1:1 chat → tap the clock icon next to the composer → pick a future date/time → tap **Schedule**.
2. Should see "Message scheduled" success alert (not the current "Saved to this device" fallback).
3. The scheduled item should appear in `/scheduled` page (mobile) and in the web app's Scheduled Messages tab simultaneously.
4. At the scheduled time, the backend cron / scheduler should send the message into the conversation as if it were sent live.

---

## Quickest unblock

If you can't change the validator quickly, please confirm:
1. Should `recipient` stay as a free-form string, OR be replaced by `conversationId`?
2. Should `date` + `time` stay split, OR consolidate into `scheduledAt: ISO`?

I'll patch mobile to match whichever shape you commit to within minutes.
