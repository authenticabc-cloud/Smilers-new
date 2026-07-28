# Study Rooms "Server Error" — Root Cause & Resolution

## Verdict: it was a CLIENT-SIDE function-type mismatch (fixed in the mobile app). No backend change required.

The Convex backend agent correctly reported that the `study.rooms.*` functions
are healthy **queries/mutations** (not actions) and that **no handler failures
are logged** for them. That is the key clue.

### Why the client saw "Server Error" with nothing in backend logs
The mobile client was invoking two `study.rooms` endpoints with the **wrong
Convex function type**:

| Function | Backend type | Client was calling it as | Result |
|---|---|---|---|
| `study.rooms.previewRoomByCode` | query/mutation | **action** (`useAction`) | rejected at routing → `[CONVEX A(...)] Server Error` |
| `study.rooms.submitRoomQuizAttempt` | mutation | **action** (`useAction`) | rejected at routing → `[CONVEX A(...)] Server Error` |

Note the **`A(`** prefix in the user's error screenshots
(`[CONVEX A(study/rooms:previewRoomByCode)]`, `[CONVEX A(study/rooms:submitRoomQuizAttempt)]`)
— Convex prefixes the invoked type: `Q(`=query, `M(`=mutation, `A(`=action.
Both were invoked as **Actions**. When you run a query/mutation *as an action*,
Convex rejects it **at the routing layer, before the handler executes** — which
is exactly why the backend logs show **no handler failure**.

### Exact info the Convex agent asked for
- **Deployment the app connects to:** `https://aware-newt-456.convex.cloud`
  (from `EXPO_PUBLIC_CONVEX_URL`) — this is your live deployment, not stale.
- **Function paths called:** `api.study.rooms.previewRoomByCode`,
  `api.study.rooms.submitRoomQuizAttempt` (accessed as
  `(api as any).study.rooms.*`).
- **Arguments sent:**
  - `previewRoomByCode({ code })` — `code` is 6 chars, uppercased, `[A-Z0-9]`.
  - `submitRoomQuizAttempt({ roomQuizId, answers })` — `answers` is
    `Array<{ number: number, given: string }>`, one per question in order.
- **How they were invoked (the bug):** both via `useAction`. Everything else in
  `study.rooms.*` was already correctly `useQuery`/`useMutation`.

### Fix applied in the mobile app (`src/lib/study/useRooms.ts`)
- `previewRoomByCode`: now invoked as an on-demand **query**
  (`convex.query(...)`), not an action.
- `submitRoomQuizAttempt`: now invoked as a **mutation**, not an action.
- Both go through a small `callFlexible()` helper that tries the expected type
  and, **only on a genuine function-type-mismatch error**, retries the other
  type. A real handler "Server Error" is NOT retried — it propagates. This makes
  the client resilient regardless of whether the backend registered
  `previewRoomByCode` as a query or a mutation.

### One thing for the Convex agent to CONFIRM (so we can drop the fallback later)
Please confirm the exact registered type of these two so the mobile app can pin
the correct single type:
1. `study.rooms.previewRoomByCode` → **query** or **mutation**?
2. `study.rooms.submitRoomQuizAttempt` → **mutation** (expected)?

Once confirmed, the mobile side can remove the type-fallback and call the exact
type directly. No other backend action is needed.
