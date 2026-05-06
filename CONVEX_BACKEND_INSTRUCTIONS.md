# 📲 Backend Changes Needed to Send Push Notifications to Mobile App

Hi Hercules! Please apply the following changes to the Convex backend so the new Smilers native mobile app can receive push notifications for **incoming calls** and **messages**. The mobile app uses **Expo Push** (a free, unified service that delivers to APNs on iOS and FCM on Android in one call).

The mobile app will register its device token via `api.pushNotifications.registerMobileDevice` after login.

---

## STEP 1 — Extend the `pushIdentities` schema

**File:** `convex/schema.ts`

Add `expoPushToken` and `platform` fields to the `pushIdentities` table (keeping all existing fields). If `pushIdentities` doesn't exist yet, create it. Suggested shape:

```ts
pushIdentities: defineTable({
  userId: v.id("users"),
  // Existing web push fields (keep whatever you already have):
  endpoint: v.optional(v.string()),
  p256dh: v.optional(v.string()),
  auth: v.optional(v.string()),
  // NEW — native mobile fields:
  expoPushToken: v.optional(v.string()),
  platform: v.optional(v.union(v.literal("ios"), v.literal("android"), v.literal("web"))),
  deviceName: v.optional(v.string()),
  appVersion: v.optional(v.string()),
  lastSeenAt: v.optional(v.string()),
})
  .index("by_user", ["userId"])
  .index("by_expo_token", ["expoPushToken"]),
```

If you already have a different shape for `pushIdentities`, just add the four new optional fields (`expoPushToken`, `platform`, `deviceName`, `appVersion`) and the `by_expo_token` index. **Do not break existing web push fields.**

---

## STEP 2 — Add `registerMobileDevice` mutation

**File:** `convex/pushNotifications.ts`

Add this new mutation. It is called by the mobile app after login to register/refresh the device's Expo Push token:

```ts
import { mutation, action, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const registerMobileDevice = mutation({
  args: {
    expoPushToken: v.string(),
    platform: v.union(v.literal("ios"), v.literal("android")),
    deviceName: v.optional(v.string()),
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Find current user
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!user) throw new Error("User not found");

    // De-duplicate: if the same expoPushToken is registered to anyone else, remove it
    // (handles user logout/login-as-different-user on same device)
    const existingForToken = await ctx.db
      .query("pushIdentities")
      .withIndex("by_expo_token", (q) => q.eq("expoPushToken", args.expoPushToken))
      .collect();

    for (const row of existingForToken) {
      if (row.userId !== user._id) {
        await ctx.db.delete(row._id);
      }
    }

    // Upsert: if this user already has a row with this token, update; else insert
    const existingMine = existingForToken.find((r) => r.userId === user._id);
    const now = new Date().toISOString();

    if (existingMine) {
      await ctx.db.patch(existingMine._id, {
        platform: args.platform,
        deviceName: args.deviceName,
        appVersion: args.appVersion,
        lastSeenAt: now,
      });
      return existingMine._id;
    }

    return await ctx.db.insert("pushIdentities", {
      userId: user._id,
      expoPushToken: args.expoPushToken,
      platform: args.platform,
      deviceName: args.deviceName,
      appVersion: args.appVersion,
      lastSeenAt: now,
    });
  },
});

export const unregisterMobileDevice = mutation({
  args: { expoPushToken: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!user) return;
    const rows = await ctx.db
      .query("pushIdentities")
      .withIndex("by_expo_token", (q) => q.eq("expoPushToken", args.expoPushToken))
      .collect();
    for (const r of rows) {
      if (r.userId === user._id) await ctx.db.delete(r._id);
    }
  },
});
```

---

## STEP 3 — Add an Expo Push sending action

**File:** `convex/pushNotifications.ts` (same file, append)

This action POSTs to the Expo Push Service. Expo handles APNs/FCM internally — no Apple or Google credentials needed when the app is built with EAS managed credentials.

```ts
// Internal helper to fetch a user's mobile push tokens
export const getUserMobileTokens = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pushIdentities")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return rows
      .filter((r) => r.expoPushToken && (r.platform === "ios" || r.platform === "android"))
      .map((r) => ({ token: r.expoPushToken!, platform: r.platform!, _id: r._id }));
  },
});

// Internal helper to remove invalid tokens reported by Expo
export const removePushIdentity = internalAction({
  args: { rowId: v.id("pushIdentities") },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.pushNotifications.deletePushIdentityById, { rowId: args.rowId });
  },
});

export const deletePushIdentityById = mutation({
  args: { rowId: v.id("pushIdentities") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.rowId);
  },
});

/**
 * Send a push notification to a user's mobile device(s) via Expo Push Service.
 * Call this from message send / call initiate / status reactions / etc.
 */
export const sendExpoPushToUser = internalAction({
  args: {
    userId: v.id("users"),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.any()),
    // For incoming calls: high priority + custom sound + Answer/Decline buttons
    isCall: v.optional(v.boolean()),
    // Custom sound file (Android channel) — must match a sound bundled with the app
    sound: v.optional(v.string()),
    // Conversation ID for deep linking (msg) or Call ID (calls)
    conversationId: v.optional(v.string()),
    callId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tokens: Array<{ token: string; platform: string; _id: any }> = await ctx.runQuery(
      internal.pushNotifications.getUserMobileTokens,
      { userId: args.userId }
    );
    if (tokens.length === 0) return;

    const messages = tokens.map((t) => ({
      to: t.token,
      title: args.title,
      body: args.body,
      data: {
        ...(args.data || {}),
        conversationId: args.conversationId,
        callId: args.callId,
        type: args.isCall ? "call" : "message",
      },
      // Android channel + iOS interruption level
      channelId: args.isCall ? "calls" : "messages",
      priority: args.isCall ? "high" : "high",
      sound: args.sound || (args.isCall ? "ringtone" : "default"),
      // iOS critical alert / call categoryIdentifier (matches client-side category)
      categoryIdentifier: args.isCall ? "incoming-call" : undefined,
      // For Android incoming calls — show heads-up + ringing
      ttl: args.isCall ? 30 : 3600,
      _displayInForeground: true,
    }));

    // Expo Push API accepts up to 100 per request
    const chunks: any[][] = [];
    for (let i = 0; i < messages.length; i += 100) chunks.push(messages.slice(i, i + 100));

    for (const chunk of chunks) {
      try {
        const res = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
          },
          body: JSON.stringify(chunk),
        });
        const json: any = await res.json();
        const tickets = json?.data || [];
        // Clean up invalid tokens (DeviceNotRegistered)
        for (let i = 0; i < tickets.length; i++) {
          const ticket = tickets[i];
          const tokenInfo = tokens[i];
          if (
            ticket?.status === "error" &&
            ticket?.details?.error === "DeviceNotRegistered" &&
            tokenInfo
          ) {
            await ctx.runAction(internal.pushNotifications.removePushIdentity, {
              rowId: tokenInfo._id,
            });
          }
        }
      } catch (e) {
        console.warn("[expo-push] send failed:", e);
      }
    }
  },
});
```

---

## STEP 4 — Trigger pushes from `messages.send` and `calls.initiateCall`

### A) For every message sent

**File:** `convex/messages.ts`

Inside the existing `send` mutation, AFTER inserting the message and updating `lastMessageTime/lastMessageText`, schedule a push for each recipient (excluding the sender). Add this near the end of the mutation:

```ts
// After: const messageId = await ctx.db.insert("messages", { ... });
// And after updating conversation.lastMessage*
const conversation = await ctx.db.get(args.conversationId);
if (conversation) {
  const sender = await ctx.db.get(senderId); // senderId = current user id you already have
  const senderName = sender?.name || "Smilers user";
  const previewText =
    args.encrypted ? "🔒 New message" :
    args.type === "text" ? (args.text || "").slice(0, 100) :
    args.type === "image" ? "📷 Photo" :
    args.type === "video" ? "🎥 Video" :
    args.type === "voice" ? "🎤 Voice note" :
    args.type === "file"  ? "📎 File"  :
    args.type === "location" ? "📍 Location" :
    args.type === "poll" ? "📊 Poll" : "New message";

  for (const recipientId of conversation.participants) {
    if (recipientId === senderId) continue;

    // Respect "muted" + "blocked" + per-user notification prefs
    const recipient = await ctx.db.get(recipientId);
    if (!recipient) continue;
    if (conversation.type === "group" && recipient.notifGroups === false) continue;
    if (conversation.type === "direct" && recipient.notifMessages === false) continue;

    // Send via Expo Push
    await ctx.scheduler.runAfter(0, internal.pushNotifications.sendExpoPushToUser, {
      userId: recipientId,
      title: conversation.type === "group"
        ? `${senderName} in ${conversation.name || "Group"}`
        : senderName,
      body: previewText,
      conversationId: args.conversationId,
      isCall: false,
    });

    // Also keep your existing web push call here (do not remove it)
  }
}
```

### B) For every incoming call

**File:** `convex/calls.ts`

Inside the existing `initiateCall` mutation, AFTER creating the call doc, send a high-priority push with the **incoming-call** category:

```ts
// After: const callId = await ctx.db.insert("calls", { ... });
const conversation = await ctx.db.get(args.conversationId);
const caller = await ctx.db.get(callerId);
const callerName = caller?.name || "Smilers user";

if (conversation) {
  for (const recipientId of conversation.participants) {
    if (recipientId === callerId) continue;
    const recipient = await ctx.db.get(recipientId);
    if (!recipient || recipient.notifCalls === false) continue;

    await ctx.scheduler.runAfter(0, internal.pushNotifications.sendExpoPushToUser, {
      userId: recipientId,
      title: args.callType === "video" ? "Incoming video call" : "Incoming voice call",
      body: callerName,
      conversationId: args.conversationId,
      callId: callId as string,
      isCall: true,
      sound: "ringtone",  // matches the bundled mobile asset ringtone.mp3
    });

    // Keep your existing web push call here
  }
}
```

---

## STEP 5 — Deploy

After making the above changes:

```bash
npx convex deploy
```

That's it! The mobile app will start receiving:
- 🔔 **Message pushes** with sender name + preview, deep-linking to the chat on tap
- 📞 **Incoming call pushes** with custom Smilers ringtone + Answer/Decline buttons

---

## Notes

- **No Firebase/APNs setup needed** — Expo Push is a managed proxy that handles both. The mobile app is built with EAS-managed credentials.
- **Existing web push continues to work** — these changes are purely additive; web push code paths are untouched.
- **Token cleanup is automatic** — invalid tokens (uninstalls, etc.) are removed from `pushIdentities` based on Expo's response.
- **Privacy** — message preview respects `encrypted` flag (shows "🔒 New message" instead of plaintext for E2EE messages).

If you have questions or hit any errors, paste them back and I (the mobile-side agent) can adjust the spec.
