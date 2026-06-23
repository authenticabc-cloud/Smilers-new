# Group Voice Calling — Phase Plan & Verified Contracts (Jun 2026)

Decision: **No LiveKit / SFU.** Match the web app exactly = WebRTC peer connections +
Convex signaling. Confirmed directly by the web team.

## Verified contracts (from web team)

### 1. Signaling — `api.signaling.*`, scoped by `callId`
- One **shared `callId`** (the `calls` doc id) for the whole group call.
- `api.signaling.send({ callId, toUserId, type, payload, encrypted?, iv? })`
  - `type`: `'offer' | 'answer' | 'ice-candidate'`
  - `payload`: JSON string (SDP or ICE candidate)
  - addressed to a specific peer via **`toUserId`**
- Polled incoming messages carry **`fromUserId`** → tells you which peer sent it.
- `api.signaling.poll({ callId })`, `api.signaling.markConsumed(...)`, `api.signaling.cleanup(...)`
- Peers discover each other via the participant roster (below), NOT via signaling.

### 2. Conference roster — `api.conference.*` (SINGULAR), keyed by `callId`
- `joinConference`, `leaveConference`, `getParticipants`, `getMyState`
- `toggleSelfMute`, `toggleHandRaise`
- `adminMuteParticipant`, `adminMuteAll`
- ⚠️ `api.conferenceRoom.*` does **NOT** exist (the mobile scheduled-conference
  `app/conference/[conferenceId]/room.tsx` is wired to this phantom namespace and
  silently no-ops — it is a SEPARATE scheduled-events feature, `api.conferences.*`
  plural, unrelated to group calls).

### 3. TURN — `GET {CONVEX_SITE_URL}/turn-credentials`  ✅ DONE (Phase 1)
- Returns `RTCIceServer[]` (Twilio ephemeral, ~1h TTL; STUN fallback).
- CONVEX_SITE_URL = `EXPO_PUBLIC_CONVEX_URL` with `.convex.cloud` → `.convex.site`.
- Implemented in `src/lib/webrtc/iceServers.ts` → `fetchTurnServers()` /
  `getPeerConnectionConfig()`; `CallSession.createPeerConnection()` now uses it
  (falls back to the static list on error). Verified live via curl.

### 4. Start / ring a (group) call
- `api.calls.initiateCall({ conversationId, callType })` → creates ONE `callId`,
  rings all other members (web push + Expo push + emergent data-only call push).
- Mobile already calls this in `src/lib/twilio/startCall.ts`.

## ⚠️ Current limitation (both web AND mobile)
The media path is **1:1 today** — the web client opens a single peer connection
even in groups. Roster / mute / hand-raise are live, but true **mesh fan-out**
(every peer ↔ every other peer) is a future build. Web team is building mesh
"soon"; mobile should ship its mesh alongside so cross-platform groups connect.

## Phase 2 — mesh media (do alongside web mesh)
The existing `src/lib/webrtc/CallSession.ts` is already single-remote-peer and its
`SignalMessage` already carries `callId` + `toUserId`. Mesh = **one `CallSession`
per remote participant**, managed by a new `MeshCallController`:

1. On join: `api.conference.joinConference({ callId })`, subscribe to
   `api.conference.getParticipants({ callId })`.
2. For each OTHER participant, create a `CallSession({ callId, remoteUserId })`.
   - **Glare rule (deterministic offerer):** the peer whose `userId` is
     lexicographically smaller creates the offer; the other waits. (Confirm the
     web app's exact rule before shipping.)
3. Route polled signals by `fromUserId` → the matching `CallSession`
   (`session.handleSignal(...)`). Single shared poll loop on `callId`.
4. Mix all remote audio tracks (each session exposes its own `remoteStream`).
5. On participant leave (roster update): tear down that `CallSession` only.
6. Mute = `api.conference.toggleSelfMute` + disable local audio track.
7. Leave = `api.conference.leaveConference` + close all sessions.

Home for the UI: the real call screen `app/call/[conversationId].tsx` (has media),
NOT the scheduled-conference `room.tsx`. Render the `api.conference.*` roster grid
there when the call is a group call.

## Open questions for web team before Phase 2
- Exact glare/offerer rule for mesh (who offers to whom).
- `getParticipants` result shape (fields: userId, name, avatar, isMuted, handRaised, role?).
- Whether `getMyState` is needed for self mute/hand state or derivable from roster.
