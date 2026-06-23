# Web Team — Verify deployed Conference function signatures (mobile uses these)

The mobile conference room (`app/conference/[conferenceId]/room.tsx`) calls the
functions below, built against an older spec. The web team already confirmed
`api.conferenceRoom.*` and `api.conferenceSignaling.*` are real and exact. We
now need confirmation for the **meeting-tools** namespaces. For EACH: does it
exist on the deployed Convex, and are the **arg names** exactly as listed? If
any differ, give the correct signature.

> All calls degrade gracefully on mobile (wrapped in `safeMutate` /
> `useSafeConvexQuery`), so wrong/missing ones currently no-op silently — we want
> to make them actually work.

## 1. `api.conferenceChat.*`  (in-meeting chat)
- `getMessages({ conferenceId })` → message[]  — fields? (sender, text, _creationTime, encrypted?)
- `sendMessage({ conferenceId, text })`  — is `text` plain or encrypted? any `iv`?

## 2. `api.conferenceMinutes.*`  (Clerk role + minutes)
- `assignClerkRole({ conferenceId, targetUserId })`
- `removeClerkRole({ conferenceId, targetUserId })`

## 3. `api.conferenceSpeakerTimer.*`  (Protocol role)
- `assignProtocolRole({ conferenceId, targetUserId })`
- `removeProtocolRole({ conferenceId, targetUserId })`

## 4. `api.conferences.*`  (timer / minutes / reactions / mute-all)
- `startTimer({ conferenceId, durationSec })`
- `endTimer({ conferenceId })`
- `appendMinutes({ conferenceId, text })`
- `sendReaction({ conferenceId, emoji })`
- `muteAll({ conferenceId })`

### ⚠️ Read-side namespace mismatch — please confirm exact paths
Mobile now subscribes (live `watchQuery`) to the three reads below, but they were
GUESSED and live in DIFFERENT modules than the writes above — which is suspicious
(Convex read+write for one feature usually share a module). For each, confirm the
exact deployed query path + returned fields, or give the correct one:

- **Active speaker timer** — reading: `api.conferenceSpeakerTimer.getActiveTimer({ conferenceId })`
  - but writing via `api.conferences.startTimer` / `endTimer`. Which module is correct?
  - expected fields used by mobile: `{ endsAt?: number(ms), durationSec?: number, speakerName?: string }`
- **Minutes log** — reading: `api.conferenceMinutes.getMinutes({ conferenceId })`
  - writing via `api.conferenceMinutes.addEntry({ conferenceId, text })` (mobile uses `addEntry`, NOT `appendMinutes` — confirm name)
  - expected fields: `{ _id, text|content, authorName? }`
- **Recent reactions** — reading: `api.conferenceReactions.getRecentReactions({ conferenceId })`
  - but writing via `api.conferences.sendReaction`. Which module is correct?
  - expected fields: `{ _id, emoji }`

## 5. `api.conferenceMotions.*`  (motions)
- `getMotions({ conferenceId })` → motion[] — fields? (title, status, votesFor/Against, _id)
- `proposeMotion({ conferenceId, title })`
- ❓ **Voting:** what's the vote mutation? (e.g. `voteMotion({ conferenceId, motionId, vote: 'for'|'against' })`)
  Mobile currently can propose + list motions but has **no vote action** — need the signature.

## 6. `api.conferencePolls.*`  (polls)
- `getPolls({ conferenceId })` → poll[] — fields? (question, options[], counts, _id)
- `createPoll({ conferenceId, ... })` — exact args (question + options[]? duration?)
- ❓ **Voting:** vote mutation signature? (e.g. `votePoll({ conferenceId, pollId, optionIndex })`)

## 7. `api.breakoutRooms.*`  (breakout rooms)
- `getRooms({ conferenceId })` → room[] — fields? (name, members[], _id)
- `createRoom({ conferenceId, name })`
- `closeRoom({ conferenceId, roomId })`  — confirm `roomId` arg name
- ❓ **Join/leave** a breakout room — what mutation moves a participant into a
  breakout? And how does `getRoomState`/`getParticipants` expose which breakout a
  user is in (so the mesh can scope peers to the same breakout)?

## 8. Hand-raise (just shipped on mobile)
- `api.conferenceRoom.toggleHandRaise({ conferenceId, handRaised })` — confirm
  exact name + args (mobile assumed this, mirroring toggleMute/toggleVideo).

---
**Please reply per-section: EXISTS (sig matches) / EXISTS (corrected sig: …) /
NOT BUILT.** That lets us wire the working ones and stop calling the rest.
