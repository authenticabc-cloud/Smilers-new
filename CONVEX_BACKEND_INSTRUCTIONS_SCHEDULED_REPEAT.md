# CONVEX BACKEND INSTRUCTIONS — Scheduled Messages: recurring repeat handling

**From:** Smilers mobile team (iter-181, extended iter-186)
**To:** Web/Convex backend team
**Priority:** HIGH — user-visible data corruption (duplicate rows accumulating daily) + mobile/web sync gap

## NEW (iter-186): Mobile ↔ Web sync requirement

User report: schedules created on MOBILE do not appear in the WEB app at
all ("Not synced to the web app"). Mobile uses these functions (all
confirmed deployed):
- create: `scheduling.scheduleMessageMobile` (fallback `scheduledMessages.create`)
- list:   `scheduledMessages.listMine`
- update/remove/toggle: `scheduledMessages.update` / `.remove` / `.setActive`

REQUIREMENT: the web app's scheduled-messages UI MUST read from the SAME
canonical store that `scheduledMessages.listMine` reads and that
`scheduling.scheduleMessageMobile` writes. If web currently uses a
different table/functions, either point web at these, or make
`scheduleMessageMobile` write into web's canonical table — ONE store,
both clients.

## Observed defect (screenshots from production user, 2026-06-11)

A scheduled message created with `repeat: "daily"` produces, after a few days:

| date       | time  | repeat shown | active |
|------------|-------|--------------|--------|
| 2026-06-10 | 05:00 | once         | on     |
| 2026-06-11 | 05:00 | once         | on     |
| 2026-06-12 | 05:00 | once         | on     |

i.e. `scheduledMessages.listMine` returns ONE NEW ROW PER DAY, each with
`repeat: "once"`, and the already-fired rows are never cleaned up. Storage
grows forever and the UI misrepresents the user's intent ("Once" instead
of "Daily").

## Root cause (suspected, backend-side)

The recurrence worker that fires due schedules appears to:
1. send the message,
2. INSERT a clone row for the next occurrence with `repeat: "once"`,
3. leave the fired row in place (still `active: true`).

## Required behavior (canonical contract)

When a scheduled message with `repeat != "once"` fires:
1. Send the message as today.
2. **UPDATE THE SAME ROW IN PLACE**: advance `date` (and `time` if needed)
   to the next occurrence — +1 day for `daily`, +7 days for `weekly`,
   +1 month for `monthly`. **KEEP the original `repeat` value.**
3. Do NOT insert any new row.

When a `repeat == "once"` schedule fires:
1. Send the message.
2. Either delete the row, or mark it `active: false` (mobile renders the
   toggle state, so `active: false` reads naturally as "done").

## Data cleanup migration (please run once)

For existing polluted data: for each (userId, message, time) group with
multiple rows on consecutive dates and `repeat: "once"`, keep ONLY the
newest row, set its `repeat` to the user's original recurrence if known
(otherwise leave "once"), and delete the older duplicates.

## Mobile-side notes (already shipped, no action needed)

- Mobile WAS stripping recurrence in one sync path (local-draft sync sent
  `repeat: "once"` unconditionally) — FIXED in iter-181; mobile now sends
  the true repeat value through both `scheduling.scheduleMessageMobile`
  and the `scheduledMessages.create` fallback.
- Mobile sends/expects payload `{ recipient, message, date ("YYYY-MM-DD"),
  time ("HH:MM"), repeat ("once"|"daily"|"weekly"|"monthly"), active }`
  (unchanged, per iter-126 confirmation).
- `recipient` is a display label; rows showing recipient "Unknown" were
  created before mobile resolved device-contact names — also fixed
  mobile-side in iter-181.
