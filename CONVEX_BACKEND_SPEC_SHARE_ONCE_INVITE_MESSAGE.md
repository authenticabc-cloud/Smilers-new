# Convex Spec — Share Once invite lands in each viewer's 1:1 chat

**Goal (user request):** When someone creates a Share Once post, every selected
viewer should receive a **tappable message in their 1:1 conversation with the
sender** — e.g. "📷 This is a photo message — tap to view", "🎥 This is a video
message — tap to view", "🎙 This is a voice message — tap to listen",
"📄 This is a document — tap to view", "👤 This is a contact — tap to view".
Tapping it opens the **sender's Share Once page for that exact post** (the native
view screen `/share-once/view?t=<shareToken>`).

This must be done on the backend because: (a) `createPost` returns only
`{postId, shareToken, viewerCount}` — not the resolved recipient user-ids needed
to fan out messages; and (b) the chat `messages.send` `type` is a server-validated
enum, so a new message subtype can't be created from the client.

## Required backend work
1. **On `createPost` (and `repostToShareOnce`)**: for EACH resolved viewer,
   get-or-create the 1:1 conversation between the author and that viewer, and
   insert ONE message with a new subtype:
   ```
   type: "shareOnceInvite"
   shareOnceToken: <shareToken>
   shareOnceContentType: "text" | "photo" | "video" | "audio" | "voice" | "file" | "contact"
   shareOnceAuthorId: <authorId>
   text: "<emoji> This is a <content> message — tap to view"   // fallback text
   ```
   - Respect the audience exactly (same resolution as the post's viewer set,
     including groups → group members, allExcept, specific, trustees, voiceTask).
   - De-dupe: at most one invite message per viewer per post (idempotent if
     createPost retries).
   - These invite messages should participate in normal unread/badge counts so
     the recipient is actually alerted (this replaces "only shown in Received tab").

2. **Push**: send the normal 1:1 message push for each invite so recipients get a
   notification like "📷 This is a photo message — tap to view".

3. **Reads**: ensure `messages.list` / the conversation query returns the extra
   fields (`shareOnceToken`, `shareOnceContentType`, `shareOnceAuthorId`) on
   `shareOnceInvite` messages so the app can render + route.

4. **Deletion parity**: if the post is deleted for everyone, the invite messages
   should tombstone like any other message (or resolve to "unavailable" when the
   view is opened — already handled by `getPostByToken` returning isDeleted).

## Native side (I'll wire this as soon as the above ships)
- Chat bubble renders `type === "shareOnceInvite"` as a tap-to-view card using
  the emoji/label from `shareOnceContentType`, routing to
  `/share-once/view?t=<shareOnceToken>` on tap.
- No client fan-out needed.

**Please confirm** the message subtype name + the extra field names so the app
renderer matches exactly.
