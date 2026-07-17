/**
 * UndoSnackbar — a lightweight bottom snackbar with an UNDO action that
 * auto-dismisses after `durationMs`. Used after swipe-to-read so an accidental
 * swipe can be reverted. Fades/slides in and out.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

type Props = {
  visible: boolean;
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
  /** Distance from the bottom (to clear the tab bar). */
  bottom?: number;
};

export default function UndoSnackbar({
  visible,
  message,
  onUndo,
  onDismiss,
  durationMs = 4000,
  bottom = 96,
}: Props) {
  const anim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onDismiss(), durationMs);
    } else {
      Animated.timing(anim, { toValue: 0, duration: 160, useNativeDriver: true }).start();
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [visible, durationMs, onDismiss, anim]);

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          bottom,
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
        },
      ]}
    >
      <TouchableOpacity activeOpacity={1} style={styles.bar} testID="undo-snackbar">
        <Feather name="check-circle" size={18} color={Colors.success || '#22C55E'} />
        <Text style={styles.msg} numberOfLines={1}>
          {message}
        </Text>
        <TouchableOpacity
          onPress={() => {
            onUndo();
            onDismiss();
          }}
          hitSlop={10}
          testID="undo-snackbar-action"
        >
          <Text style={styles.action}>UNDO</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: Spacing.base,
    right: Spacing.base,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: '#242019',
    borderRadius: Radius.md,
    paddingVertical: 12,
    paddingHorizontal: Spacing.base,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  msg: { flex: 1, color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  action: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.bold, letterSpacing: 0.5 },
});
