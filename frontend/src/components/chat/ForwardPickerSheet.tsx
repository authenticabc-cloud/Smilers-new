/**
 * ForwardPickerSheet — the "Forward to" conversation picker.
 *
 * Supports MULTI-RECIPIENT forwarding (iter-430): tap chats to select many, or
 * "Select all", then "Forward to N chats" — the parent dispatches in blocks of
 * 25 and reports live progress here. The Diary tile stays a one-tap shortcut.
 * Display-name resolution + encrypted-preview sanitisation live here; the
 * forwarding side-effects stay in the parent via the callbacks.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import Avatar from '../Avatar';
import {
  findSavedContactDisplayName,
  getConversationDisplayName,
  getResolvedConversationDisplayName,
} from '../../lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../lib/deviceContactIndex';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme';

export function ForwardPickerSheet({
  visible,
  conversations,
  currentConversationId,
  contacts,
  myUserId,
  onClose,
  onForwardTo,
  onForwardToMany,
  onSaveToDiary,
  onShareOnce,
  forwarding,
  progress,
}: {
  visible: boolean;
  conversations: any[];
  currentConversationId?: string;
  contacts: any;
  myUserId?: string;
  onClose: () => void;
  onForwardTo: (conversationId: string) => void;
  onForwardToMany?: (conversationIds: string[]) => void;
  onSaveToDiary: () => void;
  onShareOnce?: () => void;
  forwarding?: boolean;
  progress?: { done: number; total: number };
}) {
  const deviceIndex = useDeviceContactIndex();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset the selection each time the sheet opens.
  useEffect(() => {
    if (visible) setSelected(new Set());
  }, [visible]);

  const targets = useMemo(
    () => (Array.isArray(conversations) ? conversations : []).filter((item: any) => item._id !== currentConversationId),
    [conversations, currentConversationId],
  );

  const allSelected = targets.length > 0 && selected.size === targets.length;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === targets.length ? new Set() : new Set(targets.map((t: any) => t._id))));
  };

  const confirm = () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    if (ids.length === 1) onForwardTo(ids[0]);
    else if (onForwardToMany) onForwardToMany(ids);
    else onForwardTo(ids[0]);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={forwarding ? undefined : onClose}>
        <Pressable style={[styles.sheet, styles.forwardSheet]} onPress={() => {}} testID="forward-picker-sheet">
          <View style={styles.headerRow}>
            <Text style={styles.forwardTitle} testID="forward-picker-title">
              Forward to
            </Text>
            {targets.length > 0 ? (
              <TouchableOpacity onPress={toggleAll} testID="forward-select-all" disabled={forwarding}>
                <Text style={styles.selectAll}>{allSelected ? 'Clear all' : 'Select all'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <FlatList
            data={targets}
            keyExtractor={(item: any) => item._id}
            contentContainerStyle={styles.forwardListContent}
            ListHeaderComponent={
              <>
                <TouchableOpacity
                  style={[styles.forwardRow, styles.forwardRowDiary]}
                  onPress={onSaveToDiary}
                  disabled={forwarding}
                  testID="forward-target-diary"
                >
                  <View style={[styles.forwardAvatar, styles.forwardAvatarDiary]}>
                    <MaterialCommunityIcons name="book-account-outline" size={20} color={Colors.warningDark} />
                  </View>
                  <View style={styles.flexOne}>
                    <Text style={styles.forwardName} numberOfLines={1}>Diary</Text>
                    <Text style={styles.forwardPreview} numberOfLines={1}>Save to your personal diary</Text>
                  </View>
                </TouchableOpacity>
                {onShareOnce ? (
                  <TouchableOpacity
                    style={[styles.forwardRow, styles.forwardRowShareOnce]}
                    onPress={onShareOnce}
                    disabled={forwarding}
                    testID="forward-target-share-once"
                  >
                    <View style={[styles.forwardAvatar, styles.forwardAvatarShareOnce]}>
                      <MaterialCommunityIcons name="share-variant-outline" size={20} color={Colors.primary} />
                    </View>
                    <View style={styles.flexOne}>
                      <Text style={styles.forwardName} numberOfLines={1}>Share Once</Text>
                      <Text style={styles.forwardPreview} numberOfLines={1}>Save to your Share Once page — pick who later</Text>
                    </View>
                  </TouchableOpacity>
                ) : null}
              </>
            }
            renderItem={({ item }: any) => {
              const deviceName = getResolvedConversationDisplayName(
                item,
                myUserId,
                deviceIndex,
                lookupDeviceContactName,
                '',
              );
              const savedName = findSavedContactDisplayName(contacts, item, myUserId);
              const displayName =
                deviceName || savedName || getConversationDisplayName(item, myUserId, 'Smilers user');
              const raw = String(item.lastMessageText || '').trim();
              let preview = raw;
              if (raw) {
                const looksEncrypted = /^[A-Za-z0-9+/]{30,}={0,2}$/.test(raw) || raw.length > 200;
                if (looksEncrypted) preview = 'Encrypted message';
              } else {
                preview = 'Open conversation';
              }
              const isSel = selected.has(item._id);
              const photoUri =
                item?.avatar ||
                item?.avatarUrl ||
                item?.photo ||
                item?.icon ||
                item?.groupIcon ||
                item?.profilePicture ||
                item?.otherUser?.avatar ||
                item?.otherUser?.profilePicture ||
                item?.otherParticipant?.avatar ||
                item?.otherParticipant?.profilePicture ||
                undefined;
              return (
                <TouchableOpacity
                  style={[styles.forwardRow, isSel && styles.forwardRowSel]}
                  onPress={() => toggle(item._id)}
                  disabled={forwarding}
                  testID={`forward-target-${item._id}`}
                >
                  <Avatar name={displayName} size={44} uri={photoUri} />
                  <View style={styles.flexOne}>
                    <Text style={styles.forwardName}>{displayName}</Text>
                    <Text style={styles.forwardSub} numberOfLines={1}>{preview}</Text>
                  </View>
                  <View style={[styles.checkbox, isSel && styles.checkboxOn]}>
                    {isSel ? <Feather name="check" size={16} color={Colors.white} /> : null}
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.forwardEmpty} testID="forward-picker-empty">
                No other chats to forward to.
              </Text>
            }
          />

          {/* Footer: confirm / progress */}
          {forwarding ? (
            <View style={styles.footerBtnBusy} testID="forward-progress">
              <ActivityIndicator color={Colors.white} />
              <Text style={styles.footerBtnText}>
                Forwarding {progress ? `${progress.done}/${progress.total}` : ''}…
              </Text>
            </View>
          ) : selected.size > 0 ? (
            <TouchableOpacity style={styles.footerBtn} onPress={confirm} testID="forward-confirm">
              <Feather name="send" size={18} color={Colors.white} />
              <Text style={styles.footerBtnText}>
                Forward to {selected.size} chat{selected.size === 1 ? '' : 's'}
              </Text>
            </TouchableOpacity>
          ) : null}
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
  forwardSheet: { maxHeight: '75%' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.md },
  forwardTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  selectAll: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primary },
  forwardListContent: { paddingBottom: Spacing.md },
  forwardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  forwardRowSel: { backgroundColor: Colors.primaryLight, borderRadius: Radius.md, paddingHorizontal: 8, borderBottomColor: 'transparent' },
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
  forwardAvatarDiary: { backgroundColor: Colors.warningLight },
  forwardRowShareOnce: {
    backgroundColor: 'rgba(233,181,59,0.10)',
    borderBottomColor: 'transparent',
    marginBottom: 4,
    borderRadius: Radius.md,
    paddingHorizontal: 12,
  },
  forwardAvatarShareOnce: { backgroundColor: Colors.primaryLight },
  forwardAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold },
  forwardName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  forwardSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  forwardPreview: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  forwardEmpty: { textAlign: 'center', color: Colors.textMuted, paddingVertical: Spacing.lg },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  footerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    height: 50,
    borderRadius: Radius.pill,
    marginTop: Spacing.sm,
  },
  footerBtnBusy: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.primary,
    height: 50,
    borderRadius: Radius.pill,
    marginTop: Spacing.sm,
    opacity: 0.85,
  },
  footerBtnText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
});
