import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  FlatList,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useReactiveSafeConvexQuery } from '../hooks/useReactiveSafeConvexQuery';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

const SUB_GROUPS_ENABLED = process.env.EXPO_PUBLIC_SUB_GROUPS_ENABLED !== 'false';

type MotherMember = { userId: string; name: string };

function subId(item: any): string | null {
  const v = item?._id || item?.id || item?.conversationId;
  return v ? String(v) : null;
}

function getInitials(name?: string): string {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/**
 * SubGroupsSection — the "Sub Groups" block inside a mother group's Info screen.
 * Lets members create a sub group (admins → active immediately, others →
 * pending an admin's approval), lists existing sub groups the caller may see,
 * and lets mother-group admins approve/reject pending ones. Only shows for
 * top-level groups (a sub group cannot itself contain sub groups).
 *
 * Backend: subGroups.create / listForParent / approve / reject.
 */
export function SubGroupsSection({
  parentConversationId,
  motherMembers,
  motherAdminIds,
  groupName,
  isMotherAdmin,
  myId,
  onOpenChat,
  onManage,
}: {
  parentConversationId: string;
  motherMembers: MotherMember[];
  motherAdminIds: string[];
  groupName: string;
  isMotherAdmin: boolean;
  myId: string | null;
  onOpenChat: (id: string) => void;
  onManage: (id: string) => void;
}) {
  const { data: subGroups } = useReactiveSafeConvexQuery<any[]>(
    (api as any).subGroups?.listForParent,
    parentConversationId ? { parentConversationId } : {},
    [],
    SUB_GROUPS_ENABLED && !!parentConversationId,
  );

  const createM = useMutation((api as any).subGroups?.create);
  const approveM = useMutation((api as any).subGroups?.approve);
  const rejectM = useMutation((api as any).subGroups?.reject);
  const addMemberM = useMutation((api as any).subGroups?.addMember);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [addTarget, setAddTarget] = useState<{ id: string; name: string } | null>(null);
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set());
  const [addBusy, setAddBusy] = useState(false);

  // Existing members of the sub group the admin is adding people to — so we
  // don't offer members who are already in it. Only queried while the sheet is open.
  const { data: targetMembers } = useSafeConvexQuery<any[]>(
    (api as any).conversations?.getGroupMembers,
    addTarget?.id ? { conversationId: addTarget.id } : {},
    [],
    !!addTarget?.id,
  );
  const targetMemberIds = useMemo(() => {
    const set = new Set<string>();
    (Array.isArray(targetMembers) ? targetMembers : []).forEach((m: any) => {
      const uid = m?.userId || m?.user?._id || m?._id;
      if (uid) set.add(String(uid));
    });
    return set;
  }, [targetMembers]);
  const addableMembers = useMemo(
    () => motherMembers.filter((m) => m.userId && !targetMemberIds.has(m.userId)),
    [motherMembers, targetMemberIds],
  );

  const selectableMembers = useMemo(
    () => motherMembers.filter((m) => m.userId && m.userId !== myId),
    [motherMembers, myId],
  );

  const rows = useMemo(() => (Array.isArray(subGroups) ? subGroups.filter((s) => subId(s)) : []), [subGroups]);
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => String(r?.name || '').toLowerCase().includes(q));
  }, [rows, search]);

  const toggleAdd = useCallback((uid: string) => {
    setAddSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const submitAddMembers = useCallback(async () => {
    if (!addTarget?.id || !addMemberM || addSelected.size === 0) {
      setAddTarget(null);
      return;
    }
    setAddBusy(true);
    const ids = Array.from(addSelected);
    let failed = 0;
    for (const uid of ids) {
      try {
        await addMemberM({ subGroupId: addTarget.id, userId: uid });
      } catch {
        failed += 1;
      }
    }
    setAddBusy(false);
    setAddTarget(null);
    setAddSelected(new Set());
    if (failed > 0) {
      Alert.alert('Some members not added', `${ids.length - failed} added · ${failed} failed.`);
    }
  }, [addTarget?.id, addMemberM, addSelected]);

  const toggle = useCallback((uid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const resetCreate = useCallback(() => {
    setName('');
    setDesc('');
    setSelected(new Set());
  }, []);

  // "Leaders" one-tap: pre-fill the create sheet with all current admins so
  // group leaders can spin up their private sub group in a single step.
  const openLeadersCreate = useCallback(() => {
    const adminSet = new Set(
      (motherAdminIds || []).map(String).filter((uid) => uid && uid !== myId),
    );
    setName(`${groupName} Leaders`.slice(0, 60));
    setDesc('');
    setSelected(adminSet);
    setCreateOpen(true);
  }, [motherAdminIds, myId, groupName]);

  const leaderCount = useMemo(
    () => (motherAdminIds || []).map(String).filter((uid) => uid && uid !== myId).length,
    [motherAdminIds, myId],
  );

  const submitCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert('Name required', 'Please give the sub group a name.');
      return;
    }
    if (!createM) return;
    setBusy(true);
    try {
      const res = await createM({
        parentConversationId,
        name: trimmed,
        description: desc.trim() || undefined,
        memberIds: Array.from(selected),
      });
      setCreateOpen(false);
      resetCreate();
      if (res?.status === 'pending') {
        Alert.alert('Sent for approval', 'Your sub group was created and is awaiting a group admin\u2019s approval.');
      }
    } catch (e: any) {
      Alert.alert('Could not create', e?.data?.message || e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [name, desc, selected, createM, parentConversationId, resetCreate]);

  const onApprove = useCallback(
    async (id: string) => {
      if (!approveM) return;
      setBusyId(id);
      try {
        await approveM({ subGroupId: id });
      } catch (e: any) {
        Alert.alert('Could not approve', e?.data?.message || e?.message || 'Only a group admin can approve.');
      } finally {
        setBusyId(null);
      }
    },
    [approveM],
  );

  const onReject = useCallback(
    (id: string, label: string) => {
      if (!rejectM) return;
      Alert.alert('Reject sub group?', `"${label}" will be removed.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setBusyId(id);
            try {
              await rejectM({ subGroupId: id });
            } catch (e: any) {
              Alert.alert('Could not reject', e?.data?.message || e?.message || 'Please try again.');
            } finally {
              setBusyId(null);
            }
          },
        },
      ]);
    },
    [rejectM],
  );

  if (!SUB_GROUPS_ENABLED) return null;

  return (
    <View style={styles.section} testID="sub-groups-section">
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Sub Groups</Text>
        <TouchableOpacity
          style={styles.createBtn}
          onPress={() => setCreateOpen(true)}
          testID="sub-group-create-open"
          hitSlop={8}
        >
          <Ionicons name="add" size={18} color={Colors.white} />
          <Text style={styles.createBtnText}>Create</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.hint}>
        Groups within this group. Members you add must belong to this group. Sub groups are only visible to their
        members.
      </Text>

      {leaderCount > 0 ? (
        <TouchableOpacity style={styles.leadersBtn} onPress={openLeadersCreate} testID="sub-group-leaders-shortcut">
          <Ionicons name="star" size={15} color={Colors.primary} />
          <Text style={styles.leadersBtnText}>
            Create leaders sub group ({leaderCount} admin{leaderCount === 1 ? '' : 's'})
          </Text>
        </TouchableOpacity>
      ) : null}

      {rows.length >= 4 ? (
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={Colors.textSecondary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search sub groups"
            placeholderTextColor={Colors.textSecondary}
            value={search}
            onChangeText={setSearch}
            testID="sub-group-search"
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={8} testID="sub-group-search-clear">
              <Ionicons name="close-circle" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {rows.length === 0 ? (
        <Text style={styles.empty} testID="sub-groups-empty">
          No sub groups yet.
        </Text>
      ) : filteredRows.length === 0 ? (
        <Text style={styles.empty} testID="sub-groups-no-match">
          No sub groups match &quot;{search}&quot;.
        </Text>
      ) : (
        filteredRows.map((item) => {
          const id = subId(item)!;
          const pending = item?.subGroupStatus === 'pending';
          const memberCount = item?.memberCount || 0;
          const rowBusy = busyId === id;
          return (
            <View key={id} style={styles.row} testID={`sub-group-row-${id}`}>
              <View style={[styles.avatar, pending && styles.pendingAvatar]}>
                {pending ? (
                  <Ionicons name="hourglass-outline" size={16} color={Colors.white} />
                ) : (
                  <Text style={styles.avatarText}>{getInitials(item?.name)}</Text>
                )}
              </View>
              <TouchableOpacity
                style={styles.rowMid}
                disabled={pending}
                onPress={() => onOpenChat(id)}
                activeOpacity={0.7}
              >
                <View style={styles.rowNameLine}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {item?.name || 'Sub group'}
                  </Text>
                  <View style={styles.subTag}>
                    <Text style={styles.subTagText}>SUB</Text>
                  </View>
                </View>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {pending
                    ? 'Awaiting approval'
                    : `${memberCount} member${memberCount === 1 ? '' : 's'}`}
                </Text>
              </TouchableOpacity>

              {pending ? (
                rowBusy ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <View style={styles.pendingActions}>
                    {isMotherAdmin ? (
                      <TouchableOpacity
                        onPress={() => onApprove(id)}
                        style={[styles.pendBtn, styles.approveBtn]}
                        testID={`sub-group-approve-${id}`}
                        hitSlop={6}
                      >
                        <Ionicons name="checkmark" size={16} color={Colors.white} />
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      onPress={() => onReject(id, item?.name || 'Sub group')}
                      style={[styles.pendBtn, styles.rejectBtn]}
                      testID={`sub-group-reject-${id}`}
                      hitSlop={6}
                    >
                      <Ionicons name="close" size={16} color={Colors.white} />
                    </TouchableOpacity>
                  </View>
                )
              ) : (
                <View style={styles.rowActions}>
                  {isMotherAdmin ? (
                    <TouchableOpacity
                      onPress={() => {
                        setAddSelected(new Set());
                        setAddTarget({ id, name: item?.name || 'Sub group' });
                      }}
                      hitSlop={8}
                      testID={`sub-group-add-members-${id}`}
                    >
                      <Ionicons name="person-add-outline" size={20} color={Colors.primary} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity onPress={() => onManage(id)} hitSlop={8} testID={`sub-group-manage-${id}`}>
                    <Ionicons name="settings-outline" size={20} color={Colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        })
      )}

      {/* Add members to a sub group */}
      <Modal visible={!!addTarget} animationType="slide" transparent onRequestClose={() => setAddTarget(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle} numberOfLines={1}>
                Add to {addTarget?.name || 'sub group'}
              </Text>
              <TouchableOpacity onPress={() => setAddTarget(null)} hitSlop={8} testID="sub-group-add-close">
                <Ionicons name="close" size={24} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>
              Pick members from this group. They stay in the main group too — sub groups only include current members.
            </Text>
            <Text style={styles.pickLabel}>Members ({addSelected.size} selected)</Text>
            <FlatList
              style={styles.memberList}
              data={addableMembers}
              keyExtractor={(m) => m.userId}
              ListEmptyComponent={<Text style={styles.empty}>Everyone is already in this sub group.</Text>}
              renderItem={({ item }) => {
                const on = addSelected.has(item.userId);
                return (
                  <TouchableOpacity
                    style={styles.pickRow}
                    onPress={() => toggleAdd(item.userId)}
                    testID={`sub-group-add-pick-${item.userId}`}
                  >
                    <View style={styles.avatarSm}>
                      <Text style={styles.avatarText}>{getInitials(item.name)}</Text>
                    </View>
                    <Text style={styles.pickName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Ionicons
                      name={on ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={on ? Colors.primary : Colors.textSecondary}
                    />
                  </TouchableOpacity>
                );
              }}
            />
            <TouchableOpacity
              style={[styles.primaryBtn, (addBusy || addSelected.size === 0) && styles.btnDisabled]}
              onPress={submitAddMembers}
              disabled={addBusy || addSelected.size === 0}
              testID="sub-group-add-submit"
            >
              {addBusy ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <Text style={styles.primaryBtnText}>
                  Add {addSelected.size > 0 ? addSelected.size : ''} member{addSelected.size === 1 ? '' : 's'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Create modal */}
      <Modal visible={createOpen} animationType="slide" transparent onRequestClose={() => setCreateOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New sub group</Text>
              <TouchableOpacity onPress={() => setCreateOpen(false)} hitSlop={8} testID="sub-group-create-close">
                <Ionicons name="close" size={24} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <TextInput
              style={styles.input}
              placeholder="Sub group name"
              placeholderTextColor={Colors.textSecondary}
              value={name}
              onChangeText={setName}
              maxLength={60}
              testID="sub-group-name-input"
            />
            <TextInput
              style={styles.input}
              placeholder="Description (optional)"
              placeholderTextColor={Colors.textSecondary}
              value={desc}
              onChangeText={setDesc}
              maxLength={140}
              testID="sub-group-desc-input"
            />

            <Text style={styles.pickLabel}>Add members ({selected.size} selected)</Text>
            <FlatList
              style={styles.memberList}
              data={selectableMembers}
              keyExtractor={(m) => m.userId}
              ListEmptyComponent={<Text style={styles.empty}>No other members to add.</Text>}
              renderItem={({ item }) => {
                const on = selected.has(item.userId);
                return (
                  <TouchableOpacity
                    style={styles.pickRow}
                    onPress={() => toggle(item.userId)}
                    testID={`sub-group-pick-${item.userId}`}
                  >
                    <View style={styles.avatarSm}>
                      <Text style={styles.avatarText}>{getInitials(item.name)}</Text>
                    </View>
                    <Text style={styles.pickName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Ionicons
                      name={on ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={on ? Colors.primary : Colors.textSecondary}
                    />
                  </TouchableOpacity>
                );
              }}
            />

            <TouchableOpacity
              style={[styles.primaryBtn, busy && styles.btnDisabled]}
              onPress={submitCreate}
              disabled={busy}
              testID="sub-group-create-submit"
            >
              {busy ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {isMotherAdmin ? 'Create sub group' : 'Request sub group'}
                </Text>
              )}
            </TouchableOpacity>
            {!isMotherAdmin ? (
              <Text style={styles.hint}>A group admin will need to approve your sub group before it becomes active.</Text>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: Spacing.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, backgroundColor: Colors.surface },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
  },
  createBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 6, lineHeight: 18 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border || '#E5E7EB',
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, padding: 0 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  leadersBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: Spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderStyle: 'dashed',
  },
  leadersBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.semibold },
  empty: { fontSize: FontSize.base, color: Colors.textSecondary, marginTop: Spacing.sm, fontStyle: 'italic' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarSm: { width: 34, height: 34, borderRadius: 17, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  pendingAvatar: { backgroundColor: Colors.textSecondary },
  avatarText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  rowMid: { flex: 1, gap: 2 },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  subTag: { backgroundColor: Colors.textSecondary, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  subTagText: { fontSize: 9, fontWeight: '800', color: Colors.white, letterSpacing: 0.5 },
  rowName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary, flexShrink: 1 },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary },
  pendingActions: { flexDirection: 'row', gap: 8 },
  pendBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  approveBtn: { backgroundColor: Colors.success || '#22C55E' },
  rejectBtn: { backgroundColor: Colors.danger || '#E53935' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.lg,
    maxHeight: '85%',
    gap: Spacing.sm,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm },
  modalTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.border || '#E5E7EB',
  },
  pickLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary, marginTop: Spacing.sm },
  memberList: { maxHeight: 260, marginVertical: Spacing.sm },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 8 },
  pickName: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  primaryBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  primaryBtnText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  btnDisabled: { opacity: 0.6 },
});
