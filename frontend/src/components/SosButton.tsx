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
    // iter-144: raise SOS above the tab bar — on smaller screens the
    // previous `bottom: Spacing.base` (~16px) was overlapping the tab
    // labels (Chats/Contacts/etc). 84px clears a 56px tab bar + 28px
    // safe gap on Android phones with bottom navigation gestures.
    bottom: 84,
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
