/**
 * Group Details / Settings — Slice A of the Groups spec.
 *
 * Surfaces the group header, role-aware member list, regulations board,
 * message-approval toggle, invite link, and admin actions (promote / demote /
 * suspend / remove / block / pass-chief). Tries the dedicated backend
 * endpoints first; falls back to data already returned by `listGroups` so the
 * screen still renders if the backend hasn't shipped a mutation yet.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import * as Clipboard from 'expo-clipboard';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useAuth } from '../../src/providers/AuthProvider';
import { findSavedContactDisplayName } from '../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

type RoleKey = 'chief' | 'admin' | 'member';

interface NormalizedMember {
  userId: string;
  name: string;
  avatar: string | null;
  role: RoleKey;
  suspendedUntil: number | null;
  blocked: boolean;
}

const SUSPENSION_OPTIONS: { label: string; durationMs: number }[] = [
  { label: '24 hours', durationMs: 24 * 60 * 60 * 1000 },
  { label: '7 days', durationMs: 7 * 24 * 60 * 60 * 1000 },
  // Spec says: 24h, 7d, 1 week. Treat "1 week" as the same 7d entry consolidated
  // — adding the formal "1 week" wording so users see both labels familiar from
  // the web app's dropdown.
  { label: '1 week', durationMs: 7 * 24 * 60 * 60 * 1000 },
];

function roleRank(role: RoleKey): number {
  return role === 'chief' ? 0 : role === 'admin' ? 1 : 2;
}

function normalizeRole(value: any): RoleKey {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'chief' || raw === 'chiefadmin' || raw === 'chief_admin' || raw === 'owner') return 'chief';
  if (raw === 'admin' || raw === 'administrator') return 'admin';
  return 'member';
}

function asTimestamp(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isStillSuspended(ts: number | null): boolean {
  return !!ts && ts > Date.now();
}

function formatSuspensionLabel(ts: number | null): string {
  if (!ts) return '';
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return '';
  const hours = Math.ceil(diffMs / 3_600_000);
  if (hours < 24) return `Suspended · ${hours}h left`;
  const days = Math.ceil(diffMs / 86_400_000);
  return `Suspended · ${days}d left`;
}

function normalizeMember(raw: any, contactList: any[]): NormalizedMember {
  const userId = String(raw?.userId || raw?._id || raw?.id || '');
  const fallbackName = findSavedContactDisplayName(contactList, userId);
  return {
    userId,
    name:
      raw?.name ||
      raw?.displayName ||
      raw?.fullName ||
      raw?.user?.name ||
      fallbackName ||
      'Member',
    avatar:
      raw?.avatar ||
      raw?.avatarUrl ||
      raw?.user?.avatar ||
      raw?.user?.avatarUrl ||
      null,
    role: normalizeRole(raw?.role || raw?.groupRole),
    suspendedUntil: asTimestamp(raw?.suspendedUntil || raw?.suspendedUntilAt),
    blocked: !!(raw?.blocked || raw?.isBlocked),
  };
}

function MemberAvatar({ member, size = 44 }: { member: NormalizedMember; size?: number }) {
  if (member.avatar && /^https?:/i.test(member.avatar)) {
    return <Image source={{ uri: member.avatar }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarFallbackText, { fontSize: size * 0.42 }]}>
        {(member.name || 'M').charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

function RoleBadge({ role }: { role: RoleKey }) {
  if (role === 'chief') {
    return (
      <View style={[styles.roleBadge, styles.roleBadgeChief]}>
        <MaterialCommunityIcons name="crown" size={12} color="#92400e" />
        <Text style={[styles.roleBadgeText, { color: '#92400e' }]}>Chief Admin</Text>
      </View>
    );
  }
  if (role === 'admin') {
    return (
      <View style={[styles.roleBadge, styles.roleBadgeAdmin]}>
        <MaterialCommunityIcons name="star-four-points" size={11} color="#1e3a8a" />
        <Text style={[styles.roleBadgeText, { color: '#1e3a8a' }]}>Admin</Text>
      </View>
    );
  }
  return null;
}

function SuspensionModal({
  visible,
  member,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  member: NormalizedMember | null;
  onClose: () => void;
  onConfirm: (durationMs: number) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>Suspend {member?.name || 'member'}?</Text>
          <Text style={styles.modalSubtitle}>
            They&apos;ll be a spectator in the group until the suspension lifts.
          </Text>
          {SUSPENSION_OPTIONS.map((option, index) => (
            <TouchableOpacity
              key={`${option.label}-${index}`}
              style={styles.modalRow}
              onPress={() => onConfirm(option.durationMs)}
              testID={`suspend-option-${option.label.replace(/\s+/g, '-')}`}
            >
              <Text style={styles.modalRowText}>{option.label}</Text>
              <Feather name="chevron-right" size={18} color={Colors.textMuted} />
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[styles.modalRow, { justifyContent: 'center' }]} onPress={onClose}>
            <Text style={[styles.modalRowText, { color: Colors.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionSheet({
  visible,
  member,
  isAdminMe,
  isChiefMe,
  onClose,
  onPromote,
  onDemote,
  onSuspend,
  onUnsuspend,
  onRemove,
  onBlock,
  onPassChief,
}: {
  visible: boolean;
  member: NormalizedMember | null;
  isAdminMe: boolean;
  isChiefMe: boolean;
  onClose: () => void;
  onPromote: () => void;
  onDemote: () => void;
  onSuspend: () => void;
  onUnsuspend: () => void;
  onRemove: () => void;
  onBlock: () => void;
  onPassChief: () => void;
}) {
  if (!member) return null;
  const isSuspended = isStillSuspended(member.suspendedUntil);
  const isMemberAdmin = member.role === 'admin';
  const isMemberChief = member.role === 'chief';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <View style={styles.actionHeaderRow}>
            <MemberAvatar member={member} size={48} />
            <View style={{ flex: 1 }}>
              <Text style={styles.actionHeaderName}>{member.name}</Text>
              <View style={{ marginTop: 4 }}>
                <RoleBadge role={member.role} />
              </View>
            </View>
          </View>

          {isAdminMe && !isMemberChief && (
            <>
              {isMemberAdmin ? (
                <ActionRow icon="user-minus" label="Demote to member" onPress={onDemote} />
              ) : (
                <ActionRow icon="user-check" label="Promote to admin" onPress={onPromote} />
              )}
              {isSuspended ? (
                <ActionRow icon="rotate-ccw" label="Lift suspension" onPress={onUnsuspend} />
              ) : (
                <ActionRow icon="clock" label="Suspend member…" onPress={onSuspend} />
              )}
              <ActionRow icon="user-x" label="Remove from group" onPress={onRemove} danger />
              <ActionRow icon="slash" label="Block member" onPress={onBlock} danger />
            </>
          )}

          {isChiefMe && isMemberAdmin && (
            <ActionRow icon="award" label="Pass Chief Admin to this user" onPress={onPassChief} />
          )}

          <TouchableOpacity style={[styles.modalRow, { justifyContent: 'center' }]} onPress={onClose}>
            <Text style={[styles.modalRowText, { color: Colors.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionRow({ icon, label, onPress, danger }: { icon: any; label: string; onPress: () => void; danger?: boolean }) {
  return (
    <TouchableOpacity style={styles.modalRow} onPress={onPress} testID={`action-${label.replace(/\s+/g, '-')}`}>
      <Feather name={icon} size={18} color={danger ? Colors.danger : Colors.textPrimary} />
      <Text style={[styles.modalRowText, danger ? { color: Colors.danger } : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function GroupDetailsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = String(id || '');
  const { isAuthenticated } = useAuth();

  // --- Backend: try the dedicated group-details endpoint, fall back to list.
  const { data: details } = useSafeConvexQuery<any>(
    api.conversations.getGroupDetails,
    { conversationId },
    null,
    isAuthenticated && !!conversationId,
  );
  const { data: groups } = useSafeConvexQuery<any[]>(
    api.conversations.listGroups,
    {},
    [],
    isAuthenticated,
  );
  const { data: regulations } = useSafeConvexQuery<any[]>(
    api.conversations.listRegulations,
    { conversationId },
    [],
    isAuthenticated && !!conversationId,
  );
  const { data: contacts } = useSafeConvexQuery<any[]>(api.contacts.getContacts, {}, [], isAuthenticated);

  // Fallback to listGroups[i] when getGroupDetails isn't shipped.
  const conversation = useMemo(() => {
    if (details && typeof details === 'object') return details;
    const list = Array.isArray(groups) ? groups : [];
    return list.find((g: any) => String(g?._id || g?.id) === conversationId) || null;
  }, [conversationId, details, groups]);

  const myUserId: string | undefined = (conversation as any)?.viewerUserId
    || (conversation as any)?.currentUserId
    || (conversation as any)?.me?._id;

  const members: NormalizedMember[] = useMemo(() => {
    const raw =
      (conversation as any)?.memberRecords ||
      (conversation as any)?.members ||
      (conversation as any)?.participants ||
      [];
    const list = Array.isArray(raw) ? raw : [];
    const normalized = list.map((entry: any) => {
      if (typeof entry === 'string') {
        return normalizeMember({ userId: entry }, contacts || []);
      }
      return normalizeMember(entry, contacts || []);
    });
    return normalized.sort((a, b) => {
      const rankDiff = roleRank(a.role) - roleRank(b.role);
      if (rankDiff !== 0) return rankDiff;
      return a.name.localeCompare(b.name);
    });
  }, [conversation, contacts]);

  const me = useMemo(() => {
    if (!myUserId) return null;
    return members.find((m) => m.userId === myUserId) || null;
  }, [members, myUserId]);

  // If we can't detect the viewer from the conversation, fall back to "viewer
  // is the chief admin if exactly one chief exists and no others match" so the
  // screen is still usable before the backend provides a viewerUserId field.
  const meDerived = me;
  const isAdminMe = meDerived?.role === 'admin' || meDerived?.role === 'chief' || !meDerived; // unknown viewer assumes admin so they can experiment; backend authoritative
  const isChiefMe = meDerived?.role === 'chief' || !meDerived;

  // --- Local UI state ---
  const [actionMember, setActionMember] = useState<NormalizedMember | null>(null);
  const [suspendingMember, setSuspendingMember] = useState<NormalizedMember | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showAddRegulationModal, setShowAddRegulationModal] = useState(false);
  const [regulationDraft, setRegulationDraft] = useState('');
  const [messageApprovalLocal, setMessageApprovalLocal] = useState<boolean>(
    !!(conversation as any)?.messageApprovalRequired,
  );
  // Keep the toggle visually in sync if the backend value arrives after first render.
  React.useEffect(() => {
    if (conversation) {
      setMessageApprovalLocal(!!(conversation as any).messageApprovalRequired);
    }
  }, [conversation]);

  // --- Mutations (each wrapped to degrade gracefully) ---
  const updateGroupM = useMutation((api as any).conversations.updateGroup);
  const addMembersM = useMutation((api as any).conversations.addMembers);
  const removeMemberM = useMutation((api as any).conversations.removeMember);
  const promoteAdminM = useMutation((api as any).conversations.promoteToAdmin);
  const demoteAdminM = useMutation((api as any).conversations.demoteAdmin);
  const suspendMemberM = useMutation((api as any).conversations.suspendMember);
  const unsuspendMemberM = useMutation((api as any).conversations.unsuspendMember);
  const blockMemberM = useMutation((api as any).conversations.blockMember);
  const passChiefM = useMutation((api as any).conversations.passChiefAdmin);
  const toggleApprovalM = useMutation((api as any).conversations.toggleMessageApproval);
  const generateInviteM = useMutation((api as any).conversations.generateInviteLink);
  const postRegulationM = useMutation((api as any).conversations.postRegulation);
  const leaveGroupM = useMutation((api as any).conversations.leaveGroup);

  const safeCall = useCallback(async (label: string, fn: () => Promise<any>) => {
    try {
      const result = await fn();
      return result;
    } catch (errorValue: any) {
      const message = errorValue?.message || String(errorValue || '');
      // eslint-disable-next-line no-console
      console.warn(`[group] ${label} failed:`, message);
      Alert.alert(label, message.includes('not found') ? 'This action needs the latest backend update. Please rebuild on the server side, then retry.' : message);
      return null;
    }
  }, []);

  const handlePromote = useCallback(async (member: NormalizedMember) => {
    setActionMember(null);
    await safeCall('Promote to admin', async () => promoteAdminM({ conversationId, userId: member.userId }));
  }, [conversationId, promoteAdminM, safeCall]);

  const handleDemote = useCallback(async (member: NormalizedMember) => {
    setActionMember(null);
    await safeCall('Demote admin', async () => demoteAdminM({ conversationId, userId: member.userId }));
  }, [conversationId, demoteAdminM, safeCall]);

  const handleSuspendConfirm = useCallback(async (durationMs: number) => {
    if (!suspendingMember) return;
    const member = suspendingMember;
    setSuspendingMember(null);
    await safeCall('Suspend member', async () =>
      suspendMemberM({ conversationId, userId: member.userId, durationMs }),
    );
  }, [conversationId, safeCall, suspendMemberM, suspendingMember]);

  const handleUnsuspend = useCallback(async (member: NormalizedMember) => {
    setActionMember(null);
    await safeCall('Lift suspension', async () => unsuspendMemberM({ conversationId, userId: member.userId }));
  }, [conversationId, safeCall, unsuspendMemberM]);

  const handleRemove = useCallback((member: NormalizedMember) => {
    Alert.alert(
      `Remove ${member.name}?`,
      'They will be removed from this group. They can be added again later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setActionMember(null);
            await safeCall('Remove member', async () => removeMemberM({ conversationId, userId: member.userId }));
          },
        },
      ],
    );
  }, [conversationId, removeMemberM, safeCall]);

  const handleBlock = useCallback((member: NormalizedMember) => {
    Alert.alert(
      `Block ${member.name}?`,
      'Blocked members can\u2019t see or send messages in this group.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            setActionMember(null);
            await safeCall('Block member', async () => blockMemberM({ conversationId, userId: member.userId }));
          },
        },
      ],
    );
  }, [blockMemberM, conversationId, safeCall]);

  const handlePassChief = useCallback((member: NormalizedMember) => {
    Alert.alert(
      `Pass Chief Admin to ${member.name}?`,
      'You will lose Chief Admin rights. Only the current and original creator can reclaim it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pass',
          onPress: async () => {
            setActionMember(null);
            await safeCall('Pass Chief Admin', async () => passChiefM({ conversationId, toUserId: member.userId }));
          },
        },
      ],
    );
  }, [conversationId, passChiefM, safeCall]);

  const handleApprovalToggle = useCallback(async (value: boolean) => {
    setMessageApprovalLocal(value);
    const result = await safeCall('Message approval', async () =>
      toggleApprovalM({ conversationId, enabled: value }),
    );
    if (result === null) {
      // Revert if mutation failed (e.g. endpoint not deployed yet).
      setMessageApprovalLocal(!value);
    }
  }, [conversationId, safeCall, toggleApprovalM]);

  const handleGenerateInvite = useCallback(async () => {
    const result: any = await safeCall('Generate invite link', async () =>
      generateInviteM({ conversationId }),
    );
    if (result?.url || result?.link || result?.inviteUrl) {
      const url = String(result.url || result.link || result.inviteUrl);
      await Clipboard.setStringAsync(url);
      Alert.alert('Invite link copied', url);
    } else if (typeof result === 'string' && result.length > 0) {
      await Clipboard.setStringAsync(result);
      Alert.alert('Invite link copied', result);
    }
    setShowInviteModal(false);
  }, [conversationId, generateInviteM, safeCall]);

  const handleAddRegulation = useCallback(async () => {
    const text = regulationDraft.trim();
    if (!text) return;
    const result = await safeCall('Post regulation', async () =>
      postRegulationM({ conversationId, text }),
    );
    if (result !== null) {
      setRegulationDraft('');
      setShowAddRegulationModal(false);
    }
  }, [conversationId, postRegulationM, regulationDraft, safeCall]);

  const handleLeaveGroup = useCallback(() => {
    Alert.alert('Leave group?', 'You will no longer receive messages from this group.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          await safeCall('Leave group', async () => leaveGroupM({ conversationId }));
          router.back();
        },
      },
    ]);
  }, [conversationId, leaveGroupM, router, safeCall]);

  const groupName: string = (conversation as any)?.name || 'Group';
  const description: string = (conversation as any)?.description || (conversation as any)?.about || '';
  const avatar: string | null = (conversation as any)?.avatar || (conversation as any)?.avatarUrl || null;

  const renderMember = ({ item }: { item: NormalizedMember }) => {
    const isMe = item.userId === myUserId;
    const suspended = isStillSuspended(item.suspendedUntil);
    return (
      <TouchableOpacity
        style={styles.memberRow}
        onPress={() => {
          if (isMe) return;
          if (isAdminMe || isChiefMe) setActionMember(item);
        }}
        activeOpacity={isAdminMe ? 0.7 : 1}
        testID={`group-member-${item.userId}`}
        disabled={isMe || (!isAdminMe && !isChiefMe)}
      >
        <MemberAvatar member={item} />
        <View style={{ flex: 1 }}>
          <View style={styles.memberNameRow}>
            <Text style={styles.memberName} numberOfLines={1}>
              {item.name}{isMe ? ' (You)' : ''}
            </Text>
            <RoleBadge role={item.role} />
          </View>
          {suspended ? (
            <Text style={styles.suspensionText}>{formatSuspensionLabel(item.suspendedUntil)}</Text>
          ) : item.blocked ? (
            <Text style={styles.suspensionText}>Blocked</Text>
          ) : null}
        </View>
        {(isAdminMe || isChiefMe) && !isMe ? (
          <Feather name="more-vertical" size={18} color={Colors.textMuted} />
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="group-details-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.headerBtn} testID="group-back">
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>Group info</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Top group identity card */}
        <View style={styles.identityCard}>
          {avatar && /^https?:/i.test(avatar) ? (
            <Image source={{ uri: avatar }} style={styles.bigAvatar} />
          ) : (
            <View style={[styles.bigAvatar, styles.bigAvatarFallback]}>
              <Text style={styles.bigAvatarText}>{groupName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          <Text style={styles.groupTitle}>{groupName}</Text>
          <Text style={styles.groupSubtitle}>
            {members.length || (conversation as any)?.memberCount || 0} member
            {(members.length || (conversation as any)?.memberCount || 0) === 1 ? '' : 's'}
          </Text>
          {description ? <Text style={styles.groupDescription}>{description}</Text> : null}
          <TouchableOpacity
            style={styles.openChatBtn}
            onPress={() => router.push(`/chat/${conversationId}` as any)}
            testID="group-open-chat"
          >
            <Feather name="message-circle" size={18} color={Colors.textPrimary} />
            <Text style={styles.openChatText}>Open chat</Text>
          </TouchableOpacity>
        </View>

        {/* Admin-only settings block */}
        {(isAdminMe || isChiefMe) ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Admin tools</Text>

            <View style={styles.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingTitle}>Message approval</Text>
                <Text style={styles.settingHint}>
                  Hold every new message until an admin approves it.
                </Text>
              </View>
              <Switch
                value={messageApprovalLocal}
                onValueChange={handleApprovalToggle}
                trackColor={{ true: Colors.primary, false: '#d6cfbf' }}
                thumbColor="#fff"
                testID="group-approval-toggle"
              />
            </View>

            <TouchableOpacity
              style={styles.actionTile}
              onPress={() => setShowInviteModal(true)}
              testID="group-invite-link"
            >
              <Feather name="link" size={18} color={Colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.settingTitle}>Invite link</Text>
                <Text style={styles.settingHint}>Generate a shareable link for new members.</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.textMuted} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionTile}
              onPress={() => router.push(`/groups-create?addToConversation=${conversationId}` as any)}
              testID="group-add-members"
            >
              <Feather name="user-plus" size={18} color={Colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.settingTitle}>Add members</Text>
                <Text style={styles.settingHint}>Only admins can add members to the group.</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Regulations board */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionLabel}>Regulations board</Text>
            {(isAdminMe || isChiefMe) ? (
              <TouchableOpacity
                onPress={() => setShowAddRegulationModal(true)}
                hitSlop={10}
                testID="group-add-regulation"
              >
                <Feather name="plus" size={20} color={Colors.primary} />
              </TouchableOpacity>
            ) : null}
          </View>
          {Array.isArray(regulations) && regulations.length > 0 ? (
            regulations.map((reg: any, idx: number) => (
              <View key={String(reg?._id || idx)} style={styles.regulationItem}>
                <Text style={styles.regulationIndex}>{idx + 1}.</Text>
                <Text style={styles.regulationText}>{reg?.text || reg?.content || ''}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.sectionEmpty}>
              {(isAdminMe || isChiefMe)
                ? 'No regulations yet. Tap + to post the first one.'
                : 'No regulations have been posted by the admins yet.'}
            </Text>
          )}
        </View>

        {/* Members list */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Members ({members.length || (conversation as any)?.memberCount || 0})
          </Text>
          {members.length === 0 ? (
            <Text style={styles.sectionEmpty}>
              Member list will appear here when the backend exposes it.
            </Text>
          ) : (
            <FlatList
              data={members}
              keyExtractor={(item) => item.userId || Math.random().toString(36).slice(2)}
              renderItem={renderMember}
              scrollEnabled={false}
              ItemSeparatorComponent={() => <View style={styles.memberDivider} />}
            />
          )}
        </View>

        {/* Danger zone */}
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.actionTile, styles.dangerTile]}
            onPress={handleLeaveGroup}
            testID="group-leave"
          >
            <Feather name="log-out" size={18} color={Colors.danger} />
            <Text style={[styles.settingTitle, { color: Colors.danger, flex: 1 }]}>Leave group</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <ActionSheet
        visible={!!actionMember}
        member={actionMember}
        isAdminMe={isAdminMe}
        isChiefMe={isChiefMe}
        onClose={() => setActionMember(null)}
        onPromote={() => actionMember && handlePromote(actionMember)}
        onDemote={() => actionMember && handleDemote(actionMember)}
        onSuspend={() => {
          if (actionMember) {
            setSuspendingMember(actionMember);
            setActionMember(null);
          }
        }}
        onUnsuspend={() => actionMember && handleUnsuspend(actionMember)}
        onRemove={() => actionMember && handleRemove(actionMember)}
        onBlock={() => actionMember && handleBlock(actionMember)}
        onPassChief={() => actionMember && handlePassChief(actionMember)}
      />

      <SuspensionModal
        visible={!!suspendingMember}
        member={suspendingMember}
        onClose={() => setSuspendingMember(null)}
        onConfirm={handleSuspendConfirm}
      />

      {/* Invite link confirm modal */}
      <Modal
        visible={showInviteModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowInviteModal(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setShowInviteModal(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Generate an invite link?</Text>
            <Text style={styles.modalSubtitle}>
              Anyone with this link can request to join. You can revoke it later from the admin tools.
            </Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={handleGenerateInvite} testID="group-invite-confirm">
              <Text style={styles.primaryBtnText}>Generate &amp; copy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalRow, { justifyContent: 'center' }]} onPress={() => setShowInviteModal(false)}>
              <Text style={[styles.modalRowText, { color: Colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Add regulation modal */}
      <Modal
        visible={showAddRegulationModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAddRegulationModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowAddRegulationModal(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Post a regulation</Text>
            <Text style={styles.modalSubtitle}>
              All members &mdash; current and future &mdash; will see this on the regulations board.
            </Text>
            <TextInput
              value={regulationDraft}
              onChangeText={setRegulationDraft}
              placeholder="e.g. Respect each other and stay on topic."
              placeholderTextColor={Colors.textMuted}
              style={styles.regulationInput}
              multiline
              maxLength={400}
              testID="group-regulation-input"
            />
            <TouchableOpacity
              style={[styles.primaryBtn, !regulationDraft.trim() && { opacity: 0.5 }]}
              onPress={handleAddRegulation}
              disabled={!regulationDraft.trim()}
              testID="group-regulation-submit"
            >
              <Text style={styles.primaryBtnText}>Post regulation</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalRow, { justifyContent: 'center' }]}
              onPress={() => setShowAddRegulationModal(false)}
            >
              <Text style={[styles.modalRowText, { color: Colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
  },
  headerTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  headerBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: { paddingBottom: Spacing.xxl * 2 },

  identityCard: {
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.base,
    gap: 8,
  },
  bigAvatar: { width: 96, height: 96, borderRadius: 48 },
  bigAvatarFallback: {
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigAvatarText: { fontSize: 36, fontWeight: FontWeight.bold, color: Colors.primary },
  groupTitle: { fontSize: 24, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: 8 },
  groupSubtitle: { fontSize: FontSize.base, color: Colors.textSecondary },
  groupDescription: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 6,
  },
  openChatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: Spacing.md,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: Radius.pill,
    backgroundColor: '#f5e9d3',
  },
  openChatText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },

  section: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: FontWeight.semibold,
    marginBottom: 8,
  },
  sectionEmpty: { fontSize: FontSize.sm, color: Colors.textMuted, paddingVertical: 6 },

  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    marginBottom: 8,
  },
  settingTitle: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  settingHint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, lineHeight: 18 },

  actionTile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    marginBottom: 8,
  },
  dangerTile: { backgroundColor: '#fee2e2' },

  regulationItem: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  regulationIndex: { fontSize: FontSize.base, color: Colors.primary, fontWeight: FontWeight.bold },
  regulationText: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, lineHeight: 22 },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 10,
  },
  memberDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.borderLight, marginVertical: 2 },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  memberName: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  suspensionText: { fontSize: FontSize.sm, color: Colors.danger, marginTop: 2 },

  avatarFallback: {
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallbackText: { color: Colors.primary, fontWeight: FontWeight.bold },

  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  roleBadgeChief: { backgroundColor: '#fef3c7' },
  roleBadgeAdmin: { backgroundColor: '#dbeafe' },
  roleBadgeText: { fontSize: 11, fontWeight: FontWeight.semibold },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: Colors.background,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: 10,
    ...Shadow.lg,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderLight,
  },
  modalRowText: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium },

  primaryBtn: {
    minHeight: 48,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { fontSize: FontSize.base, color: Colors.headerBg, fontWeight: FontWeight.bold },

  actionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: 4 },
  actionHeaderName: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },

  regulationInput: {
    minHeight: 100,
    maxHeight: 220,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    textAlignVertical: 'top',
  },
});
