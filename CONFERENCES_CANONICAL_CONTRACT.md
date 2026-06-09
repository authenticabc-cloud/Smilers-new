# Conferences — Canonical Backend Contract (confirmed iter ≥ 152)

> **⚠️ CRITICAL FOR FUTURE AGENTS**
> Just like Groups, Conferences are split across **multiple Convex namespaces**.
> Never guess — refer to this file before touching any conference flow.

## Confirmed namespaces (12 Convex modules)

| Namespace | Purpose |
|---|---|
| `api.conferences` | CRUD, listing, lifecycle (create / get / delete / join / adjourn / endMeeting), live state, mute-all, reactions, notice, minutes, timer |
| `api.conferenceRoom` | Live in-room state & per-participant admin actions (room state, join/leave, toggle mute/video, admit/deny, suspend/remove, force mute) |
| `api.conferenceChat` | In-meeting chat (`getMessages`, `sendMessage`) |
| `api.conferenceMinutes` | Clerk role assignment + minute-related (`assignClerkRole`, `removeClerkRole`) |
| `api.conferenceSpeakerTimer` | Protocol role + speaker timer (`assignProtocolRole`, `removeProtocolRole`, `startTimer`, `endTimer`) |
| `api.chairControls` | Chair-only lifecycle (start / adjourn / participant management — does NOT host breakout rooms) |
| `api.conferenceMotions` | **Motions** — `proposeMotion`, `secondMotion`, `openVoting`, `castVote`, `closeVoting`, `withdrawMotion`, `getMotions`, `hasVoted` |
| `api.conferencePolls` | **Polls** — `createPoll`, `vote`, `closePoll`, `getPolls` |
| `api.breakoutRooms` | **Breakout rooms** — `createRoom`, `joinRoom`, `leaveRoom`, `closeRoom`, `closeAllRooms`, `moveParticipant`, `getRooms` |

---

## Confirmed function signatures — Motions / Polls / Breakout (iter 154)

### `api.conferenceMotions.*`
```ts
proposeMotion({ conferenceId: Id<"conferences">, title: string })   // mutation
secondMotion({ motionId: Id<"conferenceMotions"> })                 // mutation
openVoting({ motionId: Id<"conferenceMotions"> })                   // mutation (chair)
castVote({ motionId: Id<"conferenceMotions">, vote: "for" | "against" | "abstain" })  // mutation
closeVoting({ motionId: Id<"conferenceMotions"> })                  // mutation (chair)
withdrawMotion({ motionId: Id<"conferenceMotions"> })               // mutation (proposer)
getMotions({ conferenceId: Id<"conferences"> })                     // query → motions[] (desc)
hasVoted({ motionId: Id<"conferenceMotions"> })                     // query → boolean
```
> ⚠️ `proposeMotion` takes `title` (not `text`). No `description` arg.
> ⚠️ Don't call `propose` or `.create` — those don't exist.

### `api.conferencePolls.*`
```ts
createPoll({
  conferenceId: Id<"conferences">,
  question: string,
  options: string[],
  allowMultiple?: boolean,
  isAnonymous?: boolean,
})                                                                  // mutation (chair)
vote({ pollId: Id<"conferencePolls">, optionId: string })           // mutation
closePoll({ pollId: Id<"conferencePolls"> })                        // mutation (chair)
getPolls({ conferenceId: Id<"conferences"> })                       // query → polls[]
```
> ⚠️ `vote` takes `optionId: string` (the option's id/value), NOT an index.

### `api.breakoutRooms.*`
```ts
createRoom({
  conferenceId: Id<"conferences">,
  name: string,
  durationMinutes?: number,
  assignedUserIds?: Id<"users">[],
})                                                                  // mutation (chair)
joinRoom({ conferenceId: Id<"conferences">, roomId: Id<"breakoutRooms"> })   // mutation
leaveRoom({ conferenceId: Id<"conferences"> })                      // mutation
closeRoom({ roomId: Id<"breakoutRooms"> })                          // mutation (chair)
closeAllRooms({ conferenceId: Id<"conferences"> })                  // mutation (chair)
moveParticipant({
  conferenceId: Id<"conferences">,
  targetUserId: Id<"users">,
  roomId: Id<"breakoutRooms"> | null,   // null = back to main room
})                                                                  // mutation (chair)
getRooms({ conferenceId: Id<"conferences"> })                       // query → rooms[]
```
> ⚠️ Breakout rooms live in **`api.breakoutRooms`**, NOT `api.chairControls`.
> ⚠️ All mutations throw `ConvexError` with `UNAUTHENTICATED` / `NOT_FOUND` / `FORBIDDEN` codes — `safeMutate` handles these gracefully.

---

## Confirmed function signatures (most-used)

### `api.conferences.create`
```ts
{
  title: string,
  description?: string,
  type: 'video' | 'audio',
  accessMode: 'open' | 'admission',
  scheduledAt: string,            // ISO
  isRecurring?: boolean,
  frequency?: 'daily' | 'weekly' | 'monthly' | 'yearly',
} → Id<"conferences">
```

### `api.conferences.get`  (← detail used by info screen)
```ts
{ conferenceId: Id<"conferences"> } → ConferenceDetail
```
Returns the full conference document PLUS an enriched `participants[]`:
- Conference fields: `_id, _creationTime, title, description?, type, creatorId, chairId, inviteCode, accessMode, status, scheduledAt, isRecurring?, frequency?, startedAt?, endedAt?, adjournedAt?, e2eeEnabled?, e2eeSalt?`
- Each participant: `{ userId, userName, userAvatar?, role: 'chair'|'clerk'|'protocol'|'participant', status: 'invited'|'waiting'|'active'|'suspended'|'removed'|'left', isMuted?, videoEnabled?, joinedAt? }`

### `api.conferences.joinByCode`  (← invite-code join)
```ts
{ inviteCode: string } → Id<"conferences">
```
> ⚠️ Note: **not** `joinByInviteCode`. Arg key is `inviteCode`. No `acceptInvite` exists.

### `api.conferences.deleteConference`  (← permanent delete)
```ts
{ conferenceId: Id<"conferences"> } → void
```
- Creator-only. Throws `FORBIDDEN` otherwise.
- Removes all conference roles + the conference document. Permanent.
- `api.conferences.remove` does NOT exist.
- `adjourn` is a **soft-end only** — different semantics.

### `api.conferences.listMyConferences`
Used by the Groups tab "Conferences" sub-view.
Falls back to `listAll` if missing.

### `api.conferences.{muteAll, requestUnmute, approveAllUnmute, sendReaction, setNotice, appendMinutes, exportMinutes, startTimer, endTimer, endMeeting, adjourn}`
Used by `ConferenceHUD`.

### `api.conferenceRoom.getRoomState`  (← NOT `api.conferences.getConferenceState`)
```ts
{ conferenceId: Id<"conferences"> } → RoomState
```
> ⚠️ `api.conferences.getConferenceState` does **not** exist. The HUD previously called this; now corrected.

### `api.conferenceRoom.{joinRoom, leaveRoom, toggleMute, toggleVideo, admitParticipant, denyParticipant, suspendParticipant, removeParticipant, forceMuteParticipant}`
Per-participant admin actions used by the room screen.

### `api.conferenceChat.{getMessages, sendMessage}`
In-meeting chat. The mobile client encodes audience targeting as a text prefix (`[To: Chair] …` / `[To: Clerk] …`) since the backend signature doesn't yet accept `audience` field.

---

## Mobile route map

| Path | Purpose |
|---|---|
| `(tabs)/groups.tsx` (conferences sub-tab) | Conference LIST + join-by-code |
| `/conference-create` | Create new conference (title, type, schedule, recurring, access) |
| `/conference/[conferenceId]` | **INFO screen** (invite code, participants, Enter Room / Delete) ← NEW iter152 |
| `/conference/[conferenceId]/room` | **ROOM screen** (grid, lobby, force-mute, chat) ← MOVED iter152 |

---

## DO / DON'T

✅ DO
- Use `api.conferences.get` for full conference detail (incl participants).
- Use `api.conferences.joinByCode({ inviteCode })` — arg key is `inviteCode`.
- Use `api.conferences.deleteConference` for permanent delete; show "Only creator can delete" on `FORBIDDEN`.
- Use `api.conferenceRoom.getRoomState` for live in-call state.
- Use `api.conferenceMotions.proposeMotion({ conferenceId, title })` for motions — `title`, not `text`.
- Use `api.conferencePolls.createPoll({ conferenceId, question, options })`; vote takes `optionId: string`, not an index.
- Use `api.breakoutRooms.createRoom({ conferenceId, name, ... })` for breakout rooms — NOT `api.chairControls.*`.

❌ DON'T
- Don't call `api.conferences.getConferenceState` — it does not exist.
- Don't call `api.conferences.remove` — it does not exist.
- Don't call `api.conferences.joinByInviteCode` — it's `joinByCode`.
- Don't conflate `adjourn` (soft-end) with `deleteConference` (permanent).
- Don't put group conference creation under `api.groups.*` — there's no shared namespace.
- Don't call `api.conferenceMotions.propose` or `.create` — the function is `proposeMotion`.
- Don't call `api.conferencePolls.create` — the function is `createPoll`.
- Don't call `api.chairControls.createBreakoutRoom` — breakout rooms live in `api.breakoutRooms.createRoom`.
