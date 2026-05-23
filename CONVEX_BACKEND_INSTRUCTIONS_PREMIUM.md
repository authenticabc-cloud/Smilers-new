# Convex Backend Instructions — Premium Subscription (Mobile)

Contract for the **Premium** monetization feature shown on the Smilers
mobile app `/premium` route + the `<PremiumGate>` wrapper on the
`/emergency`, `/voice-tasks`, and `/chat-once` routes.

The full spec was provided by the web app agent. Pricing:
* **€3 / month** — `var_premium_monthly`
* **€30 / 6 months** — `var_premium_6months`
* **€24 / year** — `var_premium_yearly` (highlighted as **Best value**)

Every new user gets a **30-day free trial** from their `_creationTime`.
After expiry users must redeem a license code or subscribe.

The mobile app already runs against safe-fallback Convex calls so the
screen is fully usable while the backend is being shipped. Once these
endpoints are deployed, the mobile UX will sync transparently.

---

## Tables (suggested schema)

```ts
defineSchema({
  premiumLicenseCodes: defineTable({
    code: v.string(),                    // e.g. "PRE-A3K-9XR" (PRE-XXX-XXX)
    type: v.union(v.literal("lifetime"), v.literal("months")),
    durationMonths: v.optional(v.number()),
    status: v.union(
      v.literal("active"),
      v.literal("redeemed"),
      v.literal("revoked"),
    ),
    createdBy: v.id("users"),
    redeemedBy: v.optional(v.id("users")),
    redeemedAt: v.optional(v.string()),     // ISO timestamp
    expiresAt: v.optional(v.string()),      // ISO; null for lifetime
    note: v.optional(v.string()),
  })
    .index("by_code", ["code"])
    .index("by_redeemed_by", ["redeemedBy"]),

  // users table addition:
  // commerceCustomerId: v.optional(v.string())
});
```

---

## Queries

### `premium.getPremiumStatus({}) → PremiumStatus`

Single status query the mobile hook reads. Computes access following the
**hierarchy** (license → trial → subscription).

```ts
type PremiumStatus = {
  hasAccess: boolean;
  reason: "trial" | "license" | "subscription" | "expired";
  trialEndsAt?: string;
  daysRemaining?: number;
  licenseType?: "lifetime" | "months";
  expiresAt?: string | null;
  commerceCustomerId?: string;
};
```

* Trial calculation: `Date.now() < user._creationTime + 30 * 24 * 60 * 60 * 1000`
* On `expired`, the mobile client also calls `premiumAction.checkPremiumSubscription` as a secondary check — see below.

### `premium.listLicenseCodes({}) → Array<LicenseCode>` *(admin-only)*

Returns last 100 codes (descending by `_creationTime`). The mobile app
doesn't currently surface this — the existing web admin tool already
covers it.

---

## Mutations

### `premium.redeemLicenseCode({ code }) → { success, licenseType, expiresAt? }`

* Validates `code` against `premiumLicenseCodes.by_code`.
* Rejects if `status !== "active"` or already-redeemed.
* For `type === "months"` computes `expiresAt = now + durationMonths * 30 * 86400000`.
* Patches the row: `status: "redeemed", redeemedBy: user._id, redeemedAt: now, expiresAt`.
* Returns the canonical license info so the client can refresh its status pill.

### `premium.generateLicenseCode({ type, durationMonths?, note? }) → { code }` *(admin-only)*

Generates a `PRE-XXX-XXX` code with random alphanumerics (rejects collisions).
Mobile doesn't surface this either — exposed for the admin web tool.

### `premium.revokeLicenseCode({ code }) → null` *(admin-only)*

Sets `status: "revoked"`. Already-redeemed codes remain in their
redeemed state; this is only for unused codes.

### `premium.saveCommerceCustomerId({ customerId })` (+ internal variant)

Patches the current user with their Hercules Commerce customer id. The
mobile app doesn't call this directly — the action below uses the internal
variant.

---

## Actions (Node runtime, `"use node"`)

### `premiumAction.checkoutPremium({ variantId, successUrl, cancelUrl }) → { url }`

* Looks up the user; creates a Hercules Commerce customer if none exists
  (saving the id via `saveCommerceCustomerIdInternal`).
* Calls `hercules.commerce.checkout({ customer_id, variant_id })` with the
  provided redirect URLs.
* Returns `{ url }` — the mobile app opens it via
  `Linking.openURL(url)` so the system browser handles payment, then the
  user is redirected back to the app via `?success=true`.

### `premiumAction.checkPremiumSubscription({}) → { hasAccess }`

* Reads the user's `commerceCustomerId`.
* Calls `hercules.commerce.check({ customer_id, resource_id: "feat_premium" })`.
* Used by the mobile hook as a secondary check when `getPremiumStatus`
  returned `expired` — covers the race between subscription completion and
  the trial-end timestamp on the Convex side.

---

## Mobile entry points (already implemented)

| File | What it does |
|---|---|
| `/app/frontend/src/hooks/usePremiumAccess.ts` | Reads `premium.getPremiumStatus`; falls back to `trial` reason when the function isn't deployed; calls `checkPremiumSubscription` as a secondary check on `expired`. |
| `/app/frontend/src/components/PremiumGate.tsx` | Loading skeleton / trial-ending banner (≤7 days) / fullscreen upgrade prompt for no-access. Each gated route wraps its inner screen as `<PremiumGate featureName="...">`. |
| `/app/frontend/app/premium.tsx` | The Premium page. Shows status pill, 3 plan cards (yearly default), Subscribe button (opens Commerce URL via Linking), and a redeem code form (`PRE-XXX-XXX` input). |
| `/app/frontend/app/(tabs)/profile.tsx` | Gold "Premium" pill above Starred Messages → `/premium`. |
| `/app/frontend/app/emergency.tsx` | Now wrapped: `<PremiumGate featureName="Emergency Features">`. |
| `/app/frontend/app/voice-tasks.tsx` | `<PremiumGate featureName="Voice Tasks">`. |
| `/app/frontend/app/chat-once.tsx` | `<PremiumGate featureName="Chat Once">`. |

All callsites use `(api as any).premium?.X` / `(api as any).premiumAction?.X`
so missing endpoints gracefully no-op — the mobile app stays usable today
even before the web team finishes shipping.

---

## Trial-ending banner

When `daysRemaining <= 7` and `reason === "trial"`, the `<PremiumGate>`
renders an amber banner above the gated screen:

```
⏰  Trial ends in 4 days       [View plans]
```

Tapping **View plans** routes to `/premium`.

---

## Code format

License codes use the regex `^PRE-[A-Z0-9]{3}-[A-Z0-9]{3}$` (matches the
web app's existing format) — 3 letters + dash + 3 chars + dash + 3 chars.
Mobile input is `autoCapitalize="characters"` + `letterSpacing: 1.2` so
users can read the code as they type.
