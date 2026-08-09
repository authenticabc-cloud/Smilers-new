import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { SubGroupAppearancePicker } from './SubGroupAppearancePicker';
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
  const removeMemberM = useMutation((api as any).conversations?.removeGroupMember);

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
  const [addInit, setAddInit] = useState(false);
  // Appearance (emoji/color) — synced via subGroups.create / conversations.updateGroup.
  const [emoji, setEmoji] = useState<string | undefined>(undefined);
  const [color, setColor] = useState<string | undefined>(undefined);

  // Existing members of the sub group being edited — used both to know who's
  // already in it (avoid re-adding) and to seed the membership toggles.
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

  // Seed the toggles with the current members once, when the sheet opens.
  useEffect(() => {
    if (addTarget && !addInit && Array.isArray(targetMembers)) {
      const seed = new Set<string>();
      motherMembers.forEach((m) => {
        if (m.userId !== myId && targetMemberIds.has(m.userId)) seed.add(m.userId);
      });
      setAddSelected(seed);
      setAddInit(true);
    }
  }, [addTarget, addInit, targetMembers, targetMemberIds, motherMembers, myId]);

  // All mother members (except me) are togglable — checked = in the sub group.
  const membershipMembers = useMemo(
    () => motherMembers.filter((m) => m.userId && m.userId !== myId),
    [motherMembers, myId],
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

  const closeAddSheet = useCallback(() => {
    setAddTarget(null);
    setAddInit(false);
    setAddSelected(new Set());
  }, []);

  const submitMembership = useCallback(async () => {
    if (!addTarget?.id) {
      closeAddSheet();
      return;
    }
    setAddBusy(true);
    let failed = 0;
    // Adds: selected but not currently a member.
    const toAdd = Array.from(addSelected).filter((uid) => !targetMemberIds.has(uid));
    // Removes: currently a member (and a togglable mother member) but unselected.
    const toRemove = membershipMembers
      .map((m) => m.userId)
      .filter((uid) => targetMemberIds.has(uid) && !addSelected.has(uid));
    for (const uid of toAdd) {
      try {
        if (addMemberM) await addMemberM({ subGroupId: addTarget.id, userId: uid });
      } catch {
        failed += 1;
      }
    }
    for (const uid of toRemove) {
      try {
        if (removeMemberM) await removeMemberM({ conversationId: addTarget.id, userId: uid });
      } catch {
        failed += 1;
      }
    }
    setAddBusy(false);
    closeAddSheet();
    if (failed > 0) {
      Alert.alert('Some changes failed', `${failed} member change${failed === 1 ? '' : 's'} could not be applied.`);
    }
  }, [addTarget?.id, addSelected, targetMemberIds, membershipMembers, addMemberM, removeMemberM, closeAddSheet]);

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
    setEmoji(undefined);
    setColor(undefined);
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
    setEmoji('👑');
    setColor('#F4B400');
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
        ...(emoji || color ? { appearance: { ...(emoji ? { emoji } : {}), ...(color ? { color } : {}) } } : {}),
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
  }, [name, desc, selected, emoji, color, createM, parentConversationId, resetCreate]);

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
          const appr = (item?.appearance || {}) as { emoji?: string; color?: string };
          return (
            <View key={id} style={styles.row} testID={`sub-group-row-${id}`}>
              <View
                style={[styles.avatar, pending && styles.pendingAvatar, appr.color ? { backgroundColor: appr.color } : null]}
              >
                {pending ? (
                  <Ionicons name="hourglass-outline" size={16} color={Colors.white} />
                ) : appr.emoji ? (
                  <Text style={styles.avatarEmoji}>{appr.emoji}</Text>
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
                        setAddInit(false);
                        setAddSelected(new Set());
                        setAddTarget({ id, name: item?.name || 'Sub group' });
                      }}
                      hitSlop={8}
                      testID={`sub-group-add-members-${id}`}
                    >
                      <Ionicons name="people-outline" size={20} color={Colors.primary} />
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

      {/* Manage members of a sub group (add + remove) */}
      <Modal visible={!!addTarget} animationType="slide" transparent onRequestClose={closeAddSheet}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle} numberOfLines={1}>
                Members · {addTarget?.name || 'sub group'}
              </Text>
              <TouchableOpacity onPress={closeAddSheet} hitSlop={8} testID="sub-group-add-close">
                <Ionicons name="close" size={24} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>
              Toggle members on to add them, off to remove them. Members always stay in the main group.
            </Text>
            <Text style={styles.pickLabel}>{addSelected.size} in this sub group</Text>
            <FlatList
              style={styles.memberList}
              data={membershipMembers}
              keyExtractor={(m) => m.userId}
              ListEmptyComponent={<Text style={styles.empty}>No other members in this group.</Text>}
              renderItem={({ item }) => {
                const on = addSelected.has(item.userId);
                const wasIn = targetMemberIds.has(item.userId);
                return (
                  <TouchableOpacity
                    style={styles.pickRow}
                    onPress={() => toggleAdd(item.userId)}
                    testID={`sub-group-add-pick-${item.userId}`}
                  >
                    <View style={styles.avatarSm}>
                      <Text style={styles.avatarText}>{getInitials(item.name)}</Text>
                    </View>
                    <View style={styles.pickNameWrap}>
                      <Text style={styles.pickName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      {wasIn && !on ? <Text style={styles.willRemove}>Will be removed</Text> : null}
                      {!wasIn && on ? <Text style={styles.willAdd}>Will be added</Text> : null}
                    </View>
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
              style={[styles.primaryBtn, addBusy && styles.btnDisabled]}
              onPress={submitMembership}
              disabled={addBusy}
              testID="sub-group-add-submit"
            >
              {addBusy ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryBtnText}>Save members</Text>}
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

            <SubGroupAppearancePicker emoji={emoji} color={color} onChangeEmoji={setEmoji} onChangeColor={setColor} />

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
  avatarEmoji: { fontSize: 20 },
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
  pickNameWrap: { flex: 1 },
  pickName: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  willRemove: { fontSize: FontSize.xs, color: Colors.danger, fontWeight: FontWeight.semibold },
  willAdd: { fontSize: FontSize.xs, color: Colors.success || '#22C55E', fontWeight: FontWeight.semibold },
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
