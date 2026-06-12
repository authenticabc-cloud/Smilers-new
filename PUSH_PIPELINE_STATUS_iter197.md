# PUSH PIPELINE — STATUS & WEB-AGENT/CONVEX CHECKLIST (iter-197)

> Date: 2026-06-12. Author: mobile agent. Audience: the user + the web agent
> maintaining the Convex deployment (`aware-newt-456.convex.cloud`).

## What was proven working today (live device tests)

| Test | Result |
|---|---|
| FCM v1 send → user `01KQVQFGQ17WHDQ07F29FQ58VF` (SM-A075F) via preview backend | ✅ DELIVERED (call-style push, `calls-v4-smilers_never_cry` channel) |
| FCM v1 send → user `01KQD0V5GXE0KF558T597TC2D2` via preview backend | ✅ DELIVERED (message-style push) |
| Same sends via DEPLOYED backend (`app-migration-75.emergent.host`) | ❌ ALL 17 stored tokens dead (`UnregisteredError`) — stale tokens from old builds |

**Conclusion:** delivery infra (Firebase project `smilers-a4e07`, google-services.json,
admin SDK, channels) is healthy. The remaining unknown is whether **Convex actually
POSTs `/api/send-push-internal` on every message/incoming call, and to WHICH URL.**

## The contract (unchanged)

Convex actions must POST on new message / incoming call / missed call:

```
POST {MOBILE_BACKEND_URL}/api/send-push-internal
Header: X-Internal-Push-Token: {INTERNAL_PUSH_TOKEN}
Body: { recipients: [<OIDC sub, e.g. "01KQVQFG...">], title, message, action_url, idempotency_key }
```

- `MOBILE_BACKEND_URL` must currently be `https://smilers-chat-mobile.preview.emergentagent.com`
  (where the user's current build registers its tokens). After the user redeploys the
  backend AND rebuilds the app with the deployed URL, switch to
  `https://app-migration-75.emergent.host` (both env vars verified to share the same
  INTERNAL_PUSH_TOKEN).
- `recipients` MUST be the **OIDC `sub`** (uppercase ULID like `01KQVQFGQ17WHDQ07F29FQ58VF`),
  NOT Convex `users._id`.

## How ANYONE can now verify end-to-end (no shell needed)

iter-197 added a persistent trigger log. After making a test call/message:

```
GET https://smilers-chat-mobile.preview.emergentagent.com/api/push-debug?triggers=10
```

Each entry shows: timestamp, title, recipients Convex sent, which matched stored
tokens, real FCM success/error counts, and pruning info.

- **No entry appears** → Convex never POSTed (trigger missing/disabled, or pointed at another URL).
- **Entry with `unmatched` recipients** → user-id format mismatch (compare with `sample_user_ids` from `GET /api/push-debug`).
- **Entry with `fcm_errors`** → delivery-side issue (token dead → auto-pruned now).

## Backend improvements shipped in iter-197 (need REDEPLOY to reach production)

1. FCM data payload now carries `type` / `conversationId` / `callId` / `displayName`
   derived from `action_url` → taps on pushes now route correctly in the app.
2. Incoming-call pushes get a 45s TTL → no ghost rings after the caller hung up.
3. Dead tokens (`UnregisteredError`) are auto-pruned on send.
4. `send-push-internal` response now contains REAL per-token FCM results.
5. Trigger log (capped 300) + `?triggers=N` on `/api/push-debug`.

## Action items

- [ ] WEB AGENT / USER: confirm Convex env vars `MOBILE_BACKEND_URL` + `INTERNAL_PUSH_TOKEN`
      exist and point at the preview URL above; confirm the message/call triggers actually
      `scheduler.runAfter(0, ...)` the push action on EVERY new message + call start.
- [ ] USER: make one test call + one test message between the two phones (receiver app
      KILLED), then check `?triggers=10` (or ask the mobile agent to).
- [ ] LATER (production hardening): redeploy backend → rebuild app with deployed URL →
      switch Convex `MOBILE_BACKEND_URL` to the deployed URL. All three must move together.
