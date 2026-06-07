# Convex Server Errors — Quick Backend Contract (iter-131)

> **For**: Convex backend agent. **From**: Mobile agent (iter-131).
>
> 4 mutations are returning `Server Error / Called by client` on mobile.
> Each one is blocking a specific user-facing feature. Mobile-side args
> shown below — please confirm your validators match and unblock.

---

## 1. `statuses:create` — Status post fails

**Mobile screen**: `/status-compose` → tap **Post** → "Failed to post status".

**Mobile call** (`/app/frontend/app/status-compose.tsx` line 47):
```ts
await createStatus({
  kind: 'text',                  // 'text' | 'image' | 'video' (extend as needed)
  text: <string up to 1000 chars>,
  palette: {                     // optional theming object
    background: <hex>,
    foreground: <hex>,
    font: <string>,
  },
});
```

**Expected mutation**:
```ts
export const create = mutation({
  args: {
    kind: v.union(v.literal("text"), v.literal("image"), v.literal("video")),
    text: v.optional(v.string()),
    palette: v.optional(v.object({
      background: v.string(),
      foreground: v.string(),
      font: v.string(),
    })),
    // ...any image/video fields you need
  },
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("UNAUTHENTICATED");
    return await ctx.db.insert("statuses", {
      userId,
      ...args,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h TTL
    });
  },
});
```

---

## 2. `conversations:createGroup` — New group creation fails

**Mobile screen**: `/groups-create` → fill name + select members → **Create Group** → "Could not create group".

**Mobile call** (`/app/frontend/app/groups-create.tsx` line 61):
```ts
await createGroup({
  name: <string>,
  memberIds: <Id<"users">[]>,   // Convex user IDs of all members (sender is auto-included)
});
```

**Expected mutation**:
```ts
export const createGroup = mutation({
  args: {
    name: v.string(),
    memberIds: v.array(v.id("users")),
  },
  handler: async (ctx, { name, memberIds }) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("UNAUTHENTICATED");
    if (!name.trim()) throw new Error("Group name required");
    if (memberIds.length < 1) throw new Error("Add at least 1 member");

    // Make sure creator is in the participants set
    const participants = Array.from(new Set([userId, ...memberIds]));

    const convoId = await ctx.db.insert("conversations", {
      type: "group",
      name: name.trim(),
      participants,
      createdBy: userId,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    });
    return { _id: convoId };
  },
});
```

---

## 3. `chatOnce:join` / `chatOnce:joinByCode` — Chat Once code join fails

**Mobile screen**: `/chat-once` → enter 6-character code → **Join** → "Could not join".

**Mobile call** (`/app/frontend/app/chat-once.tsx`):
```ts
// Tries joinByCode first, falls back to join
await api.chatOnce.joinByCode({ code: <string 6 chars> });
// OR
await api.chatOnce.join({ code: <string 6 chars> });
```

**Expected mutation**:
```ts
export const joinByCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("UNAUTHENTICATED");
    const normalized = code.trim().toUpperCase();
    if (normalized.length < 4) throw new Error("Code too short");

    const session = await ctx.db
      .query("chatOnceSessions")
      .withIndex("by_code", q => q.eq("code", normalized))
      .first();
    if (!session) throw new Error("Code not found or already expired");
    if (session.expiresAt < Date.now()) throw new Error("Code expired");
    if (session.participants?.includes(userId)) {
      return { sessionId: session._id, conversationId: session.conversationId };
    }

    await ctx.db.patch(session._id, {
      participants: [...(session.participants || []), userId],
    });
    return { sessionId: session._id, conversationId: session.conversationId };
  },
});

// Keep both names alive for the fallback probe
export const join = joinByCode;
```

---

## 4. `ai.chat.generateResponse` — Smilers AI Assistant returns nothing

**Mobile screen**: `/ai-chat` (AI Assistant) → user types prompt → nothing happens (silently swallowed before iter-131; iter-131 now surfaces the error in an Alert).

**Mobile call** (`/app/frontend/app/ai-chat.tsx` line 40):
```ts
await generate({ prompt: <string> });   // useAction
```

**Expected Convex `action`**:
```ts
// convex/ai/chat.ts
import { v } from "convex/values";
import { action } from "../_generated/server";

export const generateResponse = action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("UNAUTHENTICATED");
    if (!prompt.trim()) throw new Error("Empty prompt");

    // 1. Persist user message
    await ctx.runMutation(internal.ai.chat.insertMessage, {
      userId, role: "user", content: prompt,
    });

    // 2. Call Hercules AI (or whichever LLM)
    const apiKey = process.env.HERCULES_AI_KEY ?? process.env.EMERGENT_LLM_KEY;
    if (!apiKey) throw new Error("AI not configured (HERCULES_AI_KEY missing)");
    const res = await fetch("https://hercules.smilers.online/v1/chat", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`AI upstream ${res.status}: ${await res.text()}`);
    }
    const { reply } = await res.json();

    // 3. Persist AI reply
    await ctx.runMutation(internal.ai.chat.insertMessage, {
      userId, role: "assistant", content: reply,
    });
  },
});
```

**Also needed**: `getMessages` query that returns `[{_id, role, content, createdAt}]` for the current user.

If Hercules AI integration isn't ready, **Emergent's LLM key** is available — you can swap to Claude/Gemini/OpenAI via the `emergentintegrations` library that's already in the environment. Just ask the mobile agent for the exact playbook.

---

## 5. Push notification recap (iter-130 reminder)

While you're in there, please ALSO apply the two fixes Emergent Support flagged for the push pipeline:

1. **`MOBILE_BACKEND_URL`** in Convex env vars should be `https://app-migration-75.emergent.host` (NOT the preview URL).
2. **Strip OIDC issuer prefix** before sending `recipients`:
   ```ts
   const recipients = participantTokenIdentifiers.map(
     (ti: string) => ti.split("|").pop() ?? ti,
   );
   ```

Mobile-side `/api/send-push-internal` will return `{delivery: {matched_recipients, unmatched_recipients, fcm_success_count}}` in the response so you can `console.log` and verify.

---

## Quick verification

After deploying, the user can re-test these flows. If any still error, paste the new `Request ID` (e.g. `7ab6206421a54050`) from the on-device alert and you can look up the exact stack trace in Convex logs.

— Smilers mobile agent (iter-131)
