# Bug report → Web team: `conversations.getOrCreateDirect` throws "Server Error"

**Severity:** High — blocks starting a 1:1 chat (contact tap, search result, status
reply, share/forward, find-by-phone all funnel through this mutation).

**Convex deployment:** `aware-newt-456.convex.cloud`
**Function:** `conversations:getOrCreateDirect` (mutation)

---

## Symptom
Convex rejects the mutation with a generic server error (thrown inside the
function, not a client/validation error):

```
[CONVEX M(conversations:getOrCreateDirect)] [Request ID: 2a475cc88751ec7f] Server Error
```

Captured from a real device via our diagnostic relay:
- Device: `SM-A065F`, Android 36, Smilers app `2.2.17 / 2219`
- Affected caller (push id): user `01KWH29D…`
- Related conversation id in the same session: `jd706tgfrqgc650xe7w43nxhhn89s88v`
- Timestamp (UTC): 2026-07-02 ~12:09:28

**Request ID to look up in the Convex dashboard logs:** `2a475cc88751ec7f`
(Convex Dashboard → Logs → filter by request id → the stack trace / thrown
message will pinpoint the exact line. The mobile client only ever sees the
sanitized "Server Error"; the real cause is in the server logs.)

---

## How the mobile client calls it (for reference — client is NOT the problem)
Every mobile call site passes the identical, minimal shape:

```ts
const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
// ...
await getOrCreateDirect({ otherUserId: <Id<"users">> });
```

Call sites (all `{ otherUserId }`): `search.tsx`, `user/[userId].tsx`,
`contacts.tsx`, `find-by-phone.tsx`, `share-receiver.tsx`, `screen-share.tsx`,
`status-view/[userId].tsx`, `chat/[conversationId].tsx` (fallback).

So the arg contract is consistent. The failure is thrown **inside** the mutation.

---

## Likely causes to check (in priority order)
1. **`otherUserId` = self.** If a user somehow triggers it with their own id
   (e.g. tapping their own profile, or a stale/duplicated contact row), does the
   function throw instead of returning early? Please guard: if
   `otherUserId === identityUserId`, return the self/notes conversation or a
   clean client error — not a server throw.
2. **`otherUserId` no longer exists / was deleted.** `ctx.db.get(otherUserId)`
   returning `null` and then dereferencing it would throw. Add a null check with
   a friendly `throw new ConvexError("User not found")` (client-distinguishable).
3. **Unauthenticated / missing identity.** If `ctx.auth.getUserIdentity()` is
   null (token race), reading `identity.subject` throws. Return a typed error so
   the client can retry after refresh instead of surfacing "Server Error".
4. **Duplicate-DM race / unique index violation.** Two rapid taps create two DM
   docs; if there's a unique constraint or a "find existing then insert" without
   idempotency, the second insert throws. Make it idempotent (re-query inside a
   transaction, or catch the insert conflict and return the existing DM).
5. **Schema/validator drift.** If the function recently changed its arg
   validator (e.g. now expects `userId` or `participantId` instead of
   `otherUserId`), the current arg would fail validation. If the canonical arg
   name changed, tell us and we'll rename on the client (currently `otherUserId`).

---

## What we need back
1. The **thrown error message / stack** for request id `2a475cc88751ec7f` from
   the Convex logs (this alone likely identifies the bug).
2. Confirmation of the **expected arg name** (`otherUserId` vs other).
3. A fix that makes the mutation **idempotent** and returns **typed
   `ConvexError`s** (not bare throws) for the "self", "not found", and
   "unauthenticated" cases, so the mobile app can show a helpful message and
   recover instead of a generic failure.

No mobile release is required once the server function is fixed — the client
already calls it correctly.
