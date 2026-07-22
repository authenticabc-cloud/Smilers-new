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

Phase 2b — Stream media UNDER normal 1:1 calls  ✅ DONE (code), ⏳ user APK test
- NEW screen: src/components/stream/StreamCallInner.tsx (+ Entry/.web split).
  Hybrid: Ashwini's FCM doorbell = ringing/wake-up/ringtone/Answer-Decline
  (unchanged); Convex `calls` lifecycle = call state (initiateCall on caller,
  answerCall on answer=1 callee, markCalleeRinging, endCall on hangup, and
  auto-end when Convex status→ended/declined or the Stream peer leaves); Stream
  = media (client.call('default', conversationId), getOrCreate ring:false
  notify:false, join). Uses useReactiveSafeConvexQuery for getActiveCall.
- GATE: src/components/call/CallHost.tsx now renders StreamCallInner for NORMAL
  1:1 (when !screenOnly && !conferenceMode); screen-share / conference still use
  legacy CallScreenInner. CallHost full/mini(PIP) wrapper applies to both.
- UI: ParticipantView (proven in 2a) + controls mic/cam/flip/minimize/hangup +
  timer + self-view. Styled dark to match a call context.
- KNOWN FOLLOW-UPS (next pass, agreed "core first"): caller ringback tone,
  in-call screen-share, interpreter overlay, call-waiting (2nd call). Audio route
  now handled by Stream — verify on device.
- FIX (user feedback #1): FOREGROUND incoming calls route to /call/<id> WITHOUT
  answer=1 (useIncomingCallListener, Twilio-off path), so StreamCallInner now
  shows in-app Accept/Decline and GATES the Stream join until accepted (was
  auto-connecting). answer=1 (notification Answer) still auto-joins immediately.
- OPEN (user feedback #2): after answering a KILLED-app call, connect takes a
  while — largely RN cold-start + Stream client/token init + SFU connect. This is
  the inherent tradeoff of ring:false + our own doorbell (vs Stream's native
  CallKit pre-connect, which we avoid to keep Ashwini's UI). To investigate:
  cache/warm Stream client, join({create:true}) single round-trip.

Phase 3 message fixes ✅ DONE (code), ⏳ user APK test (same build)
- TONE: bumped message channel v4→v5 everywhere (notifeeMessageDisplay,
  backgroundTaskSetup, usePushNotifications, notificationChannels) — Android
  locks a channel's sound after creation, so a fresh id restores the Smilers tone.
- NAME: chats.tsx proactively caches EVERY 1:1 device-contact name; 1:1 push
  always uses the resolved contact name as title; grouped notif no longer reuses
  a stale account-name title. MSG-NAME diagnostic logs resolution.

Phase 4 — Group-message distinct tone  ✅ DONE (code), ⏳ backend redeploy + APK test
- Tone file: android/app/src/main/res/raw/group_notification.mp3 (user-provided).
- notifeeMessageDisplay.ts: new GROUP_CHANNEL_ID 'groups-v4-group_notification'
  (sound 'group_notification', importance HIGH). displayGroupedMessageNotification
  detects group via data.conversationType==='group' || channelId startsWith
  'groups-' and renders on the group channel/tone; 1:1 stays on messages-v5.
- server.py: now forwards channelId / conversationType / conversationName in the
  FCM data so the app can pick the group channel.
- NOTE: iOS group tone NOT wired (Android per contract).

### ⚠️ BLOCKER for ALL message-notification fixes (1:1 name+tone, group tone)
The DEPLOYED backend (app-migration-75.emergent.host) is STALE and still sends a
`notification` block for messages → Android renders it directly (server profile
name + default tone), bypassing the app. Evidence: notification body showed the
MESSAGE TEXT ("Buongiorno"), which the app-rendered path never does (shows sender
name). FIX = user must REPUBLISH so server.py's data-only-message code (and the
new group-field forwarding) deploy. Only then does the app render → correct
contact name + Smilers tone + group tone. APK already has all frontend fixes.

### Phase 2 — Stream media under the answered call (SUPERSEDED by 2b above)
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

### Phase 3 — Message notifications
UPDATE (user finding): the "duplicate" was NOT a native bug — the WEB app (open
in a browser) AND the native app both rendered a notification. Web showed the
device-contact name; native showed the Google/account name. Deactivating web
notifications leaves ONE native notification, but with the wrong (account) name.

Phase 3a — device-contact name in native msg notifications  ✅ DONE (code), ⏳ user APK test
- ROOT CAUSE: ConversationRow caches the device-contact name ONLY for rows the
  virtualized list actually rendered → off-screen / brand-new conversations were
  never cached, so the headless push fell back to the account name.
- FIX: app/(tabs)/chats.tsx now proactively caches EVERY 1:1 conversation's
  device-contact name (getResolvedConversationDisplayName over the full
  conversations array + device contact index), re-running when the index loads.
- DIAGNOSTIC: backgroundTaskSetup.ts logs tag MSG-NAME (convId, cachedConvName,
  senderPhone, account) so on-device Diagnostic Logs reveal any remaining miss.

Phase 3b — custom message TONE (universal beep instead of Smilers tone) — PENDING
Likely Android channel immutability: 'messages-v4-message_notification' may have
been created earlier without the custom sound. If still wrong after 3a build,
bump to a fresh channel id (…-v5-…). Awaiting user re-verification (with web
notifications OFF).

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
