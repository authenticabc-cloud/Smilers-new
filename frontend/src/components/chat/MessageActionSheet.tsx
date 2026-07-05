/**
 * MessageActionSheet (extracted iter-185, Chat Refactor Phase 2) — the
 * long-press bottom sheet with quick reactions plus the full action
 * list (Reply / Copy / Edit / Forward / Share / Star / Pin / Delete…).
 * Logic unchanged from app/chat/[conversationId].tsx.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ActionRow } from './MessageBubble';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export function MessageActionSheet({
  message,
  canEdit,
  canSetEditMode,
  canSuggestEdit,
  suggestPending,
  onClose,
  onPickReaction,
  onReply,
  onCopy,
  onEdit,
  onWhoCanEdit,
  onForward,
  onShare,
  onSelectMultiple,
  onStar,
  onPin,
  onMoreReactions,
  onMessageInfo,
  onDelete,
}: {
  message: any | null;
  canEdit: boolean;
  canSetEditMode?: boolean;
  onClose: () => void;
  onPickReaction: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onWhoCanEdit?: () => void;
  onForward: () => void;
  onShare: () => void;
  onSelectMultiple: () => void;
  onStar: () => void;
  onPin: () => void;
  onMoreReactions: () => void;
  onMessageInfo: () => void;
  onDelete: () => void;
}) {
  return (
    <Modal visible={!!message} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}} testID="message-action-sheet">
          <View style={styles.reactionPickerRow}>
            {QUICK_REACTIONS.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                style={styles.reactionBtn}
                onPress={() => onPickReaction(emoji)}
                testID={`react-${emoji}`}
              >
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.sheetActions}>
            <ActionRow icon="corner-up-left" lib="feather" label="Reply" onPress={onReply} />
            <ActionRow icon="copy" lib="feather" label="Copy text" onPress={onCopy} />
            {canEdit ? (
              <ActionRow icon="edit-2" lib="feather" label="Edit" onPress={onEdit} />
            ) : null}
            {canSetEditMode && onWhoCanEdit ? (
              <ActionRow icon="shield" lib="feather" label="Who can edit" onPress={onWhoCanEdit} />
            ) : null}
            <ActionRow icon="corner-up-right" lib="feather" label="Forward" onPress={onForward} />
            <ActionRow icon="share-2" lib="feather" label="Share" onPress={onShare} />
            <ActionRow icon="check-square" lib="feather" label="Select multiple to forward" onPress={onSelectMultiple} />
            <ActionRow
              icon="star"
              lib="feather"
              label={message?.starred ? 'Unstar' : 'Star'}
              onPress={onStar}
            />
            <ActionRow icon="bookmark" lib="feather" label="Pin" onPress={onPin} />
            <ActionRow icon="smile" lib="feather" label="More reactions" onPress={onMoreReactions} />
            <ActionRow icon="info" lib="feather" label="Message info" onPress={onMessageInfo} />
            <ActionRow icon="trash-2" lib="feather" label="Delete message" onPress={onDelete} danger />
          </View>
          <TouchableOpacity
            style={styles.sheetCancelBtn}
            onPress={onClose}
            testID="action-sheet-cancel"
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
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.lg,
    ...Shadow.lg,
  },
  reactionPickerRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  reactionBtn: { padding: 6 },
  reactionEmoji: { fontSize: 28 },
  sheetActions: { paddingVertical: Spacing.sm },
  sheetCancelBtn: {
    marginTop: 8,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
  },
  sheetCancelText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
});
