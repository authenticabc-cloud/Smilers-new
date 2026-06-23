# Smilers — Incoming Call: FCM Payload + Signaling (Freelancer Brief)

> **Important correction:** Smilers is **NOT** using Twilio. Calling is
> **`react-native-webrtc` (peer-to-peer) + Convex** for signaling. The
> `twilio_*` keys you'll see in the FCM payload are **legacy field names**
> kept only for backward-compat with old clients — in the current build they
> are empty/ignored. The room/SDP/ICE exchange happens entirely over Convex.

---

## 1. Sample FCM payload for an incoming call (sensitive data removed)

Sent via **FCM HTTP v1** (`firebase-admin` `messaging.send`). On **Android,
call pushes are DATA-ONLY** (no `notification` / `android.notification` block)
so the OS does not auto-post a plain banner — instead our background task
renders the full-screen ring (see §3). iOS keeps an APNS alert.

```jsonc
{
  "message": {
    "token": "<DEVICE_FCM_TOKEN>",

    // DATA-ONLY on Android (no top-level "notification" object for calls).
    // All values are strings (FCM v1 requires string→string).
    "data": {
      "type": "call",
      "title": "Incoming call",
      "message": "Jane Doe is calling…",
      "callId": "<convex_call_id>",
      "callerId": "<convex_user_id_of_caller>",
      "callerName": "Jane Doe",
      "callType": "voice",                 // or "video"
      "conversationId": "<convex_conversation_id>",
      "displayName": "Jane Doe",
      "action_url": "/call/<conversationId>",
      "idempotency_key": "<dedupe_key>",

      // ---- LEGACY / UNUSED in WebRTC mode (present but empty) ----
      "twilio_room_name": "",
      "twilio_is_video": "0",
      "twilio_caller_identity": ""
    },

    "android": {
      "priority": "high",
      "ttl": "45s"                          // call pushes expire fast (no ghost ring)
      // NOTE: no "notification" block for calls (data-only)
    },

    "apns": {
      "headers": { "apns-priority": "10" },
      "payload": {
        "aps": {
          "alert": { "title": "Incoming call", "body": "Jane Doe is calling…" },
          "sound": "default",
          "badge": 1,
          "content-available": 1
        }
      }
    }
  }
}
```

For **messages** (not calls) the payload DOES include a `notification` block
and routes to the `messages-v4-<sound>` channel at importance HIGH.

### Android notification channels (immutable → versioned by tone)
- Incoming calls: **`calls-v4-<sound>`** (e.g. `calls-v4-smilers_never_cry`),
  importance **MAX**, `bypassDnd`, PUBLIC lockscreen, long vibration pattern.
- Wake-screen ring (rendered by Notifee, see §3): **`incoming-call-wake-v3-<sound>`**, importance MAX.
- Default fallback channel always created: `calls-v4-smilers_never_cry` + legacy `calls`.
- The device registers its versioned channel ids with the backend so FCM
  targets the exact channel the user's chosen ringtone lives on.

---

## 2. Backend that sends the push
- FastAPI relay endpoint: **`POST /api/send-push-internal`** → classifies the
  push (call vs message), resolves the per-token Android channel, dedupes
  call pushes (one ring per recipient within 25s), then calls
  `firebase-admin` `messaging.send` with the structure above.
- A call triggers **two** push sources that are de-duplicated into one ring:
  (a) the Convex backend on call creation, and (b) the caller device.

---

## 3. How incoming-call signaling works today (end-to-end)

**Caller side**
1. Caller taps call → app writes a Convex **call record with `status:"ringing"`** (`api.calls.*`).
2. WebRTC starts immediately: `RTCPeerConnection` + `getUserMedia` → `createOffer`
   → offer + ICE candidates are written to **Convex signaling** (`api.signaling.*`), keyed by `callId`.
3. A high-priority **data-only FCM** is dispatched to the callee (via `/api/send-push-internal`).

**Callee side — depends on app state**
- **Foreground:** the reactive Convex query **`api.calls.getIncomingCall`**
  returns the ringing record → `useIncomingCallListener` routes the user
  straight to the in-app incoming-call / call screen.
- **Background / swiped-away:** the **data-only high-priority FCM** wakes the JS
  background handler (`usePushNotifications` → `presentIncomingCallNotifeeWake`).
  **Notifee** then renders the ring on a **MAX-importance** channel:
  - `fullScreenAction` (launches over the keyguard / lock screen),
  - `category: CALL`, PUBLIC visibility,
  - **looping ringtone** (`loopSound`) + long repeating vibration pattern (~35s),
  - **Answer / Decline** action buttons,
  - auto-dismiss at `timeoutAfter` (35s) → a **Missed call** follow-up notification.
  - **NO CallKeep / NO ConnectionService / NO PushKit** today.

**Answer / Decline**
- **Answer** (action button, full-screen, or body press) → notifee background/foreground
  event handler cancels the ring and routes to **`/call/<conversationId>`** (WebRTC screen).
  Cold-start answers are recovered via `getInitialNotification()`.
- In the call screen the callee builds its `RTCPeerConnection`, reads the
  caller's **offer from Convex**, `setRemoteDescription`, `getUserMedia`,
  `createAnswer`, writes the answer + ICE back over Convex. TURN/STUN come
  from `EXPO_PUBLIC_TURN_*` / `EXPO_PUBLIC_STUN_*`. Media is **peer-to-peer**.
- **Decline** → `api.calls.declineCall({ callId })` (caller stops ringing) +
  cancel ring + Missed-call note.

---

## 4. The actual problem to solve (scope)
Standard killed-app ringing works, but on **force-stopped apps** and
**aggressive OEMs** (Xiaomi/MIUI, Oppo/ColorOS, Vivo, etc.) the OS throttles
the JS background task, so the Notifee ring sometimes doesn't fire. We want a
**native Android `ConnectionService` + foreground service (CallKeep-style)**
that shows a true system incoming-call screen on a high-priority data FCM,
**without disrupting** the existing Convex/WebRTC signaling or the FCM message
channel. (A previous CallKeep/ConnectionService attempt cannibalized the FCM
message channel — see note below.)

> ⚠️ History to avoid: an earlier `ConnectionService` integration broke the
> FCM **message** delivery channel (messages stopped arriving). The native
> work must coexist with the data-only call push + Notifee message path.

**Deliverable:** native `ConnectionService`/foreground-service incoming-call UI
triggered by the existing data-only call FCM (`type:"call"`, channel
`calls-v4-*`), with Answer routing into `/call/<conversationId>` and Decline
calling `api.calls.declineCall`. iOS equivalent (PushKit + CallKit) optional/phase-2.
