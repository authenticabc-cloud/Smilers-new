# Hercules / Convex Backend — FCM Push Contract for Killed-App Custom Tones

**Audience:** the web/Hercules backend team that sends push notifications to the
Smilers native app (the Convex/web backend, not the Emergent FastAPI backend).

**Goal:** When the native app is **force-killed** (swiped away), incoming **calls**
must RING with the user's **custom call ringtone**, and **messages** must play the
user's **custom message tone** — not the default/short "message" beep.

---

## Why this is a backend job

When the app is force-killed, **no JavaScript runs on the device** — so the app's
in-JS "render a custom ringtone via Notifee" path cannot fire. The ONLY thing that
makes a killed phone ring is the **Android notification the OS auto-displays from
the FCM payload itself**. Android plays the sound of the **notification channel**
named in the payload. Therefore the backend MUST send the notification on the
**correct channel id** for the push type.

Foreground / background (app alive) already work because JS is running.

---

## What the device registers (already implemented in the app)

On launch / when the user changes a tone, the app registers its **current,
tone-versioned channel ids**. Android channels are immutable, so a tone change =
a new channel id. The app sends these to the backend register endpoint:

```
call_channel_id     e.g. "calls-v4-smilers_never_cry_2"
message_channel_id  e.g. "messages-v4-smilers_notification"
```

> If the Convex `registerMobileDevice` mutation does **not** currently persist
> `call_channel_id` and `message_channel_id`, please add them to the push-token
> document. The app already sends them. Without storing them you cannot target
> the user's chosen tone.

The matching Android channels are created on the device with the user's chosen
sound (the app owns this). The backend's only job is to **name the right channel
id in the FCM message**.

---

## REQUIRED FCM v1 payload — CALLS

Send a message that has **BOTH** a `notification` block (so a killed phone rings)
**AND** a `data` block (so a live app can render the full-screen Answer/Decline UI).

```jsonc
{
  "message": {
    "token": "<device FCM token>",
    "android": {
      "priority": "high",
      "ttl": "45s",
      "notification": {
        "channel_id": "<the device's stored call_channel_id>",  // e.g. calls-v4-<ringtone>
        "default_vibrate_timings": true,
        "visibility": "PUBLIC",
        "notification_priority": "PRIORITY_MAX"
        // Do NOT set "sound" here — on Android 8+ the CHANNEL's sound wins.
        // The channel id above is what makes the custom RINGTONE play.
      }
    },
    "notification": { "title": "<caller name>", "body": "Incoming call" },
    "data": {
      "type": "call",
      "callId": "<id>",
      "conversationId": "<conversationId>",
      "displayName": "<caller name>",
      "twilio_room_name": "<room or empty>",
      "twilio_is_video": "1" | "0",
      "action_url": "/call/<conversationId>?...",  // tap fallback route
      "channel_id": "<same call_channel_id>"       // belt-and-suspenders
    }
  }
}
```

**Channel-id resolution rule (server-side):**
1. If the token doc has `call_channel_id` → use it.
2. Else if payload carries an explicit `channel_id` starting with `calls` → use it.
3. Else default to a stable calls channel id (e.g. `"calls"`).

> ⚠️ The classic bug: sending the call push with **no channel_id** (or a
> messages channel) makes Android play it on the default/messages channel — that
> is the "message tone instead of ringtone when killed" symptom. Always set the
> calls channel id.

---

## REQUIRED FCM v1 payload — MESSAGES

```jsonc
{
  "message": {
    "token": "<device FCM token>",
    "android": {
      "priority": "high",
      "notification": {
        "channel_id": "<the device's stored message_channel_id>", // messages-v4-<tone>
        "visibility": "PRIVATE",
        "notification_priority": "PRIORITY_HIGH"
      }
    },
    "notification": { "title": "<sender>", "body": "<preview>" },
    "data": { "type": "message", "conversationId": "<id>", "channel_id": "<same message_channel_id>" }
  }
}
```

Same rule: target the device's stored `message_channel_id` so the user's chosen
**message tone** plays when killed.

---

## Avoid the double-ring / double-tone

If, in addition to this OS notification, the backend ALSO triggers a **second**
push for the same event (e.g., a Convex "call log" push AND a caller-device push),
the user can get two notifications. Recommendations:
- Send **one** push per event per recipient (dedupe within ~25s by callId/room).
- Keep using a single `type` (`call` / `message`) so the app's de-dupe + routing
  works.

The native app has been updated to **suppress its own in-JS Notifee ring when the
OS already displayed a notification** (so when you send the `notification` block,
there is no in-app double). See `usePushNotifications.ts` (iter-218).

---

## iOS note

iOS already rings via the APNS `alert` + `sound` in the existing payload. A true
full-screen CallKit experience needs PushKit + a VoIP cert (native work) and is
out of scope here.

---

## Quick test checklist (on a real device)

1. Set a non-default call ringtone and a non-default message tone in the app.
2. Force-kill the app (swipe from recents).
3. From another account, **call** → phone should ring with the **chosen ringtone**.
4. Send a **message** → phone should play the **chosen message tone**.
5. Tap the call notification → app opens to the call screen.

If a tone is still wrong, dump the exact FCM JSON your backend sent and confirm
`android.notification.channel_id` equals the device's stored
`call_channel_id` / `message_channel_id`.
