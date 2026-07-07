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
