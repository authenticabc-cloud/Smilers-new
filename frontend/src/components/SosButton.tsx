import React from 'react';
import { Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors, FontSize, FontWeight, Shadow, Radius } from '../theme';

interface SosButtonProps {
  onPress?: () => void;
}

export default function SosButton({ onPress }: SosButtonProps) {
  return (
    <TouchableOpacity
      style={styles.sos}
      onPress={onPress}
      activeOpacity={0.85}
      testID="sos-button"
    >
      <Text style={styles.sosText}>SOS</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  sos: {
    position: 'absolute',
    // iter-144: raise SOS above the tab bar — on smaller screens the
    // previous `bottom: Spacing.base` (~16px) was overlapping the tab
    // labels (Chats/Contacts/etc). 84px clears a 56px tab bar + 28px
    // safe gap on Android phones with bottom navigation gestures.
    bottom: 84,
    // Tuck the pill mostly off-screen on the left so ONLY the "SOS" label
    // peeks out (icon removed). The left offset hides the rounded left
    // corner + extra padding; the text starts ~12px inside the screen edge.
    left: -44,
    backgroundColor: Colors.danger,
    paddingVertical: 10,
    paddingRight: 16,
    paddingLeft: 56,
    borderTopRightRadius: Radius.pill,
    borderBottomRightRadius: Radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    ...Shadow.lg,
  },
  sosText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.sm,
    letterSpacing: 0.5,
  },
});
