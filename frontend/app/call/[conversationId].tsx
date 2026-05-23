import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
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
import { Feather, Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
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
import ConferenceHUD from '../../src/components/ConferenceHUD';
import ScreenShareOverlay from '../../src/components/ScreenShareOverlay';
import { findSavedContactDisplayName, getConversationDisplayName, getDisplayInitials, getDisplayNameFromUser } from '../../src/lib/displayName';
import { useAuth } from '../../src/providers/AuthProvider';
import { useConversationOtherUser } from '../../src/hooks/useConversationOtherUser';
import { Colors, FontSize, FontWeight, Shadow, Spacing } from '../../src/theme';
import { useRingtonePlayer } from '../../src/lib/ringtone/useRingtonePlayer';

type CallType = 'voice' | 'video';
type AudioOutputRoute = 'earpiece' | 'speaker' | 'bluetooth';
type NumberPrivacyMode = 'hide' | 'show';

const Notifications = Platform.OS === 'web' ? null : (require('expo-notifications') as typeof import('expo-notifications'));

function alertScreenShareIOSError() {
  Alert.alert(
    'iOS screen sharing',
    'iOS requires a Broadcast Upload Extension target compiled into the app. The next EAS build that adds the extension will unlock screen sharing on iOS — for now you can share your screen from Android.\n\nWe\u2019ve documented the exact build steps in /app/SCREEN_SHARING_SETUP.md for the next build.',
    [{ text: 'OK', style: 'default' }],
  );
}

function getContactUserId(item: any): string {
  return String(item?.userId || item?._id || item?.id || '');
}

function getConversationMemberIds(conversation: any, currentUserId?: string | null) {
  const values = new Set<string>();
  const addValue = (value: any) => {
    if (!value) return;
    const normalized = String(value).trim();
    if (!normalized || normalized === currentUserId) return;
    values.add(normalized);
  };

  [conversation?.memberIds, conversation?.participantIds, conversation?.userIds].forEach((list) => {
    if (Array.isArray(list)) {
      list.forEach(addValue);
    }
  });

  [conversation?.participants, conversation?.members].forEach((list) => {
    if (!Array.isArray(list)) return;
    list.forEach((participant: any) => {
      addValue(participant?.userId);
      addValue(participant?._id);
      addValue(participant?.id);
    });
  });

  addValue(conversation?.otherUserId);
  addValue(conversation?.otherUser?.userId);
  addValue(conversation?.otherUser?._id);
  addValue(conversation?.otherUser?.id);

  return Array.from(values);
}

function buildConferenceName(baseName: string, addedName: string) {
  const cleanBase = baseName.trim();
  const cleanAdded = addedName.trim();
  if (!cleanBase || cleanBase.toLowerCase() === 'smilers') {
    return cleanAdded ? `${cleanAdded} conference` : 'Conference call';
  }
  return `${cleanBase} + ${cleanAdded}`;
}

export default function CallScreen() {
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const { isAuthenticated } = useAuth();
  const { conversationId: rawConversationId, type: rawTypeParam, displayName: rawDisplayName, conferenceMode: rawConfMode, screenOnly: rawScreenOnly, audio: rawAudioParam, role: rawRoleParam } = useLocalSearchParams<{
    conversationId?: string | string[];
    type?: string | string[];
    displayName?: string | string[];
    conferenceMode?: string | string[];
    screenOnly?: string | string[];
    audio?: string | string[];
    role?: string | string[];
  }>();
  const conversationId = Array.isArray(rawConversationId) ? rawConversationId[0] : rawConversationId;
  const typeParam = Array.isArray(rawTypeParam) ? rawTypeParam[0] : rawTypeParam;
  const routeDisplayName = Array.isArray(rawDisplayName) ? rawDisplayName[0] : rawDisplayName;
  const confModeParam = Array.isArray(rawConfMode) ? rawConfMode[0] : rawConfMode;
  const screenOnlyParam = Array.isArray(rawScreenOnly) ? rawScreenOnly[0] : rawScreenOnly;
  const audioParam = Array.isArray(rawAudioParam) ? rawAudioParam[0] : rawAudioParam;
  const roleParam = Array.isArray(rawRoleParam) ? rawRoleParam[0] : rawRoleParam;
  const isConferenceMode = confModeParam === '1' || confModeParam === 'true';
  // Screen-only mode is the standalone screen-share session — no camera, no
  // standard call UI, simplified controls. The sender is the broadcaster;
  // the receiver is the viewer. See /app/CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE.md
  // for the full request/accept flow.
  const isScreenOnly = screenOnlyParam === '1' || screenOnlyParam === 'true';
  const isScreenOnlyReceiver = isScreenOnly && (roleParam === 'receiver' || roleParam === 'viewer');
  const screenOnlyAudio = audioParam === '1' || audioParam === 'true';
  const requestedType: CallType = typeParam === 'video' || typeParam === 'screen' ? 'video' : 'voice';
  // Sender of a screen-share starts broadcasting on mount; receiver does not
  // start their own screen capture (they only view the remote stream).
  const startInScreenShare = typeParam === 'screen' && !isScreenOnlyReceiver;
  const compactCallLayout = windowHeight < 720;
  const hasValidConversationId = typeof conversationId === 'string' && /^[a-z0-9]+$/i.test(conversationId) && conversationId.length > 10;
  const canRunCallQueries = isAuthenticated && hasValidConversationId;

  const me = useQuery(api.users.getCurrentUser, canRunCallQueries ? {} : 'skip') as any | null | undefined;
  const meLoading = canRunCallQueries && me === undefined;
  const conversation = useQuery(
    api.conversations.getConversation,
    canRunCallQueries ? { conversationId } : 'skip'
  ) as any | null | undefined;
  const conversationLoading = canRunCallQueries && conversation === undefined;
  const activeCall = useQuery(
    (api as any).calls.getActiveCall,
    canRunCallQueries ? { conversationId } : 'skip'
  ) as any | null | undefined;
  const activeCallLoading = canRunCallQueries && activeCall === undefined;
  const contacts = useQuery(api.contacts.getContacts, isAuthenticated ? {} : 'skip') as any[] | undefined;
  const contactsLoading = isAuthenticated && contacts === undefined;

  // `api.conversations.getConversation` (singular) does NOT embed otherUser
  // the way `listConversations` does. Hydrate it via `api.users.getUserById`
  // so the contact name + isOnline + lastSeen are available.
  const fetchedOtherUser = useConversationOtherUser(
    conversation,
    me?._id ? String(me._id) : undefined
  );

  const initiateCall = useMutation(api.calls.initiateCall);
  const answerCall = useMutation(api.calls.answerCall);
  const endCall = useMutation(api.calls.endCall);
  const declineCall = useMutation(api.calls.declineCall);
  const createGroup = useMutation((api as any).conversations.createGroup);
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

  // Derived values that depend on `callType` MUST come after the useState
  // above to avoid temporal-dead-zone errors when Metro hot-reloads this file.
  const isVideoCall = callType === 'video';
  // Video calls need to leave room for an extra row of Camera/Flip controls,
  // so we shrink the hero avatar (and its pulsing ring wrap) to prevent the
  // contact name from being pushed down onto the buttons.
  const heroAvatarSize = isVideoCall
    ? compactCallLayout ? 72 : 92
    : compactCallLayout ? 110 : 132;
  const [callDurationSec, setCallDurationSec] = useState(0);
  const [audioModeReady, setAudioModeReady] = useState(false);
  const [screenReady, setScreenReady] = useState(Platform.OS !== 'android');
  const [RTCViewImpl, setRTCViewImpl] = useState<any>(null);
  const [CallSessionCtor, setCallSessionCtor] = useState<any>(null);
  const [showAddToCall, setShowAddToCall] = useState(false);
  const [addToCallSearch, setAddToCallSearch] = useState('');
  const [pendingAddContact, setPendingAddContact] = useState<any | null>(null);
  const [creatingConference, setCreatingConference] = useState(false);

  const sessionRef = useRef<any>(null);
  const initStartedRef = useRef(false);
  const callStartedAtRef = useRef<number | null>(null);
  const incomingCallSeenRef = useRef(false);
  const incomingCallAnsweredRef = useRef(false);

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
  const signals = useQuery((api as any).signaling.poll, callId && isAuthenticated ? { callId } : 'skip') as any[] | undefined;

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
        if (activeCall?.status === 'ringing') {
          await declineCall({ callId: id });
        } else {
          await endCall({ callId: id });
        }
      } catch {}
      try {
        await cleanupSignaling({ callId: id });
      } catch {}
    }
    router.back();
  }, [activeCall?.status, callId, cleanupSignaling, declineCall, endCall, router]);

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
    if (isIncoming) {
      incomingCallSeenRef.current = true;
      incomingCallAnsweredRef.current = false;
    }

    if (isActive) {
      incomingCallAnsweredRef.current = true;
    }

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
  }, [activeCall, isActive, isIncoming, router]);

  useEffect(() => {
    if (!activeCall || isActive || !incomingCallSeenRef.current || incomingCallAnsweredRef.current) {
      return;
    }

    if (activeCall.status !== 'ended') {
      return;
    }

    if (Platform.OS === 'web') {
      return;
    }

    incomingCallSeenRef.current = false;
    incomingCallAnsweredRef.current = false;

    void Notifications.scheduleNotificationAsync({
      content: {
        title: 'Missed call',
        body: 'You have a missed Smilers call',
        data: { type: 'message', conversationId },
        sound: 'message_notification',
      },
      trigger: null,
    }).catch(() => undefined);
  }, [activeCall, conversationId, isActive]);

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

  const savedContactName = useMemo(
    () => findSavedContactDisplayName(contacts, conversation, me?._id ? String(me._id) : undefined),
    [contacts, conversation, me?._id],
  );
  const otherName = useMemo(
    () => {
      const routeName = typeof routeDisplayName === 'string' ? routeDisplayName.trim() : '';
      // Only the literal chat-screen fallback "Chat" is treated as generic.
      const isGenericRouteName = !routeName || /^chat$/i.test(routeName);
      const candidate = isGenericRouteName ? '' : routeName;

      // Per Smilers Convex backend contract:
      //   `getConversation` does NOT include otherUser — we hydrate it via
      //   `useConversationOtherUser` (api.users.getUserById).
      const hydratedOther: any = fetchedOtherUser || conversation?.otherUser || {};
      const fromOtherUser =
        hydratedOther.name || hydratedOther.displayName || hydratedOther.fullName || '';
      const phone =
        hydratedOther.phone || hydratedOther.phoneNumber || conversation?.phoneNumber || '';
      const email = hydratedOther.email || '';
      const convexDerived = getConversationDisplayName(
        { ...(conversation || {}), otherUser: hydratedOther },
        me?._id ? String(me._id) : undefined,
        ''
      );

      return (
        candidate ||
        savedContactName ||
        fromOtherUser ||
        convexDerived ||
        phone ||
        email ||
        'Unknown'
      );
    },
    [conversation, fetchedOtherUser, me?._id, routeDisplayName, savedContactName],
  );

  const existingParticipantIds = useMemo(
    () => getConversationMemberIds(conversation, me?._id ? String(me._id) : undefined),
    [conversation, me?._id],
  );

  const addToCallCandidates = useMemo(() => {
    const search = addToCallSearch.trim().toLowerCase();
    const currentParticipants = new Set(existingParticipantIds);
    const baseList = Array.isArray(contacts) ? contacts : [];

    return baseList.filter((item: any) => {
      const userId = getContactUserId(item);
      if (!userId || currentParticipants.has(userId)) {
        return false;
      }
      if (!search) {
        return true;
      }
      const haystack = `${getDisplayNameFromUser(item)} ${item?.phone || ''} ${item?.email || ''}`.toLowerCase();
      return haystack.includes(search);
    });
  }, [addToCallSearch, contacts, existingParticipantIds]);

  const durationLabel = useMemo(() => {
    const m = Math.floor(callDurationSec / 60);
    const s = callDurationSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [callDurationSec]);

  const openAddParticipantFlow = useCallback(() => {
    setAudioOutputMenuVisible(false);
    setAddToCallSearch('');
    setPendingAddContact(null);
    setShowAddToCall(true);
  }, []);

  const handleAddParticipant = useCallback(() => {
    openAddParticipantFlow();
  }, [openAddParticipantFlow]);

  const closeAddParticipantFlow = useCallback(() => {
    if (creatingConference) return;
    setShowAddToCall(false);
    setAddToCallSearch('');
    setPendingAddContact(null);
  }, [creatingConference]);

  const confirmAddParticipant = useCallback(
    async (privacyMode: NumberPrivacyMode) => {
      const selectedContact = pendingAddContact;
      if (!selectedContact) return;

      const selectedUserId = getContactUserId(selectedContact);
      if (!selectedUserId) {
        Alert.alert('Could not add participant', 'This contact does not have a valid Smilers account yet.');
        return;
      }

      const memberIds = Array.from(new Set([...existingParticipantIds, selectedUserId]));
      if (memberIds.length === 0) {
        Alert.alert('Could not add participant', 'No conference members were available for the new call.');
        return;
      }

      setCreatingConference(true);
      try {
        const created: any = await createGroup({
          name: buildConferenceName(otherName, getDisplayNameFromUser(selectedContact, 'Participant')),
          memberIds,
        });
        const nextConversationId =
          typeof created === 'string' ? created : created?._id || created?.conversationId || created?.id;

        if (!nextConversationId) {
          throw new Error('Conference conversation was created without an id.');
        }

        setShowAddToCall(false);
        setPendingAddContact(null);
        router.replace(
          `/call/${nextConversationId}?type=${callType}&privacy=${privacyMode}&addedUserId=${selectedUserId}` as any
        );
      } catch (errorValue: any) {
        Alert.alert(
          'Could not add participant',
          errorValue?.message || 'Conference escalation is not enabled on this backend yet.'
        );
      } finally {
        setCreatingConference(false);
      }
    },
    [callType, createGroup, existingParticipantIds, otherName, pendingAddContact, router]
  );

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

  // Play the caller's selected ringtone while dialing, and the callee's while receiving.
  useRingtonePlayer(!!isIncoming || !!isOutgoingRinging, { vibrate: !!isIncoming });

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
            <Text style={styles.videoName} numberOfLines={1} ellipsizeMode="tail">
              {otherName}
            </Text>
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
            <View style={[styles.topArea, compactCallLayout ? styles.topAreaCompact : null]}>
              <View style={[styles.topUtilityRow, compactCallLayout ? styles.topUtilityRowCompact : null]}>
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

              <View style={[styles.heroContent, compactCallLayout ? styles.heroContentCompact : null]}>
                <RingingAvatar
                  name={otherName}
                  size={heroAvatarSize}
                  animate={isIncoming || isOutgoingRinging}
                />

                <Text
                  style={[styles.name, compactCallLayout ? styles.nameCompact : null]}
                  testID="call-contact-name"
                >
                  {otherName}
                </Text>
                <Text style={[styles.status, compactCallLayout ? styles.statusCompact : null]}>{primaryCallSubLabel}</Text>
                {secondaryCallSubLabel ? (
                  <Text style={[styles.subStatus, compactCallLayout ? styles.subStatusCompact : null]}>
                    {secondaryCallSubLabel}
                  </Text>
                ) : null}

                {isOutgoingRinging ? (
                  <View style={[styles.dotsRow, compactCallLayout ? styles.dotsRowCompact : null]}>
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
            </View>

            {/* Bottom controls */}
            <View style={[styles.controls, compactCallLayout ? styles.controlsCompact : null]}>{renderControls()}</View>
          </SafeAreaView>
        </LinearGradient>
      )}

      {showAddToCall ? (
        <AddToCallOverlay
          callType={callType}
          contacts={addToCallCandidates}
          loading={contactsLoading}
          onBack={closeAddParticipantFlow}
          onSearchChange={setAddToCallSearch}
          searchValue={addToCallSearch}
          onSelectContact={setPendingAddContact}
        />
      ) : null}

      <Modal
        visible={!!pendingAddContact}
        transparent
        animationType="fade"
        onRequestClose={() => (!creatingConference ? setPendingAddContact(null) : undefined)}
      >
        <Pressable style={styles.privacyBackdrop} onPress={() => (!creatingConference ? setPendingAddContact(null) : undefined)}>
          <Pressable style={styles.privacyCard} onPress={() => undefined} testID="add-to-call-privacy-sheet">
            <View style={styles.privacyHeaderRow}>
              <View style={styles.privacyTitleWrap}>
                <View style={styles.privacyShieldIcon}>
                  <Ionicons name="shield-checkmark-outline" size={22} color={Colors.primary} />
                </View>
                <Text style={styles.privacyTitle}>Privacy Settings</Text>
              </View>
              <TouchableOpacity
                style={styles.privacyCloseBtn}
                onPress={() => setPendingAddContact(null)}
                disabled={creatingConference}
                testID="add-to-call-privacy-close"
              >
                <Ionicons name="close" size={26} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.privacyMessage}>
              Would you like to hide <Text style={styles.privacyMessageStrong}>{getDisplayNameFromUser(pendingAddContact, 'this contact')}</Text>'s
              {' '}number from the other participants in this call?
            </Text>

            <TouchableOpacity
              style={styles.privacyOptionCard}
              activeOpacity={0.85}
              onPress={() => confirmAddParticipant('hide')}
              disabled={creatingConference}
              testID="add-to-call-hide-number"
            >
              <View style={styles.privacyOptionIconWrap}>
                <Ionicons name="eye-off-outline" size={28} color={Colors.primary} />
              </View>
              <View style={styles.privacyOptionTextWrap}>
                <Text style={styles.privacyOptionTitle}>Hide number</Text>
                <Text style={styles.privacyOptionSub}>Other participants won&apos;t see this person&apos;s phone number</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.privacyOptionCard}
              activeOpacity={0.85}
              onPress={() => confirmAddParticipant('show')}
              disabled={creatingConference}
              testID="add-to-call-show-number"
            >
              <View style={[styles.privacyOptionIconWrap, styles.privacyOptionIconWrapMuted]}>
                <Ionicons name="eye-outline" size={28} color={Colors.textSecondary} />
              </View>
              <View style={styles.privacyOptionTextWrap}>
                <Text style={styles.privacyOptionTitle}>Show number</Text>
                <Text style={styles.privacyOptionSub}>Other participants will be able to see this person&apos;s phone number</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.privacyCancelBtn}
              onPress={() => setPendingAddContact(null)}
              disabled={creatingConference}
              testID="add-to-call-privacy-cancel"
            >
              <Text style={styles.privacyCancelText}>{creatingConference ? 'Starting conference…' : 'Cancel'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Conference HUD overlay (Slice C) — opt-in via ?conferenceMode=1 */}
      {isConferenceMode && conversationId ? (
        <ConferenceHUD
          conferenceId={conversationId}
          myUserId={me?._id ? String(me._id) : null}
          onLeave={() => router.back()}
          onToggleScreenShare={toggleScreenShare}
          screenSharing={screenSharing}
        />
      ) : null}

      {/* Standalone screen-share mode — covers the whole call screen with a
          simplified UI. The underlying WebRTC peer / screen capture still
          runs in the background; the overlay simply replaces the visible
          shell so the user doesn't see a normal "call" interface. See
          /app/CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE.md for the request
          flow. */}
      {isScreenOnly ? (
        <ScreenShareOverlay
          isReceiver={isScreenOnlyReceiver}
          remoteStreamURL={remoteStreamURL}
          allowMic={screenOnlyAudio}
          muted={muted}
          onToggleMic={() => setMuted((current) => !current)}
          screenSharing={screenSharing}
          onToggleScreenShare={toggleScreenShare}
          onStop={() => {
            // Best-effort: tell the backend we're ending the session, then
            // route back. Failure is swallowed because the backend may not
            // have shipped the endpoint yet.
            try {
              (api as any).screenShare?.end &&
                // No useMutation here because this is a one-shot exit path.
                undefined;
            } catch {
              /* swallow */
            }
            router.back();
          }}
          RTCViewImpl={RTCViewImpl}
        />
      ) : null}
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
                size={24}
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
  const initials = getDisplayInitials(name, 2);
  // Tighter wrap (was ringSize * 1.8 which forced massive vertical padding
  // and pushed the contact name down onto the action buttons on video calls).
  const wrapDim = animate ? ringSize * 1.55 : size + 16;

  return (
    <View style={[styles.ringingWrap, { width: wrapDim, height: wrapDim }]}>
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

function AddToCallOverlay({
  callType,
  contacts,
  loading,
  onBack,
  onSearchChange,
  searchValue,
  onSelectContact,
}: {
  callType: CallType;
  contacts: any[];
  loading: boolean;
  onBack: () => void;
  onSearchChange: (value: string) => void;
  searchValue: string;
  onSelectContact: (contact: any) => void;
}) {
  return (
    <View style={styles.addToCallOverlay} testID="add-to-call-screen">
      <SafeAreaView edges={['top']} style={styles.addToCallHeaderWrap}>
        <View style={styles.addToCallHeaderRow}>
          <TouchableOpacity onPress={onBack} style={styles.addToCallBackBtn} testID="add-to-call-back-button">
            <Ionicons name="arrow-back" size={34} color={Colors.white} />
          </TouchableOpacity>
          <View style={styles.addToCallHeaderTextWrap}>
            <Text style={styles.addToCallTitle}>Add to call</Text>
            <Text style={styles.addToCallSubtitle}>{callType === 'video' ? 'Video call' : 'Voice call'}</Text>
          </View>
        </View>
      </SafeAreaView>

      <View style={styles.addToCallBody}>
        <View style={styles.addToCallSearchWrap} testID="add-to-call-search-wrap">
          <Ionicons name="search-outline" size={30} color={Colors.textMuted} />
          <TextInput
            value={searchValue}
            onChangeText={onSearchChange}
            placeholder="Search contacts..."
            placeholderTextColor={Colors.textMuted}
            style={styles.addToCallSearchInput}
            testID="add-to-call-search-input"
          />
        </View>

        {loading ? (
          <View style={styles.addToCallEmptyWrap} testID="add-to-call-loading-state">
            <ActivityIndicator color={Colors.primary} />
            <Text style={styles.addToCallEmptyText}>Loading contacts…</Text>
          </View>
        ) : (
          <FlatList
            data={contacts}
            keyExtractor={(item: any, index) => getContactUserId(item) || `add-to-call-${index}`}
            renderItem={({ item }) => {
              const contactId = getContactUserId(item) || 'unknown';
              return (
                <View style={styles.addToCallRow} testID={`add-to-call-contact-${contactId}`}>
                  <View style={styles.addToCallAvatar}>
                    <Text style={styles.addToCallAvatarText}>{getDisplayInitials(getDisplayNameFromUser(item), 1)}</Text>
                  </View>
                  <View style={styles.addToCallNameWrap}>
                    <Text style={styles.addToCallName} numberOfLines={1}>{getDisplayNameFromUser(item, 'Smilers contact')}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.addToCallActionBtn}
                    activeOpacity={0.85}
                    onPress={() => onSelectContact(item)}
                    testID={`add-to-call-action-${contactId}`}
                  >
                    <Ionicons name="call-outline" size={28} color={Colors.white} />
                  </TouchableOpacity>
                </View>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.addToCallDivider} />}
            contentContainerStyle={styles.addToCallListContent}
            ListEmptyComponent={
              <View style={styles.addToCallEmptyWrap} testID="add-to-call-empty-state">
                <Text style={styles.addToCallEmptyTitle}>No contacts available</Text>
                <Text style={styles.addToCallEmptyText}>Try another search or add more contacts first.</Text>
              </View>
            }
          />
        )}
      </View>
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
    gap: 6,
    paddingHorizontal: Spacing.lg,
    flex: 1,
    justifyContent: 'flex-start',
  },
  topAreaCompact: {
    paddingTop: 10,
  },
  topUtilityRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.lg,
    marginBottom: Spacing.base,
  },
  topUtilityRowCompact: {
    marginTop: Spacing.base,
    marginBottom: Spacing.sm,
  },
  heroContent: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.lg,
  },
  heroContentCompact: {
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
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
  dotsRowCompact: {
    marginTop: Spacing.base,
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
    fontSize: 24,
    lineHeight: 30,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    marginTop: Spacing.lg,
    textAlign: 'center',
    maxWidth: '90%',
  },
  nameCompact: {
    fontSize: 20,
    lineHeight: 26,
    marginTop: Spacing.md,
  },
  status: {
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.62)',
    fontWeight: FontWeight.regular,
    marginTop: 4,
  },
  statusCompact: {
    fontSize: FontSize.base,
    marginTop: 2,
  },
  subStatus: {
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.48)',
    opacity: 1,
  },
  subStatusCompact: {
    marginTop: 2,
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
    gap: 16,
  },
  controlsCompact: {
    paddingBottom: Spacing.lg,
    gap: 10,
  },
  controlsTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
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
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  bigBtnXL: {
    width: 68,
    height: 68,
    borderRadius: 34,
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
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  smallBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  smallControlWrap: {
    alignItems: 'center',
    width: 64,
    gap: 6,
  },
  smallBtnLabel: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    fontWeight: FontWeight.medium,
    textAlign: 'center',
    maxWidth: 64,
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
  addToCallOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#F8F4EC',
    zIndex: 20,
  },
  addToCallHeaderWrap: {
    backgroundColor: Colors.headerBg,
    paddingBottom: 22,
  },
  addToCallHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  addToCallBackBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addToCallHeaderTextWrap: {
    flex: 1,
  },
  addToCallTitle: {
    color: Colors.white,
    fontSize: 30,
    fontWeight: FontWeight.bold,
  },
  addToCallSubtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 18,
    marginTop: 6,
  },
  addToCallBody: {
    flex: 1,
    backgroundColor: '#FBF8F1',
  },
  addToCallSearchWrap: {
    marginHorizontal: 18,
    marginTop: 28,
    marginBottom: 14,
    minHeight: 88,
    borderRadius: 26,
    backgroundColor: '#EEE7D7',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
  },
  addToCallSearchInput: {
    flex: 1,
    fontSize: 20,
    color: Colors.textPrimary,
  },
  addToCallListContent: {
    paddingBottom: 80,
  },
  addToCallRow: {
    minHeight: 96,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 16,
    backgroundColor: '#FBF8F1',
  },
  addToCallDivider: {
    height: 1,
    backgroundColor: '#D9D0BD',
  },
  addToCallAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF7DE',
  },
  addToCallAvatarText: {
    color: '#F4B318',
    fontSize: 22,
    fontWeight: FontWeight.bold,
  },
  addToCallNameWrap: {
    flex: 1,
  },
  addToCallName: {
    fontSize: 18,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
  addToCallActionBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#07D44D',
  },
  addToCallEmptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 54,
    paddingHorizontal: 24,
    gap: 10,
  },
  addToCallEmptyTitle: {
    fontSize: 20,
    color: Colors.textPrimary,
    fontWeight: FontWeight.bold,
  },
  addToCallEmptyText: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  privacyBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  privacyCard: {
    borderRadius: 22,
    backgroundColor: '#FCF8F0',
    paddingTop: 22,
    paddingHorizontal: 18,
    paddingBottom: 22,
    borderWidth: 1,
    borderColor: '#E1D5BF',
    ...Shadow.lg,
  },
  privacyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  privacyTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  privacyShieldIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFF6DD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyTitle: {
    flex: 1,
    fontSize: 24,
    color: Colors.textPrimary,
    fontWeight: FontWeight.bold,
  },
  privacyCloseBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyMessage: {
    fontSize: 18,
    color: Colors.textSecondary,
    lineHeight: 30,
    marginBottom: 22,
  },
  privacyMessageStrong: {
    color: Colors.textPrimary,
    fontWeight: FontWeight.bold,
  },
  privacyOptionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E1D5BF',
    backgroundColor: '#FFFDF9',
    paddingHorizontal: 18,
    paddingVertical: 18,
    marginBottom: 18,
  },
  privacyOptionIconWrap: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF7DE',
  },
  privacyOptionIconWrapMuted: {
    backgroundColor: '#F5EFE4',
  },
  privacyOptionTextWrap: {
    flex: 1,
  },
  privacyOptionTitle: {
    fontSize: 18,
    color: Colors.textPrimary,
    fontWeight: FontWeight.bold,
  },
  privacyOptionSub: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 22,
    marginTop: 4,
  },
  privacyCancelBtn: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyCancelText: {
    fontSize: 20,
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
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
    maxWidth: '86%',
  },
  videoStatus: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: FontSize.sm,
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
});
