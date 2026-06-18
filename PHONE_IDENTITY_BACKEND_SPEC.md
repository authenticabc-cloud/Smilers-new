# Phone-as-Identity — Convex Backend Spec (for the web/Convex team)

**Context:** The mobile app (this repo) only *consumes* the Convex backend
(`aware-newt-456.convex.cloud`). It cannot create/modify Convex functions or the
users table. The behaviours below MUST be implemented on the Convex/web side for
"every account is identified by its verified phone number" to work end-to-end.

## Symptom the user reported
Tapping a phone number that belongs to a real Smilers account (e.g. a saved
contact `+393888793266`) shows **"Not on Smilers yet → Invite"** instead of
**"Message"**. The Device-Contacts tab likewise shows **Invite** for people who
are already registered.

## Root cause
`api.users.getByPhone({ phoneE164 })` returns `null` for accounts that ARE on
Smilers. That means those accounts are **not indexed by a canonical verified
phoneE164**, so a reverse lookup by number fails.

## Required backend changes

### 1. Canonical, unique, verified phone on every account
- Every user document MUST store `phoneE164` in strict E.164 (`+<cc><national>`,
  digits only after `+`).
- `phoneE164` MUST be **unique** across users (enforce at verification time).
- Store `phoneVerified: boolean`. Block finishing onboarding until verified.
- Backfill existing accounts: normalise any legacy `phone` field to `phoneE164`
  with libphonenumber and set `phoneVerified=true` where a verified record exists.

### 2. `users.getByPhone({ phoneE164 })` — exact reverse lookup
- Normalise the input to E.164 server-side (don't trust client formatting).
- Look up by an **index on `phoneE164`** (e.g. `by_phoneE164`).
- Return `{ _id, displayName, avatarUrl, lastSeen, phoneE164 }` or `null`.
- Must match REGARDLESS of whether the caller already has them as a contact.

### 3. `users.getByPhones({ phoneE164List: string[] })` — NEW batch lookup
- Accept up to ~500 numbers, normalise each, return only those that map to a
  Smilers account: `Array<{ phoneE164, _id, displayName, avatarUrl }>`.
- This powers the **Device-Contacts tab** so it can show "Message" for numbers
  already on Smilers and "Invite" only for the rest — without N single queries.
- Privacy note: only return matches; never echo back non-members.

### 4. Keep `searchByPhonePrefix` consistent
- Same `by_phoneE164` index; only return verified accounts.

## What the mobile app already does (no backend needed for these)
- Resolves a tapped number against the **signed-in user's own contact list**
  (`api.contacts.getContacts`) first, so people already in your contacts show
  "Message" immediately.
- The **batch wiring is already shipped and dormant** in the app:
  `src/lib/phoneLookup.ts → lookupUsersByPhones()` is feature-detected against
  `api.users.getByPhones`. The Device-Contacts tab already calls it and will
  render "Message" for matched numbers the moment the backend deploys the
  query — **no further mobile release is required** once §3 lands.

## Acceptance test (once backend is done)
1. `users.getByPhone({ phoneE164: "+393888793266" })` returns that account.
2. Tapping that number in chat → "This number is on Smilers → Message".
3. Device-Contacts tab shows "Message" for registered numbers, "Invite" for the
   rest, using a single `getByPhones` round-trip.
