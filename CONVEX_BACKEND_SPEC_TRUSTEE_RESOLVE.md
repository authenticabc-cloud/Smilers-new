# Convex Contract — Trustee "Resolve from Viewer"

Lets a **trustee/recipient** of an emergency alert mark it **resolved** from the
mobile Emergency Viewer ("I've got this"). This ONLY flips the alert record to
resolved and notifies the alerter — it must **NOT** stop the alerter's device
recording/broadcast (the alerter ends that themselves).

The mobile app already calls the new mutation and reads the new fields
(`app/emergency/[alertId].tsx`, `app/emergency.tsx`). It degrades gracefully
until this ships.

---

## 1. NEW mutation — `api.emergencyAlerts.resolveAlertByTrustee`

```ts
// args
{ alertId: Id<"emergencyAlerts"> }   // (string id)
// returns
{ ok: boolean }                      // or throw on unauthorized
```

Behavior:
1. Require an authenticated caller (the trustee/recipient viewing the alert).
2. Load the alert by `alertId`. If missing → throw / return `{ ok: false }`.
3. **Authorize**: the caller must be a legitimate recipient of this alert —
   i.e. a **trustee of the alerter** (`api.trustees` relationship), OR a
   nearby recipient for a broadcast alert. Reject otherwise.
4. If already `resolved` → **idempotent** no-op, return `{ ok: true }`.
5. Set on the alert doc:
   - `status = "resolved"`
   - `resolvedAt = <ISO string>` (server time)
   - `resolvedByUserId = <caller userId>`
   - `resolvedByName = <caller display name>`
   - `resolvedByTrustee = true`  // distinguishes from the alerter's self-resolve
6. **Do NOT** modify any broadcast/recording/location-sharing flags. The
   alerter's device keeps sharing until THEY stop it (existing
   `resolveAlert` / `stopEmergencySharing` path is unchanged).
7. **Notify the ALERTER ONLY** (not other trustees) with a push/notification,
   e.g. title "Emergency update", body "`<resolvedByName>` marked your
   emergency as resolved." (Use the existing FCM v1 `/api/send-push-internal`
   pipeline.)

Note: the alerter's own `resolveAlert({ alertId })` stays as-is (owner-only
self-resolve). This is a separate, trustee-authorized path.

---

## 2. Extend `api.emergencyAlerts.getAlertForViewer`

Add these fields to the returned object (null when not resolved by a trustee):

```ts
resolvedByName?: string | null
resolvedByUserId?: string | null
resolvedAt?: string | null       // ISO
```

The viewer shows "Resolved by `<resolvedByName>`" and hides the resolve button
once `status === "resolved"`.

---

## 3. Extend `api.emergencyAlerts.getReceivedAlerts` (inbox rows)

Each received-alert row should also include:

```ts
resolvedByName?: string | null
resolvedAt?: string | null       // ISO
status: "active" | "resolved"
```

The inbox renders "Resolved by `<resolvedByName>` · `<time>`" for resolved rows.

---

## Summary of new stored fields on `emergencyAlerts`
`resolvedByUserId`, `resolvedByName`, `resolvedByTrustee` (bool), and
`resolvedAt` (already used for self-resolve; reused here).
