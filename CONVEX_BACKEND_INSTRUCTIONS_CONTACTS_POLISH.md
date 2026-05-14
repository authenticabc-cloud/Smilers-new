# 📇 Convex Backend Changes Needed — Smilers Contacts Polish (Phase 2C)

The mobile frontend now expects the following contacts endpoints. The Convex backend source is not present in this repo, so please apply these changes server-side.

## Required endpoints

| Endpoint | Args | Notes |
|---|---|---|
| `contacts.getOutgoingRequests` | `{}` | Return pending outgoing requests shaped like `[{ _id, userId, name, email?, phone? }]` |
| `contacts.rejectRequest` | `{ contactId }` | Reject the incoming request for the current user |
| `contacts.cancelRequest` | `{ contactId }` | Cancel the outgoing request created by the current user |
| `contacts.sendRequestByPhone` | `{ phone }` | Look up by phone; if user exists, send request; otherwise persist an invite/SMS workflow |
| `contacts.sendRequest` | `{ contactId }` | Confirm existing mutation accepts the other user's id here |

## QR flow expectations

- The QR code encodes:

```json
{ "kind": "smilers-contact", "userId": "<userId>", "name": "<name>" }
```

- Scanning a valid QR should work with the existing `contacts.sendRequest({ contactId })` mutation.

## Relationship states expected by the mobile UI

- existing contact
- incoming pending request
- outgoing pending request
- no relationship

The search screen uses these states to show **Contact**, **Sent**, **Respond**, or a person-add action.