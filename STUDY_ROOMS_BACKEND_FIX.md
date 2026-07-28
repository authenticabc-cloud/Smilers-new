# Study Rooms — Convex Backend Fixes Needed

These two failures are **server-side errors thrown inside your Convex functions**
on `aware-newt-456.convex.cloud`. The mobile app calls them with correct
arguments (verified below), so the fix must happen in the Convex backend code
(not in the mobile app).

Give this document + the Request IDs to whoever maintains the Convex backend.
Each Request ID maps 1:1 to a full server stack trace in the Convex dashboard →
**Logs** (filter by the Request ID) — that trace will pinpoint the exact line.

---

## 1. `study/rooms:submitRoomQuizAttempt` — Server Error
- **Request ID to look up in Convex logs:** `fd8fb242ef649181`
- **Client call (correct):**
  ```ts
  submitRoomQuizAttempt({
    roomQuizId: "<Id<'roomQuizzes'>>",
    answers: [ { number: 1, given: "..." }, { number: 2, given: "..." }, ... ]
  })
  ```
  `answers` is an array of `{ number: number, given: string }`, one per question,
  in question order.

## 2. `study/rooms:previewRoomByCode` — Server Error
- **Request ID to look up in Convex logs:** `d33a65b80f105c60`
- **Client call (correct):**
  ```ts
  previewRoomByCode({ code: "ABC123" })   // 6-char, uppercased, [A-Z0-9]
  ```
  Expected to **return `null`** (not throw) when no room matches the code — the
  mobile app already handles `null` by showing "Room not found". A thrown
  `Server Error` is a backend bug.

---

## Most likely root cause (check this first)

Both functions are registered as **Convex `action`s** (the mobile client binds
them with `useAction`, not `useQuery`/`useMutation`). Inside a Convex **action
you cannot touch the database directly** — `ctx.db` is `undefined` there, and any
`ctx.db.query(...)` / `ctx.db.get(...)` / `ctx.db.insert(...)` call throws an
uncaught exception that surfaces to the client as exactly this "Server Error".

Fix pattern — actions must go through `ctx.runQuery` / `ctx.runMutation`:

```ts
// ❌ BROKEN inside an action:
export const previewRoomByCode = action({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const room = await ctx.db          // <-- ctx.db is undefined in an action → Server Error
      .query("studyRooms")
      .withIndex("by_code", q => q.eq("joinCode", code))
      .unique();
    return room;
  },
});

// ✅ FIX A — move the lookup into an internalQuery and call it:
export const _getRoomByCode = internalQuery({
  args: { code: v.string() },
  handler: async (ctx, { code }) =>
    ctx.db.query("studyRooms")
      .withIndex("by_code", q => q.eq("joinCode", code))
      .unique(),        // returns null if not found (don't throw)
});

export const previewRoomByCode = action({
  args: { code: v.string() },
  handler: async (ctx, { code }) =>
    ctx.runQuery(internal.study.rooms._getRoomByCode, { code }),
});

// ✅ FIX B (simpler, preferred if no external I/O is needed) —
// if the function does NOT call any external API/LLM, just make it a
// `query` instead of an `action`, then it can use ctx.db directly:
export const previewRoomByCode = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) =>
    ctx.db.query("studyRooms")
      .withIndex("by_code", q => q.eq("joinCode", code))
      .unique(),
});
```
> If you switch `previewRoomByCode`/`submitRoomQuizAttempt` from `action` →
> `query`/`mutation`, tell me and I'll flip the mobile bindings from
> `useAction` to `useQuery`/`useMutation` (one-line change each in
> `src/lib/study/useRooms.ts`).

For **`submitRoomQuizAttempt`**, apply the same rule: if it grades server-side
and writes the attempt/leaderboard row, it should either be a **`mutation`**
(so it can `ctx.db.insert(...)`), or an **`action`** that calls
`ctx.runMutation(internal.study.rooms._recordAttempt, {...})`. Also confirm:
- The `answers` array shape (`{ number, given }`) matches what the grader reads.
- The stored quiz's questions have the expected `number`/`answer` fields to grade against.
- If grading uses an LLM/external key, verify that env var is set on this deployment.

## Other things to verify (if it is NOT the ctx.db issue)
- **Missing DB index:** `by_code` (or whatever the joinCode index is) not defined
  in `schema.ts` → `.withIndex` throws.
- **Null deref:** grading reads `room.something` / `quiz.questions[i].answer`
  where the doc/field is missing.
- **Auth/identity:** the function reads `ctx.auth.getUserIdentity()` and derefs it
  without a null check when the caller's identity is present but the user row
  hasn't been provisioned.

## How to confirm the fix
1. Open the Convex dashboard → Logs → filter by the Request IDs above → read the
   top frame of each stack trace (it names the exact file/line and error).
2. After patching + `npx convex deploy`, retry from the mobile app:
   - Join a room with a valid code (and an invalid one → should say "Room not found", not error).
   - Submit a quiz → expect graded results + leaderboard update.
