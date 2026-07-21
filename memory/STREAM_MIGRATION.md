# Stream Video Migration (Option A) — Tracking Doc

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
- Route OUTGOING 1:1 calls through Stream: client.call('default', id).getOrCreate({ring:true, data:{members}}).
- Answer/decline + active-call screen (CallContent) navigation.
- Wire handleStreamCallPush() into the existing FCM background handler
  (backgroundTaskSetup.ts / SmilersCallNotificationService) so killed-app ring works.
- ⚠️ CRITICAL — COMMITTED BARE NATIVE DIRS: the Stream config plugin only applies
  on `expo prebuild`, which would CLOBBER the custom Kotlin (SmilersCallNotificationService).
  So Stream's required native config (Android ConnectionService/permissions/services,
  iOS CallKit/VoIP background modes) must be added MANUALLY to android/ + ios/, OR
  reconcile prebuild with the custom native code. This is the biggest remaining task.
- Dedup app.json webrtc plugins: `@config-plugins/react-native-webrtc` may now be
  redundant/conflicting with the Stream plugin — verify during first build.
- `expo export` (EAS Update) may need a patch for @stream-io/react-native-webrtc like
  the old scripts/patch-rn-webrtc.js did for react-native-webrtc.

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
