import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, Spacing, Shadow } from '../theme';

interface FabStackProps {
  onPencil: () => void;
  onBuilding?: () => void;
  onBroadcast?: () => void;
  onPeople?: () => void;
}

export default function FabStack({ onPencil, onBuilding, onBroadcast, onPeople }: FabStackProps) {
  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.secondaryFab} onPress={onBuilding} activeOpacity={0.85} testID="fab-communities">
        <MaterialCommunityIcons name="office-building-outline" size={20} color={Colors.headerBg} />
      </TouchableOpacity>
      {onBroadcast ? (
        <TouchableOpacity style={styles.secondaryFab} onPress={onBroadcast} activeOpacity={0.85} testID="fab-broadcast">
          <Ionicons name="radio-outline" size={22} color={Colors.headerBg} />
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity style={styles.secondaryFab} onPress={onPeople} activeOpacity={0.85} testID="fab-group">
        <Feather name="users" size={20} color={Colors.headerBg} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.mainFab} onPress={onPencil} activeOpacity={0.85} testID="fab-new-chat">
        <Feather name="edit-2" size={22} color={Colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    // iter-144: raise the FAB stack above the tab bar so it doesn't
    // cover bottom tab labels on smaller phones.
    bottom: 84,
    right: Spacing.base,
    alignItems: 'center',
    gap: 12,
  },
  secondaryFab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.sm,
  },
  mainFab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.md,
  },
});
