# Re: NATIVE_APP_SCREEN_SHARE_WEBRTC_CONTRACT — React Native implementation status

Hi team — thanks for the detailed contract document. Quick note: this app is built with **React Native + `react-native-webrtc`** (Expo SDK 54), not native Android Kotlin. The underlying WebRTC engine is the same (libwebrtc); only the binding language is different. All the logic you described in the Kotlin pseudocode is **already implemented in the mobile codebase as of the latest commit**. We're one EAS APK rebuild away from end-to-end working screen share.

## Contract requirement ↔ React Native implementation

| Your contract step | Where it lives in the mobile codebase |
|---|---|
| **Sharer**: After capture starts, create `RTCPeerConnection`, add tracks | `/app/frontend/src/lib/webrtc/CallSession.ts` → `initLocalMedia(useScreen=true)` calls `getDisplayMedia()` (or the iOS broadcast-extension equivalent) and `createPeerConnection()` adds the resulting tracks to the PC via `pc.addTrack(track, stream)`. ICE servers come from `iceServers.ts` (Google STUN + Metered.ca TURN on UDP/TCP ports 80/443). |
| **Sharer**: Create offer, send via `screenSharing.sendSignal` | `CallSession.ts → createOffer()` → calls back into the `sendSignal` wrapper in `/app/frontend/app/call/[conversationId].tsx`. The wrapper branches on `isScreenOnly` and invokes `useMutation((api as any).screenSharing.sendSignal)({ sessionId, toUserId, type: 'offer', payload })`. `sessionId` = the screen-share session id (URL path param). `toUserId` = the recipient's user id (URL `peerUserId` param, set by `/screen-share.tsx` from the contact picker). |
| **Sharer**: Send ICE candidates via `screenSharing.sendSignal` with `type: 'ice-candidate'` | Same wrapper — `pc.onicecandidate` fires `sendSignal({ type: 'ice-candidate', payload: JSON.stringify(candidate) })` which routes through the screen-share channel. We auto-retry with `'iceCandidate'` (camelCase) if the backend literal validator rejects `'ice-candidate'` (kebab) — bidirectional compat. |
| **Viewer**: Poll for offer via `screenSharing.pollSignals` | `useReactiveSafeConvexQuery(api.screenSharing.pollSignals, { sessionId }, [], enabled)` — a reactive Convex subscription that re-emits within ~1 second of a new signal landing. Same hook handles offers, answers, and ICE candidates. |
| **Viewer**: Set remote description, create answer, send back | `CallSession.ts → handleRemoteOffer(payload)` → `pc.setRemoteDescription` → `pc.createAnswer` → `pc.setLocalDescription` → routes through the same `screenSharing.sendSignal({ type: 'answer' })` channel. |
| **Both**: Exchange ICE candidates | Reactive subscription delivers candidates as they arrive; `CallSession.ts → handleRemoteIceCandidate(payload)` calls `pc.addIceCandidate(JSON.parse(payload))`. Receive-side handler accepts ALL THREE naming variants (`'ice-candidate'`, `'iceCandidate'`, `'ice'`) for full compatibility. |
| **Both**: ACK consumed messages | `useMutation((api as any).screenSharing.markSignalsConsumed)({ messageIds })` fires after every successfully processed signal so the same offer/answer isn't replayed. |

## Side-by-side: your Kotlin vs. our TypeScript

**Sharer creating the offer** (your contract):
```kotlin
peerConnection.createOffer(...) { offer ->
  peerConnection.setLocalDescription(offer)
  screenSharing.sendSignal(sessionId, viewerId, "offer", offer.toJson())
}
```

**Sharer creating the offer** (mobile reality):
```typescript
// CallSession.ts
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
await sendSignal({ type: 'offer', payload: JSON.stringify({ sdp: offer.sdp, type: offer.type }) });
// → routes via `api.screenSharing.sendSignal({ sessionId, toUserId, type, payload })`
//   in the wrapper at /app/frontend/app/call/[conversationId].tsx
```

**Viewer handling the offer** (your contract):
```kotlin
val offer = SessionDescription.fromJson(payload)
peerConnection.setRemoteDescription(offer)
peerConnection.createAnswer(...) { answer ->
  peerConnection.setLocalDescription(answer)
  screenSharing.sendSignal(sessionId, sharerId, "answer", answer.toJson())
}
```

**Viewer handling the offer** (mobile reality):
```typescript
// CallSession.ts → handleRemoteOffer
await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(payload)));
const answer = await pc.createAnswer();
await pc.setLocalDescription(answer);
await sendSignal({ type: 'answer', payload: JSON.stringify({ sdp: answer.sdp, type: answer.type }) });
```

## What's pending on our side

Nothing. The implementation is in HEAD. The next step is the user triggering an EAS APK rebuild on the `apk` profile and installing the new binary on two test devices.

## What we'd like you to confirm

Once the user installs the rebuilt APK and runs a screen-share test, please check your server logs for traffic on:

- `screenSharing.sendSignal` — should fire multiple times per session (1× offer, 1× answer, N× ICE candidates)
- `screenSharing.pollSignals` — should be a continuous reactive subscription from both peers
- `screenSharing.markSignalsConsumed` — should be called after each signal is processed

If you see this traffic, the wire is working. If the receiver's overlay still doesn't show the stream, that's a media-path issue (TURN traversal, codec mismatch, etc.) and we can dig in with the device-side logs and `getStats()` output.

## Open question for you

The contract mentions `{CONVEX_SITE_URL}/turn-credentials` as the canonical TURN-credentials endpoint. Right now the mobile uses a static Metered.ca TURN relay (in `/app/frontend/src/lib/webrtc/iceServers.ts`) which has worked fine in dev. If you'd prefer we switch to fetching dynamic credentials from your endpoint at peer-connection-create time, we're happy to. Just confirm the response schema (e.g. `{ urls, username, credential }` array) and we'll wire it up in the next iteration.

— Mobile team
