# Smilers — Convex Backend Requirements (for the web-app / Convex team)

These functions live in your **external web-app Convex backend** (`aware-newt-456.convex.cloud`),
NOT in the mobile repo. The mobile app only *calls* them via `anyApi`. Each item below is
currently either returning a **generic `Server Error`** or behaving incorrectly, which blocks
the corresponding mobile feature. Please fix on the backend side.

> The mobile app is already wired and will start working immediately once these are corrected
> — no mobile rebuild is required for backend-only fixes (except where noted).

---

## 1. `messages:addReaction` — Server Error  (P0, blocks message reactions everywhere)
- **Mobile calls:** `api.messages.addReaction({ messageId, emoji, conversationId })`
  - Also retries with a minimal-arg form `{ messageId, emoji }` if the first throws.
- **Symptom:** every emoji reaction returns a bare `[CONVEX M(messages:addReaction)] Server Error`.
- **Needed:** accept `{ messageId: Id<'messages'>, emoji: string, conversationId?: Id<'conversations'> }`,
  upsert/toggle the reaction for the calling user, and return without throwing.
  Please confirm the **exact accepted arg names** so we can drop the fallback.

## 2. Study Room creator is NOT recognised as a member  (P0)
- **Mobile calls:** `api.study.rooms.createRoom({ name, description? })` then reads
  `api.study.rooms.getRoom({ roomId })`.
- **Symptom:** right after creating a room, `getRoom` returns `null` (the app treats `null` as
  "you're not a member") — so the creator is locked out of the room they just made.
- **Needed:** `createRoom` must add the creator to the room's `members` (role `owner`/`admin`) so
  `getRoom` returns the room for them. `getRoom` should return the room (with `members[]`) for any member.

## 3. Room join codes not generating  (P0)
- **Mobile reads:** `room.joinCode` (falls back to `room.code`) from `getRoom`, and calls
  `api.study.rooms.regenerateJoinCode({ roomId })`.
- **Symptom:** rooms have no `joinCode`/`code`, so members can't share/join by code, and
  "Regenerate code" fails.
- **Needed:** `createRoom` should generate a unique **6-char uppercase** join code and persist it
  on the room doc (as `joinCode`). `regenerateJoinCode({ roomId })` should issue a new unique code
  (owner/admin only). `api.study.rooms.joinRoom({ code })` and
  `api.study.rooms.previewRoomByCode({ code })` must resolve that code.

## 4. `study/rooms:removeMember` — Server Error  (P1)
- **Mobile calls:** `api.study.rooms.removeMember({ roomId, userId })`.
- **Symptom:** removing/kicking a member throws a generic `Server Error`.
- **Needed:** accept `{ roomId, userId }`, authorise (owner/admin only), remove the target from
  `members`, return without throwing. Please confirm arg names (`userId` vs `memberId`).

## 5. `study/rooms:submitRoomQuizAttempt` — Server Error  (P1)
- **Mobile calls (Convex ACTION):** `api.study.rooms.submitRoomQuizAttempt({ roomQuizId, answers })`
  where `answers` is a payload of the user's selected answers per question.
- **Symptom:** submitting a room quiz throws a generic `Server Error`, so scores/leaderboard never record.
- **Needed:** grade server-side, store the member's best attempt, return the graded result.
  Please confirm the expected **`answers` shape** (e.g. `Array<{ questionId, selectedIndex }>` vs a map).

## 6. Group `messages.list` query is slow  (P2, perf)
- **Mobile calls:** `api.messages.list({ conversationId, paginationOpts })`.
- **Symptom:** **group** conversations spin for a long time before loading; 1:1 chats are instant.
  Strongly suggests the group-message query is heavier server-side (missing index / N+1 on
  sender/attachment lookups).
- **Needed:** add/verify an index on `messages` by `conversationId` (+ creation time) and avoid
  per-message extra reads so group history paginates as fast as 1:1.

---

### For each of the above, please share back:
1. The **exact function path** and **accepted argument names/types**.
2. Whether it's a `query` / `mutation` / `action`.
3. The **return shape** (so we can render it directly).

Once corrected, message reactions, Study Rooms (create/join/codes/members/quizzes), and fast
group loading will all work on the current mobile build.
