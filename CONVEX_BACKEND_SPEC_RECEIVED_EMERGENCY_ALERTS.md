# Backend spec — `emergencyAlerts.getReceivedAlerts` (trustee inbox)

## Goal
Give trustees an in-app inbox of the emergency alerts they've RECEIVED (i.e.
alerts from people who added them as a trustee), so they can reopen a past alert
and view its live location + recordings/captures WITHOUT relying on the push
notification (which can be missed or swiped away).

The **native app is done** and now:
- On the Emergency screen it renders an "ALERTS FROM PEOPLE WHO TRUST YOU"
  section from `api.emergencyAlerts.getReceivedAlerts` (safe-subscribed → the
  section is simply empty until this query ships).
- Each row taps to the existing viewer route `/emergency/<alertId>` which already
  calls `api.emergencyAlerts.getAlertForViewer({ alertId })`.

## Required query (Convex — web team)
```ts
// emergencyAlerts.getReceivedAlerts
export const getReceivedAlerts = query({
  args: {},                       // current user derived from auth identity
  handler: async (ctx) => {
    // Return recent alerts where the CURRENT user is a trustee of the alert's
    // owner (and/or was explicitly notified for the alert). Newest first.
    // Suggested cap: last ~30 days or latest 50.
    // Each row MUST include enough for the mobile list + viewer route:
    return alerts.map(a => ({
      _id: a._id,
      _creationTime: a._creationTime,
      triggeredAt: a.triggeredAt ?? a._creationTime,
      status: a.status,               // 'active' | 'resolved' (used for the badge)
      resolvedAt: a.resolvedAt ?? null,
      senderName: <owner's display name>,   // shown as the row title
      // optional extras the app will happily use if present:
      // senderPhone, senderId, lastLocation, hasRecordings
    }));
  },
});
```

### Field notes (mobile reads, all optional-safe)
- Row title uses `senderName` (falls back to `userName` / `ownerName` / "Someone").
- Badge = red alert-triangle when `status !== 'resolved'`, else green check.
- Sub-text = "Active · <ago>" for unresolved, else "Resolved <ago>".
- Tap → `/emergency/<_id>` (already implemented; uses `getAlertForViewer`).

## Access / privacy
- Must ONLY return alerts the caller is authorised to view (their own trustee
  relationships / explicit recipients) — same authorisation as
  `getAlertForViewer`. Do not leak alerts to non-trustees.

## Acceptance test
1. User B is a trustee of User A. A triggers an alert → B opens the Emergency
   screen → sees A's alert under "ALERTS FROM PEOPLE WHO TRUST YOU" (Active).
2. B taps it → opens the viewer with A's live location + recordings.
3. A resolves → B's row shows "Resolved <ago>" with a green check.
4. A non-trustee C never sees A's alert in their inbox.
