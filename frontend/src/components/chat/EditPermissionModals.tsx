/**
 * EditPermissionModals (extracted iter-335, Chat Refactor) — the two group
 * post edit-permission surfaces:
 *   1. "Who can edit" picker (author sets owner|open|approval mode).
 *   2. "Suggested edits" review list (author approves/rejects proposals).
 * Logic is unchanged from app/chat/[conversationId].tsx; only moved here to
 * shrink the mega-screen and isolate the feature.
 */
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../theme';
import { stripRichTextTags } from '../../lib/chatRichText';

type EditMode = 'owner' | 'open' | 'approval';

export function EditPermissionModals({
  editModeTarget,
  onCloseEditMode,
  onApplyEditMode,
  showPendingEdits,
  onClosePendingEdits,
  pendingEditsList,
  onReviewEdit,
}: {
  editModeTarget: any | null;
  onCloseEditMode: () => void;
  onApplyEditMode: (mode: EditMode) => void;
  showPendingEdits: boolean;
  onClosePendingEdits: () => void;
  pendingEditsList: any[] | undefined;
  onReviewEdit: (pendingEditId: string, decision: 'approve' | 'reject', proposerName?: string) => void;
}) {
  return (
    <>
      {/* "Who can edit" picker for a group post (author). */}
      <Modal visible={!!editModeTarget} transparent animationType="fade" onRequestClose={onCloseEditMode}>
        <Pressable style={styles.editModeBackdrop} onPress={onCloseEditMode}>
          <Pressable style={styles.editModeSheet} onPress={() => {}}>
            <Text style={styles.editModeTitle}>Who can edit this post?</Text>
            {(
              [
                { key: 'owner', label: 'Only me', hint: 'Just you can edit this post' },
                { key: 'open', label: 'Anyone can edit', hint: 'Any member can edit directly' },
                { key: 'approval', label: 'Anyone with my approval', hint: 'Members propose; you approve each edit' },
              ] as const
            ).map((opt) => {
              const active = (editModeTarget?.editMode || 'owner') === opt.key;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={styles.editModeOption}
                  onPress={() => onApplyEditMode(opt.key)}
                  testID={`edit-mode-${opt.key}`}
                >
                  <View style={styles.flexOne}>
                    <Text style={styles.editModeOptionLabel}>{opt.label}</Text>
                    <Text style={styles.editModeOptionHint}>{opt.hint}</Text>
                  </View>
                  {active ? <Feather name="check" size={20} color={Colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Author reviews member-proposed edits. */}
      <Modal visible={showPendingEdits} transparent animationType="fade" onRequestClose={onClosePendingEdits}>
        <Pressable style={styles.editModeBackdrop} onPress={onClosePendingEdits}>
          <Pressable style={styles.pendingEditsSheet} onPress={() => {}}>
            <Text style={styles.editModeTitle}>Suggested edits</Text>
            {!pendingEditsList || pendingEditsList.length === 0 ? (
              <Text style={styles.pendingEditsEmpty}>No pending edits to review.</Text>
            ) : (
              <ScrollView style={styles.pendingEditsScroll}>
                {pendingEditsList.map((pe: any) => (
                  <View key={String(pe._id)} style={styles.pendingEditItem}>
                    <Text style={styles.pendingEditProposer}>
                      {pe.proposerName || pe.proposer?.name || 'A member'} suggests:
                    </Text>
                    {pe.originalText ? (
                      <Text style={styles.pendingEditOriginal} numberOfLines={3}>
                        {stripRichTextTags(pe.originalText)}
                      </Text>
                    ) : null}
                    <Text style={styles.pendingEditProposed} numberOfLines={6}>
                      {stripRichTextTags(pe.proposedText || pe.text || '')}
                    </Text>
                    <View style={styles.pendingEditActions}>
                      <TouchableOpacity
                        style={[styles.pendingEditBtn, styles.pendingEditReject]}
                        onPress={() => onReviewEdit(String(pe._id), 'reject')}
                        testID={`pending-edit-reject-${String(pe._id).slice(-6)}`}
                      >
                        <Feather name="x" size={16} color={Colors.danger} />
                        <Text style={styles.pendingEditRejectText}>Reject</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.pendingEditBtn, styles.pendingEditApprove]}
                        onPress={() => onReviewEdit(String(pe._id), 'approve', pe.proposerName || pe.proposer?.name)}
                        testID={`pending-edit-approve-${String(pe._id).slice(-6)}`}
                      >
                        <Feather name="check" size={16} color={Colors.white} />
                        <Text style={styles.pendingEditApproveText}>Approve</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
  editModeBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
  },
  editModeSheet: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 24,
  },
  editModeTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary, marginBottom: 12 },
  editModeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  editModeOptionLabel: { fontSize: 16, fontWeight: '600', color: Colors.textPrimary },
  editModeOptionHint: { fontSize: 13, color: Colors.textMuted, marginTop: 2 },
  pendingEditsSheet: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 24,
    maxHeight: '75%',
  },
  pendingEditsScroll: { marginTop: 8 },
  pendingEditsEmpty: { fontSize: 14, color: Colors.textMuted, marginTop: 12 },
  pendingEditItem: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  pendingEditProposer: { fontSize: 13, fontWeight: '600', color: Colors.textPrimary },
  pendingEditOriginal: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 6,
    textDecorationLine: 'line-through',
  },
  pendingEditProposed: { fontSize: 15, color: Colors.textPrimary, marginTop: 6 },
  pendingEditActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  pendingEditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  pendingEditReject: { borderWidth: 1, borderColor: Colors.danger },
  pendingEditRejectText: { color: Colors.danger, fontWeight: '600', fontSize: 14 },
  pendingEditApprove: { backgroundColor: Colors.primary },
  pendingEditApproveText: { color: Colors.white, fontWeight: '600', fontSize: 14 },
});
