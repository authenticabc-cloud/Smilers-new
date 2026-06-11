/**
 * ForwardPickerSheet (extracted iter-185, Chat Refactor Phase 2) — the
 * "Forward to" conversation picker, with the Diary tile pinned at the
 * top (iter-109/111). Display-name resolution + encrypted-preview
 * sanitisation live here; forwarding/diary side-effects stay in the
 * parent via `onForwardTo` / `onSaveToDiary` callbacks.
 */
import React from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  findSavedContactDisplayName,
  getConversationDisplayName,
  getDisplayInitials,
} from '../../lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme';

export function ForwardPickerSheet({
  visible,
  conversations,
  currentConversationId,
  contacts,
  myUserId,
  onClose,
  onForwardTo,
  onSaveToDiary,
}: {
  visible: boolean;
  conversations: any[];
  currentConversationId?: string;
  contacts: any;
  myUserId?: string;
  onClose: () => void;
  onForwardTo: (conversationId: string) => void;
  onSaveToDiary: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, styles.forwardSheet]} onPress={() => {}} testID="forward-picker-sheet">
          <Text style={styles.forwardTitle} testID="forward-picker-title">
            Forward to
          </Text>
          <FlatList
            data={
              (Array.isArray(conversations) ? conversations : []).filter(
                (item: any) => item._id !== currentConversationId,
              )
            }
            keyExtractor={(item: any) => item._id}
            contentContainerStyle={styles.forwardListContent}
            ListHeaderComponent={
              // Diary pinned at the TOP — saves the forwarded message to
              // the LOCAL diary store (never touches the Convex backend).
              <TouchableOpacity
                style={[styles.forwardRow, styles.forwardRowDiary]}
                onPress={onSaveToDiary}
                testID="forward-target-diary"
              >
                <View style={[styles.forwardAvatar, styles.forwardAvatarDiary]}>
                  <MaterialCommunityIcons
                    name="book-account-outline"
                    size={20}
                    color={Colors.warningDark}
                  />
                </View>
                <View style={styles.flexOne}>
                  <Text style={styles.forwardName} numberOfLines={1}>Diary</Text>
                  <Text style={styles.forwardPreview} numberOfLines={1}>
                    Save to your personal diary
                  </Text>
                </View>
              </TouchableOpacity>
            }
            renderItem={({ item }: any) => {
              // Centralised display-name resolver — walks the members/
              // otherUser/firstName chains, mirrors the chats list.
              const savedName = findSavedContactDisplayName(contacts, item, myUserId);
              const displayName =
                savedName ||
                getConversationDisplayName(item, myUserId, 'Smilers user');
              // Sanitise the last-message preview — never expose an
              // undecrypted E2EE ciphertext (base64 blob).
              const raw = String(item.lastMessageText || '').trim();
              let preview = raw;
              if (raw) {
                const looksEncrypted =
                  /^[A-Za-z0-9+/]{30,}={0,2}$/.test(raw) ||
                  raw.length > 200;
                if (looksEncrypted) preview = 'Encrypted message';
              } else {
                preview = 'Open conversation';
              }
              return (
                <TouchableOpacity
                  style={styles.forwardRow}
                  onPress={() => onForwardTo(item._id)}
                  testID={`forward-target-${item._id}`}
                >
                  <View style={styles.forwardAvatar}>
                    <Text style={styles.forwardAvatarText}>
                      {getDisplayInitials(displayName, 1)}
                    </Text>
                  </View>
                  <View style={styles.flexOne}>
                    <Text style={styles.forwardName}>{displayName}</Text>
                    <Text style={styles.forwardSub} numberOfLines={1}>
                      {preview}
                    </Text>
                  </View>
                  <Feather name="send" size={18} color={Colors.primary} />
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.forwardEmpty} testID="forward-picker-empty">
                No other chats to forward to.
              </Text>
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
  forwardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  forwardRowDiary: {
    backgroundColor: '#FFFBEB',
    borderBottomColor: 'transparent',
    marginBottom: 4,
    borderRadius: Radius.md,
    paddingHorizontal: 12,
  },
  forwardAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forwardAvatarDiary: {
    backgroundColor: Colors.warningLight,
  },
  forwardAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold },
  forwardName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  forwardSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  forwardPreview: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  forwardEmpty: { textAlign: 'center', color: Colors.textMuted, paddingVertical: Spacing.lg },
});
