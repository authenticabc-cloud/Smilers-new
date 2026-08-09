import React from 'react';
import { Image, StyleSheet, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

const AImage = Animated.createAnimatedComponent(Image);

/**
 * Full-screen zoomable image for the photo viewer.
 * - Pinch to zoom, pan while zoomed, double-tap to toggle 1× ⇄ 2.5×.
 * - Single tap (only when NOT zoomed) closes the viewer, preserving the old
 *   tap-backdrop-to-close behavior.
 * Uses gesture-handler + reanimated (both already in the app). Wrapped in its
 * own GestureHandlerRootView so gestures work INSIDE the RN Modal on Android.
 */
export default function ZoomableImage({
  uri,
  onClose,
  onZoomChange,
  enableClose = true,
}: {
  uri: string;
  onClose?: () => void;
  /** Reports when the image crosses in/out of a zoomed state — used by the
   *  gallery pager to disable horizontal paging while zoomed so pan works. */
  onZoomChange?: (zoomed: boolean) => void;
  /** When false, a single tap does nothing (host owns its own close button). */
  enableClose?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const reportZoom = (z: boolean) => {
    onZoomChange?.(z);
  };

  const resetAll = () => {
    'worklet';
    scale.value = withTiming(1);
    savedScale.value = 1;
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedTx.value = 0;
    savedTy.value = 0;
    runOnJS(reportZoom)(false);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(0.7, savedScale.value * e.scale);
    })
    .onEnd(() => {
      if (scale.value < 1) resetAll();
      else {
        savedScale.value = scale.value;
        runOnJS(reportZoom)(scale.value > 1.05);
      }
    });

  const pan = Gesture.Pan()
    .maxPointers(2)
    .onUpdate((e) => {
      if (scale.value > 1) {
        tx.value = savedTx.value + e.translationX;
        ty.value = savedTy.value + e.translationY;
      }
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        resetAll();
      } else {
        scale.value = withTiming(2.5);
        savedScale.value = 2.5;
        runOnJS(reportZoom)(true);
      }
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      if (enableClose && scale.value <= 1 && onClose) runOnJS(onClose)();
    });

  const composed = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  return (
    <GestureHandlerRootView style={styles.root}>
      <GestureDetector gesture={composed}>
        <AImage source={{ uri }} style={[{ width, height }, animStyle]} resizeMode="contain" />
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
