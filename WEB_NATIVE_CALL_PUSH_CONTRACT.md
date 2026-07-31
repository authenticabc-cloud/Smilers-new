# Web → Native Incoming-Call Push Contract (native-side findings)

Investigated in response to the web team's question: *"Does the native FCM
handler render the ring for a data-only `type:"call"` push that arrives when the
app did NOT originate the call?"*

## TL;DR — YES, it does. There is NO "did-I-originate-this-call?" guard.

I traced **every** call-push path on native:

- **JS background handler** — `src/push/backgroundTaskSetup.ts` (`type === 'call'`,
  line ~215) → `presentIncomingCallNotifeeWake(...)`, else Expo fallback on
  channel `calls-v4-smilers_never_cry`. Renders for **any** `type:"call"`; no
  origin check. `callId` falls back to `conversationId` if absent.
- **Kotlin service** — `android/.../SmilersCallNotificationService.kt`
  `handleIntent()` → `handleCallMessage()`. Renders full-screen ring; **no**
  origin/recipient/self check. Grep for `targetUserId|recipientId|myUserId|
  currentUser|isSelf|originat` in the Kotlin call path returns **nothing**.

The only reasons `handleCallMessage` returns WITHOUT ringing:
1. a `call-cancelled` FCM for the same `callId`/`conversationId` arrived first
   (`cancelledConvIds`),
2. the foreground JS listener already claimed the call (`foregroundHandledIds`),
3. notifications are disabled for the app,
4. duplicate FCM for the same `callId` (dedup window).

None of these depend on who placed the call. So a web-initiated call is treated
identically to a native-initiated one **provided the push satisfies the contract
below.**

## What the web-initiated push MUST satisfy for native to ring

The native handler runs only under these conditions — the most likely reason
web→native fails is one of these, NOT the handler logic:

1. **DATA-ONLY message (no `notification` block).**
   If the FCM contains a `notification` object, a **killed/background** Android
   app will let the OS auto-display a plain banner and will **NOT invoke**
   `handleIntent`/the JS background handler → `handleCallMessage` never runs →
   no ring / no full-screen. ← most common culprit. Native-initiated calls are
   sent data-only; the web push must be too.

2. **A non-empty `callId` the Kotlin handler can read**, via EITHER:
   - **Path A (direct):** top-level `data.type == "call"` **and** top-level
     `data.callId` non-empty, **or**
   - **Path C (relay):** `data.body` is a JSON string containing
     `{"type":"call","callId":"...", ...}` (this is the relay format).
   If `type=="call"` but `callId` is empty at both locations, native falls
   through and does not ring.

3. **`android.priority: "high"`** (and APNs high priority / `apns-push-type`)
   so a dozing/killed device is woken.

4. Not preceded by a `call-cancelled` / `missed-call` FCM for the same id.

5. The app has been launched at least once and not force-stopped (OS rule for
   data pushes to reach a killed app).

## One-command diagnostic (settles it in 30 seconds)

On the native callee device, run while a **web** client calls it:

```
adb logcat -s SmilersCall:D | grep -Ei "handleIntent|handleCallMessage|suppress|dedup"
```

Interpretation:
- **No `handleIntent` line at all** → the push either never reached the device
  OR carried a `notification` block (killed app never invoked the handler).
  → Backend/web payload issue (contract #1), not the native handler.
- **`handleIntent (direct call)` / `(relay call)` present but no
  `handleCallMessage: ... ` ring line** → `callId` was empty at the location the
  matched path reads (contract #2).
- **`handleCallMessage` present + a `suppressing`/`dedup` log** → the log states
  exactly which guard fired (cancelled-race, foreground-handled, dedup).
- **`areNotificationsEnabled=false`** → notifications disabled on that device.

Compare the same logcat for a **native**-initiated call to the same device: the
payloads should produce identical `handleIntent`/`handleCallMessage` lines. Any
difference in those lines pinpoints the payload delta.

## Conclusion for the web team

The native ring is fully origin-agnostic. If web→native isn't ringing while
native→native is, capture the logcat above — it will show whether (a) the web
push isn't arriving/handled (data-only + high-priority contract), or (b) it's
arriving but missing `callId` in the location the handler reads. Both are
payload/delivery issues on the sender side; the native notification handler
needs no change.
