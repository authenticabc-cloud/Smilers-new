# Backend/Convex contract needed — Archived Chats sync (native ↔ web)

Goal: the native app should archive/unarchive chats against the SAME shared
Convex backend (`aware-newt-456.convex.cloud`) the web app uses, so the state
syncs both ways in real time. Native UX target (from web): hold + swipe-left a
chat to archive; an "Archived" row sits just below "Chat Once" showing a count;
the Archived screen lists chats with an Unarchive button.

The native app currently has NO archive mutations wired, and `archived.tsx`
only *guesses* the read query (`conversations.listArchived` / `getArchived`).
Please confirm the EXACT names + contracts below.

---

## 1. List archived conversations  (QUERY)
- Exact function path? (we currently probe `api.conversations.listArchived` then
  `api.conversations.getArchived`)
- Args? (expecting none / `{}`)
- Return: please make each item shaped the SAME as `conversations.listConversations`
  items so we can reuse the existing `ConversationRow`. Confirm these fields exist:
  `_id`, display name (`name` / `otherUserName`), avatar
  (`avatar` / `profilePicture` / `avatarUrl`), `lastMessageText`,
  `lastMessageTime` (or `lastMessageAt`), `unreadCount`, `isGroup`.

## 2. Archived count  (for the "Archived · N chats" row)
- Is there a lightweight count field/query, or should we just use the length of
  the list from #1?

## 3. Archive a conversation  (MUTATION)
- Exact function path + args. Which pattern do you use?
  - `conversations.archiveConversation({ conversationId })`, or
  - `conversations.setArchived({ conversationId, archived: true })`
- Return shape (e.g. `{ ok: true }`)? Idempotent?

## 4. Unarchive a conversation  (MUTATION)
- Exact function path + args (or the same `setArchived` with `archived: false`).

## 5. Does `conversations.listConversations` EXCLUDE archived chats?  ⚠️ critical
- When a chat is archived, does `listConversations` automatically stop returning
  it? If YES, the main list "just works" after a mutation (reactive).
- If NO, we must filter client-side — in that case please add an `isArchived`
  (boolean) field to each `listConversations` item so we can hide them.

## 6. Auto-unarchive on new message?
- Does the web app auto-unarchive a chat when a new message arrives (WhatsApp
  un-archives by default), or does it stay archived? We'll match web behaviour.

## 7. Scope / ownership
- Confirm archive state is PER-USER (per viewer), not a global flag on the
  conversation shared by both participants.

---

Once you confirm 1, 3, 4 (names + args) and answer 5/6, the native side is a
small change: swipe-to-archive on rows + an "Archived" pinned row + an Unarchive
button. No new screens needed.
