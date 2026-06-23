# Web team request — call-escalation "conference" groups leak into the Groups tab

## Problem
When a 1:1 call has a participant ADDED, a multi-party conversation is created.
On mobile this used `api.conversations.createGroup({ name: "<A> + <B>" | "<X> conference", memberIds })`
— i.e. a **plain group with no marker**. As a result these call-spawned
conversations are returned by `api.conversations.listGroups` and show up in the
mobile **Groups** tab next to real, deliberately-created groups. Users do not
consider these groups.

## What mobile already did
- Mobile no longer creates them: the in-call "Add participant" action is now a
  no-op alert (group calling moved to the proper `api.calls.initiateCall` +
  `api.conference.*` flow, which creates a CALL, not a group conversation).
- Mobile Groups tab now filters out anything flagged as a conference/call
  conversation: it drops items where any of these are truthy —
  `isConference`, `conversationType==='conference'`, `type==='conference'`,
  `groupType==='call'`, `isCallGroup`, `isAdHoc`, or (`callType|callId` present
  without an explicit group identity). See `isRealGroup()` in
  `app/(tabs)/groups.tsx`.

## What we need from the backend (web team)
These call-escalation conversations are **indistinguishable from real groups**
at the data level (both come from `createGroup`), so the client cannot reliably
hide pre-existing ones. Please do ONE of:

1. **Preferred:** stop creating a group conversation for call escalation — use
   the `api.calls.initiateCall` + `api.conference.*` (callId-scoped) flow the
   group-calling feature already uses, so no `conversations` doc is created.

2. **Or** tag call-escalation groups on creation with a stable flag (e.g.
   `isConference: true` or `groupType: 'call'`) AND exclude those from
   `api.conversations.listGroups`. If you add `isConference`, the mobile filter
   above will hide them automatically — but the real fix is excluding them at
   the source so web and mobile stay consistent.

Please confirm which field (if any) currently marks these so we can tighten the
mobile filter to match exactly.
