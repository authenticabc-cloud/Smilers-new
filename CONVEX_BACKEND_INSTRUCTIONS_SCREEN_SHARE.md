# Convex Backend Instructions — Screen Share Request/Accept (Mobile)

Contract for the **Screen Share** request/accept feature shown on the
Smilers mobile app `/screen-share` route. Mirrors a familiar call-invite
pattern, but the media negotiated is **screen-only** (no camera, optional
mic for narration).

The mobile screen runs against safe-fallback Convex calls so the UI is
usable while the backend is being shipped. Once these endpoints are
deployed, requests and accept/decline events will sync across devices in
realtime via the standard Convex live-query subscriptions.

---

## Flow at a glance

```
┌─ Sender ───────────────────┐         ┌─ Receiver ───────────────┐
│ 1. /screen-share           │         │                          │
│    picks recipient + opts  │         │                          │
│ 2. screenShare.request()   │  ───►   │ listIncoming live update │
│                            │         │ 3. /screen-share-incoming│
│                            │         │    accept / decline      │
│ 4. listMyRequests update   │  ◄───   │ screenShare.accept()     │
│ 5. routes both clients to  │         │    or .decline()         │
│    /call/[shareId]?…       │         │                          │
└────────────────────────────┘         └──────────────────────────┘
```

After Accept, both clients route into the existing call screen with
`?type=screen&screenOnly=1&audio=<0|1>` query params. The call screen
runs in **screen-only mode**:

* Auto-starts screen capture on the sender's device (no camera setup).
* Hides the camera tile / camera toggle entirely.
* Mic is muted by default; only toggleable when the sender chose
  "Include microphone narration" at request time (the `audio=1` param).
* Stop button labelled **Stop Sharing** instead of End Call.

---

## Queries (live)

### `screenShare.listIncoming({}) → Array<IncomingShareRequest>`

Returns the current user's *pending* incoming screen share requests
(status === "pending"). The mobile receiver subscribes via Convex live
query and renders a fullscreen "User X wants to share their screen with
you" modal as soon as a request appears.

```ts
type IncomingShareRequest = {
  _id: Id<"screenShareRequests">;
  shareId: string;            // stable id used for accept/decline + routing
  sender: {
    userId: Id<"users">;
    displayName: string;
    avatarUrl?: string;
  };
  includeAudio: boolean;      // whether sender wants mic narration enabled
  requestedAt: number;        // ms-since-epoch
};
```

### `screenShare.listMyRequests({}) → Array<OutgoingShareRequest>`

Sender-side mirror — pending requests the current user has initiated.
Used by the sender's "waiting for accept" screen. Each item has the same
shape as IncomingShareRequest but `sender` is replaced with `recipient`.

### `screenShare.getActiveSession({}) → ActiveShareSession | null`

Returns the active session if one is in flight (either as sender or
receiver). Mobile uses this to resume into the call screen when the app
is reopened mid-session.

```ts
type ActiveShareSession = {
  _id: Id<"screenShareSessions">;
  shareId: string;
  role: "sender" | "receiver";
  peerUserId: Id<"users">;
  includeAudio: boolean;
  startedAt: number;
};
```

---

## Mutations

### `screenShare.request({ recipientUserId, includeAudio }) → { shareId }`

* `recipientUserId: Id<"users">`
* `includeAudio?: boolean` — defaults `false`.

Creates a new pending request and notifies the recipient via the
standard Convex realtime subscription (and ideally a push notification
too). Returns `shareId` which the sender uses to subscribe to its own
request status updates.

**Validation:**
* Block if the recipient has the sender on their block list.
* Optionally rate-limit (e.g. max 5 pending requests per sender).

### `screenShare.accept({ shareId }) → { sessionId, signalingChannel }`

Receiver-side. Transitions the request to "active", creates a
`screenShareSessions` row, and returns the signaling channel id used for
WebRTC SDP/ICE exchange. Mobile then routes to
`/call/<shareId>?type=screen&screenOnly=1&audio=<0|1>&role=receiver`.

### `screenShare.decline({ shareId }) → null`

Receiver-side. Marks the request as declined and removes it from both
parties' lists. Sender sees the "Request declined" toast immediately.

### `screenShare.end({ shareId }) → null`

Either side can call this to terminate an active session. Mobile fires
this from the "Stop Sharing" button in the call screen.

---

## Push notifications (recommended)

When `screenShare.request` fires, send a push notification to the
recipient with:

* Title: `"<Sender name> wants to share their screen"`
* Data payload: `{ type: "screen_share_request", shareId, senderName,
  includeAudio }`

The mobile app's notification handler should route the user to the
existing `/screen-share-incoming?shareId=<id>` route on tap — same modal
the in-app live-query subscription opens automatically.

---

## Schema (suggested)

```ts
defineSchema({
  screenShareRequests: defineTable({
    shareId: v.string(),
    senderUserId: v.id("users"),
    recipientUserId: v.id("users"),
    includeAudio: v.boolean(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("cancelled"),
      v.literal("expired"),
    ),
    requestedAt: v.number(),
  })
    .index("by_shareId", ["shareId"])
    .index("by_recipient", ["recipientUserId", "status"])
    .index("by_sender", ["senderUserId", "status"]),

  screenShareSessions: defineTable({
    shareId: v.string(),
    senderUserId: v.id("users"),
    recipientUserId: v.id("users"),
    signalingChannel: v.string(),
    includeAudio: v.boolean(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_shareId", ["shareId"]),
});
```

---

## Mobile fallback behaviour (already implemented)

* If `screenShare.request` throws `CouldNotFindFunction`, the sender
  sees an informative "Backend hasn't shipped yet" message — the local
  UI doesn't pretend the request was sent.
* If the live query returns `undefined` because the endpoint doesn't
  exist, `useSafeConvexQuery` falls back to `[]` so the incoming-request
  modal simply never opens until the backend is ready.
* The active call-screen mode (`?type=screen&screenOnly=1`) works
  independently — once the user manually navigates there, screen capture
  still starts via the existing `getDisplayMedia()` path with the iOS
  Broadcast Extension / Android MediaProjection wiring described in
  `/app/SCREEN_SHARING_SETUP.md`.
