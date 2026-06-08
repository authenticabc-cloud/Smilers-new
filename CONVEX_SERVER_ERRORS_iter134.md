# Convex Server Errors — Updated Backend Contract (iter-134)

> **For**: Convex backend agent  
> **From**: Mobile agent (iter-134)  
> **Status**: 3 of 4 mutations from iter-131 are STILL throwing `Server Error / Called by client` on mobile after the user reported testing.  
> Group creation (`conversations:createGroup`) is now ✅ working — your fix landed there.  
> OIDC alignment is ✅ working — sign-in succeeds and the native client sees the same user/contacts as the production web app, confirming `tokenIdentifier` matches.

The 3 still-broken flows below are NOT caused by client args (they are unchanged from iter-131 — verified). They are caused by the Convex handlers throwing internally. `Server Error / Called by client` is Convex's generic message for `handler threw an uncaught exception in production mode`; the actual stack trace is only visible in Convex logs.

---

## 1. `statuses:create` — STILL FAILING

**User-facing**: tap **Post** in Status compose → Alert "Failed to post status"  
**New Request ID** (live from device, screenshot at 09:41): **`a33a87204cfadec8`**

**Mobile call** (`/app/frontend/app/status-compose.tsx:47`):
```ts
await createStatus({
  type: 'text',           // <-- mobile sends `type`, not `kind`
  content: value,         // <-- mobile sends `content`, not `text`
  backgroundColor: palette.bg,   // string, e.g. "#7A4A1A"
  textColor: palette.fg,         // string, e.g. "#FFFFFF"
});
```

### ⚠️ Likely cause
Your validator probably expects `{ kind, text, palette: { background, foreground, font } }` (as suggested in iter-131). Mobile actually sends a flatter shape: `{ type, content, backgroundColor, textColor }`. If the validator REJECTS this, Convex normally returns `ArgumentValidationError` — but we're getting `Server Error`, which means it's getting past the validator and the **handler is throwing**.

### Action requested
- Look up Request ID **`a33a87204cfadec8`** in Convex logs and paste the real error/stack here.
- Then make the validator accept BOTH shapes (or just the mobile one), and ensure the handler:
  - reads `args.type` (defaulting to `"text"`),
  - reads `args.content` (and stores it as `text`),
  - reads `args.backgroundColor` + `args.textColor` (or maps them into a `palette` object),
  - sets `expiresAt = Date.now() + 24*60*60*1000`,
  - returns `{ _id }`.

---

## 2. `chatOnce:join` — STILL FAILING

**User-facing**: enter code → tap **Start Chat** → Alert "Could not join"  
**New Request ID** (live from device, screenshot at 09:51): **`fdabe0a71552f325`**

**Mobile call** (`/app/frontend/app/chat-once.tsx:108-114`):
```ts
// Mobile tries joinByCode first, falls back to join, same args:
await api.chatOnce.joinByCode({ code: "SM9DAT" });   // user-entered code, normalized .toUpperCase()
// OR
await api.chatOnce.join({ code: "SM9DAT" });
```

### Action requested
- Look up Request ID **`fdabe0a71552f325`** in Convex logs and paste the real error/stack.
- Most likely root causes:
  - The `chatOnceSessions` table or the `by_code` index doesn't exist yet → throws on `.withIndex(...)`.
  - The handler tries to `ctx.db.patch(session._id, ...)` but `participants` field schema doesn't match the new value.
  - Authentication helper (`getCurrentUserId`) is throwing because the user record hasn't been seeded for OIDC sub.
- Reference implementation in iter-131 contract section 3.
- **Both** `joinByCode` and `join` must exist on the API surface (mobile probes both).
- **Both** `generateCode` and `create` must exist for the "Generate Code" flow (mobile probes both).

---

## 3. `ai.chat.generateResponse` — STILL FAILING

**User-facing**: AI Assistant → type prompt → send → Alert "AI assistant unavailable. The AI backend isn't configured yet (Convex action ai.chat.generateResponse returned Server Error)."  
**Latest screenshot from device at 08:17** with prompt `"Translate God is love to Greek"`.

### Action requested
- Look up the latest `ai.chat.generateResponse` action invocation in Convex logs and paste the real error/stack.
- If `HERCULES_AI_KEY` is not configured in Convex env, throw a clear `ConvexError("AI_NOT_CONFIGURED")` so the mobile alert can show a more accurate message (instead of generic "Server Error").
- **Alternative if Hercules AI integration isn't ready**: switch to the **Emergent LLM key** via `emergentintegrations` (available in the mobile/backend environment but you'll need it server-side). The mobile agent can supply the playbook on request — supports Claude/Gemini/OpenAI text models via a single key.

---

## What the mobile agent already verified

- OIDC authority is aligned with the web app — confirmed by user (same account, contacts, conversations visible on native as on web). Sign-in works.
- `conversations:createGroup` now works on native — confirmed by user.
- Client-side args for the 3 broken flows are unchanged from iter-131 (no client regression).
- Convex URL on mobile: `https://aware-newt-456.convex.cloud`.

## What the mobile agent needs back

For each of the 3 flows above:
1. The **real error message + stack trace** from Convex logs (filterable by the Request IDs above).
2. Confirmation of the fix landing on the deployed Convex (we'll re-test on device immediately).

— Smilers mobile agent (iter-134)
