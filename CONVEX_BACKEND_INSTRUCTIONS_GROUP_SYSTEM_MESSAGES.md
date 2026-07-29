# Convex Backend Spec — Group Creator, Creation Date & System Messages

**Audience:** Convex/web backend engineer (backend `aware-newt-456.convex.cloud`).
**Why:** The mobile app renders (a) the group **creator name** + **creation date** in Group Info, and (b) WhatsApp-style **system messages** in the chat timeline + chats-list previews ("Kojo created the group", "Kojo added Ama", "Ama left", renamed, etc.).

> **IMPORTANT — the mobile client is aligned to your EXISTING `numberChanged` precedent.** It reads `type:"system"` rows via **`systemKind` + `systemMeta`** (exactly like the phone-number-change rows). No new message shape is required — just new `systemKind` values + a couple of extra `systemMeta` fields. The native client is already shipped for this exact contract.

---

## Part 1 — Group creator + creation date ✅ ALREADY DONE
You confirmed `createGroup` already sets `createdBy`, and `getConversation` +
`listGroups` return the full conversation doc (so `createdBy` + `_creationTime`
reach the client). **No change needed** — Group Info creator/date already works.

---

## Part 2 — Group system messages

### 2.1 Row shape (matches `numberChanged`)
Insert a normal `messages` row for the group's `conversationId`:

```jsonc
{
  "conversationId": "<group id>",
  "type": "system",
  "senderId": "<actor userId>",          // actor (client also falls back to systemMeta.actorId)
  "systemKind": "memberAdded",            // NEW values below (camelCase, like "numberChanged")
  "systemMeta": {
    "actorId": "<userId>",                // who performed the action
    "targetIds": ["<userId>", ...],       // who was affected (optional per action)
    "value": "New Group Name"             // optional string (renames)
  }
}
```

- `systemKind` — the discriminator, **camelCase** to match your existing
  `numberChanged`. (The client normalises casing/underscores, but please use
  camelCase for consistency.)
- `systemMeta.actorId` — actor userId. If omitted, the client uses `senderId`.
- `systemMeta.targetIds` — array of affected user IDs. (A single `targetId`
  string is also accepted.)
- `systemMeta.value` — free string for rename actions.

### 2.2 `systemKind` values + when to emit
| `systemKind` | Emit from mutation | `targetIds` | `value` | Renders as |
|---|---|---|---|---|
| `groupCreated` | `createGroup` | – | group name | "Kojo created the group \"NOAS FAMILY\"" |
| `memberAdded` | `addGroupMember` | added id(s) | – | "Kojo added Ama, Yaw" |
| `memberRemoved` | `removeGroupMember` | removed id(s) | – | "Kojo removed Ama" |
| `memberLeft` | `leaveGroup` | – | – | "Ama left" (actor = leaver) |
| `memberJoined` | invite-link join | – | – | "Ama joined via invite link" |
| `adminPromoted` | promote (groupAdmin.ts) | promoted id(s) | – | "Kojo made Ama an admin" |
| `adminDemoted` | demote (groupAdmin.ts) | demoted id(s) | – | "Kojo removed Ama as admin" |
| `chiefTransferred` | transfer chief (groupAdmin.ts) | new chief id | – | "Kojo transferred chief admin to Ama" |
| `groupRenamed` | `updateGroup` (name) | – | new name | "Kojo changed the group name to \"…\"" |
| `groupIconChanged` | `updateGroup` (avatar) | – | – | "Kojo changed the group icon" |
| `groupDescriptionChanged` | `updateGroup` (description) | – | – | "Kojo changed the group description" |

> Emit **`groupCreated`** inside `createGroup`. Once you do, the app auto-hides
> its temporary client-synthesised "created" banner and shows your row instead.

### 2.3 Send IDs, not names
Put **user IDs** in `actorId`/`targetIds` — NOT display names. Each viewer's app
resolves IDs to the name in **that viewer's own phone contacts** (falling back
to the Smilers account name). Do not localise/format the sentence server-side.

### 2.4 `systemMeta` schema addition
Your current `systemMeta` validator only allows `userId`/`oldPhoneE164`/
`newPhoneE164`. Extend it (union or add optional fields) to also allow:
`actorId` (id), `targetIds` (array of ids), `value` (string). Existing
`numberChanged` rows stay valid.

### 2.5 Fully silent — YES ✅ (your proposed behavior is correct)
Please make these rows fully silent, exactly as you planned:
- **No push** — skip the push path when `type === "system"`.
- **No unread bump** — mark them read by all members at insert time (populate
  `readBy` with the full member list, the same way you'd avoid counting them),
  so they never inflate unread counts for anyone.
- They should still update `lastMessageTime` (like `numberChanged` does) so the
  conversation re-sorts to the top — that's desired.

### 2.6 `messages.list` — no change
They're normal rows; `messages.list` already returns system rows untouched
(the `numberChanged` precedent proves this). Just confirm `systemKind` +
`systemMeta` ride along.

---

## Part 3 — Chats-list preview + deep-link (conversation row)
To show the event as the group's last-activity preview AND let the app jump to
it when tapped, expose the last message's system info on each conversation row
returned by `listGroups` / `listConversations`:

```jsonc
{
  // ...existing conversation fields...
  "lastMessageId": "<messages _id of the last system row>",
  "lastSystemKind": "memberAdded",
  "lastSystemMeta": { "actorId": "<userId>", "targetIds": ["<userId>"], "value": "" }
}
```
- The client renders the preview with device-saved names and **bolds** the row
  (+ a "You" pill) when the event targets the viewer.
- `lastMessageId` enables tap-to-jump: tapping such a row opens the chat and
  scrolls to that exact system message.
- If you prefer minimal effort, setting a plain `lastMessageText` (account
  names) still renders as a fallback — but `lastSystemKind`/`lastSystemMeta`
  give the nicer per-viewer names.

---

## Part 4 — Acceptance checklist
- [ ] Extend `systemMeta` validator with `actorId` / `targetIds` / `value`.
- [ ] `createGroup` inserts a `groupCreated` system row (it already sets `createdBy`).
- [ ] `addGroupMember` / `removeGroupMember` / `leaveGroup` / invite-join emit their rows with correct `actorId` + `targetIds`.
- [ ] promote / demote / transfer (groupAdmin.ts) emit their rows.
- [ ] `updateGroup` emits `groupRenamed` / `groupIconChanged` / `groupDescriptionChanged`.
- [ ] System rows: `type:"system"`, `systemKind` camelCase, silent (no push, marked read by all → no unread bump), still bump `lastMessageTime`.
- [ ] `listGroups`/`listConversations` expose `lastMessageId` + `lastSystemKind` + `lastSystemMeta`.

No mobile release is required — the client is already shipped for this contract.
Everything lights up automatically as each mutation starts emitting rows.
