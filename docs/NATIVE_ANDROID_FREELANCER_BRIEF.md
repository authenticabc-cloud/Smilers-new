# Smilers — Native Android Freelancer Brief (Killed-App Incoming Calls)

**Stack:** Expo (managed, prebuild/EAS) React Native app. Calling is
**`react-native-webrtc`** signaling over **Convex** — 1:1 is **P2P**, group &
formal-conference calls are a **WebRTC mesh** (no SFU, no LiveKit, no Twilio).
Push is **Firebase FCM v1 (data-only for calls)** + **Notifee** for the
JS-rendered ring.

**Goal:** add a thin **native Android incoming-call layer** on top of the
existing Convex/WebRTC system so calls ring reliably even when the app is
**killed / force-stopped**. Do **NOT** rebuild calling — **bridge into the
existing JS flow**.

App id: `com.smilers.app`. Targets Android 14–16. `react-native-webrtc@124.0.7`.

> Scope note: screen-sharing and iOS PushKit/CallKit are handled separately and
> are **out of scope** for this engagement (iOS = phase 2).

---

## TASK — Killed / force-stopped incoming-call ringing (P0)

### Problem (confirmed by device videos)
- App **backgrounded** → rings correctly (custom Smilers ringtone, full-screen Answer/Decline). ✅
- App **swiped away / force-stopped** → plays the **message tone**, plain banner, no Answer/Decline. ❌

**Root cause:** the killed path currently relies on the React Native / Notifee
**JS background handler**, which Android (especially Samsung One UI / Xiaomi
MIUI / other aggressive OEMs) throttles or blocks entirely once the app is
**force-stopped** — so the JS never runs and the native ring never renders.
The only reliable fix is a **native `FirebaseMessagingService`** that wakes the
process directly from a high-priority data message.

### Required implementation (ADDITIVE — keep all existing paths intact)

1. **Native `FirebaseMessagingService`** (delivered via an Expo config plugin /
   local plugin) that receives **data-only** FCM in **any** app state,
   including killed / force-stopped.

2. **Classify the payload natively** (in `onMessageReceived`, before any JS):
   - It is a **call** when `data.type == "call"`.
   - Anything else (messages, etc.) → **fall through to the existing
     notification path UNCHANGED** (see "Preserve the message path" below).

3. **Start a native foreground service** for the call with
   `android:foregroundServiceType="phoneCall"` and acquire a wake lock so the
   device screen turns on.

4. **Present the incoming-call UI natively** via Android
   **`ConnectionService` (`TelecomManager`)** / **CallKeep-style** — system
   full-screen incoming-call screen, lock-screen wake, **custom Smilers
   ringtone**, Answer / Decline. Use the existing call channel (below).

5. **Bridge Answer / Decline back into the existing JS flow** — this is the
   critical integration point. **Branch on `data.isConference`:**

   | `data.isConference` | Call kind | On **Answer**, deep-link the RN activity to |
   |---|---|---|
   | `"1"` | **Group / formal conference** (WebRTC mesh) | `/group-call/<conversationId>?callId=<callId>` |
   | `"0"` or **absent** | **1:1** (WebRTC P2P) | `/call/<conversationId>` |

   - **Answer** → launch the single RN activity (`MainActivity`,
     `singleTask`) and deep-link to the route above. The existing Convex
     offer/answer/ICE (1:1) or mesh negotiation (group) then runs in JS. **Pass
     `callId` through** — the mesh uses it as the shared room id; without it the
     callee joins a different room and never connects.
   - **Decline** → call Convex **`api.calls.declineCall({ callId })`** and
     dismiss the native UI. (If the process can reach JS, route the decline
     through the existing JS helper; otherwise a direct Convex HTTP mutation
     with the stored auth token is acceptable.)

6. **Preserve the message path (HARD REQUIREMENT).** Normal messages must keep
   using the existing Notifee message channel + custom **message tone**. Do not
   cannibalize or intercept message pushes into the call UI.
   > ⚠️ A previous `ConnectionService` attempt **broke FCM message delivery**.
   > Coexistence with the message path is non-negotiable — verify messages still
   > arrive (with the message tone) in **all** app states after your change.

### FCM call payload (already sent by the backend — DO NOT change the contract)

Data-only, high priority. The backend FastAPI relay
(`/api/send-push-internal`) + Convex `api.calls.notifyIncomingCall` already
populate every field below:

```jsonc
{
  "data": {
    "type": "call",
    "callId": "<calls doc id>",
    "conversationId": "<conversation id>",
    "callType": "voice" | "video",
    "isConference": "1" | "0",      // "1" => mesh group/conference, "0"/absent => 1:1
    "callerId": "<user id>",
    "callerName": "...",
    "displayName": "...",
    "title": "Incoming call",
    "action_url": "/call/<conversationId>"   // 1:1 default; OVERRIDE per the table above when isConference=="1"
  },
  "android": { "priority": "high", "ttl": "45s" }   // DATA-ONLY (no `notification` block)
}
```

- **`isConference` is a STRING (`"1"`/`"0"`)**, not a JSON boolean — FCM data
  values are always strings. Treat any of `"1"`/`"true"` as group; treat
  `"0"`/absent as 1:1.
- `action_url` always carries the 1:1 route as a fallback. When
  `isConference == "1"`, **ignore `action_url` and build the
  `/group-call/...?callId=...` route yourself** per the table.
- Android call channel: **`calls-v4-smilers_never_cry`** (importance MAX,
  `bypassDnd`, custom ringtone). Reuse it; do not create a new channel.

### Acceptance criteria
1. **Force-stop** the app, then receive a **1:1** call → native full-screen
   incoming-call UI with Smilers ringtone + Answer/Decline. **Answer** opens
   `/call/<conversationId>` and the live P2P WebRTC call connects. **Decline**
   notifies the caller.
2. **Force-stop** the app, then receive a **group/conference** call
   (`isConference=="1"`) → same native UI. **Answer** opens
   `/group-call/<conversationId>?callId=<callId>` and the callee joins the
   **same mesh room** (audio/video flows).
3. Repeat (1) and (2) with the app **backgrounded** and **locked** — must still
   ring correctly (no regression to the existing working background path).
4. Throughout all of the above, **normal chat messages still arrive** with the
   **message tone** and the normal banner — no call UI hijack.
5. Verified on at least one **aggressive-OEM device** (Samsung One UI or Xiaomi
   MIUI) from a fully force-stopped state.

---

## Repo touchpoints (JS side — for bridging only; do not rebuild)
- **1:1 call screen / WebRTC P2P engine:** `app/call/[conversationId].tsx`, `src/lib/webrtc/CallSession.ts`
- **Group/conference mesh route + engine:** `app/group-call/[conversationId].tsx`, `app/conference/[conferenceId]/room.tsx`, `src/lib/call/mesh/` (`MeshController.ts`, `MeshPeer.ts`, `useConferenceMesh.ts`)
- **Push receive + Notifee ring (JS, foreground/background):** `src/push/usePushNotifications.ts`, `src/push/useIncomingCallListener.ts`, `src/push/notifeeCallWake.ts`
  - These already branch on `isConference` (`"1"`/`"true"`/boolean) to route to `/group-call` vs `/call`. **Mirror this exact branching natively.**
- **Decline / signaling Convex fns:** `api.calls.declineCall`, `api.signaling.*` (1:1), `api.conferenceSignaling.*` (mesh)
- **Channels:** `src/push/notificationChannels.ts`
- **Existing local config plugins (pattern reference):** `plugins/withCallWakeScreen.js`

## Constraints / Don'ts
- **No LiveKit, no Twilio, no SFU.** Calling stays on `react-native-webrtc` + Convex.
- Do **not** change the FCM payload contract or the backend — it is shared with the iOS/web teams.
- Do **not** modify Expo env vars / `metro.config.js` / packager URLs.
- Keep everything **additive**: the working backgrounded ring and the message
  path must continue to function exactly as today.
