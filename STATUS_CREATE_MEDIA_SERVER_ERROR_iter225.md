# `statuses.create` throws a Server Error for PHOTO/VIDEO statuses (iter-225)

## Symptom (reported by user, with screenshots)
- Posting a **text** status → works.
- Posting a **photo or video** status → fails with:
  `[CONVEX M(statuses:create)] [Request ID: b3eec3be52422bb6] Server Error`
  (also seen: Request ID `b278405ac7ae8698`). Generic "Server Error / Called by
  client" = an UNCAUGHT exception inside the `statuses.create` handler, NOT an
  argument-validation error.

## The mobile app is sending the documented contract
From `app/(tabs)/updates.tsx`, media statuses call:
```ts
await createStatus({
  type: 'image' | 'video',
  storageId,            // a REAL Convex _storage id from messages.generateUploadUrl
  mimeType,             // e.g. 'image/jpeg' | 'video/mp4'
  width,                // number | undefined
  height,               // number | undefined
  duration,             // number (seconds) for video, undefined for image
});
```
- `storageId` is produced by `uploadFile()` → `messages.generateUploadUrl` → POST
  → `{ storageId }`. It IS a valid `_storage` id (the same path used by working
  message/voice/profile uploads).
- This matches `CONVEX_BACKEND_INSTRUCTIONS_STATUS_STORIES.md §1` exactly.

## Likely backend causes to check (Convex side — we can't see the source)
Open the Convex dashboard → Logs → look up the Request IDs above for the exact
stack trace. Probable culprits inside the media branch of `statuses.create`:
1. Calling `ctx.storage.getUrl(storageId)` / `getMetadata` and dereferencing a
   `null` (e.g. assuming a URL/metadata always exists) → throws.
2. Reading a required field the text branch sets but media doesn't (e.g.
   `content`/`text`) and calling a method on `undefined`.
3. A non-optional column write (schema mismatch) for `width/height/duration`
   when they arrive as `undefined`.
4. Recently-deployed changes (phone-identity work) inadvertently touched
   `statuses.create`.

## Ask
- Fix the uncaught exception so photo/video statuses persist with
  `storageId`, `mimeType`, `width`, `height`, optional `duration` (per the
  existing status contract doc).
- Confirm the viewer reads them back via `storageId` (the mobile viewer already
  resolves a URL from `storageId`, and also accepts an inlined `fileUrl`).

## Mobile status: no change required
The mobile send shape is correct; this is a server-side fix. Once deployed,
photo/video status posting will work with no app update.
