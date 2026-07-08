# Draggable self-view during a video call (2026-07-07)

This is a **Group B (call-layer)** change, so it's given as focused edits rather
than a patch — apply it to YOUR version of the active video-call screen (in the
Emergent repo that's `app/call/[conversationId].tsx`, the WebRTC path used when
`EXPO_PUBLIC_USE_TWILIO=0`).

Goal: the local camera preview (self-view PiP) can be dragged anywhere on
screen and snaps back to stay fully visible. Position is session-only.

> If you ever enable the Twilio path (`EXPO_PUBLIC_USE_TWILIO=1`), apply the
> same treatment to the self-view in `app/twilio-call.tsx`.

---

### 1) Import `PanResponder` from react-native
```diff
   Animated as RNAnimated,
   AppState,
   BackHandler,
+  PanResponder,
   Platform,
```

### 2) Grab window WIDTH too, and add the drag hooks
Change the existing dimensions line and add the block right after it (must be
above any early `return`, e.g. the `if (inPip)` return, so hook order is stable):
```diff
- const { height: windowHeight } = useWindowDimensions();
+ const { width: windowWidth, height: windowHeight } = useWindowDimensions();
+
+ // ── Draggable self-view (video PiP) ──────────────────────────────
+ const PIP_W = 96;
+ const PIP_H = 130;
+ const PIP_RIGHT = Spacing.base;   // must match styles.pipWrap.right
+ const PIP_BOTTOM = 168;           // must match styles.pipWrap.bottom
+ const PIP_EDGE = 8;
+ const PIP_TOP_SAFE = 54;
+ const pipPan = useRef(new RNAnimated.ValueXY({ x: 0, y: 0 })).current;
+ const pipBounds = useMemo(() => {
+   const defaultLeft = windowWidth - PIP_RIGHT - PIP_W;
+   const defaultTop = windowHeight - PIP_BOTTOM - PIP_H;
+   return {
+     minTx: PIP_EDGE - defaultLeft,
+     maxTx: windowWidth - PIP_W - PIP_EDGE - defaultLeft,
+     minTy: PIP_TOP_SAFE - defaultTop,
+     maxTy: windowHeight - PIP_H - PIP_EDGE - defaultTop,
+   };
+ }, [windowWidth, windowHeight]);
+ const pipPanResponder = useMemo(
+   () =>
+     PanResponder.create({
+       onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
+       onPanResponderGrant: () => { pipPan.extractOffset(); },
+       onPanResponderMove: RNAnimated.event([null, { dx: pipPan.x, dy: pipPan.y }], { useNativeDriver: false }),
+       onPanResponderRelease: () => {
+         pipPan.flattenOffset();
+         const x = (pipPan.x as any)._value as number;
+         const y = (pipPan.y as any)._value as number;
+         const clampedX = Math.min(pipBounds.maxTx, Math.max(pipBounds.minTx, x));
+         const clampedY = Math.min(pipBounds.maxTy, Math.max(pipBounds.minTy, y));
+         RNAnimated.spring(pipPan, { toValue: { x: clampedX, y: clampedY }, useNativeDriver: false, friction: 7, tension: 60 }).start();
+       },
+     }),
+   [pipBounds, pipPan],
+ );
```

### 3) Make the PiP wrapper draggable
Replace the static `<View style={styles.pipWrap} pointerEvents="none">` self-view
with an animated, pan-handled view (remove `pointerEvents="none"`):
```diff
- {/* Local picture-in-picture */}
- {localStreamURL && !cameraOff ? (
-   <View style={styles.pipWrap} pointerEvents="none">
-     <RTCViewImpl streamURL={localStreamURL} style={StyleSheet.absoluteFill} objectFit="cover" mirror />
-   </View>
- ) : null}
+ {/* Local picture-in-picture — draggable self-view. */}
+ {localStreamURL && !cameraOff ? (
+   <RNAnimated.View
+     style={[styles.pipWrap, { transform: pipPan.getTranslateTransform() }]}
+     {...pipPanResponder.panHandlers}
+     testID="call-self-view"
+   >
+     <RTCViewImpl streamURL={localStreamURL} style={StyleSheet.absoluteFill} objectFit="cover" mirror />
+   </RNAnimated.View>
+ ) : null}
```

Notes:
- If your `styles.pipWrap` uses different `width/height/right/bottom`, update the
  `PIP_*` constants above so the clamp keeps it on-screen.
- `RTCViewImpl` keeps `pointerEvents` default; the drag is handled by the
  wrapper. A tap on the preview does nothing (drag needs >4px movement first),
  so it won't interfere with the full-screen controls tap-catcher.
- **Native only** — RTCView doesn't render on web/Expo Go, so this must be
  verified on a device build.

---

## iter-338 — 3 additional call-layer changes (2026-07-08)

All three live in `app/call/[conversationId].tsx` (+ two small helper files).
Keep these SEPARATE from your native push/call integration merge.

### A) Call-waiting FOREGROUND video routing (fixes "audio-only" bug)
Symptom the user reported: after **Hold current & Accept incoming**, they could
hear/speak on the accepted call but saw **no video** — the screen still tried to
render the HELD primary call's streams.

Fix: derive the foreground call and route ALL video through it.
```js
const foregroundIsSecondary =
  !!secondaryInfo && (heldSide === 'primary' || primaryEndedPromoted);
const displayRemoteURL = foregroundIsSecondary
  ? secondary.remoteStreamURL || remoteStreamURL
  : remoteStreamURL;
const displayLocalURL = foregroundIsSecondary
  ? secondary.localStreamURL || localStreamURL   // NEW: secondary local stream
  : localStreamURL;
const foregroundCallType = foregroundIsSecondary
  ? (secondaryInfo?.callType || callType) : callType;
const foregroundActive = foregroundIsSecondary
  ? (secondary.connected || isActive) : isActive;
// gate uses the FOREGROUND type/active, not the primary:
const showVideo = foregroundCallType === 'video' && foregroundActive && RTCViewImpl != null;
```
`src/lib/call/useSecondaryCall.ts` now also wires `onLocalStream` and returns
`localStreamURL` (previously only `remoteStreamURL`). The mini/pip/full-screen
surfaces all read `displayRemoteURL` / `displayLocalURL` now.

### B) Persist self-view PiP position across calls
New helper `src/lib/call/selfViewPosition.ts` (AsyncStorage). On PanResponder
release we `saveSelfViewPos({tx, ty})`; on mount (once bounds are known) we
`loadSelfViewPos()` and `pipPan.setValue(clamped)`. Re-clamped to current bounds
so an old position never lands off-screen.

### C) Double-tap PiP to swap local/remote feeds
`pipSwapped` state (default false). A `Pressable` inside the PiP wrapper calls
`handlePipTap()` which toggles `pipSwapped` on a <300ms second tap. Render:
```js
const mainVideoURL = pipSwapped ? displayLocalURL : displayRemoteURL;
const selfViewURL   = pipSwapped ? displayRemoteURL : displayLocalURL;
// main mirror = pipSwapped ; self mirror = !pipSwapped
```
Single taps still fall through to the drag / controls tap-catcher.

**Native only** — all three require a device build (RTCView + real 2nd call).

---

## iter-340 — self-view PiP drag FIX (2026-07-08)

Bug: the self-view was rendered as a small box but could NOT be dragged.
Cause: iter-338 wrapped the draggable `Animated.View` in a child `Pressable`
(for double-tap). The Pressable grabbed the touch responder on START, so the
parent `PanResponder`'s move-only `onMoveShouldSetPanResponder` was never
consulted → no drag.

Fix (in `app/call/[conversationId].tsx`):
1. PanResponder now claims the gesture at touch-start via
   `onStartShouldSetPanResponder`/`onStartShouldSetPanResponderCapture` (+ the
   move-capture variants) and `onPanResponderTerminationRequest: () => false`.
2. Removed the child `<Pressable>`. Double-tap is detected inside
   `onPanResponderRelease`: if the release moved <6px it's treated as a tap and
   routed to `handlePipTap()` (double-tap within 300ms → swap feeds); otherwise
   it's a drag (clamp + spring + `saveSelfViewPos`).
3. The self-view `RTCView` is now a direct child of the animated wrapper.

Net: drag works, double-tap-to-swap works, position still persists. Native only.

---

## iter-341 — caller "Ringing" / "Not Ringing" reachability (2026-07-08)

In `app/call/[conversationId].tsx`. During an OUTGOING ringing call the top
status chip now reflects the callee's reachability:
- `outgoingRingingLabel = calleeKnownOffline ? 'Not Ringing' : 'Ringing....'`
- `calleeKnownOffline` is derived from the hydrated callee presence
  (`fetchedOtherUser.isOnline === false || .online === false`). Undefined
  presence stays optimistic ("Ringing....") to avoid false negatives.
- `topStatusChip` returns `outgoingRingingLabel` for `isOutgoingRinging`.

This is client-only (uses existing Convex presence, same as the chat header
online dot). For a bulletproof version that also handles a backgrounded but
push-reachable callee, see `STATUS_CALL_REACHABILITY_BACKEND_SPEC.md` (adds a
callee `ringingAt` ack to the calls table).
