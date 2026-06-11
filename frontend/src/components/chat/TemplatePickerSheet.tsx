/**
 * TemplatePickerSheet (extracted iter-185, Chat Refactor Phase 2) — the
 * "Quick Replies" picker that inserts a saved template into the
 * composer. Manage/create navigation is delegated to the parent.
 */
import React from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme';

export function TemplatePickerSheet({
  visible,
  templates,
  onClose,
  onInsert,
  onManage,
}: {
  visible: boolean;
  templates: any[];
  onClose: () => void;
  onInsert: (message: string) => void;
  onManage: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, styles.forwardSheet]} onPress={() => {}} testID="template-picker-sheet">
          <View style={styles.templatePickerHeader}>
            <Text style={styles.forwardTitle} testID="template-picker-title">
              Quick Replies
            </Text>
            <TouchableOpacity onPress={onManage} testID="template-picker-manage-button">
              <Text style={styles.templatePickerManage}>Manage</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={Array.isArray(templates) ? templates : []}
            keyExtractor={(item: any) => item.id}
            contentContainerStyle={styles.forwardListContent}
            renderItem={({ item, index }: any) => (
              <TouchableOpacity
                style={styles.templatePickerRow}
                onPress={() => onInsert(item.message || '')}
                testID={`template-picker-item-${index}`}
              >
                <View style={styles.templatePickerBadge}>
                  <MaterialCommunityIcons name="message-text-outline" size={18} color={Colors.primary} />
                </View>
                <View style={styles.flexOne}>
                  <Text style={styles.forwardName}>{item.label || 'Quick Reply'}</Text>
                  <Text style={styles.forwardSub} numberOfLines={2}>
                    {item.message || ''}
                  </Text>
                </View>
                <Feather name="corner-down-left" size={18} color={Colors.primary} />
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <View style={styles.templatePickerEmptyWrap} testID="template-picker-empty">
                <Text style={styles.forwardEmpty}>No quick replies yet.</Text>
                <TouchableOpacity
                  style={styles.templatePickerCreateBtn}
                  onPress={onManage}
                  testID="template-picker-create-button"
                >
                  <Text style={styles.templatePickerCreateText}>Create one</Text>
                </TouchableOpacity>
              </View>
            }
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
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
  forwardSheet: { maxHeight: '70%' },
  forwardTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    paddingVertical: Spacing.md,
    textAlign: 'center',
  },
  forwardListContent: { paddingBottom: Spacing.lg },
  forwardName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  forwardSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  forwardEmpty: { textAlign: 'center', color: Colors.textMuted, paddingVertical: Spacing.lg },
  templatePickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  templatePickerManage: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.primary,
  },
  templatePickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  templatePickerBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  templatePickerEmptyWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    gap: Spacing.sm,
  },
  templatePickerCreateBtn: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  templatePickerCreateText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.primaryDark,
  },
});
