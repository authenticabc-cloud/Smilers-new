# Call / push pipeline — items from device logs (iter-226)

Device logs (app v2.1.93) while testing ringing/notifications/wake:

```
[CONVEX M(calls:endCall)] [Request ID: 12a48af417fa2583] Server Error
[NOTIFY] (emergentPush/register) register failed: Aborted
[SIG] (callDebug) ← skipped 4 signal(s): session not ready yet (waiting for sessionReadyTick)
[WAKE] (notifeeCallWake) cancelled: callId=js71x9tbt2dvrethrxztf0ardh88xdvy
```

## A. `calls:endCall` throws a Server Error  →  BACKEND (Convex)
- This is an uncaught exception inside the Convex `calls.endCall` mutation, not a
  client bug. When the caller hangs up / callee declines, `endCall` fails, which
  is almost certainly why "the call doesn't end on the other side."
- Web/Convex team: open Convex → Logs → Request ID `12a48af417fa2583` for the
  exact stack trace and fix the handler so `endCall` always succeeds
  (idempotent: ending an already-ended/again call must not throw).

## B. `emergentPush/register ... Aborted`  →  needs a fresh build + investigation
- The native push token registration was aborted. Pushes won't arrive reliably
  if the token isn't registered. Often a transient abort on a flaky network, but
  if persistent it must be retried.

## C. "session not ready yet (waiting for sessionReadyTick)" (signal skipped)
- Incoming call signals are arriving BEFORE the call session is initialised, so
  they're dropped. This is mobile-side call signaling timing.

## ⚠️ CRITICAL — build version
- The device is running **app v2.1.93**. The ringtone / data-only / wake-screen /
  Answer-Decline changes (iter-221) and everything since exist only in the
  SOURCE — they are NOT in an old installed APK. They will only take effect after
  a NEW build is generated (Emergent → Publish → Android build). Testing the old
  build will always show "no change."
