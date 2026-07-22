/**
 * StreamCallInner — production 1:1 call screen powered by Stream Video (NATIVE).
 *
 * HYBRID model (see /app/memory/STREAM_MIGRATION.md):
 *   • RINGING / wake-up / custom ringtone / Answer-Decline  → Ashwini's native
 *     FCM doorbell (unchanged). We create the call with ring:false so Stream
 *     sends NO push of its own.
 *   • CALL STATE (ringing→active→ended, decline propagation, in-app incoming)  →
 *     the existing Convex `calls` lifecycle (initiateCall / answerCall / endCall),
 *     so this screen interoperates with the doorbell and the callee's listener.
 *   • MEDIA / CONNECTION  → Stream (the reliability fix). Both sides join the
 *     SAME call keyed to conversationId; media flows over Stream's SFU.
 *
 * Rendered by <CallHost/> for NORMAL 1:1 calls only (screen-only / conference
 * calls still use the legacy CallScreenInner). CallHost provides the full/mini
 * (PIP) wrapper, so minimize() works here too.
 *
 * Extras still on the legacy path (to be layered on next): screen-share,
 * interpreter, call-waiting.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
// @ts-expect-error — native-only Stream SDK, resolved in the dev/prod build
import {
  StreamVideo,
  StreamCall,
  ParticipantView,
  NoiseCancellationProvider,
  useCall,
  useCallStateHooks,
  useNoiseCancellation,
  useScreenShareButton,
  useAutoEnterPiPEffect,
  useIsInPiPMode,
  CallingState,
} from '@stream-io/video-react-native-sdk';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convexApi';
import { createStreamVideoClient } from '../../lib/stream/streamClient';
import { callHost, useCallHost } from '../../lib/call/callHost';
import { useReactiveSafeConvexQuery } from '../../hooks/useReactiveSafeConvexQuery';
import { InterpreterLayer } from '../interpreter/InterpreterLayer';
import { InCallAudio } from '../../lib/webrtc/inCallManager';
import * as Haptics from 'expo-haptics';
import { Colors } from '../../theme';

function fmt(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * Auto-enable Stream's Krisp noise + echo cancellation on join when the device
 * supports advanced audio processing. Renders nothing. Native processors are
 * registered in MainApplication.kt (Android) / AppDelegate.swift (iOS).
 */
function NoiseCancellationAutoEnable() {
  const nc = useNoiseCancellation?.() as any;
  useEffect(() => {
    if (!nc) return;
    const { isSupported, deviceSupportsAdvancedAudioProcessing, isEnabled, setEnabled } = nc;
    if (deviceSupportsAdvancedAudioProcessing && isSupported && !isEnabled && setEnabled) {
      try {
        const r = setEnabled(true);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {}
    }
  }, [nc]);
  return null;
}

type CallUIProps = {
  isVideo: boolean;
  isCaller: boolean;
  peerName: string;
  convStatus: string | undefined;
  callId: string | null;
  onHangup: () => void;
};

/** In-call UI (inside StreamCall context). */
function CallUI({ isVideo, isCaller, peerName, convStatus, callId, onHangup }: CallUIProps) {
  const call = useCall();
  const { mode } = useCallHost();
  const isMini = mode === 'mini';
  const { useCallCallingState, useRemoteParticipants, useLocalParticipant, useParticipants, useHasOngoingScreenShare } =
    useCallStateHooks();
  const callingState = useCallCallingState();
  const remoteParticipants = useRemoteParticipants();
  const local = useLocalParticipant();
  const participants = useParticipants();
  const hasScreenShare = useHasOngoingScreenShare();

  // System Picture-in-Picture (Android): auto-enter PiP when the user leaves
  // the app mid-call; render a stripped-down layout while floating.
  useAutoEnterPiPEffect(false);
  const inPiP = useIsInPiPMode();

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(isVideo);
  const [seconds, setSeconds] = useState(0);
  const wasConnectedRef = useRef(false);

  // Noise / echo cancellation state (Krisp). Only surfaced when the device
  // supports advanced audio processing (native build only).
  const nc = useNoiseCancellation?.() as any;
  const ncSupported = !!(nc?.deviceSupportsAdvancedAudioProcessing && nc?.isSupported);
  const ncEnabled = !!nc?.isEnabled;
  const toggleNc = useCallback(() => {
    if (!nc?.setEnabled) return;
    try {
      const r = nc.setEnabled(!nc.isEnabled);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  }, [nc]);

  const remote = remoteParticipants[0];
  const connected = callingState === CallingState.JOINED && !!remote;

  useEffect(() => {
    if (!call) return;
    (async () => {
      try {
        await call.microphone.enable();
        if (isVideo) await call.camera.enable();
        else await call.camera.disable();
      } catch {}
    })();
  }, [call, isVideo]);

  useEffect(() => {
    if (!connected) return;
    wasConnectedRef.current = true;
    const t = setInterval(() => setSeconds((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [connected]);

  // End when Convex says ended/declined — but ONLY during the ring phase.
  // Once media is connected, the Stream session is authoritative; a ring
  // TTL/timeout on the Convex record must NOT drop a live call (this was
  // killing connected calls at ~60s).
  useEffect(() => {
    if (wasConnectedRef.current) return;
    if (convStatus === 'ended' || convStatus === 'declined') onHangup();
  }, [convStatus, onHangup]);

  // End if the remote genuinely leaves AFTER connecting — debounced so a
  // transient ICE reconnect (remote momentarily 0 participants) doesn't kill
  // the call. Only hangs up if the remote stays gone for 10s.
  useEffect(() => {
    if (!wasConnectedRef.current) return;
    if (remoteParticipants.length > 0) return;
    const t = setTimeout(() => onHangup(), 10000);
    return () => clearTimeout(t);
  }, [remoteParticipants.length, onHangup]);

  const toggleMic = useCallback(async () => {
    if (!call) return;
    try {
      await call.microphone.toggle();
      setMicOn((v) => !v);
    } catch {}
  }, [call]);
  const toggleCam = useCallback(async () => {
    if (!call) return;
    try {
      await call.camera.toggle();
      setCamOn((v) => !v);
    } catch {}
  }, [call]);
  const flipCam = useCallback(async () => {
    if (!call) return;
    try {
      await call.camera.flip();
    } catch {}
  }, [call]);

  // Screen share (Stream). Android uses the system MediaProjection dialog (the
  // foreground service is already wired via withWebRTCScreenshare); iOS uses
  // in-app capture (no broadcast-extension target needed). The ref is only
  // required for iOS broadcast mode, so null is fine here.
  const screenSharePickerRef = useRef<any>(null);
  const { onPress: toggleScreenShare, hasPublishedScreenShare } = useScreenShareButton(
    screenSharePickerRef,
    undefined,
    undefined,
    () => {},
    { type: 'inApp' },
  ) as any;
  // The participant currently sharing their screen (local or remote).
  const sharer = (participants || []).find((p: any) => p?.screenShareStream);

  const statusLine = connected
    ? fmt(seconds)
    : isCaller
      ? 'Ringing…'
      : 'Connecting…';

  // MINI (PIP) — compact tap-to-expand tile.
  if (isMini) {
    return (
      <TouchableOpacity
        activeOpacity={0.9}
        style={styles.miniRoot}
        onPress={() => callHost.maximize()}
      >
        {isVideo && remote ? (
          <ParticipantView participant={remote} style={StyleSheet.absoluteFill as any} />
        ) : (
          <View style={styles.miniCenter}>
            <Ionicons name="call" size={22} color={Colors.white} />
            <Text style={styles.miniText} numberOfLines={1}>
              {connected ? fmt(seconds) : statusLine}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.callRoot}>
      <View style={styles.remoteArea}>
        {hasScreenShare && sharer ? (
          <ParticipantView
            participant={sharer}
            trackType="screenShareTrack"
            objectFit="contain"
            style={StyleSheet.absoluteFill as any}
          />
        ) : isVideo && remote ? (
          <ParticipantView participant={remote} style={StyleSheet.absoluteFill as any} />
        ) : (
          <View style={styles.centerFill}>
            <View style={styles.avatarBig}>
              <Ionicons name="person" size={64} color={Colors.white} />
            </View>
            <Text style={styles.peerName} numberOfLines={1}>
              {peerName}
            </Text>
            <Text style={styles.statusText}>{statusLine}</Text>
          </View>
        )}
      </View>

      {!inPiP ? (
        hasScreenShare ? (
          <View style={styles.topBar} pointerEvents="none">
            <Text style={styles.topStatus}>
              {hasPublishedScreenShare ? 'You are sharing your screen' : `${peerName} is sharing their screen`}
            </Text>
          </View>
        ) : isVideo && remote ? (
          <View style={styles.topBar} pointerEvents="none">
            <Text style={styles.topName} numberOfLines={1}>
              {peerName}
            </Text>
            <Text style={styles.topStatus}>{statusLine}</Text>
          </View>
        ) : null
      ) : null}

      {!inPiP && isVideo && camOn && local ? (
        <View style={styles.selfView}>
          <ParticipantView participant={local} style={StyleSheet.absoluteFill as any} />
        </View>
      ) : null}

      {!inPiP ? (
        <SafeAreaView edges={['bottom']} style={styles.controlsWrap}>
        <View style={styles.controlsRow}>
          <TouchableOpacity style={styles.ctrlSmall} onPress={() => callHost.minimize()}>
            <Ionicons name="contract" size={22} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.ctrl, !micOn && styles.ctrlOff]} onPress={toggleMic}>
            <Ionicons name={micOn ? 'mic' : 'mic-off'} size={26} color={Colors.white} />
          </TouchableOpacity>
          {ncSupported ? (
            <TouchableOpacity
              style={[styles.ctrl, !ncEnabled && styles.ctrlOff]}
              onPress={toggleNc}
              testID="stream-nc-toggle"
            >
              <Ionicons name="sparkles" size={24} color={Colors.white} />
            </TouchableOpacity>
          ) : null}
          {isVideo ? (
            <TouchableOpacity style={[styles.ctrl, !camOn && styles.ctrlOff]} onPress={toggleCam}>
              <Ionicons name={camOn ? 'videocam' : 'videocam-off'} size={26} color={Colors.white} />
            </TouchableOpacity>
          ) : null}
          {isVideo ? (
            <TouchableOpacity style={styles.ctrl} onPress={flipCam}>
              <Ionicons name="camera-reverse" size={26} color={Colors.white} />
            </TouchableOpacity>
          ) : null}
          {toggleScreenShare ? (
            <TouchableOpacity
              style={[styles.ctrl, hasPublishedScreenShare && styles.ctrlOff]}
              onPress={toggleScreenShare}
              testID="stream-screenshare-toggle"
            >
              <Ionicons
                name={hasPublishedScreenShare ? 'stop-circle' : 'tv-outline'}
                size={24}
                color={Colors.white}
              />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={[styles.ctrl, styles.ctrlEnd]} onPress={onHangup}>
            <Ionicons
              name="call"
              size={26}
              color={Colors.white}
              style={{ transform: [{ rotate: '135deg' }] }}
            />
          </TouchableOpacity>
        </View>
      </SafeAreaView>
      ) : null}

      {/* AI Voice Interpreter — banner + live subtitles + language menu.
          callId = shared Convex call id so both sides' subtitles sync.
          Ducking the remote is best-effort on Stream (degrades to layered
          audio if per-participant volume isn't controllable). */}
      {connected && !hasScreenShare && !inPiP ? (
        <InterpreterLayer
          callId={callId}
          connected={connected}
          micMuted={!micOn}
          topOffset={90}
          bottomOffset={150}
          onDuckRemote={(ducked) => {
            try {
              (remote as any)?.setVolume?.(ducked ? 0 : 1);
            } catch {}
          }}
        />
      ) : null}
    </View>
  );
}

export default function StreamCallInner() {
  const { params } = useCallHost();
  const conversationId = params?.conversationId || '';
  const isVideo = params?.type === 'video';
  const isAnswering = params?.answer === '1' || params?.answer === 'true';
  const displayName = params?.displayName || 'Call';

  const canQuery = !!conversationId && conversationId.length > 10;
  const me = useQuery(api.users.getCurrentUser, canQuery ? {} : 'skip') as any;
  const { data: activeCall, loading: activeCallLoading } = useReactiveSafeConvexQuery<any>(
    (api as any).calls.getActiveCall,
    canQuery ? { conversationId } : undefined,
    null,
    canQuery,
  );

  const initiateCall = useMutation((api as any).calls.initiateCall);
  const answerCall = useMutation((api as any).calls.answerCall);
  const endCall = useMutation((api as any).calls.endCall);
  const declineCall = useMutation((api as any).calls.declineCall);
  const markCalleeRinging = useMutation((api as any).calls.markCalleeRinging);

  const [client, setClient] = useState<any>(undefined);
  const [call, setCall] = useState<any>(null);
  const [didInitiate, setDidInitiate] = useState(false);
  const [locallyAccepted, setLocallyAccepted] = useState(false);
  const [createdCallId, setCreatedCallId] = useState<string | null>(null);
  const initiatedRef = useRef(false);
  const answeredRef = useRef(false);
  const ringingMarkedRef = useRef(false);
  const endedRef = useRef(false);
  const sawCallRef = useRef(false);

  const callerId = activeCall?.callerId || activeCall?.callerUserId || null;
  const isCaller = !!(me && callerId && callerId === me._id);
  const convStatus: string | undefined = activeCall?.status;
  const callId: string | undefined = activeCall?._id;
  // Unique-per-call Stream room id (NOT the conversationId) so every call is a
  // fresh room with no lingering "ghost" participants from a previous call.
  const streamCallId: string | undefined = callId || createdCallId || undefined;

  // Role resolution. The foreground listener routes an in-app incoming call to
  // /call/<id> WITHOUT answer=1, so we must show Accept/Decline here (the old
  // screen did). A call answered from the notification arrives WITH answer=1
  // (already accepted). The caller is whoever initiated / owns the record.
  const iAmCaller = isCaller || didInitiate;
  const accepted = iAmCaller || isAnswering || locallyAccepted;
  const activeCallReady = !activeCallLoading && !!activeCall;
  const isIncomingPending =
    activeCallReady && !iAmCaller && !isAnswering && !locallyAccepted && convStatus === 'ringing';

  // 1) Caller: create the Convex ringing record (the doorbell FCM is already
  //    fired by startCall). Only when not answering and there's no active call.
  // Track that a call has existed so we NEVER (re)initiate after it ends — this
  // is what caused the end→re-initiate loop between the two parties.
  useEffect(() => {
    if (activeCall) sawCallRef.current = true;
  }, [activeCall]);

  useEffect(() => {
    if (isAnswering || initiatedRef.current || endedRef.current) return;
    if (locallyAccepted || sawCallRef.current) return; // callee, or a call already existed
    if (!me || !conversationId) return;
    if (activeCallLoading || activeCall) return; // wait for load; skip if a call exists
    initiatedRef.current = true;
    setDidInitiate(true);
    initiateCall({ conversationId, callType: isVideo ? 'video' : 'voice' })
      .then((id: any) => {
        if (id) setCreatedCallId(String(id));
      })
      .catch(() => {
        initiatedRef.current = false;
        setDidInitiate(false);
      });
  }, [
    isAnswering,
    me,
    conversationId,
    activeCall,
    activeCallLoading,
    initiateCall,
    isVideo,
    locallyAccepted,
  ]);

  // 2) Callee (answered from the notification): accept the Convex call.
  useEffect(() => {
    if (!isAnswering || answeredRef.current) return;
    if (!callId || convStatus !== 'ringing') return;
    answeredRef.current = true;
    void answerCall({ callId: String(callId) }).catch(() => {});
  }, [isAnswering, callId, convStatus, answerCall]);

  // 3) Callee: mark "ringing" so the caller sees delivery.
  useEffect(() => {
    if (isCaller || ringingMarkedRef.current) return;
    if (!callId || convStatus !== 'ringing') return;
    ringingMarkedRef.current = true;
    void markCalleeRinging({ callId: String(callId) }).catch(() => {});
  }, [isCaller, callId, convStatus, markCalleeRinging]);

  // 4) Join the Stream call (media) — only once ACCEPTED (caller, notification
  //    answer, or in-app Accept) AND we have the unique per-call room id.
  //    ring:false → no Stream push (Ashwini's doorbell owns ringing).
  useEffect(() => {
    if (!streamCallId || !accepted) return;
    let mounted = true;
    let joined: any = null;
    (async () => {
      try {
        const c = await createStreamVideoClient();
        if (!c || !mounted) return;
        setClient(c);
        const streamCall = c.call('default', streamCallId);
        // Single round-trip create-or-join (ring:false → Ashwini's doorbell owns
        // ringing). Was getOrCreate() THEN join() = two sequential network hops,
        // which added noticeable latency before media connected.
        await streamCall.join({ create: true, ring: false, notify: false });
        joined = streamCall;
        if (mounted) setCall(streamCall);
      } catch {
        /* join failure — screen shows Connecting…; user can hang up */
      }
    })();
    return () => {
      mounted = false;
      try {
        joined?.leave();
      } catch {}
    };
  }, [streamCallId, accepted]);

  const acceptIncoming = useCallback(() => {
    setLocallyAccepted(true);
    if (callId) void answerCall({ callId: String(callId) }).catch(() => {});
  }, [callId, answerCall]);

  const declineIncoming = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (callId) void declineCall({ callId: String(callId) }).catch(() => {});
    callHost.end();
  }, [callId, declineCall]);

  const hangup = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (callId) void endCall({ callId: String(callId) }).catch(() => {});
    try {
      call?.leave();
    } catch {}
    callHost.end();
  }, [callId, call, endCall]);

  // ── Call-waiting: surface a SECOND ringing call during an active call ──────
  const connectedNow = !!client && !!call;
  const incomingRaw = useQuery(
    (api as any).calls.getIncomingCall,
    connectedNow && canQuery ? {} : 'skip',
  ) as any;
  const [dismissedWaitingIds, setDismissedWaitingIds] = useState<string[]>([]);
  const waitingCall = useMemo(() => {
    const rec = incomingRaw;
    if (!rec || !rec._id || rec.status !== 'ringing') return null;
    const myId = me?._id ? String(me._id) : '';
    const recCallerId = String(rec?.callerId || rec?.callerUserId || rec?.caller?._id || '');
    if (myId && recCallerId && myId === recCallerId) return null; // my own outgoing
    if (callId && String(rec._id) === String(callId)) return null; // the current call
    if (conversationId && String(rec.conversationId) === String(conversationId)) return null;
    const t = String(rec?.type || rec?.callType || '').toLowerCase();
    if (['screen', 'screenshare', 'screen-share', 'screen_share', 'sharing'].includes(t)) return null;
    if (rec?.isScreenShare || rec?.screenShareSessionId) return null;
    if (dismissedWaitingIds.includes(String(rec._id))) return null;
    return rec;
  }, [incomingRaw, me, callId, conversationId, dismissedWaitingIds]);

  const waitingName = String(
    waitingCall?.callerName || waitingCall?.caller?.displayName || waitingCall?.caller?.name || 'Unknown',
  ).trim();
  const waitingIsVideo =
    waitingCall?.isVideo === true || String(waitingCall?.type || waitingCall?.callType || '').toLowerCase() === 'video';

  // WhatsApp-style alert (double-beep + double buzz) once per new waiting call.
  const alertedWaitingIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = waitingCall?._id ? String(waitingCall._id) : null;
    if (!id) {
      alertedWaitingIdRef.current = null;
      return;
    }
    if (alertedWaitingIdRef.current === id) return;
    alertedWaitingIdRef.current = id;
    try {
      InCallAudio.playCallWaitingTone?.();
    } catch {}
    try {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      setTimeout(() => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      }, 450);
    } catch {}
  }, [waitingCall]);

  const declineWaiting = useCallback(() => {
    const rec = waitingCall;
    if (!rec?._id) return;
    const id = String(rec._id);
    setDismissedWaitingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    void declineCall({ callId: id }).catch(() => {});
  }, [waitingCall, declineCall]);

  const acceptWaiting = useCallback(() => {
    const rec = waitingCall;
    if (!rec?.conversationId) return;
    const targetConv = String(rec.conversationId);
    // End the current call, then switch the call host to the incoming one
    // (answer=1 auto-accepts once it mounts). Same behaviour as WhatsApp.
    if (callId && !endedRef.current) {
      endedRef.current = true;
      void endCall({ callId: String(callId) }).catch(() => {});
    }
    try {
      call?.leave();
    } catch {}
    setTimeout(() => {
      callHost.start({
        conversationId: targetConv,
        type: waitingIsVideo ? 'video' : 'voice',
        displayName: waitingName || 'Call',
        answer: '1',
      });
    }, 200);
  }, [waitingCall, waitingIsVideo, waitingName, callId, call, endCall]);

  const waitingBanner =
    waitingCall && connectedNow ? (
      <View style={styles.waitingWrap} pointerEvents="box-none" testID="stream-call-waiting">
        <View style={styles.waitingCard}>
          <View style={styles.waitingHeader}>
            <Ionicons name={waitingIsVideo ? 'videocam' : 'call'} size={18} color={Colors.white} />
            <View style={{ flex: 1 }}>
              <Text style={styles.waitingLabel}>Incoming {waitingIsVideo ? 'video' : 'voice'} call</Text>
              <Text style={styles.waitingName} numberOfLines={1}>
                {waitingName}
              </Text>
            </View>
          </View>
          <View style={styles.waitingActions}>
            <TouchableOpacity style={[styles.waitingBtn, styles.waitingDecline]} onPress={declineWaiting}>
              <Text style={styles.waitingBtnText}>Decline</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.waitingBtn, styles.waitingAccept]} onPress={acceptWaiting}>
              <Text style={styles.waitingBtnText}>End &amp; Accept</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    ) : null;

  if (isIncomingPending) {
    return (
      <View style={styles.loading}>
        <View style={styles.avatarBig}>
          <Ionicons name="person" size={64} color={Colors.white} />
        </View>
        <Text style={styles.incomingName} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.loadingText}>
          {isVideo ? 'Incoming video call' : 'Incoming voice call'}
        </Text>
        <View style={styles.incomingRow}>
          <View style={styles.incomingBtnWrap}>
            <TouchableOpacity style={[styles.incomingBtn, styles.declineBtn]} onPress={declineIncoming}>
              <Ionicons
                name="call"
                size={28}
                color={Colors.white}
                style={{ transform: [{ rotate: '135deg' }] }}
              />
            </TouchableOpacity>
            <Text style={styles.incomingLabel}>Decline</Text>
          </View>
          <View style={styles.incomingBtnWrap}>
            <TouchableOpacity style={[styles.incomingBtn, styles.acceptBtn]} onPress={acceptIncoming}>
              <Ionicons name={isVideo ? 'videocam' : 'call'} size={28} color={Colors.white} />
            </TouchableOpacity>
            <Text style={styles.incomingLabel}>Accept</Text>
          </View>
        </View>
      </View>
    );
  }

  if (!client || !call) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={Colors.primary} size="large" />
        <Text style={styles.loadingText}>{isCaller ? 'Calling…' : 'Connecting…'}</Text>
        <Text style={styles.loadingName} numberOfLines={1}>
          {displayName}
        </Text>
        <TouchableOpacity style={styles.loadingEnd} onPress={hangup}>
          <Ionicons
            name="call"
            size={24}
            color={Colors.white}
            style={{ transform: [{ rotate: '135deg' }] }}
          />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <StreamVideo client={client}>
      <StreamCall call={call}>
        <NoiseCancellationProvider>
          <NoiseCancellationAutoEnable />
          <CallUI
            isVideo={isVideo}
            isCaller={isCaller}
            peerName={displayName}
            convStatus={convStatus}
            callId={callId ? String(callId) : streamCallId ? String(streamCallId) : null}
            onHangup={hangup}
          />
          {waitingBanner}
        </NoiseCancellationProvider>
      </StreamCall>
    </StreamVideo>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#0B0B0B', alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: Colors.white, fontSize: 20, fontWeight: '600', marginTop: 20 },
  loadingName: { color: '#9CA3AF', fontSize: 16, marginTop: 6 },
  incomingName: { color: Colors.white, fontSize: 24, fontWeight: '700', marginTop: 20 },
  incomingRow: {
    flexDirection: 'row',
    gap: 64,
    marginTop: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  incomingBtnWrap: { alignItems: 'center', gap: 10 },
  incomingBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtn: { backgroundColor: '#22C55E' },
  declineBtn: { backgroundColor: '#EF4444' },
  incomingLabel: { color: '#D1D5DB', fontSize: 14 },
  loadingEnd: {
    marginTop: 40,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
  },

  callRoot: { flex: 1, backgroundColor: '#000' },
  waitingWrap: {
    position: 'absolute',
    top: 54,
    left: 12,
    right: 12,
    alignItems: 'center',
    zIndex: 50,
  },
  waitingCard: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: 'rgba(20,20,20,0.96)',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  waitingHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  waitingLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  waitingName: { color: Colors.white, fontSize: 17, fontWeight: '700', marginTop: 1 },
  waitingActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  waitingBtn: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  waitingAccept: { backgroundColor: '#22C55E' },
  waitingDecline: { backgroundColor: '#EF4444' },
  waitingBtnText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  remoteArea: { ...StyleSheet.absoluteFillObject },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatarBig: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  peerName: { color: Colors.white, fontSize: 24, fontWeight: '700' },
  statusText: { color: '#9CA3AF', fontSize: 16, marginTop: 8 },
  topBar: { position: 'absolute', top: 56, left: 0, right: 0, alignItems: 'center' },
  topName: { color: Colors.white, fontSize: 18, fontWeight: '700' },
  topStatus: { color: '#D1D5DB', fontSize: 14, marginTop: 2 },
  selfView: {
    position: 'absolute',
    top: 60,
    right: 16,
    width: 110,
    height: 160,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  controlsWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  controlsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 28,
    paddingHorizontal: 12,
  },
  ctrl: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlSmall: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlOff: { backgroundColor: 'rgba(255,255,255,0.4)' },
  ctrlEnd: { backgroundColor: '#EF4444' },

  miniRoot: { flex: 1, backgroundColor: '#0b141a' },
  miniCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  miniText: { color: Colors.white, fontSize: 12, paddingHorizontal: 6 },
});
