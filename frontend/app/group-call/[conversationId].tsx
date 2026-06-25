/**
 * Group Voice Call (mesh) — multi-party WebRTC voice room.
 *
 * Interops with the Smilers web app's mesh: one shared `callId`, one peer
 * connection per participant, Convex `api.signaling.*` for negotiation and
 * `api.conference.*` for the live roster. Voice only (no video) for now.
 *
 * Entry:
 *   /group-call/<conversationId>            → starts (rings) a new group call
 *   /group-call/<conversationId>?callId=... → joins an existing call
 *
 * NATIVE ONLY — react-native-webrtc does not run on web/Expo Go; this screen
 * renders an explanatory notice on web and must be validated on a real build.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';

import { api } from '../../src/convexApi';
import CallBackground from '../../src/components/CallBackground';
import InviteContactPicker from '../../src/components/InviteContactPicker';
import RTCViewWrapper from '../../src/lib/webrtc/RTCViewWrapper';
import { useReactiveSafeConvexQuery } from '../../src/hooks/useReactiveSafeConvexQuery';
import { getDisplayInitials, getResolvedDisplayName } from '../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';
import type { MeshController as MeshControllerType } from '../../src/lib/call/mesh/MeshController';

type Any = any;

interface RosterEntry {
  userId: string;
  name?: string;
  avatar?: string | null;
  isMuted?: boolean;
  handRaised?: boolean;
  connected?: boolean;
}

export default function GroupCallScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    conversationId?: string | string[];
    callId?: string | string[];
    video?: string | string[];
    adhoc?: string | string[];
  }>();
  const conversationId = Array.isArray(params.conversationId) ? params.conversationId[0] : params.conversationId;
  const paramCallId = Array.isArray(params.callId) ? params.callId[0] : params.callId;
  const videoParam = Array.isArray(params.video) ? params.video[0] : params.video;
  const adhocParam = Array.isArray(params.adhoc) ? params.adhoc[0] : params.adhoc;
  // ad-hoc multiparty (upgraded 1:1) calls can carry video; formal group voice
  // calls stay audio-only.
  const wantsVideo = videoParam === '1' || videoParam === 'true';
  const isAdhoc = adhocParam === '1' || adhocParam === 'true';
  const isWeb = Platform.OS === 'web';

  const me = useQuery(api.users.getCurrentUser, isWeb ? 'skip' : {}) as Any;
  const myUserId: string = me?._id || '';

  const [callId, setCallId] = useState<string | null>(paramCallId || null);
  const [starting, setStarting] = useState(!paramCallId);
  const [micEnabled, setMicEnabled] = useState(true);
  const [connectedPeers, setConnectedPeers] = useState<Record<string, boolean>>({});
  const [fatal, setFatal] = useState<string | null>(null);

  const initiateCall = useMutation(api.calls.initiateCall);
  const joinConference = useMutation((api as Any).conference.joinConference);
  const leaveConference = useMutation((api as Any).conference.leaveConference);
  const toggleSelfMute = useMutation((api as Any).conference.toggleSelfMute);
  const sendSignalM = useMutation(api.signaling.send);
  const markConsumed = useMutation(api.signaling.markConsumed);
  const inviteToCall = useMutation((api as Any).callInvites.invite);
  const answerInvite = useMutation((api as Any).callInvites.answerInvite);

  const controllerRef = useRef<MeshControllerType | null>(null);
  const joinedRef = useRef(false);
  const answeredInviteRef = useRef(false);
  const [remoteStreamURLs, setRemoteStreamURLs] = useState<Record<string, string>>({});
  const [localStreamURL, setLocalStreamURL] = useState<string | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(wantsVideo);
  const [invitePickerVisible, setInvitePickerVisible] = useState(false);

  // --- Start (ring) a new group call if no callId was passed in. ---
  useEffect(() => {
    if (isWeb || paramCallId || callId || !conversationId || !myUserId) return;
    let cancelled = false;
    (async () => {
      try {
        const res: Any = await initiateCall({ conversationId, callType: wantsVideo ? 'video' : 'voice' });
        const id = String(res?.callId || res?._id || res || '');
        if (!cancelled) {
          if (id) setCallId(id);
          else setFatal('Could not start the group call.');
          setStarting(false);
        }
      } catch (e: Any) {
        if (!cancelled) {
          setFatal(e?.message || 'Could not start the group call.');
          setStarting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isWeb, paramCallId, callId, conversationId, myUserId, initiateCall]);

  // --- Build the mesh controller + acquire mic + join the conference roster. ---
  useEffect(() => {
    if (isWeb || !callId || !myUserId || controllerRef.current) return;
    let disposed = false;
    (async () => {
      try {
        const { MeshController } = await import('../../src/lib/call/mesh/MeshController');
        const { InCallAudio } = await import('../../src/lib/webrtc/inCallManager');
        const controller = new MeshController({
          callId,
          myUserId,
          video: wantsVideo,
          sendSignal: (toUserId, type, payload) => {
            void sendSignalM({ callId, toUserId, type, payload } as Any).catch(() => {});
          },
          onRemoteStreamsChanged: (streams) => {
            if (disposed) return;
            const map: Record<string, boolean> = {};
            const urls: Record<string, string> = {};
            Object.keys(streams).forEach((id) => {
              map[id] = true;
              try {
                const url = streams[id]?.toURL?.();
                if (url) urls[id] = url;
              } catch {}
            });
            setConnectedPeers(map);
            setRemoteStreamURLs(urls);
          },
          onError: () => {},
        });
        controllerRef.current = controller;
        await controller.start();
        try {
          const local = controller.getLocalStream?.();
          const url = local?.toURL?.();
          if (url && !disposed) setLocalStreamURL(url);
        } catch {}
        try {
          InCallAudio.start(wantsVideo ? 'video' : 'audio');
          InCallAudio.setSpeakerOn?.(true);
        } catch {}
        if (!joinedRef.current) {
          joinedRef.current = true;
          await joinConference({ callId }).catch(() => {});
        }
      } catch (e: Any) {
        if (!disposed) setFatal(e?.message || 'Microphone unavailable.');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [isWeb, callId, myUserId, sendSignalM, joinConference]);

  // --- Live roster from the conference backend. ---
  const participantsQ = useReactiveSafeConvexQuery<Any[]>(
    (api as Any).conference.getParticipants,
    !isWeb && callId ? { callId } : undefined,
    [],
    !!(!isWeb && callId),
  );
  const rawParticipants = (participantsQ.data || []) as Any[];

  // --- Ad-hoc invite roster (ring/answer status + auto-answer my own invite). ---
  const callInvitesQ = useReactiveSafeConvexQuery<Any[]>(
    (api as Any).callInvites.getCallInvites,
    !isWeb && callId ? { callId } : undefined,
    [],
    !!(!isWeb && callId),
  );
  const callInvites = (callInvitesQ.data || []) as Any[];

  // When I arrive into an ad-hoc call because I was invited, mark my invite
  // "joined" (stops the ringing on the inviter's side + cancels auto-miss).
  // Mesh peering itself is driven by joinConference/getParticipants above; this
  // only updates the callInvites status the web roster UI reads.
  useEffect(() => {
    if (isWeb || !isAdhoc || !myUserId || answeredInviteRef.current) return;
    const mine = callInvites.find(
      (inv) => String(inv?.inviteeId) === myUserId && inv?.status === 'ringing',
    );
    if (!mine?._id) return;
    answeredInviteRef.current = true;
    void answerInvite({ inviteId: mine._id } as Any).catch(() => {});
  }, [isWeb, isAdhoc, myUserId, callInvites, answerInvite]);

  // Feed peer ids to the controller whenever the roster changes.
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const ids = rawParticipants
      .map((p) => String(p?.userId || p?._id || ''))
      .filter((id) => id && id !== myUserId);
    ctrl.syncParticipants(ids);
  }, [rawParticipants, myUserId]);

  // --- Incoming signaling → route to the controller, then mark consumed. ---
  const signalsQ = useReactiveSafeConvexQuery<Any[]>(
    (api as Any).signaling.poll,
    !isWeb && callId ? { callId } : undefined,
    [],
    !!(!isWeb && callId),
  );
  const rawSignals = (signalsQ.data || []) as Any[];

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || !myUserId || rawSignals.length === 0) return;
    const mine = rawSignals.filter(
      (s) => s && String(s.toUserId) === myUserId && String(s.fromUserId) !== myUserId,
    );
    if (mine.length === 0) return;
    mine.forEach((s) => {
      try {
        ctrl.handleSignal(String(s.fromUserId), s.type, String(s.payload));
      } catch {}
    });
    const ids = mine.map((s) => s._id).filter(Boolean);
    if (ids.length > 0) void markConsumed({ messageIds: ids } as Any).catch(() => {});
  }, [rawSignals, myUserId, markConsumed]);

  // --- Cleanup on unmount. ---
  useEffect(() => {
    return () => {
      try {
        controllerRef.current?.close();
      } catch {}
      controllerRef.current = null;
      if (!isWeb && callId) {
        void leaveConference({ callId }).catch(() => {});
        import('../../src/lib/webrtc/inCallManager')
          .then((m) => m.InCallAudio.stop())
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleMute = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const next = !micEnabled;
    ctrl.setMicEnabled(next);
    setMicEnabled(next);
    if (callId) void toggleSelfMute({ callId, isMuted: !next } as Any).catch(() => {});
  }, [micEnabled, callId, toggleSelfMute]);

  const handleLeave = useCallback(() => {
    try {
      controllerRef.current?.close();
    } catch {}
    controllerRef.current = null;
    if (callId) void leaveConference({ callId } as Any).catch(() => {});
    router.back();
  }, [callId, leaveConference, router]);

  const handleToggleCamera = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const next = !cameraEnabled;
    ctrl.setVideoEnabled(next);
    setCameraEnabled(next);
  }, [cameraEnabled]);

  const handleInvite = useCallback(
    async (inviteeId: string, name: string) => {
      if (!callId) return;
      try {
        await inviteToCall({ callId, inviteeId } as Any);
      } catch (e: Any) {
        Alert.alert('Could not add', e?.message || `Failed to ring ${name}.`);
        throw e;
      }
    },
    [callId, inviteToCall],
  );

  // user ids already in the call (so the picker hides them).
  const inCallUserIds = useMemo(
    () => rawParticipants.map((p) => String(p?.userId || p?._id || '')).filter(Boolean),
    [rawParticipants],
  );

  const roster: RosterEntry[] = useMemo(() => {
    const deviceIndex: Any = undefined;
    return rawParticipants.map((p) => {
      const userId = String(p?.userId || p?._id || '');
      const name = getResolvedDisplayName(
        { _id: userId, name: p?.name || p?.userName, phone: p?.phone },
        deviceIndex,
        null,
      );
      return {
        userId,
        name,
        avatar: p?.avatar || p?.userAvatar || null,
        isMuted: p?.isMuted,
        handRaised: p?.handRaised,
        connected: userId === myUserId ? true : !!connectedPeers[userId],
      };
    });
  }, [rawParticipants, connectedPeers, myUserId]);

  if (isWeb) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Ionicons name="call-outline" size={42} color={Colors.textMuted} />
          <Text style={styles.noticeTitle}>Group calls run on the mobile app</Text>
          <Text style={styles.noticeBody}>Open Smilers on your phone to join a group voice call.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="group-call-screen">
      <CallBackground variant="warm" />
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{wantsVideo ? 'Group video call' : 'Group voice call'}</Text>
          <Text style={styles.headerSubtitle}>
            {roster.length > 0 ? `${roster.length} in call` : 'Connecting…'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.addHeaderBtn}
          onPress={() => setInvitePickerVisible(true)}
          disabled={!callId}
          testID="group-call-add-btn"
        >
          <Ionicons name="person-add" size={18} color={Colors.headerBg} />
          <Text style={styles.addHeaderBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      {fatal ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={42} color={Colors.danger} />
          <Text style={styles.noticeTitle}>Couldn’t start the call</Text>
          <Text style={styles.noticeBody}>{fatal}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => router.back()}>
            <Text style={styles.retryBtnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      ) : starting || !callId ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.noticeBody}>Starting group call…</Text>
        </View>
      ) : (
        <FlatList
          data={roster}
          keyExtractor={(p) => p.userId}
          numColumns={2}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => {
            const isMe = item.userId === myUserId;
            const streamURL = isMe ? localStreamURL : remoteStreamURLs[item.userId];
            const showTileVideo = wantsVideo && !!streamURL && (isMe ? cameraEnabled : true);
            return (
              <View
                style={[styles.tile, wantsVideo ? styles.tileVideo : null]}
                testID={`group-call-tile-${item.userId}`}
              >
                {showTileVideo ? (
                  <RTCViewWrapper
                    streamURL={streamURL}
                    style={StyleSheet.absoluteFill}
                    objectFit="cover"
                    mirror={isMe}
                  />
                ) : (
                  <View style={[styles.avatar, item.connected ? styles.avatarConnected : null]}>
                    <Text style={styles.avatarText}>{getDisplayInitials(item.name || 'U', 1)}</Text>
                  </View>
                )}
                <View style={wantsVideo ? styles.tileLabelOverlay : undefined}>
                  <Text style={styles.tileName} numberOfLines={1}>
                    {isMe ? 'You' : item.name || 'Member'}
                  </Text>
                  <View style={styles.tileStatusRow}>
                    <Feather
                      name={item.isMuted ? 'mic-off' : 'mic'}
                      size={13}
                      color={item.isMuted ? Colors.danger : Colors.success}
                    />
                    <Text style={styles.tileStatus}>
                      {isMe
                        ? micEnabled
                          ? 'You'
                          : 'Muted'
                        : item.connected
                          ? 'Connected'
                          : 'Connecting…'}
                    </Text>
                  </View>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
              <Text style={styles.noticeBody}>Waiting for participants…</Text>
            </View>
          }
        />
      )}

      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.controlBtn, !micEnabled ? styles.controlBtnActive : null]}
          onPress={handleToggleMute}
          testID="group-call-mute-btn"
        >
          <Feather name={micEnabled ? 'mic' : 'mic-off'} size={24} color={Colors.textPrimary} />
          <Text style={styles.controlLabel}>{micEnabled ? 'Mute' : 'Unmute'}</Text>
        </TouchableOpacity>
        {wantsVideo ? (
          <TouchableOpacity
            style={[styles.controlBtn, !cameraEnabled ? styles.controlBtnActive : null]}
            onPress={handleToggleCamera}
            testID="group-call-camera-btn"
          >
            <Feather
              name={cameraEnabled ? 'video' : 'video-off'}
              size={24}
              color={Colors.textPrimary}
            />
            <Text style={styles.controlLabel}>{cameraEnabled ? 'Camera' : 'Off'}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.controlBtn, styles.leaveBtn]}
          onPress={handleLeave}
          testID="group-call-leave-btn"
        >
          <Feather name="phone-off" size={24} color={Colors.white} />
          <Text style={[styles.controlLabel, { color: Colors.white }]}>Leave</Text>
        </TouchableOpacity>
      </View>

      <InviteContactPicker
        visible={invitePickerVisible}
        onClose={() => setInvitePickerVisible(false)}
        excludeUserIds={inCallUserIds}
        onInvite={handleInvite}
        title="Add to call"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.headerBg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.white },
  headerSubtitle: { fontSize: FontSize.sm, color: '#E6D9B0', marginTop: 2 },
  addHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    height: 38,
    borderRadius: 19,
  },
  addHeaderBtnText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  grid: { padding: Spacing.base, gap: Spacing.md },
  tile: {
    flex: 1,
    margin: Spacing.xs,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    gap: 8,
  },
  tileVideo: {
    height: 220,
    paddingVertical: 0,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    backgroundColor: '#000',
  },
  tileLabelOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    gap: 2,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#5A431A',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  avatarConnected: { borderColor: Colors.success },
  avatarText: { color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold },
  tileName: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.semibold, maxWidth: 130 },
  tileStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tileStatus: { color: '#E6D9B0', fontSize: FontSize.xs },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.xl,
    paddingVertical: Spacing.lg,
    paddingBottom: Spacing.xl,
  },
  controlBtn: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  controlBtnActive: { backgroundColor: '#FCD34D' },
  leaveBtn: { backgroundColor: Colors.danger },
  controlLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, padding: Spacing.lg },
  noticeTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.white, textAlign: 'center' },
  noticeBody: { fontSize: FontSize.sm, color: '#E6D9B0', textAlign: 'center' },
  retryBtn: {
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.base },
});
