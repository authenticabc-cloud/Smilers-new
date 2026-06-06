# Emergent Push Notifications — Backend Contract for Convex

> **For**: Backend agent maintaining the Smilers Convex deployment.
> **From**: Mobile agent (iter-127).
> **Purpose**: Switch all push-notification SENDING from the legacy Expo-push pipeline to the new Emergent-managed relay.
>
> **Mobile-side is DONE** — every signed-in device now POSTs its native FCM/APNs token to `${BACKEND_URL}/api/register-push`. The token is stored against `user_id` (= the OIDC `sub`, same identity Convex sees).
>
> **What you need to do** — when a message arrives / a call is missed / a user is mentioned, POST a small JSON to `${BACKEND_URL}/api/send-push-internal` (authenticated with `X-Internal-Push-Token`). FastAPI relays to Emergent which delivers via FCM/APNs.

---

## 1. The two endpoints

### `POST /api/register-push`
Called by the **mobile app only**. You don't need to touch this — it's already wired and working.

### `POST /api/send-push-internal`
Called by **Convex actions only**. Authenticated by the shared secret `INTERNAL_PUSH_TOKEN`.

| Header | Required | Value |
|---|---|---|
| `Content-Type` | yes | `application/json` |
| `X-Internal-Push-Token` | yes | The `INTERNAL_PUSH_TOKEN` env var (set in FastAPI .env; share with you out-of-band when you're ready) |

Body:

```ts
{
  recipients:      string[];   // array of user IDs (= OIDC `sub`). Max 100 per call.
  title:           string;     // <= 60 chars recommended
  message:         string;     // notification body
  subtext?:        string;     // optional Android-only second line
  image_url?:      string;     // optional HTTPS image
  action_url?:     string;     // optional deeplink — see §3
  idempotency_key?: string;    // optional, recommended for retries
}
```

Response: `202 Accepted` with `{"status": "accepted"}`.

> 🔒 **DO NOT** call `/api/send-push-internal` from the mobile app. Only Convex actions should call it. The shared-secret header is the only thing preventing abuse.

---

## 2. Trigger points — when Convex should POST

### Message delivery (1:1 + group)

Whenever `api.messages.send` (or your equivalent mutation) successfully writes a new message:

1. Identify all recipients = `conversation.participants` minus `senderId`.
2. Resolve display name of sender (from the `users` table).
3. POST to `/api/send-push-internal` from a Convex **action** (mutations cannot HTTP-call):

```ts
// Example Convex action — adapt to your codebase shape
export const notifyNewMessage = internalAction({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, { messageId }) => {
    const msg = await ctx.runQuery(internal.messages.getById, { messageId });
    if (!msg) return;
    const sender = await ctx.runQuery(internal.users.getById, { userId: msg.senderId });
    const convo = await ctx.runQuery(internal.conversations.getById, { id: msg.conversationId });

    const recipients = convo.participants.filter(p => p !== msg.senderId);
    if (recipients.length === 0) return;

    const isGroup = convo.type === "group";
    const title = isGroup
      ? `${sender.displayName} in ${convo.name || "Group"}`
      : sender.displayName;

    const preview =
      msg.kind === "text"     ? truncate(msg.body, 120)
      : msg.kind === "image"  ? "📷 Photo"
      : msg.kind === "video"  ? "🎬 Video"
      : msg.kind === "audio"  ? "🎤 Voice message"
      : msg.kind === "file"   ? `📄 ${msg.fileName || "File"}`
      : msg.kind === "sticker" ? "🌟 Sticker"
      : "New message";

    await fetch(`${process.env.MOBILE_BACKEND_URL}/api/send-push-internal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Push-Token": process.env.INTERNAL_PUSH_TOKEN!,
      },
      body: JSON.stringify({
        recipients,
        title,
        message: preview,
        action_url: `/chat/${convo._id}`,
        idempotency_key: `msg-${msg._id}`,
      }),
    });
  },
});
```

Then schedule this action from your `messages.send` mutation:

```ts
await ctx.scheduler.runAfter(0, internal.notifications.notifyNewMessage, { messageId });
```

### Missed call notification

When an incoming call rings out without being answered (your call timeout / decline flow):

```ts
await fetch(`${BACKEND_URL}/api/send-push-internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Push-Token": TOKEN },
  body: JSON.stringify({
    recipients: [calleeUserId],
    title: "Missed call",
    message: `From ${callerDisplayName}`,
    action_url: `/user/${callerUserId}`,
    idempotency_key: `missed-${callId}`,
  }),
});
```

### Incoming call notification (basic banner — see Path B note below)

Until WhatsApp-grade ringing calls are added via a separate manual EAS build, fire a banner so the user at least sees the call:

```ts
await fetch(`${BACKEND_URL}/api/send-push-internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Push-Token": TOKEN },
  body: JSON.stringify({
    recipients: [calleeUserId],
    title: "Incoming call",
    message: `${callerDisplayName} is calling — tap to answer`,
    action_url: `/call/${callId}?displayName=${encodeURIComponent(callerDisplayName)}`,
    idempotency_key: `incoming-${callId}`,
  }),
});
```

> **⚠ Limitation**: this is a one-shot heads-up banner with a single notification sound. It is NOT a ringing screen. Real ringing UX (CallKit/CallKeep + full-screen intent + repeated ringtone) is being added in a separate manual EAS build — see `PATH_B_CALLKEEP_PUSHKIT_PLAN.md` in this repo. **Do not** try to simulate ringing via repeated push pings — Emergent's relay is rate-limited and would deliver inconsistently.

### Mention / reply in group

Same as Message delivery, but the title can be more attention-grabbing:

```ts
title:   `${sender.displayName} mentioned you in ${convo.name}`,
message: truncate(msg.body, 120),
action_url: `/chat/${convo._id}?focus=${msg._id}`,
```

---

## 3. `action_url` — deeplink contract

The mobile app's tap-handler reads `data.action_url` (or `data.deeplink`) from the notification payload and routes accordingly.

Supported routes (must match expo-router paths):

| `action_url` | Behavior on tap |
|---|---|
| `/chat/<conversationId>` | Opens the chat screen for that conversation |
| `/chat/<conversationId>?focus=<messageId>` | Opens chat + scrolls to/highlights the message |
| `/call/<callId>` | Opens the incoming-call screen (will trigger the WebRTC join flow) |
| `/call/<callId>?displayName=<name>` | Same as above with caller name pre-filled |
| `/user/<userId>` | Opens that user's profile + recent-calls view |
| `/notifications` | Opens the notifications/diagnostic screen |
| `/(tabs)/chats` | Opens the chats tab |
| Any other `/`-prefixed path | Passed straight to `router.push(url)` |
| `https://...` URL | Opens the URL in the default browser |

If `action_url` is omitted, the notification is non-tappable (it opens the app to the last screen).

---

## 4. Migration from the legacy pipeline

You currently have:
- `api.mobilePush.registerMobileDevice` — receives the **Expo wrapped push token** from mobile + writes to `pushTokens` table
- A Convex action (probably) that reads `pushTokens` and POSTs to `https://exp.host/--/api/v2/push/send`

**Recommended migration:**

1. **Phase 1 (NOW)** — Keep `mobilePush.registerMobileDevice` running so legacy notifications still flow. Add the new `notifyNewMessage`-style actions that POST to `/api/send-push-internal`. You'll have BOTH paths firing for a few days.
2. **Phase 2** — Once you confirm mobile users are receiving notifications via the Emergent relay (smoke-test by sending a message → mobile receives push), DELETE the legacy `exp.host` POSTs from your Convex actions. Stop reading from `pushTokens`. The `mobilePush.registerMobileDevice` mutation can stay alive (no-op) for backward compat with older app builds, or be removed once all clients have updated.

If you want to skip Phase 1 and just cut over directly, that's also fine — mobile won't break because the legacy path's failure mode is silent.

---

## 5. Acceptance test

After deployment, ask the user to:

1. Sign in on the mobile app (causes mobile to POST `/api/register-push` with native token).
2. Send a message to themselves from a second account or device.
3. The mobile device should show a banner notification with sender name + preview, **even if the app is fully killed**.
4. Tap the notification → app opens to the correct chat screen.
5. Trigger a missed call → banner "Missed call from X" → tap → opens that user's profile.

---

## 6. Quick-confirm questions for backend

Please reply yes/no:

1. Do you have direct HTTP fetch capability in Convex actions (yes — Convex actions can call `fetch`)?
2. Can you read env vars (e.g. `MOBILE_BACKEND_URL`, `INTERNAL_PUSH_TOKEN`) from Convex via `process.env`?
3. What's the canonical name of the column on `messages` for sender ID — `senderId`, `userId`, `from`? Just confirm so I can update the spec.
4. Is the `conversations` row's recipient-list column called `participants`, `members`, or something else?
5. Are you OK with the action-scheduling pattern (`scheduler.runAfter(0, ...)`) for fire-and-forget push delivery so the `messages.send` mutation never blocks on the HTTP call?

---

## 7. Env vars you need

The mobile/FastAPI side has these set already (the deployer fills in the real values):

```
EMERGENT_PUSH_KEY=<filled at deploy>
INTERNAL_PUSH_TOKEN=<shared secret — ask the mobile agent to share>
```

Convex needs `MOBILE_BACKEND_URL` (= the FastAPI base URL, same as `EXPO_PUBLIC_BACKEND_URL` on mobile) and `INTERNAL_PUSH_TOKEN`. Set both on the Convex dashboard before going live.

— Smilers mobile agent (iter-127)
