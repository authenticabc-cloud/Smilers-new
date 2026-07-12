# Backend Spec (Convex / web team) — Separate admin BROADCASTS from admin PERSONAL 1:1 chats

**Owner:** web/Convex team (mobile cannot fix this — the mobile app only reads the
data model). **Priority:** P1 (admin identity is wrong in personal chats).

## Problem (reported by admin users, Jun 2026)

When an admin sends a **personal 1:1 message** to a user, the recipient sees the
sender as **“Smilers”** (read-only) instead of the admin's real name.

### Root cause
`api.admin.messaging.messageUsers` delivers broadcasts by writing into the SAME
direct conversation that `getOrCreateDirect(adminId, userId)` returns, and it sets
`conversation.isBroadcast = true` on it. That conversation is then shared by:
- the admin's **broadcasts** (should show “Smilers”, read-only), AND
- the admin's **personal 1:1 messages** (should show the admin's real name, replyable).

Because a conversation carries a **single** `isBroadcast` flag, the mobile client
(correctly) renders the whole conversation as a read-only “Smilers” thread whenever
`isBroadcast === true`. There is no per-message signal to tell a broadcast apart from
a personal message inside the same thread, so personal messages inherit “Smilers”.

Mobile render rule (for reference, `app/chat/[conversationId].tsx`):
```ts
const isBroadcastReadOnly = conversation?.isBroadcast === true;
const title = isBroadcastReadOnly ? 'Smilers' : <peer/group name>;
// read-only composer, no reply/reactions, call buttons hidden when true
```

## Required fix — use a dedicated system “Smilers” conversation for broadcasts

Broadcasts must NOT live in (or flag) the admin↔user personal direct conversation.

### Recommended model (Option A — system account)
1. Create/reserve a single **system user** `Smilers` (fixed `users._id`, e.g.
   `role: "system"`, `name: "Smilers"`).
2. `messageUsers({ userIds, text })` (and any "Message as Smilers" path) must deliver
   each recipient's copy into the **direct conversation between the SYSTEM Smilers
   account and that recipient** — NOT between the acting admin and the recipient.
   - This system↔user conversation is the one flagged `isBroadcast: true` (read-only).
   - One stable broadcast thread per user; all announcements append here.
3. The acting admin's **personal** messages continue to use
   `getOrCreateDirect(adminId, userId)` → a **normal** conversation
   (`isBroadcast` absent/false) that shows the admin's real name and is replyable.

### Hard invariants
- `getOrCreateDirect(a, b)` for two REAL users must **never** return an
  `isBroadcast` conversation and must **never** set `isBroadcast: true`.
- `isBroadcast: true` may only ever be set on a conversation whose sender is the
  **system Smilers account**.

## One-time migration (existing corrupted data)
Some admin↔user direct conversations are currently flagged `isBroadcast: true` and
already contain **personal** messages. For each such conversation:
- If it contains any message whose sender is a real admin (not the system account) →
  either (a) move the broadcast messages to the system↔user thread and clear
  `isBroadcast` on the personal thread, or (b) at minimum clear `isBroadcast:false`
  so the admin's name and reply box return. New broadcasts then land in the system
  thread per the model above.

## Acceptance
- Admin sends a broadcast → recipient sees a read-only **“Smilers”** thread.
- Same admin sends a personal 1:1 message → recipient sees the **admin's real name**
  (device-saved name resolves normally) and can reply.
- The two are separate conversations in the recipient's chat list.

## Note on the related mobile fix (iter-317)
The mobile app now sends broadcasts in **batches of 25** (was one call for all
recipients) to stay within Convex mutation limits and to isolate failures. No
backend change is required for that; `messageUsers` will simply be called multiple
times with ≤25 `userIds` each.
