# Web Team Spec — Stop call-escalation from creating Groups + clean up existing ones

**Owner:** Web team (Convex backend + web client)
**Reported by:** Mobile (native) team
**Priority:** P1 — user-facing clutter in the Groups tab

---

## 1. Problem (confirmed root cause)

When a user **adds a participant to a 1:1 call**, the client creates a brand-new
`type:"group"` conversation via `api.conversations.createGroup({ name, memberIds })`
(auto-named e.g. `"Alice + Bob"`, `"Bob conference"`, `"Conference call"`).

Per the web team's own schema review, there is **no field** on the
`conversations` table that marks a conversation as a call/conference — `type`
is only `"direct"` | `"group"`, and calls live in a separate `calls` table
referencing `conversationId`.

➡️ Consequence: every "add participant" escalation leaves behind a **permanent,
real group conversation** that `api.conversations.listGroups` returns, so it
shows up in the Groups tab forever next to deliberately-created groups. Users do
not consider these groups.

**Mobile status:** the native app already STOPPED creating these (its in-call
"Add participant" is now a no-op alert; the new group-calling feature uses
`api.calls.initiateCall` which references the EXISTING conversation and creates
NO new group). The remaining source of new junk groups is the **web client**.

---

## 2. Fix A — Do NOT create a conversation on add-participant (both clients, web is the live one)

A multi-party call does **not** need a new conversation. Call membership is
tracked independently in the `calls`/conference layer keyed by `callId`. So
adding someone to an ongoing call should:

1. Reuse the **existing** `callId` (created by `api.calls.initiateCall` for the
   original 1:1 call — it already references the original `conversationId`).
2. Add the new user to the **conference roster** for that `callId`
   (e.g. `api.conference.addParticipant({ callId, userId })` or invite/ring
   them so they `joinConference({ callId })`).
3. **Ring** the new user via the normal call push (`data.type:"call"`,
   carrying the shared `callId`).
4. Leave the underlying conversation(s) untouched — **no `createGroup`.**

Result: the call becomes multi-party via the conference roster + mesh, and
**zero** new group conversations are created.

> If there's a product reason a multi-party call must persist as a chat thread,
> then instead of `createGroup` use a dedicated path that tags the conversation
> (see Fix B's `originType`) so it can be excluded from `listGroups`.

---

## 3. Fix B — Tag future call-spawned conversations (only if Fix A can't fully land)

If, for any flow, the backend still must create a conversation for a call, add a
stable marker so clients can exclude it:

```ts
// convex/schema.ts — conversations table
originType: v.optional(v.union(v.literal("user"), v.literal("call"))), // default "user"
// (or: isCallConversation: v.optional(v.boolean()))
```

- Set `originType: "call"` whenever a conversation is created as a side effect
  of a call/conference escalation.
- Update `api.conversations.listGroups` to **exclude** `originType === "call"`.

Mobile already filters defensively on `isConference` / `groupType:'call'` /
`isCallGroup` / `isAdHoc`; if you instead add `originType`, tell us the exact
field name and we'll match it. **Preferred field name: `originType:"call"`.**

---

## 4. Fix C — One-time cleanup / backfill of EXISTING junk groups

Existing call-spawned groups have **no marker**, so identify them by joining to
the `calls` table. Proposed Convex internal migration (pseudocode — web team to
adapt to real field names):

```ts
// Identify candidate junk groups:
//   - conversation.type === "group"
//   - has >= 1 row in `calls` (or `callHistory`) with isConference === true
//   - has ZERO real chat messages (only the call ever happened)
//   - name matches the auto-generated pattern ("A + B" | "* conference" | "Conference call")
// Be conservative: require BOTH "zero messages" AND "auto-name" to avoid
// removing any group a user actually used.

const groups = await ctx.db.query("conversations")
  .filter(q => q.eq(q.field("type"), "group")).collect();

for (const g of groups) {
  const msgCount = await ctx.db.query("messages")
    .withIndex("by_conversation", q => q.eq("conversationId", g._id))
    .take(1);
  const hasMessages = msgCount.length > 0;

  const confCall = await ctx.db.query("calls")
    .withIndex("by_conversation", q => q.eq("conversationId", g._id))
    .filter(q => q.eq(q.field("isConference"), true)).take(1);
  const cameFromConferenceCall = confCall.length > 0;

  const autoNamed = /(^.+ \+ .+$)|( conference$)|(^conference call$)/i.test(g.name ?? "");

  if (!hasMessages && cameFromConferenceCall && autoNamed) {
    // Soft-delete / archive (preferred) or set originType:"call" so it drops
    // out of listGroups. DO NOT hard-delete the `calls` history rows.
    await ctx.db.patch(g._id, { originType: "call" /* or deletedAt: Date.now() */ });
  }
}
```

**Safety:** require *both* "zero messages" *and* "auto-generated name" before
touching a group, so no group anyone actually chatted in is affected. Prefer
setting `originType:"call"` (reversible) over hard delete.

---

## 5. Acceptance criteria
- Adding a participant to a call creates **no** new `conversations` row (Fix A),
  OR any such row carries `originType:"call"` and is excluded from `listGroups`
  (Fix B).
- After the backfill (Fix C), the Groups tab shows **only** deliberately-created
  groups; no `"A + B"` / `"… conference"` call leftovers remain.
- Web and mobile Groups lists match.

## 6. What mobile will do on its side
- Already done: stopped creating call-groups; defensive `listGroups` filter in
  `app/(tabs)/groups.tsx`.
- On confirmation of the exact field (`originType` recommended), we'll align the
  filter name 1:1 so behavior is identical across platforms.
