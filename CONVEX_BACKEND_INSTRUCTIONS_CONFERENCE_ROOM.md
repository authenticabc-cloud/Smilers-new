# Convex Backend Contract — Conference Room Admin Mutations

The mobile app now ships a dedicated **Conference Room** screen at `/conference/[conferenceId]` that includes a participant grid and admin action sheet. This screen calls a handful of mutations that aren't in the published conferences spec. They all degrade gracefully (clear "needs backend update" alert), but please ship them so the actions become functional.

All mutations live in `convex/conferenceRoom.ts` (extending the existing module).

---

## 1. `conferenceRoom.admitParticipant`

Admit a waiting participant into an `admission` conference.

**Args**
```ts
{
  conferenceId: Id<"conferences">,
  targetUserId: Id<"users">,
}
```

**Behavior**
- Caller must be `chair` or `clerk` of the conference.
- Find the `conferenceRoles` row for `(conferenceId, targetUserId)`.
- Require `role.status === "waiting" || "invited"`.
- Update `role.status = "active"`, set `joinedAt = now`.
- Throws if caller is not authorized or role row missing.

---

## 2. `conferenceRoom.denyParticipant`

Reject a waiting participant.

**Args**
```ts
{
  conferenceId: Id<"conferences">,
  targetUserId: Id<"users">,
}
```

**Behavior**
- Caller must be `chair` or `clerk`.
- Set `role.status = "removed"`.

---

## 3. `conferenceRoom.suspendParticipant`

Temporarily mute + disable video for a disruptive participant.

**Args**
```ts
{
  conferenceId: Id<"conferences">,
  targetUserId: Id<"users">,
}
```

**Behavior**
- Caller must be `chair`.
- Cannot suspend the chair (self).
- If currently `status === "suspended"`, flip back to `"active"` (this single endpoint handles both suspend and reinstate).
- When suspending: set `status = "suspended"`, `isMuted = true`, `videoEnabled = false`.
- When reinstating: set `status = "active"` (leave mute/video as-is — user re-enables when ready).

---

## 4. `conferenceRoom.removeParticipant`

Eject a participant permanently from the meeting.

**Args**
```ts
{
  conferenceId: Id<"conferences">,
  targetUserId: Id<"users">,
}
```

**Behavior**
- Caller must be `chair`.
- Cannot remove the chair (self).
- Set `role.status = "removed"`.
- The participant should be kicked from `conferenceParticipants` (group call table) too if they're in the call.

---

## 5. `conferenceRoom.forceMuteParticipant`

Chair force-mutes (or unmutes) one specific participant.

**Args**
```ts
{
  conferenceId: Id<"conferences">,
  targetUserId: Id<"users">,
  isMuted: boolean,
}
```

**Behavior**
- Caller must be `chair`.
- Set `role.isMuted = args.isMuted` on the target's `conferenceRoles` row.
- Different from existing `conference.adminMuteParticipant` because that one keys on `callId` (group-call table), while this keys on `conferenceId` (formal conference roles table).

---

## Mobile usage map

These are all called from `/app/frontend/app/conference/[conferenceId].tsx`:

| Mutation | Trigger |
|---|---|
| `admitParticipant` | Green check in lobby row |
| `denyParticipant` | Red X in lobby row |
| `suspendParticipant` | Long-press tile → "Suspend participant" |
| `removeParticipant` | Long-press tile → "Remove from meeting" |
| `forceMuteParticipant` | Long-press tile → "Force mute" / "Force unmute" |

All calls are wrapped with safe-fallback alerts so the UI stays functional until these ship.

---

## Notes on Audience-Aware Chat (no backend change needed yet)

The mobile chat composer now lets users target messages to `Everyone | Chair | Clerk/Secretary`. Since `conferenceChat.sendMessage` only accepts `{conferenceId, text, encrypted?, iv?}`, the audience is encoded as a text prefix:

```
[To: Chair] Hello chair, please call for a vote.
[To: Clerk] Please log this as a motion.
```

The mobile client parses this prefix on receive and:
- Strips it from the displayed body
- Adds an "audience badge" to the bubble
- **Filters out messages targeted at audiences the viewer isn't part of** (only chair sees `[To: Chair]`, only clerk sees `[To: Clerk]`, sender always sees their own)

**Future improvement:** Add an explicit `audience: "everyone" | "chair" | "clerk"` field to the `conferenceChat` schema + `sendMessage` args so filtering happens server-side instead of client-side. Until then the prefix scheme works fine.
