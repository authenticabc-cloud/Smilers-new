# Backend spec — return per-viewer `viewedAt` on status views (Convex / web team)

**Owner:** Convex backend (`aware-newt-456.convex.cloud`) — the mobile app only
consumes this data, it does not own the schema.

**Context:** In the mobile status viewer ("Seen by" sheet), each viewer row can
now show a relative time ("5 min ago"). The mobile client
(`app/status-view/[userId].tsx` → `StatusViewerRow`) reads the timestamp from
`viewedAt` (and a few aliases) on each entry of the status `views` array.

The problem: `api.statuses.getMyStatuses` currently returns the `views` array
**without a usable `viewedAt`** on each entry (names resolve fine, but the time
is missing). We need the backend to include the per-viewer timestamp.

---

## Required shape

`api.statuses.getMyStatuses` (and any other query that returns the owner's own
stories, e.g. `listStatusGroups` for the owner) must return, for each story, a
`views` array where **every entry includes `viewedAt` as an epoch-milliseconds
number**:

```ts
views: Array<{
  userId: Id<"users">,
  viewedAt: number,        // REQUIRED — Date.now() at the moment of viewing (ms)
  name?: string,           // optional (client already resolves via getUserById)
}>
```

Example entry the client expects:

```json
{ "userId": "j57abc...", "viewedAt": 1783501234567, "name": "Abednego Obeng" }
```

### Notes / acceptance
- `viewedAt` MUST be the value already written by `statuses.markViewed`
  (`{ userId: me._id, viewedAt: Date.now(), name: me.name }` per the original
  status/stories spec). It is stored — it just needs to be **returned** by
  `getMyStatuses` (don't strip it during projection/serialization).
- If any older view rows were written before `viewedAt` was added, backfill them
  with the row's creation time (or leave them out — the client hides the time
  when absent, it will not crash).
- The client accepts either an epoch-ms **number** or an **ISO date string**,
  but a number is preferred. It also reads these aliases if you already use a
  different name: `viewedAtMs`, `at`, `seenAt`, `seenAtMs`, `timestamp`, `time`,
  `createdAt`, `_creationTime`. Any one of these works — but standardizing on
  `viewedAt` (ms) is the contract.

### What NOT to change
- Do not remove the `name` field (mobile still uses it as a hint; it also falls
  back to `api.users.getUserById`).
- No change needed to `markViewed` itself if it already writes `viewedAt`.

---

## How to verify
1. Owner opens their own status → "Seen by" sheet on mobile.
2. Each viewer row should show the viewer's name (already working) **and** a
   relative time like "5 min ago" / "2 h ago" that reflects when they actually
   viewed (not "just now" for old views, and not blank).

Mobile-side handling is already shipped in
`app/status-view/[userId].tsx` (`StatusViewerRow`) and needs no further change
once `viewedAt` is present in the response.
