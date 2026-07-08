# Convex Decline-Call fix — SAFE version (for the Hercules web-app / Convex project)

## Why not the original draft
The draft in Ashwini's note calls the **FCM v1** endpoint
(`/v1/projects/{PROJECT_ID}/messages:send`) with `Authorization: Bearer ${FCM_SERVER_KEY}`.
FCM v1 requires a **short-lived OAuth2 access token minted from a service account**,
NOT a static "server key". A static server key on the v1 endpoint returns **401**,
so Decline would still silently fail. (Static server keys only worked on the
deprecated legacy `/fcm/send` endpoint, which Google is turning down.)

## The reliable fix — reuse the Python backend that ALREADY sends FCM v1 correctly
The Smilers Python relay already implements FCM v1 with the Firebase Admin SDK
(service-account credentials) and already understands the `call-declined` event:
it looks up the caller's stored device token in MongoDB and pushes a silent
`type: "call-declined"` control message that the app already handles.

So Convex's `declineCall` just needs to POST to that existing endpoint. No FCM
credentials or google-auth in Convex — only the relay URL.

### convex/calls.ts

```ts
import { action, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";

export const declineCall = mutation({
  args: { callId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    // --- existing logic: fetch call doc + patch status ---
    const call = await ctx.db.get(args.callId as Id<"calls">);
    if (!call) throw new ConvexError("Call not found");
    await ctx.db.patch(call._id, { status: "declined" });

    // --- NEW: tell the caller immediately via the existing push relay ---
    // Use the caller's ACCOUNT/USER identity string that the relay maps to a
    // device token in MongoDB (same value used as `recipients` for incoming
    // call/message pushes). Adapt `call.callerId` to whatever your schema stores.
    await ctx.scheduler.runAfter(0, internal.calls.notifyCallerDeclined, {
      callerId: String(call.callerId),
      conversationId: call.conversationId ?? "",
      callId: String(call._id),
    });
  },
});

export const notifyCallerDeclined = action({
  args: {
    callerId: v.string(),
    conversationId: v.string(),
    callId: v.string(),
  },
  handler: async (_ctx, args) => {
    const relay = process.env.PUSH_RELAY_URL; // e.g. https://<smilers-backend-host>
    if (!relay) {
      console.warn("[declineCall] PUSH_RELAY_URL not set");
      return;
    }
    // The relay already handles event "call-declined": it resolves the
    // recipient's stored FCM/APNs token and sends a silent control push
    // (type: "call-declined") that the app is wired to act on.
    const res = await fetch(`${relay.replace(/\/$/, "")}/api/notify-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "call-declined",
        recipients: [args.callerId],
        conversation_id: args.conversationId,
        call_id: args.callId,
      }),
    });
    if (!res.ok) {
      console.warn("[declineCall] relay notify failed:", res.status, await res.text());
    } else {
      console.log("[declineCall] call-declined relayed for callId=", args.callId);
    }
  },
});
```

### Convex env var (only one)
- `PUSH_RELAY_URL` = the public base URL of the Smilers Python backend
  (the same host the app already POSTs `/api/notify-event` to).

> Confirm the exact JSON field names the relay's `/api/notify-event` expects
> (event, recipients, conversation_id, call_id) against the deployed server.py;
> the payload above matches the NotifyEventBody the relay already parses.

## If you truly must call FCM directly from Convex instead
Then you need a **service account** (Firebase console → Project settings → Service
accounts → generate key) and must mint an OAuth2 access token per request
(`https://www.googleapis.com/auth/firebase.messaging` scope) using google-auth —
a static server key will NOT authenticate against the v1 endpoint. The relay
approach above avoids all of this.
