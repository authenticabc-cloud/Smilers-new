# Push payload changes for device-contact names (mobile native app)

Context: the native app shows the recipient's **device address-book name** for a
contact everywhere in-app. On push notifications it currently shows the
sender/caller's **Google/account name** instead. This spec lets the app fix that.

The FastAPI relay (`/api/send-push-internal`) forwards every extra key in the
push `data` object straight through to FCM, so the ONLY change needed is what
Convex puts into that `data` object (plus, optionally, one new sync mutation).

---

## 1) Incoming CALL notifications — add `callerPhone` (small, high value)

Calls are already sent **data-only**, so the app renders the notification itself
and can swap in the device-contact name. The native app now resolves the
caller's address-book name from a phone number — it just needs the number.

**Change:** in the call push `data`, include the caller's phone in **E.164**:

```
data: {
  type: "call",
  callId, callerId, callerName,          // existing
  callerPhone: "+441234567890",          // NEW — caller's phone in E.164
  conversationId, twilio_room_name, ...  // existing
}
```

The app (native, already shipped) resolves in this order: chat-list cache →
`callerPhone` address-book lookup → `callerName` (account name) fallback. No
further mobile work once `callerPhone` is present.

---

## 2) MESSAGE notifications — device-contact names WITHOUT losing reliability

Message pushes are intentionally sent as **notification-type FCM** (with a
`notification` block) so Android reliably shows them even when the app is
killed/Doze. That means Android renders the **server-provided title**, and the
app cannot rewrite it in the background. So the title must already be correct
**when the server builds it, per recipient**.

The server can't know a recipient's private address book — unless the recipient's
own device tells it. Proposed privacy-scoped approach:

### a) New mutation: the device uploads its own sender→name map
```
api.push.setContactDisplayName({ contactUserId, displayName })
// stored PER (ownerUserId, contactUserId); readable ONLY by ownerUserId.
// The app calls this whenever it resolves a device-contact name for a peer
// (it already computes these names for the chat list).
```
Store it in a table like `pushContactNames`:
`{ ownerUserId, contactUserId, displayName, updatedAt }` (unique on
owner+contact). This is the recipient's OWN private label for a contact — never
exposed to anyone else.

### b) When building a message push, title = recipient's private label
For each recipient `r` and sender `s`, look up
`pushContactNames(owner=r, contact=s)`; if found, use that as the notification
`title`; else fall back to the sender's account name (current behaviour).

Because the notification stays notification-type, **delivery reliability is
unchanged** — only the title string differs per recipient.

### c) Also include `senderPhone` (E.164) + `senderId` in message `data`
```
data: { type: "message", conversationId, senderId, senderPhone: "+44…", ... }
```
This lets the app resolve GROUP sender names in the foreground and is a cheap
belt-and-braces for future use.

---

## Summary of asks
- CALL push data: add `callerPhone` (E.164).  ← fixes incoming-call names immediately.
- MESSAGE push data: add `senderId` + `senderPhone` (E.164).
- Optional (best UX): `api.push.setContactDisplayName` mutation + per-recipient
  title lookup so message notifications show device-contact names while staying
  reliably delivered.

Mobile side for (1) and the foreground parts of (2c) is already implemented and
shipped — it activates automatically as soon as these fields appear in the payload.
