# 📚 Convex Backend Changes Needed — Smilers Status / Stories (Phase 2B.1 + 2B.2)

The mobile app frontend now includes:

- text/photo/video status creation
- full-screen story viewer
- mark-viewed support
- reply-to-story as a DM
- own-story viewer list

The local workspace still does **not** include the Convex backend source, so please apply the following changes on the Convex side.

---

## 1) Extend `statuses.create`

Accept and persist these shapes:

```ts
type: v.union(v.literal("text"), v.literal("image"), v.literal("video"))
text: v.optional(v.string())
backgroundColor: v.optional(v.string())
textColor: v.optional(v.string())
storageId: v.optional(v.id("_storage"))
mimeType: v.optional(v.string())
width: v.optional(v.number())
height: v.optional(v.number())
duration: v.optional(v.number())
views: v.optional(v.array(v.object({
  userId: v.id("users"),
  viewedAt: v.number(),
  name: v.optional(v.string()),
})))
```

For text stories, persist `backgroundColor` and `textColor`.

For photo/video stories, persist `storageId`, `mimeType`, `width`, `height`, and optional `duration`.

Statuses should remain active for 24 hours.

---

## 2) Add `statuses.listForUser` query

**Args:** `{ userId }`

Return either:

- `Array<status>` **or**
- `{ stories, name, avatarUrl }`

Requirements:

- only non-expired stories
- newest last (viewer advances forward chronologically)
- include view info if available

---

## 3) Add `statuses.markViewed` mutation

**Args:** `{ statusId }`

Behavior:

- resolve the authenticated app user
- append `{ userId, viewedAt, name }` to the status `views` array if this user has not already viewed it
- do nothing if already viewed

Suggested behavior:

```ts
if (!status.views.some((entry) => entry.userId === me._id)) {
  await ctx.db.patch(statusId, {
    views: [
      ...(status.views || []),
      { userId: me._id, viewedAt: Date.now(), name: me.name },
    ],
  });
}
```

---

## 4) Keep `statuses.listStatusGroups` compatible

The Status tab expects recent-update rows shaped like:

```ts
{
  userId: string,
  name: string,
  count: number,
  avatarUrl?: string,
}
```

Only include users with active (non-expired) statuses.

---

## 5) Extend `messages.send`

Add optional:

```ts
replyToStatusId: v.optional(v.id("statuses"))
```

Persist it on the message so the chat bubble can render a tiny “Replied to story” pill above the message later.

---

## 6) Add `conversations.getOrCreateDirectConversation`

**Args:** `{ otherUserId }`

Return an existing direct conversation id if one already exists between the caller and `otherUserId`, otherwise create it and return the new id.

Accepted frontend return shapes:

- `Id<"conversations">`
- `{ _id: Id<"conversations"> }`
- `{ conversationId: Id<"conversations"> }`

---

## 7) Optional viewer payload for own stories

For the viewer bottom sheet, each story may include:

```ts
views: Array<{
  userId: Id<"users">,
  viewedAt: number,
  name?: string,
}>
```

If you prefer, you can also expose `viewCount` in addition to `views`.

---

## Expected result

- `My Status` opens the story viewer if the user has active stories.
- Recent update rows open `/status-view/[userId]`.
- Stories mark viewed once per user.
- Own stories show viewer counts and viewer timestamps.
- Replying to someone else’s story sends a DM with `replyToStatusId`.