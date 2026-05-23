# Convex Backend Instructions — Face ID (Mobile)

Contract for the **Face ID** identity-verification feature shown on the Smilers
mobile app `/face-id` screen. Mirrors the web app's existing UX:

* Up to **3 registered faces** per user.
* List of **trusted devices** the user has previously verified from.
* Adding a face captures a **front-camera selfie**.
* Removing a face / trusted device immediately revokes its trust.

The mobile screen already runs against a local AsyncStorage fallback so the
UI is usable while the backend is being shipped. Once these endpoints are
deployed, registered faces and trusted-device entries will sync automatically.

---

## Queries

### `faceId.listMyFaces({}) → Array<Face>`

Returns the current user's registered faces, newest first. Empty array if
none registered.

```ts
type Face = {
  _id: Id<"faces">;
  thumbnailUri: string;   // either data: URI or remote storage URL
  label: string;          // e.g. "Face 1"
  registeredAt: number;   // ms-since-epoch
};
```

Mobile reads any of these fields (in order): `thumbnailUri`, `imageUri`,
`image`, `thumbnailUrl`, `imageUrl`. Use whichever shape your existing
storage already produces.

### `faceId.listTrustedDevices({}) → Array<TrustedDevice>`

Returns devices that have completed a successful Face ID verification.

```ts
type TrustedDevice = {
  _id: Id<"trustedDevices">;
  label: string;          // e.g. "K", "Windows PC"
  verifiedAt: number;     // ms-since-epoch, last successful verification
  platform?: "ios" | "android" | "web" | "desktop" | string;
};
```

The mobile app uses `platform` to pick a phone vs desktop icon — falling
back to phone if absent.

---

## Mutations

### `faceId.registerFace({ imageBase64, mimeType, label }) → { _id, faceId? }`

Args:

* `imageBase64: string` — raw base64 (no `data:` prefix). The mobile client
  encodes the selfie at JPEG quality `0.6` to keep payloads small.
* `mimeType: string` — typically `image/jpeg`.
* `label?: string` — optional label like `"Face 1"`.

Returns either `{ _id }` or `{ faceId }`. Both shapes are accepted by the
mobile client.

**Enforce max-3 server-side** — if the user already has 3 faces, throw.

### `faceId.deleteFace({ faceId }) → null`

Removes a registered face. `faceId` is the `_id` from `listMyFaces`.

### `faceId.deleteTrustedDevice({ deviceId }) → null`

Revokes a trusted device. Next sign-in from that device should require a
fresh Face ID verification.

---

## Notes for the mobile client (already implemented)

* If the backend mutation throws `CouldNotFindFunction`, the mobile client
  silently keeps the face in **AsyncStorage** on the local device. Once the
  backend ships, new registrations will route through Convex and the locally
  cached entries can be migrated by the user re-adding them, or by a one-time
  background sync that the web team can write later.
* Mobile assigns ids prefixed with `local_` to locally-only entries — the
  client never sends those to the delete mutations.
* The mobile screen surfaces a "Protect your account" info card matching the
  web copy:
  > Register up to 3 faces. When you log in from a new device, a quick selfie
  > will verify your identity.

---

## Alternative naming

If your existing Convex schema already uses different names, the mobile
client probes these alternate paths automatically:

| Mobile lookup            | Primary                    | Alternate                  |
|--------------------------|----------------------------|----------------------------|
| List faces query         | `faceId.listMyFaces`       | `faceId.list`              |
| Register face mutation   | `faceId.registerFace`      | `faceId.create`            |
| Delete face mutation     | `faceId.deleteFace`        | `faceId.remove`            |
| Trusted devices query    | `faceId.listTrustedDevices`| `devices.listTrustedDevices` |
| Delete device mutation   | `faceId.deleteTrustedDevice`| `devices.remove`          |

Pick whichever pair matches your codebase — the mobile app will hit the
first one that exists.
