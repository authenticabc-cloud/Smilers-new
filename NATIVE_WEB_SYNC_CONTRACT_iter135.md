# Native ↔ Web Sync Contract — Face ID + Admin Dashboard (iter-135)

> **For**: Convex backend agent (or anyone with access to the web app source)
> **From**: Mobile agent (iter-135)
> **Problem**: Native and web show **different data** for Face ID and Admin
> Dashboard, but the underlying Convex deployment is the same
> (`aware-newt-456.convex.cloud`). Root cause: the mobile code calls
> Convex paths it *assumed* exist (`api.faceId.listMyFaces`,
> `api.faceId.listTrustedDevices`, `api.admin.getStats`) but the web app
> almost certainly calls different paths and/or reads different field
> names. Because the mobile uses `anyApi`, mismatched paths return
> `undefined` silently — the screen then falls back to AsyncStorage and
> looks "out of sync" to the user.

---

## 1. Face ID

### What the native app currently calls

```ts
// app/face-id.tsx (lines 137–158)
const remoteFaces   = useSafeConvexQuery(
  api.faceId?.listMyFaces ?? api.faceId?.list, {}
);
const remoteDevices = useSafeConvexQuery(
  api.faceId?.listTrustedDevices ?? api.devices?.listTrustedDevices, {}
);
const registerFaceM   = useMutation(api.faceId?.registerFace ?? api.faceId?.create);
const deleteFaceM     = useMutation(api.faceId?.deleteFace   ?? api.faceId?.remove);
const deleteDeviceM   = useMutation(api.faceId?.deleteTrustedDevice ?? api.devices?.remove);
```

### What the native expects in the response shape

For each item in `listMyFaces` (array):
- `_id` (or `id` / `faceId`) — primary key
- `thumbnailUri` OR `imageUri` OR `image` OR `thumbnailUrl` OR `imageUrl` — a data URI / URL
- `label` — optional, falls back to "Face N"
- `registeredAt` (ms) OR `createdAt` OR `_creationTime`

For each item in `listTrustedDevices` (array):
- `_id` (or `id` / `deviceId`)
- `label` OR `name` OR `deviceName`
- `verifiedAt` (ms) OR `lastVerifiedAt` OR `updatedAt` OR `_creationTime`
- `platform` (optional, `"ios" | "android" | "web" | "desktop"`)

### What the web app shows (per user screenshot)

- Face 1, added 03/05/2026 (one registered face)
- 4 trusted devices: `K` (03/05/2026), `Windows PC` (05/05/2026), `K` (09/05/2026), `Windows PC` (10/05/2026)

### What the native app shows (per user screenshot)

- Face 1, added 08/06/2026 (a fresh face the user just registered on native)
- "No trusted devices yet."

### Required action

**Either**:
- (Preferred) Confirm the exact path and arg shape used by the web app for these 5 operations, and we will update the native paths accordingly. The simplest fix is for you to paste the 5–10 lines from the web app showing each call.
- OR add aliases on Convex so `api.faceId.listMyFaces`, `api.faceId.listTrustedDevices`, `api.faceId.registerFace`, `api.faceId.deleteFace`, `api.faceId.deleteTrustedDevice` all exist and return the shape described above.

---

## 2. Admin Dashboard

### What the native app currently calls

```ts
// app/admin.tsx
api.admin.getStats        // overview cards
api.admin.listUsers       // users tab
api.admin.listReports     // reports tab
api.admin.resolveReport   // reports tab action
api.admin.setRole         // users tab action
api.admin.suspendUser     // users tab action
api.admin.unsuspendUser   // users tab action
api.ads.approveAd         // ads tab action
```

### What the native expects from `getStats` (overview tab)

The 6 cards on native read these field names:
- `totalUsers`
- `activeToday`         ← **not on web**, web shows "Online Now"
- `newThisWeek`
- `pendingReports`
- `pendingAds`          ← **not on web**, web shows "Messages (24h)" or others
- `suspended`           ← **not on web**, web shows "Communities"

### What the web app shows (per user screenshot)

8 cards:
- `Total Users` = 7
- `Online Now` = 7
- `New This Week` = 2
- `Messages (24h)` = 21
- `Total Conversations` = 9
- `Group Chats` = 4
- `Pending Reports` = 0
- `Communities` = 0

### Mismatch summary

| Web field         | Native expects          | Native renders         |
|-------------------|-------------------------|------------------------|
| `totalUsers`      | `totalUsers`            | "—" (would work if returned, but value blank → likely field missing or differently named) |
| `onlineNow`       | `activeToday`           | "—" (wrong field name) |
| `newThisWeek`     | `newThisWeek`           | "—" |
| `messages24h`     | — (not displayed)       | n/a |
| `totalConversations` | — (not displayed)    | n/a |
| `groupChats`      | — (not displayed)       | n/a |
| `pendingReports`  | `pendingReports`        | "—" |
| `communities`     | — (not displayed)       | n/a |
| — (not on web)    | `pendingAds`            | "—" |
| — (not on web)    | `suspended`             | "—" |

### Required action

**Please paste the exact response shape returned by `api.admin.getStats`** as it's used by the web app (the type/interface, or just the keys with example values). We will then update `app/admin.tsx` to read the right fields AND render the same 8 cards the web shows.

---

## Why this can only be fixed on the mobile

The Convex deployment is the source of truth. The mobile's queries are silently mismatched. We need to either:
1. Get the **canonical names** from the web app and align the mobile, or
2. Have you add **aliases** on Convex for the names the mobile already uses.

Option 1 is cleaner and matches our team-wide preference (single contract).

---

— Smilers mobile agent (iter-135)
