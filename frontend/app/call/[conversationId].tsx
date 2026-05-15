import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
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
import { Camera } from 'expo-camera';
import { Audio } from 'expo-av';
import { api } from '../../src/convexApi';
import Avatar from '../../src/components/Avatar';
import { CallSession } from '../../src/lib/webrtc/CallSession';
import { Colors, FontSize, FontWeight, Shadow, Spacing } from '../../src/theme';
import RTCView from '../../src/lib/webrtc/RTCViewWrapper';

type CallType = 'voice' | 'video';

export default function CallScreen() {
  const router = useRouter();
  const { conversationId, type: typeParam } = useLocalSearchParams<{
    conversationId: string;
    type?: string;
  }>();
  const requestedType: CallType = typeParam === 'video' ? 'video' : 'voice';

  const me = useQuery(api.users.getCurrentUser, conversationId ? {} : 'skip');
  const conversation = useQuery(
    api.conversations.getConversation,
    conversationId ? { conversationId } : 'skip'
  );
  const activeCall = useQuery(
    api.calls.getActiveCall,
    conversationId ? { conversationId } : 'skip'
  );

  const initiateCall = useMutation(api.calls.initiateCall);
  const answerCall = useMutation(api.calls.answerCall);
  const endCall = useMutation(api.calls.endCall);
  const declineCall = useMutation(api.calls.declineCall);
  const sendSignal = useMutation(api.signaling.send);
  const markConsumed = useMutation(api.signaling.markConsumed);
  const cleanupSignaling = useMutation(api.signaling.cleanup);

  const [callId, setCallId] = useState<string | null>(null);
  const [callType, setCallType] = useState<CallType>(requestedType);
  const [localStreamURL, setLocalStreamURL] = useState<string | null>(null);
  const [remoteStreamURL, setRemoteStreamURL] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [statusText, setStatusText] = useState('Connecting…');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [callDurationSec, setCallDurationSec] = useState(0);

  const sessionRef = useRef<CallSession | null>(null);
  const initStartedRef = useRef(false);
  const callStartedAtRef = useRef<number | null>(null);

  // Subscribe to incoming signaling messages for this call
  const signals: any[] | undefined = useQuery(
    api.signaling.poll,
    callId ? { callId } : 'skip'
  );

  // Derived role: outgoing if I'm the caller, incoming otherwise
  const isCaller = activeCall && me ? activeCall.callerId === me._id : false;
  const isIncoming = activeCall && me && activeCall.callerId !== me._id && activeCall.status === 'ringing';
  const isOutgoingRinging = isCaller && activeCall?.status === 'ringing';
  const isActive = activeCall?.status === 'active';

  // Capture callId once we know it
  useEffect(() => {
    if (activeCall?._id && !callId) {
      setCallId(activeCall._id);
      setCallType(activeCall.callType === 'video' ? 'video' : 'voice');
    }
  }, [activeCall?._id, activeCall?.callType, callId]);

  // ====== Initiate (auto-start outgoing call if none exists) ======
  useEffect(() => {
    const shouldAutoInitiate =
      !activeCall &&
      !callId &&
      conversationId &&
      conversation &&
      me &&
      activeCall !== undefined; // wait until Convex query resolved (null vs undefined)
    if (!shouldAutoInitiate) return;
    let cancelled = false;
    (async () => {
      try {
        const id: any = await initiateCall({ conversationId, callType: requestedType });
        if (!cancelled && id) setCallId(id);
      } catch (errorValue: any) {
        if (!cancelled) {
          console.warn('initiateCall failed:', errorValue?.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCall, callId, conversation, conversationId, initiateCall, me, requestedType]);

  // ====== Update status text based on state ======
  useEffect(() => {
    if (isIncoming) setStatusText('Incoming call…');
    else if (isOutgoingRinging) setStatusText('Calling…');
    else if (isActive) setStatusText('Connected');
    else if (activeCall?.status === 'ended') setStatusText('Call ended');
    else if (activeCall?.status === 'declined') setStatusText('Declined');
    else setStatusText('Connecting…');
  }, [isIncoming, isOutgoingRinging, isActive, activeCall?.status]);

  // ====== Call duration timer ======
  useEffect(() => {
    if (!isActive) {
      callStartedAtRef.current = null;
      setCallDurationSec(0);
      return;
    }
    if (callStartedAtRef.current == null) callStartedAtRef.current = Date.now();
    const intervalId = setInterval(() => {
      const start = callStartedAtRef.current;
      if (start) setCallDurationSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(intervalId);
  }, [isActive]);

  // ====== Set up audio routing for calls ======
  useEffect(() => {
    if (Platform.OS === 'web') return;
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: !speakerOn && callType === 'voice',
        });
      } catch (errorValue: any) {
        console.warn('Audio.setAudioModeAsync failed:', errorValue?.message);
      }
    })();
  }, [callType, speakerOn]);

  // ====== Build & tear down peer connection when call becomes active ======
  const startPeerConnection = useCallback(
    async (asCaller: boolean) => {
      if (!callId || !activeCall || initStartedRef.current) return;
      if (Platform.OS === 'web') return; // skip on web preview
      const remoteUserId = asCaller ? activeCall.recipientId : activeCall.callerId;
      if (!remoteUserId) return;

      initStartedRef.current = true;

      // Request permissions
      try {
        const cam = await Camera.requestCameraPermissionsAsync();
        const micPermission = await Camera.requestMicrophonePermissionsAsync().catch(() => null);
        const micGranted = micPermission?.status === 'granted';
        if (callType === 'video' && cam.status !== 'granted') {
          setPermissionDenied(true);
          return;
        }
        if (!micGranted && cam.status !== 'granted') {
          setPermissionDenied(true);
          return;
        }
      } catch {
        // Continue — getUserMedia will fail explicitly if permissions missing
      }

      const session = new CallSession({
        callType,
        isCaller: asCaller,
        callId,
        remoteUserId,
        sendSignal: async (sig) => {
          try {
            await sendSignal(sig);
          } catch (errorValue: any) {
            console.warn('sendSignal failed:', errorValue?.message);
          }
        },
        onLocalStream: (stream) => {
          try {
            setLocalStreamURL((stream as any).toURL());
          } catch {}
        },
        onRemoteStream: (stream) => {
          try {
            setRemoteStreamURL((stream as any).toURL());
          } catch {}
        },
        onConnectionStateChange: (state) => {
          console.log('[Call] connection state:', state);
          if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            // ICE may temporarily disconnect; only act on fatal states
            if (state === 'failed' || state === 'closed') {
              setStatusText('Connection lost');
            }
          }
        },
        onError: (err) => console.warn('[Call] error:', err?.message),
      });

      sessionRef.current = session;

      try {
        await session.initLocalMedia();
        session.createPeerConnection();
        if (asCaller) {
          await session.createOffer();
        }
      } catch (errorValue: any) {
        console.warn('startPeerConnection failed:', errorValue?.message);
        setPermissionDenied(true);
      }
    },
    [activeCall, callId, callType, sendSignal]
  );

  // Caller: kick off peer-connection as soon as we have a callId (status may still be ringing)
  useEffect(() => {
    if (isCaller && callId && !sessionRef.current && !initStartedRef.current) {
      void startPeerConnection(true);
    }
  }, [isCaller, callId, startPeerConnection]);

  // Callee: kick off peer-connection when answered (status → active)
  useEffect(() => {
    if (!isCaller && isActive && callId && !sessionRef.current && !initStartedRef.current) {
      void startPeerConnection(false);
    }
  }, [isCaller, isActive, callId, startPeerConnection]);

  // ====== Process incoming signaling messages ======
  useEffect(() => {
    if (!signals || !Array.isArray(signals) || signals.length === 0) return;
    if (!sessionRef.current) return;

    const messageIds: string[] = [];
    (async () => {
      for (const msg of signals) {
        try {
          if (msg.type === 'offer') {
            await sessionRef.current?.handleRemoteOffer(msg.payload);
          } else if (msg.type === 'answer') {
            await sessionRef.current?.handleRemoteAnswer(msg.payload);
          } else if (msg.type === 'ice-candidate') {
            await sessionRef.current?.handleRemoteIceCandidate(msg.payload);
          }
          messageIds.push(msg._id);
        } catch (errorValue: any) {
          console.warn('handle signal failed:', msg.type, errorValue?.message);
        }
      }
      if (messageIds.length > 0) {
        try {
          await markConsumed({ messageIds });
        } catch (errorValue: any) {
          console.warn('markConsumed failed:', errorValue?.message);
        }
      }
    })();
  }, [signals, markConsumed]);

  // ====== End call ======
  const handleHangup = useCallback(async () => {
    const id = callId;
    sessionRef.current?.close();
    sessionRef.current = null;
    initStartedRef.current = false;
    if (id) {
      try {
        await endCall({ callId: id });
      } catch {}
      try {
        await cleanupSignaling({ callId: id });
      } catch {}
    }
    router.back();
  }, [callId, cleanupSignaling, endCall, router]);

  const handleDecline = useCallback(async () => {
    const id = callId;
    sessionRef.current?.close();
    sessionRef.current = null;
    initStartedRef.current = false;
    if (id) {
      try {
        await declineCall({ callId: id });
      } catch {}
      try {
        await cleanupSignaling({ callId: id });
      } catch {}
    }
    router.back();
  }, [callId, cleanupSignaling, declineCall, router]);

  const handleAnswer = useCallback(async () => {
    if (!callId) return;
    try {
      await answerCall({ callId });
    } catch (errorValue: any) {
      console.warn('answerCall failed:', errorValue?.message);
    }
  }, [answerCall, callId]);

  // If remote ends the call, also tear down locally
  useEffect(() => {
    if (
      activeCall &&
      (activeCall.status === 'ended' || activeCall.status === 'declined') &&
      sessionRef.current
    ) {
      sessionRef.current.close();
      sessionRef.current = null;
      initStartedRef.current = false;
      // Give the user 700ms to see the "Call ended" state before popping
      const timeoutId = setTimeout(() => router.back(), 700);
      return () => clearTimeout(timeoutId);
    }
  }, [activeCall, router]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
      initStartedRef.current = false;
    };
  }, []);

  // App state listener — keep call alive when backgrounded but pause video preview
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && callType === 'video') {
        // Optionally turn off camera while in background
      }
    });
    return () => sub.remove();
  }, [callType]);

  // ====== Control handlers ======
  const toggleMute = useCallback(() => {
    const next = !muted;
    sessionRef.current?.setMuted(next);
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOff;
    sessionRef.current?.setCameraOff(next);
    setCameraOff(next);
  }, [cameraOff]);

  const flipCamera = useCallback(() => {
    sessionRef.current?.switchCamera();
  }, []);

  const toggleSpeaker = useCallback(() => {
    setSpeakerOn((v) => !v);
  }, []);

  const otherName = useMemo(() => {
    return conversation?.name || conversation?.otherUserName || 'Smilers';
  }, [conversation?.name, conversation?.otherUserName]);

  const durationLabel = useMemo(() => {
    const m = Math.floor(callDurationSec / 60);
    const s = callDurationSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [callDurationSec]);

  const showVideo = callType === 'video' && isActive && RTCView != null;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="call-screen">
      {/* Video layer or avatar header */}
      {showVideo && remoteStreamURL ? (
        <View style={styles.videoLayer}>
          <RTCView
            streamURL={remoteStreamURL}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={false}
          />
          {/* Local picture-in-picture */}
          {localStreamURL && !cameraOff ? (
            <View style={styles.pipWrap}>
              <RTCView
                streamURL={localStreamURL}
                style={StyleSheet.absoluteFill}
                objectFit="cover"
                mirror
              />
            </View>
          ) : null}
          {/* Top overlay: name + duration */}
          <View style={styles.videoTopOverlay}>
            <Text style={styles.videoName}>{otherName}</Text>
            <Text style={styles.videoStatus}>{isActive ? durationLabel : statusText}</Text>
          </View>
        </View>
      ) : (
        <View style={styles.topArea}>
          <Avatar name={otherName} size={140} backgroundColor={Colors.primaryLight} />
          <Text style={styles.name}>{otherName}</Text>
          <Text style={styles.status}>{isActive ? durationLabel : statusText}</Text>
          {callType === 'video' ? (
            <Text style={styles.subStatus}>
              {callType === 'video' ? 'Video call' : 'Voice call'}
            </Text>
          ) : null}
          {isOutgoingRinging ? (
            <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.lg }} />
          ) : null}
          {permissionDenied ? (
            <Text style={styles.errorText} testID="call-permission-error">
              Camera or microphone permission denied. Enable them in your device settings to use calls.
            </Text>
          ) : null}
        </View>
      )}

      {/* Bottom controls */}
      <View style={styles.controls}>
        {isIncoming ? (
          <View style={styles.row}>
            <ControlBtn
              testID="decline-call-btn"
              onPress={handleDecline}
              backgroundColor={Colors.danger}
              icon={<Ionicons name="close" size={32} color={Colors.white} />}
              label="Decline"
            />
            <ControlBtn
              testID="answer-call-btn"
              onPress={handleAnswer}
              backgroundColor={Colors.success}
              icon={<Ionicons name="call" size={32} color={Colors.white} />}
              label="Answer"
            />
          </View>
        ) : (
          <>
            <View style={styles.controlsTopRow}>
              <SmallControl
                testID="mute-btn"
                onPress={toggleMute}
                active={muted}
                icon={
                  <Feather name={muted ? 'mic-off' : 'mic'} size={22} color={Colors.white} />
                }
                label={muted ? 'Unmute' : 'Mute'}
              />
              {callType === 'video' ? (
                <>
                  <SmallControl
                    testID="camera-btn"
                    onPress={toggleCamera}
                    active={cameraOff}
                    icon={
                      <Feather
                        name={cameraOff ? 'video-off' : 'video'}
                        size={22}
                        color={Colors.white}
                      />
                    }
                    label={cameraOff ? 'Camera on' : 'Camera off'}
                  />
                  <SmallControl
                    testID="flip-camera-btn"
                    onPress={flipCamera}
                    icon={<Ionicons name="camera-reverse-outline" size={22} color={Colors.white} />}
                    label="Flip"
                  />
                </>
              ) : (
                <SmallControl
                  testID="speaker-btn"
                  onPress={toggleSpeaker}
                  active={speakerOn}
                  icon={
                    <Ionicons
                      name={speakerOn ? 'volume-high' : 'volume-medium-outline'}
                      size={22}
                      color={Colors.white}
                    />
                  }
                  label={speakerOn ? 'Speaker' : 'Earpiece'}
                />
              )}
            </View>
            <View style={styles.row}>
              <ControlBtn
                testID="hangup-btn"
                onPress={handleHangup}
                backgroundColor={Colors.danger}
                icon={
                  <Ionicons
                    name="call"
                    size={32}
                    color={Colors.white}
                    style={{ transform: [{ rotate: '135deg' }] }}
                  />
                }
                label="End"
              />
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function ControlBtn({
  testID,
  onPress,
  backgroundColor,
  icon,
  label,
}: {
  testID: string;
  onPress: () => void;
  backgroundColor: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.bigBtn, { backgroundColor }]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      {icon}
      <Text style={styles.bigBtnLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function SmallControl({
  testID,
  onPress,
  active,
  icon,
  label,
}: {
  testID: string;
  onPress: () => void;
  active?: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.smallBtn, active ? styles.smallBtnActive : null]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      {icon}
      <Text style={styles.smallBtnLabel} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.headerBg,
    justifyContent: 'space-between',
  },
  topArea: {
    alignItems: 'center',
    paddingTop: Spacing.xxl,
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  name: {
    fontSize: FontSize.xxxl,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    marginTop: Spacing.lg,
    textAlign: 'center',
  },
  status: {
    fontSize: FontSize.lg,
    color: Colors.primaryLight,
    fontWeight: FontWeight.medium,
  },
  subStatus: {
    fontSize: FontSize.sm,
    color: Colors.primaryLight,
    opacity: 0.8,
  },
  errorText: {
    color: Colors.danger,
    fontSize: FontSize.sm,
    textAlign: 'center',
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  controls: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    gap: Spacing.lg,
  },
  controlsTopRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    gap: Spacing.lg,
  },
  bigBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  bigBtnLabel: {
    color: Colors.white,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    marginTop: 4,
  },
  smallBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    gap: 2,
    paddingHorizontal: 6,
  },
  smallBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  smallBtnLabel: {
    color: Colors.white,
    fontSize: 10,
    fontWeight: FontWeight.medium,
    marginTop: 2,
  },

  /* Video layer */
  videoLayer: {
    flex: 1,
    backgroundColor: '#000',
    position: 'relative',
  },
  pipWrap: {
    position: 'absolute',
    top: Spacing.lg,
    right: Spacing.base,
    width: 110,
    height: 160,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  videoTopOverlay: {
    position: 'absolute',
    top: Spacing.xl,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
  },
  videoName: {
    color: Colors.white,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  videoStatus: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: FontSize.sm,
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
});
