# Convex Backend Spec — Chief-Admin Election by Majority Vote

**Audience:** Smilers web/Convex team (this logic MUST live in the Convex repo — the
mobile app cannot create Convex tables/mutations; it only consumes `api.*`).

**Mobile status:** UI will be built against the contract below once these functions
are deployed. Nothing on mobile can enforce vote tallies or assign a chief admin
(the chief-assignment mutation is permission-gated server-side), so this is a hard
backend dependency.

---

## Goal / product rule

> If any group **or sub group** is **without a chief admin**, any member may
> **propose themselves** as chief admin. The proposal is approved by a **simple
> majority** of the group's/sub-group's membership. This must **not contradict**
> the existing **automatic** chief-admin assignment (auto-succession). It applies
> to **all existing** groups/sub groups that are currently without a chief admin.

### Interaction with automatic assignment (important)
- Auto-succession (the existing `leaveGroup` / `removeGroupMember` logic that picks
  an earliest-joined admin/member as the new chief) **still runs first and wins**.
- The **election is only available when `chiefAdmin` is genuinely empty/null** for
  the conversation (e.g. legacy groups that predate auto-succession, or a group
  whose chief left before the auto-succession code existed, or any edge case that
  left `chiefAdmin` unset).
- The instant a chief exists (auto-assigned OR elected), any open election for that
  conversation is **closed/cancelled** and no new election can be opened. Opening an
  election must re-check `chiefAdmin == null` inside the mutation (not just the client).

---

## Definitions

- **Membership count `N`** = number of ACTIVE members of the conversation
  (`conversations.members` for the group/sub group; for a sub group use its own
  member list, not the mother group's).
- **Simple majority** = `floor(N / 2) + 1` approve votes.
  - Examples: N=3 → 2, N=4 → 3, N=5 → 3, N=6 → 4.
- A member may cast **one** vote per open election (approve or reject); re-casting
  updates their vote. The proposer is counted as an implicit **approve** (1 vote).

---

## Data model

New table `chiefElections`:
```ts
chiefElections: defineTable({
  conversationId: v.id("conversations"),
  candidateUserId: v.id("users"),      // the member proposing themselves
  status: v.union(
    v.literal("open"),
    v.literal("passed"),
    v.literal("failed"),
    v.literal("cancelled"),
  ),
  createdAt: v.number(),
  closesAt: v.number(),                // e.g. createdAt + 48h auto-expiry → "failed"
  membershipAtStart: v.number(),       // N captured when opened (audit)
  requiredApprovals: v.number(),       // floor(N/2)+1 captured at open
})
  .index("by_conversation", ["conversationId"])
  .index("by_conversation_status", ["conversationId", "status"]),
```

New table `chiefElectionVotes`:
```ts
chiefElectionVotes: defineTable({
  electionId: v.id("chiefElections"),
  voterUserId: v.id("users"),
  vote: v.union(v.literal("approve"), v.literal("reject")),
  votedAt: v.number(),
})
  .index("by_election", ["electionId"])
  .index("by_election_voter", ["electionId", "voterUserId"]),
```

Only **one** `status:"open"` election per conversation at a time.

---

## Mutations

### `groupAdmin.proposeChiefAdmin({ conversationId })`
- Auth: caller must be an **active member** of the conversation.
- **Reject** (throw) if `conversation.chiefAdmin` is set (a chief already exists).
- **Reject** if an `open` election already exists for this conversation
  (return that election id instead, or throw `ELECTION_ALREADY_OPEN`).
- Compute `N`, `requiredApprovals = floor(N/2)+1`.
  - If `N === 1` (caller is the only member) → assign them chief immediately, emit
    `chiefTransferred` system message, **no election**.
- Insert `chiefElections` (`status:"open"`, `candidateUserId = caller`,
  `closesAt = now + 48h`), insert the candidate's own `approve` vote.
- Emit a system message: `"<Name> is proposing to become the Chief Admin — members, please vote."`
- Return `{ electionId }`.

### `groupAdmin.voteChiefAdmin({ electionId, vote })`  // vote: "approve" | "reject"
- Auth: caller must be an active member of the election's conversation and **not**
  the candidate (candidate is auto-approve; ignore or throw if they call this).
- Reject if election `status !== "open"`.
- Upsert the caller's vote in `chiefElectionVotes` (one per voter; updates on re-cast).
- **Tally after every vote:**
  - `approvals = count(approve)`, `rejections = count(reject)`.
  - If `approvals >= requiredApprovals` → **PASS**:
    - Set `conversation.chiefAdmin = candidateUserId` (and add to `admins`/`adminOrder`
      if not already an admin — a chief is always an admin).
    - Set election `status = "passed"`.
    - Emit `chiefTransferred` (so the existing native handler renders
      "X is now the Chief Admin"; see iter-478).
  - Else if `rejections >= requiredApprovals` (majority already rejected → can't pass)
    → set election `status = "failed"`; emit `"The chief-admin proposal did not pass."`.
  - Else keep `open`.
- Return `{ status, approvals, rejections, requiredApprovals }`.

### `groupAdmin.cancelChiefElection({ electionId })` (optional)
- Auth: the candidate may withdraw. Sets `status = "cancelled"`.

### Auto-close hook
- When a chief becomes set by ANY path (auto-succession, manual transfer, N===1
  shortcut), **cancel** any `open` election for that conversation.
- A cron (or lazy check in the query) flips `open` elections past `closesAt` to
  `failed`.

---

## Queries

### `groupAdmin.getChiefElection({ conversationId })`
Returns `null` when `chiefAdmin` is set OR there is no open election. Otherwise:
```ts
{
  electionId,
  candidateUserId,
  candidateName,           // resolved display name
  status: "open",
  approvals: number,
  rejections: number,
  requiredApprovals: number,
  membershipCount: number,
  closesAt: number,
  myVote: "approve" | "reject" | null,   // caller's current vote
  iAmCandidate: boolean,
  canPropose: boolean,     // true when chiefAdmin==null && no open election && caller is member
}
```
This single reactive query drives the whole mobile UI (live vote counts update as
members vote). Return it for both groups and sub groups (use the sub group's own
membership).

---

## Edge cases the mobile team needs handled server-side
1. Membership changes mid-election: tally uses `requiredApprovals` captured at open
   (documented in `membershipAtStart`). If a voter leaves, keep their vote (simplest)
   — the captured threshold keeps the math stable. (Confirm this choice.)
2. Candidate leaves the group mid-election → auto-`cancelled`.
3. Two members propose near-simultaneously → the `ELECTION_ALREADY_OPEN` guard means
   only the first opens; the second gets the existing election id.
4. Re-check `chiefAdmin == null` **inside** `proposeChiefAdmin` and inside the PASS
   branch of `voteChiefAdmin` to avoid races with auto-succession.
5. Applies to existing groups automatically — no migration needed; `getChiefElection`
   simply returns `canPropose:true` for any chief-less conversation.

---

## Mobile UI plan (built once the above ships)
- Group Info + Chat header of any chief-less group/sub group shows a banner:
  **"This group has no Chief Admin."** with a **"Propose myself as Chief Admin"** button
  (`proposeChiefAdmin`) when `canPropose`.
- While an election is `open`: a vote card shows the candidate, live
  `approvals / requiredApprovals`, and **Approve / Reject** buttons (`voteChiefAdmin`),
  disabled/replaced by "You voted ✓" after voting; the candidate sees a progress view.
- On PASS the existing `chiefTransferred` toast/system message already announces the
  new chief (iter-478) — no extra mobile work.

**Please confirm the function names/return shapes** (or adjust) so the mobile UI
matches exactly.
