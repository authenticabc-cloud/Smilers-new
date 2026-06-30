# Smilers — Handover for Incoming-Call Notifications (for Ashwini)

This document answers your questions and gives you everything needed to finish the
two remaining items:
1. **Multiple notifications for the same call** (should be ONE persistent banner for the
   whole ring, WhatsApp-style).
2. **Answer / Decline buttons** missing on the call notification.

Please read **Section 3 (Root cause)** carefully — it changes the plan, because the
server-side part you described is **already implemented and live**, so the real work is
on the **native killed-app handler**.

---

## 1. Your direct questions answered

**Q1. Where is the server hosted?**
The FastAPI backend (`server.py`) runs on **Emergent's managed cloud platform** — *not*
AWS / GCP / DigitalOcean / a VPS. There is **no SSH host** to log into.

**Q2. How is it running? (PM2 / systemd / Docker / terminal / panel)**
None of those. It runs as a managed process inside the Emergent platform (supervisor-managed
internally). There is **no PM2 / systemd / Docker** surface exposed to developers.

**Q3. Is there a deployment script / set of steps for server updates?**
Yes, but it's a one-click flow, not a script:
- Backend code changes go live by clicking the **“Publish”** button (top-right) in the
  Emergent project.
- **Publishing automatically restarts the backend** (≈ a few seconds). There is no manual
  `restart` command to run, and no low-traffic-window coordination needed — it's a fast,
  zero-data-loss redeploy (all data is in the database/Convex, not the process).

**Q4. Should you restart it yourself, or get access?**
Neither in the traditional sense. Because there's no SSH/PM2/systemd:
- Send us your exact `server.py` change (a diff or the file), and **we apply it inside the
  Emergent project and click Publish**. That is the “restart”.
- ⚠️ **Important:** any edits you make to a *local* copy of `server.py` will **NOT** reach
  the live backend on their own. They only go live when applied in the Emergent project and
  Published. So please hand changes to us rather than expecting a server you can restart.

---

## 2. How the live push pipeline actually works (so you can align)

- The backend sends pushes via **Firebase Cloud Messaging v1** (Admin SDK / service
  account). Function: `fcm_send_v1()` in `server.py` (~line 1282).
- There are exactly **two** call-ring entry points, each sends **one** push per call
  (idempotent, fire-and-forget):
  - `POST /api/calls/ring`  → WebRTC calls (the current default).
  - `POST /api/twilio/initiate-call` → Twilio path.
- The mobile **caller** calls `/api/calls/ring` **once** per call (see
  `frontend/src/lib/twilio/twilioApi.ts → ringWebrtcCall`). It does **not** loop.
- Convex *also* emits a call push via `/api/notify-event`. So per call there can be up to
  **two** push sources (Convex trigger + caller device). The backend **collapses these to
  one ring per recipient within a 25-second window** (see below).

### Call pushes are already DATA-ONLY + de-duplicated (THIS IS KEY)
In `server.py`, `send_push()` (~lines 1820–1885) already does, for any `type: "call"` push:
- **`android_data_only=True`** → the FCM message has **NO `notification` block**, so Android
  does **not** auto-display a system banner. (Line ~1884.)
- **Dedupe to one ring / 25s / user** via `_recent_call_push_to_user()` (lines ~1824–1836).
- **TTL = 45s** so a late-delivered ring can't “ghost ring” minutes later. (Line ~1868.)
- High priority (`priority="high"`) so it wakes a backgrounded/killed (not force-stopped) app.

➡️ **Conclusion:** the “make call retries silent/data-only” change you described is **already
present and live**. Re-doing it in `server.py` is redundant and a server restart for that
purpose is **not** required.

---

## 3. Root cause of the remaining issues (revised)

The repository currently has **no** `@react-native-firebase/messaging`
`setBackgroundMessageHandler` and **no** native `FirebaseMessagingService` — confirmed by
searching the codebase. The incoming-call UI is rendered **only** by the JS/Notifee module
`frontend/src/push/notifeeCallWake.ts`, which runs when the app is **alive**
(foreground/background, not killed).

That JS module is already “correct” WhatsApp-style:
- It posts a **single notification with a STABLE id**: `` `call-wake-${callId}` `` (line ~262).
  Because the id is keyed by `callId`, repeated data messages for the same call **update the
  same notification instead of stacking**.
- It **already includes Answer / Decline action buttons**, a full-screen intent
  (`fullScreenAction`), `category: CALL`, looping ringtone, and an auto missed-call follow-up
  (lines ~261–324).

So the duplicate, button-less banners you are seeing are coming from **the native
killed-app handler you are adding** — it is posting a **new** notification per incoming FCM
data message (and there are up to 2 sources per call, plus any re-emits), each with a fresh
id and **without** action buttons.

**This means the remaining work is in your native code, not the server.**

---

## 4. What we need you to implement (native, killed-app path)

Implement the native data-message handler so it behaves **exactly like the JS Notifee path**:

1. **One persistent notification per call (no stacking):**
   Build the notification id/tag **deterministically from `callId`**, e.g.
   `NotificationManager.notify(("call-wake-" + callId).hashCode(), notification)` (or use a
   constant tag + callId). Every subsequent data message for the **same `callId`** must call
   `notify()` with the **same id**, so Android **replaces/updates** the existing banner
   rather than adding a new one. This is the core fix for “appears every few seconds”.

2. **Add Answer / Decline actions + full-screen intent:**
   - `setCategory(NotificationCompat.CATEGORY_CALL)`
   - `setFullScreenIntent(pendingIntent, true)` (wakes a locked screen)
   - `setOngoing(false)` + `setTimeoutAfter(35000)` (matches the 35s ring; see
     `RING_TIMEOUT_MS` in `notifeeCallWake.ts`)
   - Two actions: **Answer** (launch activity → route to the call screen) and **Decline**
     (broadcast → end the call / cancel notification + post “Missed call”).
   - Use the high-importance **call channel** (see Section 6).

3. **Single-renderer rule (avoid double UI):**
   When the app/JS is alive, `notifeeCallWake.ts` already handles the call. Your native
   handler should only render when JS is not running, and should **dedupe by `callId`** so
   the user never sees two ringing UIs. Cancel your native notification by the same
   `callId`-derived id when the call is answered/declined/cancelled.

4. **Mirror Answer/Decline behavior** from `notifeeCallWake.ts → handleCallEvent` (lines
   ~373–417): Answer cancels the ring + routes into the call screen; Decline ends the call
   and shows a “Missed call”.

> Note: **Force-stopped** apps (user swiped “Force stop” in Settings) cannot run any code —
> not JS *or* native — so they won't ring. That's an accepted Android platform limitation.

---

## 5. FCM data payload contract (what your native handler will receive)

All call pushes are **data-only** on Android. The `data` map keys (all strings):

| key                      | example                          | notes |
|--------------------------|----------------------------------|-------|
| `type`                   | `"call"`                         | route as a call when == `call` |
| `callId`                 | `"jd72...ns"`                    | **use this for the stable notification id** |
| `callerId`               | Convex user id of caller         | |
| `callerName`             | `"Áßhåäã Developer"`             | title of the notification |
| `displayName`            | same as callerName               | |
| `conversationId`         | conversation/room id             | Answer routes to `/call/<conversationId>` (WebRTC) |
| `twilio_is_video`        | `"1"` or `"0"`                   | video vs voice |
| `twilio_caller_identity` | caller identity                  | |
| `twilio_room_name`       | only on the Twilio path          | if present, Answer routes to `/incoming-call?...` |
| `action_url`             | `"/call/<conversationId>"`       | deep-link fallback |
| `channel_id`             | `"calls-v4-smilers_never_cry"`   | hint for the call channel |
| `subtext`                | `"Incoming call"`                | |

(See `server.py` `webrtc_ring` ~lines 473–490 and `twilio-initiate-call` ~lines 367–405.)

---

## 6. Android notification channels (already defined by the app)

- **Call ring channel (JS/Notifee):** `incoming-call-wake-v3-<ringtone>` —
  `AndroidImportance.MAX`, looping ringtone, long vibration pattern, `visibility=PUBLIC`.
  (See `notifeeCallWake.ts → ensureCallChannel`, line ~152.)
- **Legacy/explicit call channel id used in payloads:** `calls-v4-smilers_never_cry`.
- **Missed calls:** `missed-calls-v1` (HIGH importance).
- **Messages:** `messages-v4-message_notification`.

For your native notification, post on a **MAX/HIGH-importance call channel** (you may reuse
`calls-v4-smilers_never_cry` or create your own native call channel with a ringtone sound).
Channels are immutable on Android O+ — if you change sound/vibration, bump the channel id.

---

## 7. Reference files (in the project)

- `frontend/src/push/notifeeCallWake.ts` — the canonical incoming-call renderer to mirror
  (stable id, Answer/Decline, full-screen, missed-call follow-up, event handlers).
- `frontend/src/push/usePushNotifications.ts` — where `presentIncomingCallNotifeeWake()` is
  invoked when the app is alive (lines ~312, ~1145).
- `frontend/src/lib/twilio/twilioApi.ts` — `ringWebrtcCall` (caller fires one ring).
- `backend/server.py` — `webrtc_ring` (~467), `twilio-initiate-call` (~275), `send_push`
  (~1686, dedupe+data-only at ~1820–1885), `fcm_send_v1` (~1282).

---

## 8. Summary / decision

- ✅ Backend already sends call pushes **data-only** and **dedupes to one ring per 25s** —
  **no server change or restart is required** for that.
- ✅ The JS Notifee path already shows **one** notification with **Answer/Decline** for
  alive apps.
- 🔧 The remaining work is **entirely in the native killed-app handler**: use a
  **stable `callId`-based notification id** (so it updates instead of stacking) and attach
  **Answer/Decline actions + a full-screen intent**, mirroring `notifeeCallWake.ts`.
- 📦 If you do need any backend change, send us the diff — we apply it in the Emergent
  project and click **Publish** (that is the “restart”).
