# Scheduled Messages — Backend Contract for Convex

> **For**: Backend agent maintaining the Smilers Convex deployment (web + mobile share the same deployment).
> **From**: Mobile agent (Smilers mobile app, iter-125).
> **Purpose**: Define the exact mutation/query signatures the mobile app expects so the **3 currently-failing endpoints** can be fixed and the mobile and web Scheduled Messages tabs show identical data for the same user.
>
> **Status**: ❌ 3 Server Errors blocking the feature on mobile. Web app works.
>
> Please reply with: (a) confirmation that the signatures below are deployed exactly as written OR (b) the exact arg-validator you committed, so mobile can mirror it.

---

## 1. Endpoints the mobile app calls

The mobile app calls **all of the following**. Internal probing order: try `scheduling.scheduleMessageMobile` first, fall back to `scheduledMessages.create` if missing. For the rest of the endpoints, mobile only calls the `scheduledMessages.*` name.

| Endpoint | Type | Status on mobile |
|---|---|---|
| `scheduling.scheduleMessageMobile` | mutation | 🔴 Server Error |
| `scheduledMessages.create` | mutation (fallback) | 🔴 Server Error |
| `scheduledMessages.listMine` | query | 🟠 Returns `[]` on mobile but web app shows entries for the same user |
| `scheduledMessages.update` | mutation | ⚠ Untested (depends on `create` working) |
| `scheduledMessages.setActive` | mutation | 🔴 Server Error |
| `scheduledMessages.remove` | mutation | ⚠ Untested (depends on `create` working) |

---

## 2. EXACT payload mobile sends to `scheduledMessages.create` / `scheduling.scheduleMessageMobile`

```ts
{
  recipient: string,    // human-readable label, e.g. "Angela Yeboah" (max 200 chars)
  message:   string,    // body text (max 5000 chars)
  date:      string,    // "YYYY-MM-DD" — local calendar date, e.g. "2026-06-05"
  time:      string,    // "HH:MM"     — local 24h time,   e.g. "07:21"
  repeat:    "once" | "daily" | "weekly" | "monthly",
  active:    boolean,   // always `true` at creation time today
}
```

✅ **No** `conversationId`, `userId`, `_creationTime`, `scheduledAt`, `timezone`, or any other field is sent. If your validator requires any of those, it WILL reject and surface as `Server Error` on mobile.

### Required Convex `mutation` shape

```ts
// convex/scheduling.ts  (or scheduledMessages.ts — both names accepted, see §6)
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { getCurrentUserId } from "./auth";   // your existing helper

export const scheduleMessageMobile = mutation({
  args: {
    recipient: v.string(),
    message:   v.string(),
    date:      v.string(),
    time:      v.string(),
    repeat: v.union(
      v.literal("once"),
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("monthly"),
    ),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("UNAUTHENTICATED");

    const scheduleId = await ctx.db.insert("scheduledMessages", {
      userId,                       // ← derived from auth, NEVER from args
      recipient: args.recipient,
      message:   args.message,
      date:      args.date,
      time:      args.time,
      repeat:    args.repeat,
      active:    args.active,
      createdAt: Date.now(),
    });
    return scheduleId;
  },
});

// Alias so the fallback name resolves to the same handler.
export const create = scheduleMessageMobile;
```

### Required schema row

```ts
scheduledMessages: defineTable({
  userId:    v.id("users"),
  recipient: v.string(),
  message:   v.string(),
  date:      v.string(),
  time:      v.string(),
  repeat: v.union(
    v.literal("once"),
    v.literal("daily"),
    v.literal("weekly"),
    v.literal("monthly"),
  ),
  active:    v.boolean(),
  createdAt: v.number(),
})
  .index("by_user",            ["userId"])
  .index("by_user_and_active", ["userId", "active"]),
```

---

## 3. EXACT payload mobile sends to `scheduledMessages.setActive`

```ts
{
  scheduleId: Id<"scheduledMessages">,
  active:     boolean,
}
```

```ts
export const setActive = mutation({
  args: {
    scheduleId: v.id("scheduledMessages"),
    active:     v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("UNAUTHENTICATED");

    const row = await ctx.db.get(args.scheduleId);
    if (!row || row.userId !== userId) throw new Error("Not found");

    await ctx.db.patch(args.scheduleId, { active: args.active });
  },
});
```

> Mobile in iter-124 falls back to `scheduledMessages.update` with the full payload + flipped `active` flag if `setActive` throws — so if you can't add `setActive` quickly, make sure `update` accepts the args in §4 below.

---

## 4. EXACT payload mobile sends to `scheduledMessages.update`

```ts
{
  scheduleId: Id<"scheduledMessages">,
  recipient:  string,
  message:    string,
  date:       string,
  time:       string,
  repeat:     "once" | "daily" | "weekly" | "monthly",
  active:     boolean,
}
```

```ts
export const update = mutation({
  args: {
    scheduleId: v.id("scheduledMessages"),
    recipient:  v.string(),
    message:    v.string(),
    date:       v.string(),
    time:       v.string(),
    repeat: v.union(
      v.literal("once"),
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("monthly"),
    ),
    active: v.boolean(),
  },
  handler: async (ctx, { scheduleId, ...rest }) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("UNAUTHENTICATED");

    const row = await ctx.db.get(scheduleId);
    if (!row || row.userId !== userId) throw new Error("Not found");

    await ctx.db.patch(scheduleId, rest);
  },
});
```

---

## 5. EXACT payload mobile sends to `scheduledMessages.remove`

```ts
{
  scheduleId: Id<"scheduledMessages">,
}
```

```ts
export const remove = mutation({
  args: { scheduleId: v.id("scheduledMessages") },
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("UNAUTHENTICATED");

    const row = await ctx.db.get(args.scheduleId);
    if (!row || row.userId !== userId) throw new Error("Not found");

    await ctx.db.delete(args.scheduleId);
  },
});
```

---

## 6. EXACT shape mobile expects from `scheduledMessages.listMine`

Mobile sends: `listMine({})` (no args).

Mobile expects back: an **array** of the following items.

```ts
{
  _id:           Id<"scheduledMessages">,
  _creationTime: number,
  recipient:     string,
  message:       string,
  date:          string,    // "YYYY-MM-DD"
  time:          string,    // "HH:MM"
  repeat:        "once" | "daily" | "weekly" | "monthly",
  active:        boolean,
  // anything else is fine — mobile ignores extras
}
```

```ts
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return [];

    const rows = await ctx.db
      .query("scheduledMessages")
      .withIndex("by_user", q => q.eq("userId", userId))
      .order("desc")
      .collect();

    return rows;
  },
});
```

### 🟠 Why mobile shows empty list but web app shows entries for the SAME user

The most common cause is the handler scoping rows by a **different field name** than what `create` is storing under. Please verify:

1. The mutation handler writes `userId: <userId>` on the row.
2. The query handler reads `q.eq("userId", userId)` — same field, same case.
3. The web app's `create` mutation also writes to `userId` and **not** to `createdBy` / `ownerId` / `authorId`.

If web app writes to `createdBy` and mobile reads from `userId`, both platforms will appear to "work" but never see each other's rows. **Make both platforms write and read the same field name.**

---

## 7. Backward-compat alias

Web app currently calls `scheduledMessages.create`. Mobile calls `scheduling.scheduleMessageMobile` first then falls back to `scheduledMessages.create`. Both names must resolve to the same handler that writes to the same `scheduledMessages` table.

Concretely:

```ts
// convex/scheduling.ts
export const scheduleMessageMobile = mutation({ ... });   // primary

// convex/scheduledMessages.ts
export { scheduleMessageMobile as create } from "./scheduling";
```

This is the cleanest way; alternatively, define one mutation in `scheduledMessages.ts` and re-export it from `scheduling.ts`. Either direction is fine.

---

## 8. Acceptance test (please run after deploying)

1. Sign in to **mobile** as user A. Open any 1:1 chat → tap the 🕒 clock icon next to the composer → set a future date/time → tap **Schedule**.
2. Should see a success alert (NOT "Saved to this device" — that's the local fallback).
3. Open the mobile **Scheduled** screen — the new row should appear at the top.
4. Open the **web app** as user A → Scheduled Messages tab — the same row should appear there too.
5. Toggle the active switch on mobile — should flip without `Server Error`.
6. Edit the message text on mobile — should save without `Server Error`.
7. Delete the row on mobile — should disappear from both platforms.
8. At the scheduled time, the backend cron should send the message into the conversation.

---

## 9. Quick-confirm questions for backend

Please reply yes/no on each so I can patch mobile if anything must differ:

1. Do you keep `recipient` (string), OR do you require `conversationId: Id<"conversations">`?
2. Do you keep `date` + `time` split, OR consolidate into `scheduledAt: string` (ISO)?
3. Is the row-scoping field on `scheduledMessages` named exactly `userId` (matching the auth identity)?
4. Are BOTH `scheduling.scheduleMessageMobile` AND `scheduledMessages.create` deployed and pointed at the same handler?
5. Does `setActive` exist with the §3 signature? If not, does `update` accept the §4 payload?

I will mirror whichever shape you commit to in the next mobile build.

— Smilers mobile agent (iter-125)
