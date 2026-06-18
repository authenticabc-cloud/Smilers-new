# Phone-identity asymmetry between two devices — diagnosis (iter-224)

## What the user saw
- On **Device A** (logged in as ABC INVESTOR, +393888793266):
  - Tapping +393495432048 (Queeny/Angela) → "Not on Smilers" (Invite)
  - Tapping ABC's OWN number +393888793266 → "Not on Smilers"
  - Device-Contacts shows Queeny (+393495432048) and "Ben Chris" (+393888793266, = own) under **Invite**
- On **Device B** (logged in as Angela, +393495432048):
  - Tapping +393495432048 → "Angela Yeboah — on Smilers" (Message)
  - Tapping +393888793266 (ABC) → "on Smilers" (Message)

## Root cause (BACKEND — not the mobile app)
The mobile wiring is correct (it calls `users.lookupByPhones({ phones })` and
matches by last-10). The asymmetry is caused by backend DATA, two parts:

1. **Self is excluded from results.** `lookupByPhones`/`getByPhone` excludes the
   calling user, so a user's OWN number resolves as "not on Smilers" to
   themselves. → Mobile now special-cases this and shows **"This is your own
   Smilers number."** instead of an invite prompt (no backend change needed).

2. **Not every account is matchable.** An account only resolves if it has a
   populated, indexed `phoneLast10` AND is `phoneVerified`. ABC's account is
   verified+indexed (so Angela can message ABC), but Angela's number does NOT
   resolve for ABC → Angela's account is missing `phoneLast10` (or isn't
   verified/indexed). This is exactly what the backfill is for.

## Required backend actions (web/Convex team)
1. Run **`internal.users.backfillPhoneE164({})`** once so ALL existing accounts
   get `phoneLast10`. (New sign-ups/number-changes populate it automatically.)
2. Confirm every account that should be reachable has `phoneVerified === true`
   and a unique `phoneE164`. Any account without these will keep showing as
   "not on Smilers" to others — this is the remaining cause of the asymmetry.
3. (Optional product decision) Decide whether `lookupByPhones` should keep
   excluding the caller. Mobile already handles the self case gracefully either
   way.

## Acceptance test after backfill
- Device A tapping +393495432048 → "Angela … on Smilers → Message".
- Device A's Device-Contacts → Queeny shows **Message**.
- Each user tapping their OWN number → "This is your own Smilers number."
