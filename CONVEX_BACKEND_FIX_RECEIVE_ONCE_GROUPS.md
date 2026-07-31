# Convex backend fix — "Receive Once" dedupe must cover GROUP receipts

## Reported behavior
- **Works:** send a file to user A (1:1), then send the SAME file to user A again (1:1) → the 2nd copy is auto-hidden for A (`receiveOnceHidden = true`). ✅
- **Broken:** the same file is delivered to a user via a GROUP and also via a 1:1 (in either order) → the 2nd receipt is NOT hidden. ❌
  - Repro from device: video sent to a 1:1 chat (21:13), then forwarded to a group the same recipient belongs to (21:17). The recipient sees BOTH copies; the group copy should have been hidden for them.

## Root cause is on the backend (NOT the mobile app)
The mobile client already does its part correctly and is unchanged:
- Sender computes `fileHash` (SHA-256 of plaintext bytes) and passes it on `messages.send({ ..., fileHash })` for photos, videos and documents (`src/lib/fileHash.ts`, chat send paths).
- **Forwarding preserves it**: `messages.send({ ..., forwardOfMessageId, fileHash: originalMsg.fileHash })`.
- The client renders the tombstone purely from the backend-set per-viewer flag `message.receiveOnceHidden === true` (`MediaBubble.tsx`). It has no independent dedupe logic.

So the duplicate is not being hidden because the backend is not setting `receiveOnceHidden = true` for the second receipt when a GROUP conversation is involved.

## Required backend behavior (per RECEIVER, across the whole app)
When delivering a message that carries a `fileHash`, for EACH recipient user:
1. Determine if that recipient has ALREADY received a message with the same `fileHash` in ANY prior conversation — **including group conversations** (both as an earlier group delivery and as an earlier 1:1).
2. If yes, mark THIS delivery as `receiveOnceHidden = true` **for that recipient only** (the sender and first-recipient copies stay visible).

### Likely gaps to check
- The dedupe "have I seen this fileHash before?" lookup probably only scans the recipient's **direct (1:1)** conversations / message rows and ignores **group** message rows. It must scan across ALL conversation types the recipient is a member of.
- Group messages have ONE stored message row but MANY recipients. Ensure the per-recipient `receiveOnceHidden` is computed per member (e.g. a per-recipient receipt/visibility record), not a single flag on the shared group row — otherwise hiding it for one member would hide it for everyone (or for no one).
- Ordering: the "first" (visible) copy should be the earliest by creation time across all of that recipient's conversations; every later one (group or 1:1) is hidden.

### Data the client already sends / reads
- `messages.send({ fileHash })` — lowercase hex SHA-256 of plaintext bytes. Present on original sends AND forwards.
- Client reads back `message.receiveOnceHidden: boolean` (per current viewer) and `message.fileHash` (must be returned in `messages.list` so forwards can carry it — confirm it is).
- `api.messages.getReceiveOnceOrigin({ fileHash })` → `{ firstConversationId, firstMessageId }` is used by the "View original" tombstone action; ensure it also considers group conversations.

## Acceptance test
1. As User X, send file F to Group G (members include User Y). Y sees it once.
2. As User X, send the same file F to User Y in a 1:1. → Y's 1:1 copy shows the "received once" tombstone (hidden), tappable to view the original in Group G.
3. Reverse order (1:1 first, then Group) → the Group copy is hidden for Y.
4. The SENDER always sees their own copies; OTHER new members who never received F still see it.
