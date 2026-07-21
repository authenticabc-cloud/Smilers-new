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

## Phase 1b — Frontend 1:1 calling (Android) — NEXT (build-only, iterative)
Destructive swap — do together, then iterate on device builds:
1. `yarn remove react-native-webrtc` ; `npx expo install @stream-io/video-react-native-sdk
   @stream-io/react-native-webrtc @config-plugins/react-native-webrtc react-native-svg
   @react-native-community/netinfo expo-build-properties`
2. app.json plugins: `@stream-io/video-react-native-sdk` (enableNonRingingPushNotifications:true),
   `@config-plugins/react-native-webrtc`, `expo-build-properties`.
3. New files:
   - `src/lib/stream/streamClient.ts` — getOrCreateInstance, tokenProvider → /api/stream/token
   - `src/lib/stream/streamPush.ts` — setPushConfig (isExpo:true, android provider name),
     device token registration via expo-notifications getDevicePushTokenAsync + client.addDevice
   - `src/components/stream/RingingOverlay.tsx` — useCalls() ringing → RingingCallContent
4. Wire client + RingingOverlay at app root (`app/_layout.tsx`).
5. Route OUTGOING 1:1 calls through Stream: `client.call('default', id).getOrCreate({ring:true,...})`.
6. Answer/Decline via call.join() / call.leave({reject:true}).

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
