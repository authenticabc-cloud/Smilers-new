# Convex Backend Spec — Group Creator, Creation Date & System Messages

**Audience:** Convex/web backend engineer (backend `aware-newt-456.convex.cloud`).
**Why:** The mobile app now renders (a) the group **creator name** + **creation date** in Group Info, and (b) WhatsApp-style **system messages** in the chat timeline ("X created the group", "X added Y", "X left", renamed, etc.). The client is already shipped and will light up automatically once the backend returns the fields/events below. **None of this exists on the web backend yet.**

The mobile app **does not write** to Convex schema — it only consumes. Everything below must be implemented on the backend and will benefit web + mobile equally.

---

## Part 1 — Group creator + creation date (REQUIRED, small)

The client reads these off the conversation object returned by
`conversations.getConversation` **and** `conversations.listConversations`.

### 1.1 Conversation document must include
| Field | Type | Notes |
|---|---|---|
| `createdBy` | `Id<"users">` | The user who created the group. **Set this in `createGroup`.** If historical groups lack it, backfill from the earliest membership / chief admin. |
| `_creationTime` | number (ms) | Convex system field — already exists on every doc. Just make sure it is **not stripped** from the query return. |

> The client also accepts `creatorId` / `createdByUserId` / `ownerId` as aliases, and falls back to the chief admin if none are present — but please send **`createdBy`** as the canonical field.

### 1.2 Both queries must return `createdBy` + `_creationTime`
Ensure `getConversation` and `listConversations` return the raw conversation doc (or at least include `createdBy`, `name`, `type`, `_creationTime`). Today `getConversation` returns `name`/`description` etc.; just make sure `createdBy` and `_creationTime` ride along.

---

## Part 2 — Group system messages (the timeline events)

### 2.1 What a system message looks like
Emit these as **normal rows in the `messages` table** for the group's
`conversationId`, so they appear inline in `messages.list` exactly where they
happened (ordered by `_creationTime`). The mobile client already renders any
message matching this shape:

```jsonc
{
  "conversationId": "<group conversation id>",
  "type": "system",                 // REQUIRED discriminator
  "senderId": "<actor userId>",     // actor (also used as fallback actorId)
  "system": {
    "action": "member_added",       // see actions below
    "actorId": "<userId>",          // who performed the action
    "targetIds": ["<userId>", ...], // who was affected (optional per action)
    "value": "New Group Name"       // optional string payload (renames etc.)
  },
  "text": "Kojo added Ama",          // OPTIONAL pre-rendered fallback (see 2.4)
  "encrypted": false                 // MUST be false / decryptable (see 2.5)
}
```

- `type: "system"` is the discriminator. (The client also accepts
  `messageType: "system"`.)
- `system.actorId` — the user who performed the action. If omitted, the client
  uses `senderId`.
- `system.targetIds` — array of affected users. Single-target actions may send
  `targetId` (string) instead; the client handles both.
- `system.value` — free string used by rename/description actions.

### 2.2 Actions and when to emit them
| `action` | Emit from mutation | `targetIds` | `value` | Renders as (example) |
|---|---|---|---|---|
| `group_created` | `createGroup` | – | group name | "Kojo created the group \"NOAS FAMILY\"" |
| `member_added` | `addGroupMember` | added user id(s) | – | "Kojo added Ama, Yaw" |
| `member_removed` | `removeGroupMember` | removed user id(s) | – | "Kojo removed Ama" |
| `member_left` | `leaveGroup` | – | – | "Ama left" (actor = the leaver) |
| `member_joined` | invite-link join | – | – | "Ama joined via invite link" |
| `admin_promoted` | `promoteToAdmin` | promoted user id(s) | – | "Kojo made Ama an admin" |
| `admin_demoted` | `demoteFromAdmin` | demoted user id(s) | – | "Kojo removed Ama as admin" |
| `chief_transferred` | `transferChiefAdmin` | new chief user id | – | "Kojo transferred chief admin to Ama" |
| `group_renamed` | `updateGroup` (name) | – | new name | "Kojo changed the group name to \"…\"" |
| `group_icon_changed` | `updateGroup` (avatar) | – | – | "Kojo changed the group icon" |
| `group_description_changed` | `updateGroup` (description) | – | – | "Kojo changed the group description" |

> Emit **`group_created`** inside `createGroup` (right after the conversation +
> memberships are inserted). Once you do, the mobile app automatically hides its
> temporary client-synthesised "created" banner and shows your event instead.

### 2.3 IDs, not names
**Send user IDs (`actorId`/`targetIds`), NOT display names.** Each viewer's app
resolves those IDs to the name saved in **that viewer's own phone contacts**
(falling back to the Smilers account name). This is why the copy must be built
client-side. Do **not** localise/format the sentence on the server.

### 2.4 Optional `text` fallback
You may also set a plain `text` (e.g. "Kojo added Ama") for web/back-compat and
for the chat list "last message" preview. Mobile only uses `text` if the
structured `system` payload is missing or has an unknown `action`.

### 2.5 Encryption / decryption
System messages must **not** be E2EE-encrypted (`encrypted: false`) — or if the
group pipeline always encrypts, they must decrypt to the payload above. The
client reads `system` / `text` directly and does not attempt AES on system rows.

### 2.6 Read state, unread counts & pushes
- System messages should **not** increment unread counts and should **not**
  trigger a user-facing push notification (silent). If your `messages.send`
  path always pushes, add a branch to skip push when `type === "system"`.
- They **may** update the conversation's `lastMessage`/preview if you want the
  chat list to show e.g. "Kojo added Ama" — optional.

### 2.7 `messages.list` must return them
No special work if they're normal `messages` rows — just confirm `messages.list`
(the paginated query the app uses: `{ conversationId, paginationOpts }`) returns
`type` and `system` fields untouched.

---

## Part 3 — Acceptance checklist
- [ ] `createGroup` sets `conversation.createdBy` and inserts a `group_created` system message.
- [ ] `getConversation` + `listConversations` return `createdBy` and `_creationTime`.
- [ ] `addGroupMember` / `removeGroupMember` / `leaveGroup` / invite-join emit the matching system message with correct `actorId` + `targetIds`.
- [ ] `promoteToAdmin` / `demoteFromAdmin` / `transferChiefAdmin` emit their events.
- [ ] `updateGroup` emits `group_renamed` / `group_icon_changed` / `group_description_changed` as applicable.
- [ ] System messages are `type:"system"`, unencrypted (or decryptable), returned by `messages.list`, and do **not** push or bump unread.
- [ ] Backfill `createdBy` for existing groups (best-effort from earliest membership / chief admin).

Once Part 1 lands, Group Info shows creator + date immediately. Once Part 2
lands, the timeline shows the full membership history like WhatsApp. No mobile
release is required — the client is already shipped for this contract.
