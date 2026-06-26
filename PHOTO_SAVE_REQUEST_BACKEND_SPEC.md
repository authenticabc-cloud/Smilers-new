# Backend spec — Profile-photo SAVE-by-approval (web ⇄ mobile)

Mobile (iter-276) ships the full UI for this flow. It needs the following Convex
functions on the shared backend (`aware-newt-456.convex.cloud`). Until they
deploy, the mobile UI degrades gracefully (the request button shows
"Not available yet"; the owner banner renders nothing).

## Product rules (confirmed with user)
1. **Trustees of the photo owner can save the owner's profile photo freely** (no request).
2. **Everyone else** who taps "Save to gallery" on the enlarged profile photo
   sends the **owner an approve/decline request**. They can only save once the
   owner **accepts**.
3. If the owner is **offline**, the requester just sees "Awaiting approval"
   (no auto-save).
4. (Client already enforces) The enlarged profile photo cannot be screenshotted
   on native (FLAG_SECURE) — no backend work needed.

## 1) Extend `users.getCurrentUser` / the profile query the mobile `user/[userId]` reads
Return a **server-computed, per-viewer** boolean:

```
canSavePhoto: boolean
```
True when ANY of:
- viewer is a **trustee** of this profile's owner, OR
- owner's `photoSavePolicy === 'everyone'`, OR
- owner's `photoSavePolicy === 'contacts'` AND viewer is a contact, OR
- the owner has **already approved** a pending save request from this viewer
  (one-time grant — see below).

Mobile already reads `user.canSavePhoto` and, when true, allows a direct save.
When false, it shows "Request to save".

## 2) New module `photoSaveRequests`

### `photoSaveRequests.request` (mutation)
- Args: `{ ownerId: Id<"users"> }`
- Caller = the requester (from `ctx.auth`).
- Reject if caller is the owner, if caller is already a trustee (they can save
  directly), or if `canSavePhoto` is already true.
- Upsert a pending row `{ ownerId, requesterId, status: 'pending', createdAt }`
  (dedupe per owner+requester; refresh `createdAt` if re-requested).
- Fire the owner a push/notification ("X wants to save your profile photo").
- Returns the request id.

### `photoSaveRequests.getIncoming` (query)
- No args. Caller = owner (from `ctx.auth`).
- Returns pending rows addressed to the caller:
  ```
  Array<{ _id, requesterId, requesterName, requesterAvatar?, status: 'pending', createdAt }>
  ```
- `requesterName` should be the requester's display name.

### `photoSaveRequests.respond` (mutation)
- Args: `{ requestId: Id<"photoSaveRequests">, accept: boolean }`
- Caller must be the owner of the request.
- `accept:true`  → set `status:'approved'` and create a **one-time grant** so the
  requester's `canSavePhoto` becomes true (until they save once, or for a TTL —
  your choice; one-time is fine). Optionally push the requester
  ("Your save request was approved").
- `accept:false` → set `status:'declined'`.

### `photoSaveRequests.getOutgoingStatus` (query) — REQUIRED for the live-approval UX
- Args: `{ ownerId }` → `{ status: 'none'|'pending'|'approved'|'declined' }`
  (a bare string is also accepted by mobile).
- Caller = the requester (from `ctx.auth`); returns the status of the caller's
  own request to that owner.
- Mobile subscribes to this on the profile-photo viewer: when it flips to
  `approved` the Save button enables instantly + a one-time "approved" alert
  shows; `declined` shows a declined state; `pending` shows "Awaiting approval".

## Notes
- Trustee membership already exists (`trustees.getMyTrustees` etc.). The
  `canSavePhoto` computation must check the **owner's** trustee list, which only
  the backend can do (a viewer can't read another user's trustees) — that's why
  this must be server-side.
- Keep all names/shapes EXACT — mobile reads `_id`/`requestId`, `requesterName`,
  `status`, and calls `request({ownerId})`, `respond({requestId, accept})`,
  `getIncoming({})`.
