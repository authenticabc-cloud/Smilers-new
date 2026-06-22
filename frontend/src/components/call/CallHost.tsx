/**
 * CallHost — renders the live WebRTC call ONCE at the app root so it survives
 * navigation. Driven by the `callHost` store:
 *   - mode 'full'  → full-screen call overlay (covers the app).
 *   - mode 'mini'  → small draggable floating window; the rest of the app stays
 *                    interactive so the user can browse while staying on the call.
 *
 * CRITICAL: the SAME <CallScreenInner/> element instance must stay mounted
 * across full↔mini toggles, otherwise React would unmount it and the unmount
 * cleanup would close the peer connection (dropping the call). We therefore
 * keep a single, stable element tree and only swap the wrapper STYLE / pan
 * handlers — never the structure — when the mode changes.
 */
import React, { useMemo, useRef } from 'react';
import { Animated, Dimensions, PanResponder, Platform, StyleSheet, View } from 'react-native';

import CallErrorBoundary from '../CallErrorBoundary';
import { callHost, useCallHost } from '../../lib/call/callHost';
import { CallScreenInner } from '../../../app/call/[conversationId]';

const MINI_WIDTH = 124;
const MINI_HEIGHT = 184;
const EDGE = 12;

export default function CallHost() {
  const { params, mode } = useCallHost();

  // Hooks must run unconditionally (before any early return).
  const { width: screenW, height: screenH } = Dimensions.get('window');
  const startX = screenW - MINI_WIDTH - EDGE;
  const startY = screenH - MINI_HEIGHT - 120;
  const pan = useRef(new Animated.ValueXY({ x: startX, y: startY })).current;
  const offset = useRef({ x: startX, y: startY }).current;

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Only claim the gesture once the finger actually moves, so taps still
        // reach the expand/end buttons inside the mini window.
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4,
        onPanResponderGrant: () => {
          pan.setOffset({ x: offset.x, y: offset.y });
          pan.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
          useNativeDriver: false,
        }),
        onPanResponderRelease: (_evt, gesture) => {
          pan.flattenOffset();
          const nextX = Math.min(Math.max(EDGE, offset.x + gesture.dx), screenW - MINI_WIDTH - EDGE);
          const nextY = Math.min(Math.max(EDGE + 24, offset.y + gesture.dy), screenH - MINI_HEIGHT - EDGE);
          offset.x = nextX;
          offset.y = nextY;
          Animated.spring(pan, {
            toValue: { x: nextX, y: nextY },
            useNativeDriver: false,
            friction: 7,
          }).start();
        },
      }),
    [offset, pan, screenW, screenH],
  );

  // Web previews can't run react-native-webrtc — skip the overlay entirely so
  // the bundle still renders for screenshots/QA. Real calls only run on native.
  if (Platform.OS === 'web' || !params) return null;

  const isMini = mode === 'mini';

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={isMini ? 'box-none' : 'auto'} testID="call-host">
      <Animated.View
        style={isMini ? [styles.mini, { transform: pan.getTranslateTransform() }] : styles.full}
        {...(isMini ? responder.panHandlers : {})}
        testID={isMini ? 'mini-call-window' : 'call-host-full'}
      >
        <CallErrorBoundary onClose={() => callHost.end()}>
          <CallScreenInner />
        </CallErrorBoundary>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  full: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9000,
    elevation: 9000,
  },
  mini: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: MINI_WIDTH,
    height: MINI_HEIGHT,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#0b141a',
    zIndex: 9000,
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
});
