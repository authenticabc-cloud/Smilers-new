import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SUB_GROUP_EMOJIS, SUB_GROUP_COLORS } from '../lib/subGroupAppearance';
import { Colors, FontSize, FontWeight, Spacing } from '../theme';

/** Emoji + color pickers for a sub group's list appearance. */
export function SubGroupAppearancePicker({
  emoji,
  color,
  onChangeEmoji,
  onChangeColor,
}: {
  emoji?: string;
  color?: string;
  onChangeEmoji: (e?: string) => void;
  onChangeColor: (c?: string) => void;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Icon</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowScroll}>
        <TouchableOpacity
          style={[styles.emojiCell, !emoji && styles.cellOn]}
          onPress={() => onChangeEmoji(undefined)}
          testID="appearance-emoji-none"
        >
          <Text style={styles.noneText}>Aa</Text>
        </TouchableOpacity>
        {SUB_GROUP_EMOJIS.map((e) => (
          <TouchableOpacity
            key={e}
            style={[styles.emojiCell, emoji === e && styles.cellOn]}
            onPress={() => onChangeEmoji(e)}
            testID={`appearance-emoji-${e}`}
          >
            <Text style={styles.emoji}>{e}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <Text style={styles.label}>Color</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowScroll}>
        <TouchableOpacity
          style={[styles.colorCell, styles.colorNone, !color && styles.cellOn]}
          onPress={() => onChangeColor(undefined)}
          testID="appearance-color-none"
        >
          <Text style={styles.noneText}>×</Text>
        </TouchableOpacity>
        {SUB_GROUP_COLORS.map((c) => (
          <TouchableOpacity
            key={c}
            style={[styles.colorCell, { backgroundColor: c }, color === c && styles.colorCellOn]}
            onPress={() => onChangeColor(c)}
            testID={`appearance-color-${c}`}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary, marginTop: Spacing.sm },
  rowScroll: { gap: 8, paddingVertical: 2 },
  emojiCell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border || '#E5E7EB',
  },
  emoji: { fontSize: 20 },
  noneText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.bold },
  colorCell: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: 'transparent' },
  colorNone: { backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', borderColor: Colors.border || '#E5E7EB' },
  cellOn: { borderColor: Colors.primary, borderWidth: 2 },
  colorCellOn: { borderColor: Colors.textPrimary },
});
