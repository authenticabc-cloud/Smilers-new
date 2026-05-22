import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Spacing, Shadow, Radius } from '../theme';

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
      <MaterialCommunityIcons name="alarm-light-outline" size={18} color={Colors.white} />
      <Text style={styles.sosText}>SOS</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  sos: {
    position: 'absolute',
    bottom: Spacing.base,
    // Push the button further off-screen on the left so only the "SOS" label
    // peeks out — mirrors the web app's chat list peeking-pill look.
    left: -60,
    backgroundColor: Colors.danger,
    paddingVertical: 10,
    paddingRight: 18,
    paddingLeft: 68,
    borderTopRightRadius: Radius.pill,
    borderBottomRightRadius: Radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    ...Shadow.lg,
  },
  sosText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.sm,
    letterSpacing: 0.5,
  },
});
