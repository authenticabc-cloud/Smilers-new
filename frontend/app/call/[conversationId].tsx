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
import { useMutation } from 'convex/react';
import { Camera } from 'expo-camera';
import { Audio } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { StatusBar } from 'expo-status-bar';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useAuth } from '../../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Shadow, Spacing } from '../../src/theme';
import { useRingtonePlayer } from '../../src/lib/ringtone/useRingtonePlayer';

type CallType = 'voice' | 'video';
type AudioOutputRoute = 'earpiece' | 'speaker' | 'bluetooth';

function alertScreenShareIOSError() {
  Alert.alert(
    'Screen sharing on iOS',
    'iOS screen sharing requires a Broadcast Upload Extension built into the app. We\'ll enable this in a future build — for now, screen sharing is available on Android.'
  );
}

export default function CallScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { conversationId: rawConversationId, type: rawTypeParam } = useLocalSearchParams<{
    conversationId?: string | string[];
    type?: string | string[];
  }>();
  const conversationId = Array.isArray(rawConversationId) ? rawConversationId[0] : rawConversationId;
  const typeParam = Array.isArray(rawTypeParam) ? rawTypeParam[0] : rawTypeParam;
  const requestedType: CallType = typeParam === 'video' || typeParam === 'screen' ? 'video' : 'voice';
  const startInScreenShare = typeParam === 'screen';
  const hasValidConversationId = typeof conversationId === 'string' && /^[a-z0-9]+$/i.test(conversationId) && conversationId.length > 10;
  const canRunCallQueries = isAuthenticated && hasValidConversationId;

  const { data: me, loading: meLoading } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    {},
    null,
    canRunCallQueries,
  );
  const { data: conversation, loading: conversationLoading } = useSafeConvexQuery<any | null>(
    api.conversations.getConversation,
    conversationId ? { conversationId } : {},
    null,
    canRunCallQueries,
  );
  const { data: activeCall, loading: activeCallLoading } = useSafeConvexQuery<any | null>(
    (api as any).calls.getActiveCall,
    conversationId ? { conversationId } : {},
    null,
    canRunCallQueries,
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
  const [audioOutput, setAudioOutput] = useState<AudioOutputRoute>(requestedType === 'voice' ? 'earpiece' : 'speaker');
  const [audioOutputMenuVisible, setAudioOutputMenuVisible] = useState(false);
  const [screenSharing, setScreenSharing] = useState(startInScreenShare);
  const [statusText, setStatusText] = useState('Connecting…');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [callDurationSec, setCallDurationSec] = useState(0);
  const [audioModeReady, setAudioModeReady] = useState(false);
  const [screenReady, setScreenReady] = useState(Platform.OS !== 'android');
  const [RTCViewImpl, setRTCViewImpl] = useState<any>(null);
  const [CallSessionCtor, setCallSessionCtor] = useState<any>(null);

  const sessionRef = useRef<any>(null);
  const initStartedRef = useRef(false);
  const callStartedAtRef = useRef<number | null>(null);

  const applyAudioMode = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: audioOutput !== 'speaker' && callType === 'voice',
      });
    } catch (errorValue: any) {
      console.warn('Audio.setAudioModeAsync failed:', errorValue?.message);
    }
  }, [audioOutput, callType]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      setScreenReady(true);
      return undefined;
    }
    setScreenReady(false);
    const timerId = setTimeout(() => {
      setScreenReady(true);
    }, 350);
    return () => {
      clearTimeout(timerId);
      setScreenReady(false);
    };
  }, [conversationId]);

  useEffect(() => {
    if (Platform.OS === 'web' || !screenReady) return;
    let cancelled = false;
    try {
      const rtcModule = require('../../src/lib/webrtc/RTCViewWrapper');
      const callModule = require('../../src/lib/webrtc/CallSession');
      if (!cancelled) {
        setRTCViewImpl(() => rtcModule.default);
        setCallSessionCtor(() => callModule.CallSession);
      }
    } catch (errorValue: any) {
      console.warn('Failed to load WebRTC modules:', errorValue?.message);
    }
    return () => {
      cancelled = true;
    };
  }, [screenReady]);

  // Subscribe to incoming signaling messages for this call
  const { data: signals } = useSafeConvexQuery<any[]>(
    (api as any).signaling.poll,
    callId ? { callId } : {},
    [],
    !!callId && isAuthenticated,
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
      canRunCallQueries &&
      conversationId &&
      conversation &&
      me &&
      !activeCallLoading &&
      !conversationLoading &&
      !meLoading;
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
  }, [activeCall, activeCallLoading, callId, canRunCallQueries, conversation, conversationId, conversationLoading, initiateCall, isAuthenticated, me, meLoading, requestedType]);

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

  useEffect(() => {
    if (!audioModeReady) return;
    void applyAudioMode();
  }, [applyAudioMode, audioModeReady]);

  // ====== Build & tear down peer connection when call becomes active ======
  const startPeerConnection = useCallback(
    async (asCaller: boolean) => {
      if (!callId || !activeCall || initStartedRef.current || !CallSessionCtor) return;
      if (Platform.OS === 'web') return; // skip on web preview
      const remoteUserId = asCaller ? activeCall.recipientId : activeCall.callerId;
      if (!remoteUserId) return;

      initStartedRef.current = true;

      // Request permissions
      try {
        let camGranted = true;
        if (callType === 'video') {
          const cam = await Camera.requestCameraPermissionsAsync();
          camGranted = cam.status === 'granted';
        }
        const micPermission = await Camera.requestMicrophonePermissionsAsync().catch(() => null);
        const micGranted = micPermission?.status === 'granted';
        if (callType === 'video' && !camGranted) {
          setPermissionDenied(true);
          return;
        }
        if (!micGranted) {
          setPermissionDenied(true);
          return;
        }
        await applyAudioMode();
        setAudioModeReady(true);
      } catch {
        // Continue — getUserMedia will fail explicitly if permissions missing
      }

      const session = new CallSessionCtor({
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
        await session.initLocalMedia(startInScreenShare);
        await session.createPeerConnection();
        if (asCaller) {
          await session.createOffer();
        }
      } catch (errorValue: any) {
        console.warn('startPeerConnection failed:', errorValue?.message);
        if (startInScreenShare) {
          Platform.OS === 'ios'
            ? alertScreenShareIOSError()
            : console.warn('Screen capture failed:', errorValue?.message);
        }
        setPermissionDenied(true);
      }
    },
    [CallSessionCtor, activeCall, applyAudioMode, callId, callType, sendSignal, startInScreenShare]
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

  const handleSelectAudioOutput = useCallback((nextOutput: AudioOutputRoute) => {
    setAudioOutput(nextOutput);
    setAudioOutputMenuVisible(false);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      Alert.alert('Screen sharing', 'Screen sharing will be available as soon as the call media is ready.');
      return;
    }
    if (Platform.OS === 'ios') {
      alertScreenShareIOSError();
      return;
    }
    try {
      if (screenSharing) {
        await session.stopScreenShare(callType === 'video');
        setScreenSharing(false);
        setCameraOff(false);
      } else {
        await session.startScreenShare();
        setScreenSharing(true);
        setCameraOff(false);
      }
    } catch (e: any) {
      Alert.alert('Screen sharing failed', e?.message || 'Could not start screen sharing.');
    }
  }, [screenSharing, callType]);

  const handleAddParticipant = useCallback(() => {
    Alert.alert(
      'Add participant',
      'Conference escalation from the live call screen is the next call update. I have added the button to match the web layout, and I can wire the actual invite flow next.'
    );
  }, []);

  const otherName = useMemo(() => {
    const conversationName = typeof conversation?.name === 'string' ? conversation.name.trim() : '';
    const directName = [
      conversation?.otherUserName,
      conversation?.otherUser?.name,
      conversation?.otherUser?.displayName,
      conversation?.otherUser?.fullName,
    ].find((value) => typeof value === 'string' && value.trim().length > 0 && value.trim().toLowerCase() !== 'smilers');

    const participantName = Array.isArray(conversation?.participants)
      ? conversation.participants
          .map((participant: any) => {
            if (!participant || participant._id === me?._id || participant.id === me?._id) {
              return '';
            }
            return participant.name || participant.displayName || participant.fullName || participant.username || '';
          })
          .find((value: string) => typeof value === 'string' && value.trim().length > 0)
      : '';

    if (directName) {
      return String(directName).trim();
    }
    if (typeof participantName === 'string' && participantName.trim().length > 0 && participantName.trim().toLowerCase() !== 'smilers') {
      return participantName.trim();
    }
    if (conversationName && conversationName.toLowerCase() !== 'smilers') {
      return conversationName;
    }
    return 'Smilers';
  }, [conversation, me?._id]);

  const durationLabel = useMemo(() => {
    const m = Math.floor(callDurationSec / 60);
    const s = callDurationSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [callDurationSec]);

  const topStatusChip = useMemo(() => {
    if (isOutgoingRinging) return 'Ringing....';
    if (isIncoming) return 'Incoming...';
    if (!isActive && statusText && statusText !== 'Connecting…') return statusText;
    return '';
  }, [isActive, isIncoming, isOutgoingRinging, statusText]);

  const primaryCallSubLabel = useMemo(() => {
    if (isActive) return durationLabel;
    return callType === 'video' ? 'Video Call' : 'Voice Call';
  }, [callType, durationLabel, isActive]);

  const secondaryCallSubLabel = useMemo(() => {
    if (permissionDenied || isActive || isIncoming || isOutgoingRinging) return '';
    return statusText;
  }, [isActive, isIncoming, isOutgoingRinging, permissionDenied, statusText]);

  const showVideo = callType === 'video' && isActive && RTCViewImpl != null;

  // Play ringtone + vibrate when this is an incoming call that's still ringing
  useRingtonePlayer(!!isIncoming);

  // Background gradient for non-video states (incoming/outgoing/voice/active-voice)
  const gradientColors = isIncoming
    ? (['#1a3b5d', '#0f1d2e'] as const) // calm blue for incoming
    : (['#3A2608', '#1a1004'] as const); // warm dark brown for outgoing/active

  if (Platform.OS === 'android' && !screenReady) {
    return (
      <View style={[styles.container, styles.callLoadingScreen]} testID="call-screen-loading">
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={Colors.white} />
        <Text style={styles.callLoadingText}>Preparing call…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="call-screen">
      <StatusBar style="light" />
      {/* Video layer or gradient + avatar */}
      {showVideo && remoteStreamURL ? (
        <View style={styles.videoLayer}>
          <RTCViewImpl
            streamURL={remoteStreamURL}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={false}
          />
          {/* Local picture-in-picture */}
          {localStreamURL && !cameraOff ? (
            <View style={styles.pipWrap}>
              <RTCViewImpl
                streamURL={localStreamURL}
                style={StyleSheet.absoluteFill}
                objectFit="cover"
                mirror
              />
            </View>
          ) : null}
          {/* Top overlay: name + duration */}
          <SafeAreaView edges={['top']} style={styles.videoTopOverlay} pointerEvents="none">
            <Text style={styles.videoName}>{otherName}</Text>
            <Text style={styles.videoStatus}>{isActive ? durationLabel : statusText}</Text>
          </SafeAreaView>
          {/* Bottom controls overlay */}
          <SafeAreaView edges={['bottom']} style={styles.videoControlsOverlay}>
            {renderControls()}
          </SafeAreaView>
        </View>
      ) : (
        <LinearGradient colors={gradientColors as any} style={StyleSheet.absoluteFill}>
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.topArea}>
              <View style={styles.topUtilityRow}>
                <View style={styles.topUtilitySide} />
                {topStatusChip ? (
                  <View style={styles.statusChip} testID="call-status-chip">
                    <Text style={styles.statusChipText}>{topStatusChip}</Text>
                  </View>
                ) : (
                  <View style={styles.statusChipSpacer} />
                )}
                <View style={styles.topUtilitySide} />
              </View>

              {/* Pulsing avatar */}
              <RingingAvatar
                name={otherName}
                size={158}
                animate={isIncoming || isOutgoingRinging}
              />

              <Text style={styles.name}>{otherName}</Text>
              <Text style={styles.status}>{primaryCallSubLabel}</Text>
              {secondaryCallSubLabel ? <Text style={styles.subStatus}>{secondaryCallSubLabel}</Text> : null}

              {isOutgoingRinging ? (
                <View style={styles.dotsRow}>
                  <BouncingDot delay={0} />
                  <BouncingDot delay={150} />
                  <BouncingDot delay={300} />
                </View>
              ) : null}

              {permissionDenied ? (
                <Text style={styles.errorText} testID="call-permission-error">
                  Camera or microphone permission denied. Enable them in your device settings to use calls.
                </Text>
              ) : null}
            </View>

            {/* Bottom controls */}
            <View style={styles.controls}>{renderControls()}</View>
          </SafeAreaView>
        </LinearGradient>
      )}
    </View>
  );

  function renderControls() {
    if (isIncoming) {
      return (
        <View style={styles.incomingRow}>
          <View style={styles.incomingCol}>
            <ControlBtn
              testID="decline-call-btn"
              onPress={handleDecline}
              backgroundColor={Colors.danger}
              icon={
                <Ionicons
                  name="call"
                  size={32}
                  color={Colors.white}
                  style={{ transform: [{ rotate: '135deg' }] }}
                />
              }
              label=""
              size="xl"
            />
            <Text style={styles.incomingActionLabel}>Decline</Text>
          </View>
          <View style={styles.incomingCol}>
            <ControlBtn
              testID="answer-call-btn"
              onPress={handleAnswer}
              backgroundColor={Colors.success}
              icon={<Ionicons name="call" size={32} color={Colors.white} />}
              label=""
              size="xl"
            />
            <Text style={styles.incomingActionLabel}>Answer</Text>
          </View>
        </View>
      );
    }
    return (
      <>
        {audioOutputMenuVisible ? (
          <AudioOutputMenu value={audioOutput} onSelect={handleSelectAudioOutput} />
        ) : null}
        <View style={styles.controlsTopRow}>
          <SmallControl
            testID="mute-btn"
            onPress={toggleMute}
            active={muted}
            icon={<Feather name={muted ? 'mic-off' : 'mic'} size={22} color={Colors.white} />}
            label="Mute"
          />
          <SmallControl
            testID="audio-output-btn"
            onPress={() => setAudioOutputMenuVisible((current) => !current)}
            active={audioOutputMenuVisible}
            icon={<Ionicons name="phone-portrait-outline" size={22} color={Colors.white} />}
            label="Audio"
          />
          <SmallControl
            testID="share-screen-btn"
            onPress={toggleScreenShare}
            active={screenSharing}
            icon={<Feather name="monitor" size={22} color={Colors.white} />}
            label="Screen"
          />
          <SmallControl
            testID="add-participant-btn"
            onPress={handleAddParticipant}
            icon={<Ionicons name="person-add-outline" size={22} color={Colors.white} />}
            label="Add"
          />
        </View>
        {callType === 'video' ? (
          <View style={styles.controlsSecondaryRow}>
            <SmallControl
              testID="camera-btn"
              onPress={toggleCamera}
              active={cameraOff}
              icon={<Feather name={cameraOff ? 'video-off' : 'video'} size={22} color={Colors.white} />}
              label="Camera"
            />
            <SmallControl
              testID="flip-camera-btn"
              onPress={flipCamera}
              icon={<Ionicons name="camera-reverse-outline" size={22} color={Colors.white} />}
              label="Flip"
            />
          </View>
        ) : null}
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
            label=""
          />
        </View>
      </>
    );
  }
}

function ControlBtn({
  testID,
  onPress,
  backgroundColor,
  icon,
  label,
  size,
}: {
  testID: string;
  onPress: () => void;
  backgroundColor: string;
  icon: React.ReactNode;
  label: string;
  size?: 'md' | 'xl';
}) {
  const sizeStyle = size === 'xl' ? styles.bigBtnXL : styles.bigBtn;
  return (
    <TouchableOpacity
      style={[sizeStyle, { backgroundColor }]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      {icon}
      {label ? <Text style={styles.bigBtnLabel}>{label}</Text> : null}
    </TouchableOpacity>
  );
}

/**
 * RingingAvatar — avatar with up to three concentric pulsing rings.
 * When `animate=true`, the rings expand and fade in a staggered loop
 * (similar to FaceTime / WhatsApp incoming call screens).
 */
function RingingAvatar({
  name,
  size,
  animate,
}: {
  name: string;
  size: number;
  animate: boolean;
}) {
  const p1 = useSharedValue(0);
  const p2 = useSharedValue(0);
  const p3 = useSharedValue(0);

  useEffect(() => {
    if (animate) {
      const loop = (sv: any, delay: number) => {
        sv.value = 0;
        sv.value = withRepeat(
          withTiming(1, { duration: 2200, easing: Easing.out(Easing.ease) }),
          -1,
          false
        );
      };
      // Stagger the rings
      loop(p1, 0);
      setTimeout(() => loop(p2, 600), 600);
      setTimeout(() => loop(p3, 1200), 1200);
    } else {
      cancelAnimation(p1);
      cancelAnimation(p2);
      cancelAnimation(p3);
      p1.value = 0;
      p2.value = 0;
      p3.value = 0;
    }
    return () => {
      cancelAnimation(p1);
      cancelAnimation(p2);
      cancelAnimation(p3);
    };
  }, [animate, p1, p2, p3]);

  const ringStyle1 = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + p1.value * 0.6 }],
    opacity: 0.45 * (1 - p1.value),
  }));
  const ringStyle2 = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + p2.value * 0.6 }],
    opacity: 0.45 * (1 - p2.value),
  }));
  const ringStyle3 = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + p3.value * 0.6 }],
    opacity: 0.45 * (1 - p3.value),
  }));

  const ringSize = size + 24;
  const initials = name
    .split(' ')
    .map((part) => part.trim().charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <View style={[styles.ringingWrap, { width: ringSize * 1.8, height: ringSize * 1.8 }]}>
      {animate ? (
        <>
          <Animated.View
            style={[
              styles.ring,
              { width: ringSize, height: ringSize, borderRadius: ringSize / 2 },
              ringStyle1,
            ]}
          />
          <Animated.View
            style={[
              styles.ring,
              { width: ringSize, height: ringSize, borderRadius: ringSize / 2 },
              ringStyle2,
            ]}
          />
          <Animated.View
            style={[
              styles.ring,
              { width: ringSize, height: ringSize, borderRadius: ringSize / 2 },
              ringStyle3,
            ]}
          />
        </>
      ) : null}
      <View
        style={[
          styles.callAvatarCore,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
        testID="call-avatar-core"
      >
        <Text style={[styles.callAvatarInitials, { fontSize: size * 0.28 }]}>{initials || '?'}</Text>
      </View>
    </View>
  );
}

function AudioOutputMenu({
  value,
  onSelect,
}: {
  value: AudioOutputRoute;
  onSelect: (next: AudioOutputRoute) => void;
}) {
  const options: Array<{
    key: AudioOutputRoute;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      key: 'earpiece',
      label: 'Earpiece',
      icon: <Ionicons name="phone-portrait-outline" size={22} color={Colors.primary} />,
    },
    {
      key: 'speaker',
      label: 'Speaker',
      icon: <Ionicons name="volume-high-outline" size={22} color="rgba(255,255,255,0.82)" />,
    },
    {
      key: 'bluetooth',
      label: 'Bluetooth',
      icon: <Ionicons name="bluetooth-outline" size={22} color="rgba(255,255,255,0.82)" />,
    },
  ];

  return (
    <View style={styles.audioMenuCard} testID="audio-output-card">
      <Text style={styles.audioMenuTitle}>AUDIO OUTPUT</Text>
      {options.map((option) => {
        const selected = value === option.key;
        return (
          <TouchableOpacity
            key={option.key}
            style={[styles.audioMenuRow, selected ? styles.audioMenuRowSelected : null]}
            onPress={() => onSelect(option.key)}
            activeOpacity={0.82}
            testID={`audio-output-${option.key}`}
          >
            <View style={styles.audioMenuIconWrap}>{option.icon}</View>
            <Text style={[styles.audioMenuLabel, selected ? styles.audioMenuLabelSelected : null]}>
              {option.label}
            </Text>
            {selected ? <View style={styles.audioMenuSelectedDot} /> : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/**
 * Three bouncing dots while we wait for the other side to pick up.
 */
function BouncingDot({ delay }: { delay: number }) {
  const sv = useSharedValue(0);
  useEffect(() => {
    setTimeout(() => {
      sv.value = withRepeat(
        withTiming(1, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        -1,
        true
      );
    }, delay);
    return () => cancelAnimation(sv);
  }, [delay, sv]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: -4 * sv.value }],
    opacity: 0.4 + 0.6 * sv.value,
  }));
  return <Animated.View style={[styles.dot, style]} />;
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
    <View style={styles.smallControlWrap}>
      <TouchableOpacity
        style={[styles.smallBtn, active ? styles.smallBtnActive : null]}
        onPress={onPress}
        activeOpacity={0.85}
        testID={testID}
      >
        {icon}
      </TouchableOpacity>
      <Text style={styles.smallBtnLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.headerBg,
    justifyContent: 'space-between',
  },
  callLoadingScreen: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
  },
  callLoadingText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
    color: Colors.white,
  },
  topArea: {
    alignItems: 'center',
    paddingTop: 18,
    gap: 8,
    paddingHorizontal: Spacing.lg,
    flex: 1,
    justifyContent: 'flex-start',
  },
  topUtilityRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.lg,
    marginBottom: Spacing.base,
  },
  topUtilitySide: {
    width: 44,
    height: 44,
  },
  statusChip: {
    minHeight: 54,
    minWidth: 146,
    paddingHorizontal: 24,
    borderRadius: 28,
    backgroundColor: 'rgba(228,181,59,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(228,181,59,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusChipSpacer: {
    width: 146,
    height: 54,
  },
  statusChipText: {
    color: '#FFD34E',
    fontSize: 18,
    fontWeight: FontWeight.semibold,
  },
  ringingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  ring: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  callAvatarCore: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 6,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  callAvatarInitials: {
    color: 'rgba(255,255,255,0.4)',
    fontWeight: FontWeight.medium,
    letterSpacing: 1.5,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: Spacing.lg,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primaryLight,
  },
  incomingRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    gap: Spacing.xxl,
  },
  incomingCol: {
    alignItems: 'center',
    gap: Spacing.sm,
  },
  incomingActionLabel: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  name: {
    fontSize: 34,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    marginTop: Spacing.lg + 6,
    textAlign: 'center',
  },
  status: {
    fontSize: FontSize.lg,
    color: 'rgba(255,255,255,0.62)',
    fontWeight: FontWeight.regular,
  },
  subStatus: {
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.48)',
    opacity: 1,
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
    gap: 18,
  },
  controlsTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  controlsSecondaryRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.xl,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.lg,
  },
  bigBtn: {
    width: 106,
    height: 106,
    borderRadius: 53,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  bigBtnXL: {
    width: 76,
    height: 76,
    borderRadius: 38,
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
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  smallBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  smallControlWrap: {
    alignItems: 'center',
    width: 76,
    gap: 10,
  },
  smallBtnLabel: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    fontWeight: FontWeight.medium,
    textAlign: 'center',
  },
  audioMenuCard: {
    backgroundColor: 'rgba(28,22,4,0.92)',
    alignSelf: 'center',
    width: '88%',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(228,181,59,0.18)',
    overflow: 'hidden',
    marginBottom: 6,
  },
  audioMenuTitle: {
    color: '#FFD34E',
    fontSize: 16,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.8,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(228,181,59,0.14)',
  },
  audioMenuRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 14,
  },
  audioMenuRowSelected: {
    backgroundColor: 'rgba(228,181,59,0.18)',
  },
  audioMenuIconWrap: {
    width: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioMenuLabel: {
    flex: 1,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 16,
    fontWeight: FontWeight.medium,
  },
  audioMenuLabelSelected: {
    color: '#FFD34E',
  },
  audioMenuSelectedDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#FFD34E',
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
  videoControlsOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    paddingTop: Spacing.xxl,
    gap: Spacing.lg,
    backgroundColor: 'transparent',
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
