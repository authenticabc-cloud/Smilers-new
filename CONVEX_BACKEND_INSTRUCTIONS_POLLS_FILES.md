# 📊📎 Convex Backend Changes Needed — Polls + Documents for Smilers Mobile

Hi Hercules! Please apply these changes to the existing Smilers Convex backend so the native mobile app can send **poll** and **file/document** messages and record poll votes.

---

## STEP 1 — Extend the `messages` schema

**File:** `convex/schema.ts`

Keep all existing fields and add the following optional fields to `messages`:

```ts
messages: defineTable({
  // ...existing fields...
  type: v.union(
    v.literal("text"),
    v.literal("image"),
    v.literal("voice"),
    v.literal("poll"),
    v.literal("file")
  ),
  poll: v.optional(
    v.object({
      question: v.string(),
      options: v.array(
        v.object({
          id: v.string(),
          text: v.string(),
          votes: v.optional(v.array(v.id("users"))),
        })
      ),
    })
  ),
  fileName: v.optional(v.string()),
  fileSize: v.optional(v.number()),
})
```

---

## STEP 2 — Extend `messages.send`

**File:** `convex/messages.ts`

Update the existing validator so `send` accepts `poll`, `fileName`, and `fileSize`:

```ts
type: v.union(
  v.literal("text"),
  v.literal("image"),
  v.literal("voice"),
  v.literal("poll"),
  v.literal("file")
),
poll: v.optional(
  v.object({
    question: v.string(),
    options: v.array(v.object({ id: v.string(), text: v.string() })),
  })
),
fileName: v.optional(v.string()),
fileSize: v.optional(v.number()),
```

When inserting the message:

- For `poll`, persist:

```ts
poll: args.poll
  ? {
      question: args.poll.question,
      options: args.poll.options.map((option) => ({
        id: option.id,
        text: option.text,
        votes: [],
      })),
    }
  : undefined,
```

- For `file`, persist `storageId`, `mimeType`, `fileName`, and `fileSize` as part of the message row.

Keep all existing reply/react/star/delete behavior unchanged.

---

## STEP 3 — Add `votePoll` mutation

**File:** `convex/messages.ts`

Append this new mutation:

```ts
export const votePoll = mutation({
  args: { messageId: v.id("messages"), optionId: v.string() },
  handler: async (ctx, { messageId, optionId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const me = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!me) throw new Error("User not found");

    const msg = await ctx.db.get(messageId);
    if (!msg || msg.type !== "poll" || !msg.poll) throw new Error("Not a poll");

    const newOptions = msg.poll.options.map((option) => {
      const votes = option.votes || [];
      if (option.id === optionId) {
        return {
          ...option,
          votes: votes.includes(me._id)
            ? votes.filter((voteUserId) => voteUserId !== me._id)
            : [...votes, me._id],
        };
      }

      return {
        ...option,
        votes: votes.filter((voteUserId) => voteUserId !== me._id),
      };
    });

    await ctx.db.patch(messageId, {
      poll: {
        ...msg.poll,
        options: newOptions,
      },
    });
  },
});
```

This keeps the poll **single-choice** and supports toggle-off when the same option is tapped again.

---

## STEP 4 — Forwarding compatibility

The mobile app now forwards poll and file messages too. Please ensure `messages.send` accepts forwarded payloads that include:

- `poll`
- `storageId`
- `mimeType`
- `fileName`
- `fileSize`

No extra backend endpoint is needed beyond the existing `send` mutation once its validator/storage logic is extended.

---

## Expected result

- Poll messages render with question + options.
- Each option stores votes as `userId[]`.
- Tapping an option records/toggles the user's vote.
- File messages store `storageId`, filename, size, and MIME type.
- Existing reply/react/forward/star/delete flows keep working for poll and file messages.