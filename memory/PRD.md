# Smilers Mobile App — PRD

## iter-276 (Jun 2026): Device-B auto-switch sync fix + profile-photo save-approval + screenshot block
**#1 Device B auto-switch FIXED (synchronous overlay dismiss).** B's diagnostic logs showed `FIRING → triggerMeshUpgrade → router.replace → group-call` all firing, but the iter-275 `callHost.end()` was deferred via `setTimeout(…,60)` and that timer NEVER ran on B (`callHost.end() done` log absent) — Android throttled the timer during the nav transition while the overlay (zIndex 9000) kept covering group-call. Fix (`app/call/[conversationId].tsx` `triggerMeshUpgrade.navigate`): call `callHost.end()` **synchronously** right after `router.replace` (no timer). Works for both A (fromModal, after the 350ms modal-dismiss) and B (rAF path).
**#2 Profile-photo save-by-approval (Convex-synced) — mobile UI shipped.** User rule: trustees save freely; everyone else taps "Request to save" → owner gets an Approve/Decline banner; can only save once approved; owner offline → "Awaiting approval" (no auto-save).
  - Requester (`app/user/[userId].tsx` photo viewer): when server `canSavePhoto` is true → direct Save (existing). When false → "Request to save" → `api.photoSaveRequests.request({ownerId})` → "Awaiting … approval" state. Graceful "Not available yet" if backend fn missing.
  - Owner (`src/components/PhotoSaveRequestBanner.tsx`, mounted in Chats tab): subscribes `api.photoSaveRequests.getIncoming`, Approve/Decline → `api.photoSaveRequests.respond({requestId, accept})`. Renders nothing until backend deploys.
  - **Backend spec for web team:** `/app/PHOTO_SAVE_REQUEST_BACKEND_SPEC.md` (extend per-viewer `canSavePhoto` to include trustees + one-time approval grant; new `photoSaveRequests.request/getIncoming/respond`).
**#3 Profile photo screenshot block.** `app/user/[userId].tsx` toggles `preventScreenCaptureAsync('profile-photo')` while the enlarged photo viewer is open, `allowScreenCaptureAsync` on close (native-only; no-op web).
**#4 Photo upload (iter-275) confirmed WORKING by user.**
⚠️ NATIVE BUILD required to validate auto-switch + screenshot block. Lint clean on all changed files; web bundle builds; app boots.


## iter-275 (Jun 2026): P0 — 1:1→Mesh auto-switch ROOT CAUSE + photo-upload silent-hang fix
**#1 Auto-switch (1:1 → Mesh) — TRUE ROOT CAUSE found.** User confirmed BOTH parties stay on the 1:1 screen until they tap End, which then drops them into the conference. The diagnostic logs already showed `[adhoc-upgrade] router.replace → group-call` firing — so navigation *ran* but had no visible effect. Cause: the call UI is NOT a real route — since iter-261 it's rendered by the root-mounted `<CallHost/>` overlay driven by the `callHost` store. `router.replace('/group-call/...')` only swaps the UNDERLYING expo-router screen; the 1:1 overlay stays mounted ON TOP (store still holds params), so users keep seeing the 1:1 screen until `callHost.end()` runs (which only happened on tapping End). **Fix** (`app/call/[conversationId].tsx` `triggerMeshUpgrade.navigate`): after `router.replace(dest)`, defer ~60ms then call `callHost.end()` to dismiss the overlay and reveal the group-call screen underneath. The live PC/streams are already `detachForHandoff()`-stashed before navigating, so ending the overlay does NOT drop the call (close() is a no-op on the detached pc); the group-call screen adopts the handoff. Applies to BOTH initiator (fromModal) and receiver paths.
**#2 Photo upload "stuck in composer, no alert" — silent-hang hardening.** No error alert + photo stuck = `uploadFile`'s one-shot `convex.mutation(messages.generateUploadUrl)` hanging forever on the auth-handshake race (same failure class as trustees/languages/call-pills). **Fixes:** (a) `src/lib/uploadFile.ts` now races the upload-URL mutation against a 25s timeout → a stalled handshake throws a clear error instead of hanging. (b) `sendImageFromUri` (`app/chat/[conversationId].tsx`) now logs each step (`IMG send start / upload OK / meta / messages.send OK`) to the in-app Diagnostic Logs export and surfaces `errorValue.data.message` verbatim in the alert; the previously-silent `!isConversationAvailable` early-return now shows an alert too. Next device test + log export will pinpoint the exact failing step if it persists.
**⚠️ NATIVE BUILD REQUIRED to validate both** (WebRTC + native upload don't run on web/Expo Go). Lint clean on all 3 files; web bundle builds; app boots to Sign In.


## iter-274 (Jun 2026): Conference — poll voting + timer/minutes/reactions read displays
In `app/conference/[conferenceId]/room.tsx`:
- **Poll voting wired:** polls now render each option as a tappable button → `api.conferencePolls.vote({pollId, optionId})` (shows vote count if present; disabled when poll closed).
- **Read subscriptions added** (confirmed web queries): `conferenceMinutes.getMinutes` → minutes list in Minutes panel; `conferenceSpeakerTimer.getActiveTimer` → active-timer block (remaining secs from `endsAt`/`durationSec`) in Timer panel; `conferenceReactions.getRecentReactions` → drives the floating reactions overlay (was reading stale `state.recentReactions`).
- Lint clean; web bundle builds (web:200); app boots. NATIVE BUILD required to validate.
- ⚠️ Still unconfirmed: timer **start/end** namespace (left `conferences.startTimer/endTimer`); option/field shapes for polls/minutes/timer/reactions read defensively (multiple key fallbacks) — adjust if web shapes differ. Conference feature now: voice+video mesh, mic/cam toggles, roster/roles, speaking indicator, breakout peer-scoping + join, motion voting, poll voting, minutes/timer/reactions displays, chat. (Hand-raise intentionally absent — not supported by formal-conference backend.)


## iter-273 (Jun 2026): Conference meeting-tools wired to confirmed backend + breakout mesh scoping
Web team confirmed exact signatures. Changes in `app/conference/[conferenceId]/room.tsx`:
- **Breakout-room peer scoping (option a):** mesh now connects ONLY participants in the SAME breakout (`peerUserIds` filtered by `conferenceRoles.breakoutRoomId` from getRoomState; null=main). Added **Join** button per breakout room → `api.breakoutRooms.joinRoom({conferenceId, roomId})`.
- **Hand-raise REMOVED** from formal conference (web confirmed it does NOT exist there — only group calls have it; `conferenceRoles` has no handRaised field). Removed the button/handler/mutation added in iter-272. (Speaking indicator from iter-272 stays — it's client-side getStats.)
- **Namespace fixes:** `muteAll`→`api.chairControls.muteAll`; minutes append→`api.conferenceMinutes.addEntry`.
- **Motion voting added:** For/Against/Abstain per motion → `api.conferenceMotions.castVote({motionId, vote})`.
- ⚠️ **Poll voting NOT wired yet** (`api.conferencePolls.vote({pollId, optionId})` declared, eslint-disabled) — polls render doesn't list options; needs option rendering. FOLLOW-UP. Also not yet wired: reads for active timer (`conferenceSpeakerTimer.getActiveTimer`), minutes log (`conferenceMinutes.getMinutes`), reactions (`conferenceReactions.getRecentReactions`); and timer start/end namespace unconfirmed (left as `conferences.*`).
Lint clean; web bundle builds (web:200); app boots. NATIVE BUILD required to validate media/votes. Full contract: web repo `docs/CONFERENCE_MEETING_TOOLS_NATIVE_CONTRACT.md`; my verify doc `/app/docs/WEB_TEAM_VERIFY_conference_tools_signatures.md`.


## iter-272 (Jun 2026): Conference — speaking indicator + hand-raise UI
- **Speaking indicator:** `MeshPeer` now reads WebRTC `getStats()` audio levels (`getInboundAudioLevel` from inbound-rtp, `getLocalAudioLevel` from media-source). `MeshController` polls every 700ms and emits `onSpeakingChange({ [peerUserId]:bool, __local:bool })` (threshold 0.02; local gated by mic-enabled). `useConferenceMesh` exposes `speaking`. Conference `ParticipantTile` shows a green ring (`tileSpeaking`) on the active talker.
- **Hand-raise:** added `api.conferenceRoom.toggleHandRaise({conferenceId, handRaised})` mutation + a "Raise/Lower hand" control in the room's bottom bar (extended `SelfControl` with an `mci` flag for the MaterialCommunityIcons `hand-back-right` icon). Tile already renders the hand-raised badge from `participant.handRaised`.
- ⚠️ **ASSUMED** `api.conferenceRoom.toggleHandRaise` arg shape (parallel to toggleMute/toggleVideo) — web team to confirm; calls degrade gracefully via `safeMutate` if wrong. Lint clean; web bundle builds; app boots. NATIVE BUILD required to validate speaking levels (getStats audioLevel support is native-only).


## iter-271 (Jun 2026): Conference = voice AND video (mesh) + confirmed signaling
- Web team confirmed all `api.conferenceSignaling.*` shapes are EXACT 1:1 matches with my native impl (send `{conferenceId,toUserId,type:'offer'|'answer'|'ice-candidate',payload}`; poll `{conferenceId}`→`[{_id,fromUserId,toUserId,type,payload,consumed}]`; markConsumed `{messageIds}`; plus `cleanupMine({conferenceId})` on leave). No signaling changes needed.
- **Conference is voice+video** (unlike group calls which are voice-first). Extended `MeshController` with `video` option + `setVideoEnabled`/`getLocalStream` (getUserMedia now requests camera for video confs; MeshPeer already exchanges all tracks). `useConferenceMesh` now accepts `videoEnabled`/`cameraOn`, exposes `remoteStreams`+`localStream`, and calls `conferenceSignaling.cleanupMine` on unmount.
- **room.tsx**: detects `conference.type==='video'`, runs the video mesh, lazy-loads web-safe `RTCViewWrapper` → renders each participant's live `RTCView` (self mirrored) in the existing `ParticipantTile` video area (falls back to avatar when no stream). Mic + camera buttons now control the real tracks instantly (optimistic local mirrors synced from server `isMuted`/`videoEnabled`). Lint clean; web bundle builds; app boots.
- **NATIVE BUILD required** to validate (no WebRTC on web/Expo Go). Follow-ups: speaking indicator + hand-raise UI; breakout-room peer scoping (mesh currently connects all active participants).


## iter-270 (Jun 2026): Conference room — LIVE voice mesh wired (web-interop)
Web team confirmed the conference room IS fully built on web with real mesh audio, keyed by **`conferenceId`** (NOT a callId; no `initiateCall`): roster/join/leave/mute via `api.conferenceRoom.*`, signaling via **`api.conferenceSignaling.*`** (separate from `api.signaling.*`), mesh connects to `peerUserIds` (other active participants, breakout-scoped). Built native conference audio reusing the transport-agnostic `MeshController`/`MeshPeer` (same perfect-negotiation politeness as group calls) via new hook `src/lib/call/mesh/useConferenceMesh.ts`. Wired into `app/conference/[conferenceId]/room.tsx`: computes `peerUserIds` from active roster, runs the mesh, mute button now cuts the real mic instantly (local `localMicOn` mirror synced from `myMuted`, incl. admin force-mute via 3s `getRoomState` refetch). Voice only (video grid is follow-up). Lint clean; web bundle builds; app boots.
**⚠️ ASSUMED `api.conferenceSignaling.*` arg shapes (parallel to `api.signaling.*`) — web team to CONFIRM:** `send({ conferenceId, toUserId, type:'offer'|'answer'|'ice-candidate', payload:string })`; `poll({ conferenceId })` → `[{ _id, fromUserId, toUserId, type, payload }]`; `markConsumed({ messageIds })`. If real names differ, conference audio won't connect until aligned. NATIVE BUILD required to validate.


## iter-269 (Jun 2026): Incoming group-call ring → group room + Groups-tab call-leak guard
- **Incoming group-call routing:** Foreground `src/push/useIncomingCallListener.ts` now routes calls where `incomingCall.isConference===true` (or `callType==='conference'`) to `/group-call/<conversationId>?callId=<call._id>` instead of the 1:1 `/call`. Push-tap handler in `src/push/usePushNotifications.ts` (`type==='call'`) routes `payload.isConference|callType==='conference'` to `/group-call/<conv>?callId=`. FastAPI relay `server.py` now forwards `isConference` in the call push data block so the flag reaches the device. ⚠️ **Web dependency:** Convex `initiateCall` must include `isConference:true` in the push it posts to `/api/send-push-internal` for the killed/background ring to route correctly (foreground works without it).
- **Groups tab call-leak (user bug):** 1:1 calls with "add participant" create real `type:"group"` conversations via `createGroup` (web-confirmed: NO marker field on conversations). Mobile already stopped creating these (add-participant is an alert; `/group-call` uses `initiateCall` which makes no conversation). Added defensive `isRealGroup()` filter in `app/(tabs)/groups.tsx` (drops `isConference`/`groupType:'call'`/`isCallGroup`/`isAdHoc`/call-meta-without-group). Existing junk groups are indistinguishable client-side → handed full fix spec to web team: `/app/docs/WEB_TEAM_SPEC_stop_call_group_creation_and_cleanup.md` (stop createGroup on escalation OR add `originType:'call'` + exclude from listGroups + one-time backfill).


## iter-268 (Jun 2026): Group voice calling — native WebRTC mesh (Phase 2, voice only)
Web team shipped web mesh → built native mesh to interop. New `src/lib/call/mesh/MeshPeer.ts` (perfect-negotiation peer) + `MeshController.ts` (owns mic, one peer per roster participant, routes signals by `fromUserId`, exposes remote streams) + screen `app/group-call/[conversationId].tsx` (roster grid, mute, leave; voice only). Entry = "Group voice call" ActionRow on `app/group/[id].tsx` → `/group-call/<conversationId>`. Uses confirmed contracts: `api.calls.initiateCall({conversationId,callType:'voice'})` to start/ring, `?callId=` to join; `api.conference.{joinConference,leaveConference,getParticipants,toggleSelfMute}({callId})`; `api.signaling.{send,poll,markConsumed}` (poll filtered to `toUserId===me`, routed by `fromUserId`); dynamic TURN via Phase-1 `getPeerConnectionConfig()`. **Glare rule (must match web):** `polite = String(myUserId) > String(peerUserId)`; rollback-free subset — IMPOLITE peer is sole offerer, POLITE only answers, impolite ignores colliding offers (interops with web's full perfect negotiation). Lint clean; web bundle builds; route registered. **TODO follow-ups:** incoming group-call ring still routes to 1:1 `/call` (callee joins via group screen for now); speaking/hand-raise/admin-mute UI; group video. **NATIVE BUILD REQUIRED to validate** (no WebRTC on web/Expo Go). Full plan: `/app/docs/GROUP_CALLING_PHASE_PLAN.md`.


## iter-267 (Jun 2026): Group calling decision (NO LiveKit) + dynamic TURN (Phase 1)
- **Decision:** Group voice calling will NOT use LiveKit/SFU. Web team confirmed the entire stack is WebRTC peer connections + Convex signaling (`api.signaling.*` scoped by shared `callId`, addressed via `toUserId`/`fromUserId`); group roster = `api.conference.*` (singular, keyed by callId); start/ring = `api.calls.initiateCall({conversationId, callType})`. `api.conferenceRoom.*` does NOT exist (the scheduled-conference `room.tsx` is a separate `api.conferences.*` plural events feature). Full contracts + Phase 2 mesh plan in `/app/docs/GROUP_CALLING_PHASE_PLAN.md`.
- **Phase 1 DONE — dynamic TURN (web parity, helps existing 1:1 calls too):** `src/lib/webrtc/iceServers.ts` adds `fetchTurnServers()` + `getPeerConnectionConfig()` — fetches ephemeral Twilio relay creds from `GET {CONVEX_SITE_URL}/turn-credentials` (derived from `EXPO_PUBLIC_CONVEX_URL` `.cloud`→`.site`), 8s timeout, ~50min cache, falls back to the static metered.ca list on any error. `CallSession.createPeerConnection()` now awaits it (static fallback on error). Endpoint verified live via curl (returns Twilio STUN+TURN). Lint clean; web bundle builds. Native-validate on build.
- **CRITICAL caveat:** media is still 1:1 on BOTH web and mobile today — true mesh fan-out (every peer↔peer) is Phase 2, to ship alongside the web team's mesh (user confirmed web mesh is coming soon). Existing `CallSession` is already single-remote-peer with `callId`+`toUserId` in its signal shape → mesh = one CallSession per participant via a `MeshCallController` (see doc).


## iter-266 (Jun 2026): Presence polish — chat header + user profile
- **Chat header** (`chat/[conversationId].tsx`): added a green online dot to the header avatar (wrapped it so the dot isn't clipped by the avatar's `overflow:hidden`). `headerOnline` is DM-only (no group/broadcast), derived from `mergedPresenceSource` (`isOnline`/`online` flag or `lastSeen` within 2 min). Presence subtitle text was already present.
- **User profile** (`user/[userId].tsx`): added an online dot on the avatar ring + the last-seen line now shows "Online" (green) when the user is online (`profileOnline`); falls back to the existing `formatLastSeenLabel`.
Both read the same Convex `users` presence as the web app. Lint clean, web bundle builds (2514 modules). Native-validate on build. (Continues iter-265 which added presence to Admin list, chat list, contacts.)


## iter-265 (Jun 2026): Online dot + last-seen parity (Admin, chat list, contacts)
**Goal:** match the web app, which shows presence everywhere the native app didn't.
- **Avatar** (`src/components/Avatar.tsx`): added reusable `online?: boolean` prop → renders a green presence dot at bottom-right (outside the clipped circle, scales with size). Used everywhere.
- **Admin Users** (`admin.tsx`): each row now shows the online dot on the avatar + a "Last seen …"/"Online now" line (`formatAdminLastSeen` from contract `isOnline`/`lastSeen`; getAllUsers already forces offline after 2 min).
- **Chat list** (`(tabs)/chats.tsx`): `ConversationRow` Avatar gets `online={peerIsOnline(item)}` — DM-only (no dot on groups), online if `isOnline`/`online` flag OR `lastSeen` within 2 min.
- **Contacts** (`(tabs)/contacts.tsx`): already had the dot via `ContactAvatar`; added subtitle = "Online" / "Last seen …" (`formatContactLastSeen`) falling back to the about line.
All read the same Convex `users` presence the web app uses. Lint clean, web bundle builds. Native-validate on build.


## iter-264 (Jun 2026): Screen-share = request/accept (no call) + #1 killed-ring conclusion
**#3 Screen-share FIXED (sharer entry):** Web team confirmed the full `api.screenSharing.*` contract exists (request/accept/decline/signaling) and the native viewer side ALREADY worked (`IncomingScreenShareModal` polls `listIncoming`; call screen has full screen-only mode wired to `screenSharing.sendSignal/pollSignals/markSignalsConsumed`). Only the SHARER entry was wrong — `app/screen-share.tsx handleStart` used Twilio `startCall(autoShare)` (rang like a call). Rewrote it to: `getOrCreateDirect({otherUserId})` → `screenSharing.requestScreenShare({conversationId})` → `router.replace('/call/<sessionId>?type=screen&screenOnly=1&audio=<0|1>&role=sharer&convId=<conv>&peerUserId=<viewer>')`. No call doc, no ringtone; recipient gets the accept/decline request (modal + the new web-side push) and on accept opens the same screen-only view as `role=receiver`. Web team also added `internal.emergentPush.notifyScreenShareRequest` (banner channel `messages-v4-message_notification`, action `/screen-share?conversationId=`) so requests reach backgrounded/killed apps. Removed the now-unused Twilio `startCall` import.
**#1 Killed-app ring — native side verified CORRECT, remaining fix is web/native-build:** Web team confirmed Convex calls THIS backend's `/api/send-push-internal` with `channel_id: calls-v4-smilers_never_cry`, `data.type:'call'`, recipients = Convex `users._id`. Native app DOES register `convex_user_id` (iter-203) and the relay matches on it; `defineTask` is at module scope. So the canonical data-only ring push reaches the device. The killed-app MESSAGE TONE comes from (a) competing pipelines the web team fires in parallel — Hercules web push, Expo legacy (`mobilePushAction.sendExpoPushToUser`), and the missed-call push (`messages-v4-message_notification`) — landing a notification-block on a non-calls channel, and/or (b) Android not waking JS for data-only FCM on force-stopped apps. NATIVE can't override an OS-rendered notification or run JS while force-stopped. RESOLUTION PATH: web team should ensure ONLY the calls-v4 data-only push fires for ringing (and that the Expo-legacy/missed pushes specify the calls channel or are suppressed), AND/OR implement native CallKeep/foreground-service (P2, native freelancer) for guaranteed wake-on-lock.


## iter-263 (Jun 2026): Pop-out clickability, admin per-user message, + screen-share/killed-ring scoping
**#2 Pop-out not clickable (FIXED):** iter-261 added a 4th "Minimize" button to `controlsSecondaryRow`, overflowing the fixed single-line row so "Pop out" was pushed off the right edge (untappable). Made the row `flexWrap:'wrap'` with `columnGap/rowGap` so all controls stay on-screen and tappable.
**#4 Admin per-user message (DONE):** Added "Message as “Smilers”" to the per-user RowMenu (next to Make/Remove admin + Suspend) in `admin.tsx`; it routes to `/broadcast-create?preselect=<userId>` (new `preselect` param pre-selects that single recipient in the broadcast composer). Quick way to message one user as Smilers.
**#1 Killed-app ring still just vibrates (OPEN, needs Convex/prod logs):** User confirms prior build still plays a short buzz/message-tone when killed → the call push is still arriving as a message-channel notification (JS not running). iter-262 relay hardening + `[PUSH][classify]`/`[PUSH][channels]`/`data_only` logs are now in to diagnose, BUT only help if the incoming-call push flows through THIS backend's `/api/send-push-internal`. User suspects prod should be wired to the web app's Convex backend. NEED: the Convex function/payload the WEB app uses to push incoming calls to mobile (to confirm call signals / path).
**#3 Screen-share starts a call (OPEN, needs Convex contract):** `/app/frontend/app/screen-share.tsx` `handleStart` currently calls the Twilio `startCall(... autoShare:true)`, which RINGS the recipient like a call. User wants: tapping chat-menu "Share screen" sends an ACCEPT/DECLINE request (no call); on accept it renders screen-only. Only the IN-CALL screen-share button should run during a call. This needs the Convex screen-share request/accept contract (functions + payload + receiver notify + accept→render signaling). Referenced doc: /app/CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE.md.


## iter-262 (Jun 2026): Killed-app call-tone root cause + relay hardening + return-to-call banner
**Diagnosis (user-confirmed):** killed app plays the MESSAGE tone for incoming calls. A message tone on a killed app means JS never ran → the OS rendered a notification-block push on `messages-v4-message_notification`, i.e. the relay MISCLASSIFIED the call as a message. So the iter-260 Notifee v3 vibration fix only helps when Notifee actually renders (foreground / backgrounded-alive), NOT the killed case.
**Fix 1 — relay classifier hardening** (`backend/server.py` `_resolve_android_channel`): now also treats the PRESENCE of call-metadata fields (`callId`/`callType`/`callerId`/`twilio_room_name`/`twilio_room_sid`/`twilio_caller_identity`) as a definitive call signal → such pushes go data-only → wake background task → render the Notifee full-screen ring instead of a message banner. Dependency: only works if (a) prod routes calls through this backend's `/api/send-push-internal` (Convex does today) AND (b) Convex's call push carries at least one call signal (type:'call' | action_url:/call/ | a call-metadata field). If Convex sends ZERO call signals, the fix must be on Convex.
**Fix 2 — relay classification log** (`send_push`): one-line `[PUSH][classify] -> CALL|MESSAGE channel=… recipients=… type=… action_url=… has_callId=… title=…` so production push routing is debuggable from deployed backend logs.
**Feature — return-to-call banner** (`src/components/call/CallReturnBanner.tsx`, mounted in `_layout.tsx` after CallHost): WhatsApp-style slim green bar pinned to the top of every screen while a call is MINIMIZED; tap → `callHost.maximize()`. Companion to the draggable floating window. Web returns null.
**Still pending native validation on Emergent Android build.** Hard limit unchanged: force-killed apps on aggressive OEMs may not wake JS even with a correct data-only push → needs native CallKeep/foreground service (deferred P2).


## iter-261 (Jun 2026): In-app "Minimize" floating call window (global CallHost refactor)
**Goal:** let users minimize a live WebRTC call into a small draggable window and keep browsing Smilers without dropping the call.
**Architecture (P1):** The call no longer lives inside the `/call/[conversationId]` route. New external store `src/lib/call/callHost.ts` (`start/end/minimize/maximize`, `useCallHost` via useSyncExternalStore) drives a root-mounted `src/components/call/CallHost.tsx` that renders `CallScreenInner` ONCE.
- `CallScreenInner` is now `export`ed from the route file and reads its params from `useCallHost()` (not `useLocalSearchParams`). The route default export is now a thin SHIM that forwards route params → `callHost.start()` → pops itself (so every entry point — push wake, startCall, deep links — keeps pushing `/call/<id>` unchanged).
- CallHost keeps the SAME `<CallScreenInner/>` element mounted across full↔mini (only swaps wrapper STYLE + PanResponder handlers) — critical so React never unmounts it and tears down the peer connection. `pointerEvents="box-none"` in mini lets the app behind stay interactive.
- Added a "Minimize" control (both video & voice control rows) → `callHost.minimize()`; mini window shows remote video/avatar + duration + expand/end, tap-to-expand, draggable.
- All call-ending paths now call `callHost.end()` (was `router.back()`); conference escalation uses `callHost.start(newParams)` in place of `router.replace`.
- Mounted `<CallHost/>` at app root in `_layout.tsx`. Web returns null (no react-native-webrtc on web).
**Gotcha logged:** Metro runs in CI mode (no file-watch) — NEW files (callHost.ts, CallHost.tsx) are only picked up after `supervisorctl restart expo`. Bundle confirmed clean after restart; app boots to Sign In.
**MUST validate on native Emergent Android build** (WebRTC/PiP can't run in web/Expo Go): verify minimize keeps the call connected, drag works, expand restores, end works, and conference/screen-share modes still function via the new shim.


## iter-260 (Jun 2026): Admin features (broadcast/user insights/leaderboard) + P0 killed-app call vibration
**Admin contract wired (verified against backend by user):**
- **Admin User List** (`app/admin.tsx` UsersTab): each row now shows a Level pill + `<N> pts · <N> refs` from `api.admin.queries.getAllUsers` ({} args; added `level`/`totalEngagements`/`referralCount` to UserItem). Added a "Send broadcast as Smilers" CTA at top of the Users tab.
- **Admin Broadcasts** (`app/broadcast-create.tsx`, fully rewritten): admin-gated screen fetching `api.admin.queries.getAllUsers`, per-row checkboxes + select-all, a 1–5000 char message composer, then ONE `api.admin.messaging.messageUsers({ userIds, text })` call; surfaces returned `{ sent }`. FAB broadcast button (`FabStack`/chats) now only renders for `me.role === 'admin'`.
- **Broadcast read-only enforcement** (`app/chat/[conversationId].tsx`): when `conversation.isBroadcast === true` → title forced to "Smilers", subtitle "Announcement · read-only", call/video header buttons hidden, composer replaced with a read-only banner, and reactions/long-press/swipe-to-reply disabled (new `isBroadcastReadOnly` flag mirroring the existing `viewerSuspension` spectator path).
- **Leaderboard** (`app/earnings.tsx` Top tab): `getLeaderboard` now called with `{}` (was `{ limit: 20 }` → would fail strict arg validation). TopEarnersList reads contract fields verbatim (`userId`/`name`/`avatar`/`level`/`totalEngagements`); server anonymizes to "User #N" for non-admins — no client-side de-anonymization.
**P0 — killed/backgrounded incoming-call vibration too short (recurring):** Notifee call wake channel (`src/push/notifeeCallWake.ts`) played a ~2.4s vibration pattern ONCE (`loopSound` loops audio, not vibration) → felt like a message buzz. Fixed by baking a LONG repeating buzz pattern (≈ RING_TIMEOUT_MS, 700ms on / 600ms off) into the channel; channels are immutable on Android O+ so bumped id `incoming-call-wake-v2-*` → `v3`. NOTE: this FastAPI backend already sends call pushes data-only (correct); IF production points at the separate Hercules/Convex backend and that sends a notification-block on a message channel, killed-app vibration must also be fixed there. **All native-only (Notifee/push/WebRTC) — requires user's Emergent Android build to validate.**


## iter-221 (Feb 2026): Profile screen — match web app (phone section + card styling)
User compared native vs web Profile (screenshots). Changes in `app/(tabs)/profile.tsx`:
- **Added PHONE NUMBER section** above YOUR NAME (web parity): phone icon + "PHONE NUMBER" label, the number (`me.phoneE164 ?? me.phone`) + green **Verified** pill (`me.phoneVerified`, shield-check) + edit pencil (→ `/phone-verify`), and helper text "Your phone number is how friends find and recognize you on Smilers." Shown only when a phone exists.
- **Restyled cards to the web's soft look** (native previously used deep solid yellow): Premium = pale gold fill `#FBF1CD` + gold border `#EAD68C` + gold crown/text (`primaryDark`), chevron removed; Starred Messages + Settings & Privacy = near-white `#FAF7EC` fill + hairline border `#ECE7D8` + gold icon + dark semibold text.
- Verified: eslint 0 errors (only a pre-existing unused-`useEffect` warning), bundles clean. Visual check is OIDC-gated → **device/authed retest**. Note: phone fields are `phoneE164`/`phone` + `phoneVerified` on `getCurrentUser`; if they're named differently on the live Convex backend the number/Verified pill won't show until matched.


## iter-220 (Feb 2026): In-conversation search — highlight + ▲/▼ navigation (web parity)
User wants: search a word → results in Chats & Messages → tap → enter conversation with ALL matches highlighted + up/down buttons that jump match-to-match (skip non-matches, wrap-around, scroll-to-centre). Screenshots showed the web design ("Results for 'Thanks' · 1 of 9" bar + yellow highlight; Search screen Chats/Messages tabs).
**Part 1 — in-conversation highlight + nav (CORE, self-contained, done):**
- `app/chat/[conversationId].tsx`: reads `?q=<term>&mid=<messageId>` params; STOPPED the old iter-109 filter behaviour (full list stays visible). Computes `searchMatchPositions` = timeline indices of non-deleted text messages containing the term (case-insensitive), oldest→newest. New highlight+nav bar (search icon, editable term input, "<n> of <total>", ▲ ▼ ✕) replacing the old filter bar. ▲/▼ wrap-around; active match scrolled to centre via `scrollToIndex(viewPosition:0.5)` + `onScrollToIndexFailed` fallback; `onContentSizeChange` auto-scroll-to-end guarded off during search. Initial focus = `mid` match (else most recent), once per term.
- `src/components/MediaBubble.tsx`: new props `searchTerm` + `isActiveSearchMatch`; `RichMessageText` + `splitByTerm` highlight every occurrence (yellow `#FDE68A`, active brighter `#FACC15`); active bubble gets an amber outline.
**Part 2 — global Search "Messages" tab (done, pending field confirmation):**
- `app/search.tsx`: added `Messages` tab (now Chats/Messages/People) using `api.search.searchMessages` ({ query }); new `MessageResultRow` with highlighted snippet; tapping a message → `/chat/<cid>?q=<term>&mid=<mid>`; conversation taps now carry `?q=<term>`. Defensive field reads (conversationId/_id/messageId, text/snippet, conversationName/...).
**Verification:** tsc (whole project) + eslint clean on all 3 files (only PRE-EXISTING errors remain: MediaBubble VideoPlayer.seekTo, chat L624 'code', and a pre-existing conditional-useMemo hook warning in MediaBubble — NOT mine). Web+iOS bundles built; Search screen renders 3 tabs. Full E2E (highlight/jump, message search results) is OIDC+data gated → device/authed retest.
**OPEN for user/web team** (see `/app/IN_CONVERSATION_SEARCH_NATIVE_WIRING_iter220.md`): confirm `api.search.searchMessages` arg is `query` and result fields (`conversationId`, `_id`, `text`, `conversationName`); and whether to drop the 3rd "People" tab for strict 2-tab web parity.


## iter-218c (Feb 2026): On-device "Call Diagnostics" screen (enhancement)
New `app/call-diagnostics.tsx` (route `/call-diagnostics`, linked from Settings under "Diagnostic Logs"). Reads the local AsyncStorage diagnostic ring buffer via new exports `getStoredDiagnostics()` / `clearStoredDiagnostics()` in `src/lib/diagnostics.ts`. Shows recent call/push events newest-first with tag pills, source, timestamp; filter chips Calls / Push / All; Refresh, Copy-to-clipboard (expo-clipboard), and Clear. Lets the user/support pinpoint ring / answer-decline / auto-drop (`[TWILIO-CALL]`, `[WAKE]`) issues during the next device test without server-log digging. Verified on web: lint+tsc clean, list renders (6 boot/health events), filter switching + copy work. NOTE: Metro runs in CI mode (reloads disabled) — adding a NEW route file requires `sudo supervisorctl restart expo` for expo-router to register it.


## iter-218 (Feb 2026): Device-test fixes — Twilio auto-drop, missed-call lingering, killed-app ringtone
User device-tested iter-217 and reported 3 issues. Fixes:
- **Issue 3 (Twilio call doesn't auto-drop on the other side)** — ROOT CAUSE: Twilio does not disconnect the remaining participant when one leaves, and there was no caller-side ring timeout, so the local room stayed `connected` (alone) and the screen never closed. FIX in `app/twilio-call.tsx`: (a) remote-left auto-end — once a remote participant joined and then all leave, tear down our side (leave + `/api/twilio/end-call` + close); (b) caller no-answer ring-timeout (~35s) → auto-end instead of stranding the caller on "Waiting for others to join…". Client-side, lint-clean.
- **Issue 2 (incoming-call notification lingers beside the missed-call notification)** — ROOT CAUSE: the wake notification was `ongoing: true`, and Android's `timeoutAfter` does not remove an ongoing notification, so it persisted next to the scheduled missed-call. FIX in `src/push/notifeeCallWake.ts`: set `ongoing: false` (still rings full-screen via fullScreenAction + loopSound + MAX heads-up, but the OS auto-dismisses it at timeout; Answer/Decline handlers still cancel explicitly).
- **Issue 1 (killed app plays message tone instead of custom ringtone)** — ROOT CAUSE: a force-killed app can't run JS, so the data-only call push never rendered the Notifee ring; Android played the default/message tone. User chose option 1a (custom ringtones for calls AND messages when killed). FIX: backend `server.py` send_push now sends calls with a NOTIFICATION block on the device's custom calls channel (`android_data_only=False`; channel already resolves to `call_channel_id`) so a killed phone rings with the chosen ringtone via the OS; `usePushNotifications.ts` background task now SKIPS its own Notifee ring when the OS already displayed a notification (prevents double-ring). 11/11 push pytest pass.
  - **IMPORTANT**: User confirmed the PRODUCTION app points at a SEPARATE backend (the Hercules/Convex web app), not this Emergent FastAPI backend (device logs show `register-push HTTP 404` here + legacy Convex `notifyPush` call path). So the authoritative Issue-1 fix must be made in the Hercules/Convex push sender. Wrote `/app/HERCULES_BACKEND_PUSH_CONTRACT_iter218.md` — exact FCM v1 payload contract (per-type `channel_id` = stored `call_channel_id`/`message_channel_id`, notification+data blocks, dedupe) for the user to hand to the Hercules team. Convex `registerMobileDevice` likely must also persist `call_channel_id`/`message_channel_id`.
- **Status:** all code lint/tsc/pytest clean; killed-app push + Twilio call flows are DEVICE-ONLY testable → pending user's next build + device retest. Issue 1 also requires the Hercules backend change to land.


## Latest feature (Feb 2026 — iter-214): Live-location request receiver confirmation flow
**User request:** "When someone requests a live position and it arrives in my chat, when I click on it, it should open a confirmation to send it which when confirmed, my live location should be sent." Match the web app's confirmation flow. Scope chosen by user: **receiver/confirmation flow ONLY** (no continuous 10s live-tracking yet); show incoming request as a tappable banner in **both** the Chats tab (global) and inside the chat screen (scoped to that conversation).
**Implementation:** New `src/components/LiveLocationRequestBanner.tsx`. Subscribes to web-canonical Convex query `api.locationRequests.getIncomingRequests` (via `anyApi`, degrades gracefully through `useSafeConvexQuery`). Renders amber banner ("Live location requested — tap to share") with a quick X to decline (`respondToRequest({ requestId, accept:false })`). Tapping opens a confirmation modal ("Share your live location?") with a 15/30/60-min selector; "Send my live location" captures `Location.getCurrentPositionAsync()` and calls `api.locationRequests.respondToRequest({ requestId, accept:true, latitude, longitude, durationMinutes })`. Mounted in `app/(tabs)/chats.tsx` (global, below LoginApprovalBanner) and `app/chat/[conversationId].tsx` (scoped, top of KeyboardAvoidingView).
**Status:** lint + tsc clean (only pre-existing unrelated TS errors), web smoke test PASS (Sign-In renders, no bundle crash). Full flow requires OIDC login + a real incoming request from web → **user to verify on device**. Sender-side request creation intentionally out of scope per user.

### iter-214b: "Sharing live location · X min left" status pill + one-tap Stop
**User approved** the suggested enhancement. New `src/components/LiveLocationSharingPill.tsx` subscribes to web-canonical `api.locationRequests.getActiveShares`, shows a green pill ("Sharing live location · 28 min left", ticks every 30s, computes remaining from `expiresAt` or `startedAt`+`durationMinutes`) with a "Stop" button that calls `api.locationRequests.stopSharing`. Mounted scoped-to-conversation in `app/chat/[conversationId].tsx` directly under the request banner. NOTE: exact `stopSharing` arg key wasn't in the contract, so Stop tries likely shapes in order (`{shareId}`→`{requestId}`→`{id}`→`{conversationId}`); Convex validates args before running the handler so wrong shapes are harmless no-ops. Confirm the canonical signature on device and simplify. lint + tsc clean; web smoke PASS.


## Latest fix (Feb 2026 — iter-177): OS Share Sheet "Nothing shared yet" ROOT CAUSE
**Recurring bug finally root-caused.** The app called `useShareIntent()` in TWO places (global `ShareIntentRouter` in `_layout.tsx` + `share-receiver.tsx`). Each hook instance has private state and the native payload is one-shot: the router consumed it, navigated, and the screen's late-mounted instance was always empty.
**Fix:** Single `ShareIntentProvider` mounted at app root (`src/lib/shareIntentContext.tsx` — platform-safe wrapper `AppShareIntentProvider` / `useAppShareIntent`). Both router and screen now read the SAME shared state. Screen also snapshots the first non-empty payload so background/reset can't wipe it mid-flow. Pure JS fix — ships in any new Emergent Android build (no native change needed). Earlier Kotlin/JS library patches (`scripts/patch-expo-share-intent.js`) remain in place and are still required.
**Status:** lint + tsc + web smoke test PASS. Android device verification by user CONFIRMED WORKING (share sheet → recipient picker now appears).

### Follow-up (same day): device-contact names in share picker
Share screen recipient list was showing Smilers/Google account names instead of device-saved contact names. Fixed by wiring `useDeviceContactIndex` + `getResolvedDisplayName` / `getResolvedConversationDisplayName` (same iter-176 override used in Chats/Contacts) into the share-receiver recipient builder (DM rows + contact rows; groups untouched). Verification on device pending — requires new Android build.

### iter-178: "Frequently shared" pins in share picker
New `src/lib/recentShareTargets.ts` (AsyncStorage, per-user, stable ids `u:<userId>` / `c:<convId>`, capped 8). After each successful share, targets are recorded; on next share up to 3 most-used recipients are pinned below My Diary with a "Frequently shared" subtitle. Local-only, best-effort, never blocks send.

### iter-179: APK sharing allowed + clear "blocked" reporting
The "Sent to 0 chats / 1 send(s) failed" report was the iter-164 security scanner silently blocking an .apk share — not a real failure. Fixes: (1) `SendOutcome.blocked` flag replaces fragile regex tally; share-complete alert now states the block reason explicitly. (2) Per user decision (option b, WhatsApp-style), `.apk` removed from DANGEROUS_EXTENSIONS in BOTH `messageSecurityScanner.ts` (send boundary) and `securityScanner.ts` (incoming render/auto-delete). `.exe/.bat/.ipa/etc.` remain blocked. Verified via tsx unit run: apk allowed, exe/bat/ipa blocked, jpg safe — ALL PASS.
(3) Caution banner: received .apk file messages show an amber "App install file — only install if you trust the sender" strip under the file bubble (`FileMessage` in `src/components/MediaBubble.tsx`, testID `apk-caution-<msgId>`). Sender's own bubble stays clean.

### iter-180: Call-log pills missing in chat — fetch layer fix
Call pills (CallPill, `__kind:'call'` merge, `api.calls.listCallLogsForConversation`) all existed since iter-156, but the data was fetched with one-shot `useSafeConvexQuery` which (a) raced the Convex auth handshake on cold launch → unauthenticated result `[]` cached for the whole visit, and (b) never refreshed after a call ended while chat was open. Fix: new `useSafeConvexSubscription` (reactive `watchQuery`+`onUpdate`, error-safe fallback) in `src/hooks/useSafeConvexQuery.ts`; chat screen now subscribes live. Also fixed `Number(ISO startedAt)`→NaN timestamp parsing (toMillis handles numeric + ISO). NOTE for next agent: if pills STILL don't appear on device after this, the Convex backend (web codebase, not ours) is likely not writing call-log rows for mobile-initiated calls — would need a CONVEX_BACKEND_INSTRUCTIONS doc for the web team.

### iter-181: Settings green Earnings + Scheduled repeat fix + Trustees picker fix
1. **Earnings row** in Settings now renders green (#16A34A icon/title, #DCFCE7 chip) via new `success` flag — mirrors the red `danger` styling on Emergency/Blocked.
2. **Scheduled messages**: (a) local-draft sync was hardcoding `repeat:'once'` — now maps recurring frequency properly; (b) chat composer recipient label now uses device-contact-resolved names (fixes "Unknown" recipients); (c) the DAILY-CLONE-AS-ONCE row duplication is a BACKEND defect — wrote `/app/CONVEX_BACKEND_INSTRUCTIONS_SCHEDULED_REPEAT.md` for the web team (fire → update same row date in place, keep repeat, no clones, cleanup migration).
3. **Trustees picker** "No Smilers contacts available": picker now merges DM conversation peers (guaranteed registered users) with contacts rows, accepts row `_id` as user reference (same as Contacts tab's getContactUserId), still excludes pending invites, and shows device-saved names.

### iter-182: Six-issue batch (call ringing regression, tones, tabs, save photo, languages, chat perf)
1. **Call ringing root cause (backend `server.py`)**: incoming-call FCM pushes landed on the default "messages-v3" channel (one short beep + short vibration — exact user symptom) because Convex doesn't reliably send `channel_id`. Added `_resolve_android_channel()`: per-token channel override → explicit channel_id → type-derived ('calls' for call payloads, detected via type/action_url(/call)/title regex). 9 pytest tests in `/app/backend/tests/test_push_channels.py` (all pass; full suite 28 pass).
2. **Tone customization (issue 6)**: Android channels are IMMUTABLE → introduced tone-versioned channel ids (`calls-v4-<sound>` MAX importance + bypassDnd, `messages-v4-<sound>` HIGH) in new `src/push/notificationChannels.ts`. App registers its current channel ids with `/api/register-push` (new optional fields `call_channel_id`/`message_channel_id`, stored per token); `ringtones.tsx` persist() now applies versioned channels + immediate `reregisterPushDevice()` (exported from useEmergentPush). Old fixed ids still created for back-compat. Verified registration+storage via curl/mongosh.
3. **Tabs covered by OS nav bar**: tab bar uses safe-area bottom inset ((tabs)/_layout.tsx).
4. **Save photo error**: `messageMedia.ts` now guarantees a media extension (mime→url→type default .jpg/.mp4/.m4a); extension-less/.bin files caused "Primary directory DCIM not allowed".
5. **Language save spinner forever**: 10s timeout race around Convex mutations in languages.tsx (both onSave and saveLanguage) — hung queued mutations no longer freeze the UI; local save + clear alert instead.
6. **Chat slow initial load / call buttons (issue 2)**: investigated — buttons are wired directly; sluggishness = JS-thread saturation from the 4600-line screen's initial render. FlatList initialNumToRender tuning was tried and REVERTED (blank-bottom regression risk with scrollToEnd). Proper fix = chat screen refactor (backlog).
HONEST LIMIT: full screen-wake on locked phones still requires the CallKeep/full-screen-intent native layer which is BLOCKED by the build pipeline (expo config crash). The MAX-importance call channel gives heads-up + screen light-up on most devices.

### iter-183: Trustees infinite spinner — ROOT CAUSE + global fix
Backend verified FINE via direct Convex probes: `trustees:getMyTrustees` ✓, `trustees:addTrustee` ✓, `trustees:removeTrustee` ✓, `contacts:getContacts` ✓, `conversations:listConversations` ✓ all exist on deployment (no Convex/web changes needed — communicated to user).
Root cause was mobile-side: `useSafeConvexQuery` awaited a ONE-SHOT `convex.query()` that the client can queue FOREVER when racing the auth handshake → `loading:true` for eternity (same failure class as the languages-save hang and call-pills emptiness). REWROTE the hook internals to a `watchQuery` SUBSCRIPTION (same public API `{data, loading, refetch}`): auto-recovers when auth completes, live-updates on server writes, 12s safety timer guarantees no infinite spinner, still degrades to fallback on errors. Benefits ALL consumer screens (trustees, contacts pickers, admin tabs, recordings, share picker...). Preserved iter-138 (no flicker on enabled toggles) and iter-141 (spinner only on first load) behaviors.

### iter-184: Chat screen refactor — Phase 1 (structure, zero behavior change)
`app/chat/[conversationId].tsx` reduced 4,626 → 3,853 lines by extracting verbatim into focused modules:
- `src/lib/chatFormat.ts` — formatChatDayChip, isSameCalendarDay, isGifAsset, formatCallDuration
- `src/components/chat/MessageBubble.tsx` — ActionRow (used by action sheet) + MessageBubble (NOTE: MessageBubble was ALREADY dead code in the timeline — MediaBubble renders everything; kept exported for future use)
- `src/components/chat/CallPill.tsx`, `src/components/chat/RecordingPlayback.tsx`, `src/components/chat/ChatOptionsMenu.tsx`
31 bubble/action style keys moved out of the main StyleSheet (verified exclusive via usage scan; only flexOne shared → copied). All code moved VERBATIM; tsc/eslint clean; boot smoke pass.
**Phase 2 candidates (next):** extract the three in-JSX modals (action sheet ~line 2700, disappearing sheet, template picker), then split composer + header into components, then hook-extraction for the ~90 hooks at top of ChatScreen.

### iter-185: Reply-to-message send failure FIXED
Replying on mobile always failed (message stayed unsent; web worked). Root cause: mobile sent BOTH `replyToId` AND `replyToMessageId` on every reply payload (iter-101 dual-compat) — the deployed `messages.send` strict validator rejects the unknown extra field → mutation throws → composer restored silently. Web sends only `replyToId` → works. Fix: ALL 8 send sites in chat screen now send ONLY `replyToId` (text, edit-fallback, image, file, GIF, voice, video, poll/location paths). Renderer still reads both names on rows. Also: send failure now restores the reply banner AND shows a "Message not sent" alert instead of failing silently. Contract doc section 5 updated.

### iter-186: Play Store invite links + languages save + scheduled sync doc
1. **Invite links → Play Store**: new `src/lib/inviteLink.ts` (PLAY_STORE_URL = play.google.com/store/apps/details?id=com.smilers.app). All invites (Contacts tab invite + Earnings "Share code") now link to the Play listing with the referral code in BOTH the Play `referrer` param (Install Referrer-ready) and the message text ("Use my referral code X") so earnings referrals keep counting.
2. **Languages save error**: probed deployment — ONLY `users.updateProfile` exists (updateLanguages/setLanguages/languages.update are FunctionPathNotFound). Reordered candidates so updateProfile variants go FIRST and raised the save timeout 10s→20s for slow/roaming networks.
3. **Scheduled messages Once/duplicates/not-on-web**: confirmed mobile uses deployed canonical fns (scheduling.scheduleMessageMobile, scheduledMessages.listMine/update/remove/setActive) — the duplication-as-once AND the web-sync gap are CONVEX BACKEND defects. Extended `/app/CONVEX_BACKEND_INSTRUCTIONS_SCHEDULED_REPEAT.md` with the one-canonical-store sync requirement. USER MUST APPLY THIS DOC IN THE WEB PROJECT — mobile cannot fix it.

### iter-187: Caller-side ringback silence — ROOT CAUSE + native fix
User insight confirmed: outgoing-call ringback (Smilers theme on the CALLER's phone) only played when permissions weren't granted yet. Mechanism: once permissions are granted, the call screen starts InCallManager (MODE_IN_COMMUNICATION) immediately during outgoing "ringing" — Android mutes the media stream where the expo-audio ringback played. Fix:
1. Bundled `assets/sounds/incallmanager_ringback.mp3` (copy of smilers_never_cry.mp3, the library's `_BUNDLE_` naming, verified in InCallManagerModule.java) + added to app.json sounds → lands in res/raw.
2. `InCallAudio.startRingback()/stopRingback()` wrappers in `src/lib/webrtc/inCallManager.ts` — ringback now plays on the VOICE-CALL stream (immune to communication mode) during outgoing ringing.
3. Callee-side: native session start now SUPPRESSED while incoming-ringing (suppressSessionStartRef) and started on answer — so the in-app ringtone (user's selected tone) stays audible; WebRTC callee setup begins at answer anyway.
4. useRingtonePlayer now incoming-only.
ALSO acknowledged to user: wake-screen + CallKeep still requires EAS CLI build (Emergent pipeline rejects the config plugin) — per earlier diagnosis; backend redeploy still needed for the push channel routing (iter-182).
NOTE: during editing, two search_replace ops mis-applied leaving duplicate trailing lines in call/[conversationId].tsx — repaired by truncation; file verified clean (tsc/eslint pass).

### iter-188: Mobile alignment with the NEW scheduled-messages backend
Web-side agent rewrote the Convex delivery worker (real timers, repeat recurrence, unified store, expectedSendKey stale-timer guard). Mobile alignment applied:
1. `recipient` label now prefers the SERVER-KNOWN Smilers profile name (device-contact name only as fallback) — the new worker resolves recipient→conversation BY NAME and can't match device-saved names.
2. Chat-composer schedule create now self-negotiates `conversationId`: tries `{...args, conversationId}` first (zero-ambiguity targeting), falls back to the confirmed iter-126 contract if the validator rejects the extra field. Works with both old and new deployed validators.
OPTIONAL backend follow-up (relay to web agent): accept optional `conversationId` in `scheduling.scheduleMessageMobile` + `scheduledMessages.create` validators and use it directly when present — mobile already sends it.

## Overview
Native iOS + Android port of **smilers.online** (a Convex-backed real-time messaging app). Connects directly to the existing Convex backend (`https://aware-newt-456.convex.cloud`) using the official Convex React Native SDK. Authenticates via Hercules Auth OIDC (same provider as web app). Web and mobile share the same database in real time.

## Stack
- **Frontend**: React Native + Expo SDK 54, expo-router, TypeScript
- **Backend**: Convex (existing, unmodified) — real-time WebSocket subscriptions
- **Auth**: Hercules Auth OIDC via expo-auth-session + PKCE
- **Storage**: Convex File Storage (binary upload via signed URLs)
- **Push**: Expo Push Notifications (works for both iOS APNs and Android FCM)
- **Permissions**: Camera, Photo Library, Microphone, Location, Contacts, Face ID

## Phase 2 Implementation (Push Notifications + Phone Verification)

### Push Notifications (Mobile-side complete; backend wiring needed via Hercules)
- Permission request, Expo push token registration on login
- Android channels: `calls` (MAX importance, custom Smilers ringtone) + `messages` (HIGH)
- iOS notification category with **Answer** / **Decline** action buttons
- Tap-to-deep-link: message push → `/chat/<id>`, call push → `/call/<id>`
- Decline button calls `api.calls.declineCall` directly without opening the app
- Real-time foreground call listener via Convex reactive query

### Phone Verification Gate (Mobile-side complete; backend wiring needed via Hercules)
- Hard-block on `/phone-verify` if `me.phone` missing OR `me.phoneVerified !== true`
- Country code picker with flag emojis (`react-native-country-codes-picker`)
- E.164 validation via `libphonenumber-js`
- Twilio Verify integration (sendOtp + verifyOtp actions on backend)
- 30-second resend cooldown
- "Use a different number" + "Sign out" escape hatches
- Duplicate phone detection (rejects if already verified by another user)
- Both new and existing users without verified phone are forced through this gate

### Backend specs (give to Hercules agent)
- `/app/CONVEX_BACKEND_INSTRUCTIONS.md` — Push notifications schema/mutations/Expo Push Service POSTing
- `/app/CONVEX_BACKEND_INSTRUCTIONS_PHONE.md` — Phone verification with Twilio Verify, schema additions, defense-in-depth checks

### Hercules dashboard config (user-side)
- Restrict OIDC login methods to Google + Apple ID only (disable Email OTP, LinkedIn, Microsoft, Phone OTP)

## Phase 1 Implementation (Complete)
- ✅ Sign-in screen with Hercules OIDC (PKCE flow, secure token storage on native, localStorage fallback on web)
- ✅ OIDC callback fix v2.0.12: expo-router `+not-found.tsx` now catches `smilers://auth-callback?code=...` deep links, restores PKCE state, exchanges tokens, and routes to chats with on-screen debug logs on failure
- ✅ Settings navigation now fully wired with real Phase 1 utility screens: Emergency, AI Assistant, Blocked Users, Notifications, Earnings & Rewards
- ✅ Added polished placeholder routes for Privacy, App Lock, Face ID, Chat Appearance, Quick Replies, Scheduled Messages, and Chat Once
- ✅ Added safe Convex query fallback layer so optional backend functions degrade to empty states instead of crashing the UI when unavailable
- ✅ Fixed the Contacts tab crash by refactoring `app/frontend/app/(tabs)/contacts.tsx` to use `useSafeConvexQuery` for contacts, pending requests, outgoing requests, and search results; missing Convex endpoints now fall back safely instead of crashing the app tree
- ✅ Audited all current `ComingSoon` screens so the next replacement work can be prioritized cleanly: `privacy`, `app-lock`, `face-id`, `scheduled`, `templates`, `chat-appearance`, `chat-once`, and `auth-webview`
- ✅ Replaced the `Privacy` placeholder with a real mobile settings screen for last seen, profile photo, about, status, groups, calls, read receipts, and typing indicators, persisted locally on device
- ✅ Replaced the `App Lock` placeholder with a real settings screen for PIN setup/change/remove, auto-lock timing, preview hiding, background lock, and biometric enablement on supported native devices
- ✅ Replaced the `Scheduled Messages` placeholder with a real management screen for creating, editing, pausing, resuming, and deleting scheduled message drafts, persisted locally on device
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_PRIVACY_SCHEDULED.md` and wired the Privacy + Scheduled screens to safe Convex endpoint names (`privacy.getSettings`, `privacy.updateSettings`, `scheduledMessages.listMine`, `create`, `update`, `remove`, `setActive`) with local fallback when those endpoints are unavailable
- ✅ Replaced the `Quick Replies` placeholder with a real templates screen for searching, creating, editing, favoriting, copying, and deleting saved reply snippets, plus starter suggestions
- ✅ Replaced the `Chat Appearance` placeholder with a real appearance screen for wallpaper, outgoing/incoming bubble colours, bubble style, and message size, with live preview and local persistence
- ✅ Wired chat personalization into the live chat UI: saved wallpaper now applies to the chat screen background and Quick Replies can be opened from the chat composer
- ✅ Tabs layout now uses web-safe auth redirects, and Expo push-notification calls are guarded on web so `/chats` no longer red-screens in preview
- ✅ Phase 2A.1 chat actions added: long-press action sheet, quick reactions, reply preview, quoted replies, copy, forward, star/unstar, delete placeholder, and haptic feedback
- ✅ Chat route is now hardened for invalid/unauthorized conversation IDs with a safe fallback state instead of a Convex error screen
- ✅ Phase 2A.2a media groundwork added: attachment sheet, image upload helper, gallery/camera send flow, image bubble rendering, upload progress bar, and full-screen image viewer
- ✅ Phase 2A.2b voice notes patched in: record/send flow in chat composer plus playback UI in media bubbles
- ✅ Phase 2A.2c chat parity added on the frontend: poll composer modal, poll message bubble voting UI, document picking/upload flow, and file message bubble open/download handling
- ✅ Phase 2B.1 frontend prerequisites added: redesigned sign-in screen, status composer route, and media status creation sheet on the Status tab
- ✅ Phase 2B.2 story viewer added on the frontend: full-screen viewer route, progress bars, tap navigation, pause/resume handling, reply input, and own-story viewers sheet
- ✅ Phase 2C contacts polish added on the frontend: rewritten Contacts tab, reject/cancel flows, sent/respond/contact pills, add-by-phone modal, and QR show/scan route
- ✅ Ads module addendum added on the frontend: My Ads credit balance/redeem card plus Admin > Ads > Ad Codes tab with generate/copy/revoke controls
- ✅ Search + Starred slice added on the frontend: global search screen, starred messages screen, chats/profile button wiring, and a basic user profile route for search results
- ✅ Wallet / Send Money slice added on the frontend: `Gold Wallet` screen, withdrawal methods/request UI, `Send Money` screen with send/request/pending tabs, and Earnings entry points into both routes
- ✅ Ads module MVP added: Ads tab wiring, Browse/My Ads view, Create Ad form, Admin Review screen, country selector modal, and standard 195-country list filtering
- ✅ Fixed React 19 TypeScript incompatibility from `react-native-country-codes-picker` so the preview/build loads cleanly again
- ✅ Fixed invalid chat-route update loop by stabilizing query fallback handling and chat fallbacks; `/chat/test-conversation` now renders the unavailable state without `Maximum update depth exceeded`
- ✅ Rebuilt `/chat-appearance` to closely match the latest user-provided screenshot reference with a dark brown header, wallpaper/bubble-theme tabs, large live preview, screenshot-style wallpaper cards, and preserved local appearance persistence
- ✅ Hardened Android production bundling for WebRTC calls by adding an npm `prepare` hook for the existing `patch-rn-webrtc.js` and forcing `react-native-webrtc` to resolve `event-target-shim@5.0.1`, preventing the EAS `Missing "./index" specifier in "event-target-shim" package` failure during the JavaScript bundle phase
- ✅ Removed a corrupt malformed filename from `/app/frontend` that was breaking EAS tarball upload with `ENOENT ... lstat '/workspace/source/frontend/��@@��9@8'`, and strengthened `.easignore` to exclude similar junk names plus Python cache artifacts
- ✅ Fixed the Groups tab crash risk by replacing raw Convex queries with `useSafeConvexQuery`, deferring the optional conferences query until needed, and hardening list item IDs / row navigation so missing identifiers do not crash the screen
- ✅ Fixed Groups/Conferences navigation and call-route stability: Groups `+` now opens a dedicated new-group screen, Conferences `+` opens a safe new-conference screen, Conferences now reuse existing group conversations as conference-ready entries, and the call screen no longer crashes from unguarded wake-lock usage or raw unauthenticated Convex queries
- ✅ Updated the Conferences screen toward the latest screenshot reference (gold header, back arrow, search, invite-code row, styled conference list, SOS button) and further hardened the native call flow by moving audio-session setup until after permissions succeed and adding iOS background-audio capability support in `app.json`
- ✅ Added Android-specific call-screen mounting guards: `CallSession` and `RTCViewWrapper` are now lazy-loaded after a short mount delay so `react-native-webrtc` native modules do not initialize too early and crash Android when the voice/video route opens
- ✅ Login and Sign Up were explicitly skipped by the user for now; rebuilt the Message Language screen to match the provided web screenshot, added Akan (Asante Twi) plus more recognized languages (including Kazakh), and changed the profile language row to display a human-readable language name instead of a raw code
- ✅ Applied the latest chat-screen references to `/chat/[conversationId]`: replaced the generic header with a screenshot-style brown header, added the end-to-end encryption banner, date chips, warmer composer controls, and richer link/file bubble styling while preserving the existing Chat Appearance wallpaper and bubble-theme system
- ✅ Added screenshot-driven chat extras and money flow updates: voice-note recording now exposes cancel / pause-resume / send controls, disappearing messages now use a top chat button with selectable options, and `/send-money` was rebuilt to a screenshot-style Send / Requests / History experience with transfer and contact-picker modals
- ✅ Refined the live chat typography and bubble styling again to better mirror the web app: title casing now matches the web header more closely, date/time chips use the web-style formatting, default chat text size is less oversized, and message bubbles use tighter radii/padding closer to the web screenshots
- ✅ Added richer chat-composer behavior toward the latest web screenshots: the composer now uses stronger keyboard avoidance on Android, exposes a bold toggle plus a five-color palette, and renders outgoing formatted text (bold / black / red / blue / green / gold) through a lightweight rich-text message parser
- ✅ Refreshed the bundled ringtone assets for `Smilers Never Cry · 2` and `Smilers Never Cry · 3` with the latest uploaded MP3s while keeping the existing ringtone catalog entries intact
- ✅ Updated the bundled message notification sound so received messages now use a two-part alert sequence: the existing beep followed by the newly uploaded follow-up sound, while preserving the same `message_notification.mp3` filename already used by foreground alerts and native push channels
- ✅ Re-investigated the Android production call crash and removed the remaining early `react-native-webrtc` native initialization: `CallSession.ts` now uses cached dynamic imports, `createPeerConnection()` is async, `call/[conversationId].tsx` awaits that initialization, and `RTCViewWrapper.ts` no longer imports `RTCView` at module load time
- ✅ Fixed the follow-up EAS Update export blocker by removing JSX from `src/lib/webrtc/RTCViewWrapper.ts` and switching to `React.createElement(...)`, which keeps the wrapper valid as a `.ts` file during OTA/export bundling
- ✅ Refined the native voice-call screen toward the web screenshots: smarter contact-name resolution, outlined avatar orb, web-style Mute / Audio / Screen / Add controls, and an in-call Audio Output chooser matching the provided reference more closely
- ✅ Added the in-call Add to call escalation flow to match the provided screenshots: tapping Add now opens a dedicated add-participant overlay with contact search, then shows the Privacy Settings choice sheet before creating a new group conversation and replacing into the conference call route
- ✅ Added shared safe display-name resolution across Contacts, Chats, Chat header, Call screen, add-to-call rows, and Avatar initials so saved contact names are preferred over the generic `Smilers` fallback and malformed name payloads no longer crash renders
- ✅ Hardened contact opening with safer contact-user-id lookup and guard rails around direct-chat creation so bad or incomplete contact records degrade gracefully instead of crashing the app
- ✅ Updated ringtone playback so the user's selected preferred ringtone is used during outgoing ringing as well as incoming ringing (with vibration still limited to incoming-call behavior)
- ✅ Tightened the chat composer box again toward the web screenshot with a denser beige shell, slimmer toolbar spacing, and a more web-like input shape
- ✅ Reworked the non-video call layout for compact screens: the avatar/name/status area is now centered and uses compact spacing/sizing so contact metadata no longer overlaps the action controls on short mobile heights
- ✅ Replaced the simple emoji modal with a fuller web-style emoji picker sheet: category icon row, many more emoji categories, and recent emojis support
- ✅ Reworked the attachment popup toward the web reference into a floating action card with Photo, Video from Gallery, Record Video, Document, and Location rows
- ✅ Restored chat keyboard avoidance for typing and switched voice-note recording to an explicit `prepareToRecordAsync` + `startAsync` flow for more reliable recording startup
- ✅ Expanded ringtone options with `Classic Ring` and `Smilers Notification`, and updated foreground message alerts to play a two-step beep + selected notification tone sequence
- ✅ Tuned the visible composer toolbar closer to the web screenshots by shifting primary actions into a dedicated bottom tool row (apps, GIF placeholder, templates, tools, mic, palette), simplifying the input row itself, and then tightening spacing/icon sizing/divider weight for a flatter web-like finish
- ✅ Fixed a critical chat crash path by removing the auto-translation render loop (translated-message state no longer retriggers the translation effect on every render)
- ✅ Split the two language flows correctly: `/message-language` is now the single preferred-language picker for auto-translation, while `/languages` is the multi-select skip-translation settings screen with grouped headings and checkbox rows
- ✅ Expanded the shared language catalog to 111 entries so both language flows can show a much fuller official-language list with distinct variants like Chinese Simplified/Traditional and Portuguese / Portuguese (Brazil)
- ✅ Simplified notification-sound choices to only `Smilers Notification` and `Silent`, synced the Android Messages notification channel to that choice, and made foreground translation faster by processing only recent untranslated messages in parallel
- ✅ Fixed an audio-mode conflict between foreground message sounds and voice-note recording, and reduced the attachment sheet footprint slightly again
- ✅ Added app-side Android notification hardening for native behavior: `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`, message/call channel syncing, and a missed-call local notification when an incoming call ends unanswered while the app is alive enough to observe it
- ✅ Fixed the repeated call-screen naming issue for caller-launched calls by passing the resolved saved contact name into the call route, and updated caller hangup during ringing to use `declineCall` so the remote side can stop ringing correctly
- ✅ Replaced the composer tools-button `requestAnimationFrame(...focus())` timing with an interaction-safe focus pattern to avoid the real-device backgrounding issue
- ✅ Improved live status handling by merging saved contact data with conversation presence data instead of letting saved contact records hide online/last-seen fields
- ✅ Added separate delivery acknowledgements for message ticks: the app now attempts `messages.markDelivered` when a message push is received while running, and the chat screen calls `markDelivered` before `markRead` so delivered vs read can diverge more like the web app
- ✅ Fixed tick rendering assumptions so `readBy.length > 0` is enough to show the read state, rather than incorrectly requiring more than one reader entry
- ✅ Deployment-facing package cleanup: removed mixed Yarn lock usage, switched `packageManager` to npm, generated a consistent `package-lock.json`, and moved `eslint` + `eslint-config-expo` into runtime dependencies so the build-time `expo install` / config checks can find them reliably
- ✅ Deployment-facing auth URL cleanup: added `EXPO_PUBLIC_WEB_APP_URL` to frontend env and removed the hardcoded `https://smilers.online` fallback in mobile auth screens/providers
- ✅ Push notification spec alignment pass: installed `expo-task-manager`, updated native push registration to send `{ expoPushToken, platform, deviceName, appVersion }` with backend fallback for `mobilePush` vs `pushNotifications`, refreshed Android `calls` / `messages` channels plus iOS `remote-notification` background mode, and added background notification-task scaffolding for headless/data-driven delivery handling
- ✅ Web-safe push import cleanup: added `usePushNotifications.web.ts` and converted remaining top-level `expo-notifications` imports in call/ringtone screens to native-only lazy requires so web preview no longer logs the push-token-listener warning
- ✅ Backend-aligned push lifecycle: moved native push registration out of the tabs layout into `app/_layout.tsx` so authenticated sessions register earlier, added best-effort `mobilePush.unregisterMobileDevice` handling on logout, and restored native token-refresh re-registration now that the web bundle is isolated from Expo notifications imports
- ✅ Deployment hardening for Emergent/EAS Android builds: moved `typescript` and `@babel/core` into production dependencies so Expo CLI checks still work when the builder omits devDependencies, and added `frontend/eas.json` with `cli.appVersionSource` + `app-bundle` profile so the pipeline stops generating that config dynamically. (Kept `packageManager` on Yarn locally because this workspace’s readonly supervisor still launches Expo with Yarn; the deployment log’s concrete blockers were missing build-time dependencies, not the packageManager field.)
- ✅ Fixed chat composer tools-button crash/minimize on Android: the sliders button had been calling a nonexistent `setShowComposerFormatting` setter at press time. Introduced real pinned formatting state in `app/chat/[conversationId].tsx`, so the button now safely opens/closes the formatting strip instead of throwing and minimizing the app
- ✅ Push registration race hardening: `src/push/usePushNotifications.ts` now waits for Convex auth readiness before device-token registration, retries failed registration attempts, and re-registers on app-active/token refresh so backend `mobilePushTokens` has a better chance of being populated reliably on native devices
- ✅ Privacy web-preview fallback: `app/privacy.tsx` no longer hits the cloud privacy query on web preview, preventing repeated `privacy:getSettings` console errors while keeping the native app path ready for authenticated mobile use
- ✅ Added a push diagnostics panel to `app/notifications.tsx` backed by `src/push/pushDiagnostics.ts`, exposing auth readiness, projectId detection, permission state, device token preview, last registration result/error, and a manual retry action to speed up Android/iOS notification debugging on real devices
- ✅ Added a `Copy diagnostics` action on the Notifications diagnostics card so the full push state can be copied and shared instantly during Android/iOS debugging
- ✅ Added staged Android push-token diagnostics: the app now separates native device-token fetch from Expo token fetch and times both out with clear actionable errors, instead of hanging forever at a generic `acquiring-token` state
- ✅ Wired Android Firebase/FCM config for native push: added `frontend/google-services.json` for Firebase project `smilers-a4e07` and connected it through `expo.android.googleServicesFile` so Android builds can acquire the native device push token
- ✅ Added notification self-test tools on `app/notifications.tsx`: a local notification test and a remote Expo self-push test, allowing real-device isolation of native rendering versus backend delivery
- ✅ Switched Expo/EAS linkage to the actual project chosen by the user: `slug=smilers`, `owner=abcsimplesend`, `projectId=smilers-chat-mobile`
- ✅ Fixed the chat GIF button so it is no longer a dead disabled control; it now launches a GIF-only picker and sends selected GIF files through the existing media upload/message flow
- ✅ Migrated chat voice-note recording from deprecated `expo-av` recorder APIs to `expo-audio`, including microphone permission request, audio mode handling, recorder lifecycle, and the `expo-audio` app config plugin
- ✅ Added `/app/auth_testing.md` and `/app/auth-testing.md` to document current manual auth verification expectations for future testing runs
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_POLLS_FILES.md` because the Convex backend source is not present in this repo; it documents the required schema, `messages.send`, and `votePoll` backend changes
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_STATUS_STORIES.md` because the Convex backend source is not present in this repo; it documents the required `statuses` endpoints, story views, DM reply support, and direct-conversation mutation
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_CONTACTS_POLISH.md` because the Convex backend source is not present in this repo; it documents the required contacts queries/mutations for outgoing requests, reject/cancel, phone invites, and QR flows
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_AD_CREDIT_CODES.md` because the Convex backend source is not present in this repo; it documents the required `adCreditCodes` table, code lifecycle, redeem flow, and `ads.recordClick` billing changes
- ✅ Applied the latest user handoff spec to replace both `/privacy` and `/scheduled` with the new mobile UI variants, including installing `@react-native-community/datetimepicker` for scheduled date/time picking
- ✅ Kept the user handoff UI but added the minimal required safety fix: both routes now use `useSafeConvexQuery` instead of raw `useQuery`, because the current Convex endpoints still return `Server Error` and raw queries caused red-screen crashes
- ✅ Reworked native sign-in to bridge through the already working web app at `https://smilers.online/`: Sign In now routes to `/auth-webview`, opens the live web sign-in flow, and supports callback handoff via either direct tokens or OIDC `code/state`
- ✅ Added `/app/HERCULES_MOBILE_SIGNIN_BRIDGE.md` for the Hercules/web agent with the exact query params and callback contract needed to return control to the native app after successful web login
- ✅ Added callback support in `+not-found.tsx` / `auth-callback` for `id_token`, `access_token`, `refresh_token`, and `expires_in` bridge params, while preserving the existing code-exchange path
- ✅ Updated native phone verification gating to stay mobile-only and install-aware: after auth, the app now requires phone verification when the backend user is unverified or when the current app install lacks the local verified-install marker (matching first install / reinstall behavior)
- ✅ Stored the verified-install marker locally after successful OTP verification so repeat sign-ins on the same install do not re-prompt unnecessarily
- ✅ Renamed the Status tab route file to `updates.tsx` to avoid Expo web’s reserved `/status` path conflict while keeping the tab label as **Status**
- ✅ Convex client with custom auth integration (passes ID token via `ConvexProviderWithAuth`)
- ✅ Bottom tab navigation (5 tabs: Chats, Contacts, Groups, Status, Profile) — matches web app's bottom nav
- ✅ Chat list with pinned **Smilers AI** (purple) and **Chat Once** (orange) rows + FAB stack (4 floating buttons) + persistent SOS button
- ✅ Direct & group chat view (text messages, send, ticks for sent/delivered/read, typing indicator, reactions, replies, media placeholders)
- ✅ Contacts tab (list, search, add by email, accept pending requests, tap to open chat)
- ✅ Groups tab (list user's groups)
- ✅ Status tab (status feed, "My Status" with plus badge)
- ✅ Profile tab (avatar with camera overlay, Your Name, About, Message Language, Email, Starred Messages, Settings & Privacy, Sign Out)
- ✅ Settings screen (Privacy, App Lock, Face ID, Notifications, Earnings, Blocked Users, Scheduled Messages, Quick Replies, Chat Appearance)
- ✅ Exact design match with web app: gold/yellow primary (#E4B53B), dark brown header (#3A2608), cream background (#F5EFE0)
- ✅ All native permissions declared in app.json for iOS + Android (camera, mic, location, contacts, biometric, etc.)

## Backend API Integration (existing functions called)
- `api.users.updateCurrentUser` — auto-sync on login
- `api.users.getCurrentUser`, `api.users.searchUsers`
- `api.conversations.listConversations`, `api.conversations.listGroups`, `api.conversations.getConversation`, `api.conversations.getOrCreateDirect`
- `api.messages.list`, `api.messages.send`, `api.messages.markRead`
- `api.contacts.getContacts`, `api.contacts.getPendingRequests`, `api.contacts.sendRequest`, `api.contacts.acceptRequest`
- `api.statuses.listStatusGroups`, `api.statuses.getMyStatuses`
- `api.typing.setTyping`

## Phase 2+ (Future Iterations)
- Voice/Video calls (WebRTC peer-to-peer with Convex signaling)
- Push notifications backend wiring (register device token via `api.pushNotifications.subscribe`)
- E2EE encryption (PBKDF2 key derivation + AES-GCM as per backend spec)
- Conferences with breakout rooms, motions, voting, minutes
- Money transfers, Gold wallet, Earnings/levels system
- AI chat via `api.ai.chat`
- Communities, Broadcasts, Polls, Templates
- Status / Stories (text/photo/video composer + viewer)
- Story reply + story viewer counts/viewers sheet
- Contacts QR + add-by-phone flow
- Ads credit codes / redeem flow
- Global search + starred messages
- Wallet / send-money flow
- Scheduled messages, Backup, Face ID app lock, Trustees/Emergency
- Voice notes (record + playback + Whisper transcription)
- Image/file sharing via Convex File Storage
- Auto-translation by recipient's preferred language
- Disappearing messages
- Status reactions & replies
- Screen sharing
- Admin dashboard

## Smart Business Enhancement
The Earnings/Engagement system is already built into the backend. The mobile app exposes the entry point in Settings → "Earnings" which can drive:
- **Daily activity nudges** via push notifications to maintain engagement levels
- **Referral codes** drive viral growth with 2 engagements per signup (compounds at higher levels)
- **Gold tier wallet activation** at high engagement creates retention loop tied to real-world payouts

## Out of Scope (current iteration)
- Final real-device login validation still depends on Hercules allowing the native redirect URI `smilers://auth-callback` for the mobile client.
- End-to-end authenticated sign-in through the live Smilers web app still needs one manual web/Hercules bridge completion test, because automation cannot perform the real callback/token return from the external live site.
- Manual authenticated verification is still required for three live cases: first mobile sign-up, reinstall on a previously verified account, and deleted/reactivated account flow.
- Full end-to-end authenticated voice-note verification is still pending because browser automation cannot deterministically complete the third-party Google/Hercules sign-in flow with the current test setup.
- Full end-to-end authenticated poll/document verification is still pending for the same auth-gated reason, and the live poll voting flow also depends on the user applying the backend changes from `/app/CONVEX_BACKEND_INSTRUCTIONS_POLLS_FILES.md`.
- Full end-to-end authenticated status/story verification is still pending for the same auth-gated reason, and story viewing/reply/view counts depend on the backend changes from `/app/CONVEX_BACKEND_INSTRUCTIONS_STATUS_STORIES.md`.
- Full end-to-end authenticated contacts-polish verification is still pending for the same auth-gated reason, and outgoing requests/reject/cancel/add-by-phone depend on the backend changes from `/app/CONVEX_BACKEND_INSTRUCTIONS_CONTACTS_POLISH.md`.
- Direct signed-in verification of the fixed Contacts tab is still pending because browser automation cannot complete the Hercules-authenticated mobile flow in this environment.
- The latest `/privacy` and `/scheduled` handoff screens are live and tested, but real cloud persistence is still blocked because `privacy:getSettings`, `privacy:updateSettings`, `scheduledMessages:listMine`, and `scheduledMessages:create` continue returning Convex `Server Error`.
- Iteration 12 frontend testing confirmed both routes now load without crash and remain interactive under backend failure conditions because of the safe-query guard.
- Quick Replies and Chat Appearance currently persist per device in the mobile client; no backend sync is wired for those routes yet.
- Full end-to-end authenticated ad-credit verification is still pending for the same auth-gated reason, and code generation/redeem/billing depend on the backend changes from `/app/CONVEX_BACKEND_INSTRUCTIONS_AD_CREDIT_CODES.md`.
- Full end-to-end authenticated search/starred verification is still pending because browser automation cannot complete the Hercules sign-in flow here, so in-app button navigation from Chats/Profile still needs one signed-in device pass.
- Full end-to-end authenticated wallet/send-money verification is still pending because browser automation cannot complete the Hercules sign-in flow here, and the exact mutation arg shapes for some `wallet.ts` / `transfers.ts` actions still need validation against the live backend.
- The latest real-data regression checks for the user-reported contact/call issues are still partially pending because automation could not authenticate into a live account with real contacts; manual signed-in validation is still needed for: the specific `Asare Ben Chris` crash case, saved contact-name parity in live chats/calls, and hearing the preferred ringtone during a real native outgoing call.
- The newest chat-polish items still need signed-in native-device validation for the real keyboard/composer-on-typing behavior, actual voice-note capture/send, and audible message/incoming-call sounds under real notification conditions.
- The biggest remaining gap is true killed-state incoming-call/message delivery. The app-side notification channels and permissions are now in place, but the external Convex backend must also be sending Expo mobile pushes to the registered native token (not only web/Chrome push) for ringing/notifications to work when the native app is killed.
- The current Android production build log still ends with a pure remote infrastructure failure in the EAS worker: Gradle wrapper download returns HTTP 502 while fetching `gradle-8.14.3-bin.zip`. That final blocker is outside app code; repo-side fixes now target the earlier package/env issues so any remaining failure is isolated to the remote Gradle download step.

## Files
- `/app/frontend/app/_layout.tsx` — Root with AuthProvider + ConvexProvider
- `/app/frontend/app/index.tsx` — Redesigned sign-in screen
- `/app/frontend/app/+not-found.tsx` — OIDC deep-link catch-all + token exchange fallback
- `/app/frontend/app/auth-webview.tsx` — Live Smilers web sign-in bridge screen for native auth handoff
- `/app/frontend/app/{emergency,ai-chat,blocked,notifications,earnings}.tsx` — Fully wired Phase 1 utility screens
- `/app/frontend/app/{privacy,app-lock,face-id,chat-appearance,templates,scheduled,chat-once}.tsx` — Phase 1 polished placeholders
- `/app/frontend/src/components/ComingSoon.tsx` — Shared placeholder screen component
- `/app/frontend/src/hooks/useSafeConvexQuery.ts` — Safe query helper for optional Convex endpoints
- `/app/frontend/app/chat/[conversationId].tsx` — Phase 2A.1 message actions and safe fallback handling
- `/app/auth_testing.md` and `/app/auth-testing.md` — Auth testing notes for manual/automation handoff
- `/app/frontend/src/lib/uploadFile.ts` — Convex file upload helper
- `/app/frontend/src/components/{AttachmentSheet,MediaBubble}.tsx` — Attachment picker and media-aware message bubble renderer
- `/app/frontend/src/components/PollComposer.tsx` — Poll creation bottom sheet
- `/app/frontend/app/status-compose.tsx` — Text status composer
- `/app/frontend/app/status-view/[userId].tsx` — Full-screen story viewer
- `/app/frontend/app/(tabs)/updates.tsx` — Status tab UI and media status creation sheet
- `/app/frontend/app/(tabs)/contacts.tsx` — Contacts tab with add sheet, reject/cancel flows, and relationship pills
- `/app/frontend/app/contact-qr.tsx` — Contact QR show/scan modal route
- `/app/frontend/app/(tabs)/ads.tsx` — Ads Browse/My Ads home
- `/app/frontend/app/ads/{create,review}.tsx` — Ad creation and admin review flows
- `/app/frontend/app/search.tsx` — Global search screen for chats and people
- `/app/frontend/app/starred.tsx` — Starred messages screen
- `/app/frontend/app/user/[userId].tsx` — Basic user profile route for search results
- `/app/frontend/app/wallet.tsx` — Gold Wallet screen with payout methods and withdrawal requests
- `/app/frontend/app/send-money.tsx` — Send/request money screen with pending requests and history
- `/app/frontend/src/lib/adCreditCodes.ts` — Ad credit code formatting/estimate helpers
- `/app/frontend/src/lib/{settingsStorage,chatAppearance}.ts` — Local settings persistence and chat appearance helpers
- `/app/frontend/src/{constants/countries.ts,components/CountrySelectorModal.tsx,hooks/useDebouncedValue.ts}` — Ads filtering/support utilities
- `/app/frontend/app/(tabs)/_layout.tsx` — Tab bar
- `/app/frontend/app/(tabs)/{chats,contacts,groups,updates,profile}.tsx`
- `/app/frontend/app/chat/[conversationId].tsx` — Chat detail
- `/app/frontend/app/settings.tsx` — Settings list
- `/app/frontend/src/providers/AuthProvider.tsx` — Hercules OIDC + token mgmt
- `/app/frontend/src/providers/ConvexClientProvider.tsx` — Convex client + auth glue
- `/app/frontend/src/components/{Header,Avatar,FabStack,SosButton}.tsx`
- `/app/frontend/src/theme.ts` — Design tokens
- `/app/frontend/src/convexApi.ts` — Untyped api references via `anyApi`
- `/app/CONVEX_BACKEND_INSTRUCTIONS_POLLS_FILES.md` — Required backend support for poll voting and file messages
- `/app/CONVEX_BACKEND_INSTRUCTIONS_STATUS_STORIES.md` — Required backend support for status/story composer, viewer, and story replies
- `/app/CONVEX_BACKEND_INSTRUCTIONS_CONTACTS_POLISH.md` — Required backend support for outgoing requests, reject/cancel, phone invites, and QR contacts
- `/app/CONVEX_BACKEND_INSTRUCTIONS_AD_CREDIT_CODES.md` — Required backend support for Ad Credit Codes, redeem flow, and per-click billing deductions
- `/app/HERCULES_MOBILE_SIGNIN_BRIDGE.md` — Exact web/Hercules-side instructions to redirect successful web sign-in back into the native app

## Session: Feb 2026 — Chat Refactor Phase 2 + Swipe-to-Reply
- **Swipe-to-Reply (NEW)**: WhatsApp-style swipe-right gesture on any message bubble opens the reply composer with haptic feedback. Implemented in `/app/frontend/src/components/chat/SwipeToReply.tsx` (react-native-gesture-handler Pan + reanimated v4). Native-only (disabled on web); disabled in multi-select mode, for suspended viewers, and on deleted messages. NEEDS DEVICE VERIFICATION (gesture is native-only).
- **Chat Screen Refactor Phase 2 (DONE)**: Extracted 5 more components from `chat/[conversationId].tsx` (3,882 → 3,411 lines):
  - `MessageActionSheet.tsx` — long-press sheet w/ quick reactions + action rows (owns QUICK_REACTIONS)
  - `DeleteMessageSheet.tsx` — tri-state delete sheet
  - `DisappearingSheet.tsx` — duration picker (owns canonical DISAPPEARING_OPTIONS, re-imported by chat screen)
  - `ForwardPickerSheet.tsx` — forward-to picker incl. pinned Diary tile (diary save logic stays in parent via onSaveToDiary)
  - `TemplatePickerSheet.tsx` — Quick Replies picker
- All testIDs preserved exactly. Removed ~470 lines of dead styles/JSX from the chat screen. ESLint + tsc clean; web bundle renders (smoke-tested).
- User confirmed fixed this session: small-phone tab spacing, Trustees contact list.

## Session: Feb 2026 — Desktop Login Approval (native side, iter-186)
Built per web team's DESKTOP_LOGIN_APPROVAL_NATIVE_CONTRACT.md (pasted in chat):
- `/app/frontend/app/approve-login.tsx` — approval screen: pending list (live `api.loginApprovals.listPendingForMe` subscription), per-request detail w/ 2-min countdown, Approve gated by device biometrics/PIN (expo-local-authentication, blocks if no screen lock), Deny without gate, in-app QR scanner (parses `?code=` URL or raw 8-char hex), success/error states mapped to contract error codes (BAD_REQUEST=expired, CONFLICT=handled, FORBIDDEN, NOT_FOUND, UNAUTHENTICATED).
- `/app/frontend/src/components/LoginApprovalBanner.tsx` — amber banner atop Chats tab when pending approvals exist (contract §5.5), live-updating.
- Push: `login-approvals-v1` channel (MAX importance heads-up) in notificationChannels.ts; `login-approval` notification category with Approve (opens app → biometric) / Deny (background mutation) action buttons; response handler + foreground receive listener route to /approve-login with code (usePushNotifications.ts).
- Settings row "Approve Desktop Login" (after Face ID).
- ⚠️ FOLLOW-UP FOR WEB AGENT: push must include `categoryId: "login-approval"` for the Approve/Deny buttons to render on the notification (tap-to-open works without it).
- Verified: eslint + tsc clean, web bundle renders. Device verification needed (push, biometrics, QR scan are native-only).

## Session: Feb 2026 — Screen Share fixes (iter-188)
User-reported bugs (with debug overlay screenshot):
1. **Screen share never connected ("from day one")** — ROOT CAUSE: `startPeerConnection skipped (ctor=false)`. The screen-only bootstrap in `app/call/[conversationId].tsx` claimed `initStartedRef` and called startPeerConnection immediately on mount, but on Android the WebRTC module (`CallSessionCtor`) is require()d ~350ms later (screenReady timer). The bail path never released the slot and nothing retried → no PC → no MediaProjection picker. FIXES: (a) bail path now releases `initStartedRef` when ctor/callId missing (keeps it for live-session idempotency), (b) screen-only Effect B + caller/callee kick-off effects now gate on `CallSessionCtor` and include it in deps so they re-fire when the module loads.
2. **Google-account names instead of device contact names** — Share Screen picker (`app/screen-share.tsx`) and incoming request modal (`IncomingScreenShareModal.tsx`) now resolve names via `resolveDeviceContactNameFromUser(useDeviceContactIndex())`, same as Chats list.
- Verified: eslint 0 errors, tsc no new errors (6 pre-existing in call screen), web bundle renders. NEEDS DEVICE VERIFICATION (WebRTC/MediaProjection native-only): expect the share-app/entire-screen picker to appear again after EAS build.

## Session: Feb 2026 — Screen Share signaling queue (iter-189)
After iter-188 fix, user's debug overlay showed the NEXT failure layer: `screenSharing.sendSignal` Server-Errors (offer + ICE dead after 3 fast retries in ~2s). Cause: sharer enters /call immediately after `requestScreenShare`, BEFORE recipient accepts — backend rejects signals for not-yet-active sessions. FIXES in `app/call/[conversationId].tsx`:
- Ordered screen-signal queue (`screenSignalQueueRef`) + `flushScreenSignalQueue`: retries head-of-queue every 2.5s for up to 2 min, preserving offer-before-ICE order; flushes everything the moment the recipient accepts. Full backend error text (300 chars) logged on give-up.
- `peerConnected` state from onConnectionStateChange → ScreenShareOverlay sharer copy now says "Waiting for the recipient to accept…" until WebRTC is actually connected.
- Queue cleared on unmount. eslint 0 errors, tsc no new errors. NEEDS DEVICE VERIFICATION (2 phones: request → accept → picker → stream).
- NOTE: frontend zip download endpoint `/api/download/frontend-zip` (added this session) — zip REGENERATED after this fix.

## Session: Feb 2026 — Share Sheet "contacts do not appear" fix (iter-190)
User screenshot: Share-to-Smilers picker showed "No matches" (no Diary row either) despite a full address book. ROOT CAUSE: `app/share-receiver.tsx` had no offline/cold-start resilience — its useSafeConvexQuery calls silently settle to [] when the Convex websocket is down (roaming/flaky network) or the auth handshake races; the Chats tab masks the same condition via its iter-160 AsyncStorage cache. FIXES:
- share-receiver now hydrates from the SAME offline cache (readCacheMeta 'conversations'/userKey) + a new 'contacts' scope, with write-through when live data arrives. Live data wins when non-empty.
- Loading-aware empty state: spinner + "Loading your chats and contacts…" while queries resolve; honest "couldn't load — check connection" copy otherwise (search-specific copy when filtering).
- eslint 0 errors, tsc 0 errors for the file. Zip at /api/download/frontend-zip REGENERATED (includes iter-188/189/190).

## Session: Feb 2026 — Share sheet REAL root cause: OIDC discovery race (iter-191)
iter-190 cache fix didn't help (user confirmed with new build). TRUE ROOT CAUSE found in AuthProvider.tsx:
- On share-sheet cold start, the stored id_token is expired. Convex requests a token within ~100ms, but `refreshTokens()` returned null whenever `useAutoDiscovery` hadn't loaded the OIDC discovery doc yet (network race lost every time). `getFreshIdToken` then handed Convex the EXPIRED token → Convex ran silently UNAUTHENTICATED for the session → getCurrentUser=null, getContacts=[], listConversations=[] (valid empty results, no errors). Chats tab masked it via cache; share-receiver showed "No matches". iter-190's cache fallback ALSO missed because with getCurrentUser=null the cache key fell back to 'anon' while data was cached under the real user id.
FIXES:
1. AuthProvider: OIDC discovery document persisted to storage (`smilers_oidc_discovery`); refreshTokens falls back to it — refresh works instantly on every launch after the first.
2. getFreshIdToken: waits up to 5s for discovery (live or cached) before attempting refresh, and calls refreshTokens via a ref (stale-closure fix: old closure captured discovery=null).
3. Cache-key fix: `me` persisted under fixed key ('me','self') by chats tab + share-receiver; share-receiver resolves user id from this cache when Convex is unauthenticated, so conversation/contact caches hit correctly.
- eslint 0 errors, no new tsc errors. Zip REGENERATED. User raised billing complaint → support_agent response delivered verbatim (support@emergent.sh with job ID).

## Session: Feb 2026 — Connection status pill on share screen (iter-192)
- New `/app/frontend/src/components/ConnectionStatusPill.tsx`: 🟢 Connected (socket + Convex auth), 🟡 Signing in… (socket up / auth handshake), ⚪ Offline — showing saved contacts. Uses `useConvexAuth` + `useConvexConnectionState` (convex ^1.37). Mounted under the header in share-receiver.tsx.
- eslint/tsc clean. Zip regenerated.

## Session: Feb 2026 — User device-test feedback round (iter-193)
CONFIRMED WORKING by user: desktop login approval ✓, swipe-to-reply ✓, share picker contacts ✓ (iter-191 auth fix verified), earpiece/speaker call audio ✓, MediaProjection picker now appears ✓ (iter-188 verified).
FIXES THIS ROUND:
1. APK sharing blocked → root cause was MAX_UPLOAD_BYTES.document=20MB (Smilers APK is 60+MB); raised to 100MB in dataFriendlyDefaults.ts. Scanner already allowed .apk.
2. Bluetooth call audio → BLUETOOTH_CONNECT runtime permission (Android 12+) was never requested in the call flow; setBluetoothOn() now requests it before SCO routing + extra route re-issue at 1.2s for slow headsets (inCallManager.ts).
3. Killed-app ringing (beep+short vibration) → TWO causes: (a) backend _resolve_android_channel only scanned the TITLE for "incoming call" but Convex sends WhatsApp-style pushes (title=caller name, body="Incoming voice call") → routed to messages channel; now scans title+message+subtext (kept (incoming|missed) guard to avoid false positives from chat texts like "let's video call"). (b) DEPLOYED backend (app-migration-75.emergent.host) is an OLD version without iter-182 per-token channel storage → USER MUST REDEPLOY the backend via Emergent Deploy. 30/30 pytest pass (2 new regression tests).
4. Screen share signaling: backend `screenSharing.sendSignal` Server-Errors EVEN AFTER acceptance → Convex backend bug; wrote /app/WEB_AGENT_SCREEN_SHARE_SENDSIGNAL_FIX.md for the user to hand to the web agent (likely wrong table id in ctx.db.get, status guard throw, or 'ice-candidate' literal mismatch).
Zip regenerated (24MB).

## Session: Feb 2026 — Bluetooth auto-switch (iter-194)
- New `addAudioDeviceChangedListener` in inCallManager.ts (Android `onAudioDeviceChanged` event from react-native-incall-manager; parses JSON availableAudioDeviceList; no-op on iOS).
- Call screen: auto-switches route to Bluetooth when a headset connects mid-call; falls back to earpiece (voice) / speaker (video) on disconnect. Works with the iter-193 BLUETOOTH_CONNECT permission request.
- Clarified to user: killed-app ringing fix requires BACKEND REDEPLOY via Emergent Deploy button (no zip/download involved — zip is frontend-only for EAS).
- eslint 0 errors, tsc baseline unchanged. Zip regenerated.

## Session: Feb 2026 — APK share crash fix (iter-195)
User: sharing a photo to Smilers works, but sharing a 185MB APK crashes the app on Send ("Smilers has stopped"). ROOT CAUSE: uploadFile did `fetch(uri) → blob() → POST`, loading the ENTIRE file into RAM → OOM kill on large files; plus the share path never ran a size check. FIXES:
1. uploadFile.ts: native uploads now STREAM from disk via `expo-file-system/legacy` `uploadAsync` (BINARY_CONTENT) — constant memory regardless of file size; blob path kept for web.
2. MAX_UPLOAD_BYTES.document raised 100MB → 250MB (user's APKs are ~185MB; safe now that uploads stream).
3. sendSharedPayload.ts: new `checkShareFileSize` (resolves size via fileSize or getInfoAsync) gates BEFORE upload in both the conversation and diary share branches — clear "too large (X MB — max Y MB)" outcome instead of crash/doomed upload.
- eslint + tsc clean. Zip REGENERATED (must rebuild via EAS to get the fix — crash was native-memory, requires new build).

## Session: Feb 2026 — PUSH NOTIFICATIONS ROOT CAUSE FOUND + FIXED (iter-197)
User reported pushes NEVER work (no banners when app open/backgrounded; total silence when killed; previous "fixes" were never device-verified). FULL-PIPELINE AUDIT findings (hard evidence):
1. DEPLOYED backend (app-migration-75.emergent.host): ALL 17 stored FCM tokens DEAD (UnregisteredError) — stale tokens from old builds; every push attempted there dies. Also runs pre-iter-182 code.
2. PREVIEW backend: live tokens (current build registers here, EXPO_PUBLIC_BACKEND_URL=preview) and FCM v1 send DELIVERED to BOTH user phones in live tests (call-style → 01KQVQFG… SM-A075F ✓, message-style → 01KQD0V5… ✓). Delivery infra (smilers-a4e07 project, admin SDK, channels) is HEALTHY.
3. Convex triggers: every historical send-push-internal showed matched=0; no real triggers logged since Jun 7 → whether Convex still POSTs (and to which URL) is THE remaining unknown — needs user test call + trigger-log check.
4. Tap-routing bug: backend FCM data lacked type/conversationId/callId and the app never read action_url → taps did nothing.
FIXES (backend, hot-reloaded on preview; REDEPLOY needed for production):
- _derive_push_routing(): fcm data now carries type/conversationId/callId/displayName parsed from action_url.
- 45s TTL on incoming-call pushes (no ghost rings).
- Dead-token auto-pruning on UnregisteredError.
- send-push-internal returns REAL per-token FCM stats; full recipient ids logged; persistent push_trigger_log (capped 300) exposed via GET /api/push-debug?triggers=N.
FIXES (frontend, in regenerated zip):
- handleResponse action_url deeplink fallback (contract §3: /chat, /call, /user, /notifications, https).
- share-receiver.tsx missing useRef import (left by iter-196) + uploadFile.ts null/undefined tsc fix — upload progress + cancel UI now compiles clean.
- BRANDING: official Smilers logo pulled from smilers.online → icon.png (1024), adaptive-icon.png (safe-zone composed), splash-image.png, favicon, NEW notification-icon.png (white bubble silhouette); app.json: notification icon + splash bg #FEF9F4; react template assets deleted.
TESTS: 36/36 pytest (new tests/test_push_routing.py), eslint 0 errors, tsc baseline clean for touched files. Zip REGENERATED (24MB).
DOC: /app/PUSH_PIPELINE_STATUS_iter197.md — Convex env checklist (MOBILE_BACKEND_URL must = preview URL for now; recipients = OIDC sub) + verification steps.
PENDING USER VERIFICATION: (1) test call+message between phones with receiver app killed → then check /api/push-debug?triggers=10 to confirm Convex triggers; (2) rebuild via EAS from new zip → verify Smilers icon, tap-routing, upload progress UI, Bluetooth auto-switch, large APK sharing.

## Session: Feb 2026 cont. (iter-198) — SENDER-SIDE PUSH TRIGGERS (Convex-independent)
User re-tested killed-app: still nothing → trigger log proved Convex NEVER POSTs send-push-internal for real messages/calls. Decision: make pushes independent of Convex triggers.
BACKEND (preview, live):
- POST /api/notify-event — client-fired push trigger (recipients = Convex user ids, event message|call|missed-call, validation caps, builds action_url, reuses send_push channels/TTL/routing).
- push_tokens now store convex_user_id (sent at registration); send_push matches $or(user_id, convex_user_id).
- Cross-trigger dedupe: _is_duplicate_push (idempotency_key 10min + content sha1 60s window, push_dedupe collection) applied to BOTH notify-event and send-push-internal → exactly one notification if Convex triggers ever return.
- send-push-internal logs full recipient ids (requested_ids/unmatched_ids).
LIVE E2E VERIFIED 18:02 UTC: message push delivered (1/1), duplicate suppressed, call push delivered (1/1, rings calls channel). 41/41 pytest (new dedupe/hash tests; pytest.ini loop scope session fix; uuid-unique test payloads).
FRONTEND (in zip, NEEDS REBUILD):
- src/lib/notifyPush.ts (fire-and-forget notifyEventPush + previewForMessageType).
- chat/[conversationId].tsx: sendMessage wrapped → fires message push to all other participants (Convex ids via pushNotifyCtxRef populated from hydratedConversation; works for groups). Preview: text or 📷/🎥/🎤/📎.
- call/[conversationId].tsx: after initiateCall success → fires call push (callerName, voice/video, callId as idempotency key).
- useEmergentPush: registers convex_user_id (api.users.getCurrentUser), throttle busts when convex id appears.
- scheduled.tsx: hides past one-time schedules (matches web; fixes duplicate stale Jun-11/12 entries complaint). NOTE: 'Unknown' recipient label is server-side data (web agent's listMine should return display names).
- contacts.tsx: referral code auto-create fallback (getOrCreateReferralCode) so invite links ALWAYS carry the referral code (user's invite went out without code because profile had none).
ZIP regenerated 18:05 (24MB) with all of the above + Smilers branding.
REMAINING after user rebuild: verify killed-app ring/messages e2e; production migration (redeploy backend + Convex MOBILE_BACKEND_URL + bake deployed URL — all three together); foreground suppression of banners for the actively-open chat (polish).

## Session: Feb 2026 cont. (iter-199) — PUSH SYSTEM CAME ALIVE AT 21:24; remaining items are Convex-side
Evidence from DEPLOYED backend trigger log (user redeployed backend tonight via Emergent build/deploy):
- Convex DOES trigger call pushes → POSTs send-push-internal to the DEPLOYED URL (recipients = OIDC subs, correct). At 21:24:11 a real "Incoming voice call" push was DELIVERED to phone 2 (matched + fcm_success=1) — ~10 min AFTER the user stopped testing (screenshots 21:09-21:12). Before 21:24 production had only dead tokens.
- The installed Emergent android build CONTAINS iter-198 (client trigger fired at 21:24:11.296 with Convex-id recipient; scheduled filter visible in screenshot). Build bakes the DEPLOYED backend URL.
- Self-test pushes via deployed backend delivered to BOTH phones.
- convex_user_id matching not confirmed yet (probe token_count=0; may be 3rd account or registration timing) — has_convex_id now exposed in push-debug tokens (next redeploy).
iter-199 changes (preview; USER MUST REDEPLOY BACKEND to ship): _recent_call_push_to_user() — semantic per-recipient 25s call-push dedupe collapsing Convex-trigger + caller-device doubles (different keys/urls so generic dedupe can't catch); push-debug tokens now show has_convex_id. 41/41 pytest. Live test confirmed pruning of dead preview tokens.
NEW DOC: /app/WEB_AGENT_REQUESTS_iter199.md — canonical-contract questions for web agent: (1) screenSharing.sendSignal offer rejection (P0), (2) users.updateProfile language fields Server Error (P0 — mobile tried skipTranslationLanguages/languages/spokenLanguages), (3) scheduledMessages.listMine recipient 'Unknown', (4) earnings.getOrCreateReferralCode existence (invite shared without code).
USER ACTIONS: (1) redeploy backend (no app rebuild needed), (2) RE-TEST pushes NOW with current build (killed app), (3) relay WEB_AGENT_REQUESTS_iter199.md to web agent.

## Session: Feb 2026 cont. (iter-200) — Canonical contracts wired + production-URL build zip
Web agent provided canonical answers (user relayed): screenSharing.sendSignal FIXED server-side (accepts offer/ice any casing — mobile just re-tests); languages = users.updateProfile({preferredLanguage, selectedLanguages}); scheduled names = scheduling.getAllMyScheduledMessages → conversationName; referral = earnings.getOrCreateReferralCode (lazy, idempotent).
Evidence from user's 22:27 re-test (deployed trigger log): Convex call trigger fired + FCM SUCCESS yet phone showed NOTHING → device-display layer issue (likely channel mismatch) + both fresh deployed tokens have has_convex_id=false (registration not carrying convex id).
MOBILE FIXES (in zip, need EAS CLI build):
- languages.tsx: single canonical updateProfile({selectedLanguages}) — removed dead fallback mutations.
- scheduled.tsx: useSafeConvexQuery(scheduling.getAllMyScheduledMessages) → conversationNameById map → displayRecipient() (fixes 'Unknown').
- contacts.tsx: unconditional getOrCreateReferralCode on mount (was gated on profile query resolving).
- notificationChannels.ts: creates ALL backend-target fallback channels (calls-v4-smilers_never_cry, legacy 'calls', messages-v4-message_notification, legacy 'messages-v3') — Android drops pushes aimed at non-existent channels.
- useEmergentPush.ts: reportConvexUserIdForPush() exported setter + effectiveConvexUserId (query OR reported); chat screen reports me._id → guarantees convex_user_id reaches backend.
BACKEND (preview; next redeploy ships): push-debug tokens now include call_channel_id/message_channel_id.
ZIP regenerated 22:45 WITH EXPO_PUBLIC_BACKEND_URL=https://app-migration-75.emergent.host (production) — CRITICAL: EAS build must target deployed backend because Convex posts there. Workspace .env stays preview for dev.
TESTS: 41/41 pytest; tsc/eslint clean on touched files.
ARCHITECTURE NOTE: production topology = APK (deployed URL) + Convex→deployed + deployed FastAPI w/ FCM. Preview pod = dev only.
NEXT: user EAS CLI build from zip → install both phones → test killed-app ring/messages, screen share (server fixed), languages save, scheduled names, referral in invite. If FCM success but still nothing visible: check Samsung Settings→Apps→Smilers→Notifications categories.


---

## iter-212 — Pre-Play-Store P0 bug fixes (4 surgical, no scope creep)

Fixed in this fork per user's explicit priority list:

1. **Chat photo "no send button"** (P0) — gallery picks no longer auto-send.
   They now stage into a preview bar above the composer (thumbnail + remove X +
   "Add a caption, then tap send"); the **Send** button appears even with empty
   text and drives the upload (caption = composer text). On failure the staged
   image is restored for retry. Camera capture keeps its own in-modal preview/send.
   Files: `app/chat/[conversationId].tsx` (`pendingImage` state, `pickPhoto`,
   `handleSend`, `sendImageFromUri` now returns boolean, composer preview UI).

2. **Twilio call doesn't end on the other side** — added backend
   `POST /api/twilio/end-call` → completes the room
   (`rest.video.v1.rooms(sid).update(status="completed")`), resolving unique_name
   → sid, idempotent on already-completed/404. Wired into `handleHangup`
   (twilio-call.tsx) AND the push **decline** branch (usePushNotifications.ts) so
   both "caller hangs up" and "callee declines" force-end the room.
   Curl-verified: 400 w/o room, 200 idempotent for nonexistent room.

3. **Image download "Couldn't open file"** — root cause: E2EE chats serve
   AES-GCM CIPHERTEXT at the storage URL; the download helper re-fetched that and
   saved unreadable bytes. Fix: `saveMessageMediaToGallery` now accepts a
   `localUri` (the renderer's already-decrypted `data:`/`file://` src) and saves
   THAT (data: → decoded to cache file). ImageViewer passes its decrypted `uri`.
   Files: `src/lib/messageMedia.ts`, `src/components/MediaBubble.tsx`.

4. **My Recordings missing download/delete** — added Download (video → gallery
   via MediaLibrary; audio → share sheet) + Delete (confirm dialog) icons per row.
   Delete probes likely Convex mutation names (see
   `WEB_AGENT_REQUESTS_iter212_recordings_delete.md`) with graceful fallback.
   File: `app/my-recordings.tsx`.

**Verification status:** #2 backend curl-verified. #1/#3/#4 compile clean
(babel-transform OK) but need a **native build + authenticated device** for full
2-phone / E2EE / gallery verification (OIDC Google login blocks automated e2e).
Deferred (per user): ringtone-as-message-tone + missing `[FCM]` diagnostic events
on receiver (needs separate investigation); screen-share remote tile + screen
wake (freelance native engineer).


---

## iter-213 — Recording delete pinned + Archived Chats sync (native ↔ web)

**Recording delete** pinned to the confirmed canonical mutation
`api.callRecording.deleteRecording({ recordingId })` (fallback probing removed) —
`app/my-recordings.tsx`.

**Archived Chats sync** against the shared Convex backend (`api.archives.*`,
confirmed by web team):
- Read: `archives.getArchivedIds({})` (id set, used to filter main list) +
  `archives.listArchived({})` (full rows for the Archived screen).
- Write: `archives.archiveConversation({ conversationId })` /
  `archives.unarchiveConversation({ conversationId })` — both void + idempotent.
- `app/(tabs)/chats.tsx`: filter archived out of the main list (listConversations
  does NOT exclude them — matches web client-side filtering); **swipe-left**
  reveals an Archive button (react-native-gesture-handler `Swipeable`); an
  **"Archived · N chats"** pinned row sits directly below Chat Once and is shown
  ONLY when count > 0 (matches web).
- `app/archived.tsx`: now uses the real `archives.listArchived`, adds a per-row
  **Unarchive** button (`archive-arrow-up-outline`), updated empty-state copy.
- Per-user scope; no auto-unarchive on new message (matches web). State syncs
  reactively across web/mobile via Convex.

Verified: all changed files babel-transform clean; app bundles + renders Sign In
(smoke). Authenticated archive flow needs a real device (OIDC Google blocks
automated e2e). Contract Q&A: `WEB_AGENT_REQUESTS_iter213_archived_chats_sync.md`.

---

## iter-214 — Call-notification trio (#1 ringtone, #3 missed-call, #4 persistence) ROOT-CAUSE (no code change)

Full end-to-end trace done. Findings:
- Channel-routing code is CORRECT by inspection: Twilio call push has
  `type:"call"` → `_resolve_android_channel` returns the device's versioned
  call channel (`calls-v4-<sound>`, default `smilers_never_cry`) → passed to
  `fcm_send_v1` as `android_channel_id`. Call channels carry a RING sound, not
  the message tone.
- The call FCM carries a `notification` block (title/body) AND data. On a
  KILLED app, Android AUTO-DISPLAYS the notification itself → the rich
  `notifeeCallWake` path (ringtone loop + Answer/Decline + ongoing + missed-call
  transform) NEVER runs (matches previous agent's "no [FCM]/WAKE events on
  receiver"). So #1/#3/#4 share ONE cause: the OS renders the call, not notifee.
- Proper fix = send call pushes DATA-ONLY + render via a reliable killed-app
  background handler (notifee/@react-native-firebase). That is the EXACT path
  that catastrophically regressed in iter-202 (all push died). It cannot be
  verified in the cloud env (killed-app FCM needs a real device build).
- The residual "message tone" is runtime/data (which channel actually rendered /
  what `call_channel_id` the device registered) — needs ONE device diagnostic to
  pin; not statically visible.

DECISION: do NOT blind-edit the fragile push delivery path (regression risk =
exactly what burned us in iter-202). Trio deferred to a device-in-hand session
where each change is immediately testable against the WAKE/[FCM] diagnostic
stream. Items #5 (recordings), #6 (photo download), #2 (call-end) already fixed.

---

## iter-215 — Multi-photo album send with per-image captions (chat composer)

Extended the staged image-preview (iter-212) to N photos:
- `pickPhoto` now uses `allowsMultipleSelection` (limit 10); picks stage into
  `pendingImages[]` (each `{uri, mimeType, caption}`); first inherits any typed text.
- Preview shows a horizontal **thumbnail strip** (active highlighted, per-thumb
  remove ×, blue dot = has caption). Tap a thumb to select; the composer input
  edits THAT image's caption (`setActiveCaption`); placeholder → "Add a caption…".
- `handleSend` uploads each image with its own caption sequentially; failures are
  restored to the strip for retry. Single-photo behaviour is unchanged (length 1).
- `sendImageFromUri` gained an optional `captionOverride`. Added `ScrollView` import.
- Verified: babel-transform clean, app bundles + renders Sign-In (smoke). Needs
  device verification (authenticated chat behind OIDC). No backend changes.

---

## iter-216 — Post-test fixes: receiver call-screen, archived UX, schedule edit

1. **Call lingered on receiver screen** (`app/twilio-call.tsx`): the receiver was
   never navigated away when the room ended remotely. Added a guarded auto-close
   effect — once the session reaches a terminal state ('disconnected'/'failed')
   AFTER having been active, the screen pops. `handleHangup` now uses the same
   guarded `closeScreen` (no double-nav).
2. **Archived UX** (`app/(tabs)/chats.tsx`, `app/archived.tsx`):
   - Full left-swipe now AUTO-archives (web parity) via `onSwipeableOpen` — no
     tap needed (the action button was also hidden behind the right-edge floating
     quick-action buttons).
   - Archived rows showed "Chat" instead of the contact name. New `ArchivedRow`
     component resolves the name the same way the main list does (device address
     book → saved contact → Smilers name) + avatar photo.
3. **Schedule edit missing Yearly** (`app/scheduled.tsx`): extended `Repeat` to
   include `hourly` + `yearly` (parity with the create sheet's frequencies);
   updated REPEAT_LABEL/REPEAT_OPTIONS and the draft→repeat passthrough. Also
   fixes blank labels for existing hourly/yearly schedules in the list.

Verified: all four touched files babel-transform clean; app bundles + renders
Sign-In (smoke). Needs device verification (authenticated flows behind OIDC).
Backend `repeat: 'yearly'/'hourly'` assumed supported by Convex (web edit already
offers Yearly → shared backend).

---

## iter-233 — 4-colour delivery dots (real component) + Offline Outbox

**Problem found:** the prior fork edited `src/components/chat/MessageBubble.tsx`,
but that `MessageBubble` is DEAD CODE — the chat timeline renders
`src/components/MediaBubble.tsx`. MediaBubble still had the old 3-colour mapping
(Blue/Yellow/Green, no RED, and GREEN/YELLOW swapped vs the web contract).

**Fixes:**
1. **MediaBubble.tsx** — status dot now evaluated top-down per the web
   `native-message-delivery-status-contract`: RED (`__outbox`/`__failed`) →
   BLUE (`readBy.length>0` excl. sender) → GREEN (`deliveredTo.length>0` excl.
   sender) → YELLOW (on server, no delivery yet). Group chats use ANY-recipient
   `.length>0`.
2. **NEW `src/lib/outbox.ts`** — AsyncStorage per-conversation queue
   (`smilers:outbox:v1:<id>`): load/enqueue/remove/markFailed for plain-text only.
3. **`app/chat/[conversationId].tsx`**:
   - Fresh text send that FAILS (offline/Convex unreachable) is queued to the
     outbox and rendered immediately in the timeline with a RED dot (no Alert).
     Edits and media keep the old "not sent" alert (not queued).
   - `flushOutbox()` auto-sends the queue on NetInfo reconnect + AppState
     'active' + on mount. Tap / long-press a RED message also retries.
   - Outbox entries merged into the `timeline` memo; swipe-to-reply disabled for
     them (no server id yet).
   - Installed `@react-native-community/netinfo` (11.4.1).

Verified: lint clean on changed files; bundle compiles; app renders Sign-In
(smoke). End-to-end offline behaviour needs device/build verification (auth is
Google OIDC + requires real network toggling — not exercisable in web preview).

---

## iter-234 — Offline read access to old messages (BUG FIX)

**Reported:** previous agent claimed offline message access worked; it never did.

**Root cause (`app/chat/[conversationId].tsx`):** the render gate was
`{conversationLoading || messagesLoading ? <spinner> : ...}`. When offline the
Convex `messages.list` query stays `undefined` forever → `messagesLoading`
stayed `true` → the screen showed "Taking longer than usual"/spinner and NEVER
rendered the FlatList, even though `cachedMessages` (iter-164 AsyncStorage cache)
were available. The conversation object + `me` were also `undefined` offline, so
the header showed "Loading…" and `isConversationAvailable` was false (composer
disabled, outbox couldn't trigger).

**Fix:**
- Cache the conversation object per-id (`chat-conversation` scope) when it
  resolves; read it back offline. Read cached `me` (`me`/`self` scope, already
  written by the Chats tab). Added `effectiveConversation = conversation ??
  cachedConversation` and `effectiveMe = me ?? cachedMe`.
- `hydratedConversation`, `isConversationAvailable`, header title, and the
  message `isMine`/`myUserId` now use the effective (cache-fallback) values.
- Render gate now bypasses the loading spinner when `hasCachedTimeline` (cached
  messages exist) → the FlatList renders cached history offline.

Result: opening a previously-synced chat while offline shows the full cached
timeline, correct sender alignment, and the contact name in the header. (Only
in-flight/undelivered incoming server messages aren't shown until reconnect, as
expected.) Lint clean; bundle compiles; Sign-In renders (smoke). Needs device
verification with real airplane-mode toggling.

---

## iter-235 — Post-test fixes (3 user-reported items)

1. **Call auto-switch to conference (Issue 1).** Root cause: the other party's
   `triggerMeshUpgrade` deferred navigation with
   `InteractionManager.runAfterInteractions(...)`. The call screen runs
   continuous animations (CallBackground orbs / ringing pulse) which keep an
   interaction handle open, so the queued `router.replace` never fired until
   the user tapped something (e.g. End). Fix (`app/call/[conversationId].tsx`):
   `triggerMeshUpgrade({ fromModal })` — initiator closes the picker <Modal>
   then `setTimeout(replace, 350)`; the other party navigates immediately via
   `setTimeout(replace, 0)` with NO InteractionManager. Removed the now-unused
   InteractionManager import.

2. **Green "delivered" dot never showed (Issue 2).** Root cause: `markDelivered`
   and `markRead` both fired only when the recipient OPENED the chat → jumped
   straight to BLUE; GREEN was never observable. Fix (`app/(tabs)/chats.tsx`):
   from the chats list, call `api.messages.markDelivered({conversationId})` for
   each conversation whenever its `lastMessageTime` changes (live/online only,
   deduped via a ref). Now the sender sees GREEN once the recipient's app syncs
   the list, then BLUE when they open the chat. (markDelivered excludes the
   sender, so own-conversation calls are no-ops.)

3. **Offline message vanished instead of showing as not-sent (Issue 3).** Root
   cause: Convex mutations DON'T reject when offline — `await sendMessage(...)`
   just hangs until reconnect, so the try/catch outbox-enqueue never ran and the
   message disappeared from the UI until reconnect. Fix
   (`app/chat/[conversationId].tsx`): in `handleSend`, when `isOffline`, enqueue
   to the outbox immediately (RED dot, WhatsApp-style pending) and skip the
   hanging mutation; auto-sends on reconnect. (Avoids duplicates since the
   mutation is never queued by Convex.)

Lint clean on all changed files; bundle compiles; Sign-In renders (smoke).
Needs two-device verification with airplane-mode toggling.

---

## iter-236 — Two remaining post-test issues (delivered dot + auto-switch)

**Issue 2 — green "delivered" still not showing.** The iter-235 chats-list
markDelivered only ran while the Chats tab was mounted; if the recipient was on
another screen (or the tab unmounted) delivered was never set, so yellow kept
"double duty". The push received-listener only fires in the FOREGROUND and the
background task can't run a Convex mutation. Fix: NEW global hook
`src/hooks/useDeliveryReceipts.ts`, mounted in `app/_layout.tsx`
(PresenceHeartbeat — inside Convex+Auth, runs on EVERY authenticated screen,
mirrors the web client's always-on subscription). It watches
`listConversations` and calls `messages.markDelivered({conversationId})` when a
conversation's lastMessageTime advances. Removed the chats-tab duplicate.

**Issue 1 — conference auto-switch still required tapping End.** Removing
InteractionManager (iter-235) wasn't enough — the receiver's trigger
(`activeCall.isConference` / `getCallInvites`) wasn't firing reliably
(getCallInvites likely filters to invites addressed to the current user, and
isConference may not echo promptly). Added a RELIABLE cross-device trigger in
`app/call/[conversationId].tsx`: subscribe to
`conference.getParticipants({callId})` — the initiator calls `joinConference`
the instant they enter the mesh host, so the roster becomes non-empty on the
other party's device. The upgrade watcher now fires on isConference OR invite OR
roster>0. Navigation: initiator `setTimeout(350)` after closing the modal; the
other party uses `requestAnimationFrame → setTimeout(0)`. Added `__DEV__`
console.logs at the watcher + triggerMeshUpgrade entry + router.replace for
field diagnosis.

Lint clean on changed files (pre-existing require/import warnings only); bundle
compiles; Sign-In renders. Needs two-device verification.

---

## iter-237 — Match web delivery dots + remove risky global hook + triage regressions

USER feedback: web app itself shows GREEN for both sent & delivered and never
shows yellow; also reported NEW regressions: photo attach stuck, delete-for-
everyone not propagating to receiver / not corrupting.

1. **Delivery dots → match web exactly** (`MediaBubble.tsx`): RED (outbox) →
   BLUE (readBy>0, excl sender) → GREEN (on server). Removed YELLOW and the
   delivered/read distinction entirely (green now appears as soon as the
   message is on the server, exactly like web).
2. **Removed `useDeliveryReceipts` global hook** (+ deleted the file, unmounted
   from `_layout.tsx`). It is no longer needed (green = on-server) and it was
   firing `markDelivered` mutations for EVERY conversation on every list update
   — a plausible source of Convex client backpressure / the new instability.
   Also removed the chats-tab variant earlier.
3. **Regression triage (NOT changed — backend/shared-Convex coupled):**
   - Photo attach: send path (`sendImageFromUri`/`uploadFile`) is untouched and
     uses the same Convex storage that working text uses. Suspect stale bundle
     or the removed global hook interfering. Needs clean reload + device logs.
   - Delete-for-everyone: `performDelete` already silently FALLS BACK to
     `deleteMessage({messageId})` (= delete-for-me) when `{mode:'everyone'}`
     throws (iter-97). The cross-device delete propagation + "corrupt on
     receiver" are BACKEND (shared Convex `messages.deleteMessage`) features —
     if the web team changed that schema, mobile's `mode:'everyone'` may now be
     rejected → silent delete-for-me. Requires backend/web-team confirmation.

Bundle compiles; Sign-In renders. Asked user to do a CLEAN reload and re-test
photo + delete; the removed global hook may have been the destabiliser.

---

## iter-238 — Delete-for-everyone/receiver: probe correct backend signature

USER: delete-for-everyone/receiver work on WEB (tombstone "This message was
deleted" shown) but NOT on mobile. Root cause: mobile sent
`deleteMessage({messageId, mode:'everyone'})`; the shared Convex backend (which
the web app uses successfully) validates args strictly and rejects that shape,
so the old code silently fell back to `deleteMessage({messageId})` = delete-for-
ME only → message gone for sender, still on receiver.

Fix (`performDelete` in chat): probe the realistic Convex signatures and use
whichever the backend ACCEPTS (strict validation makes wrong shapes throw
safely, so no accidental wrong-delete):
  everyone → tries forEveryone:true, deleteFor:'everyone', scope, deleteType,
             mode, then deleteMessageForEveryone()/deleteForEveryone().
  receiver → tries deleteFor/scope/deleteType/mode:'receiver'.
  me       → deleteFor:'me' / mode:'me' / deleteForMe() / bare {messageId}.
CRUCIALLY removed the silent bare-{messageId} fallback for everyone/receiver
(that was the delete-for-me masking). `__DEV__` logs which signature succeeded.

NOTE: exact web signature unknown (Convex backend lives in web repo; mobile uses
anyApi). If the probe still misses, need the web team's `messages.deleteMessage`
arg schema to lock it in. File-corruption-on-receiver is a separate backend
feature.

Lint clean; bundle compiles.

---

## iter-239 — Root-caused 3 issues from the WEB BUNDLE (definitive)

Inspected the deployed web bundle (smilers-app.onhercules.app/assets/index-*.js)
to get EXACT signatures instead of guessing.

1. **Delete for everyone/receiver** — web uses:
   `messages.deleteMessage({ messageId, forEveryone: true })` (everyone),
   `messages.deleteMessage({ messageId, forReceiver: true })` (receiver),
   `messages.deleteMessage({ messageId, forEveryone: false })` (me),
   `messages.requestDeletion({ messageId })` (request).
   Mobile was sending `{mode:'everyone'}` → strict-validation reject → silent
   delete-for-me. Rewrote `performDelete` + the media auto-purge to the exact
   web args. Removed the silent fallback.

2. **Delivery dots** — web logic (chat/page.tsx:3205-3208) is:
   read→`bg-blue-500`, else delivered→`bg-green-500`, else→`bg-yellow-500`.
   So my iter-237 "green=sent, no yellow" was WRONG. Restored proper 4-state in
   MediaBubble: RED(outbox)→BLUE(read)→GREEN(delivered)→YELLOW(sent).
   Re-added the global delivery hook as an EXACT port of the web's `Ure()`
   component: subscribe `messages.getUnreadCounts`, and call
   `markDelivered({conversationId})` whenever a conversation's unread count
   INCREASES. Mounted in _layout (PresenceHeartbeat). This populates
   `deliveredTo` so the sender actually sees green (was stuck on yellow).

3. **Photo attach stuck** — web image send includes `mimeType` (+fileName,
   fileSize); the mobile VIDEO send already sends `mimeType` (works) but the
   IMAGE send omitted it. Backend `messages.send` requires `mimeType` for media
   → image send rejected → "Upload failed" / photo stayed in composer. Added
   `mimeType` to `sendImageFromUri`'s send (matches web + the working video path).

Lint clean on changed files (pre-existing MediaBubble rules-of-hooks + _layout
require-style warnings only); bundle compiles; Sign-In renders.

---

## iter-240 — Media metadata, deletion-request prompt, delivered fix, conf logs

Verified all contracts against the deployed web bundle (smilers-app.onhercules.app).

1. **Photo attach stuck + video sends bad metadata** — web `messages.send`
   includes fileName + fileSize + mimeType for ALL media. Mobile image send
   omitted fileName/fileSize (and previously mimeType); video sends omitted
   fileName/fileSize. Added a `getMediaMeta(uri,mime,base)` helper
   (expo-file-system getInfoAsync) and now send fileName+fileSize+mimeType on
   image + both video paths. This is why photos stayed stuck in the composer
   and the deleted video left a broken frame (bad metadata → couldn't render).

2. **"Ask sender to delete" prompt (NEW feature)** — web uses
   `getPendingDeletionRequests({})` + `respondToDeletionRequest({requestId:_id,
   accept})`. Added a red in-chat banner (Decline / Delete) shown to the
   message owner, scoped to the conversation when the request carries
   conversationId.

3. **Green delivered dot** — removed the in-chat markDelivered (it fired with
   markRead on open → yellow skipped straight to blue). Delivery is now marked
   only by the global useDeliveryReceipts hook (getUnreadCounts increase),
   exactly like web's Ure() component.

4. **Conference auto-switch diagnostics (Step 1)** — the watcher now reads and
   logs `error` from getCallInvites + getParticipants safe-queries so a real
   device build's Metro logs show whether those backend fns error
   (CouldNotFindFunction) vs return empty. NOTE: mesh/group-call is native-only
   and won't populate the roster in Expo Go — must test on an EAS build.

Lint clean; bundle compiles; Sign-In renders. Most of these need a real device
build (Expo Go can't run mesh; push is dead in Expo Go).

## iter-241 — "No chats yet" lockout + per-user delete tombstone (isDeleted)

1. **"No chats yet" lockout (only reinstall fixed it)** — `chats.tsx` did
   `list = liveList ?? cachedList ?? []`, so when `listConversations` resolved
   to an EMPTY array (transient during Convex re-auth / stale SecureStore
   identity) the UI showed empty AND `writeCache` overwrote the good cache with
   `[]` — persisting the lockout (APK update kept storage; only reinstall
   cleared it). Fixes: prefer live ONLY when it has rows, else fall back to
   cached; guard writeCache to never clobber a non-empty cache with `[]`; and
   when live==empty but cache has rows, force ONE Convex reconnect to recover.
   (Root cause is a backend/auth session glitch returning empty — this makes
   the app self-heal instead of requiring reinstall.)

2. **Delete tombstone for me/receiver + video** — the web uses a unified
   `isDeleted` boolean (set per-viewer for forReceiver:true / forEveryone:false,
   globally for forEveryone:true). Mobile only checked `deletedAt`, so per-user
   deletes (and some media deletes) never showed "This message was deleted".
   MediaBubble now renders the tombstone for `deletedAt || isDeleted===true`.

Lint clean (pre-existing MediaBubble rules-of-hooks + chats dup-import warnings
only); bundle compiles; Sign-In renders.

## iter-242 — WebRTC signaling race fixes (from device call log)

CallSession.ts (native 1:1 engine):
1. **"handle answer failed: Called in wrong state: stable"** — two answers
   arrived back-to-back; the first connected (→stable), the second tried
   setRemoteDescription(answer) in stable state and threw. Fix: handleRemoteAnswer
   now skips any answer when signalingState is not 'have-local-offer'/
   'have-remote-pranswer', and marks lastAppliedAnswerPayload BEFORE the await so
   a concurrent identical answer is caught by the dup guard.
2. **"handleRemoteOffer: pc is null" / "Peer connection not initialized"** — on
   answering, the offer raced ahead of pc construction and was thrown away. Fix:
   handleRemoteOffer now stashes the early offer (pendingOfferPayload) instead of
   throwing; the pc-creation path replays it the moment the pc exists.

Lint clean (pre-existing RTCSessionDescription unused-type warning only); bundle
compiles; Sign-In renders. Native-only — verify on EAS device build.

## iter-243 — text tombstone, gallery-video metadata, receiver media purge
- MessageBubble.tsx: tombstone now fires on deletedAt || isDeleted (text per-viewer delete).
- pickVideo (gallery) now sends fileName+fileSize via getMediaMeta (was missed; only recordVideo had it).
- MediaBubble receiver purge now triggers on isDeleted too (local file corruption on delete-for-everyone).
- Backend Server Errors noted (NOT mobile): conference:toggleSelfMute, messages:setTranscription — web-team Convex fns.
