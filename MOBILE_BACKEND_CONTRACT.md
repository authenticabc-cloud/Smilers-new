# Smilers Mobile ↔ Convex Backend Contract

> **Audience**: Backend agent maintaining the Smilers Convex codebase
> (web app and mobile app share the same Convex deployment).
>
> **Purpose**: This document enumerates EVERY backend function the mobile
> app calls, the exact args/return shape it expects, and the failure
> behavior it relies on. Hand this to the backend agent so we stop the
> client-side guess-and-patch cycle.
>
> **Convex URL**: `EXPO_PUBLIC_CONVEX_URL` (configured in `/app/frontend/.env`)
>
> **All paths use `anyApi`** in the client (we don't import generated
> types). The client tolerates missing functions IF wrapped in
> `useSafeConvexQuery`, but raw `useQuery` + raw `useMutation` calls
> CRASH the app on `CouldNotFindFunction`. Endpoints listed as
> "MUST EXIST" must not be removed without a corresponding mobile patch.

---

## 🔴 P0 — CURRENTLY FAILING ENDPOINTS

### 1. `scheduling.scheduleMessageMobile` AND `scheduledMessages.create`

**Status**: ❌ BOTH endpoints return `Server Error` to the mobile client.

User reported screenshot diagnostic from iter-115:
```
[CONVEX M(scheduledMessages:create)] [Request ID: f4db30e0c8853c09]
Server Error
Called by client
```

This is the FALLBACK endpoint after the primary `scheduling.scheduleMessageMobile`
also fails. So BOTH are broken from the mobile side. The mobile app sends
EXACTLY these args (verified, with iter-113 hardening):

```ts
{
  recipient: string,    // human-readable name, max 200 chars, e.g. "Angela Yeboah"
  message: string,      // body text, max 5000 chars
  date: string,         // ISO date "YYYY-MM-DD", e.g. "2026-06-05"
  time: string,         // 24h time "HH:MM", e.g. "07:21"
  repeat: "once" | "daily" | "weekly" | "monthly",
  active: boolean,      // currently always true at creation time
}
```

**NO `conversationId`, `userId`, `_creationTime`, or other fields** are passed.

**Required handler (Convex `mutation`)**:
```ts
// convex/scheduling.ts  (or scheduledMessages.ts — both names accepted)
export const scheduleMessageMobile = mutation({
  args: {
    recipient: v.string(),
    message: v.string(),
    date: v.string(),
    time: v.string(),
    repeat: v.union(
      v.literal("once"),
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("monthly"),
    ),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = (await getCurrentUserId(ctx))!;
    const scheduleId = await ctx.db.insert("scheduledMessages", {
      userId,
      recipient: args.recipient,
      message: args.message,
      date: args.date,
      time: args.time,
      repeat: args.repeat,
      active: args.active,
      createdAt: Date.now(),
    });
    return scheduleId;
  },
});

// Optional alias for backward compatibility with web app
export const create = scheduleMessageMobile;
```

**On the mobile side, we also call**:
- `scheduledMessages.listMine({}) → ScheduledMessage[]`
- `scheduledMessages.update({ scheduleId, recipient, message, date, time, repeat, active })`
- `scheduledMessages.setActive({ scheduleId, active })`
- `scheduledMessages.remove({ scheduleId })`

Expected `ScheduledMessage` shape:
```ts
{
  _id: Id<"scheduledMessages">,
  _creationTime: number,
  recipient: string,
  message: string,
  date: string,    // "YYYY-MM-DD"
  time: string,    // "HH:MM"
  repeat: "once" | "daily" | "weekly" | "monthly",
  active: boolean,
  // anything else is fine — mobile ignores extras
}
```

**Action for backend agent**: Audit the current handler's arg validator
— it's almost certainly rejecting one of the 6 fields above. Either
relax the validator OR add the missing arg the handler expects. Once
fixed, share the validator definition so we can mirror it on mobile.

---

### 2. `conversations.listArchived`

**Status**: ⚠ Mobile previously **CRASHED** ("Smilers has stopped" native
dialog) when this endpoint didn't exist. Patched in iter-115 to degrade
gracefully via `useSafeConvexQuery` with a fallback to
`conversations.getArchived` (legacy name). Either name works.

**Required handler**:
```ts
export const listArchived = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await getCurrentUserId(ctx))!;
    // Return only conversations where the current user has set
    // `archived: true` (per-user flag, not global).
    const all = await ctx.db.query("conversations").collect();
    return all.filter(c => c.archivedBy?.includes(userId));
    // ... or whatever the existing archival schema is. The mobile
    //     client just needs an array back.
  },
});
```

Expected return shape (each item):
```ts
{
  _id: Id<"conversations">,
  name?: string,            // group name OR
  otherUserName?: string,   // direct chat partner name
  lastMessageText?: string,
  lastMessageTime?: string, // ISO timestamp
}
```

---

### 3. Push device registration: `mobilePush.registerMobileDevice` AND `pushNotifications.registerMobileDevice`

**Status**: ⚠ Mobile registers successfully (`Status: registered`), but
the "Remote self-test" via `https://exp.host/--/api/v2/push/send` is
**failing**. That's a different problem (likely FCM project mismatch or
Expo receipt error). The endpoints below ARE working for token storage.

The mobile client tries the primary, then falls back to legacy:

```ts
// Primary
mobilePush.registerMobileDevice({
  expoPushToken: "ExponentPushToken[xxx]",
  platform: "android" | "ios",
  deviceName: "Pixel 7",
  appVersion: "2.0.0",
})

// Fallback (legacy web-app name)
pushNotifications.registerMobileDevice({ ...same args })
```

Same for `unregisterMobileDevice({ expoPushToken })`.

**Action for backend agent**: Confirm at least ONE of these endpoints exists
on the deployment. Either is fine; mobile probes both. If both exist,
they should write to the same `mobileDevices` table so the per-user
"send push to all my devices" logic works regardless of which one fired.

---

## 🟠 P1 — DEFINED, WORKING, BUT NEEDS WIRING-AUDIT

### 4. `messages.editText` / `editMessage` / `updateMessage`

Mobile probes ALL THREE function names because different deployments
expose different names. ONE of them must exist:

```ts
// Any of these signatures will work
editText({ messageId, newText })
editMessage({ messageId, newText })
updateMessage({ messageId, newText })
```

If none exists, the user gets a friendly "Edit failed" alert (no crash).

### 5. `messages.send` — Reply field name MUST be `replyToId`

**Background**: iter-101 normalized the mobile client to send BOTH
`replyToId` AND `replyToMessageId` on every message-send payload, to be
compatible with both schema variants. To match the web app spec, the
backend should:

- **Accept arg name**: `replyToId?: Id<"messages">`
- **Store field name**: `replyToId` on the message row
- (Tolerate `replyToMessageId` as a synonym for one release cycle.)

Mobile reads BOTH `item.replyToId` and `item.replyToMessageId` so either
name on the row works.

### 6. `messages.send` — supported payload variants

The mobile send-message mutation can carry any of these payload shapes
(spread into a single args object, all OPTIONAL except the basics):

```ts
{
  conversationId: Id<"conversations">,
  text: string,            // required for text messages
  type?: "text" | "image" | "voice" | "gif" | "location" | "poll",

  // For images / voice / gif:
  attachmentStorageId?: Id<"_storage">,
  attachmentMimeType?: string,
  attachmentDurationMs?: number,   // voice notes
  attachmentWidth?: number,        // images
  attachmentHeight?: number,

  // For replies (BOTH sent for backward compat)
  replyToId?: Id<"messages">,
  replyToMessageId?: Id<"messages">,

  // For location share
  location?: { lat: number, lng: number, label?: string },

  // For poll
  poll?: { question: string, options: string[], multi?: boolean },

  // For E2EE (when sender encrypts client-side)
  encrypted?: boolean,
  encryptedPayload?: string,   // base64 / hex of the ciphertext
  encryptionKeyId?: string,
}
```

The strict validator should **allow extras** OR the backend agent
should add `v.optional(...)` for ALL the above. Strict rejection of
ANY of these breaks the user's send flow with `Server Error`.

---

## 🟡 P2 — CALLS / WEBRTC

### 7. `calls.*` endpoints (working — DO NOT BREAK)

```ts
calls.initiateCall({ peerUserId, conversationId, callType: "audio" | "video" })
  → callId

calls.getIncomingCall({}) → { _id, callerId, callType, ... } | null
calls.answerCall({ callId })
calls.declineCall({ callId })
calls.endCall({ callId })
calls.heartbeat({ callId })
```

### 8. `signaling.*` — WebRTC SDP/ICE bridge

```ts
signaling.send({ callId, peerUserId, payload: object })
signaling.poll({ callId }) → SignalingMessage[]
signaling.markConsumed({ ids: Id[] })
```

Mobile polls `signaling.poll` every ~750ms when a call is active. Each
`SignalingMessage` item must include `{ _id, payload, fromUserId, ... }`.
The payload is opaque to the backend (SDP/ICE-candidate JSON).

### 9. `screenSharing.*` — Standalone screen-share session

```ts
screenSharing.requestScreenShare({ conversationId, includeAudio?, language? })
  → { _id, sessionId } | shareId

screenSharing.acceptScreenShare({ sessionId })
screenSharing.declineScreenShare({ sessionId })
screenSharing.listIncoming({}) → IncomingShareRequest[]
screenSharing.getActiveSession({}) → ActiveShareSession | null
screenSharing.pollSignals({ sessionId }) → SignalingMessage[]
screenSharing.sendSignal({ sessionId, peerUserId, payload })

// Switch sharer mid-session (sender ↔ receiver flip)
screenSharing.requestSwitch({ sessionId })
screenSharing.approveSwitch({ sessionId })
screenSharing.declineSwitch({ sessionId })
```

Each `IncomingShareRequest` should expose `{ shareId, requesterId,
requesterName, conversationId, audio, language }`. The mobile-side
modal (`IncomingScreenShareModal`) reads all of these.

---

## 🟡 P2 — CHAT / CONTENT

### 10. `conversations.*`

```ts
conversations.listConversations({}) → Conversation[]
conversations.listGroups({}) → GroupConversation[]
conversations.listRegulations({}) → ChannelConversation[]  // ("Regulations" channels)
conversations.getConversation({ conversationId }) → Conversation | null
conversations.getGroupDetails({ conversationId }) → GroupDetails | null
conversations.getOrCreateDirect({ otherUserId }) → Id<"conversations">
conversations.getOrCreateDirectConversation({ otherUserId }) → Id   // alias
conversations.createBroadcast({ name, memberIds }) → Id
```

> ⚠ **CRITICAL — Diary safety**: The mobile app DOES NOT call
> `getOrCreateDirect({ otherUserId: myUserId })` for the "Diary" feature
> anymore. iter-110 moved Diary to 100% AsyncStorage after a serious
> cross-chat data leak. Please ensure `getOrCreateDirect` NEVER returns
> a conversation where `otherUserId === currentUserId` (it should error
> or return a special self-conversation marker). Self-conversation must
> be uniquely scoped to the caller.

### 11. `messages.*`

```ts
messages.list({ conversationId, paginationOpts? }) → PaginatedMessages
messages.markRead({ conversationId })
messages.markDelivered({ conversationId })       // called from push handler
messages.toggleStar({ messageId })
messages.toggleReaction({ messageId, emoji })
messages.deleteMessage({ messageId })
messages.votePoll({ messageId, optionIndex })
messages.generateUploadUrl({}) → string
messages.getStorageUrl({ storageId }) → string
```

### 12. `typing.*`

```ts
typing.setTyping({ conversationId, isTyping: boolean })
```

### 13. `starred.getStarredMessages`

```ts
starred.getStarredMessages({}) → Message[]
```

---

## 🟡 P2 — USER / CONTACTS / AUTH

### 14. `users.*`

```ts
users.getCurrentUser({}) → CurrentUser | null
users.getUserById({ userId }) → User | null
users.searchUsers({ query: string }) → User[]
users.updateCurrentUser({ ...partial }) → void   // alias of updateProfile
users.updateProfile({ ...partial }) → void
users.deleteAccount({}) → void
```

Mobile spreads partial updates into `updateProfile`. Important keys
mobile may send:
- `displayName`
- `bio`
- `avatar` (storage id)
- `notifications: Record<string, boolean>` (per-category toggle)
- `language`
- `phone`, `email`
- `preferences: { ... }`

### 15. `contacts.*`

```ts
contacts.getContacts({}) → Contact[]
contacts.getPendingRequests({}) → Request[]
contacts.getOutgoingRequests({}) → Request[]
contacts.sendRequest({ targetUserId })
contacts.sendRequestByPhone({ phone })
contacts.acceptRequest({ requestId })
contacts.rejectRequest({ requestId })
contacts.cancelRequest({ requestId })
```

### 16. `blocking.*`

```ts
blocking.getBlockedUsers({}) → User[]
blocking.unblockUser({ userId })
// Note: block is done from the chat header menu — but mobile currently
// does NOT have a `blocking.blockUser` call. If the backend has one,
// mobile will wire it in a follow-up.
```

### 17. `privacy.*`

```ts
privacy.getSettings({}) → PrivacySettings
privacy.updateSettings({ ...partial })
```

### 18. `phoneAuthAction.*`

```ts
phoneAuthAction.sendOtp({ phone })
phoneAuthAction.verifyOtp({ phone, code })
```

---

## 🟢 P2 — DEVOTIONALS / STATUSES / GROUPS

### 19. `devotionals.*` (working as of iter-100)

```ts
devotionals.getFeed({ paginationOpts }) → PaginatedDevotionals
devotionals.getMyDevotionals({}) → Devotional[]
devotionals.create({
  type: "text" | "voice" | "video",
  title?: string,
  body?: string,
  storageId?: Id<"_storage">,
  mimeType?: string,
  duration?: number,
  fileSize?: number,
})
devotionals.remove({ devotionalId })
devotionals.getPreferences({}) → { filter: "all"|"contacts"|"selected", ... }
devotionals.updatePreferences({ filter, selectedUserIds? })
devotionals.getViewerLanguage({}) → string  // e.g. "en"
devotionals.generateUploadUrl({}) → string
```

Each `Devotional` item must expose:
```ts
{
  _id,
  authorId, authorName, authorAvatar?,
  type: "text" | "voice" | "video",
  title?: string,
  body?: string,             // ORIGINAL text
  translations?: Record<string, string>, // { "en": "...", "fr": "..." }
  detectedLanguage?: string, // source language
  storageId?: Id<"_storage">,
  mimeType?: string,
  duration?: number,
  createdAt: number,
}
```

### 20. `statuses.*`

```ts
statuses.create({ type, storageId?, text?, durationHours? }) → Id
statuses.getMyStatuses({}) → Status[]
statuses.listStatusGroups({}) → StatusGroup[]
statuses.listForUser({ userId }) → Status[]
statuses.markViewed({ statusId })
```

### 21. `communities.createCommunity` (just starting — admin tooling next)

```ts
communities.createCommunity({ name, description?, kind: "public"|"private" })
  → communityId
```

More endpoints needed for admin tooling (P1 upcoming):
```ts
communities.listMyCommunities()         // NEEDED
communities.listMembers({ communityId }) // NEEDED
communities.addMember({ communityId, userId })  // NEEDED
communities.removeMember({ communityId, userId }) // NEEDED
communities.listChannels({ communityId }) // NEEDED
communities.createChannel({ communityId, name, kind }) // NEEDED
communities.deleteChannel({ channelId })  // NEEDED
communities.setMemberRole({ communityId, userId, role: "admin"|"member" }) // NEEDED
communities.pinMessage({ messageId })     // NEEDED
communities.unpinMessage({ messageId })   // NEEDED
```

### 22. `conferences.*` / `conferenceRoom.*`

```ts
conferences.create({ name, conversationId? }) → conferenceId
conferences.startConference({ conferenceId })
conferenceRoom.removeParticipant({ conferenceId, userId })
conferenceRoom.suspendParticipant({ conferenceId, userId })
```

### 23. `chatOnce.*` — Anonymous 24h chats

```ts
chatOnce.create({}) → { code, conversationId, expiresAt }
chatOnce.generateCode({ conversationId }) → string
chatOnce.join({ conversationId })
chatOnce.joinByCode({ code }) → conversationId
```

---

## 💰 P3 — MONETIZATION

### 24. `wallet.*`

```ts
wallet.getMyWithdrawalMethods({}) → WithdrawalMethod[]
wallet.addWithdrawalMethod({ kind, details })
wallet.removeWithdrawalMethod({ methodId })
wallet.setDefaultMethod({ methodId })
wallet.getMyWithdrawals({}) → Withdrawal[]
wallet.requestWithdrawal({ amount, methodId, currency? })
```

### 25. `transfers.*`

```ts
transfers.sendMoney({ recipientUserId, amount, currency, note? }) → transferId
transfers.requestMoney({ payerUserId, amount, currency, note? }) → requestId
transfers.respondToRequest({ requestId, action: "accept"|"decline" })
transfers.getPendingRequests({}) → MoneyRequest[]
transfers.getTransferHistory({}) → Transfer[]
```

### 26. `earnings.*`

```ts
earnings.getMyProfile({}) → { totalEarned, currentBalance, ... }
earnings.getMyTransactions({}) → Transaction[]
earnings.getMyReferrals({}) → Referral[]
earnings.getOrCreateReferralCode({}) → string
```

### 27. `premium.*`

```ts
premium.getPremiumStatus({}) → { active, plan, expiresAt? }
premium.generateLicenseCode({ kind }) → string  // admin-only
```

### 28. `ads.*` + `adCreditCodes.*`

```ts
ads.create({ title, body, mediaStorageId?, linkUrl?, ... }) → adId
ads.generateUploadUrl({}) → string
ads.listMyAds({}) → Ad[]
ads.listApproved({ paginationOpts }) → Ad[]
ads.searchAds({ query }) → Ad[]
ads.recordClick({ adId })
// Moderation (admin)
ads.listPendingForReview({}) → Ad[]
ads.approveAd({ adId })   // and `approve({ adId })` — both names probed
ads.rejectAd({ adId, reason })  // and `reject({...})`
ads.listPending({}) → Ad[]  // legacy

adCreditCodes.generateCreditCode({ amount })
adCreditCodes.generateLifetimeCode({})
adCreditCodes.listCodes({}) → CreditCode[]
adCreditCodes.redeemCode({ code })
adCreditCodes.revokeCode({ codeId })
adCreditCodes.getMyAdCredits({}) → number
```

---

## 🛡 P3 — TRUST & SAFETY

### 29. `trustees.*`

```ts
trustees.getMyTrustees({}) → Trustee[]
trustees.addTrustee({ trusteeUserId, role })
trustees.removeTrustee({ trusteeId })
```

### 30. `admin.*` — Admin panel (Trusted role required)

```ts
admin.getStats({}) → { totalUsers, mau, ... }
admin.listUsers({ paginationOpts, query? }) → User[]
admin.setRole({ userId, role: "admin"|"trustee"|"user" })
admin.suspendUser({ userId, reason })
admin.unsuspendUser({ userId })
admin.listReports({}) → Report[]
admin.resolveReport({ reportId, action })
```

### 31. `support.submitTicket`

```ts
support.submitTicket({ category, subject, body, attachmentStorageId? })
```

---

## 💾 P3 — FILES / STORAGE

### 32. `files.*` / `storage.*` / `messages.generateUploadUrl`

All three should work and return Convex `_storage` URLs:

```ts
files.generateUploadUrl({}) → string
files.getUrl({ storageId }) → string

storage.getUrl({ storageId }) → string

messages.generateUploadUrl({}) → string
messages.getStorageUrl({ storageId }) → string
```

Mobile probes whichever is available.

---

## 🧠 P3 — AI / DIARY (LOCAL)

### 33. `ai.chat.*` — Smilers AI assistant

```ts
ai.chat.generateResponse({ conversationId, prompt }) → string
ai.chat.getMessages({ conversationId, paginationOpts }) → PaginatedAIMessages
```

### 34. `diary.*` — Personal notes (RESURRECTED in iter-117 with proper isolation)

**Status**: User has asked for cloud sync of the Diary feature (so notes
move between web app + mobile app + multiple mobile devices for the
same user). iter-110 had ripped this out due to a cross-user data leak
caused by `getOrCreateDirect({ otherUserId: myUserId })`. iter-117
re-introduces it through a DEDICATED, PROPERLY-ISOLATED `diary.*`
namespace.

**🚨 CRITICAL ISOLATION REQUIREMENT 🚨**: Every diary query/mutation
MUST derive `userId` from the auth context (`getCurrentUserId(ctx)`).
The handler must NEVER accept a `userId` arg from the client side.
Without this, the cross-user leak that broke iter-110 reproduces.

**Schema**:

```ts
// convex/schema.ts (add to existing schema)
diaryEntries: defineTable({
  userId: v.id("users"),                    // OWNER — set by handler from auth context
  kind: v.union(                            // entry kind
    v.literal("text"),
    v.literal("image"),
    v.literal("video"),
    v.literal("audio"),
    v.literal("file"),
    v.literal("gif"),
  ),
  text: v.optional(v.union(v.string(), v.null())),
  attachment: v.optional(v.union(           // forwarded attachment metadata
    v.object({
      storageId: v.optional(v.union(v.id("_storage"), v.string(), v.null())),
      mediaUrl: v.optional(v.union(v.string(), v.null())),
      fileUrl: v.optional(v.union(v.string(), v.null())),
      fileName: v.optional(v.union(v.string(), v.null())),
      mimeType: v.optional(v.union(v.string(), v.null())),
      fileSize: v.optional(v.union(v.number(), v.null())),
      audioDuration: v.optional(v.union(v.number(), v.null())),
      thumbnailUrl: v.optional(v.union(v.string(), v.null())),
    }),
    v.null(),
  )),
  forwardedFrom: v.optional(v.union(        // provenance when forwarded
    v.object({
      conversationId: v.optional(v.union(v.string(), v.null())),
      conversationName: v.optional(v.union(v.string(), v.null())),
      originalSenderName: v.optional(v.union(v.string(), v.null())),
      originalMessageId: v.optional(v.union(v.string(), v.null())),
      originalCreationTime: v.optional(v.union(v.number(), v.null())),
    }),
    v.null(),
  )),
  clientCreationTime: v.optional(v.number()), // for migration of offline drafts
}).index("by_user_and_creation", ["userId", "_creationTime"]),
```

**Required handlers**:

```ts
// convex/diary.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserId } from "./auth"; // your existing helper

export const listEntries = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return [];
    // Order newest-LAST (matches mobile's chat-bubble newest-at-bottom convention).
    const entries = await ctx.db
      .query("diaryEntries")
      .withIndex("by_user_and_creation", q => q.eq("userId", userId))
      .order("asc")
      .collect();
    // Return shape MUST match mobile DiaryEntry interface (see
    // /app/frontend/src/lib/diaryStore.ts:DiaryEntry).
    return entries.map(e => ({
      _id: e._id,
      _creationTime: e._creationTime,
      kind: e.kind,
      text: e.text ?? null,
      attachment: e.attachment ?? null,
      forwardedFrom: e.forwardedFrom ?? null,
    }));
  },
});

export const appendEntry = mutation({
  args: {
    kind: v.union(
      v.literal("text"),
      v.literal("image"),
      v.literal("video"),
      v.literal("audio"),
      v.literal("file"),
      v.literal("gif"),
    ),
    text: v.optional(v.union(v.string(), v.null())),
    attachment: v.optional(v.union(v.any(), v.null())),
    forwardedFrom: v.optional(v.union(v.any(), v.null())),
    clientCreationTime: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const entryId = await ctx.db.insert("diaryEntries", {
      userId,           // ← derived from auth context — NEVER from args
      kind: args.kind,
      text: args.text ?? null,
      attachment: args.attachment ?? null,
      forwardedFrom: args.forwardedFrom ?? null,
      clientCreationTime: args.clientCreationTime,
    });
    return entryId;
  },
});

export const deleteEntry = mutation({
  args: { entryId: v.id("diaryEntries") },
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const entry = await ctx.db.get(args.entryId);
    if (!entry || entry.userId !== userId) {
      // SECURITY: deny silently rather than reveal existence.
      throw new Error("Not found");
    }
    await ctx.db.delete(args.entryId);
  },
});

export const clearDiary = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const all = await ctx.db
      .query("diaryEntries")
      .withIndex("by_user_and_creation", q => q.eq("userId", userId))
      .collect();
    for (const e of all) await ctx.db.delete(e._id);
  },
});
```

**Mobile behavior when these endpoints are deployed**:
- `app/diary.tsx` probes `api.diary.listEntries({})` via `useSafeConvexQuery`
- If the query returns an array, mobile flips to cloud-mode → header subtitle changes from "Saved on this device" → "Synced with Smilers cloud"
- Any locally-saved entries (from offline use) get flushed to cloud via `appendEntry` on first successful list, then removed from local AsyncStorage
- All new writes (send, delete, clear) hit the cloud first; local AsyncStorage is the fallback
- Long-press on any entry → Copy / Forward to a chat / Delete (added in iter-117)

**Mobile behavior when these endpoints are NOT deployed**:
- `useSafeConvexQuery` catches the `CouldNotFindFunction` and returns `null`
- Mobile stays in local-only mode (identical to iter-111 behavior)
- No crashes, no error toasts, graceful degradation

---

## 📋 ACTION ITEMS FOR BACKEND AGENT

> 🆕 **iter-124 updates** — the user is hitting 2 new Server-Error endpoints
> that need backend handler fixes:

### 🔴 P0 — `chatOnce.joinByCode` throws Server Error

The user reports `[CONVEX M(chatOnce:joinByCode)] Server Error` when joining
with a valid 6-character code that another user just generated via
`chatOnce.create` from the web app. The function exists but the handler is
throwing. Mobile sends EXACTLY:
```ts
joinByCode({ code: "XXXXXX" })   // 6-char uppercase alphanumeric
```

Likely candidates for the bug:
- Strict argument validator rejecting the case (only accepts lowercase?)
- Throwing when the matching session is already joined by 2 participants
- Throwing on missing required user-side state (premium check?)
- Reading from a missing index on the chatOnce table

Mobile has been hardened in iter-124 to ALSO try `chatOnce.join({ code })`
as a fallback (legacy/alias name) — please confirm at least ONE of these
two endpoints works with `{ code: string }`.

### 🔴 P0 — `scheduledMessages.setActive` throws Server Error

User reports `[CONVEX M(scheduledMessages:setActive)] Server Error` when
tapping the toggle switch on a scheduled message. The function exists per
iter-120 backend update, but the handler errors. Mobile sends:
```ts
setActive({ scheduleId: Id<"scheduledMessages">, active: boolean })
```

Mobile iter-124 falls back to `scheduledMessages.update` with the full
payload + flipped `active` flag if `setActive` fails — please confirm
either path works.

### 🟠 P1 — `scheduledMessages.listMine` returns empty on mobile but populated on web

User has Angela Yeboah's "Happy birthday" schedule visible on the WEB app
but not on the MOBILE app's `/scheduled` screen, even though both share the
same Convex deployment and same auth identity. Likely cause: the handler
uses a different field name to scope user (`createdBy` vs `userId`) AND
mobile + web are inserting with different field names, OR the auth context
identity differs between platforms. Please verify the same handler returns
the same set for the same authenticated user regardless of platform.

---

### Earlier action items (still relevant):

1. **🔴 Fix `scheduling.scheduleMessageMobile` AND `scheduledMessages.create`** —
   inspect the validator, share the rejection details OR fix the
   validator so the mobile payload (Section 1 above) is accepted.

2. **🔴 Verify Expo→FCM delivery** — Run a remote self-test from your
   side using the user's Expo push token
   `ExponentPushToken[15OXCFHAXv_92aUr_slnfF]` via Expo's API. If the
   receipt fails, the FCM V1 project id in the credentials may not match
   `smilers-a4e07`. If the receipt is OK, the backend's "send push when
   message arrives" code path is the gap.

3. **🟠 Verify `messages.send` validator** — confirm it accepts ALL the
   optional keys listed in Section 6 (encrypted payload, location, poll,
   reply variants, attachment metadata). Strict rejection of any breaks
   a real user flow.

4. **🟠 Verify `conversations.getOrCreateDirect` self-conversation
   safety** — must not return a conversation where `otherUserId ===
   currentUserId`. iter-110 found that this was returning a random
   active chat in this case.

5. **🟡 Implement `communities.*` admin endpoints** — see Section 21
   for the full list. Mobile UI for community admin tooling is the next
   feature in the queue.

---

## 📝 NOTES FOR THE MOBILE AGENT

- Whenever you add a NEW endpoint call from the mobile app:
  1. Wrap it in `useSafeConvexQuery` (queries) or `safeMutation`
     (mutations) so a missing function doesn't crash the app.
  2. Add it to this document with its expected args/return.
  3. Sign-off: the backend agent confirms the function exists with the
     matching signature before the mobile uses it in production.
- DO NOT call `useQuery` / `useMutation` directly on an unproven path.
  iter-115 fixed an `archived.tsx` crash caused by exactly this mistake.
- For deprecated endpoints, mark them as REMOVED in this document and
  remove the mobile call site in the same PR.
