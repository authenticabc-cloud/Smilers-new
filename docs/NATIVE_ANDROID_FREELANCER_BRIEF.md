# Smilers — Native Android Freelancer Brief

**Stack:** Expo (managed, prebuild/EAS) React Native app. Calling is
**`react-native-webrtc` (P2P) + Convex** signaling. Push is **Firebase FCM v1**
(data-only for calls) + **Notifee** for the JS-rendered ring. **No Twilio.**

**Goal:** add a thin **native Android incoming-call layer** on top of the
existing Convex/WebRTC system, and resolve a **native screen-share black-frame**
issue. Do **NOT** rebuild calling — bridge into the existing JS flow.

App id: `com.smilers.app`. Targets Android 14–16. `react-native-webrtc@124.0.7`
(already the latest published version — no upgrade available).

---

## TASK 1 — Killed/force-stopped incoming-call ringing (P0)

### Problem (confirmed by device videos)
- App **backgrounded** → rings correctly (custom Smilers ringtone, full-screen Answer/Decline). ✅
- App **swiped away / force-stopped** → plays the **message tone**, plain banner, no Answer/Decline. ❌

The killed path currently relies on the React Native / Notifee **JS background
handler**, which the OS throttles/blocks when the app is force-stopped — so the
native ring never renders.

### Required implementation (additive — keep existing paths intact)
1. Native **`FirebaseMessagingService`** (via an Expo config plugin / `expo-build-properties` or a local plugin) to receive **data-only** FCM in any app state, including killed.
2. **Classify** the payload: it's a call when `data.type == "call"` (also carries `callId`, `conversationId`, `callType`, `callerName`, `displayName`). Everything else = message → **fall through to the existing notification path unchanged**.
3. Start a **native foreground service** for the call, `android:foregroundServiceType="phoneCall"` (+ keep the existing `mediaProjection` service untouched).
4. Present the incoming-call UI via **Android `ConnectionService` (`TelecomManager`)** / **CallKeep-style** — system incoming-call screen, lock-screen wake, custom ringtone, Answer/Decline. (react-native-callkeep or a custom ConnectionService.)
5. **Bridge Answer/Decline back into the existing JS flow:**
   - **Answer** → launch the RN activity and deep-link to **`/call/<conversationId>`** (the WebRTC call screen) so the existing Convex offer/answer/ICE flow runs.
   - **Decline** → call Convex `api.calls.declineCall({ callId })` (or POST the existing decline path) and dismiss.
6. **Preserve the message path** — normal messages must keep using the existing Notifee message channel + custom message tone. Do not cannibalize it. (A previous ConnectionService attempt broke message delivery — this is a hard requirement.)
7. iOS PushKit + CallKit is **out of scope for now** (phase 2).

### FCM call payload (already sent by backend, sanitized)
```jsonc
{ "data": {
    "type": "call", "callId": "...", "conversationId": "...",
    "callType": "voice|video", "callerName": "...", "displayName": "...",
    "title": "Incoming call", "action_url": "/call/<conversationId>"
  },
  "android": { "priority": "high", "ttl": "45s" }   // DATA-ONLY (no notification block)
}
```
Android call channel: `calls-v4-smilers_never_cry` (importance MAX, bypassDnd).

### Acceptance
Force-stop the app → place a call → native full-screen incoming-call UI with
Smilers ringtone + Answer/Decline; Answer opens the live WebRTC call; Decline
notifies the caller; **messages still arrive normally with the message tone.**

---

## TASK 2 — Screen share shows BLACK on the recipient (P1)

### Problem
When a user shares their screen (whole screen or single app), the **recipient
sees a black frame**. A normal **camera** video call renders fine on the same
peer connection — so ICE/SDP/codec/RTCView all work; only the **screen-capture
frames** are black on the remote. Persisted on **Android 16 (Samsung)**.

### Already ruled out (please don't re-do)
- `react-native-webrtc` is on the latest `124.0.7`.
- Manifest is correct: `MediaProjectionService` declared with
  `foregroundServiceType="mediaProjection"`; `FOREGROUND_SERVICE_MEDIA_PROJECTION`
  permission present; `@config-plugins/react-native-webrtc` applied; OS App-info
  shows "Picture-in-picture: Allowed".
- JS encoder caps applied (15fps / 2.5 Mbps / `maintain-resolution`,
  downscale > 1280px) — **did not** fix it (so not an encoder-overload issue).

### Likely area / asks
Android 14+ tightened MediaProjection: the `mediaProjection` foreground service
must be in the foreground **before** capture starts, and there can be timing /
EglBase / SurfaceTextureHelper issues producing black frames on newer Android.
Investigate at the native layer:
- Foreground-service start ordering vs. `getDisplayMedia`/`createVirtualDisplay` on Android 14–16 (add a small delay if needed).
- Whether `react-native-webrtc`'s `ScreenCapturerAndroid` needs a patch for Android 16, or whether linking against a maintained WebRTC-Android fork (e.g. `getstream/webrtc-android`) resolves it.
- `adb logcat` around `MediaProjection` / `SecurityException` / `MissingForegroundServiceTypeException` during a share.

### Acceptance
Recipient sees the **actual shared screen** (not black) on Android 14–16; a
normal camera call is unaffected.

---

## Repo touchpoints (JS side, for bridging)
- Call screen / WebRTC engine: `app/call/[conversationId].tsx`, `src/lib/webrtc/CallSession.ts`
- Push receive + Notifee ring (JS): `src/push/usePushNotifications.ts`, `src/push/notifeeCallWake.ts`
- Decline/accept Convex calls: `api.calls.declineCall`, `api.signaling.*`
- Channels: `src/push/notificationChannels.ts`
