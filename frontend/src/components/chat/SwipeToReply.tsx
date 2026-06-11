/**
 * SwipeToReply (iter-185, Chat Refactor Phase 2) — WhatsApp-style
 * swipe-right-to-reply gesture wrapper for chat timeline rows.
 *
 * Behaviour:
 *  - Drag a bubble to the RIGHT; a reply arrow fades/scales in.
 *  - Crossing the threshold fires a haptic tick; releasing past it
 *    triggers `onReply` and the row springs back.
 *  - Vertical pans fail fast (failOffsetY) so the FlatList scroll is
 *    never hijacked; left swipes never activate.
 *  - Disabled on web (mouse-drag conflicts with text selection) and
 *    whenever `enabled` is false (multi-select mode, suspended viewer,
 *    deleted messages).
 */
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

const REPLY_THRESHOLD = 56;
const MAX_DRAG = 88;

function fireHaptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

export function SwipeToReply({
  enabled = true,
  onReply,
  children,
}: {
  enabled?: boolean;
  onReply: () => void;
  children: React.ReactNode;
}) {
  const translateX = useSharedValue(0);
  const crossed = useSharedValue(false);

  const pan = Gesture.Pan()
    .enabled(enabled && Platform.OS !== 'web')
    // Activate only after a clear rightward drag; fail on any leftward
    // or vertical intent so list scrolling stays buttery.
    .activeOffsetX(18)
    .failOffsetX(-12)
    .failOffsetY([-14, 14])
    .onUpdate((event) => {
      const dx = Math.max(0, event.translationX);
      translateX.value = Math.min(dx, MAX_DRAG);
      if (dx >= REPLY_THRESHOLD && !crossed.value) {
        crossed.value = true;
        runOnJS(fireHaptic)();
      } else if (dx < REPLY_THRESHOLD && crossed.value) {
        crossed.value = false;
      }
    })
    .onEnd(() => {
      if (crossed.value) {
        runOnJS(onReply)();
      }
      crossed.value = false;
      translateX.value = withSpring(0, { damping: 18, stiffness: 220, mass: 0.6 });
    })
    .onFinalize(() => {
      // Safety net — if the gesture is cancelled (e.g. list scroll wins)
      // make sure the row animates home.
      crossed.value = false;
      translateX.value = withSpring(0, { damping: 18, stiffness: 220, mass: 0.6 });
    });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [8, REPLY_THRESHOLD], [0, 1], Extrapolation.CLAMP),
    transform: [
      {
        scale: interpolate(
          translateX.value,
          [8, REPLY_THRESHOLD],
          [0.5, 1],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.wrap} collapsable={false}>
        <Animated.View style={[styles.iconWrap, iconStyle]} pointerEvents="none">
          <View style={styles.iconCircle}>
            <Feather name="corner-up-left" size={15} color="#6B5B3E" />
          </View>
        </Animated.View>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    justifyContent: 'center',
  },
  iconWrap: {
    position: 'absolute',
    left: 2,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  iconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(228, 213, 183, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
