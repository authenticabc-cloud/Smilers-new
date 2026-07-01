/**
 * /group/[id]  ▸  Group Info hub (iter-151)
 *
 * Aligned to the canonical Convex contract (`/app/GROUPS_CANONICAL_CONTRACT_iter151.md`).
 * Uses ONLY documented endpoints — no path-guessing.
 *
 * Reads:
 *   - api.conversations.getConversation
 *   - api.conversations.getGroupMembers
 *   - api.groupAdmin.getGroupAdminInfo
 *   - api.groupSuspensions.getGroupSuspensions
 *
 * Writes:
 *   - api.conversations.updateGroup / addGroupMember / removeGroupMember
 *   - api.conversations.leaveGroup / deleteGroup
 *   - api.groupAdmin.promoteToAdmin / demoteFromAdmin / transferChiefAdmin
 *   - api.groupAdmin.generateInviteLink / disableInviteLink
 *   - api.messageApproval.toggleApproval
 *   - api.groupSuspensions.suspendMember / liftSuspension
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import * as Clipboard from 'expo-clipboard';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import ScreenErrorBoundary from '../../src/components/ScreenErrorBoundary';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

type SuspendDuration = '1h' | '6h' | '24h' | '7d' | '30d' | 'permanent';

const DURATION_OPTIONS: { key: SuspendDuration; label: string }[] = [
  { key: '1h', label: '1 Hour' },
  { key: '6h', label: '6 Hours' },
  { key: '24h', label: '24 Hours' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: 'permanent', label: 'Permanent' },
];

function getInitials(name?: string): string {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function extractConvexError(e: any): string {
  const code = e?.data?.code || e?.code || '';
  const message = e?.data?.message || e?.message || 'Unknown error';
  return code ? `${code}: ${String(message).slice(0, 200)}` : String(message).slice(0, 240);
}

export default function GroupInfoScreen() {
  const router = useRouter();
  return (
    <ScreenErrorBoundary screenName="group-info" onClose={() => router.back()}>
      <GroupInfoInner />
    </ScreenErrorBoundary>
  );
}

function GroupInfoInner() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id;

  // -------- Reads --------
  const { data: conversation } = useSafeConvexQuery<any | null>(
    api.conversations.getConversation,
    conversationId ? { conversationId } : {},
    null,
    !!conversationId,
  );
  const { data: members, refetch: refetchMembers } = useSafeConvexQuery<any[]>(
    api.conversations.getGroupMembers,
    conversationId ? { conversationId } : {},
    [],
    !!conversationId,
  );
  const { data: adminInfo, refetch: refetchAdmin } = useSafeConvexQuery<any | null>(
    (api as any).groupAdmin?.getGroupAdminInfo,
    conversationId ? { conversationId } : {},
    null,
    !!conversationId,
  );
  const { data: suspensions } = useSafeConvexQuery<any[]>(
    (api as any).groupSuspensions?.getGroupSuspensions,
    conversationId ? { conversationId } : {},
    [],
    !!conversationId,
  );

  // -------- Mutations --------
  const updateGroupM = useMutation((api as any).conversations?.updateGroup);
  const addGroupMemberM = useMutation((api as any).conversations?.addGroupMember);
  const removeGroupMemberM = useMutation((api as any).conversations?.removeGroupMember);
  const leaveGroupM = useMutation((api as any).conversations?.leaveGroup);
  const deleteGroupM = useMutation((api as any).conversations?.deleteGroup);
  const promoteAdminM = useMutation((api as any).groupAdmin?.promoteToAdmin);
  const demoteAdminM = useMutation((api as any).groupAdmin?.demoteFromAdmin);
  const transferChiefM = useMutation((api as any).groupAdmin?.transferChiefAdmin);
  const generateInviteM = useMutation((api as any).groupAdmin?.generateInviteLink);
  const disableInviteM = useMutation((api as any).groupAdmin?.disableInviteLink);
  const toggleApprovalM = useMutation((api as any).messageApproval?.toggleApproval);
  const suspendMemberM = useMutation((api as any).groupSuspensions?.suspendMember);
  const liftSuspensionM = useMutation((api as any).groupSuspensions?.liftSuspension);

  // -------- Derived --------
  const isAdmin = !!adminInfo?.isAdmin;
  const isChief = !!adminInfo?.isChiefAdmin;
  const myId = adminInfo?.myId ? String(adminInfo.myId) : null;
  const adminIds = useMemo(
    () => new Set<string>((adminInfo?.admins || []).map((a: any) => String(a))),
    [adminInfo],
  );
  const chiefAdminId = adminInfo?.chiefAdmin ? String(adminInfo.chiefAdmin) : null;
  const memberCount = adminInfo?.memberCount ?? (Array.isArray(members) ? members.length : 0);

  // iter-311: Add Members picker (replaces the old "Picker coming next" stub).
  const { data: myContacts } = useSafeConvexQuery<any[]>(
    api.contacts.getContacts,
    {},
    [],
    !!conversationId,
  );
  const memberIdSet = useMemo(
    () =>
      new Set<string>(
        (Array.isArray(members) ? members : []).map((m: any) =>
          String(m?.userId || m?._id || m?.user?._id || ''),
        ),
      ),
    [members],
  );
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [selectedAdd, setSelectedAdd] = useState<Set<string>>(new Set());
  const addableContacts = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    return (Array.isArray(myContacts) ? myContacts : []).filter((c: any) => {
      const uid = String(c?.userId || c?.user?._id || c?._id || '');
      if (!uid || memberIdSet.has(uid)) return false;
      if (!q) return true;
      return `${c?.name || ''} ${c?.phone || ''} ${c?.email || ''}`.toLowerCase().includes(q);
    });
  }, [myContacts, memberIdSet, addSearch]);

  const toggleAddSelect = useCallback((userId: string) => {
    setSelectedAdd((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const openAddMembers = useCallback(() => {
    setAddSearch('');
    setSelectedAdd(new Set());
    setAddMembersOpen(true);
  }, []);

  const confirmAddMembers = useCallback(async () => {
    if (!conversationId || selectedAdd.size === 0 || !addGroupMemberM) {
      setAddMembersOpen(false);
      return;
    }
    setBusy('addMembers');
    let added = 0;
    let failed = 0;
    for (const userId of Array.from(selectedAdd)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await addGroupMemberM({ conversationId, userId });
        added += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(null);
    setAddMembersOpen(false);
    setSelectedAdd(new Set());
    void refetchMembers?.();
    void refetchAdmin?.();
    if (failed > 0) {
      Alert.alert(
        'Some members not added',
        `${added} added, ${failed} could not be added. They may already be in the group or an admin restriction applies.`,
      );
    }
  }, [conversationId, selectedAdd, addGroupMemberM, refetchMembers, refetchAdmin]);

  const currentAdminCount = adminInfo?.currentAdminCount ?? 1;
  const maxAdmins = adminInfo?.maxAdmins ?? Math.max(1, Math.floor(memberCount * 0.2));
  const messageApprovalEnabled = !!adminInfo?.messageApprovalEnabled;
  const inviteLinkEnabled = !!adminInfo?.inviteLinkEnabled;
  const inviteCode: string | null = adminInfo?.inviteCode || null;

  const groupName = conversation?.name || 'Group';

  // Build sorted members list: Me first, then chief, then admins, then rest by name
  const sortedMembers = useMemo(() => {
    const list = Array.isArray(members) ? [...members] : [];
    return list.sort((a, b) => {
      const aId = String(a._id || a.userId);
      const bId = String(b._id || b.userId);
      if (myId && aId === myId) return -1;
      if (myId && bId === myId) return 1;
      if (chiefAdminId && aId === chiefAdminId) return -1;
      if (chiefAdminId && bId === chiefAdminId) return 1;
      const aA = adminIds.has(aId), bA = adminIds.has(bId);
      if (aA && !bA) return -1;
      if (!aA && bA) return 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [members, myId, chiefAdminId, adminIds]);

  const suspendedMap = useMemo(() => {
    const map = new Map<string, any>();
    (Array.isArray(suspensions) ? suspensions : []).forEach((s: any) => {
      if (s?.userId) map.set(String(s.userId), s);
    });
    return map;
  }, [suspensions]);

  // -------- Modal state --------
  const [editNameOpen, setEditNameOpen] = useState(false);
  const [draftName, setDraftName] = useState(groupName);
  const [draftDesc, setDraftDesc] = useState(conversation?.description || '');
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<any | null>(null);
  const [suspendDuration, setSuspendDuration] = useState<SuspendDuration>('24h');
  const [suspendReason, setSuspendReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // -------- Handlers --------
  const callMutation = useCallback(async (label: string, fn: any, args: any) => {
    if (typeof fn !== 'function') {
      Alert.alert(`Server missing ${label}`, 'Please try after the next deployment.');
      return false;
    }
    setBusy(label);
    try {
      await fn(args);
      return true;
    } catch (e: any) {
      Alert.alert(`${label} failed`, extractConvexError(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const onSaveName = async () => {
    if (!conversationId) return;
    const name = draftName.trim();
    if (!name) return Alert.alert('Name required', 'Group name cannot be empty.');
    const ok = await callMutation('updateGroup', updateGroupM, {
      conversationId,
      name,
      description: draftDesc.trim() || undefined,
    });
    if (ok) {
      setEditNameOpen(false);
      void refetchAdmin();
    }
  };

  const onToggleApproval = async (next: boolean) => {
    if (!conversationId) return;
    const ok = await callMutation('toggleApproval', toggleApprovalM, { conversationId, enabled: next });
    if (ok) void refetchAdmin();
  };

  const onGenerateInvite = async () => {
    if (!conversationId) return;
    const ok = await callMutation('generateInviteLink', generateInviteM, { conversationId });
    if (ok) void refetchAdmin();
  };

  const onDisableInvite = async () => {
    if (!conversationId) return;
    const ok = await callMutation('disableInviteLink', disableInviteM, { conversationId });
    if (ok) {
      setInviteModalOpen(false);
      void refetchAdmin();
    }
  };

  const onShareInvite = async () => {
    if (!inviteCode) return;
    const url = `https://smilers.online/join/${inviteCode}`;
    try {
      await Share.share({
        message: `Join my group "${groupName}" on Smilers: ${url}`,
        url,
        title: groupName,
      } as any);
    } catch {}
  };

  const onCopyInvite = async () => {
    if (!inviteCode) return;
    try {
      await Clipboard.setStringAsync(`https://smilers.online/join/${inviteCode}`);
      Alert.alert('Copied', 'Invite link copied to clipboard.');
    } catch {}
  };

  const onPromote = async (userId: string) => {
    if (!conversationId) return;
    if (currentAdminCount >= maxAdmins) {
      return Alert.alert('Admin cap reached', `This group allows at most ${maxAdmins} admin(s) (20% of ${memberCount} members).`);
    }
    const ok = await callMutation('promoteToAdmin', promoteAdminM, { conversationId, userId });
    if (ok) void refetchAdmin();
  };

  const onDemote = async (userId: string) => {
    if (!conversationId) return;
    const ok = await callMutation('demoteFromAdmin', demoteAdminM, { conversationId, userId });
    if (ok) void refetchAdmin();
  };

  const onTransferChief = async (newChiefAdminId: string) => {
    if (!conversationId) return;
    const ok = await callMutation('transferChiefAdmin', transferChiefM, { conversationId, newChiefAdminId });
    if (ok) {
      setTransferModalOpen(false);
      void refetchAdmin();
    }
  };

  const onSuspendConfirm = async () => {
    if (!conversationId || !suspendTarget) return;
    const ok = await callMutation('suspendMember', suspendMemberM, {
      conversationId,
      userId: suspendTarget.userId || suspendTarget._id,
      duration: suspendDuration,
      reason: suspendReason.trim() || undefined,
    });
    if (ok) {
      setSuspendTarget(null);
      setSuspendReason('');
      setSuspendDuration('24h');
    }
  };

  const onLiftSuspension = async (userId: string) => {
    if (!conversationId) return;
    await callMutation('liftSuspension', liftSuspensionM, { conversationId, userId });
  };

  const onRemoveMember = (userId: string, name: string) => {
    if (!conversationId) return;
    Alert.alert('Remove from group?', `${name} will be removed from this group.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => callMutation('removeGroupMember', removeGroupMemberM, { conversationId, userId }),
      },
    ]);
  };

  const onLeave = () => {
    if (!conversationId) return;
    Alert.alert('Leave group?', `You will no longer receive messages from "${groupName}".`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          const ok = await callMutation('leaveGroup', leaveGroupM, { conversationId });
          if (ok) router.back();
        },
      },
    ]);
  };

  const onDelete = () => {
    if (!conversationId) return;
    Alert.alert(
      'Delete group permanently?',
      'All messages, regulations, and members will be removed. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const ok = await callMutation('deleteGroup', deleteGroupM, { conversationId });
            if (ok) router.replace('/(tabs)/groups' as any);
          },
        },
      ],
    );
  };

  // -------- Render --------
  if (!conversationId) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <Text style={styles.errText}>Missing group id.</Text>
      </SafeAreaView>
    );
  }

  const eligibleTransferAdmins = sortedMembers.filter((m: any) => {
    const mid = String(m._id || m.userId);
    return adminIds.has(mid) && mid !== myId;
  });

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="group-info-screen">
      <View style={styles.header} testID="group-info-header">
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="group-info-back">
          <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Group Info</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* Identity */}
        <View style={styles.identityWrap}>
          <View style={styles.bigAvatar}>
            <Feather name="users" size={42} color={Colors.primary} />
          </View>
          <TouchableOpacity
            style={styles.nameRow}
            disabled={!isAdmin}
            onPress={() => {
              setDraftName(groupName);
              setDraftDesc(conversation?.description || '');
              setEditNameOpen(true);
            }}
            testID="group-info-edit-name"
          >
            <Text style={styles.groupName}>{groupName}</Text>
            {isAdmin ? <Feather name="edit-2" size={16} color={Colors.textSecondary} /> : null}
          </TouchableOpacity>
          <Text style={styles.memberCountLine}>{memberCount} members</Text>
          <Text style={styles.adminCapLine}>
            Admins: {currentAdminCount}/{maxAdmins} (20% cap)
          </Text>
        </View>

        {/* ADMIN ACTIONS (only if admin) */}
        {isAdmin ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>ADMIN ACTIONS</Text>

            <ActionRow
              icon="link"
              label="Invite Link"
              trailing={inviteLinkEnabled && inviteCode ? 'Enabled' : 'Disabled'}
              onPress={() => setInviteModalOpen(true)}
              testID="group-info-invite"
            />
            <ActionRow
              icon="user-plus"
              label="Add Members"
              onPress={openAddMembers}
              testID="group-info-add-members"
            />
            <ToggleRow
              icon="check-circle"
              label="Message Approval"
              value={messageApprovalEnabled}
              onValueChange={onToggleApproval}
              disabled={busy === 'toggleApproval'}
              testID="group-info-approval"
            />
            {messageApprovalEnabled ? (
              <ActionRow
                icon="inbox"
                label="Pending Messages"
                onPress={() => router.push(`/group/${conversationId}/pending` as any)}
                testID="group-info-pending"
              />
            ) : null}
            <ActionRow
              icon="phone-call"
              label="Group voice call"
              onPress={() => router.push(`/group-call/${conversationId}` as any)}
              testID="group-info-voice-call"
            />
            <ActionRow
              icon="file-text"
              label="Regulations Board"
              onPress={() => router.push(`/group/${conversationId}/regulations` as any)}
              testID="group-info-regulations"
            />
            {isChief ? (
              <ActionRow
                icon="award"
                label="Transfer Chief Admin"
                onPress={() => setTransferModalOpen(true)}
                testID="group-info-transfer"
              />
            ) : null}
          </View>
        ) : null}

        {/* MEMBERS */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>MEMBERS ({memberCount})</Text>
          {sortedMembers.map((m: any) => {
            const mid = String(m._id || m.userId);
            const isMe = mid === myId;
            const isChiefMember = mid === chiefAdminId;
            const isAdminMember = adminIds.has(mid);
            const suspension = suspendedMap.get(mid);
            return (
              <View key={mid} style={styles.memberRow} testID={`group-member-${mid}`}>
                <View style={styles.memberAvatar}>
                  {m?.avatarUrl ? (
                    <Image source={{ uri: m.avatarUrl }} style={styles.memberAvatarImg} />
                  ) : (
                    <Text style={styles.memberAvatarText}>{getInitials(m?.name)}</Text>
                  )}
                </View>
                <View style={styles.memberBody}>
                  <View style={styles.memberNameLine}>
                    {isChiefMember ? <Text style={styles.crown}>👑 </Text> : null}
                    <Text style={styles.memberName} numberOfLines={1}>
                      {isMe ? 'You' : m?.name || 'Unnamed'}
                    </Text>
                    {isChiefMember ? (
                      <View style={styles.chiefBadge}>
                        <Text style={styles.chiefBadgeText}>Chief Admin</Text>
                      </View>
                    ) : isAdminMember ? (
                      <View style={styles.adminBadge}>
                        <Text style={styles.adminBadgeText}>Admin</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.memberBio} numberOfLines={1}>
                    {suspension
                      ? `🚫 Suspended${suspension.duration ? ` · ${suspension.duration}` : ''}`
                      : m?.bio || m?.statusMessage || 'Hey there! I am using Smilers.'}
                  </Text>
                </View>
                {isAdmin && !isMe && !isChiefMember ? (
                  <View style={styles.memberActions}>
                    {/* Promote / Demote (chief only for demote) */}
                    {isAdminMember ? (
                      isChief ? (
                        <TouchableOpacity
                          style={styles.iconBtn}
                          onPress={() => onDemote(mid)}
                          testID={`group-member-demote-${mid}`}
                        >
                          <Feather name="arrow-down-circle" size={20} color={Colors.textSecondary} />
                        </TouchableOpacity>
                      ) : null
                    ) : (
                      <TouchableOpacity
                        style={styles.iconBtn}
                        onPress={() => onPromote(mid)}
                        testID={`group-member-promote-${mid}`}
                      >
                        <Feather name="arrow-up-circle" size={20} color={Colors.primary} />
                      </TouchableOpacity>
                    )}
                    {suspension ? (
                      <TouchableOpacity
                        style={styles.iconBtn}
                        onPress={() => onLiftSuspension(mid)}
                        testID={`group-member-lift-${mid}`}
                      >
                        <Feather name="refresh-cw" size={20} color="#22A06B" />
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        style={styles.iconBtn}
                        onPress={() => setSuspendTarget(m)}
                        testID={`group-member-suspend-${mid}`}
                      >
                        <Feather name="slash" size={20} color="#D67200" />
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={styles.iconBtn}
                      onPress={() => onRemoveMember(mid, m?.name || 'this member')}
                      testID={`group-member-remove-${mid}`}
                    >
                      <Feather name="user-minus" size={20} color="#D63030" />
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>

        {/* Footer actions */}
        <View style={styles.footerActions}>
          <TouchableOpacity style={styles.leaveBtn} onPress={onLeave} testID="group-info-leave">
            <Feather name="log-out" size={18} color="#D63030" />
            <Text style={styles.leaveBtnText}>Leave Group</Text>
          </TouchableOpacity>
          {isChief ? (
            <TouchableOpacity style={styles.deleteBtn} onPress={onDelete} testID="group-info-delete">
              <Feather name="trash-2" size={18} color={Colors.white} />
              <Text style={styles.deleteBtnText}>Delete Group Permanently</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>

      {/* ----- Edit Name Modal ----- */}
      <Modal visible={editNameOpen} transparent animationType="slide" onRequestClose={() => setEditNameOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setEditNameOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Edit Group</Text>
            <Text style={styles.modalLabel}>Name</Text>
            <TextInput
              value={draftName}
              onChangeText={setDraftName}
              style={styles.modalInput}
              maxLength={64}
              testID="group-info-edit-name-input"
            />
            <Text style={styles.modalLabel}>Description</Text>
            <TextInput
              value={draftDesc}
              onChangeText={setDraftDesc}
              style={[styles.modalInput, { minHeight: 70, textAlignVertical: 'top' }]}
              multiline
              maxLength={280}
              testID="group-info-edit-desc-input"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setEditNameOpen(false)} style={styles.modalCancel}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onSaveName} style={styles.modalSave} testID="group-info-edit-save">
                <Text style={styles.modalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ----- Invite Link Modal ----- */}
      <Modal visible={inviteModalOpen} transparent animationType="slide" onRequestClose={() => setInviteModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setInviteModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>🔗 Invite Link</Text>
            {inviteLinkEnabled && inviteCode ? (
              <>
                <Text style={styles.modalBody}>Share this link with anyone you want to add.</Text>
                <View style={styles.linkBox}>
                  <Text style={styles.linkBoxText} numberOfLines={1}>
                    https://smilers.online/join/{inviteCode}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
                  <TouchableOpacity style={styles.modalActionBtn} onPress={onCopyInvite} testID="group-info-invite-copy">
                    <Feather name="copy" size={16} color={Colors.textPrimary} />
                    <Text style={styles.modalActionText}>Copy</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalActionBtn} onPress={onShareInvite} testID="group-info-invite-share">
                    <Feather name="share-2" size={16} color={Colors.textPrimary} />
                    <Text style={styles.modalActionText}>Share</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  style={[styles.modalSave, { backgroundColor: '#D63030' }]}
                  onPress={onDisableInvite}
                  testID="group-info-invite-disable"
                >
                  <Text style={styles.modalSaveText}>Disable Invite Link</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.modalBody}>Only admins can generate and share invite links.</Text>
                <TouchableOpacity style={styles.modalSave} onPress={onGenerateInvite} testID="group-info-invite-generate">
                  <Text style={styles.modalSaveText}>Generate Invite Link</Text>
                </TouchableOpacity>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ----- Transfer Chief Modal ----- */}
      <Modal visible={transferModalOpen} transparent animationType="slide" onRequestClose={() => setTransferModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setTransferModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>👑 Transfer Chief Admin</Text>
            <Text style={styles.modalBody}>You can transfer Chief Admin to any admin in the group.</Text>
            {eligibleTransferAdmins.length === 0 ? (
              <View style={styles.emptyModal}>
                <Text style={styles.emptyModalTitle}>No eligible admins</Text>
                <Text style={styles.emptyModalBody}>Promote someone to admin first.</Text>
              </View>
            ) : (
              <FlatList
                data={eligibleTransferAdmins}
                keyExtractor={(m: any) => String(m._id || m.userId)}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.transferRow}
                    onPress={() =>
                      Alert.alert('Transfer Chief Admin?', `${item?.name || 'this admin'} will become the new Chief Admin.`, [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Transfer',
                          style: 'destructive',
                          onPress: () => onTransferChief(String(item._id || item.userId)),
                        },
                      ])
                    }
                    testID={`group-info-transfer-${String(item._id || item.userId)}`}
                  >
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>{getInitials(item?.name)}</Text>
                    </View>
                    <Text style={styles.transferName}>{item?.name || 'Admin'}</Text>
                    <Feather name="chevron-right" size={18} color={Colors.textMuted} />
                  </TouchableOpacity>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ----- Suspend Member Modal ----- */}
      <Modal visible={!!suspendTarget} transparent animationType="slide" onRequestClose={() => setSuspendTarget(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSuspendTarget(null)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>🚫 Suspend Member</Text>
            <Text style={styles.modalBody}>
              Suspended members enter spectator mode — they can read messages but cannot send.
            </Text>
            <Text style={styles.modalLabel}>Duration</Text>
            <View style={styles.durationGrid}>
              {DURATION_OPTIONS.map((opt) => {
                const active = suspendDuration === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[styles.durationCell, active && styles.durationCellActive]}
                    onPress={() => setSuspendDuration(opt.key)}
                    testID={`group-info-suspend-${opt.key}`}
                  >
                    <Text style={[styles.durationText, active && styles.durationTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.modalLabel}>Reason (optional)</Text>
            <TextInput
              value={suspendReason}
              onChangeText={setSuspendReason}
              placeholder="Why is this member being suspended?"
              placeholderTextColor={Colors.textMuted}
              style={[styles.modalInput, { minHeight: 60, textAlignVertical: 'top' }]}
              multiline
              maxLength={200}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setSuspendTarget(null)} style={styles.modalCancel}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onSuspendConfirm}
                style={[styles.modalSave, { backgroundColor: '#D63030' }]}
                testID="group-info-suspend-confirm"
              >
                <Text style={styles.modalSaveText}>Suspend</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {busy ? (
        <View pointerEvents="none" style={styles.busyOverlay}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function ActionRow({
  icon,
  label,
  trailing,
  onPress,
  testID,
}: {
  icon: any;
  label: string;
  trailing?: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity style={styles.actionRow} onPress={onPress} testID={testID} activeOpacity={0.7}>
      <Feather name={icon} size={20} color={Colors.primary} />
      <Text style={styles.actionLabel}>{label}</Text>
      {trailing ? <Text style={styles.actionTrailing}>{trailing}</Text> : null}
      <Feather name="chevron-right" size={18} color={Colors.textMuted} />
    </TouchableOpacity>
  );
}

function ToggleRow({
  icon,
  label,
  value,
  onValueChange,
  disabled,
  testID,
}: {
  icon: any;
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.actionRow} testID={testID}>
      <Feather name={icon} size={20} color={Colors.primary} />
      <Text style={[styles.actionLabel, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  errText: { padding: 24, color: Colors.textPrimary },
  header: {
    height: Platform.select({ ios: 100, default: 88 }),
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.md,
  },
  headerTitle: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  body: { paddingBottom: 80 },
  identityWrap: { alignItems: 'center', paddingVertical: Spacing.lg, gap: 6 },
  bigAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: Spacing.md },
  groupName: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  memberCountLine: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  adminCapLine: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },
  section: { marginTop: Spacing.lg, backgroundColor: Colors.surface, paddingVertical: Spacing.sm },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.2,
    color: Colors.textSecondary,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  actionLabel: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  actionTrailing: { fontSize: FontSize.sm, color: Colors.textSecondary, marginRight: 4 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    gap: Spacing.md,
  },
  memberAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarImg: { width: 44, height: 44, borderRadius: 22 },
  memberAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: 16 },
  memberBody: { flex: 1 },
  memberNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  crown: { fontSize: 14 },
  memberName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  chiefBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(229,156,26,0.18)',
  },
  chiefBadgeText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: FontWeight.bold },
  adminBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(50,120,200,0.15)',
  },
  adminBadgeText: { fontSize: FontSize.xs, color: '#3278C8', fontWeight: FontWeight.bold },
  memberBio: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  memberActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },

  footerActions: { padding: Spacing.base, gap: Spacing.md, marginTop: Spacing.lg },
  leaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderColor: '#D63030',
    backgroundColor: 'rgba(214,48,48,0.08)',
  },
  leaveBtnText: { fontSize: FontSize.base, color: '#D63030', fontWeight: FontWeight.semibold },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 54,
    borderRadius: Radius.md,
    backgroundColor: '#D63030',
  },
  deleteBtnText: { fontSize: FontSize.base, color: Colors.white, fontWeight: FontWeight.bold },

  // Modals
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: Spacing.lg,
    maxHeight: '90%',
    gap: Spacing.md,
  },
  modalTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalBody: { fontSize: FontSize.base, color: Colors.textSecondary, lineHeight: 20 },
  modalLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary, marginTop: 4 },
  modalInput: {
    minHeight: 46,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    borderRadius: Radius.md,
    backgroundColor: Colors.surfaceMuted || Colors.surface,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  modalActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  modalCancel: { flex: 1, height: 48, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  modalCancelText: { fontSize: FontSize.base, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  modalSave: {
    flex: 1,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSaveText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.bold },
  modalActionBtn: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    height: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryLight,
  },
  modalActionText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  linkBox: {
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  linkBoxText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) as any },
  emptyModal: { alignItems: 'center', gap: 6, paddingVertical: Spacing.lg },
  emptyModalTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  emptyModalBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  transferRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  transferName: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  durationGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  durationCell: {
    flexBasis: '31%',
    flexGrow: 1,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    alignItems: 'center',
  },
  durationCellActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  durationText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  durationTextActive: { color: Colors.textPrimary, fontWeight: FontWeight.bold },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
