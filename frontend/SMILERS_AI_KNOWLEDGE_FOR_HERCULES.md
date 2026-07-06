# Smilers AI — knowledge update for the Hercules team (2026-07-06)

The in-app **AI Assistant** (Smilers AI) runs on the Hercules web-app backend via
the Convex action `api.ai.chat.generateResponse`. Its system prompt / knowledge
base is **NOT** in the mobile repo, so this document lists the facts the AI should
know so it can answer user questions about the newest features consistently with
the in-app FAQ (`src/lib/faqs.ts`).

Please append the following to the Smilers AI system prompt / knowledge base.

---

## Smilers Premium
- Premium unlocks the full Smilers experience.
- Plans and prices: **Monthly €3**, **6 Months €15**, **Yearly €24**.
- Users subscribe from the in-app **Premium** screen (card checkout) OR via **Mobile Money** (manual).
- Variant IDs: `var_premium_monthly` (1 mo), `var_premium_6months` (6 mo), `var_premium_yearly` (12 mo).

## Mobile Money — Premium
- On the Premium screen, pick a plan → **“Pay with Mobile Money”**.
- User chooses their country, optionally adds the phone number they’ll pay from, and submits a request.
- An **admin** messages the user with the mobile money number to pay.
- When the admin marks the payment **complete**, the Premium plan is **activated automatically**.
- Users can track their requests via **Premium → “Your requests”**.
- Convex: `api.mobileMoneyRequests.createRequest / getMyRequests`; admin `listPendingRequests / listRequestHistory / completeRequest / declineRequest / countPendingRequests`.

## Mobile Money — Ad Clicks (NEW)
- Price: **€0.04 per paid ad click**.
- Flow: **Ads → My Ads → Buy clicks** on an ad → choose quantity → **“Pay with Mobile Money”**.
- User chooses country, optionally adds pay-from phone, reviews the **estimated** local total, and submits.
- An admin messages the number to pay; on **completion**, the clicks are **credited to the ad automatically**.
- Users see status in **Ads → My Ads → “Mobile Money top-ups”** card: `Pending`, `Credited` (completed), or `Declined`.
- Card checkout remains available as an alternative to Mobile Money.
- Convex: `api.adClickRequests.createRequest({ adId, clicks, country, phone? }) / getMyRequests`; admin `listPendingRequests / listRequestHistory / completeRequest / declineRequest / countPendingRequests`.

### Mobile Money — general
- The local-currency amount shown before submitting is an **estimate (≈)** based on the current rate; the exact amount is confirmed on submit and communicated by the admin.
- Supported countries/currencies: Kenya (KES), Ghana (GHS), Uganda (UGX), Tanzania (TZS), Rwanda (RWF), Zambia (ZMW), South Africa (ZAR), Nigeria (NGN), Cameroon & Gabon (XAF), Côte d’Ivoire / Senegal / Burkina Faso / Mali / Benin / Togo (XOF), Malawi (MWK).
- Payments are reviewed/confirmed manually by an admin, usually within a few hours.

## Group features
- **Pinned posts:** group admins can pin a message; it appears as a top banner that members tap to jump to it. Admins unpin the same way.
- **Post edit approvals:** members can *suggest* an edit to a group post; an admin approves/rejects. Approved edits show a “suggested edit was approved” system notice.
- **Group sender names:** each message in a group shows the sender’s name above it (saved contact name first, then Smilers name).

## Calls
- **Add participants mid-call:** a 1-to-1 call can be upgraded to a group/conference call by tapping **Add** — the live call is not interrupted.
- **Call waiting:** an incoming call while you’re already on a call can be answered (placing the first on hold) or declined; the first call stays connected.

## Support routing
- In-app support: **Settings → Help & Support** (searchable FAQ + contact form).
- Support email: **support.smilers@gmail.com** (the old `support@smilers.online` inbox is deprecated).
- If the AI can’t resolve a billing/payment issue, direct users to Help & Support and, for Mobile Money, remind them an admin confirms payments manually and applies the benefit automatically.

---

_Keep this in sync with `frontend/src/lib/faqs.ts` in the mobile repo, which now
has a dedicated “Premium & payments” category covering the above._
