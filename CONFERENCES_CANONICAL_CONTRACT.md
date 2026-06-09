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
| `api.chairControls` | Chair-only lifecycle (start / adjourn / breakout rooms / remove participant) |
| (others) | Breakout rooms, polls/motions if present |

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

❌ DON'T
- Don't call `api.conferences.getConferenceState` — it does not exist.
- Don't call `api.conferences.remove` — it does not exist.
- Don't call `api.conferences.joinByInviteCode` — it's `joinByCode`.
- Don't conflate `adjourn` (soft-end) with `deleteConference` (permanent).
- Don't put group conference creation under `api.groups.*` — there's no shared namespace.
