# Smilers — Native Android Freelancer Brief (Killed-App Incoming Calls)

**Stack:** Expo (managed, prebuild/EAS) React Native app. Calling is
**`react-native-webrtc` (P2P) + Convex** signaling. Push is **Firebase FCM v1**
(data-only for calls) + **Notifee** for the JS-rendered ring. **No Twilio.**

**Goal:** add a thin **native Android incoming-call layer** on top of the
existing Convex/WebRTC system. Do **NOT** rebuild calling — bridge into the
existing JS flow.

App id: `com.smilers.app`. Targets Android 14–16. `react-native-webrtc@124.0.7`.

> Scope note: screen-sharing is handled separately by the app team and is **out
> of scope** for this engagement.

---

## TASK — Killed/force-stopped incoming-call ringing (P0)

### Problem (confirmed by device videos)
- App **backgrounded** → rings correctly (custom Smilers ringtone, full-screen Answer/Decline). ✅
- App **swiped away / force-stopped** → plays the **message tone**, plain banner, no Answer/Decline. ❌

The killed path currently relies on the React Native / Notifee **JS background
handler**, which the OS throttles/blocks when the app is force-stopped — so the
native ring never renders. (Recommendation confirmed by the client.)

### Required implementation (additive — keep existing paths intact)
1. Native **`FirebaseMessagingService`** (via an Expo config plugin / local plugin) to receive **data-only** FCM in any app state, including killed/force-stopped.
2. **Classify** the payload: it's a call when `data.type == "call"` (also carries `callId`, `conversationId`, `callType`, `callerName`, `displayName`). Everything else = message → **fall through to the existing notification path unchanged**.
3. Start a **native foreground service** for the call, `android:foregroundServiceType="phoneCall"`.
4. Present the incoming-call UI via **Android `ConnectionService` (`TelecomManager`)** / **CallKeep-style** — system incoming-call screen, lock-screen wake, custom ringtone, Answer/Decline.
5. **Bridge Answer/Decline back into the existing JS flow:**
   - **Answer** → launch the RN activity and deep-link to **`/call/<conversationId>`** (the WebRTC call screen) so the existing Convex offer/answer/ICE flow runs.
   - **Decline** → call Convex `api.calls.declineCall({ callId })` and dismiss.
6. **Preserve the message path** — normal messages must keep using the existing Notifee message channel + custom message tone. Do not cannibalize it.
   > ⚠️ A previous ConnectionService attempt broke FCM **message** delivery — coexistence with the message path is a hard requirement.
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

## Repo touchpoints (JS side, for bridging)
- Call screen / WebRTC engine: `app/call/[conversationId].tsx`, `src/lib/webrtc/CallSession.ts`
- Push receive + Notifee ring (JS): `src/push/usePushNotifications.ts`, `src/push/notifeeCallWake.ts`
- Decline/accept Convex calls: `api.calls.declineCall`, `api.signaling.*`
- Channels: `src/push/notificationChannels.ts`
- Existing local config plugins (for reference/pattern): `plugins/withCallWakeScreen.js`
