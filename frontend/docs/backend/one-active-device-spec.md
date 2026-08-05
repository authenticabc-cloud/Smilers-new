# Backend Spec — "One Active Device Only" (Bug 2b)

This spec is for the **web team's Convex repo** (the mobile app only consumes
`anyApi`; it never defines backend functions). The mobile client scaffold is
already shipped in:

- `src/lib/deviceIdentity.ts` — stable per-device UUID + device name
- `src/providers/ActiveDeviceProvider.tsx` — claim / takeover / eviction UX
- Wired into `app/(tabs)/_layout.tsx` (wraps the authenticated tabs)

The client is **feature-flagged OFF** (`EXPO_PUBLIC_ONE_ACTIVE_DEVICE_ENABLED`)
and **no-ops safely** until every function below exists. Flip the flag to
`true` once these are deployed.

---

## Policy

- An account may be **actively signed in on ONE device** at a time.
- Signing in on a **new device** must **warn the old device** and require it to
  **confirm** the transfer. On confirmation the old device is signed out and the
  new device becomes active.
- Claiming/taking over the active slot requires **Face ID** on the new device
  (the client already gates the takeover mutation behind biometrics and sends
  `faceVerified: true`).

## Data model (suggested)

Table `deviceSessions`:

| field           | type     | notes                                         |
|-----------------|----------|-----------------------------------------------|
| userId          | Id<users>| owner                                         |
| activeDeviceId  | string   | UUID of the currently-active device           |
| activeDeviceName| string   | human-readable name                           |
| platform        | string   | "iOS" / "Android" / "Web"                     |
| updatedAt       | number   | last heartbeat/claim (ms)                     |
| pendingDeviceId | string?  | device requesting takeover (if any)           |
| pendingDeviceName| string? | its name                                      |
| pendingAt       | number?  | when the takeover was requested (ms)          |

One row per user (upsert by `userId`).

## Functions (exact names the client calls)

### `query api.deviceSessions.getActiveDevice()`
Auth: current user. Returns for the caller's account:
```ts
{
  activeDeviceId: string | null,
  activeDeviceName: string | null,
  updatedAt: number,
  pendingTakeover?: { deviceId: string, deviceName?: string, requestedAt?: number } | null
} | null
```
Must be a **live/reactive** query (the client subscribes via `watchQuery`).

### `mutation api.deviceSessions.claimActiveDevice({ deviceId, deviceName, platform, faceVerified, requestTakeover })`
- If **no active device** for the account (or `activeDeviceId === deviceId`):
  set this device active immediately, clear any pending takeover.
- If **another device is active** and `requestTakeover === true`:
  set `pendingDeviceId/Name/At = this device` (do **not** switch active yet).
  Reject if `faceVerified !== true`.
- Idempotent: safe to call repeatedly.

### `mutation api.deviceSessions.confirmTakeover({ deviceId })`
Called by the **currently-active (old) device** to approve. Sets
`activeDevice = pendingDevice`, clears pending. The old device's
`getActiveDevice` will now report a different `activeDeviceId` → the client
signs the old device out automatically.
Auth: caller must currently be the active device; `deviceId` must equal
`pendingDeviceId`.

### `mutation api.deviceSessions.denyTakeover({ deviceId })`
Called by the active (old) device to reject. Clears pending fields only;
active device unchanged.

### `mutation api.deviceSessions.heartbeat({ deviceId })` (optional)
Bumps `updatedAt` while `deviceId` is the active device. Client calls it every
~60s and on foreground. Safe to omit — client guards for its absence.

## Security notes

- All mutations must derive `userId` from the authenticated identity — never
  trust a client-supplied user id.
- Enforce `faceVerified === true` server-side for takeover claims.
- Consider a `pendingAt` TTL (e.g. auto-expire a takeover request after 2 min)
  so a stale request can't linger on the old device.

## Client behaviour recap (already implemented)

- New device with nobody active → silent claim.
- New device while another is active → Face ID → `claimActiveDevice(requestTakeover:true)`
  → shows "Waiting for approval" overlay.
- Old device sees `pendingTakeover` → shows "New sign-in request" prompt with
  Approve (`confirmTakeover`) / Deny (`denyTakeover`).
- Any device that loses the active slot → "Signed in on another device" overlay
  → `signOut()`.
