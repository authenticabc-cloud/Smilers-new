# Stream Video Migration — Tracking Doc

## ⚠️ PIVOT (2026-07-21): Option B — HYBRID (user-approved)
User feedback after the Phase-1b APK test: Stream's `ring:true` outgoing calls
BYPASSED Ashwini's native incoming-call experience (full-screen wake-up screen,
custom ringtone, Answer/Decline via SmilersCallNotificationService) — calls rang
with the plain message tone and no wake-up screen. Ashwini's native code is fully
intact, it was just no longer being triggered.

Decision → **HYBRID**: keep Ashwini's FCM "doorbell" (ringing/wake-up/ringtone/
Answer-Decline + message notifications) UNCHANGED, and use Stream ONLY for the
media/connection layer (the actual reliability fix). Both parties join the SAME
Stream call keyed to `conversationId` with `ring:false, notify:false`.

### Phase 1 — Restore Ashwini's doorbell + disable Stream ringing  ✅ DONE (code), ⏳ user APK test
- chat/[conversationId].tsx: removed the `startStreamCall` (ring:true) short-circuit
  on the voice + video buttons → calls go through legacy `startCall` again
  (→ /api/calls/ring → SmilersCallNotificationService). Removed streamCallActions import.
- src/components/stream/RingingOverlay.tsx: now a PASSTHROUGH — no setStreamPushConfig,
  no registerStreamDevice, no RingingCallContent/CallContent overlay. Stream sends NO
  ringing push and shows NO UI. (Stale device reg from prev build is harmless since no
  ring:true call is ever created.)
- Web bundle smoke-tested OK. NEXT: user builds APK, confirms Ashwini's calls fully back.

### Phase 2 — Stream media under the answered call (IN PROGRESS)
Approach chosen with user: 🅱 new Stream 1:1 screen; carry over interpreter,
call-waiting, screen-share, PIP as best possible. Since the whole thing is
native-only and the production call screen is ~3400 lines, we FIRST validate the
Stream connection core in isolation (like Phase 1), then integrate.

Phase 2a — ISOLATED Stream connection test screen  ✅ DONE (code), ⏳ user APK test
- src/components/stream/StreamTestCall.tsx — native Stream 1:1 test using the
  playbook pattern: client.call('default', <roomCode>), getOrCreate({ring:false,
  notify:false}), join(); custom UI via StreamCall + useCallStateHooks +
  ParticipantView; controls: mic/camera/flip/hangup + timer + remote-left end.
- Component-level platform split (StreamTestCallEntry.tsx / .web.tsx) keeps the
  Stream SDK out of the web bundle. Route: app/stream-call-test.tsx (no platform
  ext, per expo-router). Web shows a "native only" notice.
  NOTE: route-level .web.tsx split BROKE web bundling (expo-router needs a
  no-platform fallback AND the native fallback pulled the SDK into web) — fixed
  by splitting at the component level instead. Home renders OK now.
- Entry point: Settings → Call Diagnostics → "Test Stream connection (1:1)".
- NEXT (Phase 2b, after user confirms 2a connects on device): wire Stream media
  into app/call/[conversationId].tsx for regular 1:1 (join call('default',
  conversationId), ring:false), keeping Convex lifecycle (initiate/answer/end/
  decline/reachability/ringback), and re-add PIP/screen-share/interpreter/
  call-waiting. Both caller & callee already land on /call/<conversationId>.

### Phase 3 — Message notification duplicate + wrong tone (PENDING, bundle w/ 2b)
Investigated: message bg render path = presentBackgroundLocalNotification
(backgroundTaskSetup.ts) → notifee grouped (notifeeMessageDisplay) else expo
channel 'messages-v4-message_notification' sound 'message_notification'.
Suspects: (1) Android channel immutability — if the channel id was first created
without/with a different sound, the custom tone never applies (need a NEW channel
id). (2) duplicate = notifee grouped AND expo/FCM auto-display both firing, or
foreground+background both rendering. NEEDS device logcat to confirm before fix.

---
## (Original) Option A plan below — superseded by the hybrid pivot above

Goal: replace the custom WebRTC + Convex-signaling + FCM call stack with GetStream
Video for WhatsApp-grade native ringing (CallKit iOS / ConnectionService Android),
reliable even when the app is killed.

## Credentials (in backend/.env)
- STREAM_API_KEY = sf6v64y8z2q7
- STREAM_API_SECRET = (set, server-only)
- Android push provider name (Stream dashboard): `firebase-video-production`

## Key architectural decisions
- **Push: use `expo-notifications`, NOT `@react-native-firebase`.** Stream supports this
  via `enableNonRingingPushNotifications` + `getDevicePushTokenAsync()` + `client.addDevice()`.
  → The custom `SmilersCallNotificationService` + notifee **message** notifications STAY.
  Message notifications are NOT affected by this migration.
- **WebRTC: hard swap.** `@stream-io/react-native-webrtc` cannot coexist with
  `react-native-webrtc`. Removing the latter breaks ALL current call code until migrated.

## Phase 1a — Backend token endpoint  ✅ DONE + TESTED
- `POST /api/stream/token` mints HS256 Stream JWT (4h TTL). Verified locally.
- Added to health critical-routes list.

## Phase 1b — Frontend 1:1 calling (Android) — IN PROGRESS
DONE (verified: app still builds + loads on web preview):
- ✅ Destructive package swap: removed `react-native-webrtc`, installed
  `@stream-io/react-native-webrtc@145` + `@stream-io/video-react-native-sdk@1.41`.
  Swapped the 4 runtime import strings (CallSession.ts, RTCViewWrapper.ts,
  mesh/MeshController.ts, mesh/MeshPeer.ts) to the fork — legacy call code keeps
  working on the API-compatible fork.
- ✅ Stream config plugin auto-added to app.json.
- ✅ streamClient.ts SDK import made LAZY (dynamic) so web-safe helpers
  (cacheStreamIdentity) don't bundle the SDK on web.
- ✅ Root wiring in app/_layout.tsx (DeviceContactBridge): caches Stream identity
  (me._id + name) on login; mounts <StreamCallProvider> (native-only via
  RingingOverlay.web.tsx passthrough so web preview stays clean).

REMAINING (build-only, needs device iterations):
- ✅ Outgoing 1:1 calls routed through Stream (chat voice+video buttons, native
  only, legacy fallback) — DONE.
- ✅ Ringing + in-call UI (RingingCallContent + CallContent) at root — DONE.
- ✅ Incoming Stream push routed via FCM background handler (lazy, native) — DONE.
- ✅ Android native permissions: added MANAGE_OWN_CALLS + READ_PHONE_STATE; the
  rest (FOREGROUND_SERVICE_*, USE_FULL_SCREEN_INTENT, POST_NOTIFICATIONS,
  BLUETOOTH_CONNECT) already present from the callkeep setup. minSdk=24 OK.
  Stream's ConnectionService/receivers auto-merge from the AAR. — DONE.
- ⏳ FIRST ANDROID BUILD: validate the WebRTC-fork swap compiles + autolinks in
  the committed android/ project; watch for callkeep-vs-Stream ConnectionService
  or manifest-merger conflicts; confirm Stream client connects (token) and an
  outgoing call rings. Iterate from build errors.
- ⏳ iOS (Phase 2): CallKit + APN VoIP provider + entitlements/Podfile.
- ⏳ Group/conference/screen migration to Stream (Phase 3).
- ⏳ `expo export` (EAS Update) may need a patch for @stream-io/react-native-webrtc.

## Phase 2 — iOS CallKit (needs APN VoIP provider in Stream dashboard)

## Phase 3 — Migrate remaining WebRTC consumers (or drop if unused):
react-native-webrtc is imported by 13 files:
- 1:1: app/call/[conversationId].tsx, src/components/call/CallHost.tsx, src/lib/call/handoff.ts
- group/conference: app/group-call/[...], app/conference/[...]/room.tsx,
  src/lib/call/mesh/{useConferenceMesh,MeshController,MeshPeer}.ts
- screen-share: src/components/ScreenShareOverlay.tsx
- twilio path: src/lib/twilio/startCall.ts, app/twilio-call.tsx
- misc: app/call-audio.tsx, app/_layout.tsx
ACTION NEEDED: confirm whether group calls / conference / screen-share are in active use.
If not, drop them (delete/stub) instead of migrating to reduce scope drastically.

## Testing
- Build-only (dev build / APK). Not testable in Expo Go or web preview.
- Expect 3–5 build/test iterations for Phase 1b.

## Safety
- Message notifications: SAFE (expo-notifications path, custom FCM service untouched).
- Existing calls: REPLACED by Stream (intentional — that's the fix).
