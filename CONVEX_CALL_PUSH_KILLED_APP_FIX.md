# Convex spec — fix "killed app plays the message tone for incoming calls"

**Audience:** the web/Convex team.
**Symptom:** when the native app is backgrounded/swiped/killed, an incoming call shows a short *message-tone* banner instead of ringing.

## Root cause (confirmed from native side)

The native app is correct: it registers its FCM token with the Convex `users._id`
(`convex_user_id`), the relay matches on it, and call pushes that arrive **data-only on a
`calls-…` channel** render the full-screen ring. The problem is on the send side:

For one incoming call you fire **three** push pipelines in parallel:

1. `internal.emergentPush.notifyIncomingCall` → `POST /api/send-push-internal`
   with `channel_id:"calls-v4-smilers_never_cry"`, `data.type:"call"` → **data-only, correct.**
2. `internal.mobilePushAction.sendExpoPushToUser` (Expo push, `sound:"ringtone"`)
   → **notification-block, NO `channelId`** → on Android the OS renders it on the
   default channel = the short message/default tone. ← **this is what a killed phone plays.**
3. `internal.pushWeb.sendNotification` → web only, ignore for mobile.

Plus the **missed-call** push uses `messages-v4-message_notification` (a banner). If it
races the incoming-call push it also produces a message tone.

Two hard platform facts:
- A **data-only** FCM message cannot run JS on a **force-stopped** app, so pipeline #1 alone
  can never ring a force-stopped phone. Only an OS-rendered notification on a high-importance
  **calls** channel will.
- You cannot tell at send time whether the callee's app is alive or killed.

## The fix (3 changes)

### 1) Put the Expo-legacy push on the CALLS channel (the killed-app ring)

In `mobilePushAction.sendExpoPushToUser` (the incoming-call path), set the Android channel and
high priority on the Expo message so the OS rings on the calls channel even with no JS:

```ts
// Expo push message for an INCOMING CALL
await expo.sendPushNotificationsAsync([{
  to: expoPushToken,
  title: callerName,
  body: isVideo ? "Incoming video call" : "Incoming call",
  priority: "high",
  // Android: MUST target the high-importance calls channel (ringtone + heads-up).
  channelId: "calls-v4-smilers_never_cry",
  sound: "default",            // the channel's ringtone is what actually plays on Android
  // iOS: use the call interruption level so it rings through.
  _category: "incoming_call",
  data: {
    type: "call",
    callId,
    conversationId,
    twilio_is_video: isVideo ? "1" : "0",
    twilio_caller_identity: callerUserId,
    callerName,
    action_url: `/call/${conversationId}`,
  },
}]);
```

> If `channelId` is not on the Expo message, Android **ignores** the calls channel and uses the
> default channel → the message tone. This single missing field is the most likely culprit.

### 2) Don't double-notify the live app

When the app is alive, pipeline #1 (data-only) already renders the rich Answer/Decline UI, and
pipeline #2 would add a second banner. Pick ONE of these:

- **Option A (recommended, simplest):** keep BOTH pipelines but make the native foreground/
  background-alive handler the source of the rich UI, and accept that a force-stopped phone gets
  the plain (but correctly *ringing*) banner from #2. The native app already de-dupes by call id.
- **Option B:** drop pipeline #1's data-only push for calls and rely solely on #2 as a
  notification-block on `calls-v4-…`. You lose in-app Answer/Decline buttons rendered by Notifee
  but always ring. (Not recommended — you lose the rich UI.)

Go with **Option A**.

### 3) Delay + cancel the missed-call push so it can't race the ring

The missed-call push (`messages-v4-message_notification`) must only fire AFTER the ring window
and ONLY if the call was never answered/declined:

```ts
// when initiating the call:
await ctx.scheduler.runAfter(40_000, internal.calls.maybeSendMissedCall, { callId });

// scheduled fn:
export const maybeSendMissedCall = internalMutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call) return;
    // Skip if answered/declined/ended/cancelled — only true "missed" rings.
    if (call.status !== "ringing") return;
    await ctx.scheduler.runAfter(0, internal.emergentPush.notifyMissedCall, { callId });
  },
});
```

Keep the shared dedupe family (`twilio-call:<conversationId>` for the ring,
`missed-<callId>` for the miss) so the relay collapses duplicates.

## Acceptance test (native build, app force-stopped)

1. Caller (web or mobile) calls a callee whose app is swiped/killed.
2. Callee's phone should **ring on the calls channel** (ringtone + heads-up), not a message beep.
3. No missed-call banner appears while ringing; it only appears ~40s later if unanswered.
4. With the app in foreground/background-alive, the rich Notifee Answer/Decline UI shows (from
   the data-only push) and there is at most one notification.

## Quick verification using the relay logs (already added on the native backend)

Each `/api/send-push-internal` call now logs:
```
[PUSH][classify] -> CALL|MESSAGE channel=… recipients=… type=… action_url=… has_callId=… title=…
[PUSH][channels] {'calls-v4-smilers_never_cry': N, ...}
send_push FCM v1: X/N delivered (… is_call=… data_only=… dispatched_tokens=…)
```
For an incoming call these should read `CALL`, `calls-v4-smilers_never_cry`, `data_only=True`.
Note pipeline #2 (Expo push) does NOT go through this relay, so also confirm its `channelId`
in the Expo push payload directly.

## Note on a fully-reliable ring

Even with the above, some aggressive OEMs throttle background pushes for force-stopped apps.
The only 100%-reliable wake-on-locked-screen ring is a native **CallKeep / ConnectionService /
PushKit + foreground service** integration in the native app (tracked as P2 for the native
freelancer). The changes above maximize reliability without it.
