/**
 * DeleteMessageSheet (extracted iter-185, Chat Refactor Phase 2) — the
 * tri-state WhatsApp-style delete sheet. For sent messages: Delete for
 * me / receiver / everyone. For received: Delete for me / Ask sender.
 * Logic unchanged from app/chat/[conversationId].tsx.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../theme';

export type DeleteMode = 'me' | 'receiver' | 'everyone' | 'request_everyone';

export function DeleteMessageSheet({
  target,
  isMine,
  onClose,
  onSelect,
}: {
  target: any | null;
  isMine: boolean;
  onClose: () => void;
  onSelect: (mode: DeleteMode) => void;
}) {
  return (
    <Modal visible={!!target} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.deleteSheet} onPress={() => {}} testID="delete-sheet">
          <Text style={styles.deleteSheetTitle}>Delete message?</Text>
          <Text style={styles.deleteSheetSubtitle}>Choose how to delete this message</Text>
          {isMine ? (
            <>
              <TouchableOpacity
                style={styles.deleteRow}
                onPress={() => onSelect('me')}
                testID="delete-for-me"
              >
                <Feather name="trash-2" size={22} color={Colors.textSecondary} />
                <Text style={styles.deleteRowLabel}>Delete for me</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteRow}
                onPress={() => onSelect('receiver')}
                testID="delete-for-receiver"
              >
                <Feather name="trash-2" size={22} color="#f59e0b" />
                <Text style={styles.deleteRowLabel}>Delete for receiver</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteRow}
                onPress={() => onSelect('everyone')}
                testID="delete-for-everyone"
              >
                <Feather name="trash-2" size={22} color={Colors.danger} />
                <Text style={[styles.deleteRowLabel, { color: Colors.danger }]}>Delete for everyone</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={styles.deleteRow}
                onPress={() => onSelect('me')}
                testID="delete-for-me"
              >
                <Feather name="trash-2" size={22} color={Colors.textSecondary} />
                <Text style={styles.deleteRowLabel}>Delete for me</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteRow}
                onPress={() => onSelect('request_everyone')}
                testID="delete-request-everyone"
              >
                <Feather name="message-circle" size={22} color={Colors.primary} />
                <Text style={styles.deleteRowLabel}>Ask sender to delete for everyone</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity
            style={styles.sheetCancelBtn}
            onPress={onClose}
            testID="delete-cancel"
          >
            <Text style={styles.sheetCancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  deleteSheet: {
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.base,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  deleteSheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  deleteSheetSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.base,
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderLight,
  },
  deleteRowLabel: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
  },
  sheetCancelBtn: {
    marginTop: 8,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
  },
  sheetCancelText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
});
