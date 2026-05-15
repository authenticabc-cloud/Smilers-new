# 🔐⏰ Convex Backend Changes Needed — Smilers Privacy + Scheduled Messages

The mobile frontend is now prepared to use the following Convex endpoints when they exist. The backend source is not present in this repo, so please add these server-side.

## 1) Privacy settings

### Required endpoint

| Endpoint | Args | Return shape | Notes |
|---|---|---|---|
| `privacy.getSettings` | `{}` | `{ lastSeen, profilePhoto, about, status, groups, calls, readReceipts, typingIndicators }` | Return the current user's saved privacy settings |
| `privacy.updateSettings` | `{ settings }` | `{ ok: true }` | Persist the full settings object for the current user |

### Expected settings shape

```ts
{
  lastSeen: 'everyone' | 'contacts' | 'nobody',
  profilePhoto: 'everyone' | 'contacts' | 'nobody',
  about: 'everyone' | 'contacts' | 'nobody',
  status: 'everyone' | 'contacts' | 'nobody',
  groups: 'everyone' | 'contacts' | 'admins',
  calls: 'everyone' | 'contacts' | 'nobody',
  readReceipts: boolean,
  typingIndicators: boolean,
}
```

### Suggested storage

- Store on the user document, for example:

```ts
privacySettings: {
  lastSeen,
  profilePhoto,
  about,
  status,
  groups,
  calls,
  readReceipts,
  typingIndicators,
}
```

## 2) Scheduled messages

### Required endpoints

| Endpoint | Args | Return shape | Notes |
|---|---|---|---|
| `scheduledMessages.listMine` | `{}` | `[{ _id, recipient, message, date, time, repeat, active }]` | List the current user's scheduled messages |
| `scheduledMessages.create` | `{ recipient, message, date, time, repeat, active }` | `{ _id }` or created object | Create a scheduled message |
| `scheduledMessages.update` | `{ scheduleId, recipient, message, date, time, repeat, active }` | `{ ok: true }` | Update an existing scheduled message |
| `scheduledMessages.remove` | `{ scheduleId }` | `{ ok: true }` | Delete a scheduled message |
| `scheduledMessages.setActive` | `{ scheduleId, active }` | `{ ok: true }` | Pause/resume a scheduled message |

### Expected message shape

```ts
{
  _id: string,
  recipient: string,
  message: string,
  date: string,   // YYYY-MM-DD
  time: string,   // HH:MM
  repeat: 'once' | 'daily' | 'weekly' | 'monthly',
  active: boolean,
}
```

### Suggested table fields

```ts
scheduledMessages: {
  userId,
  recipient,
  message,
  date,
  time,
  repeat,
  active,
  createdAt,
  updatedAt,
}
```

## Mobile behavior already wired

- If these endpoints exist, the mobile app will:
  - fetch cloud privacy settings from `privacy.getSettings`
  - save privacy changes through `privacy.updateSettings`
  - fetch scheduled messages from `scheduledMessages.listMine`
  - create/update/delete/pause/resume scheduled messages through the listed mutations
- If any endpoint is missing or errors, the mobile app safely falls back to local device persistence instead of crashing.