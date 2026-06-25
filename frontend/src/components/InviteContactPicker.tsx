/**
 * InviteContactPicker — a bottom-sheet style modal for inviting a registered
 * Smilers contact into an ongoing call (ad-hoc multiparty / "Add" button).
 *
 * It owns its own contact query (`api.contacts.getContacts`) and calls back
 * `onInvite(userId, name)` for each tapped contact. Contacts already in the
 * call (`excludeUserIds`) and locally-saved invite-only contacts (no linked
 * user id) are filtered out. Multiple people can be invited in one session;
 * each row shows its own pending/done state.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { api } from '../convexApi';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

type Any = any;

function getContactUserId(item: Any): string | null {
  const value =
    item?.userId ||
    item?.user?._id ||
    item?.user?.userId ||
    item?.contactUserId ||
    item?.linkedUserId ||
    item?._id ||
    item?.id;
  return value ? String(value) : null;
}

function getInitials(name?: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export default function InviteContactPicker({
  visible,
  onClose,
  excludeUserIds,
  onInvite,
  title = 'Add to call',
}: {
  visible: boolean;
  onClose: () => void;
  excludeUserIds: string[];
  onInvite: (userId: string, name: string) => Promise<void> | void;
  title?: string;
}) {
  const isWeb = Platform.OS === 'web';
  const { data: contacts, loading } = useSafeConvexQuery<Any[]>(
    api.contacts.getContacts,
    {},
    [],
    visible && !isWeb,
  );
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [invited, setInvited] = useState<Record<string, boolean>>({});

  const exclude = useMemo(() => new Set(excludeUserIds.map(String)), [excludeUserIds]);

  const eligible = useMemo(() => {
    const list = Array.isArray(contacts) ? contacts : [];
    const seen = new Set<string>();
    return list.filter((c: Any) => {
      const id = getContactUserId(c);
      if (!id || exclude.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [contacts, exclude]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((c: Any) =>
      `${c?.name || ''} ${c?.phone || ''} ${c?.email || ''}`.toLowerCase().includes(q),
    );
  }, [eligible, search]);

  const handleTap = useCallback(
    async (item: Any) => {
      const id = getContactUserId(item);
      if (!id || pending[id] || invited[id]) return;
      setPending((p) => ({ ...p, [id]: true }));
      try {
        await onInvite(id, item?.name || item?.fullName || 'Contact');
        setInvited((i) => ({ ...i, [id]: true }));
      } catch {
        // surface nothing here — caller alerts on failure
      } finally {
        setPending((p) => ({ ...p, [id]: false }));
      }
    },
    [onInvite, pending, invited],
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={styles.backdropFill} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.searchBox}>
            <Ionicons name="search" size={18} color={Colors.textMuted} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search contacts"
              placeholderTextColor={Colors.textMuted}
              style={styles.searchInput}
              autoCorrect={false}
              testID="invite-picker-search"
            />
          </View>

          {loading && eligible.length === 0 ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : filtered.length === 0 ? (
            <View style={styles.center}>
              <Ionicons name="people-outline" size={36} color={Colors.textMuted} />
              <Text style={styles.emptyText}>No contacts available to add.</Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item, idx) => getContactUserId(item) || String(idx)}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: Spacing.xl }}
              renderItem={({ item }) => {
                const id = getContactUserId(item) as string;
                const isPending = !!pending[id];
                const isDone = !!invited[id];
                return (
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => handleTap(item)}
                    disabled={isPending || isDone}
                    testID={`invite-contact-${id}`}
                  >
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{getInitials(item?.name)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {item?.name || item?.phone || 'Contact'}
                      </Text>
                      {item?.phone ? (
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {item.phone}
                        </Text>
                      ) : null}
                    </View>
                    {isPending ? (
                      <ActivityIndicator size="small" color={Colors.primary} />
                    ) : isDone ? (
                      <View style={styles.invitedPill}>
                        <Ionicons name="checkmark" size={14} color={Colors.success} />
                        <Text style={styles.invitedText}>Ringing</Text>
                      </View>
                    ) : (
                      <View style={styles.addBtn}>
                        <Ionicons name="add" size={20} color={Colors.headerBg} />
                      </View>
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  backdropFill: { flex: 1 },
  sheet: {
    maxHeight: '78%',
    backgroundColor: Colors.background || '#fff',
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border || '#ddd',
    marginBottom: Spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.inputBg || '#F1F1F1',
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.sm,
    height: 44,
    marginBottom: Spacing.sm,
  },
  searchInput: { flex: 1, color: Colors.textPrimary, fontSize: FontSize.base },
  center: { paddingVertical: Spacing.xl, alignItems: 'center', gap: Spacing.sm },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: 10,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  rowName: { color: Colors.textPrimary, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  rowSub: { color: Colors.textMuted, fontSize: FontSize.xs, marginTop: 1 },
  addBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  invitedPill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  invitedText: { color: Colors.success, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
});
