# Web Team (Convex backend) — Two contract gaps blocking the mobile app

The mobile (Expo) app talks to the **same Convex backend** as the web app. Two
mobile-reported bugs trace back to the Convex side, not the mobile code. Both
are small, additive backend changes.

---

## 1. Voice/video transcript not delivered to the recipient

### Symptom
The **sender** sees the transcript on their own voice/video bubble, but the
**recipient never sees it**.

### Root cause
The recipient cannot transcribe — on E2EE chats they only hold AES-GCM
ciphertext. The transcript reaches them **only** if it is persisted onto the
Convex message and returned by the message-list query. The mobile app already:

1. Runs Whisper (`POST /api/transcribe/upload`).
2. Caches the result locally (sender-only).
3. Calls `api.messages.setTranscription` to persist it on the message.

**Convex arg validators reject unknown/extra fields.** If `setTranscription`'s
validator does not define `transcriptionSegments` (and/or
`transcriptionLanguage` / `transcriptionStatus`), the **entire mutation
throws**, nothing is persisted, and only the sender's local cache has the text.
(The mobile app now retries with progressively smaller arg shapes as a
mitigation, but the proper fix is on the backend.)

### Fix requested
Ensure `api.messages.setTranscription` **accepts and persists** all of:

```ts
setTranscription({
  messageId: v.id("messages"),
  transcription: v.optional(v.string()),
  transcriptionLanguage: v.optional(v.string()),
  transcriptionStatus: v.optional(v.string()),   // 'pending' | 'ready' | 'error'
  transcriptionSegments: v.optional(v.array(v.object({
    start: v.number(), end: v.number(), text: v.string(),
  }))),
  transcriptionError: v.optional(v.string()),
})
```

…and that the **message-list / message-by-id queries return** `transcription`,
`transcriptionLanguage`, `transcriptionStatus`, `transcriptionSegments` so the
recipient's client renders the pill. (The mobile bubble reads
`message.transcription` first, then falls back to local cache.)

### How to verify
Send a voice note from mobile → confirm the **recipient** (mobile or web) sees
the transcript. In Convex dashboard, the message document should now contain a
non-empty `transcription` field.

---

## 2. Killed-app incoming calls ring with the MESSAGE tone (no full-screen UI)

### Symptom (from device videos)
- App **backgrounded** → call rings correctly with the custom Smilers ringtone + full-screen Answer/Decline. ✅
- App **swiped away / killed** → plays the **message tone**, shows a plain banner, no Answer/Decline. ❌

### Root cause
When backgrounded, the **data-only** high-priority call FCM wakes the JS handler
which renders the rich ring. When killed, JS can't run first, so whatever push
the OS auto-displays wins. The FastAPI relay (`/api/notify-event`) is already
fixed and **verified** to send the call push **data-only** with `type:'call'`
on the `calls-v4-*` channel. The message-tone-when-killed pattern indicates a
**second call push, sent by the Convex backend, that carries a `notification`
block routed to the message channel** — the OS shows it directly.

### Fix requested (Convex push action for calls)
Make Convex's **call** push match the mobile contract:

1. **Data-only** on Android — NO `notification` block (so the OS doesn't auto-display a banner with the message sound; the device's handler renders the ring).
2. `android.priority = "high"`, short TTL (~45s).
3. `data` must include: `type:"call"`, `callId`, `conversationId`, `callType`
   (`voice`/`video`), `callerName`, `displayName`, and the Android
   `channelId` for the calls channel (`calls-v4-smilers_never_cry`).
4. Keep the existing **message** push path unchanged.

> Note: even with this, a *fully force-stopped* app can't run JS at all. That
> last-mile case is handled by the native Android layer (see the native
> freelancer brief: FirebaseMessagingService + ConnectionService/CallKeep).
> This Convex fix covers the swiped-away/killed-but-not-force-stopped case.

### How to verify
Swipe the app away, place a call → device shows the full-screen Smilers ring
with Answer/Decline, not the message banner.
