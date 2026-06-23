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
  ScrollView,
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
import { useConferenceMesh } from '../../../src/lib/call/mesh/useConferenceMesh';
import { getDisplayInitials } from '../../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../../src/theme';

// Speaker-timer countdown. Web's `getActiveTimer` returns no `endsAt` — it
// gives `{ durationSeconds, startedAt (ISO), status, pausedAt?, elapsedBeforePause? }`.
// Remaining = duration − elapsed, where elapsed accumulates the time spent
// running (frozen while paused).
function computeTimerRemainingSec(t: any): number {
  if (!t) return 0;
  const duration = Number(t.durationSeconds) || 0;
  const startedAtMs = Date.parse(t.startedAt || '') || 0;
  const elapsedBeforePause = Number(t.elapsedBeforePause) || 0;
  if (!startedAtMs) return Math.max(0, Math.round(duration - elapsedBeforePause));
  const refMs =
    t.status === 'paused' ? Date.parse(t.pausedAt || '') || startedAtMs : Date.now();
  const elapsed = elapsedBeforePause + Math.max(0, (refMs - startedAtMs) / 1000);
  return Math.max(0, Math.round(duration - elapsed));
}

// Map an RTCPeerConnectionState to a coarse link-quality bucket for the
// per-participant status dot. No `getStats` polling needed — the state
// transitions (new→connecting→connected, or disconnected/failed) already give
// a reliable signal of whether a peer's media is flowing.
function peerConnectionQuality(state?: string): 'good' | 'fair' | 'poor' {
  switch (state) {
    case 'connected':
    case 'completed':
      return 'good';
    case 'disconnected':
    case 'failed':
    case 'closed':
      return 'poor';
    default:
      // 'new' | 'connecting' | 'checking' | undefined
      return 'fair';
  }
}


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

  // --- Live voice+video mesh (web-interop conference media) ---
  // Peers = other active participants in the room. The mesh engine
  // (MeshController/MeshPeer) is shared with group calls; here it is driven by
  // `api.conferenceSignaling.*` keyed by conferenceId (no callId for conferences).
  // Breakout scoping: the mesh only connects participants in the SAME breakout
  // room (web exposes this via conferenceRoles.breakoutRoomId in getRoomState;
  // null/undefined = main room).
  const myBreakoutRoomId = (me as any)?.breakoutRoomId ?? null;
  const peerUserIds = useMemo(
    () =>
      active
        .filter(
          (p) =>
            p.userId &&
            p.userId !== myUserId &&
            (((p as any).breakoutRoomId ?? null) === myBreakoutRoomId),
        )
        .map((p) => p.userId),
    [active, myUserId, myBreakoutRoomId],
  );
  const isVideoConf = (state?.conference as any)?.type === 'video';
  // Local mic/camera mirrors so toggles take effect instantly; server state
  // syncs via the 3s room refetch (incl. admin force-mute).
  const [localMicOn, setLocalMicOn] = useState(true);
  const [localCamOn, setLocalCamOn] = useState(true);
  useEffect(() => {
    setLocalMicOn(!myMuted);
  }, [myMuted]);
  useEffect(() => {
    setLocalCamOn(myVideoEnabled);
  }, [myVideoEnabled]);
  const { remoteStreams, localStream, speaking, connectionStates } = useConferenceMesh({
    conferenceId,
    myUserId,
    peerUserIds,
    isActive: isValid && !!myUserId,
    micEnabled: localMicOn,
    videoEnabled: isVideoConf,
    cameraOn: localCamOn,
  });

  // Native-only RTCView (video tiles). Web/Expo Go get a null stub.
  const [RTCViewImpl, setRTCViewImpl] = useState<any>(null);
  useEffect(() => {
    if (Platform.OS === 'web' || !isVideoConf) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('../../../src/lib/webrtc/RTCViewWrapper');
      if (mod?.default) setRTCViewImpl(() => mod.default);
    } catch {
      /* RTCView unavailable — fall back to avatar tiles */
    }
  }, [isVideoConf]);

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
  // Toolbar pill actions (graceful fallback when functions don't exist):
  // Web-team confirmed: speaker timer lives in `api.conferenceSpeakerTimer.*`
  // (start with `durationSeconds`; end via `stopTimer({ timerId })` — there is
  // no `endTimer`).
  const startTimerM = useMutation((api as any).conferenceSpeakerTimer.startTimer);
  const stopTimerM = useMutation((api as any).conferenceSpeakerTimer.stopTimer);
  const appendMinutesM = useMutation((api as any).conferenceMinutes.addEntry);
  const sendReactionM = useMutation((api as any).conferenceReactions.sendReaction);
  const muteAllM = useMutation((api as any).chairControls.muteAll); // eslint-disable-line @typescript-eslint/no-unused-vars
  // Confirmed canonical contracts (iter 154):
  //   Motions   → api.conferenceMotions.proposeMotion / getMotions
  //   Polls     → api.conferencePolls.createPoll / getPolls
  //   Breakout  → api.breakoutRooms.createRoom / closeRoom / getRooms
  const createBreakoutRoomM = useMutation((api as any).breakoutRooms.createRoom);
  const closeBreakoutRoomM = useMutation((api as any).breakoutRooms.closeRoom); // eslint-disable-line @typescript-eslint/no-unused-vars
  const proposeMotionM = useMutation((api as any).conferenceMotions.proposeMotion);
  const createPollM = useMutation((api as any).conferencePolls.createPoll);
  const joinBreakoutRoomM = useMutation((api as any).breakoutRooms.joinRoom);
  const castMotionVoteM = useMutation((api as any).conferenceMotions.castVote);
  const votePollM = useMutation((api as any).conferencePolls.vote);

  // List queries for drawer panels (graceful fallback to []).
  const { data: motions } = useSafeConvexQuery<any[]>(
    (api as any).conferenceMotions.getMotions,
    { conferenceId },
    [],
    !!conferenceId,
  );
  const { data: polls } = useSafeConvexQuery<any[]>(
    (api as any).conferencePolls.getPolls,
    { conferenceId },
    [],
    !!conferenceId,
  );
  const { data: breakoutRooms } = useSafeConvexQuery<any[]>(
    (api as any).breakoutRooms.getRooms,
    { conferenceId },
    [],
    !!conferenceId,
  );
  // Confirmed read queries (web contract): minutes log, active speaker timer, recent reactions.
  const { data: minutesEntries } = useSafeConvexQuery<any[]>(
    (api as any).conferenceMinutes.getMinutes,
    { conferenceId },
    [],
    !!conferenceId,
  );
  const { data: activeTimer } = useSafeConvexQuery<any>(
    (api as any).conferenceSpeakerTimer.getActiveTimer,
    { conferenceId },
    null,
    !!conferenceId,
  );
  const { data: recentReactions } = useSafeConvexQuery<any[]>(
    (api as any).conferenceReactions.getRecentReactions,
    { conferenceId },
    [],
    !!conferenceId,
  );

  // --- Toolbar panel state ---
  const [activePanel, setActivePanel] = useState<
    null | 'minutes' | 'timer' | 'motions' | 'polls' | 'breakout' | 'chat' | 'e2ee' | 'participants'
  >(null);
  const closePanel = useCallback(() => setActivePanel(null), []);

  // --- Floating reactions overlay (incoming reactions) ---
  const incomingReactions: any[] = Array.isArray(recentReactions)
    ? recentReactions
    : Array.isArray((state as any)?.recentReactions)
      ? (state as any).recentReactions
      : [];

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

  // --- Speaker-timer 1s ticker: re-render every second while a countdown is
  //     active so the "Xs remaining" label decrements smoothly (refetchState
  //     only fires every 3s, which made the countdown jump). ---
  const [, setClockTick] = useState(0);
  const timerHasCountdown = (activeTimer as any)?.status === 'running';
  useEffect(() => {
    if (!timerHasCountdown) return;
    const id = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timerHasCountdown]);

  // --- Local UI state ---
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
    setLocalMicOn((v) => !v); // instant local mic cut/restore via the mesh
    await safeMutate('Toggle mute', async () => toggleMuteM({ conferenceId, isMuted: !myMuted }));
    void refetchState();
  }, [conferenceId, myMuted, refetchState, toggleMuteM]);

  const handleToggleSelfVideo = useCallback(async () => {
    setLocalCamOn((v) => !v); // instant local camera on/off via the mesh
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
            onPress={() => setActivePanel('chat')}
            hitSlop={10}
            style={styles.headerActionBtn}
            testID="conf-open-chat"
          >
            <Ionicons name="chatbubbles-outline" size={24} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Horizontal pill toolbar — per Smilers web parity */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillBarContent}
        style={styles.pillBar}
        testID="conf-pillbar"
      >
        <ToolbarPill
          icon="file-document-outline"
          tint="#FFFFFF"
          bg="rgba(255,255,255,0.08)"
          onPress={() => setActivePanel('minutes')}
          testID="conf-pill-minutes"
        />
        <ToolbarPill
          icon="timer-outline"
          tint="#F59E0B"
          bg="rgba(245,158,11,0.18)"
          onPress={() => setActivePanel('timer')}
          testID="conf-pill-timer"
        />
        <ToolbarPill
          icon="gavel"
          tint="#A855F7"
          bg="rgba(168,85,247,0.18)"
          onPress={() => setActivePanel('motions')}
          testID="conf-pill-motions"
        />
        <ToolbarPill
          icon="poll"
          tint="#14B8A6"
          bg="rgba(20,184,166,0.18)"
          onPress={() => setActivePanel('polls')}
          testID="conf-pill-polls"
        />
        <ToolbarPill
          icon="view-grid-outline"
          tint="#818CF8"
          bg="rgba(129,140,248,0.18)"
          onPress={() => setActivePanel('breakout')}
          testID="conf-pill-breakout"
        />
        <ToolbarPill
          icon="chat-outline"
          tint="#38BDF8"
          bg="rgba(56,189,248,0.18)"
          onPress={() => setActivePanel('chat')}
          testID="conf-pill-chat"
        />
        <ToolbarPill
          icon="shield-check-outline"
          tint="#10B981"
          bg="rgba(16,185,129,0.18)"
          onPress={() => setActivePanel('e2ee')}
          testID="conf-pill-e2ee"
        />
        <ToolbarPill
          icon={myMuted ? 'microphone-off' : 'microphone'}
          tint={myMuted ? '#EF4444' : '#FFFFFF'}
          bg={myMuted ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.08)'}
          onPress={handleToggleSelfMute}
          testID="conf-pill-mute"
        />
        <ToolbarPill
          icon={myVideoEnabled ? 'video' : 'video-off'}
          tint={myVideoEnabled ? '#FFFFFF' : '#EF4444'}
          bg={myVideoEnabled ? 'rgba(255,255,255,0.08)' : 'rgba(239,68,68,0.18)'}
          onPress={handleToggleSelfVideo}
          testID="conf-pill-camera"
        />
        <ToolbarPill
          icon="account-multiple-outline"
          tint="#FFFFFF"
          bg="rgba(255,255,255,0.08)"
          onPress={() => setActivePanel('participants')}
          badgeCount={active.length}
          testID="conf-pill-participants"
        />
        <ToolbarPill
          icon="emoticon-happy-outline"
          tint="#3D2A00"
          bg="#FACC15"
          onPress={() => {
            void safeMutate('Send reaction', async () => sendReactionM({ conferenceId, emoji: '\uD83C\uDF89' }));
          }}
          testID="conf-pill-reactions"
        />
      </ScrollView>

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
          renderItem={({ item }) => {
            const tileStream = item.userId === myUserId ? localStream : remoteStreams[item.userId];
            const streamURL = tileStream?.toURL ? tileStream.toURL() : null;
            return (
              <ParticipantTile
                participant={item}
                isMe={item.userId === myUserId}
                canManage={isChair && item.userId !== myUserId}
                width={tileWidth}
                height={tileHeight}
                streamURL={streamURL}
                RTCViewImpl={RTCViewImpl}
                mirror={item.userId === myUserId}
                isSpeaking={item.userId === myUserId ? !!speaking.__local : !!speaking[item.userId]}
                onLongPress={() => (isChair && item.userId !== myUserId ? setActionTarget(item) : undefined)}
              />
            );
          }}
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
            onPress={() => setActivePanel('chat')}
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
        visible={activePanel === 'chat'}
        onClose={closePanel}
        conferenceId={conferenceId!}
        myUserId={myUserId}
        myRole={myRole}
      />

      {/* Side drawer panels (Participants / E2EE info / Breakout / Motions / Polls / Timer / Minutes) */}
      <SideDrawerPanel
        visible={activePanel === 'participants'}
        title={`Participants (${active.length})`}
        icon="account-multiple-outline"
        accent="#FFFFFF"
        onClose={closePanel}
      >
        {active.length === 0 ? (
          <Text style={styles.panelEmpty}>No one in the room yet.</Text>
        ) : (
          active.map((p) => {
            const cfg = getRoleConfig(normalizeRole(p.role));
            return (
              <View key={p.userId} style={styles.panelRow}>
                <View style={styles.panelAvatar}>
                  <Text style={styles.panelAvatarText}>{getDisplayInitials(p.name || 'U', 1)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.panelRowTitle} numberOfLines={1}>
                    {(p.name || 'Unknown').toUpperCase()}
                  </Text>
                  <Text style={styles.panelRowSubtitle}>{cfg.label}</Text>
                </View>
                <Feather
                  name={p.isMuted ? 'mic-off' : 'mic'}
                  size={16}
                  color={p.isMuted ? '#EF4444' : '#10B981'}
                  style={{ marginRight: 8 }}
                />
                <MaterialCommunityIcons
                  name={p.videoEnabled === false ? 'video-off' : 'video'}
                  size={16}
                  color={p.videoEnabled === false ? '#EF4444' : '#10B981'}
                />
              </View>
            );
          })
        )}
      </SideDrawerPanel>

      <SideDrawerPanel
        visible={activePanel === 'e2ee'}
        title="End-to-End Encryption"
        icon="shield-check-outline"
        accent="#10B981"
        onClose={closePanel}
      >
        <View style={styles.panelInfoBlock}>
          {[
            'Chair enables E2EE and sets a passphrase',
            'Chair shares the passphrase securely (voice/DM)',
            'Participants enter the passphrase in chat',
            'Messages encrypted locally before sending',
            'Server never sees plaintext messages',
          ].map((line, i) => (
            <View key={i} style={styles.panelInfoRow}>
              <Text style={styles.panelInfoNumber}>{i + 1}.</Text>
              <Text style={styles.panelInfoText}>{line}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.panelHelper}>
          E2EE is configured from chat. Tap the encryption setting inside chat to set a passphrase.
        </Text>
      </SideDrawerPanel>

      <SideDrawerPanel
        visible={activePanel === 'breakout'}
        title="Breakout Rooms"
        icon="view-grid-outline"
        accent="#818CF8"
        onClose={closePanel}
      >
        <TouchableOpacity
          style={[styles.panelPrimaryBtn, { borderColor: '#818CF8' }]}
          activeOpacity={0.85}
          onPress={async () => {
            if (!isChair) {
              Alert.alert('Chair only', 'Only the Chair can create breakout rooms.');
              return;
            }
            await safeMutate('Create breakout room', async () =>
              createBreakoutRoomM({ conferenceId, name: `Room ${(breakoutRooms?.length || 0) + 1}` }),
            );
            void refetchState();
          }}
          testID="conf-breakout-new"
        >
          <Feather name="plus" size={18} color="#818CF8" />
          <Text style={[styles.panelPrimaryBtnText, { color: '#818CF8' }]}>New Room</Text>
        </TouchableOpacity>
        {Array.isArray(breakoutRooms) && breakoutRooms.length > 0 ? (
          breakoutRooms.map((r: any) => (
            <View key={String(r._id || r.id)} style={styles.panelRow} testID={`conf-breakout-${r._id || r.id}`}>
              <View style={[styles.panelAvatar, { backgroundColor: 'rgba(129,140,248,0.18)' }]}>
                <MaterialCommunityIcons name="view-grid-outline" size={18} color="#818CF8" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.panelRowTitle} numberOfLines={1}>{r.name || 'Room'}</Text>
                <Text style={styles.panelRowSubtitle}>
                  {Array.isArray(r.participants) ? `${r.participants.length} participant${r.participants.length === 1 ? '' : 's'}` : 'Open'}
                </Text>
              </View>
              <TouchableOpacity
                style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: 'rgba(129,140,248,0.18)' }}
                onPress={async () => {
                  await safeMutate('Join breakout room', async () =>
                    joinBreakoutRoomM({ conferenceId, roomId: r._id || r.id }),
                  );
                  void refetchState();
                }}
                testID={`conf-breakout-join-${r._id || r.id}`}
              >
                <Text style={{ color: '#818CF8', fontWeight: '700', fontSize: 13 }}>Join</Text>
              </TouchableOpacity>
            </View>
          ))
        ) : (
          <Text style={styles.panelEmpty}>No breakout rooms</Text>
        )}
      </SideDrawerPanel>

      <SideDrawerPanel
        visible={activePanel === 'motions'}
        title="Motions"
        icon="gavel"
        accent="#A855F7"
        onClose={closePanel}
      >
        <TouchableOpacity
          style={[styles.panelPrimaryBtn, { borderColor: '#A855F7' }]}
          activeOpacity={0.85}
          onPress={async () => {
            await safeMutate('Propose a motion', async () =>
              proposeMotionM({ conferenceId, title: `Motion #${(motions?.length || 0) + 1}` }),
            );
            void refetchState();
          }}
          testID="conf-motion-new"
        >
          <Feather name="plus" size={18} color="#A855F7" />
          <Text style={[styles.panelPrimaryBtnText, { color: '#A855F7' }]}>Propose a Motion</Text>
        </TouchableOpacity>
        {Array.isArray(motions) && motions.length > 0 ? (
          motions.map((m: any) => {
            const stateLabel = String(m.status || m.state || 'proposed');
            return (
              <View key={String(m._id || m.id)} style={styles.panelRow} testID={`conf-motion-${m._id || m.id}`}>
                <View style={[styles.panelAvatar, { backgroundColor: 'rgba(168,85,247,0.18)' }]}>
                  <MaterialCommunityIcons name="gavel" size={18} color="#A855F7" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.panelRowTitle} numberOfLines={2}>{m.title || m.text || 'Motion'}</Text>
                  <Text style={styles.panelRowSubtitle}>{stateLabel}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 4 }}>
                  {(['for', 'against', 'abstain'] as const).map((v) => (
                    <TouchableOpacity
                      key={v}
                      onPress={async () => {
                        await safeMutate('Cast vote', async () => castMotionVoteM({ motionId: m._id || m.id, vote: v }));
                        void refetchState();
                      }}
                      style={{ paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, backgroundColor: 'rgba(168,85,247,0.18)' }}
                      testID={`conf-motion-vote-${v}-${m._id || m.id}`}
                    >
                      <Text style={{ color: '#A855F7', fontSize: 11, fontWeight: '700' }}>
                        {v === 'for' ? 'For' : v === 'against' ? 'Vs' : 'Abs'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            );
          })
        ) : (
          <Text style={styles.panelEmpty}>No motions yet</Text>
        )}
      </SideDrawerPanel>

      <SideDrawerPanel
        visible={activePanel === 'polls'}
        title="Polls"
        icon="poll"
        accent="#14B8A6"
        onClose={closePanel}
      >
        <TouchableOpacity
          style={[styles.panelPrimaryBtn, { borderColor: '#14B8A6' }]}
          activeOpacity={0.85}
          onPress={async () => {
            if (!isChair) {
              Alert.alert('Chair only', 'Only the Chair can create polls.');
              return;
            }
            await safeMutate('Create poll', async () =>
              createPollM({
                conferenceId,
                question: `Poll #${(polls?.length || 0) + 1}`,
                options: ['Yes', 'No', 'Abstain'],
              }),
            );
            void refetchState();
          }}
          testID="conf-poll-new"
        >
          <Feather name="plus" size={18} color="#14B8A6" />
          <Text style={[styles.panelPrimaryBtnText, { color: '#14B8A6' }]}>Create Poll</Text>
        </TouchableOpacity>
        {Array.isArray(polls) && polls.length > 0 ? (
          polls.map((p: any) => {
            const closed = p.status === 'closed' || p.closed === true;
            return (
              <View
                key={String(p._id || p.id)}
                style={[styles.panelRow, { flexDirection: 'column', alignItems: 'stretch' }]}
                testID={`conf-poll-${p._id || p.id}`}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={[styles.panelAvatar, { backgroundColor: 'rgba(20,184,166,0.18)' }]}>
                    <MaterialCommunityIcons name="poll" size={18} color="#14B8A6" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.panelRowTitle} numberOfLines={2}>{p.question || 'Poll'}</Text>
                    <Text style={styles.panelRowSubtitle}>
                      {closed ? 'Closed' : `${Array.isArray(p.options) ? p.options.length : 0} options`}
                    </Text>
                  </View>
                </View>
                {Array.isArray(p.options) && p.options.length > 0 ? (
                  <View style={{ marginTop: 8, gap: 6 }}>
                    {p.options.map((o: any, idx: number) => {
                      const optionId = o?._id || o?.id || String(idx);
                      const label = o?.text || o?.label || o?.option || String(o);
                      // Confirmed web shape: counts live in `poll.voteCounts`
                      // (a { optionId: count } map), and the viewer's own
                      // selection(s) in `poll.myVotes` (optionId[]).
                      const count =
                        p?.voteCounts && typeof p.voteCounts[optionId] === 'number'
                          ? p.voteCounts[optionId]
                          : typeof o?.votes === 'number'
                            ? o.votes
                            : typeof o?.count === 'number'
                              ? o.count
                              : null;
                      const mine = Array.isArray(p?.myVotes) && p.myVotes.includes(optionId);
                      return (
                        <TouchableOpacity
                          key={optionId}
                          disabled={closed}
                          onPress={async () => {
                            await safeMutate('Vote', async () => votePollM({ pollId: p._id || p.id, optionId }));
                          }}
                          style={{
                            flexDirection: 'row',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            borderRadius: 8,
                            borderWidth: mine ? 1 : 0,
                            borderColor: mine ? '#14B8A6' : 'transparent',
                            backgroundColor: closed
                              ? 'rgba(255,255,255,0.05)'
                              : mine
                                ? 'rgba(20,184,166,0.28)'
                                : 'rgba(20,184,166,0.12)',
                          }}
                          testID={`conf-poll-opt-${optionId}`}
                        >
                          <Text style={{ color: Colors.white, fontSize: 13, flex: 1 }} numberOfLines={1}>
                            {mine ? '\u2713 ' : ''}{label}
                          </Text>
                          {count !== null ? (
                            <Text style={{ color: '#14B8A6', fontSize: 12, fontWeight: '700', marginLeft: 8 }}>
                              {count}
                            </Text>
                          ) : null}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })
        ) : (
          <Text style={styles.panelEmpty}>No polls yet</Text>
        )}
      </SideDrawerPanel>

      <SideDrawerPanel
        visible={activePanel === 'timer'}
        title="Protocol Timer"
        icon="timer-outline"
        accent="#F59E0B"
        onClose={closePanel}
      >
        <Text style={styles.panelSection}>DURATION</Text>
        <View style={styles.panelGrid}>
          {[1, 2, 3, 5, 10, 15].map((mins) => (
            <TouchableOpacity
              key={mins}
              style={styles.panelGridBtn}
              activeOpacity={0.85}
              onPress={async () => {
                await safeMutate('Start timer', async () =>
                  startTimerM({ conferenceId, durationSeconds: mins * 60 }),
                );
                void refetchState();
              }}
              testID={`conf-timer-${mins}min`}
            >
              <Text style={styles.panelGridBtnText}>{mins} min</Text>
            </TouchableOpacity>
          ))}
        </View>
        {activeTimer ? (
          <View style={{ marginTop: 12, padding: 12, borderRadius: 10, backgroundColor: 'rgba(245,158,11,0.15)' }}>
            <Text style={{ color: '#F59E0B', fontWeight: '700', fontSize: 13 }}>
              Timer {(activeTimer as any).status === 'paused' ? 'paused' : 'running'}
              {(activeTimer as any).speakerName ? ` · ${(activeTimer as any).speakerName}` : ''}
            </Text>
            <Text style={{ color: Colors.white, fontSize: 12, marginTop: 2 }}>
              {computeTimerRemainingSec(activeTimer)}s remaining
            </Text>
          </View>
        ) : null}
        <TouchableOpacity
          style={[styles.panelGhostBtn, { marginTop: 12 }]}
          onPress={async () => {
            const timerId = (activeTimer as any)?._id;
            if (!timerId) {
              closePanel();
              return;
            }
            await safeMutate('End timer', async () => stopTimerM({ timerId }));
            void refetchState();
          }}
          testID="conf-timer-end"
        >
          <Text style={styles.panelGhostBtnText}>End timer</Text>
        </TouchableOpacity>
      </SideDrawerPanel>

      <SideDrawerPanel
        visible={activePanel === 'minutes'}
        title="Minutes"
        icon="file-document-outline"
        accent="#FFFFFF"
        onClose={closePanel}
      >
        <Text style={styles.panelHelper}>
          {isPrivileged
            ? 'Private to the Chair & Clerk. Tap below to append a quick note.'
            : 'Minutes are recorded by the Chair & Clerk. You can view the log below.'}
        </Text>
        {isPrivileged ? (
          <TouchableOpacity
            style={[styles.panelPrimaryBtn, { borderColor: '#FFFFFF' }]}
            activeOpacity={0.85}
            onPress={async () => {
              await safeMutate('Append minute entry', async () =>
                appendMinutesM({ conferenceId, content: `Note logged at ${new Date().toLocaleTimeString()}`, category: 'note' }),
              );
              void refetchState();
            }}
            testID="conf-minutes-append"
          >
            <Feather name="edit-3" size={18} color="#FFFFFF" />
            <Text style={[styles.panelPrimaryBtnText, { color: '#FFFFFF' }]}>Append entry</Text>
          </TouchableOpacity>
        ) : null}
        {Array.isArray(minutesEntries) && minutesEntries.length > 0 ? (
          <View style={{ marginTop: 12, gap: 8 }}>
            {minutesEntries.map((m: any, i: number) => (
              <View
                key={String(m?._id || i)}
                style={{ padding: 10, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.06)' }}
              >
                <Text style={{ color: Colors.white, fontSize: 13 }}>{m?.text || m?.content || ''}</Text>
                {m?.authorName ? (
                  <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2 }}>{m.authorName}</Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : (
          <Text style={[styles.panelEmpty, { marginTop: 12 }]}>No minutes yet</Text>
        )}
      </SideDrawerPanel>

      {/* Floating reactions overlay (incoming) */}
      {incomingReactions.length > 0 ? (
        <View style={styles.reactionsOverlay} pointerEvents="none">
          {incomingReactions.slice(-3).map((r: any, i: number) => (
            <View key={`${r?._id || i}`} style={styles.reactionBubble}>
              <Text style={styles.reactionEmoji}>{String(r?.emoji || '\uD83C\uDF89')}</Text>
            </View>
          ))}
        </View>
      ) : null}
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
  streamURL,
  RTCViewImpl,
  mirror,
  isSpeaking,
  connectionQuality,
  onLongPress,
}: {
  participant: Participant;
  isMe: boolean;
  canManage: boolean;
  width: number;
  height: number;
  streamURL?: string | null;
  RTCViewImpl?: any;
  mirror?: boolean;
  isSpeaking?: boolean;
  connectionQuality?: 'good' | 'fair' | 'poor' | null;
  onLongPress?: () => void;
}) {
  const role = normalizeRole(participant.role);
  const roleCfg = getRoleConfig(role);
  const isMuted = !!participant.isMuted;
  const videoOn = participant.videoEnabled !== false;
  const isSuspended = participant.status === 'suspended';
  const handRaised = !!participant.handRaised;
  const showVideo = videoOn && !!streamURL && !!RTCViewImpl;

  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={300}
      style={({ pressed }) => [
        styles.tile,
        { width, height },
        isSuspended ? styles.tileSuspended : null,
        isSpeaking ? styles.tileSpeaking : null,
        pressed && canManage ? styles.tilePressed : null,
      ]}
      testID={`conf-tile-${participant.userId}`}
    >
      {/* Video area / avatar */}
      <View style={styles.tileVideo}>
        {showVideo ? (
          <RTCViewImpl
            streamURL={streamURL}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={!!mirror}
            zOrder={0}
          />
        ) : videoOn ? (
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
          {connectionQuality ? (
            <View
              style={[
                styles.tileQualityDot,
                {
                  backgroundColor:
                    connectionQuality === 'good'
                      ? Colors.success
                      : connectionQuality === 'fair'
                        ? '#F59E0B'
                        : Colors.danger,
                },
              ]}
              testID={`conf-tile-quality-${participant.userId}`}
            />
          ) : null}
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
  mci,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  mci?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const iconColor = danger ? Colors.white : active ? '#3D2A00' : Colors.white;
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
        {mci ? (
          <MaterialCommunityIcons name={icon as any} size={22} color={iconColor} />
        ) : (
          <Feather name={icon as any} size={22} color={iconColor} />
        )}
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

/* --------------------------- ToolbarPill --------------------------- */

function ToolbarPill({
  icon,
  tint,
  bg,
  badgeCount,
  onPress,
  testID,
}: {
  icon: string;
  tint: string;
  bg: string;
  badgeCount?: number;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.toolbarPill, { backgroundColor: bg }]}
      testID={testID}
    >
      <MaterialCommunityIcons name={icon as any} size={22} color={tint} />
      {typeof badgeCount === 'number' && badgeCount > 0 ? (
        <View style={styles.toolbarPillBadge}>
          <Text style={styles.toolbarPillBadgeText}>{badgeCount > 99 ? '99+' : String(badgeCount)}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

/* --------------------------- SideDrawerPanel --------------------------- */

function SideDrawerPanel({
  visible,
  title,
  icon,
  accent,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  icon: string;
  accent: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.drawerBackdrop} onPress={onClose}>
        <Pressable style={styles.drawerCard} onPress={() => {}}>
          <View style={styles.drawerHeader}>
            <MaterialCommunityIcons name={icon as any} size={20} color={accent} />
            <Text style={styles.drawerTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} testID="conf-drawer-close">
              <Text style={styles.drawerCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.drawerBody} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
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
  tileSpeaking: { borderColor: Colors.success, borderWidth: 3 },
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
    alignItems: 'center',
    gap: 4,
  },
  tileQualityDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: 'rgba(0,0,0,0.35)',
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

  /* Toolbar pill bar */
  pillBar: {
    flexGrow: 0,
    flexShrink: 0,
    height: 56,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(228,181,59,0.18)',
  },
  pillBarContent: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    gap: 10,
    alignItems: 'center',
  },
  toolbarPill: {
    width: 56,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    position: 'relative',
  },
  toolbarPillBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: '#FACC15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarPillBadgeText: {
    color: '#3D2A00',
    fontSize: 10,
    fontWeight: FontWeight.bold,
  },

  /* Side drawer panel */
  drawerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    flexDirection: 'row',
  },
  drawerCard: {
    flex: 1,
    marginLeft: 48,
    backgroundColor: '#0F0A04',
    borderTopLeftRadius: 16,
    borderBottomLeftRadius: 16,
    overflow: 'hidden',
  },
  drawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  drawerTitle: {
    flex: 1,
    color: Colors.white,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  drawerCloseText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  drawerBody: {
    padding: Spacing.base,
    gap: Spacing.sm,
  },

  /* Panel rows */
  panelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.04)',
    minHeight: 56,
  },
  panelAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(228,181,59,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelAvatarText: { color: '#FFD34E', fontWeight: FontWeight.bold, fontSize: 14 },
  panelRowTitle: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  panelRowSubtitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: FontSize.sm,
    marginTop: 2,
  },
  panelEmpty: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: FontSize.sm,
    textAlign: 'center',
    paddingVertical: Spacing.lg,
  },
  panelHelper: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: FontSize.sm,
    lineHeight: 20,
  },
  panelSection: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.2,
    marginTop: Spacing.sm,
  },
  panelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  panelGridBtn: {
    flexBasis: '30%',
    flexGrow: 1,
    paddingVertical: 14,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelGridBtnText: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  panelPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  panelPrimaryBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  panelGhostBtn: {
    minHeight: 44,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelGhostBtnText: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  panelInfoBlock: {
    gap: Spacing.sm,
  },
  panelInfoRow: {
    flexDirection: 'row',
    gap: 8,
  },
  panelInfoNumber: {
    color: '#10B981',
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    width: 24,
  },
  panelInfoText: {
    flex: 1,
    color: Colors.white,
    fontSize: FontSize.base,
    lineHeight: 22,
  },

  /* Floating reactions overlay */
  reactionsOverlay: {
    position: 'absolute',
    right: 8,
    top: '30%',
    gap: 6,
  },
  reactionBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionEmoji: {
    fontSize: 20,
  },
});
