# 📞 Backend Changes #2 — Phone Verification (Twilio Verify)

Hi Hercules! Please apply these changes to the Convex backend so the Smilers mobile app can require phone verification for all new and existing users (hard block until verified).

---

## STEP 1 — Add Twilio secrets to your Convex deployment

Run these commands locally (once):

```bash
npx convex env set TWILIO_ACCOUNT_SID "AC09b5e3343d52cbbf521bee6d367a1a71"
npx convex env set TWILIO_AUTH_TOKEN "8194104437df1b360f3bde09b28f4e45"
npx convex env set TWILIO_VERIFY_SERVICE_SID "VA56f3a75d7bf855ac85381f1f3f600711"
```

> ⚠️ These are server-side only — never bundle them in the client. Convex `action` functions can read them via `process.env`.

---

## STEP 2 — Extend the `users` schema

**File:** `convex/schema.ts`

Add a `phoneVerified` boolean to the `users` table (keeping all existing fields). Also add a `by_phone` index so we can detect duplicate phone numbers.

```ts
users: defineTable({
  // ...all existing fields...
  phone: v.optional(v.string()),
  phoneVerified: v.optional(v.boolean()),  // NEW
})
  .index("by_token", ["tokenIdentifier"])
  .index("by_phone", ["phone"]),  // NEW
```

---

## STEP 3 — Create `convex/phoneAuth.ts`

This file handles all Twilio Verify logic. Create it new:

```ts
import { action, mutation, internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const TWILIO_VERIFY_BASE = "https://verify.twilio.com/v2/Services";

function basicAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("Twilio credentials not configured");
  // btoa is available in Convex's V8 runtime
  return "Basic " + btoa(`${sid}:${token}`);
}

function serviceSid() {
  const sid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid) throw new Error("Twilio Verify Service SID not configured");
  return sid;
}

/**
 * Send an OTP code via Twilio Verify to the given phone number.
 * Phone must be in E.164 format (e.g. "+14155551234").
 */
export const sendOtp = action({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    if (!/^\+[1-9]\d{6,14}$/.test(args.phone)) {
      throw new Error("Invalid phone number format. Use international format e.g. +14155551234.");
    }

    // Check duplicate: if another user already has this phone verified, reject early
    const existingPhone: Doc<"users"> | null = await ctx.runQuery(
      internal.phoneAuth.findUserByPhone,
      { phone: args.phone }
    );
    const me: Doc<"users"> | null = await ctx.runQuery(
      internal.phoneAuth.getCurrentUserInternal,
      {}
    );
    if (
      existingPhone &&
      existingPhone.phoneVerified &&
      me &&
      existingPhone._id !== me._id
    ) {
      throw new Error("This phone number is already in use. Please sign in with the original account.");
    }

    const url = `${TWILIO_VERIFY_BASE}/${serviceSid()}/Verifications`;
    const body = new URLSearchParams({
      To: args.phone,
      Channel: "sms",
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Twilio sendOtp] error:", res.status, errText);
      throw new Error(
        res.status === 429
          ? "Too many attempts. Please wait a few minutes and try again."
          : "Could not send verification code. Please try again."
      );
    }

    return { success: true };
  },
});

/**
 * Verify the OTP entered by the user. On success, save the phone to the user
 * record and mark phoneVerified = true.
 */
export const verifyOtp = action({
  args: { phone: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    if (!/^\+[1-9]\d{6,14}$/.test(args.phone)) {
      throw new Error("Invalid phone number format.");
    }
    if (!/^\d{4,8}$/.test(args.code)) {
      throw new Error("Invalid verification code.");
    }

    // Re-check duplicate before write
    const existingPhone: Doc<"users"> | null = await ctx.runQuery(
      internal.phoneAuth.findUserByPhone,
      { phone: args.phone }
    );
    const me: Doc<"users"> | null = await ctx.runQuery(
      internal.phoneAuth.getCurrentUserInternal,
      {}
    );
    if (!me) throw new Error("User not found");
    if (
      existingPhone &&
      existingPhone.phoneVerified &&
      existingPhone._id !== me._id
    ) {
      throw new Error("This phone number is already in use.");
    }

    const url = `${TWILIO_VERIFY_BASE}/${serviceSid()}/VerificationCheck`;
    const body = new URLSearchParams({ To: args.phone, Code: args.code });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Twilio verifyOtp] error:", res.status, errText);
      throw new Error("Could not verify code. Please try again.");
    }

    const json: any = await res.json();
    if (json.status !== "approved") {
      throw new Error("Incorrect or expired code. Please try again.");
    }

    // Persist phone + phoneVerified on user
    await ctx.runMutation(internal.phoneAuth.savePhoneVerified, {
      userId: me._id,
      phone: args.phone,
    });

    return { success: true };
  },
});

// ─── Internal helpers ─────────────────────────────────────────────────────

export const findUserByPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .unique();
  },
});

export const getCurrentUserInternal = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
  },
});

export const savePhoneVerified = internalMutation({
  args: { userId: v.id("users"), phone: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      phone: args.phone,
      phoneVerified: true,
    });
  },
});
```

> 📝 Note: I marked `findUserByPhone` and `getCurrentUserInternal` as **public queries** so the action can call them via `ctx.runQuery(internal.phoneAuth...)`. If you prefer them to be `internalQuery`, change them and import via `internal.phoneAuth.*` — both work.

---

## STEP 4 — Make `getCurrentUser` always return `phoneVerified`

**File:** `convex/users.ts`

Inside the existing `getCurrentUser` query, ensure the returned object includes both `phone` and `phoneVerified` (they should already be there since you spread the user doc, but double-check and add fallbacks):

```ts
return {
  ...user,
  phoneVerified: user.phoneVerified ?? false,
};
```

This way the mobile app always knows whether to show the gate.

---

## STEP 5 — Defense in depth (server-side block on writes)

**File:** `convex/messages.ts`, `convex/conversations.ts`, `convex/calls.ts`, `convex/statuses.ts`

In each user-action mutation/action that writes data (send message, create group, initiate call, post status, etc.), add this guard at the top:

```ts
const me = await ctx.db
  .query("users")
  .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
  .unique();
if (!me?.phoneVerified) {
  throw new Error("Phone verification required. Please verify your phone in the app.");
}
```

This ensures even if a malicious client bypasses the mobile UI gate, the backend won't let them do anything until phone is verified.

> 💡 Tip: Wrap this in a helper function `requireVerifiedUser(ctx)` and call it from each handler.

---

## STEP 6 — Migration consideration (existing users)

Your existing web users may already have a `phone` field set (e.g., from profile edits). Run this **one-time migration** to mark them as verified IF you trust the existing phone numbers, OR leave them unverified to force re-verification:

**Option A (force re-verify everyone):** Do nothing. All users without `phoneVerified === true` will see the gate on next login.

**Option B (grandfather users with phone already set):** Run this one-time mutation:

```ts
// convex/oneTimeMigration.ts
export const grandfatherExistingPhones = mutation({
  args: {},
  handler: async (ctx) => {
    // ⚠️ Only an admin should call this once
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const caller = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (caller?.role !== "admin") throw new Error("Admin only");

    let count = 0;
    const all = await ctx.db.query("users").collect();
    for (const u of all) {
      if (u.phone && !u.phoneVerified) {
        await ctx.db.patch(u._id, { phoneVerified: true });
        count++;
      }
    }
    return { migrated: count };
  },
});
```

The user requested: **"all existing users should be forced to add a phone number"** — so go with **Option A** (do nothing). All users will see the verify screen until they verify a phone via Twilio.

---

## STEP 7 — Restrict Hercules login methods

This is **separate** from Convex — it's a setting in your **Hercules dashboard**, not the backend.

Tell the Hercules admin/chat:
> *"For the OIDC client `IWJWPQTRdglpKPvkJZTHDZhNKQutGnBG`, please disable all login methods except **Google** and **Apple ID**. Specifically: turn off Email OTP, LinkedIn, Microsoft, Phone OTP. Only Google and Apple should remain."*

---

## STEP 8 — Deploy

```bash
npx convex deploy
```

That's it! After deployment:
- New users sign in with Google/Apple → get redirected to phone verify → enter phone → SMS arrives via Twilio → enter OTP → unblocked
- Existing users without `phoneVerified === true` get the same gate
- Trying to use messages/calls without verified phone → backend rejects

---

## What the mobile app already does (no action needed)

The mobile app:
- Calls `api.phoneAuth.sendOtp` with E.164 phone
- Calls `api.phoneAuth.verifyOtp` with phone + code
- Reads `me.phone` and `me.phoneVerified` from `api.users.getCurrentUser`
- Hard-blocks all tabs until both are truthy
- Shows country picker with flags + libphonenumber validation
- 30-second resend cooldown
- "Use a different number" + "Sign out" escape hatches

Just deploy and it'll all work end-to-end.
