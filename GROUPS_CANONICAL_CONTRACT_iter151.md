# Groups & Conferences — CANONICAL Convex Contract (iter-151)

> **This file is the single source of truth.** It supersedes the
> PRD-style `Smilers_script.docx` and `GROUPS_PRD_iter150.md`.
> All native code MUST call these exact function paths with these
> exact arg names. If a function isn't listed here, it does NOT exist
> on the server — don't guess (that's what crashed Status).

## 1. `api.conversations.*`

| Function | Type | Args | Returns |
|---|---|---|---|
| `getOrCreateDirect` | mutation | `{ otherUserId: v.id("users") }` | `Id<"conversations">` |
| `listConversations` | query | `{}` | `Array<conversation & { otherUser: user-with-online/nickname/avatar \| null }>`, sorted by `lastMessageTime` desc. Excludes groups, community convos, and blocked users. |
| `setDisappearingMessages` | mutation | `{ conversationId: v.id("conversations"), disappearAfter: v.number() }` — **seconds**; `0` = off | `null` |
| `getConversation` | query | `{ conversationId: v.id("conversations") }` | full `conversations` doc, or `null` if not a participant |
| `createGroup` | mutation | `{ name: v.string(), participantIds?: v.array(v.string()), memberIds?: v.array(v.string()), description?: v.string() }` — accepts BOTH names | `Id<"conversations">` |
| `updateGroup` | mutation | `{ conversationId, name?, description? }` | `null` (admin-only) |
| `addGroupMember` | mutation | `{ conversationId, userId: v.id("users") }` | `null` (admin-only) |
| `removeGroupMember` | mutation | `{ conversationId, userId }` | `null` (admin-only) |
| `pinMessage` | mutation | `{ conversationId, messageId?: v.id("messages") }` — omit `messageId` to unpin | `null` |
| `getPinnedMessage` | query | `{ conversationId }` | `message & { senderName }`, or `null` |
| `leaveGroup` | mutation | `{ conversationId }` | `null` |
| `deleteGroup` | mutation | `{ conversationId }` | `null` (chief-admin only; cascades messages/regulations/suspensions/pending) |
| `listGroups` | query | `{}` | `Array<group & { memberCount: number }>`, sorted by `lastMessageTime` desc |
| `getGroupMembers` | query | `{ conversationId }` | `Array<users doc>` |

## 2. `api.groupAdmin.*`

| Function | Type | Args | Returns |
|---|---|---|---|
| `promoteToAdmin` | mutation | `{ conversationId, userId }` | `null` — enforces 20% admin cap (min 1) |
| `demoteFromAdmin` | mutation | `{ conversationId, userId }` | `null` (chief-admin only) |
| `transferChiefAdmin` | mutation | `{ conversationId, newChiefAdminId: v.id("users") }` | `null`. New chief must already be an admin; non-creator chief can only transfer back to creator |
| `generateInviteLink` | mutation | `{ conversationId }` | `string` (12-char invite code); also sets `inviteLinkEnabled: true` |
| `disableInviteLink` | mutation | `{ conversationId }` | `null` |
| `joinViaInviteLink` | mutation | `{ inviteCode: v.string() }` | `Id<"conversations">` |
| `getGroupAdminInfo` | query | `{ conversationId }` | see shape below, or `null` |

### `getGroupAdminInfo` return shape
```ts
{
  chiefAdmin: Id<"users"> | null,
  createdBy: Id<"users"> | null,
  admins: Id<"users">[],
  maxAdmins: number,                  // 20% cap
  currentAdminCount: number,
  memberCount: number,
  isAdmin: boolean,
  isChiefAdmin: boolean,
  inviteCode: string | undefined,     // only present if caller is admin
  inviteLinkEnabled: boolean,
  messageApprovalEnabled: boolean,
  myId: Id<"users">
}
```

## 3. `api.messageApproval.*`

| Function | Type | Args | Returns |
|---|---|---|---|
| `toggleApproval` | mutation | `{ conversationId, enabled: v.boolean() }` | `null` (admin-only) |
| `submitForApproval` | mutation | `{ conversationId, type, text?, storageId?: v.id("_storage"), fileName?, fileSize?, mimeType?, duration?, pollId?: v.id("polls"), latitude?, longitude?, locationName?, replyToId?: v.id("messages") }` | `Id<"pendingMessages">` |
| `getPendingMessages` | query | `{ conversationId }` | `Array<pendingMessage & { senderName, senderAvatar, mediaUrl }>` (admin-only, else `[]`) |
| `getMyPendingMessages` | query | `{ conversationId }` | `Array<pendingMessages doc>` for the caller |
| `approveMessage` | mutation | `{ pendingMessageId: v.id("pendingMessages") }` | `void` — creates real message, schedules translate/transcribe/moderation/expiry |
| `rejectMessage` | mutation | `{ pendingMessageId, reason?: v.string() }` | `null` |
| `getPendingCount` | query | `{ conversationId }` | `number` (admin-only badge; else `0`) |
| `getApprovalStatus` | query | `{ conversationId }` | `{ enabled: boolean, isAdmin: boolean }` or `null` |

`submitForApproval.type` strict union: `text | image | video | audio | file | voice | poll | location`

## 4. `api.groupRegulations.*`

| Function | Type | Args | Returns |
|---|---|---|---|
| `getRegulations` | query | `{ conversationId }` | `Array<regulation & { creatorName }>`, ordered by `order` |
| `addRegulation` | mutation | `{ conversationId, title: v.string(), content: v.string(), pinned?: v.boolean() }` | `Id<"groupRegulations">` (admin-only) |
| `updateRegulation` | mutation | `{ regulationId: v.id("groupRegulations"), title?, content?, pinned? }` | `null` (admin-only) |
| `deleteRegulation` | mutation | `{ regulationId }` | `null` (admin-only) |
| `reorderRegulations` | mutation | `{ conversationId, regulationIds: v.array(v.id("groupRegulations")) }` | `null` — order = array position + 1 |
| `getRegulationCount` | query | `{ conversationId }` | `number` |

## 5. `api.groupSuspensions.*`

| Function | Type | Args | Returns |
|---|---|---|---|
| `suspendMember` | mutation | `{ conversationId, userId, duration, reason?: v.string() }` | `null` (admin-only; chief-admin required to suspend other admins) |
| `liftSuspension` | mutation | `{ conversationId, userId }` | `null` (admin-only) |
| `getMyGroupSuspension` | query | `{ conversationId }` | active `suspension & { isExpired: boolean }`, or `null` |
| `getGroupSuspensions` | query | `{ conversationId }` | `Array<suspension & { userName, userAvatar, suspendedByName }>` (admin-only) |
| `isSuspended` | query | `{ conversationId, userId }` | `boolean` |
| `expireStale` | mutation | `{ conversationId }` | `null` — marks expired active suspensions |

`duration` strict literal union: `"1h" | "6h" | "24h" | "7d" | "30d" | "permanent"`

## Error contract
- All **mutations** throw `ConvexError` with a `code` field:
  - `UNAUTHENTICATED`, `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST`, `CONFLICT`
- All **queries** silently return `[]` / `null` / `0` when unauthorized (NEVER throw).

## Native screens → server function map

| Screen | Reads | Writes |
|---|---|---|
| Groups tab (`/(tabs)/groups.tsx`) | `conversations.listGroups` | – |
| Create Group (`/groups-create.tsx`) | `contacts.getContacts` | `conversations.createGroup` |
| Group chat (`/group/[id].tsx`) | `conversations.getConversation`, `conversations.getGroupMembers`, `conversations.getPinnedMessage`, `messages.*`, `groupSuspensions.getMyGroupSuspension`, `messageApproval.getApprovalStatus` | `messages.send` OR `messageApproval.submitForApproval` (depending on approval toggle), `conversations.pinMessage`, `conversations.setDisappearingMessages` |
| Group Info (`/group/[id]/info.tsx`) | `conversations.getConversation`, `conversations.getGroupMembers`, `groupAdmin.getGroupAdminInfo`, `groupSuspensions.getGroupSuspensions` | `conversations.updateGroup`, `conversations.addGroupMember`, `conversations.removeGroupMember`, `conversations.leaveGroup`, `conversations.deleteGroup`, `groupAdmin.promoteToAdmin`, `groupAdmin.demoteFromAdmin`, `groupAdmin.transferChiefAdmin`, `groupAdmin.generateInviteLink`, `groupAdmin.disableInviteLink`, `messageApproval.toggleApproval`, `groupSuspensions.suspendMember`, `groupSuspensions.liftSuspension` |
| Pending Messages (`/group/[id]/pending.tsx`) | `messageApproval.getPendingMessages`, `messageApproval.getPendingCount` | `messageApproval.approveMessage`, `messageApproval.rejectMessage` |
| Regulations Board (`/group/[id]/regulations.tsx`) | `groupRegulations.getRegulations`, `groupRegulations.getRegulationCount` | `groupRegulations.addRegulation`, `groupRegulations.updateRegulation`, `groupRegulations.deleteRegulation`, `groupRegulations.reorderRegulations` |
| Join-by-link (handles `smilers://join/CODE`) | – | `groupAdmin.joinViaInviteLink` |

## Iter-147 bug to fix while at it
The iter-147 disappearing-messages code in `app/chat/[conversationId].tsx`
calls `api.conversations.setDisappearAfter` (wrong name) with milliseconds.
Correct call is `api.conversations.setDisappearingMessages({ conversationId,
disappearAfter: <seconds> })`. Fix BEFORE wiring it into the group chat.

— Smilers mobile agent (iter-151, after canonical contracts from backend agent)
