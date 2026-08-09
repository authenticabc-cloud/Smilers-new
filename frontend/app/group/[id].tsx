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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import ScreenErrorBoundary from '../../src/components/ScreenErrorBoundary';
import { SubGroupsSection } from '../../src/components/SubGroupsSection';
import { SubGroupPositionModal } from '../../src/components/SubGroupPositionModal';
import { BulkPositionsModal, type BulkPositionMember } from '../../src/components/BulkPositionsModal';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../src/lib/deviceContactIndex';
import { getResolvedDisplayName, getSavedContactRecord } from '../../src/lib/displayName';

/** Resolve the registered Smilers user id for a contact row, mirroring groups-create. */
function getContactUserId(item: any): string | null {
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
  const insets = useSafeAreaInsets();
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
  // Reactive count of messages awaiting approval — drives the red badge on the
  // "Pending Messages" row. Returns 0 for non-admins (server-enforced).
  const { data: pendingCount } = useSafeConvexQuery<number>(
    (api as any).messageApproval?.getPendingCount,
    conversationId ? { conversationId } : {},
    0,
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
  const deviceIndex = useDeviceContactIndex();
  const displayNameForContact = useCallback(
    (obj: any): string =>
      getResolvedDisplayName(
        obj,
        deviceIndex,
        lookupDeviceContactName,
        obj?.name || obj?.displayName || obj?.email || obj?.phone || 'Contact',
      ),
    [deviceIndex],
  );
  // iter-317: group members from getGroupMembers carry only the Smilers/Google
  // account name (no phone), so they showed "Abednego Obeng Asare" instead of
  // the viewer's saved contact "Kojo". Enrich each member with the full contact
  // record from `getContacts` (which has phone/phoneE164) by matching userId,
  // then resolve the device-saved name — same fix used for voice tasks.
  const displayNameForMember = useCallback(
    (m: any): string => {
      const uid = String(m?.userId || m?._id || m?.user?._id || '');
      const full = getSavedContactRecord(myContacts, { userId: uid }) || m;
      return getResolvedDisplayName(
        full,
        deviceIndex,
        lookupDeviceContactName,
        m?.name || m?.displayName || 'Unnamed',
      );
    },
    [deviceIndex, myContacts],
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
      const uid = getContactUserId(c);
      // Only registered Smilers users (with a resolvable user id) that aren't
      // already in the group can be added.
      if (!uid || memberIdSet.has(uid)) return false;
      if (!q) return true;
      return `${displayNameForContact(c)} ${c?.phone || ''} ${c?.email || ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [myContacts, memberIdSet, addSearch, displayNameForContact]);

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

  const messageApprovalEnabled = !!adminInfo?.messageApprovalEnabled;
  const currentAdminCount = adminInfo?.currentAdminCount ?? 1;
  // Cap ratio mirrors the server (native-group-admin-cap-contract): 1 admin
  // per 5 members when message approval is ON, else 1 per 10.
  const adminRatio = messageApprovalEnabled ? 5 : 10;
  const maxAdmins = adminInfo?.maxAdmins ?? Math.max(1, Math.floor(memberCount / adminRatio));
  const inviteLinkEnabled = !!adminInfo?.inviteLinkEnabled;
  const inviteCode: string | null = adminInfo?.inviteCode || null;

  // Reserve admins: members who hold an admin slot in adminOrder but are
  // currently OUTSIDE the effective cap (display only — they hold no admin
  // rights until the cap grows or approval is toggled on).
  const reserveAdminIds = useMemo(
    () => new Set<string>((adminInfo?.reserveAdmins || []).map((a: any) => String(a))),
    [adminInfo],
  );

  const groupName = conversation?.name || 'Group';

  // Group creator (resolved to each viewer's device-saved contact name) +
  // creation date — shown to ALL members. The Convex conversation doc carries
  // `_creationTime` (ms epoch). The creator's userId is read from whichever
  // field the backend exposes, falling back to the chief admin (the creator is
  // the chief admin unless it was later transferred).
  const creationDate = useMemo(() => {
    const raw =
      (conversation as any)?._creationTime ??
      (conversation as any)?.createdAt ??
      (conversation as any)?.created_at;
    if (raw == null) return '';
    const d = typeof raw === 'number' ? new Date(raw) : new Date(String(raw));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }, [conversation]);

  const creatorName = useMemo(() => {
    const creatorId = String(
      (conversation as any)?.createdBy ||
        (conversation as any)?.creatorId ||
        (conversation as any)?.createdByUserId ||
        (conversation as any)?.creator ||
        (conversation as any)?.ownerId ||
        chiefAdminId ||
        '',
    );
    if (!creatorId) return '';
    if (myId && creatorId === String(myId)) return 'You';
    const memberRec =
      (Array.isArray(members) ? members : []).find(
        (m: any) => String(m?.userId || m?._id || m?.user?._id || '') === creatorId,
      ) || null;
    const full = getSavedContactRecord(myContacts, { userId: creatorId }) || memberRec;
    if (!full) return '';
    return getResolvedDisplayName(
      full,
      deviceIndex,
      lookupDeviceContactName,
      memberRec?.name || memberRec?.displayName || 'Group creator',
    );
  }, [conversation, chiefAdminId, members, myContacts, deviceIndex, myId]);

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

  // Sub groups: only top-level groups can contain sub groups. The member picker
  // is restricted to this (mother) group's members per the backend contract.
  const isTopLevelGroup = !conversation?.parentConversationId;
  const isSubGroup = !isTopLevelGroup;
  const motherAdminIds = useMemo(() => {
    const set = new Set<string>();
    adminIds.forEach((a) => set.add(String(a)));
    if (chiefAdminId) set.add(chiefAdminId);
    return Array.from(set);
  }, [adminIds, chiefAdminId]);
  const motherMembers = useMemo(
    () =>
      (Array.isArray(members) ? members : [])
        .map((m: any) => {
          const uid = getContactUserId(m);
          if (!uid) return null;
          return { userId: uid, name: displayNameForMember(m) };
        })
        .filter(Boolean) as { userId: string; name: string }[],
    [members, displayNameForMember],
  );

  // -------- Positions (sub groups only) --------
  // Inside a SUB group we manage/show each member's position title.
  const { data: subPositions, refetch: refetchPositions } = useSafeConvexQuery<any[]>(
    (api as any).subGroups?.listPositions,
    isSubGroup && conversationId ? { subGroupId: conversationId } : {},
    [],
    isSubGroup && !!conversationId,
  );
  // Inside the MOTHER group we show titles that sub-group chiefs chose to expose.
  const { data: motherPositions } = useSafeConvexQuery<Record<string, any[]>>(
    (api as any).subGroups?.positionsForMother,
    isTopLevelGroup && conversationId ? { parentConversationId: conversationId } : {},
    {},
    isTopLevelGroup && !!conversationId,
  );

  const subPositionMap = useMemo(() => {
    const map = new Map<string, { title: string; showInMother: boolean }>();
    (Array.isArray(subPositions) ? subPositions : []).forEach((p: any) => {
      if (p?.userId && p?.title) map.set(String(p.userId), { title: String(p.title), showInMother: !!p.showInMother });
    });
    return map;
  }, [subPositions]);

  // positionsForMother is pre-sorted by the backend (order field) — preserve it.
  const motherPositionMap = useMemo(() => {
    const map = new Map<string, string[]>();
    const rec = (motherPositions && typeof motherPositions === 'object' ? motherPositions : {}) as Record<string, any[]>;
    Object.keys(rec).forEach((uid) => {
      const titles = (Array.isArray(rec[uid]) ? rec[uid] : []).map((e: any) => String(e?.title)).filter(Boolean);
      if (titles.length) map.set(String(uid), titles);
    });
    return map;
  }, [motherPositions]);

  // Name lookup for the Office Bearers overview.
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    (Array.isArray(members) ? members : []).forEach((m: any) => {
      const uid = getContactUserId(m);
      if (uid) map.set(uid, displayNameForMember(m));
    });
    return map;
  }, [members, displayNameForMember]);

  // Office bearers = sub-group members who hold a position, in the backend's
  // (Chief-Admin-controlled) order. subPositions is pre-sorted by `order`.
  const officeBearers = useMemo(() => {
    const list: { userId: string; name: string; title: string; showInMother: boolean }[] = [];
    subPositionMap.forEach((val, uid) => {
      list.push({ userId: uid, name: nameById.get(uid) || 'Member', title: val.title, showInMother: val.showInMother });
    });
    return list;
  }, [subPositionMap, nameById]);

  const [positionTarget, setPositionTarget] = useState<{ userId: string; name: string } | null>(null);
  const [bulkPositionsOpen, setBulkPositionsOpen] = useState(false);
  const setPositionOrderM = useMutation((api as any).subGroups?.setPositionOrder);
  const [localBearers, setLocalBearers] = useState(officeBearers);

  // Keep local order synced with the backend order, unless we're mid-reorder.
  const bearerKey = useMemo(() => officeBearers.map((b) => b.userId).join('|'), [officeBearers]);
  useEffect(() => {
    setLocalBearers(officeBearers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bearerKey]);

  const reorderBearer = useCallback(
    (index: number, dir: -1 | 1) => {
      const j = index + dir;
      if (j < 0 || j >= localBearers.length || !conversationId) return;
      const next = [...localBearers];
      [next[index], next[j]] = [next[j], next[index]];
      setLocalBearers(next);
      if (setPositionOrderM) {
        void setPositionOrderM({ subGroupId: conversationId, orderedUserIds: next.map((b) => b.userId) })
          .then(() => refetchPositions?.())
          .catch(() => setLocalBearers(officeBearers));
      }
    },
    [localBearers, conversationId, setPositionOrderM, officeBearers, refetchPositions],
  );

  // Members list for the bulk positions editor (sub group only).
  const bulkPositionMembers = useMemo<BulkPositionMember[]>(
    () =>
      (Array.isArray(members) ? members : [])
        .map((m: any) => {
          const uid = getContactUserId(m);
          if (!uid) return null;
          const pos = subPositionMap.get(uid);
          return {
            userId: uid,
            name: displayNameForMember(m),
            currentTitle: pos?.title || '',
            currentShowInMother: !!pos?.showInMother,
          };
        })
        .filter(Boolean) as BulkPositionMember[],
    [members, displayNameForMember, subPositionMap],
  );

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
    if (ok) {
      void refetchAdmin();
      Alert.alert('Invite link ready', 'Your group invite link has been generated. Tap Copy or Share to send it.');
    }
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

  // Export the invite QR as a PNG → save to Photos (falls back to the share
  // sheet if Photos access is denied, so the user is never dead-ended).
  const qrRef = useRef<any>(null);
  const [savingQr, setSavingQr] = useState(false);
  const onSaveQr = useCallback(() => {
    const ref = qrRef.current;
    if (!ref || typeof ref.toDataURL !== 'function') {
      Alert.alert('QR not ready', 'Please try again in a moment.');
      return;
    }
    setSavingQr(true);
    ref.toDataURL(async (base64: string) => {
      try {
        const fs: any = LegacyFileSystem;
        const target = `${fs.cacheDirectory}smilers_group_invite_${Date.now()}.png`;
        await fs.writeAsStringAsync(target, base64, { encoding: 'base64' });
        const perm = await MediaLibrary.getPermissionsAsync();
        let status = perm.status;
        if (status !== 'granted' && perm.canAskAgain !== false) {
          status = (await MediaLibrary.requestPermissionsAsync()).status;
        }
        if (status === 'granted') {
          await (MediaLibrary as any).saveToLibraryAsync(target);
          Alert.alert('Saved', 'Invite QR code saved to your Photos.');
        } else if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(target, {
            mimeType: 'image/png',
            dialogTitle: 'Save or share invite QR',
          });
        } else {
          Alert.alert(
            'Photos access needed',
            'Enable Photos access in Settings to save the QR code.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ],
          );
        }
      } catch (e: any) {
        Alert.alert('Could not save', e?.message || 'Failed to save the QR code.');
      } finally {
        setSavingQr(false);
      }
    });
  }, []);

  const onPromote = async (userId: string) => {
    if (!conversationId) return;
    if (currentAdminCount >= maxAdmins) {
      return Alert.alert(
        'Admin cap reached',
        `This group allows at most ${maxAdmins} admin(s) — 1 per ${adminRatio} members ${messageApprovalEnabled ? 'while message approval is on' : 'while message approval is off'}. Turn on Message Approval to allow more admins.`,
      );
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
            Admins: {currentAdminCount}/{maxAdmins} (1 per {adminRatio})
          </Text>
          {creatorName ? (
            <Text style={styles.metaLine} testID="group-created-by">
              Created by {creatorName}
            </Text>
          ) : null}
          {creationDate ? (
            <Text style={styles.metaLine} testID="group-created-on">
              Created on {creationDate}
            </Text>
          ) : null}
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
                badgeCount={Number(pendingCount) || 0}
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

        {/* SUB GROUPS */}
        {isTopLevelGroup && conversationId ? (
          <SubGroupsSection
            parentConversationId={conversationId}
            motherMembers={motherMembers}
            motherAdminIds={motherAdminIds}
            groupName={groupName}
            isMotherAdmin={isAdmin}
            myId={myId}
            onOpenChat={(sid) => router.push(`/chat/${sid}` as any)}
            onManage={(sid) => router.push(`/group/${sid}` as any)}
          />
        ) : null}

        {/* OFFICE BEARERS (sub group only) */}
        {isSubGroup && (officeBearers.length > 0 || isAdmin) ? (
          <View style={styles.section} testID="office-bearers-section">
            <View style={styles.bearerHeader}>
              <Text style={styles.sectionLabel}>OFFICE BEARERS ({officeBearers.length})</Text>
              {isAdmin ? (
                <TouchableOpacity
                  style={styles.manageBtn}
                  onPress={() => setBulkPositionsOpen(true)}
                  testID="office-bearers-manage"
                  hitSlop={8}
                >
                  <Feather name="edit-2" size={13} color={Colors.primary} />
                  <Text style={styles.manageBtnText}>Manage</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {officeBearers.length === 0 ? (
              <Text style={styles.bearerEmpty}>No positions assigned yet. Tap Manage to add office bearers.</Text>
            ) : null}
            {isChief && localBearers.length > 1 ? (
              <Text style={styles.bearerHint}>Use the arrows to rank office bearers.</Text>
            ) : null}
            {localBearers.map((ob, idx) => (
              <View key={ob.userId} style={styles.bearerRow} testID={`office-bearer-${ob.userId}`}>
                <View style={styles.bearerAvatar}>
                  <Text style={styles.memberAvatarText}>{getInitials(ob.name)}</Text>
                </View>
                <Text style={styles.bearerName} numberOfLines={1}>
                  {ob.userId === myId ? 'You' : ob.name}
                </Text>
                <View style={styles.positionPill}>
                  <Ionicons name="ribbon" size={11} color={Colors.white} />
                  <Text style={styles.positionPillText} numberOfLines={1}>
                    {ob.title}
                  </Text>
                  {ob.showInMother ? <Ionicons name="eye" size={10} color={Colors.white} /> : null}
                </View>
                {isChief && localBearers.length > 1 ? (
                  <View style={styles.bearerArrows}>
                    <TouchableOpacity
                      onPress={() => reorderBearer(idx, -1)}
                      disabled={idx === 0}
                      style={styles.arrowBtn}
                      testID={`office-bearer-up-${ob.userId}`}
                      hitSlop={6}
                    >
                      <Feather name="chevron-up" size={20} color={idx === 0 ? Colors.border : Colors.textSecondary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => reorderBearer(idx, 1)}
                      disabled={idx === localBearers.length - 1}
                      style={styles.arrowBtn}
                      testID={`office-bearer-down-${ob.userId}`}
                      hitSlop={6}
                    >
                      <Feather
                        name="chevron-down"
                        size={20}
                        color={idx === localBearers.length - 1 ? Colors.border : Colors.textSecondary}
                      />
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            ))}
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
            const resolvedName = displayNameForMember(m);
            return (
              <View key={mid} style={styles.memberRow} testID={`group-member-${mid}`}>
                <TouchableOpacity
                  style={styles.memberTap}
                  activeOpacity={0.6}
                  onPress={() =>
                    router.push(`/user/${mid}?conversationId=${conversationId}` as any)
                  }
                  testID={`group-member-open-${mid}`}
                >
                <View style={styles.memberAvatar}>
                  {m?.avatarUrl ? (
                    <Image source={{ uri: m.avatarUrl }} style={styles.memberAvatarImg} />
                  ) : (
                    <Text style={styles.memberAvatarText}>{getInitials(resolvedName)}</Text>
                  )}
                </View>
                <View style={styles.memberBody}>
                  <View style={styles.memberNameLine}>
                    {isChiefMember ? <Text style={styles.crown}>👑 </Text> : null}
                    <Text style={styles.memberName} numberOfLines={1}>
                      {isMe ? 'You' : resolvedName}
                    </Text>
                    {isChiefMember ? (
                      <View style={styles.chiefBadge}>
                        <Text style={styles.chiefBadgeText}>Chief Admin</Text>
                      </View>
                    ) : isAdminMember ? (
                      <View style={styles.adminBadge}>
                        <Text style={styles.adminBadgeText}>Admin</Text>
                      </View>
                    ) : reserveAdminIds.has(mid) ? (
                      <View style={styles.reserveBadge}>
                        <Text style={styles.reserveBadgeText}>Reserve</Text>
                      </View>
                    ) : null}
                    {isSubGroup && subPositionMap.get(mid)?.title ? (
                      <View style={styles.positionPill} testID={`member-position-${mid}`}>
                        <Ionicons name="ribbon" size={11} color={Colors.white} />
                        <Text style={styles.positionPillText} numberOfLines={1}>
                          {subPositionMap.get(mid)!.title}
                        </Text>
                        {subPositionMap.get(mid)!.showInMother ? (
                          <Ionicons name="eye" size={10} color={Colors.white} />
                        ) : null}
                      </View>
                    ) : null}
                    {isTopLevelGroup && (motherPositionMap.get(mid) || []).map((t, i) => (
                      <View key={`${mid}-pos-${i}`} style={styles.positionPill} testID={`member-mother-position-${mid}-${i}`}>
                        <Ionicons name="ribbon" size={11} color={Colors.white} />
                        <Text style={styles.positionPillText} numberOfLines={1}>
                          {t}
                        </Text>
                      </View>
                    ))}
                  </View>
                  <Text style={styles.memberBio} numberOfLines={1}>
                    {suspension
                      ? `🚫 Suspended${suspension.duration ? ` · ${suspension.duration}` : ''}`
                      : m?.bio || m?.statusMessage || 'Hey there! I am using Smilers.'}
                  </Text>
                </View>
                </TouchableOpacity>
                {isSubGroup && isAdmin ? (
                  <TouchableOpacity
                    style={styles.iconBtn}
                    onPress={() => setPositionTarget({ userId: mid, name: isMe ? 'You' : resolvedName })}
                    testID={`group-member-position-${mid}`}
                  >
                    <Feather name="award" size={20} color={Colors.primary} />
                  </TouchableOpacity>
                ) : null}
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
          <Pressable style={[styles.modalCard, { paddingBottom: Spacing.lg + insets.bottom }]} onPress={() => {}}>
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
      <Modal visible={inviteModalOpen} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setInviteModalOpen(false)}>
        <Pressable style={[styles.modalBackdrop, { justifyContent: 'center', padding: Spacing.lg }]} onPress={() => setInviteModalOpen(false)}>
          <Pressable style={[styles.modalCard, styles.modalCardCentered]} onPress={() => {}}>
            <Text style={styles.modalTitle}>🔗 Invite Link</Text>
            <ScrollView
              style={{ alignSelf: 'stretch' }}
              contentContainerStyle={{ gap: Spacing.md, paddingBottom: Spacing.sm }}
              showsVerticalScrollIndicator={false}
            >
            {inviteLinkEnabled && inviteCode ? (
              <>
                <Text style={styles.modalBody}>Share this link with anyone you want to add.</Text>
                <TouchableOpacity
                  style={styles.qrCard}
                  activeOpacity={0.85}
                  onPress={onSaveQr}
                  onLongPress={onSaveQr}
                  disabled={savingQr}
                  testID="group-info-invite-qr"
                >
                  <QRCode
                    value={`https://smilers.online/join/${inviteCode}`}
                    size={160}
                    backgroundColor="#FFFFFF"
                    color="#1A1207"
                    getRef={(c: any) => (qrRef.current = c)}
                  />
                  <Text style={styles.qrCaption}>Scan to join {groupName}</Text>
                  <View style={styles.qrSaveHint}>
                    {savingQr ? (
                      <ActivityIndicator size="small" color={Colors.primary} />
                    ) : (
                      <Feather name="download" size={13} color={Colors.textSecondary} />
                    )}
                    <Text style={styles.qrSaveHintText}>
                      {savingQr ? 'Saving…' : 'Tap to save QR to Photos'}
                    </Text>
                  </View>
                </TouchableOpacity>
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
                <Text style={styles.modalBody}>Generate a link that anyone can use to join this group. You can disable it anytime.</Text>
                <TouchableOpacity
                  style={[styles.modalSave, busy === 'generateInviteLink' ? { opacity: 0.6 } : null]}
                  onPress={onGenerateInvite}
                  disabled={busy === 'generateInviteLink'}
                  testID="group-info-invite-generate"
                >
                  <Text style={styles.modalSaveText}>
                    {busy === 'generateInviteLink' ? 'Generating…' : 'Generate Invite Link'}
                  </Text>
                </TouchableOpacity>
              </>
            )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ----- Transfer Chief Modal ----- */}
      <Modal visible={transferModalOpen} transparent animationType="slide" onRequestClose={() => setTransferModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setTransferModalOpen(false)}>
          <Pressable style={[styles.modalCard, { paddingBottom: Spacing.lg + insets.bottom }]} onPress={() => {}}>
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
          <Pressable style={[styles.modalCard, { paddingBottom: Spacing.lg + insets.bottom }]} onPress={() => {}}>
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

      {/* ----- Sub Group Position Modal ----- */}
      {isSubGroup && conversationId ? (
        <SubGroupPositionModal
          visible={!!positionTarget}
          subGroupId={conversationId}
          userId={positionTarget?.userId || null}
          memberName={positionTarget?.name || 'Member'}
          currentTitle={positionTarget ? subPositionMap.get(positionTarget.userId)?.title || '' : ''}
          currentShowInMother={positionTarget ? !!subPositionMap.get(positionTarget.userId)?.showInMother : false}
          isChief={isChief}
          onClose={() => {
            setPositionTarget(null);
            void refetchPositions?.();
          }}
        />
      ) : null}

      {/* ----- Bulk Positions Modal ----- */}
      {isSubGroup && conversationId ? (
        <BulkPositionsModal
          visible={bulkPositionsOpen}
          subGroupId={conversationId}
          members={bulkPositionMembers}
          isChief={isChief}
          onClose={() => {
            setBulkPositionsOpen(false);
            void refetchPositions?.();
          }}
        />
      ) : null}


      {/* ----- Add Members Modal ----- */}
      <Modal visible={addMembersOpen} transparent animationType="slide" onRequestClose={() => setAddMembersOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAddMembersOpen(false)}>
          <Pressable style={[styles.modalCard, { paddingBottom: Spacing.lg + insets.bottom }]} onPress={() => {}}>
            <Text style={styles.modalTitle}>➕ Add Members</Text>
            <Text style={styles.modalBody}>Pick Smilers contacts to add to this group.</Text>
            <TextInput
              value={addSearch}
              onChangeText={setAddSearch}
              placeholder="Search contacts"
              placeholderTextColor={Colors.textMuted}
              style={styles.modalInput}
              autoCorrect={false}
              testID="group-info-add-search"
            />
            {addableContacts.length === 0 ? (
              <View style={styles.emptyModal}>
                <Text style={styles.emptyModalTitle}>No contacts to add</Text>
                <Text style={styles.emptyModalBody}>
                  {addSearch.trim()
                    ? 'No matching Smilers contacts found.'
                    : 'All your Smilers contacts are already in this group.'}
                </Text>
              </View>
            ) : (
              <FlatList
                data={addableContacts}
                keyExtractor={(c: any) => getContactUserId(c) || String(Math.random())}
                style={{ maxHeight: 340 }}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => {
                  const uid = getContactUserId(item) as string;
                  const name = displayNameForContact(item);
                  const avatar = item?.avatar || item?.avatarUrl || item?.user?.avatar;
                  const checked = selectedAdd.has(uid);
                  return (
                    <TouchableOpacity
                      style={styles.transferRow}
                      onPress={() => toggleAddSelect(uid)}
                      testID={`group-info-add-contact-${uid}`}
                    >
                      <View style={styles.memberAvatar}>
                        {avatar ? (
                          <Image source={{ uri: avatar }} style={styles.memberAvatarImg} />
                        ) : (
                          <Text style={styles.memberAvatarText}>{getInitials(name)}</Text>
                        )}
                      </View>
                      <Text style={styles.transferName} numberOfLines={1}>
                        {name}
                      </Text>
                      <Feather
                        name={checked ? 'check-circle' : 'circle'}
                        size={22}
                        color={checked ? Colors.primary : Colors.textMuted}
                      />
                    </TouchableOpacity>
                  );
                }}
              />
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setAddMembersOpen(false)} style={styles.modalCancel}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmAddMembers}
                style={[styles.modalSave, selectedAdd.size === 0 && { opacity: 0.5 }]}
                disabled={selectedAdd.size === 0 || busy === 'addMembers'}
                testID="group-info-add-confirm"
              >
                <Text style={styles.modalSaveText}>
                  {selectedAdd.size > 0 ? `Add ${selectedAdd.size}` : 'Add'}
                </Text>
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
  badgeCount,
  onPress,
  testID,
}: {
  icon: any;
  label: string;
  trailing?: string;
  badgeCount?: number;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity style={styles.actionRow} onPress={onPress} testID={testID} activeOpacity={0.7}>
      <Feather name={icon} size={20} color={Colors.primary} />
      <Text style={styles.actionLabel}>{label}</Text>
      {badgeCount && badgeCount > 0 ? (
        <View style={styles.actionBadge} testID={`${testID}-badge`}>
          <Text style={styles.actionBadgeText}>{badgeCount > 99 ? '99+' : badgeCount}</Text>
        </View>
      ) : null}
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
  metaLine: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2, textAlign: 'center' },
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
  actionBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E5342B',
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  actionBadgeText: { color: '#FFFFFF', fontSize: FontSize.xs, fontWeight: FontWeight.bold },
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
  memberTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
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
  reserveBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(120,120,120,0.15)',
  },
  reserveBadgeText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: FontWeight.bold },
  positionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    maxWidth: 130,
  },
  positionPillText: { fontSize: FontSize.xs, color: Colors.white, fontWeight: FontWeight.bold, flexShrink: 1 },
  bearerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 8 },
  bearerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bearerEmpty: { fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic', marginTop: 6 },
  bearerHint: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 4, marginBottom: 2 },
  bearerArrows: { flexDirection: 'row', alignItems: 'center', marginLeft: 4 },
  arrowBtn: { paddingHorizontal: 2 },
  manageBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  manageBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.semibold },
  bearerAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bearerName: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.medium, color: Colors.textPrimary },
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
  modalCardCentered: {
    borderRadius: 20,
    width: '100%',
    maxHeight: '80%',
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
  qrCard: {
    alignSelf: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: Radius.lg,
    padding: Spacing.base,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  qrCaption: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  qrSaveHint: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qrSaveHintText: { fontSize: FontSize.sm, color: Colors.textSecondary },
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
