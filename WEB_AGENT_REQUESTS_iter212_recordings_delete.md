# Web/Convex team — confirm recording DELETE mutation (iter-212)

The native **My Recordings** screen now has **Download** + **Delete** buttons
(web parity). Download works fully. Delete calls Convex but I could not find
the canonical mutation name in the shared contract, so the mobile client tries
these names/arg shapes in order and surfaces a friendly error if none exist:

Function names tried (under `api.callRecording.*`):
1. `deleteRecording`
2. `removeRecording`
3. `remove`
4. `delete`

Arg shapes tried per name:
1. `{ recordingId: <row._id> }`
2. `{ id: <row._id> }`
3. `{ callId: <row.callId> }`

### What we need from you
Please confirm the EXACT mutation name + arg shape the web app uses to delete a
call recording (the trash icon on the web `My Recordings` screen). Once
confirmed we'll pin the mobile client to that single call and drop the fallback
probing.

If no delete mutation exists yet, please add one (auth: owner only) — until then
the mobile Delete button shows: "Deleting recordings isn't available yet on the
server."
