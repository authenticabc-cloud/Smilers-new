# Backend spec — "Receive once" duplicate-file hiding not firing

## Observed bug (native, reported by user)
A sender forwarded the **same audio file three times** to a 1:1 chat. All three
copies rendered as full, separately-downloadable files on the recipient's device.
Expected: the **2nd and 3rd identical copies should have been hidden** for the
recipient (the "receive once" feature), showing the tap-to-reveal footprint
instead of a duplicate downloadable file.

Screenshot facts: 1st file `AUD-…opus`, then two identical `a2442105-…` copies
(same content/hash) sent seconds apart — none were hidden.

## What the mobile app already does (verified)
The native client sends a plaintext **`fileHash`** (SHA-256 of the decrypted
bytes, lowercase hex) on `messages.send` for every image / video / file /
document — and preserves it on forward:

- `app/chat/[conversationId].tsx`
  - image: `fileHash` (computeFileHashFromUri)
  - video: `fileHash`
  - document/file (incl. `.opus`/`.ogg` shared from device Files): `fileHash`
  - forward: passes through `msg.fileHash` when present
- In-app **voice notes** (`type:'voice'`) intentionally do NOT send a hash
  (each recording is unique — receive-once does not apply).

The client also already CONSUMES the feature:
- Renders the hidden state when a message has `receiveOnceHidden === true`.
- `messages.getReceiveOnceOrigin({ fileHash }) → { firstConversationId, firstMessageId }`
- `messages.allowReceipt({ messageId })` to un-hide a copy.

So the mobile side is complete. The **hiding decision is server-side** and is
not being applied.

## Required backend behaviour (Convex — web team)
On `messages.send`, when the incoming message carries a `fileHash`:

1. Look up whether **this recipient** has ALREADY received a message with the
   **same `fileHash`** (in ANY conversation, any earlier `_creationTime`).
2. If yes → set **`receiveOnceHidden: true`** on the NEW copy **for that
   recipient's read** (the recipient's `messages.list` should return the field
   as `true`). The sender keeps their normal view.
3. The FIRST received copy stays fully visible; only subsequent duplicates are
   hidden.
4. Keep `getReceiveOnceOrigin({ fileHash })` returning the first copy's
   `conversationId` + `messageId`, and `allowReceipt({ messageId })` clearing
   `receiveOnceHidden` for that one message.

### Likely root cause to check
- The dedup lookup may only be scoped to a single conversation, or may be
  gated by a feature flag, or may not run when the message `type` is `file`/
  `document` (these `.opus`/`.ogg` came through as documents).
- Confirm `fileHash` is actually being persisted on the message doc and indexed
  so the per-recipient duplicate lookup is cheap.

## Test to reproduce
Forward/send the same file 3× from account A to account B → on B, copies #2 and
#3 must come back with `receiveOnceHidden: true`; tapping offers
"View original" (routes to copy #1) and "Allow receipt".
