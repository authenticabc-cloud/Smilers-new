# Web ⇄ Native Stream Call Interop — Web App Implementation Spec

Goal: make 1:1 calls connect between the **web app** and the **native (Expo) app**.
Native 1:1 calls now run on **GetStream Video**. For interop, the web app must
place/answer calls on the **same Stream application, the same call id, and the
same user identity** the native app uses. Ringing is handled by our existing
backend (NOT Stream's native ring).

Everything below is exactly what the native client already does — match it.

---

## 1. Use the SAME Stream application

- **API key:** `sf6v64y8z2q7`
  (native reads `EXPO_PUBLIC_STREAM_API_KEY`, defaults to this value).
- Do **not** create a new Stream app. Tokens are minted by our backend with the
  matching Stream **secret**, so both clients must use this one app.

## 2. Identity — Stream `user.id` MUST equal the Convex user `_id`

- Native connects to Stream as `user = { id: <convex user _id>, name: <displayName> }`.
- The web app **must** connect as the SAME identity: `user.id === <the signed-in
  user's Convex `_id`>` (string). If web uses a different id (email, auth sub,
  etc.), the two users won't be recognised as the call participants.

## 3. Token — fetch from our backend (never embed the secret)

```
POST  {BACKEND_URL}/api/stream/token
Content-Type: application/json
Body: { "user_id": "<convex user _id>" }

Response: { "token": "<jwt>", "api_key": "sf6v64y8z2q7" }
```

Create the client with a token provider that calls this endpoint:

```js
import { StreamVideoClient } from '@stream-io/video-client'; // or -react

const client = new StreamVideoClient({
  apiKey: 'sf6v64y8z2q7',
  user: { id: convexUserId, name: displayName },
  tokenProvider: async () => {
    const r = await fetch(`${BACKEND_URL}/api/stream/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: convexUserId }),
    });
    const { token } = await r.json();
    return token;
  },
});
```

## 4. The call id (room) is DETERMINISTIC — both sides derive it identically

- **Call type:** `'default'`
- **Call id:** `` `smilers_conv_${conversationId}` `` where `conversationId` is the
  **Convex conversation `_id`** shared by both participants.

```js
const call = client.call('default', `smilers_conv_${conversationId}`);
```

Both native and web build this exact string, so they always join the same room —
no dependency on the call-record id.

## 5. Join options — match native exactly (NO Stream ring)

```js
await call.microphone.enable();
if (isVideo) await call.camera.enable(); else await call.camera.disable();

await call.join({ create: true, ring: false, notify: false });
```

- `ring: false` / `notify: false` are REQUIRED — Stream must NOT send its own
  ring push. Ringing is done by our backend (see §6). Using Stream ring would
  double-ring / conflict with the native FCM call UI.

## 6. Ringing / signalling — use the existing backend, not Stream

Native does not rely on Stream to ring. It uses the Convex `calls` lifecycle,
which fires the FCM "doorbell" to the callee. The web app must do the same so a
native device actually rings.

### Web places a call to a native user
1. Call the SAME backend/Convex ring the native app uses:
   `initiateCall({ conversationId, callType: 'voice' | 'video' })`
   (Convex mutation `api.calls.initiateCall`). This creates the ring record and
   triggers the FCM push to the callee's native device.
2. Immediately join the Stream room `default:smilers_conv_<conversationId>` (§4–5).
3. The native callee taps Accept → native joins the SAME room → media connects.

### Native places a call to a web user
1. Native already calls `initiateCall(...)` and joins the Stream room.
2. The web app must detect the incoming call. Subscribe to the Convex `calls`
   record for the conversation (status `ringing`, callerId ≠ me) — the same
   record native reads — and show your incoming-call UI.
3. On Accept: call `answerCall({ callId })` (Convex mutation `api.calls.answerCall`,
   same as native) and join `default:smilers_conv_<conversationId>` (§4–5).
4. On Decline: `declineCall({ callId })`.

> Native mutation names for reference (Convex): `calls.initiateCall`,
> `calls.answerCall`, `calls.declineCall`, `calls.markCalleeRinging`,
> `calls.endCall`. Use the identical mutations so both clients share one lifecycle.

## 7. Ending a call

- Use `call.leave()` on hangup (NOT `call.end()`), so the per-conversation room
  stays reusable for the next call. Native only ever `leave()`s.

---

## Quick interop checklist (web app)

- [ ] Stream API key = `sf6v64y8z2q7` (same app as native).
- [ ] Stream `user.id` === Convex user `_id`.
- [ ] Token fetched from `POST /api/stream/token` `{ user_id }`.
- [ ] Call built as `client.call('default', 'smilers_conv_<conversationId>')`.
- [ ] Join with `{ create: true, ring: false, notify: false }`.
- [ ] Outgoing: call Convex `initiateCall` (fires FCM to native), then join.
- [ ] Incoming: watch the Convex `calls` record; on Accept call `answerCall` then join.
- [ ] Hang up with `call.leave()`.

If all boxes are checked, a web user and a native user land in the exact same
Stream room as the same Stream app + identities, and media connects both ways.

---

### Common interop mistakes → symptoms
- Different Stream API key / app → tokens valid but users never see each other.
- `user.id` ≠ Convex `_id` → roster/participant mismatch.
- Call id built from the call-record id (or a random id) instead of
  `smilers_conv_<conversationId>` → each side joins a DIFFERENT room → "rings but
  never connects".
- `ring: true` on Stream → conflicting double ring with the native FCM call UI.
- Web is on Twilio/WebRTC instead of Stream → cannot connect at all (different
  media plane). Web MUST be on Stream to interoperate with native.
