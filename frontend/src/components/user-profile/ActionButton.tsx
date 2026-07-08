import { Feather } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Colors, FontSize, FontWeight } from '../../theme';

/** Circular icon + label action used in the profile header actions row. */
export default function ActionButton({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={styles.actionItem}
      activeOpacity={0.85}
      onPress={onPress}
      testID={testID}
    >
      <View style={styles.actionCircle}>
        <Feather name={icon} size={22} color={Colors.primary} />
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  actionItem: { alignItems: 'center', minWidth: 70 },
  actionCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    marginTop: 8,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },
});
