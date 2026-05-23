# Convex Backend Instructions — Avatar / Profile Photo Upload (Mobile)

## Why this is needed

When a mobile user changes their profile photo, the mobile client picks
an image from the gallery or camera, then needs to:

1. Upload the JPEG bytes to **Convex Storage** (not base64 inline — base64
   pumps inflate the user document size, blow past Convex's per-row size
   cap, and slow down every page that subscribes to the user's profile).
2. Patch the user row with the resulting `storageId` so all clients (web
   + mobile) pull it via `getUrl` from Convex Storage.
3. Have the existing `getUserById` / `getCurrentUser` queries return a
   resolvable URL (or base64 fallback) under `avatar` / `avatarUrl` so
   the mobile screens (Profile tab, Contact info page, chat header,
   contacts list) render the photo automatically.

Today the mobile app already passes `avatarFile` base64 to whatever
mutation is wired, but the photo doesn't show up on subsequent loads,
which suggests the backend either rejects oversized base64 payloads
or doesn't expose it back as a URL.

---

## Mutations to ship

### 1. `users.generateAvatarUploadUrl({}) → string`

```ts
export const generateAvatarUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");
    return await ctx.storage.generateUploadUrl();
  },
});
```

Mobile client flow:

```ts
const url = await generateAvatarUploadUrl({});
await fetch(url, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
// response → { storageId }
await setAvatar({ storageId });
```

### 2. `users.setAvatar({ storageId }) → null`

```ts
export const setAvatar = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const user = await getCurrentUserFromCtx(ctx);
    if (!user) throw new Error("Not authenticated");
    // Delete the previous storage object if any (saves quota).
    if (user.avatarStorageId) {
      try { await ctx.storage.delete(user.avatarStorageId); } catch {}
    }
    await ctx.db.patch(user._id, { avatarStorageId: storageId });
  },
});
```

### 3. (Optional) `users.removeAvatar({}) → null`

Deletes the current `avatarStorageId` and patches the user row to clear it.

---

## Queries to update

Every query that returns a user object should hydrate the avatar URL:

```ts
async function hydrateAvatar(ctx, user) {
  if (!user) return user;
  if (user.avatarStorageId) {
    const url = await ctx.storage.getUrl(user.avatarStorageId);
    return { ...user, avatar: url, avatarUrl: url };
  }
  return user;
}
```

Apply in:
* `users.getCurrentUser`
* `users.getUserById`
* `users.searchUsers`
* `contacts.getContacts`
* `conversations.listConversations` (the `otherUser` field)
* Any `members[].user` list (groups, conferences)

The mobile screens read any of these fields, in priority order: `avatar`,
`avatarUrl`, `photoURL`.

---

## Schema addition

```ts
users: defineTable({
  // existing fields…
  avatarStorageId: v.optional(v.id("_storage")),
})
```

If the existing column is already named differently (e.g. `photoStorage`),
keep it but expose it via `avatar` in the query hydrator.

---

## Why this fixes the current mobile bug

The mobile Profile screen currently uploads a base64 image to whatever
mutation is wired and never sees a resolvable URL come back. The hierarchy
above ensures:

* Uploads stay under 10MB and never bloat the user row.
* Every existing avatar-reading mobile screen (Profile pill avatar, chat
  header avatar, contact info page hero, contacts list, group/conference
  member tiles) automatically shows the new photo as soon as the mutation
  returns and the live query re-fires.
* Future deletion / replacement is clean — old storage objects are
  garbage-collected by `setAvatar` itself.
