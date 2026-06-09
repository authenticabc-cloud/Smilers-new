/**
 * Conference Room Screen
 *
 * Web-parity conference room with:
 *  - Participant grid (responsive 2/3-col) with mic/cam/role/hand-raised indicators
 *  - Waiting room (lobby) with admit/deny actions for Chair/Clerk
 *  - Long-press participant tile → admin action sheet (chair-only):
 *      - Force mute
 *      - Promote → Clerk
 *      - Promote → Protocol
 *      - Demote roles
 *      - Suspend / Remove (uses conferenceRoles.status)
 *  - Self controls: mute, video, leave
 *  - In-meeting chat panel (slide-up) with audience-aware composer:
 *      - Everyone / Chair / Clerk-Secretary
 *      - Audience encoded as `[To: <audience>] ` prefix in message text
 *
 * Uses the deployed Convex backend per CONFERENCES_SPEC:
 *   - api.conferenceRoom.{getRoomState, joinRoom, leaveRoom, toggleMute, toggleVideo}
 *   - api.conferenceChat.{getMessages, sendMessage}
 *   - api.conferenceMinutes.{assignClerkRole, removeClerkRole}
 *   - api.conferenceSpeakerTimer.{assignProtocolRole, removeProtocolRole}
 *
 * For suspend/remove (not in spec), we call optimistic safe-fallback mutations:
 *   - api.conferenceRoom.suspendParticipant
 *   - api.conferenceRoom.removeParticipant
 * If the backend hasn't shipped them, we fall back gracefully with a clear alert.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { StatusBar } from 'expo-status-bar';

import { api } from '../../../src/convexApi';
import { useSafeConvexQuery } from '../../../src/hooks/useSafeConvexQuery';
import { getDisplayInitials } from '../../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../../src/theme';

type Role = 'chair' | 'clerk' | 'protocol' | 'participant';
type Audience = 'everyone' | 'chair' | 'clerk';
type ParticipantStatus = 'invited' | 'waiting' | 'active' | 'suspended' | 'removed' | 'left';

interface Participant {
  _id?: string;
  userId: string;
  name?: string;
  avatar?: string | null;
  role: Role;
  status: ParticipantStatus;
  isMuted?: boolean;
  videoEnabled?: boolean;
  handRaised?: boolean;
  joinedAt?: string;
}

interface RoomState {
  conference?: {
    _id: string;
    title: string;
    type: 'video' | 'audio';
    status: 'scheduled' | 'started' | 'ended' | 'adjourned';
    chairId: string;
    inviteCode?: string;
  };
  participants: Participant[];
  myRole: Role;
  myUserId: string;
}

const AUDIENCE_OPTIONS: { key: Audience; label: string; icon: any }[] = [
  { key: 'everyone', label: 'Everyone', icon: 'account-group-outline' },
  { key: 'chair', label: 'Chair only', icon: 'crown-outline' },
  { key: 'clerk', label: 'Clerk / Secretary', icon: 'pencil-outline' },
];

const AUDIENCE_PREFIX_RE = /^\[To:\s*(everyone|chair|clerk|secretary)\]\s*/i;

function parseAudienceFromText(text: string): { audience: Audience; body: string } {
  const match = text.match(AUDIENCE_PREFIX_RE);
  if (!match) return { audience: 'everyone', body: text };
  const raw = match[1].toLowerCase();
  const audience: Audience = raw === 'chair' ? 'chair' : raw === 'secretary' || raw === 'clerk' ? 'clerk' : 'everyone';
  return { audience, body: text.slice(match[0].length) };
}

function encodeAudience(audience: Audience, text: string): string {
  if (audience === 'everyone') return text;
  const label = audience === 'chair' ? 'Chair' : 'Clerk';
  return `[To: ${label}] ${text}`;
}

function normalizeRole(value: any): Role {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  if (v === 'chair' || v === 'host') return 'chair';
  if (v === 'clerk' || v === 'secretary') return 'clerk';
  if (v === 'protocol' || v === 'moderator') return 'protocol';
  return 'participant';
}

function getRoleConfig(role: Role) {
  switch (role) {
    case 'chair':
      return { label: 'Chair', icon: 'crown' as const, bg: '#FEF3C7', fg: '#92400E' };
    case 'clerk':
      return { label: 'Clerk', icon: 'pencil-outline' as const, bg: '#DBEAFE', fg: '#1E3A8A' };
    case 'protocol':
      return { label: 'Protocol', icon: 'shield-check' as const, bg: '#DCFCE7', fg: '#166534' };
    default:
      return { label: 'Participant', icon: 'account-outline' as const, bg: '#F3F4F6', fg: '#374151' };
  }
}

function safeMutate<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  return fn().catch((e: any) => {
    const message = String(e?.message || e || '');
    console.warn(`[conf-room] ${label} failed:`, message);
    const isMissing = message.includes('CouldNotFindFunction') || message.includes('not found') || message.toLowerCase().includes('no function');
    Alert.alert(
      label,
      isMissing
        ? 'This action needs a backend update — once the team ships the endpoint, it will start working.'
        : message || 'Something went wrong. Please try again.',
    );
    return null;
  });
}

export default function ConferenceRoomScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { conferenceId: rawId } = useLocalSearchParams<{ conferenceId?: string | string[] }>();
  const conferenceId = Array.isArray(rawId) ? rawId[0] : rawId;
  const isValid = typeof conferenceId === 'string' && conferenceId.length > 4;

  // --- Room state ---
  const { data: state, refetch: refetchState, loading: stateLoading } = useSafeConvexQuery<RoomState>(
    (api as any).conferenceRoom.getRoomState,
    { conferenceId },
    { conference: undefined, participants: [], myRole: 'participant', myUserId: '' },
    !!isValid,
  );

  const myRole = normalizeRole(state?.myRole);
  const myUserId = state?.myUserId || '';
  const isChair = myRole === 'chair';
  const isClerk = myRole === 'clerk';
  const isPrivileged = isChair || isClerk;

  const allParticipants: Participant[] = Array.isArray(state?.participants) ? state!.participants : [];
  const active = useMemo(
    () => allParticipants.filter((p) => p.status === 'active' || p.status === 'suspended'),
    [allParticipants],
  );
  const waiting = useMemo(
    () => allParticipants.filter((p) => p.status === 'waiting' || p.status === 'invited'),
    [allParticipants],
  );

  const me = useMemo(() => active.find((p) => p.userId === myUserId), [active, myUserId]);
  const myMuted = !!me?.isMuted;
  const myVideoEnabled = me?.videoEnabled !== false;

  // --- Mutations ---
  const joinRoomM = useMutation((api as any).conferenceRoom.joinRoom);
  const leaveRoomM = useMutation((api as any).conferenceRoom.leaveRoom);
  const toggleMuteM = useMutation((api as any).conferenceRoom.toggleMute);
  const toggleVideoM = useMutation((api as any).conferenceRoom.toggleVideo);
  const admitM = useMutation((api as any).conferenceRoom.admitParticipant);
  const denyM = useMutation((api as any).conferenceRoom.denyParticipant);
  const suspendM = useMutation((api as any).conferenceRoom.suspendParticipant);
  const removeM = useMutation((api as any).conferenceRoom.removeParticipant);
  const forceMuteM = useMutation((api as any).conferenceRoom.forceMuteParticipant);
  const assignClerkM = useMutation((api as any).conferenceMinutes.assignClerkRole);
  const removeClerkM = useMutation((api as any).conferenceMinutes.removeClerkRole);
  const assignProtocolM = useMutation((api as any).conferenceSpeakerTimer.assignProtocolRole);
  const removeProtocolM = useMutation((api as any).conferenceSpeakerTimer.removeProtocolRole);

  // --- Auto-join once on mount ---
  const joinedRef = useRef(false);
  useEffect(() => {
    if (!isValid || joinedRef.current) return;
    joinedRef.current = true;
    (async () => {
      await safeMutate('Join room', async () => joinRoomM({ conferenceId, videoEnabled: true }));
      await refetchState();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValid]);

  // --- Live refresh (poll lightweight at 3s while in room) ---
  useEffect(() => {
    if (!isValid) return;
    const id = setInterval(() => {
      void refetchState();
    }, 3000);
    return () => clearInterval(id);
  }, [isValid, refetchState]);

  // --- Local UI state ---
  const [chatOpen, setChatOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<Participant | null>(null);

  // --- Handlers ---
  const handleLeave = useCallback(() => {
    Alert.alert('Leave conference?', 'You can rejoin anytime as long as the meeting is active.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          await safeMutate('Leave room', async () => leaveRoomM({ conferenceId }));
          router.back();
        },
      },
    ]);
  }, [conferenceId, leaveRoomM, router]);

  const handleToggleSelfMute = useCallback(async () => {
    await safeMutate('Toggle mute', async () => toggleMuteM({ conferenceId, isMuted: !myMuted }));
    void refetchState();
  }, [conferenceId, myMuted, refetchState, toggleMuteM]);

  const handleToggleSelfVideo = useCallback(async () => {
    await safeMutate('Toggle camera', async () => toggleVideoM({ conferenceId, videoEnabled: !myVideoEnabled }));
    void refetchState();
  }, [conferenceId, myVideoEnabled, refetchState, toggleVideoM]);

  const handleAdmit = useCallback(
    async (p: Participant) => {
      await safeMutate('Admit participant', async () => admitM({ conferenceId, targetUserId: p.userId }));
      void refetchState();
    },
    [admitM, conferenceId, refetchState],
  );

  const handleDeny = useCallback(
    async (p: Participant) => {
      await safeMutate('Deny participant', async () => denyM({ conferenceId, targetUserId: p.userId }));
      void refetchState();
    },
    [conferenceId, denyM, refetchState],
  );

  const performAdminAction = useCallback(
    async (action: string, p: Participant) => {
      setActionTarget(null);
      const targetUserId = p.userId;
      switch (action) {
        case 'force_mute':
          await safeMutate('Force mute', async () => forceMuteM({ conferenceId, targetUserId, isMuted: true }));
          break;
        case 'force_unmute':
          await safeMutate('Force unmute', async () => forceMuteM({ conferenceId, targetUserId, isMuted: false }));
          break;
        case 'promote_clerk':
          await safeMutate('Promote to Clerk', async () => assignClerkM({ conferenceId, targetUserId }));
          break;
        case 'demote_clerk':
          await safeMutate('Remove Clerk role', async () => removeClerkM({ conferenceId, targetUserId }));
          break;
        case 'promote_protocol':
          await safeMutate('Promote to Protocol', async () => assignProtocolM({ conferenceId, targetUserId }));
          break;
        case 'demote_protocol':
          await safeMutate('Remove Protocol role', async () => removeProtocolM({ conferenceId, targetUserId }));
          break;
        case 'suspend':
          Alert.alert('Suspend participant?', 'They will be temporarily muted and their video disabled until you reinstate them.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Suspend',
              style: 'destructive',
              onPress: async () => {
                await safeMutate('Suspend participant', async () => suspendM({ conferenceId, targetUserId }));
                void refetchState();
              },
            },
          ]);
          return;
        case 'remove':
          Alert.alert('Remove participant?', 'They will be ejected from the meeting and cannot rejoin without being readmitted.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Remove',
              style: 'destructive',
              onPress: async () => {
                await safeMutate('Remove participant', async () => removeM({ conferenceId, targetUserId }));
                void refetchState();
              },
            },
          ]);
          return;
      }
      void refetchState();
    },
    [assignClerkM, assignProtocolM, conferenceId, forceMuteM, refetchState, removeClerkM, removeM, removeProtocolM, suspendM],
  );

  // --- Layout ---
  const columns = width >= 720 ? 3 : 2;
  const tileWidth = (width - Spacing.base * 2 - Spacing.sm * (columns - 1)) / columns;
  const tileHeight = tileWidth * 1.1;

  if (!isValid) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <StatusBar style="light" />
        <View style={styles.errorWrap}>
          <Ionicons name="alert-circle-outline" size={48} color={Colors.danger} />
          <Text style={styles.errorTitle}>Invalid conference</Text>
          <Text style={styles.errorBody}>The conference link is malformed or has expired.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()}>
            <Text style={styles.primaryBtnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container} testID="conference-room-screen">
      <StatusBar style="light" />
      <SafeAreaView edges={['top']} style={styles.headerWrap}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={handleLeave} hitSlop={10} testID="conf-leave-btn" style={styles.headerBackBtn}>
            <Ionicons name="chevron-back" size={28} color={Colors.white} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {state?.conference?.title || 'Conference'}
            </Text>
            <Text style={styles.headerSubtitle}>
              <Text style={styles.headerLiveDot}>●</Text>  {active.length} participant{active.length === 1 ? '' : 's'}
              {state?.conference?.status ? `  ·  ${state.conference.status}` : ''}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setChatOpen(true)}
            hitSlop={10}
            style={styles.headerActionBtn}
            testID="conf-open-chat"
          >
            <Ionicons name="chatbubbles-outline" size={24} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Waiting room (lobby) */}
      {waiting.length > 0 && isPrivileged ? (
        <View style={styles.lobbyCard} testID="conf-lobby">
          <View style={styles.lobbyHeader}>
            <MaterialCommunityIcons name="account-clock-outline" size={18} color="#7F1D1D" />
            <Text style={styles.lobbyTitle}>Waiting room ({waiting.length})</Text>
          </View>
          {waiting.slice(0, 5).map((p) => (
            <View key={p.userId} style={styles.lobbyRow} testID={`conf-lobby-row-${p.userId}`}>
              <View style={[styles.smallAvatar, { backgroundColor: '#FEF3C7' }]}>
                <Text style={styles.smallAvatarText}>{getDisplayInitials(p.name || 'U', 1)}</Text>
              </View>
              <Text style={styles.lobbyName} numberOfLines={1}>
                {p.name || 'Unknown'}
              </Text>
              <TouchableOpacity
                onPress={() => handleAdmit(p)}
                style={[styles.lobbyBtn, { backgroundColor: Colors.success }]}
                testID={`conf-admit-${p.userId}`}
              >
                <Feather name="check" size={16} color={Colors.white} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleDeny(p)}
                style={[styles.lobbyBtn, { backgroundColor: Colors.danger }]}
                testID={`conf-deny-${p.userId}`}
              >
                <Feather name="x" size={16} color={Colors.white} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}

      {/* Participant grid */}
      {stateLoading && active.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>Joining conference…</Text>
        </View>
      ) : (
        <FlatList
          data={active}
          keyExtractor={(item) => item.userId}
          numColumns={columns}
          key={`grid-${columns}`}
          contentContainerStyle={styles.gridContent}
          columnWrapperStyle={columns > 1 ? styles.gridRow : undefined}
          renderItem={({ item }) => (
            <ParticipantTile
              participant={item}
              isMe={item.userId === myUserId}
              canManage={isChair && item.userId !== myUserId}
              width={tileWidth}
              height={tileHeight}
              onLongPress={() => (isChair && item.userId !== myUserId ? setActionTarget(item) : undefined)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <MaterialCommunityIcons name="account-multiple-outline" size={48} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>Waiting for others to join</Text>
              <Text style={styles.emptyBody}>Share the invite code so people can join.</Text>
            </View>
          }
        />
      )}

      {/* Bottom control bar */}
      <SafeAreaView edges={['bottom']} style={styles.bottomBar}>
        <View style={styles.bottomBarRow}>
          <SelfControl
            icon={myMuted ? 'mic-off' : 'mic'}
            label={myMuted ? 'Unmute' : 'Mute'}
            active={myMuted}
            onPress={handleToggleSelfMute}
            testID="conf-self-mute"
          />
          <SelfControl
            icon={myVideoEnabled ? 'video' : 'video-off'}
            label={myVideoEnabled ? 'Stop video' : 'Start video'}
            active={!myVideoEnabled}
            onPress={handleToggleSelfVideo}
            testID="conf-self-video"
          />
          <SelfControl
            icon="message-circle"
            label="Chat"
            onPress={() => setChatOpen(true)}
            testID="conf-self-chat"
          />
          <SelfControl
            icon="phone-off"
            label="Leave"
            danger
            onPress={handleLeave}
            testID="conf-self-leave"
          />
        </View>
      </SafeAreaView>

      {/* Admin action sheet */}
      {actionTarget ? (
        <AdminActionSheet
          target={actionTarget}
          onClose={() => setActionTarget(null)}
          onAction={(action) => performAdminAction(action, actionTarget)}
        />
      ) : null}

      {/* Chat modal */}
      <ConferenceChatModal
        visible={chatOpen}
        onClose={() => setChatOpen(false)}
        conferenceId={conferenceId!}
        myUserId={myUserId}
        myRole={myRole}
      />
    </View>
  );
}

/* --------------------------- ParticipantTile --------------------------- */

function ParticipantTile({
  participant,
  isMe,
  canManage,
  width,
  height,
  onLongPress,
}: {
  participant: Participant;
  isMe: boolean;
  canManage: boolean;
  width: number;
  height: number;
  onLongPress?: () => void;
}) {
  const role = normalizeRole(participant.role);
  const roleCfg = getRoleConfig(role);
  const isMuted = !!participant.isMuted;
  const videoOn = participant.videoEnabled !== false;
  const isSuspended = participant.status === 'suspended';
  const handRaised = !!participant.handRaised;

  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={300}
      style={({ pressed }) => [
        styles.tile,
        { width, height },
        isSuspended ? styles.tileSuspended : null,
        pressed && canManage ? styles.tilePressed : null,
      ]}
      testID={`conf-tile-${participant.userId}`}
    >
      {/* Video area / avatar */}
      <View style={styles.tileVideo}>
        {videoOn ? (
          <View style={styles.tileVideoActive}>
            <MaterialCommunityIcons name="video" size={28} color="rgba(255,255,255,0.3)" />
          </View>
        ) : (
          <View style={styles.tileAvatarWrap}>
            <View style={styles.tileAvatar}>
              <Text style={styles.tileAvatarText}>{getDisplayInitials(participant.name || '?', 2)}</Text>
            </View>
          </View>
        )}
        {/* Top-right badges */}
        <View style={styles.tileTopRight}>
          {handRaised ? (
            <View style={styles.handRaisedBadge}>
              <MaterialCommunityIcons name="hand-front-right" size={14} color="#92400E" />
            </View>
          ) : null}
          {isSuspended ? (
            <View style={styles.suspendedBadge}>
              <MaterialCommunityIcons name="pause-circle-outline" size={14} color={Colors.white} />
            </View>
          ) : null}
        </View>
        {/* Top-left role badge */}
        <View style={[styles.tileRoleBadge, { backgroundColor: roleCfg.bg }]}>
          <MaterialCommunityIcons name={roleCfg.icon as any} size={11} color={roleCfg.fg} />
          <Text style={[styles.tileRoleText, { color: roleCfg.fg }]}>{roleCfg.label}</Text>
        </View>
      </View>

      {/* Bottom name + mic */}
      <View style={styles.tileFooter}>
        <Text style={styles.tileName} numberOfLines={1}>
          {isMe ? 'You' : participant.name || 'Unknown'}
        </Text>
        <View style={styles.tileMicWrap}>
          <Feather name={isMuted ? 'mic-off' : 'mic'} size={12} color={isMuted ? Colors.danger : Colors.success} />
        </View>
      </View>

      {canManage ? (
        <View style={styles.tileLongPressHint} pointerEvents="none">
          <Text style={styles.tileLongPressHintText}>Hold for options</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/* --------------------------- SelfControl --------------------------- */

function SelfControl({
  icon,
  label,
  active,
  danger,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={styles.selfControlWrap}
      onPress={onPress}
      activeOpacity={0.8}
      testID={testID}
    >
      <View
        style={[
          styles.selfControlBtn,
          active ? styles.selfControlBtnActive : null,
          danger ? styles.selfControlBtnDanger : null,
        ]}
      >
        <Feather name={icon as any} size={22} color={danger ? Colors.white : active ? '#3D2A00' : Colors.white} />
      </View>
      <Text style={[styles.selfControlLabel, danger ? { color: Colors.danger } : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

/* --------------------------- AdminActionSheet --------------------------- */

function AdminActionSheet({
  target,
  onClose,
  onAction,
}: {
  target: Participant;
  onClose: () => void;
  onAction: (action: string) => void;
}) {
  const role = normalizeRole(target.role);
  const isMuted = !!target.isMuted;
  const isSuspended = target.status === 'suspended';

  const actions: { key: string; label: string; icon: any; danger?: boolean; show: boolean }[] = [
    {
      key: isMuted ? 'force_unmute' : 'force_mute',
      label: isMuted ? 'Force unmute' : 'Force mute',
      icon: isMuted ? 'microphone' : 'microphone-off',
      show: true,
    },
    {
      key: role === 'clerk' ? 'demote_clerk' : 'promote_clerk',
      label: role === 'clerk' ? 'Remove Clerk role' : 'Promote → Clerk / Secretary',
      icon: 'pencil-outline',
      show: role !== 'chair',
    },
    {
      key: role === 'protocol' ? 'demote_protocol' : 'promote_protocol',
      label: role === 'protocol' ? 'Remove Protocol role' : 'Promote → Protocol',
      icon: 'shield-check-outline',
      show: role !== 'chair',
    },
    {
      key: 'suspend',
      label: isSuspended ? 'Reinstate participant' : 'Suspend participant',
      icon: 'pause-circle-outline',
      danger: !isSuspended,
      show: true,
    },
    {
      key: 'remove',
      label: 'Remove from meeting',
      icon: 'close-circle-outline',
      danger: true,
      show: true,
    },
  ];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheetCard} onPress={() => {}} testID="conf-admin-sheet">
          <View style={styles.sheetHeader}>
            <View style={styles.sheetAvatar}>
              <Text style={styles.sheetAvatarText}>{getDisplayInitials(target.name || '?', 2)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {target.name || 'Unknown'}
              </Text>
              <Text style={styles.sheetSubtitle}>
                {getRoleConfig(role).label}
                {isSuspended ? ' · Suspended' : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10} testID="conf-admin-close">
              <Ionicons name="close" size={24} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {actions
            .filter((a) => a.show)
            .map((a) => (
              <TouchableOpacity
                key={a.key}
                style={styles.sheetRow}
                onPress={() => onAction(a.key)}
                testID={`conf-admin-${a.key}`}
                activeOpacity={0.75}
              >
                <MaterialCommunityIcons
                  name={a.icon}
                  size={22}
                  color={a.danger ? Colors.danger : Colors.textPrimary}
                />
                <Text style={[styles.sheetRowText, a.danger ? { color: Colors.danger } : null]}>{a.label}</Text>
                <Feather name="chevron-right" size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* --------------------------- ConferenceChatModal --------------------------- */

function ConferenceChatModal({
  visible,
  onClose,
  conferenceId,
  myUserId,
  myRole,
}: {
  visible: boolean;
  onClose: () => void;
  conferenceId: string;
  myUserId: string;
  myRole: Role;
}) {
  const [draft, setDraft] = useState('');
  const [audience, setAudience] = useState<Audience>('everyone');
  const [audiencePickerOpen, setAudiencePickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<any> | null>(null);

  const { data: messages, refetch } = useSafeConvexQuery<any[]>(
    (api as any).conferenceChat.getMessages,
    { conferenceId },
    [],
    visible && !!conferenceId,
  );

  const sendMessageM = useMutation((api as any).conferenceChat.sendMessage);

  // Poll while chat is open
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => void refetch(), 2500);
    return () => clearInterval(id);
  }, [visible, refetch]);

  const handleSend = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    const encoded = encodeAudience(audience, trimmed);
    const ok = await safeMutate('Send message', async () =>
      sendMessageM({ conferenceId, text: encoded }),
    );
    setSending(false);
    if (ok !== null) {
      setDraft('');
      void refetch();
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [audience, conferenceId, draft, refetch, sendMessageM, sending]);

  const audienceConfig = AUDIENCE_OPTIONS.find((o) => o.key === audience)!;
  const visibleMessages = useMemo(() => {
    if (!Array.isArray(messages)) return [];
    return messages
      .map((m) => {
        const text = String(m?.text || '');
        const { audience: aud, body } = parseAudienceFromText(text);
        return { ...m, _audience: aud, _body: body };
      })
      .filter((m) => {
        // Show messages targeted to me, sent by me, or addressed to everyone
        if (m._audience === 'everyone') return true;
        if (m.senderId === myUserId) return true;
        if (m._audience === 'chair' && myRole === 'chair') return true;
        if (m._audience === 'clerk' && myRole === 'clerk') return true;
        return false;
      });
  }, [messages, myRole, myUserId]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={styles.chatContainer} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          {/* Header */}
          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>Meeting chat</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} testID="conf-chat-close">
              <Ionicons name="close" size={26} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>

          {/* Messages */}
          <FlatList
            ref={listRef}
            data={visibleMessages}
            keyExtractor={(item, idx) => String(item?._id || idx)}
            renderItem={({ item }) => {
              const isMe = item.senderId === myUserId || item.isMe;
              return (
                <View style={[styles.bubbleRow, isMe ? { justifyContent: 'flex-end' } : null]}>
                  <View
                    style={[
                      styles.bubble,
                      isMe ? styles.bubbleMe : styles.bubbleOther,
                    ]}
                  >
                    {!isMe ? (
                      <Text style={styles.bubbleSender}>{item.senderName || 'Unknown'}</Text>
                    ) : null}
                    {item._audience !== 'everyone' ? (
                      <View style={styles.bubbleAudienceBadge}>
                        <MaterialCommunityIcons
                          name={item._audience === 'chair' ? 'crown' : 'pencil-outline'}
                          size={10}
                          color="#92400E"
                        />
                        <Text style={styles.bubbleAudienceText}>
                          To {item._audience === 'chair' ? 'Chair' : 'Clerk'}
                        </Text>
                      </View>
                    ) : null}
                    <Text style={[styles.bubbleText, isMe ? { color: Colors.textPrimary } : null]}>
                      {item._body}
                    </Text>
                  </View>
                </View>
              );
            }}
            contentContainerStyle={styles.chatListContent}
            ListEmptyComponent={
              <View style={styles.chatEmpty}>
                <MaterialCommunityIcons name="chat-outline" size={42} color={Colors.textMuted} />
                <Text style={styles.chatEmptyText}>No messages yet. Be the first!</Text>
              </View>
            }
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />

          {/* Audience selector + composer */}
          <View style={styles.composerWrap}>
            <TouchableOpacity
              style={styles.audiencePill}
              onPress={() => setAudiencePickerOpen(true)}
              testID="conf-audience-pill"
            >
              <MaterialCommunityIcons name={audienceConfig.icon} size={14} color={Colors.primary} />
              <Text style={styles.audiencePillText}>To: {audienceConfig.label}</Text>
              <Feather name="chevron-down" size={14} color={Colors.primary} />
            </TouchableOpacity>

            <View style={styles.composerRow}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder={`Message ${audienceConfig.label.toLowerCase()}…`}
                placeholderTextColor={Colors.textMuted}
                style={styles.composerInput}
                multiline
                maxLength={2000}
                testID="conf-chat-input"
              />
              <TouchableOpacity
                style={[styles.sendBtn, !draft.trim() ? styles.sendBtnDisabled : null]}
                onPress={handleSend}
                disabled={!draft.trim() || sending}
                testID="conf-chat-send"
              >
                {sending ? (
                  <ActivityIndicator size="small" color={Colors.headerBg} />
                ) : (
                  <Ionicons name="send" size={18} color={Colors.headerBg} />
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Audience picker modal */}
          <Modal
            visible={audiencePickerOpen}
            transparent
            animationType="fade"
            onRequestClose={() => setAudiencePickerOpen(false)}
          >
            <Pressable style={styles.sheetBackdrop} onPress={() => setAudiencePickerOpen(false)}>
              <Pressable style={styles.sheetCard} onPress={() => {}}>
                <Text style={styles.sheetTitle}>Send message to…</Text>
                <Text style={styles.sheetSubtitle}>
                  Only the selected audience will see this message in their chat panel.
                </Text>
                {AUDIENCE_OPTIONS.map((opt) => {
                  const selected = audience === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.sheetRow, selected ? styles.sheetRowSelected : null]}
                      onPress={() => {
                        setAudience(opt.key);
                        setAudiencePickerOpen(false);
                      }}
                      testID={`conf-audience-opt-${opt.key}`}
                    >
                      <MaterialCommunityIcons
                        name={opt.icon}
                        size={22}
                        color={selected ? Colors.primary : Colors.textPrimary}
                      />
                      <Text style={[styles.sheetRowText, selected ? { color: Colors.primary, fontWeight: FontWeight.bold } : null]}>
                        {opt.label}
                      </Text>
                      {selected ? <Feather name="check" size={18} color={Colors.primary} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </Pressable>
            </Pressable>
          </Modal>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

/* --------------------------- Styles --------------------------- */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0703',
  },
  headerWrap: {
    backgroundColor: Colors.headerBg,
    paddingBottom: Spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    gap: Spacing.sm,
    minHeight: 56,
  },
  headerBackBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: { flex: 1 },
  headerTitle: {
    color: Colors.white,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  headerSubtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
    marginTop: 2,
  },
  headerLiveDot: { color: '#EF4444' },
  headerActionBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },

  errorWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  errorTitle: {
    color: Colors.white,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  errorBody: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  primaryBtn: {
    minHeight: 48,
    paddingHorizontal: Spacing.lg,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.md,
  },
  primaryBtnText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.base },

  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  loadingText: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.sm },

  lobbyCard: {
    margin: Spacing.base,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FCD34D',
  },
  lobbyHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.sm },
  lobbyTitle: { color: '#7F1D1D', fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  lobbyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  smallAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallAvatarText: { color: '#92400E', fontWeight: FontWeight.bold, fontSize: 12 },
  lobbyName: { flex: 1, color: '#1F2937', fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
  lobbyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },

  gridContent: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: 120,
    gap: Spacing.sm,
  },
  gridRow: {
    gap: Spacing.sm,
  },

  tile: {
    backgroundColor: '#1A1208',
    borderRadius: Radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(228,181,59,0.18)',
    marginBottom: Spacing.sm,
  },
  tileSuspended: { opacity: 0.55, borderColor: Colors.danger },
  tilePressed: { borderColor: Colors.primary, transform: [{ scale: 0.98 }] },
  tileVideo: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#0A0603',
  },
  tileVideoActive: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#15100A',
  },
  tileAvatarWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(228,181,59,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileAvatarText: {
    color: '#FFD34E',
    fontWeight: FontWeight.bold,
    fontSize: 20,
  },
  tileRoleBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  tileRoleText: { fontSize: 10, fontWeight: FontWeight.bold },
  tileTopRight: {
    position: 'absolute',
    top: 6,
    right: 6,
    flexDirection: 'row',
    gap: 4,
  },
  handRaisedBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  suspendedBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  tileName: { flex: 1, color: Colors.white, fontWeight: FontWeight.semibold, fontSize: 13 },
  tileMicWrap: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileLongPressHint: {
    position: 'absolute',
    bottom: 36,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  tileLongPressHintText: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 9,
    fontWeight: FontWeight.medium,
  },

  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Spacing.xxl,
    gap: Spacing.sm,
  },
  emptyTitle: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  emptyBody: { color: 'rgba(255,255,255,0.5)', fontSize: FontSize.sm },

  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(11,7,3,0.96)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(228,181,59,0.18)',
  },
  bottomBarRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.base,
  },
  selfControlWrap: { alignItems: 'center', gap: 4, minWidth: 64 },
  selfControlBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  selfControlBtnActive: { backgroundColor: '#FACC15' },
  selfControlBtnDanger: { backgroundColor: Colors.danger },
  selfControlLabel: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 11,
    fontWeight: FontWeight.medium,
  },

  /* Admin sheet */
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: Spacing.lg,
    gap: Spacing.sm,
    ...Shadow.lg,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
    paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
  },
  sheetAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: 14 },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  sheetSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 14,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.md,
  },
  sheetRowSelected: { backgroundColor: Colors.primaryLight },
  sheetRowText: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium },

  /* Chat modal */
  chatContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  chatTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  chatListContent: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
    flexGrow: 1,
  },
  chatEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Spacing.xxl,
    gap: Spacing.sm,
  },
  chatEmptyText: { color: Colors.textMuted, fontSize: FontSize.sm },

  bubbleRow: {
    flexDirection: 'row',
    marginVertical: 4,
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  bubbleOther: {
    backgroundColor: Colors.bubbleIn,
    borderTopLeftRadius: 4,
    ...Shadow.sm,
  },
  bubbleMe: {
    backgroundColor: Colors.bubbleOut,
    borderTopRightRadius: 4,
  },
  bubbleSender: {
    fontSize: 11,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    marginBottom: 2,
  },
  bubbleText: { fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20 },
  bubbleAudienceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    backgroundColor: '#FEF3C7',
    marginBottom: 4,
  },
  bubbleAudienceText: {
    fontSize: 10,
    color: '#92400E',
    fontWeight: FontWeight.bold,
  },

  composerWrap: {
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    gap: 6,
  },
  audiencePill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  audiencePillText: {
    color: Colors.primaryDark,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: Colors.border },
});
