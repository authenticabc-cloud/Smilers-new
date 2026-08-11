# Convex Backend Specs for Web Team — Group items (Aug 2026)

These three need Convex changes (mobile can only consume `api.*`). The native app
will build/adjust the UI once each ships. Please confirm final function names +
return shapes so the mobile UI matches exactly.

---

## SPEC 1 — Sub-group membership integrity (report item #1)

**Rule:** A sub group must NEVER contain a member who is not a member of its
PARENT group. New adds already enforce this (v6 BAD_REQUEST). This spec covers
EXISTING bad data + ongoing safety.

### 1a. One-off migration (server-side script/mutation)
For every sub group (`conversations` with `parentConversationId != null`):
- For each sub-group member `m` NOT in the parent group's members:
  - **If `m` is the sub group's `chiefAdmin`:** strip the chief role, then run the
    EXISTING auto-succession (`chiefSuccession` in native-sub-groups-contract) to
    install a valid successor (earliest-joined remaining parent-group admin, else
    earliest-joined remaining member). Then remove `m` from the sub group.
  - **Else:** remove `m` from the sub group.
- Emit the usual system messages (`chiefTransferred`, member-removed) so clients
  render the change reactively.
- Idempotent + safe to re-run.

### 1b. Ongoing enforcement (already partly done — verify)
- `subGroups.addMember` / `conversations.addGroupMember` / `joinViaInviteLink`
  already reject a non-parent-member (keep this).
- **NEW:** when a member is removed from / leaves the PARENT group, CASCADE:
  remove them from every sub group of that parent (and run sub-group chief
  auto-succession if they were a sub-group chief). This is the main ongoing hole
  that produces the bad state in #1.

### 1c. Optional query for a native "fix-it" surface
`subGroups.getOrphanMembers({ subGroupId }) → Array<{ userId, name }>` (members not
in the parent) so an admin can see/clean them from the app. Optional — the
migration + cascade above make the app UI unnecessary.

---

## SPEC 2 — Positions / role designation for PARENT groups (report item #5)

Today `subGroups.setPosition` / `listPositions` / `positionsForMother` exist ONLY
for sub groups (keyed by `subGroupId`). The user wants the SAME office-bearer /
position feature on regular PARENT groups.

**Preferred approach:** generalise positions to any group id.

New (or generalised) functions — mirror the sub-group ones but keyed by
`conversationId` (works for a parent group OR a sub group):
- `groupPositions.setPosition({ conversationId, userId, title, showInParent? })`
  - Any group admin may set/clear (empty `title` clears). `showInParent` only
    honoured for a sub group + only settable by chief (unchanged semantics).
- `groupPositions.listPositions({ conversationId }) →`
  `Array<{ userId, title, showInParent }>` (pre-sorted by the manual order below).
- `groupPositions.setPositionOrder({ conversationId, orderedUserIds })` — chief-only
  manual rank (same as sub-group `setPositionOrder`).
- For sub groups, `positionsForMother` stays as-is (parent rollup).

**Data:** reuse the `subGroupPositions` table but rename the key field to a generic
`conversationId` (or add one), plus `order`. Back-compat: keep the old
`subGroups.*` names as thin aliases so the existing sub-group UI keeps working, OR
tell us the new names and we'll switch both sub-group and parent-group screens to
them.

**Election + admin (already done on native):** the Chief-Admin ELECTION
(`chiefElections.*`) is already wired in the app for BOTH parent and sub groups
(iter-481) — no backend change needed there. Admin promote/demote/transfer
(`groupAdmin.*`) already works for parent groups. So #5's ONLY missing backend
piece is positions/roles for parent groups (above).

---

## SPEC 3 — Chat request / approval (report item #4, non-contact case)

When a user opens a group member's profile and taps **Chat** but they have no
existing relationship with that member, the user should send a **chat request**
the member must ACCEPT before a conversation opens. No such backend exists today.

### Definition of "contact" — WHEN the accept-first gate triggers  (web team's Q)
The native app has THREE server-visible relationship signals (all owned by your
Convex repo). **Open the chat DIRECTLY (NO request) when ANY of these is true;
otherwise require a chat request:**

1. **Existing conversation** — a 1:1 conversation already exists between the two
   users (`getOrCreateDirect` would return an existing id, not create one).
2. **Number saved on device** — `phoneSavedOnDevice === true`. This is the EXACT
   same signal your `groupMemberProfile.getMemberProfile` already returns and that
   drives the profile's "In your contacts" badge — reuse that logic verbatim so
   the gate matches what the user sees. (This is the "if I have his number saved"
   case from the report.)
3. **Accepted app-contact** — a `contacts` row between the two users with
   `contactStatus === 'accepted'` (same source as `contacts.getContacts`).

So: `requiresChatRequest = !(existingConversation || phoneSavedOnDevice || acceptedContact)`.

Notes:
- `phoneSavedOnDevice` is authoritative server-side because the app already syncs
  the viewer's device-contact index to the backend (that's how `getMemberProfile`
  can return it). So the backend CAN evaluate the gate itself — but the client
  will ALSO evaluate it (it has all three signals) and only call
  `chatRequests.send` when `requiresChatRequest` is true.
- Please make `getOrCreateDirect` KEEP working for the direct-open cases (1/2/3).
  The request gate is only for genuine strangers.

### Functions
- `chatRequests.send({ toUserId }) → { requestId, status }`
  - Server MUST re-check the gate: if any of (existing conversation / phoneSaved /
    acceptedContact) holds, DON'T create a request — return `{ status:'auto' }` and
    let the client open the chat. Reject if already requested (idempotent → return
    existing), or if `toUserId` blocked the caller.
- `chatRequests.getIncoming() → Array<{ _id, fromUserId, fromName, sentAt }>` (reactive)
- `chatRequests.getOutgoingStatus({ toUserId }) → 'none'|'pending'|'accepted'|'declined'|'auto'`
- `chatRequests.accept({ requestId }) → { conversationId }`  // creates/returns the 1:1 conv
- `chatRequests.decline({ requestId }) → { ok: true }`

### Data
`chatRequests: { fromUserId, toUserId, status:'pending'|'accepted'|'declined', createdAt, respondedAt? }`
indexed `by_to_status` + `by_pair`.

### Native UI (built once shipped)
- Profile Chat button → client computes `requiresChatRequest` (using the 3 signals
  it already has). If false → open chat immediately (current behaviour). If true →
  `chatRequests.send` → "Request sent, waiting for <name> to accept." (poll
  `getOutgoingStatus`).
- A "Chat requests" inbox (or a banner on Chats) driven by `getIncoming` with
  Accept/Decline; Accept opens the returned `conversationId`.

Please confirm names/shapes.
