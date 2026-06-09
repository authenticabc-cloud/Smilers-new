# Groups — Product Requirements (from Smilers_script.docx)

> ⚠️ This file is the **product spec**, not the implemented backend.
> The actual Convex function names DIFFER from this PRD — see the
> backend agent's namespace map below.

## Sources of truth (in order of precedence)
1. **Backend code on Convex deployment** (queries/mutations as they actually exist).
   Reference message from backend agent on 2026-06-09:
   - `api.conversations.*` (CRUD + invite link + members)
   - `api.groupAdmin.promoteToAdmin` / `demoteFromAdmin` / `transferChiefAdmin`
   - `api.messageApproval.*` (toggle / listPending / approve / reject)
   - `api.groupRegulations.*` (list / add / update / delete)
   - `api.groupSuspensions.*` (suspendMember / liftSuspension / list)
   - `api.communities.*` (separate)
   - `api.conferences.*` (separate)
2. **Product Requirements doc** (this file's source): canonical for UI/UX behavior
   but NOT for function names.

## UI rules locked from screenshots (batch 1-4)

### Groups tab (bottom-tab entry)
- Header "Groups" + `+` create button
- Sub-tabs: 👥 Groups (default) | 📹 Conferences
- Search input "Search groups…"
- List cards: letter avatar (cream/yellow), bold name, subtitle (description or "N members"),
  right column = relative time + 👥 N count

### Create Group flow
- Step 1: "New Group / Add participants" header with back arrow
  - Contacts list with circular checkboxes on right
  - When ≥1 selected: header gets a ✓ commit icon (top right) AND
    chips appear at top (avatar + red ✕ removal)
  - Bottom CTA: "Next (N selected)"
- Step 2: "Group Details" header
  - Group avatar placeholder (people icon on cream bg)
  - **Group Name *** required field, placeholder "e.g. Family, Work Team…"
  - **Description (optional)** textarea, placeholder "What's this group about?"
  - PARTICIPANTS (N) chips including "You"
  - Bottom CTA: "Create Group" (disabled until name filled)

### Group chat shell
- Dark brown header: back · avatar · name (truncated to "Smiler…") · "N members"
- Header icons: 📞 voice · 📹 video · ⏱ chat-once timer · 🛡 E2EE shield · ⋮ overflow
- Green "End-to-end encrypted" pill banner under header
- Date separator chip (e.g. "June 8, 2026")
- Sender bubble: sender name in gold + text + 🌐 "Show original" + time
- Bottom input bar: B (bold) + 🎨 (theme) row, then 😊 · 📎 · 💬 · Message input · 🎤
- Background: pale yellow → orange gradient
- 3-dot menu (⋮) sheet: **Group info / Export chat / Media & Files /
  Scheduled messages / Mute notifications / Cancel**

### Group Info screen (admin hub)
- Yellow header "Group Info" + back
- Avatar (people icon) · **Name ✏️** (editable) · "N members" ·
  **"Admins: X/Y (20% cap)"** where Y = floor(N × 0.20) [server-enforced]
- **ADMIN ACTIONS** section (admin-only rows):
  1. **Invite Link** — trailing label "Disabled" or shows code. Tap opens modal:
     "🔗 Invite Link / Only admins can generate and share invite links" +
     yellow "Generate Invite Link" CTA
  2. **Add Members** — opens modal listing non-member contacts. Empty state:
     "Add Members / No contacts to add"
  3. **Message Approval** — toggle (default OFF)
  4. **Pending Messages** → *only visible when Message Approval is ON*
     - Empty state has orange-tinted header, ✓ icon, "All clear / No messages
       waiting for approval"
  5. **Regulations Board** → empty state: yellow header "Regulations Board /
     0 rules" + `+` header button + body "No regulations yet / Tap + to add
     group rules and guidelines" + yellow "Add Regulation" CTA
  6. **Transfer Chief Admin** — opens modal "👑 Transfer Chief Admin / You can
     transfer Chief Admin to any admin in the group" + "No eligible admins"
     empty state (requires promoting someone to admin first)
- **MEMBERS (N)** list:
  - "You" row: 👑 crown + cream "Chief Admin" pill badge + bio subtitle
  - Other members: avatar + name + bio subtitle ("Hey there! I am using Smilers." default)
  - **Right-side action icons** (admin sees these):
    - 🚫 orange = **Suspend** (NOT block) → opens Suspend Member modal:
      - Title "🚫 Suspend Member" + body "Suspended members enter spectator mode
        — they can read messages but cannot send."
      - **Duration grid**: 1 Hour / 6 Hours / **24 Hours (default-selected, yellow)** /
        7 Days / 30 Days / Permanent
      - Optional Reason textarea: "Why is this member being suspended?"
      - Red "Suspend" + "Cancel"
    - 👤➖ red = **Remove from group** (kick)
- Bottom: pink-outlined **"→ Leave Group"** · big red **"🗑 Delete Group Permanently"**
  (chief admin only)
- Floating muted-mic 🎙 (global voice-tasks button)

## Server-enforced rules
| Rule | Detail |
|---|---|
| Admin cap | 20% of member count (floor). 5 → 1, 10 → 2, etc. |
| Chief Admin | Exactly one. Transfer required before stepping down. Only chief deletes. |
| Message Approval | Toggle gates the Pending Messages queue. Pending messages do NOT appear in chat until approved. |
| Invite Link | Disabled by default. Admin must explicitly Generate. |
| Member actions | Suspend ≠ Remove. Suspended = spectator (read-only). Removed = kicked. |
| Suspend durations | 1h / 6h / 24h / 7d / 30d / Permanent |

## PRD-side proposed function shapes (DO NOT IMPLEMENT VERBATIM)
Saved verbatim from PRD for reference only. Confirm against actual backend before use:

### Conversations (PRD)
- `createConversation({ conversationType: "oneToOne"|"group", participantIds, groupName?, groupIconUrl?, messageApprovalToggle?, maxAdmins?, regulationsBoard? })`
- `getConversations({ userId })`
- `sendMessage({ conversationId, senderId, content, messageType, translationPreference?, scheduledAt?, pollOptions?, pollConfig? })`
- `getMessages({ conversationId, limit?, beforeMessageId? })`
- `addAdmin({ conversationId, adminUserId, addedByUserId })` ← BACKEND USES `groupAdmin.promoteToAdmin`
- `removeAdmin({ conversationId, adminUserId, removedByUserId })` ← BACKEND USES `groupAdmin.demoteFromAdmin`
- `assignChiefAdmin({ conversationId, newChiefAdminUserId, assignedByUserId })`
- `suspendMember({ conversationId, memberUserId, suspensionDuration, suspendedByUserId })` ← LIKELY UNDER `groupSuspensions.*`
- `liftSuspension({ conversationId, memberUserId, liftedByUserId })`

### Conferences (PRD)
- `createConference`, `joinConference`, `startConference`, `endConference`, `adjournConference`
- `muteParticipantInGroupConference`, `unmuteParticipantInGroupConference`
- `removeParticipantFromConference`, `suspendParticipantInConference`
- `makeConferenceOpenToEveryone`, `makeConferenceAdmissionBased`, `admitParticipant`
- `assignRoleInConference` (chair/clerk/protocol)
- `updateMinutesTranscription`, `updateNoticeBoard`
- `shareScreenInConference`, `stopScreenSharingInConference`
- `createPollInConference`, `voteInPoll`, `sharePollResults`
- `assignParticipantToSubConference`, `createSubConference`
- `messageInConferenceChat`

### Screen sharing (top-level, not conference)
- `initiateScreenSharing`, `stopScreenSharing`, `switchScreenSharing`

### Voice tasks
- `voiceTask({ conversationId, userId, taskType, targetContactIndex?, command? })`
- `addPreferredContactForVoiceTask({ userId, contactUserId, preferredOrder(1-10) })`
- `removePreferredContactForVoiceTask`

## What I still need before writing groups code
1. The backend team's **actual** function signatures from each of the 5 namespaces
   (preferably the raw `args: v.object({...})` blocks from each `.ts` file).
2. Confirmation that `api.conversations.create*` (NOT `createConversation` per the PRD)
   is what we should call, with the right arg names.
3. Whether the admin cap is enforced server-side (returns error) or just client-side.
4. The exact suspension duration enum values the server accepts.

— Smilers mobile agent (iter-150)
