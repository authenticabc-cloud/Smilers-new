# Smilers — Message push contract (for the web-app / Convex backend team)

## The problem (confirmed on device)
Chat + group message notifications arrive with:
- the sender's **Google/account name** (not the recipient's saved device-contact name), and
- the **default/universal notification tone** (not the custom Smilers `message`/`group` tone).

**Root cause (confirmed):** these pushes are being sent as **FCM *notification* messages**
(they contain a top-level `notification` block). Android therefore auto-displays them itself,
using the FCM `notification.title` and the *default* channel/sound — completely bypassing the
mobile app's own renderer. Proof from the device: the app's background renderer logs
(`MSG-PUSH` / `MSG-NAME`) **never fire** for message pushes, and only **one** banner appears.

The mobile app already has a correct, working renderer for messages, but it only runs when the
push is **data-only**. When it runs, it (a) resolves the recipient's **device-contact name** and
(b) posts on the **custom Smilers channel** with the right tone. It cannot do either for a push
the OS displays on its own.

> The FastAPI relay already sends its message pushes data-only (`is_message_push`). Only the
> **Convex** message/group-message pushes still carry a `notification` block. Please fix those.

---

## The fix — send message pushes DATA-ONLY (no `notification` block)

For every **chat message** and **group message** push, send an FCM v1 message shaped like this:

```jsonc
{
  "message": {
    "token": "<recipient FCM token>",
    "android": {
      "priority": "high"          // REQUIRED so the app's background task wakes
      // ⚠️ do NOT include an "android.notification" object
    },
    "apns": {
      "headers": { "apns-priority": "5", "apns-push-type": "background" },
      "payload": { "aps": { "content-available": 1 } }   // data-only on iOS too
      // ⚠️ do NOT include "aps.alert" / "aps.sound" for messages
    },
    // ⚠️ NO top-level "notification" block anywhere
    "data": {
      "type": "message",                       // REQUIRED (exact string)
      "conversationId": "<Id<'conversations'>>",// REQUIRED
      "conversationType": "group",             // "group" for group msgs; omit/"direct" for 1:1
      "title": "<group name for groups, or sender account name for 1:1>",
      "body": "<message preview text>",
      // Fields the app uses to resolve the DEVICE-CONTACT name (send whatever you have):
      "senderId": "<Id<'users'> of the sender>",
      "senderPhone": "<sender phone in E.164, e.g. +355...>",
      // Optional routing already understood by the app:
      "channelId": "groups-v5-group_notification"  // for group msgs (optional; type+conversationType is enough)
    }
  }
}
```

### Field notes
- **No `notification` block** (android or top-level) — this is the whole fix. If present, Android
  shows its own banner with the wrong name + default sound.
- `data.type` **must** be exactly `"message"`.
- For **group** messages set `data.conversationType = "group"` (or a `data.channelId` starting with
  `groups-`). The app then renders on the **group** channel with the Smilers **group** tone and keeps
  the group name as the title.
- `data.senderPhone` (E.164) and/or `data.senderId` let the app show the recipient's **saved
  contact name**. Without them the app falls back to `data.title`.
- Keep Android `priority: high` and iOS `content-available: 1` so a backgrounded/closed app wakes
  and renders exactly one banner.

### Result after the fix
The app renders a **single** notification with the **device-contact name** on the **custom Smilers
message/group tone**. No mobile rebuild required — the app is already wired for this.

---

## Quick way to verify
While receiving one 1:1 and one group message, the mobile **Diagnostic Logs** screen should now show
`MSG-PUSH type=message hasNotifBlock=false ...` (today it shows nothing because the OS handles the
notification push before the app ever sees it).
