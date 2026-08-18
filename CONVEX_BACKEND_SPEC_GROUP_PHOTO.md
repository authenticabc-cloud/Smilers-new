# Backend spec — Group photo (admin-set) support in `conversations.updateGroup`

## Goal
Let a group admin set a real group photo (like a profile picture) that then
shows everywhere the app already renders group avatars (chat header, chats list,
groups list, Forward picker, OS "Share to Smilers" sheet, group info screen).

The **native app is done** and now:
- Renders the group photo from the conversation/group field **`avatar`** (with
  fallbacks `groupIcon` / `avatarUrl` / `photo`) — same field the app already
  uses for direct-chat avatars.
- On the Group Info screen, an admin taps the big avatar → Take Photo / Choose
  from Library / Remove → uploads the image via the existing storage upload
  (`generateUploadUrl`) and calls:

  ```
  api.conversations.updateGroup({ conversationId, avatarStorageId: <Id<"_storage">> })   // set/replace
  api.conversations.updateGroup({ conversationId, avatarStorageId: null })                // remove
  ```

## Required backend changes (Convex — web team)
1. **`conversations.updateGroup`** — extend the args validator to ACCEPT an
   optional `avatarStorageId: v.union(v.id("_storage"), v.null())` (alongside the
   existing `name` / `description` / `appearance`).
   - Enforce admin-only (chief/admin/creator), same as `name`/`appearance` edits.
   - When provided: store it on the conversation doc (e.g. `avatarStorageId`).
   - When `null`: clear the stored value.
   - IMPORTANT: today the validator rejects unknown args, so until this ships the
     mobile call fails with an ArgumentValidationError (handled gracefully in the
     app with a "will apply once the server update is live" message).

2. **Resolve to a signed URL in every group/conversation read** — wherever a
   conversation/group row is returned (`listConversations`, `listGroups`,
   `getConversation`, group info queries, `getGroupMembers` group headers, etc.),
   include a resolved **`avatar`** string:
   ```
   avatar: doc.avatarStorageId ? await ctx.storage.getUrl(doc.avatarStorageId) : null
   ```
   (Reusing the existing per-user avatar resolution pattern.)

3. **System message** — emit a `groupIconChanged` system message when the photo
   is set/changed/removed (the type already exists in the app's system-message
   renderer), so members see "<Admin> changed the group photo".

## Acceptance test
1. Admin on Group Info taps avatar → picks a photo → within a moment the header
   shows the image; a `groupIconChanged` system line appears in the chat.
2. The same group now shows the photo in: chats list, groups list, Forward
   picker, and the OS "Share to Smilers" sheet.
3. Non-admins do NOT get the camera badge and cannot call the mutation.
4. Admin → Remove Photo → falls back to initials/appearance emoji everywhere.
