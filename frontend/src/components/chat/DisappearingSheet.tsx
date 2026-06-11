/**
 * DisappearingSheet (extracted iter-185, Chat Refactor Phase 2) — the
 * "Disappearing messages" duration picker. Owns the canonical
 * DISAPPEARING_OPTIONS list (also imported by the chat screen for TTL
 * resolution). Selection side-effects (persist + mutation) stay in the
 * parent via `onSelect`.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme';

export const DISAPPEARING_OPTIONS = [
  { key: 'off', label: 'Off', ms: 0 },
  { key: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '90d', label: '90 days', ms: 90 * 24 * 60 * 60 * 1000 },
] as const;

export type DisappearingOption = (typeof DISAPPEARING_OPTIONS)[number];
export type DisappearingKey = DisappearingOption['key'];

export function DisappearingSheet({
  visible,
  mode,
  onClose,
  onSelect,
}: {
  visible: boolean;
  mode: DisappearingKey;
  onClose: () => void;
  onSelect: (option: DisappearingOption) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, styles.disappearingSheet]} onPress={() => {}} testID="disappearing-sheet">
          <Text style={styles.disappearingTitle}>Disappearing messages</Text>
          {DISAPPEARING_OPTIONS.map((option) => {
            const selected = mode === option.key;
            return (
              <TouchableOpacity
                key={option.key}
                style={styles.disappearingRow}
                onPress={() => onSelect(option)}
                testID={`disappearing-option-${option.key}`}
              >
                <Text style={[styles.disappearingLabel, selected ? styles.disappearingLabelSelected : null]}>{option.label}</Text>
                {selected ? <Ionicons name="checkmark-circle" size={20} color={Colors.primary} /> : null}
              </TouchableOpacity>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.lg,
    ...Shadow.lg,
  },
  disappearingSheet: { paddingHorizontal: 16, paddingBottom: 24 },
  disappearingTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, paddingHorizontal: 4, paddingBottom: 12 },
  disappearingRow: {
    minHeight: 50,
    borderRadius: Radius.lg,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  disappearingLabel: { fontSize: FontSize.base, color: Colors.textPrimary },
  disappearingLabelSelected: { color: Colors.primaryDark, fontWeight: FontWeight.semibold },
});
