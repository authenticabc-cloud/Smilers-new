# Convex Backend Contract — Groups Slice A

The native mobile Group Details screen (`/app/group/[id]`) calls the following
Convex queries + mutations. The web team must ship matching server-side
implementations so the actions actually persist. Until they do, the mobile
screen still renders and surfaces an inline 'needs latest backend update'
alert for each missing endpoint.

All `conversationId` and `userId` fields are Convex IDs (strings on the wire).

---

## Queries

### `conversations.getGroupDetails({ conversationId })`

Should return a single group conversation object the screen consumes:

```ts
{
  _id: Id<"conversations">,
  name: string,
  description?: string,
  avatar?: string,            // URL or storageId-resolved URL
  memberCount?: number,       // optional, fallback to memberRecords.length
  messageApprovalRequired?: boolean,
  viewerUserId?: string,      // current authed user's id; used to gate admin UI
  viewerSuspendedUntil?: number,  // ms-since-epoch — when set, mobile shows
                                  // a red "Suspended · spectator mode" banner
                                  // and hides the composer + reactions
  memberRecords: Array<{      // OR `members` / `participants` (any accepted)
    userId: string,
    name?: string,            // display name; resolved server-side preferred
    avatar?: string,
    role?: "chief" | "admin" | "member",
    suspendedUntil?: number,  // ms-since-epoch; in the future = still suspended
    blocked?: boolean,
  }>,
}
```

If the field doesn't exist yet, the screen falls back to a row from
`conversations.listGroups`. The richer shape simply makes admin features work.

### `conversations.listRegulations({ conversationId })`

Returns the regulations board, oldest first:

```ts
Array<{
  _id: Id<"groupRegulations">,
  text: string,
  postedByUserId: string,
  createdAt: number,
}>
```

---

## Mutations (all admin-gated server-side)

| Name | Args | Notes |
|------|------|-------|
| `conversations.updateGroup` | `{ id, name?, description? }` | future use |
| `conversations.addMembers` | `{ conversationId, userIds: string[] }` | from `/groups-create?addToConversation=…` |
| `conversations.removeMember` | `{ conversationId, userId }` | admin only |
| `conversations.promoteToAdmin` | `{ conversationId, userId }` | enforces ≤20% admins per spec |
| `conversations.demoteAdmin` | `{ conversationId, userId }` | chief admin only |
| `conversations.suspendMember` | `{ conversationId, userId, durationMs }` | spec: 24h / 7d / 1w; suspended admins lose all rights |
| `conversations.unsuspendMember` | `{ conversationId, userId }` | only chief admin can lift Admin suspensions |
| `conversations.blockMember` | `{ conversationId, userId }` | admin only |
| `conversations.passChiefAdmin` | `{ conversationId, toUserId }` | spec: original creator can always reclaim; non-creator chief can only pass back to creator until creator leaves |
| `conversations.toggleMessageApproval` | `{ conversationId, enabled }` | admin gate for message approval feature |
| `conversations.generateInviteLink` | `{ conversationId }` → `{ url, expiresAt }` | admin only |
| `conversations.postRegulation` | `{ conversationId, text }` | admin only; max 400 chars |
| `conversations.leaveGroup` | `{ conversationId }` | for any member |

Error contract: throw `ConvexError` with a descriptive `message` — the mobile
client surfaces it directly in an alert.

---

## Spec-driven server-side enforcement (NOT mobile concerns)

The mobile UI gates visibility based on the viewer's role hint, but final
authorization must be enforced server-side per the spec:

* Admin cap: `floor(memberCount * 0.2)` minimum guarantees at least one admin
* Chief admin: exactly one per group; suspended admin loses all admin rights
* Suspension: while `suspendedUntil > now`, block all `messages.send` writes
  from that user in this group + hide reactions/composer
* Message approval: when toggled on, route new messages to a pending queue
  the admin can approve/reject (mobile UI for the queue is in Slice B)

---

# Conferences contract — Slice C

The mobile ConferenceHUD (`/app/src/components/ConferenceHUD.tsx`) and the
Conference Create screen (`/app/app/conference-create.tsx`) call these
endpoints. All wrapped in `safeCall` — mobile renders cleanly when missing.

## Query

### `conferences.getConferenceState({ conferenceId })`

Returns the current conference snapshot:

```ts
{
  _id: Id<"conferences">,
  title: string,
  mode: "video" | "audio",
  entryMode: "open" | "invite",
  viewerRole: "chair" | "clerk" | "protocol" | "participant",
  allMuted: boolean,
  pendingUnmuteRequests?: Array<{ userId: string; requestedAt: number }>,
  pendingUnmuteCount?: number,         // server-computed convenience
  timerEndsAt?: number,                // ms-since-epoch; null when no timer
  notice?: string,                     // notice board content (Clerk-edited)
  minutesTranscript?: string,          // pre-joined plain text (Clerk-only)
  minutes?: Array<{ text: string; at?: number; speaker?: string }>,
  participants?: Array<{ userId, name, role, micMuted, cameraOff, raisedHand }>,
  lobby?: Array<{ userId, name, requestedAt }>,
}
```

## Mutations

| Name | Args | Notes |
|------|------|-------|
| `conferences.startConference` | `{ title, mode, entryMode, groupId?, clerkUserId?, protocolUserId?, description?, scheduledAt?, recurring?, frequency? }` → `{ conferenceId }` | Chair = caller. Returns the new id used for routing. The mobile client now also sends optional **`description`** (string), **`scheduledAt`** (ms-since-epoch — when set the conference is scheduled, not started immediately), **`recurring`** (boolean), and **`frequency`** (`"daily" \| "weekly" \| "monthly" \| "yearly"`, only when `recurring=true`). Mobile uses a progressive-fallback submit: if the deployed validator rejects the full payload, it retries without `recurring`/`frequency`, then without `scheduledAt`, finally with only the core fields — so old backends still create a conference and the scheduling metadata stays cached on-device until you ship the new fields. |
| `conferences.muteAll` | `{ conferenceId, enabled }` | Chair only — gates incoming audio at media SFU layer. |
| `conferences.requestUnmute` | `{ conferenceId }` | Participant signals they want to talk. Spec: voice + pop-up notify the chair. |
| `conferences.approveAllUnmute` | `{ conferenceId }` | Chair-batch approve. |
| `conferences.approveUnmute` / `declineUnmute` | `{ conferenceId, userId }` | per-user, with the spec's confirm/decline pop-up on the participant side. |
| `conferences.sendReaction` | `{ conferenceId, kind: "raise_hand" \| "question" \| "motion" \| "second_motion" }` | broadcast to all. |
| `conferences.setNotice` | `{ conferenceId, text }` | Clerk only. |
| `conferences.appendMinutes` | `{ conferenceId, text }` | Clerk only; private. |
| `conferences.exportMinutes` | `{ conferenceId }` | Clerk only → emails PDF. |
| `conferences.startTimer` | `{ conferenceId, durationMs, withBell }` | Protocol only. |
| `conferences.endTimer` | `{ conferenceId }` | Chair or Protocol. |
| `conferences.forceVideoOff` | `{ conferenceId, userId }` | Protocol only. |
| `conferences.admit` | `{ conferenceId, userId }` | Protocol only. |
| `conferences.endMeeting` | `{ conferenceId }` | Chair only — closes the call. |
| `conferences.adjourn` | `{ conferenceId }` | Chair only — adjournment per Robert's Rules; broadcast voice + sound + end. |
| `conferences.passRole` | `{ conferenceId, role, toUserId }` | Chair → Chair, Chair → Clerk, Chair → Protocol assignments; per spec, leaving Chair auto-promotes next-in-line. |

## Routing contract

Mobile routes into `/call/<conferenceId>?type=video&conferenceMode=1`
(or `type=voice` for audio). The `conferenceMode=1` query opts the call
screen into mounting the `ConferenceHUD` overlay. Convex `Id<"conferences">`
strings must be compatible with the existing call screen's
`conversationId` validation regex (`/^[a-z0-9]+$/i`).
