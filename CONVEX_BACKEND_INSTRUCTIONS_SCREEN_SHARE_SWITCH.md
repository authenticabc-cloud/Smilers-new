# Backend Contract — Screen Share Switch (Role Swap)

Native app now ships UI for **switching screen-share control mid-session** so the current viewer can request to broadcast instead of (or after) the current sharer. UI is wired end-to-end with safe-fallback alerts. Backend needs to ship the mutations + extend `getActiveSession` response.

Applies equally to **standalone screen-share** (`/screen-share`) and **in-call screen-share** (toggled inside an active voice/video call). Same mutations cover both.

---

## 1. New mutations to add in `convex/screenSharing.ts`

### `requestSwitch`

The current **viewer** asks the sharer to hand over screen-broadcasting control.

**Args**
```ts
{ sessionId: Id<"screenSharingSessions"> }
```

**Behavior**
- Get current user via `ctx.auth.getUserIdentity()` + `users` lookup.
- Load the session by `sessionId`. Throw if not found or status !== `"active"`.
- Require `viewerId === currentUser._id` (only the current viewer can request a swap).
- Reject if `pendingSwitchRequestBy` is already set (one pending request at a time).
- Patch session: `pendingSwitchRequestBy: currentUser._id`, `pendingSwitchAt: now`.
- (Optional) Insert a notification / signal so the sharer's device is reactively notified — but since `getActiveSession` returns the row reactively, a simple patch is enough.

---

### `approveSwitch`

The current **sharer** approves the pending switch — roles swap.

**Args**
```ts
{ sessionId: Id<"screenSharingSessions"> }
```

**Behavior**
- Auth + load session.
- Require `sharerId === currentUser._id`.
- Require `pendingSwitchRequestBy` is set.
- **Atomically swap**: set `sharerId = pendingSwitchRequestBy`, `viewerId = (old) sharerId`. Clear pending fields. Bump a `renegotiationToken` (or `version`) field so both clients know to drop existing WebRTC peers and start a fresh offer/answer cycle.
- Both clients pick up the new sharerId/viewerId reactively via `getActiveSession`, swap their local roles, and renegotiate.

---

### `declineSwitch`

The current **sharer** rejects the pending switch.

**Args**
```ts
{ sessionId: Id<"screenSharingSessions"> }
```

**Behavior**
- Auth + load session.
- Either `sharerId === currentUser._id` (sharer says no), OR `pendingSwitchRequestBy === currentUser._id` (requester withdraws).
- Clear `pendingSwitchRequestBy` and `pendingSwitchAt`.

---

## 2. Extend `getActiveSession` response

The existing query already returns the session row. Please also expose:

```ts
{
  ...existingFields,
  pendingSwitchRequestBy?: Id<"users">,         // who asked
  pendingSwitchRequesterName?: string,           // resolved from users table for display
  pendingSwitchRequesterAvatar?: string | null,  // optional
  pendingSwitchAt?: string,                      // ISO timestamp
  renegotiationToken?: string,                   // bumped after approveSwitch
}
```

The mobile component already looks for these field names (with fallbacks).

---

## 3. Schema additions

Add these optional fields to the `screenSharingSessions` table:

```ts
pendingSwitchRequestBy: v.optional(v.id("users")),
pendingSwitchAt: v.optional(v.string()),
renegotiationToken: v.optional(v.string()),
```

No new indexes needed — these are read via the existing `getActiveSession`.

---

## 4. Reactivity expectations

- After `requestSwitch`, the **sharer's** device sees `pendingSwitchRequestBy` populated within ~1 second via Convex's reactive `getActiveSession`. The mobile UI then auto-opens the accept/decline modal.
- After `approveSwitch`, both devices see `sharerId/viewerId` swap and `renegotiationToken` change. The mobile WebRTC layer should drop existing peers and start a new offer/answer pair (sharer captures, viewer receives). This is handled by the existing WebRTC bootstrap code that watches the session state.
- After `declineSwitch`, the viewer sees `pendingSwitchRequestBy` cleared. The mobile component already resets the "Request sent — waiting" badge automatically.

---

## 5. Mobile usage map (already wired — no further mobile work needed)

| Mutation / field | Triggered from |
|---|---|
| `requestSwitch` | Viewer taps "Request to share my screen" in the standalone screen-share viewer overlay |
| `approveSwitch` | Sharer taps "Hand over" in the modal that auto-pops when `pendingSwitchRequestBy` arrives |
| `declineSwitch` | Sharer taps "Keep sharing" in same modal |
| `pendingSwitchRequestBy` + `pendingSwitchRequesterName` | Polled reactively from `getActiveSession({ conversationId })` and used to show the modal |

All call paths use safe-fallback so the UI degrades cleanly to a "needs backend update" alert until these ship.

---

## 6. Acceptance check

1. User A starts screen share to User B (existing flow).
2. User B taps **"Request to share my screen"** → User A's device shows a modal "User B is asking to share their screen instead of yours." within ~1 second.
3. User A taps **"Hand over"** → User A stops broadcasting, User B starts broadcasting, both peers renegotiate cleanly.
4. Repeat with **"Keep sharing"** → modal dismisses, User B sees "Request sent — waiting" badge clear, original session continues unchanged.

Same flow works inside an active voice/video call.

---

That's the full contract. Mobile side is fully implemented and waiting on these.
