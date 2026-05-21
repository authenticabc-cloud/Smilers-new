# Convex Backend Contract — Groups Slice A

The native mobile Group Details screen (`/app/group/[id]`) calls the following
Convex queries + mutations. The web team must ship matching server-side
implementations so the actions actually persist. Until they do, the mobile
screen still renders and surfaces an inline 'needs latest backend update'
alert for each missing endpoint.

All `conversationId` and `userId` fields are Convex IDs (strings on the wire).

---

## Queries

### `conversations.getGroupDetails({ conversationId })`

Should return a single group conversation object the screen consumes:

```ts
{
  _id: Id<"conversations">,
  name: string,
  description?: string,
  avatar?: string,            // URL or storageId-resolved URL
  memberCount?: number,       // optional, fallback to memberRecords.length
  messageApprovalRequired?: boolean,
  viewerUserId?: string,      // current authed user's id; used to gate admin UI
  memberRecords: Array<{      // OR `members` / `participants` (any accepted)
    userId: string,
    name?: string,            // display name; resolved server-side preferred
    avatar?: string,
    role?: "chief" | "admin" | "member",
    suspendedUntil?: number,  // ms-since-epoch; in the future = still suspended
    blocked?: boolean,
  }>,
}
```

If the field doesn't exist yet, the screen falls back to a row from
`conversations.listGroups`. The richer shape simply makes admin features work.

### `conversations.listRegulations({ conversationId })`

Returns the regulations board, oldest first:

```ts
Array<{
  _id: Id<"groupRegulations">,
  text: string,
  postedByUserId: string,
  createdAt: number,
}>
```

---

## Mutations (all admin-gated server-side)

| Name | Args | Notes |
|------|------|-------|
| `conversations.updateGroup` | `{ id, name?, description? }` | future use |
| `conversations.addMembers` | `{ conversationId, userIds: string[] }` | from `/groups-create?addToConversation=…` |
| `conversations.removeMember` | `{ conversationId, userId }` | admin only |
| `conversations.promoteToAdmin` | `{ conversationId, userId }` | enforces ≤20% admins per spec |
| `conversations.demoteAdmin` | `{ conversationId, userId }` | chief admin only |
| `conversations.suspendMember` | `{ conversationId, userId, durationMs }` | spec: 24h / 7d / 1w; suspended admins lose all rights |
| `conversations.unsuspendMember` | `{ conversationId, userId }` | only chief admin can lift Admin suspensions |
| `conversations.blockMember` | `{ conversationId, userId }` | admin only |
| `conversations.passChiefAdmin` | `{ conversationId, toUserId }` | spec: original creator can always reclaim; non-creator chief can only pass back to creator until creator leaves |
| `conversations.toggleMessageApproval` | `{ conversationId, enabled }` | admin gate for message approval feature |
| `conversations.generateInviteLink` | `{ conversationId }` → `{ url, expiresAt }` | admin only |
| `conversations.postRegulation` | `{ conversationId, text }` | admin only; max 400 chars |
| `conversations.leaveGroup` | `{ conversationId }` | for any member |

Error contract: throw `ConvexError` with a descriptive `message` — the mobile
client surfaces it directly in an alert.

---

## Spec-driven server-side enforcement (NOT mobile concerns)

The mobile UI gates visibility based on the viewer's role hint, but final
authorization must be enforced server-side per the spec:

* Admin cap: `floor(memberCount * 0.2)` minimum guarantees at least one admin
* Chief admin: exactly one per group; suspended admin loses all admin rights
* Suspension: while `suspendedUntil > now`, block all `messages.send` writes
  from that user in this group + hide reactions/composer
* Message approval: when toggled on, route new messages to a pending queue
  the admin can approve/reject (mobile UI for the queue is in Slice B)
