# Status (Updates) — Edit & Delete: Convex Backend Spec

The Smilers **mobile** app now has UI for **deleting** (and, optionally, **editing**)
a user's own status/update. The mobile client is fully wired and will activate
automatically once these Convex functions exist. Until they ship, the mobile app
fails softly (a friendly "not available yet" message — no crash).

The mobile app talks to the **same Convex deployment** as the web app
(`api.statuses.*`). Please add the following.

---

## 1. `statuses.remove` — REQUIRED (Delete a status)

**Type:** `mutation`

**Args:**
```ts
{ statusId: v.id("statuses") }
```

**Auth / ownership:**
- Must be an authenticated user.
- The status's `userId` (author) MUST equal the caller's user id. Otherwise throw
  (e.g. `throw new Error("Not authorized")`).

**Behavior:**
- Delete the status document (`ctx.db.delete(statusId)`).
- Also clean up any dependent rows if you keep them separately (e.g. per-viewer
  "seen" records, reactions/replies tied to the status). If those are embedded on
  the status doc, a single delete is enough.
- Return `{ success: true }` (or `null`). Idempotent: if the status is already
  gone, return success rather than throwing.

**Mobile call (already implemented):**
```ts
await removeStatus({ statusId: current._id });
```

---

## 2. `statuses.update` — OPTIONAL (Edit a text status)

Only needed if you want true in-place editing. If you'd rather users
"delete & repost", skip this and tell us — we'll switch the mobile "edit" affordance
to a delete-then-compose flow.

**Type:** `mutation`

**Args:**
```ts
{
  statusId: v.id("statuses"),
  content: v.optional(v.string()),
  backgroundColor: v.optional(v.string()),
  textColor: v.optional(v.string()),
}
```

**Auth / ownership:** same ownership check as `remove`.

**Behavior:**
- Patch only the provided fields (`ctx.db.patch`).
- Do NOT reset `_creationTime` / the 24h expiry (an edit shouldn't extend the
  status's life) — unless you explicitly want edits to refresh expiry; tell us
  which and we'll match copy in the app.
- Only `type: "text"` statuses are editable from mobile for now.
- Return the updated doc or `{ success: true }`.

---

## Notes / questions for the web team
1. Confirm the exact field name for the author id on the `statuses` table
   (`userId`? `authorId`?) — the mobile ownership assumption is `userId`.
2. Confirm the id arg name — mobile sends `statusId`. If your convention is
   `id`, tell us and we'll rename on the client.
3. Confirm whether deleting should also notify/clear viewers' "seen" state.

Once deployed, no mobile release is required for **delete** — it will start working
immediately (the client already references `api.statuses.remove`). For **edit**,
tell us the final arg shape and we'll finish that UI.
