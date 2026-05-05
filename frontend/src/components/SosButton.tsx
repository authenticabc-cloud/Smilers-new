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
    left: -8,
    backgroundColor: Colors.danger,
    paddingVertical: 10,
    paddingHorizontal: 20,
    paddingLeft: 24,
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
