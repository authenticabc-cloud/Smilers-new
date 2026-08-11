import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  FlatList,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

export type BulkPositionMember = {
  userId: string;
  name: string;
  currentTitle: string;
  currentShowInMother: boolean;
};

function getInitials(name?: string): string {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/**
 * BulkPositionsModal — assign/clear office-bearer titles for MANY sub-group
 * members in one sheet. Any sub-group admin can edit titles; the Chief Admin
 * additionally toggles "show in mother group" per member. Only rows that
 * changed are pushed via subGroups.setPosition.
 */
export function BulkPositionsModal({
  visible,
  subGroupId,
  backend = 'subGroups',
  allowVisibility = true,
  members,
  isChief,
  onClose,
}: {
  visible: boolean;
  subGroupId: string;
  backend?: 'subGroups' | 'groupPositions';
  allowVisibility?: boolean;
  members: BulkPositionMember[];
  isChief: boolean;
  onClose: () => void;
}) {
  const positionApi = backend === 'groupPositions' ? (api as any).groupPositions : (api as any).subGroups;
  const setPositionM = useMutation(positionApi?.setPosition);
  const idArg = backend === 'groupPositions' ? { conversationId: subGroupId } : { subGroupId };
  const canShowVisibility = allowVisibility && backend === 'subGroups';
  const [draft, setDraft] = useState<Record<string, { title: string; showInMother: boolean }>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      const seed: Record<string, { title: string; showInMother: boolean }> = {};
      members.forEach((m) => {
        seed[m.userId] = { title: m.currentTitle || '', showInMother: !!m.currentShowInMother };
      });
      setDraft(seed);
    }
  }, [visible, members]);

  const setTitle = useCallback((uid: string, title: string) => {
    setDraft((prev) => ({ ...prev, [uid]: { ...(prev[uid] || { showInMother: false }), title } }));
  }, []);
  const setShow = useCallback((uid: string, showInMother: boolean) => {
    setDraft((prev) => ({ ...prev, [uid]: { ...(prev[uid] || { title: '' }), showInMother } }));
  }, []);

  const save = useCallback(async () => {
    if (!setPositionM) return;
    setBusy(true);
    let failed = 0;
    for (const m of members) {
      const d = draft[m.userId] || { title: '', showInMother: false };
      const titleChanged = (d.title || '').trim() !== (m.currentTitle || '').trim();
      const showChanged = canShowVisibility && isChief && !!d.showInMother !== !!m.currentShowInMother;
      if (!titleChanged && !showChanged) continue;
      try {
        await setPositionM({
          ...idArg,
          userId: m.userId,
          title: (d.title || '').trim(),
          ...(canShowVisibility && isChief ? { showInMother: !!d.showInMother } : {}),
        });
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    onClose();
    if (failed > 0) Alert.alert('Some positions failed', `${failed} could not be saved.`);
  }, [setPositionM, members, draft, canShowVisibility, isChief, idArg, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Manage positions</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} testID="bulk-positions-close">
              <Ionicons name="close" size={24} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>Give members a title (e.g. President). Leave blank to clear.</Text>
          <FlatList
            style={styles.list}
            data={members}
            keyExtractor={(m) => m.userId}
            ListEmptyComponent={<Text style={styles.empty}>No members to assign.</Text>}
            renderItem={({ item }) => {
              const d = draft[item.userId] || { title: '', showInMother: false };
              return (
                <View style={styles.row} testID={`bulk-position-row-${item.userId}`}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{getInitials(item.name)}</Text>
                  </View>
                  <View style={styles.mid}>
                    <Text style={styles.name} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Title (optional)"
                      placeholderTextColor={Colors.textSecondary}
                      value={d.title}
                      onChangeText={(t) => setTitle(item.userId, t)}
                      maxLength={40}
                      testID={`bulk-position-input-${item.userId}`}
                    />
                    {canShowVisibility && isChief && d.title.trim() ? (
                      <View style={styles.showRow}>
                        <Text style={styles.showLabel}>Show in mother group</Text>
                        <Switch
                          value={d.showInMother}
                          onValueChange={(v) => setShow(item.userId, v)}
                          trackColor={{ true: Colors.primary }}
                          testID={`bulk-position-show-${item.userId}`}
                        />
                      </View>
                    ) : null}
                  </View>
                </View>
              );
            }}
          />
          <TouchableOpacity style={[styles.primaryBtn, busy && styles.btnDisabled]} onPress={save} disabled={busy} testID="bulk-positions-save">
            {busy ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryBtnText}>Save all</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  card: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.lg,
    maxHeight: '88%',
    gap: Spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  list: { marginVertical: Spacing.sm },
  empty: { fontSize: FontSize.base, color: Colors.textSecondary, fontStyle: 'italic', paddingVertical: Spacing.md },
  row: { flexDirection: 'row', gap: Spacing.md, paddingVertical: 10, alignItems: 'flex-start' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  avatarText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  mid: { flex: 1, gap: 6 },
  name: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.border || '#E5E7EB',
  },
  showRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  showLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  primaryBtn: { backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: Radius.pill, alignItems: 'center' },
  primaryBtnText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  btnDisabled: { opacity: 0.6 },
});
