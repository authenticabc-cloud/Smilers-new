import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
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
import { Feather, Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Camera } from 'expo-camera';
import { setAudioModeAsync } from 'expo-audio';
import CallBackground from '../../src/components/CallBackground';
import InviteContactPicker from '../../src/components/InviteContactPicker';
import { stashCallHandoff } from '../../src/lib/call/handoff';
import { InCallAudio } from '../../src/lib/webrtc/inCallManager';
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
import CallDebugOverlay from '../../src/components/CallDebugOverlay';
import { callDebug } from '../../src/lib/callDebugLog';
import CallErrorBoundary from '../../src/components/CallErrorBoundary';
import ConferenceHUD from '../../src/components/ConferenceHUD';
import ScreenShareOverlay from '../../src/components/ScreenShareOverlay';
import ScreenShareSwitchControls from '../../src/components/ScreenShareSwitchControls';
import { findSavedContactDisplayName, getConversationDisplayName, getDisplayInitials, getDisplayNameFromUser } from '../../src/lib/displayName';
import { useAuth } from '../../src/providers/AuthProvider';
import { notifyEventPush } from '../../src/lib/notifyPush';
import { useConversationOtherUser } from '../../src/hooks/useConversationOtherUser';
import { useReactiveSafeConvexQuery } from '../../src/hooks/useReactiveSafeConvexQuery';
import { useEngagementTracker } from '../../src/hooks/useEngagementTracker';
import { Colors, FontSize, FontWeight, Shadow, Spacing } from '../../src/theme';
import { useRingtonePlayer } from '../../src/lib/ringtone/useRingtonePlayer';
import { setPipParams, enterPip, isPipSupported, useIsInPip } from '../../src/lib/pip';
import { callHost, useCallHost } from '../../src/lib/call/callHost';

type CallType = 'voice' | 'video';
type AudioOutputRoute = 'earpiece' | 'speaker' | 'bluetooth';

const Notifications = Platform.OS === 'web' ? null : (require('expo-notifications') as typeof import('expo-notifications'));

function alertScreenShareIOSError() {
  Alert.alert(
    'iOS screen sharing',
    'iOS requires a Broadcast Upload Extension target compiled into the app. The next EAS build that adds the extension will unlock screen sharing on iOS — for now you can share your screen from Android.\n\nWe\u2019ve documented the exact build steps in /app/SCREEN_SHARING_SETUP.md for the next build.',
    [{ text: 'OK', style: 'default' }],
  );
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
  // This route is now a thin SHIM. The live call UI is rendered once at the
  // app root by <CallHost/> (see src/components/call/CallHost.tsx) so it can be
  // minimized into a floating window without dropping the WebRTC session.
  // We forward the route params into the callHost store, then pop this screen
  // so the user lands back on a browsable screen with the call as an overlay.
  const router = useRouter();
  const params = useLocalSearchParams();
  const forwardedRef = useRef(false);
  useEffect(() => {
    if (forwardedRef.current) return;
    forwardedRef.current = true;
    const flat: Record<string, string> = {};
    Object.entries(params || {}).forEach(([key, value]) => {
      const v = Array.isArray(value) ? value[0] : value;
      if (typeof v === 'string') flat[key] = v;
    });
    callHost.start(flat);
    // Pop this empty shim route; if there's nothing to pop (cold start from a
    // push), land on the chats tab so the overlay has a screen behind it.
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/chats' as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={{ flex: 1, backgroundColor: '#0b141a' }} testID="call-route-shim" />
  );
}

export function CallScreenInner() {
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const { isAuthenticated } = useAuth();
  // Params now come from the callHost store (this component is rendered by
  // <CallHost/> at the app root), not from route params — see the shim above.
  const { params: hostParams, mode: callHostMode } = useCallHost();
  const isMini = callHostMode === 'mini';
  const {
    conversationId: rawConversationId,
    type: rawTypeParam,
    displayName: rawDisplayName,
    conferenceMode: rawConfMode,
    screenOnly: rawScreenOnly,
    audio: rawAudioParam,
    role: rawRoleParam,
    convId: rawConvIdParam,
    peerUserId: rawPeerUserIdParam,
  } = (hostParams || {}) as Record<string, string | undefined>;
  const conversationId = Array.isArray(rawConversationId) ? rawConversationId[0] : rawConversationId;
  const typeParam = Array.isArray(rawTypeParam) ? rawTypeParam[0] : rawTypeParam;
  const routeDisplayName = Array.isArray(rawDisplayName) ? rawDisplayName[0] : rawDisplayName;
  const confModeParam = Array.isArray(rawConfMode) ? rawConfMode[0] : rawConfMode;
  const screenOnlyParam = Array.isArray(rawScreenOnly) ? rawScreenOnly[0] : rawScreenOnly;
  const audioParam = Array.isArray(rawAudioParam) ? rawAudioParam[0] : rawAudioParam;
  const roleParam = Array.isArray(rawRoleParam) ? rawRoleParam[0] : rawRoleParam;
  // Optional explicit conversationId override — used by /screen-share and
  // IncomingScreenShareModal in screen-only mode, where the URL's path param
  // (`conversationId`) is actually a screen-share *session* id, not a real
  // conversation id. When present, prefer this for `getConversation`.
  const convIdParam = Array.isArray(rawConvIdParam) ? rawConvIdParam[0] : rawConvIdParam;
  // Required by `screenSharing.sendSignal` — the other party's user id. Set
  // by /screen-share (sender knows recipient) and IncomingScreenShareModal
  // (receiver knows sharer via session.requesterId). Without this we cannot
  // route signaling messages through the per-recipient screenSharing queue.
  const peerUserIdParam = Array.isArray(rawPeerUserIdParam) ? rawPeerUserIdParam[0] : rawPeerUserIdParam;
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
  // Real conversationId for the Convex queries — prefers the explicit
  // `convId` URL param (screen-share path), falls back to the route segment.
  const effectiveConversationId =
    convIdParam && /^[a-z0-9]+$/i.test(convIdParam) && convIdParam.length > 10
      ? convIdParam
      : conversationId;
  const hasValidEffectiveConversationId =
    typeof effectiveConversationId === 'string' &&
    /^[a-z0-9]+$/i.test(effectiveConversationId) &&
    effectiveConversationId.length > 10;
  const canRunCallQueries = isAuthenticated && hasValidConversationId;

  const me = useQuery(api.users.getCurrentUser, canRunCallQueries ? {} : 'skip') as any | null | undefined;
  const meLoading = canRunCallQueries && me === undefined;
  // `getConversation` is wrapped in the REACTIVE safe-query hook so a
  // server-side error (invalid id, transient auth blip, schema mismatch
  // etc.) doesn't bubble into a render crash — the call screen continues
  // with whatever `routeDisplayName` we have from the URL. The Convex
  // request id error the user saw historically came from screen-only
  // mode passing a screen-share *session* id to this query; we now use
  // the explicit `convId` URL param when available, so this is a
  // safety net for any future ID mismatch.
  const { data: conversationData, loading: conversationLoadingRaw } = useReactiveSafeConvexQuery<any>(
    api.conversations.getConversation,
    hasValidEffectiveConversationId ? { conversationId: effectiveConversationId } : undefined,
    null,
    !!isAuthenticated && hasValidEffectiveConversationId,
  );
  const conversation = conversationData as any | null;
  const conversationLoading = canRunCallQueries && conversationLoadingRaw;
  // `getActiveCall` is wrapped in the REACTIVE safe-query hook for the same
  // reason `getConversation` is — a Server Error here used to bubble into a
  // render crash and the user saw "Call ended unexpectedly [CONVEX
  // Q(calls:getActiveCall)] Server Error" the moment they entered the call
  // screen. This happened in two ways:
  //
  //   1. Screen-share and conference modes pass a screen-share-session id
  //      / conference id as the route segment. The backend's
  //      `calls.getActiveCall` validator expects a real conversation id
  //      and throws a Server Error on mismatch.
  //   2. For regular calls a transient backend hiccup or auth gap
  //      surfaces as the same Server Error.
  //
  // In screen-only AND conference mode we explicitly skip the query —
  // those modes don't use the `calls` table at all (screen-only uses
  // `screenSharingSessions`, conference uses `conferences`). For normal
  // calls the safe-query wrapper lets us continue with `null` instead of
  // crashing.
  const shouldQueryActiveCall =
    canRunCallQueries && !isScreenOnly && !isConferenceMode;
  const { data: activeCallData, loading: activeCallLoadingRaw } =
    useReactiveSafeConvexQuery<any>(
      (api as any).calls.getActiveCall,
      shouldQueryActiveCall ? { conversationId } : undefined,
      null,
      shouldQueryActiveCall,
    );
  const activeCall = activeCallData as any | null;
  const activeCallLoading = shouldQueryActiveCall && activeCallLoadingRaw;
  const contacts = useQuery(api.contacts.getContacts, isAuthenticated ? {} : 'skip') as any[] | undefined;

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
  // iter-137 engagement tracking — fires `api.earnings.trackCall` on
  // hangup. See useEngagementTracker for thresholds (must connect).
  const engagement = useEngagementTracker();
  const declineCall = useMutation(api.calls.declineCall);
  const inviteToCall = useMutation((api as any).callInvites.invite);
  const requestVideoUpgrade = useMutation((api as any).calls.requestVideoUpgrade);
  // Backend-confirmed contract (June 2025): `api.calls.heartbeat({ callId })`
  // is wired up to a 60s cron that auto-`ends` calls without a recent ping.
  // Without this mobile-side heartbeat ping, an active call gets force-ended
  // within 60–90s of being answered, which manifested on the receiver as
  // "Call ended unexpectedly" the moment they answered. (Cast as `any` since
  // the cached anyApi proxy can be undefined-tolerant when the backend is
  // mid-deploy.)
  const heartbeat = useMutation((api as any).calls.heartbeat);
  const sendSignal = useMutation(api.signaling.send);
  const markConsumed = useMutation(api.signaling.markConsumed);
  // Per the backend team's June-2025 spec (and what their logs show is wired
  // up): screen-share sessions DO NOT use `api.signaling.*` — that endpoint
  // has a strict `v.id("calls")` validator that rejects screen-share session
  // ids. Instead use the dedicated `api.screenSharing.sendSignal` /
  // `pollSignals` / `markSignalsConsumed`, which are keyed by `{sessionId,
  // toUserId}` and route through a per-recipient queue.
  const sendScreenSignal = useMutation((api as any).screenSharing?.sendSignal);
  const markScreenSignalsConsumed = useMutation((api as any).screenSharing?.markSignalsConsumed);

  // iter-189: drains `screenSignalQueueRef` IN ORDER with patient retries.
  // The backend Server-Errors on `sendSignal` until the recipient ACCEPTS
  // the request (the session row only becomes signalable then), so giving
  // up after 3 fast attempts (~2s) dropped the offer forever. We retry the
  // head of the queue every 2.5s for up to 2 minutes instead.
  const flushScreenSignalQueue = useCallback(async () => {
    if (screenSignalFlushActiveRef.current) return;
    screenSignalFlushActiveRef.current = true;
    const RETRY_MS = 2500;
    const DEADLINE_MS = 120000;
    try {
      while (screenSignalQueueRef.current.length > 0) {
        const sig = screenSignalQueueRef.current[0];
        if (!conversationId || !peerUserIdParam) {
          console.warn('screen-share signal dropped — missing sessionId or peerUserId');
          screenSignalQueueRef.current.shift();
          continue;
        }
        try {
          await (sendScreenSignal as any)({
            sessionId: conversationId,
            toUserId: peerUserIdParam,
            type: sig.type,
            payload: sig.payload,
          });
          screenSignalQueueRef.current.shift();
          if (screenSignalFirstFailAtRef.current) {
            callDebug.push(
              'SIG',
              `→ ${sig.type} screen-share delivered (recipient accepted) — flushing ${screenSignalQueueRef.current.length} queued signal(s)`,
            );
            screenSignalFirstFailAtRef.current = null;
          }
        } catch (errorValue: any) {
          const message = String(errorValue?.message || '');
          const isValidation =
            message.includes('ArgumentValidationError') ||
            message.includes('Validator error') ||
            message.toLowerCase().includes('union') ||
            message.toLowerCase().includes('literal');
          if (isValidation && sig.type === 'ice-candidate') {
            // Literal-name compat: some deployments validate 'iceCandidate'.
            try {
              await (sendScreenSignal as any)({
                sessionId: conversationId,
                toUserId: peerUserIdParam,
                type: 'iceCandidate',
                payload: sig.payload,
              });
              screenSignalQueueRef.current.shift();
              callDebug.push('SIG', '→ iceCandidate screen-share (camel variant) ok');
              continue;
            } catch {
              /* fall through to the retry/backoff path */
            }
          }
          if (!screenSignalFirstFailAtRef.current) {
            screenSignalFirstFailAtRef.current = Date.now();
            callDebug.push(
              'SIG',
              `→ ${sig.type} rejected — queued, retrying every ${RETRY_MS / 1000}s until the recipient accepts. Backend said: ${message.slice(0, 160)}`,
            );
          }
          if (Date.now() - screenSignalFirstFailAtRef.current > DEADLINE_MS) {
            callDebug.push(
              'ERR',
              `screen-share signaling gave up after ${DEADLINE_MS / 1000}s (${screenSignalQueueRef.current.length} undelivered). Last backend error: ${message.slice(0, 300)}`,
            );
            screenSignalQueueRef.current = [];
            screenSignalFirstFailAtRef.current = null;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    } finally {
      screenSignalFlushActiveRef.current = false;
    }
  }, [sendScreenSignal, conversationId, peerUserIdParam]);
  // Stable ref so the CallSession closure (created once per session) always
  // calls the freshest flusher.
  const flushScreenSignalQueueRef = useRef(flushScreenSignalQueue);
  useEffect(() => {
    flushScreenSignalQueueRef.current = flushScreenSignalQueue;
  }, [flushScreenSignalQueue]);

  const [callId, setCallId] = useState<string | null>(null);
  const [callType, setCallType] = useState<CallType>(requestedType);
  const [localStreamURL, setLocalStreamURL] = useState<string | null>(null);
  const [remoteStreamURL, setRemoteStreamURL] = useState<string | null>(null);
  // Bumps whenever the remote stream's video-track presence changes. react-native-webrtc
  // does NOT repaint an already-mounted <RTCView> when a video track is added to the
  // SAME stream mid-call (e.g. a voice→video upgrade). We use this as a remount `key`
  // so the remote view re-attaches and renders the newly-arrived camera track.
  const [remoteVideoGen, setRemoteVideoGen] = useState(0);
  const remoteHasVideoRef = useRef(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [audioOutput, setAudioOutput] = useState<AudioOutputRoute>(requestedType === 'voice' ? 'earpiece' : 'speaker');
  const [audioOutputMenuVisible, setAudioOutputMenuVisible] = useState(false);
  const [screenSharing, setScreenSharing] = useState(startInScreenShare);
  // Screen-share quality profile chosen via the in-share toggle. 'sharp'
  // keeps near-native resolution (text/code), 'smooth' favours framerate
  // (scrolling video), 'auto' switches between them based on detected
  // motion. Applied through CallSession.setScreenQuality().
  const [screenQuality, setScreenQuality] = useState<'sharp' | 'smooth' | 'auto'>('auto');
  // In 'auto' mode, the profile the motion-detector is currently using
  // (for display only).
  const [autoActiveProfile, setAutoActiveProfile] = useState<'sharp' | 'smooth'>('sharp');
  const [statusText, setStatusText] = useState('Connecting…');
  const [permissionDenied, setPermissionDenied] = useState(false);
  // iter-189: true once the WebRTC connection actually reaches 'connected'.
  // The screen-only sharer UI uses this to say "Waiting for the recipient
  // to accept…" instead of falsely claiming the screen is being seen.
  const [peerConnected, setPeerConnected] = useState(false);

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

  const sessionRef = useRef<any>(null);
  // The resolved remote 1:1 partner id — captured for seamless conference
  // handoff (we hand this peer's live connection over to the mesh).
  const partnerUserIdRef = useRef<string | null>(null);
  const initStartedRef = useRef(false);
  // iter-189 screen-share signaling queue. The sharer enters this screen
  // IMMEDIATELY after `requestScreenShare` — before the recipient accepts —
  // and the backend's `screenSharing.sendSignal` Server-Errors on signals
  // for a session that isn't active yet. The user's debug overlay showed
  // offer + ICE all dying within ~2s (3 fast retries). Signals are now kept
  // in an ORDERED queue (offer must land before ICE) and retried every
  // 2.5s for up to 2 minutes, so they deliver the moment the recipient
  // accepts the request.
  const screenSignalQueueRef = useRef<Array<{ type: string; payload: any }>>([]);
  const screenSignalFlushActiveRef = useRef(false);
  const screenSignalFirstFailAtRef = useRef<number | null>(null);
  const callStartedAtRef = useRef<number | null>(null);
  const incomingCallSeenRef = useRef(false);
  const incomingCallAnsweredRef = useRef(false);
  // Tracks whether InCallManager.start() has been invoked for this call. We
  // only want to fire start() once per CallSession — subsequent audioOutput
  // changes go through chooseAudioRoute() / setSpeakerOn() instead.
  const inCallStartedRef = useRef(false);
  // iter-187: while an INCOMING call is still ringing (unanswered), DON'T
  // start the native in-call session yet. MODE_IN_COMMUNICATION mutes the
  // media stream, which silenced the expo-audio ringtone the moment all
  // permissions were granted (the "rings only before allowing
  // notifications" bug). The session starts the instant the call is
  // answered (effect below). Mirrored as a ref so applyAudioMode
  // (declared earlier than the role derivation) can read it without
  // TDZ issues.
  const suppressSessionStartRef = useRef(false);
  // sessionReadyTick — bumped each time sessionRef.current transitions from
  // null → a real CallSession instance. The signal-processing useEffect at
  // line ~864 used to bail out early if `sessionRef.current` was null,
  // and because Convex `signaling.poll` returns the SAME array reference
  // (no diff) once the offer lands, it would never re-fire after the
  // session was built → the offer/ICE were dropped forever and the call
  // sat in 76s of silence (the exact pattern in iter-93 diagnostic logs).
  // By incrementing this tick whenever the session becomes available,
  // we force the effect to re-run and process any queued signals.
  const [sessionReadyTick, setSessionReadyTick] = useState(0);

  const applyAudioMode = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      // expo-audio replaces the deprecated expo-av Audio.setAudioModeAsync.
      // The field names are different from expo-av, see Audio.types.d.ts:
      //   playsInSilentMode (was playsInSilentModeIOS)
      //   allowsRecording   (was allowsRecordingIOS)
      //   shouldPlayInBackground (was staysActiveInBackground)
      //   interruptionMode    (was shouldDuckAndroid boolean)
      //   shouldRouteThroughEarpiece (was playThroughEarpieceAndroid)
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
        shouldPlayInBackground: false,
        interruptionMode: 'duckOthers',
        shouldRouteThroughEarpiece:
          audioOutput !== 'speaker' && callType === 'voice',
      });
    } catch (errorValue: any) {
      console.warn('setAudioModeAsync failed:', errorValue?.message);
    }

    // ─────────────────────────────────────────────────────────────────────
    // react-native-incall-manager handles the LOW-LEVEL Android audio
    // routing that `setAudioModeAsync` can't reliably control:
    //   • Switches Android into MODE_IN_COMMUNICATION (required for the
    //     speaker/earpiece switch to actually work during a WebRTC call).
    //   • Acquires a wake-lock so the screen stays on during the call.
    //   • Routes audio to the right output (SPEAKER_PHONE / EARPIECE /
    //     BLUETOOTH) via Android's AudioManager.
    //
    // We start() it ONCE per call (tracked via inCallStartedRef) and then
    // change routes through the chooseAudioRoute path for every subsequent
    // audioOutput change.
    // ─────────────────────────────────────────────────────────────────────
    if (!inCallStartedRef.current && !suppressSessionStartRef.current) {
      // iter-2xx: request BLUETOOTH_CONNECT *before* starting the native
      // session. The native start() spins up the BluetoothManager which can
      // only enumerate a paired headset when the app already holds this
      // permission — requesting it lazily (after start) meant Bluetooth never
      // appeared in the device list, so both auto-detect and manual selection
      // were silently ignored and audio fell back to the speaker.
      await InCallAudio.ensureBluetoothPermission();
      InCallAudio.start(callType === 'video' ? 'video' : 'audio');
      inCallStartedRef.current = true;
      callDebug.push(
        'AUDIO',
        `InCallManager.start(${callType === 'video' ? 'video' : 'audio'})`,
      );
    }
    if (!inCallStartedRef.current) {
      // Session not started yet (incoming still ringing) — skip routing
      // calls below; they'll be applied when the session starts.
      return;
    }
    if (audioOutput === 'speaker') {
      InCallAudio.setSpeakerOn(true);
    } else if (audioOutput === 'bluetooth') {
      InCallAudio.setBluetoothOn();
    } else {
      // 'earpiece' (default for voice calls)
      InCallAudio.setEarpieceOn();
    }
    callDebug.push('AUDIO', `route=${audioOutput} mode=${callType}`);
  }, [audioOutput, callType]);

  // iter-194 / iter-2xx: auto-switch audio to Bluetooth whenever a headset
  // is available (paired before the call OR connected mid-call) and the user
  // hasn't explicitly chosen a different output. We no longer rely solely on
  // the false→true transition, because if the headset was already connected
  // when the session started the first device event can arrive before our
  // listener subscribes — that race left video calls stuck on the speaker.
  // Android-only; iOS AVAudioSession already auto-routes to Bluetooth.
  const btWasAvailableRef = useRef(false);
  const userPickedRouteRef = useRef(false);
  useEffect(() => {
    const unsubscribe = InCallAudio.addAudioDeviceChangedListener(({ available }) => {
      const btAvailable = available.includes('BLUETOOTH');
      if (btAvailable && !userPickedRouteRef.current) {
        callDebug.push('AUDIO', 'Bluetooth available — auto-routing to headset');
        setAudioOutput((current) => (current === 'bluetooth' ? current : 'bluetooth'));
      } else if (!btAvailable && btWasAvailableRef.current) {
        callDebug.push('AUDIO', 'Bluetooth headset disconnected — falling back');
        setAudioOutput((current) =>
          current === 'bluetooth' ? (callType === 'video' ? 'speaker' : 'earpiece') : current,
        );
      }
      btWasAvailableRef.current = btAvailable;
    });
    return unsubscribe;
  }, [callType]);

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

  // Subscribe to incoming signaling messages — the channel depends on mode.
  //
  // • Regular calls: `api.signaling.poll({ callId })` — strict callId validator,
  //   keyed by the calls-table id.
  //
  // • Screen-share sessions: `api.screenSharing.pollSignals({ sessionId })` —
  //   keyed by the screen-share session id (NOT a calls-table id). The backend
  //   team confirmed this is the right channel for screen sharing; using
  //   `signaling.poll` with a session id silently fails its `v.id("calls")`
  //   validator. See iteration-78 fix.
  const regularSignals = useQuery(
    (api as any).signaling.poll,
    !isScreenOnly && callId && isAuthenticated ? { callId } : 'skip',
  ) as any[] | undefined;
  const screenShareSignalsRaw = useReactiveSafeConvexQuery<any[]>(
    (api as any).screenSharing?.pollSignals,
    isScreenOnly && conversationId ? { sessionId: conversationId } : undefined,
    [],
    !!(isScreenOnly && conversationId && isAuthenticated),
  );
  const signals = (isScreenOnly ? screenShareSignalsRaw.data : regularSignals) as any[] | undefined;

  // Derived role: outgoing if I'm the caller, incoming otherwise.
  //
  // ⚠ Backend-schema tolerance: the Convex `calls` row exposes the caller's
  // user id under EITHER `callerId` (legacy) OR `callerUserId` (per the new
  // spec in /app/CONVEX_BACKEND_INSTRUCTIONS_URGENT_MOBILE_BLOCKERS.md §A.3).
  // We accept both so the call screen keeps working through the backend
  // migration without rebuilding the mobile binary.
  const activeCallCallerId = activeCall
    ? (activeCall as any).callerId || (activeCall as any).callerUserId || null
    : null;
  const isCaller = !!(activeCallCallerId && me && activeCallCallerId === me._id);
  const isIncoming = !!(
    activeCallCallerId &&
    me &&
    activeCallCallerId !== me._id &&
    activeCall?.status === 'ringing'
  );
  const isOutgoingRinging = isCaller && activeCall?.status === 'ringing';
  const isActive = activeCall?.status === 'active';

  // iter-187: keep the session-suppression ref in sync with the role.
  // While an incoming call rings we hold the native audio session back so
  // the in-app ringtone (expo-audio, media stream) is audible; the moment
  // the call is answered (status → active) we lift the gate and start the
  // session right here.
  useEffect(() => {
    suppressSessionStartRef.current = !!isIncoming && !isScreenOnly;
    if (!suppressSessionStartRef.current && audioModeReady && !inCallStartedRef.current) {
      void applyAudioMode();
    }
  }, [isIncoming, isScreenOnly, audioModeReady, applyAudioMode]);

  // iter-187: CALLER-SIDE RINGBACK through InCallManager's native ringback
  // (voice-call stream — not muted by MODE_IN_COMMUNICATION). Replaces the
  // expo-audio ringback that fell silent as soon as the in-call session
  // started (= as soon as all permissions were granted).
  useEffect(() => {
    if (Platform.OS === 'web' || isScreenOnly) return undefined;
    if (!isOutgoingRinging) return undefined;
    InCallAudio.startRingback();
    return () => {
      InCallAudio.stopRingback();
    };
  }, [isOutgoingRinging, isScreenOnly]);

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
      !meLoading &&
      // Screen-only mode (standalone screen share) MUST NOT trigger a regular
      // call — otherwise the recipient would hear a ringtone. The screen-share
      // session is created up-front by /screen-share via
      // api.screenSharing.requestScreenShare and the recipient is notified
      // silently via IncomingScreenShareModal (subscribes to listIncoming).
      !isScreenOnly &&
      // Conference mode similarly must NOT touch the `calls` table — it uses
      // the separate `conferences` table and its own signaling channel.
      !isConferenceMode;
    if (!shouldAutoInitiate) return;
    let cancelled = false;
    (async () => {
      try {
        const id: any = await initiateCall({ conversationId, callType: requestedType });
        if (!cancelled && id) setCallId(id);
        // iter-198 SENDER-SIDE CALL PUSH: ring the callee's device even when
        // their app is killed. The Convex backend's own push trigger was
        // proven absent during live diagnosis (2026-06-12), so the caller's
        // device fires the FCM push directly via our FastAPI backend. The
        // backend dedupes by call id if Convex triggers ever come back.
        if (id) {
          try {
            const meId = me?._id ? String(me._id) : null;
            const recipients = getConversationMemberIds(
              { ...(conversation || {}), otherUser: (conversation as any)?.otherUser || fetchedOtherUser },
              meId,
            );
            const callerName = getDisplayNameFromUser(me, 'Smilers');
            notifyEventPush({
              recipients,
              event: 'call',
              title: callerName,
              message: requestedType === 'video' ? 'Incoming video call' : 'Incoming voice call',
              conversationId: String(conversationId),
              callId: String(id),
              callType: requestedType === 'video' ? 'video' : 'voice',
              displayName: callerName,
              idempotencyKey: String(id),
            });
          } catch {}
        }
      } catch (errorValue: any) {
        if (!cancelled) {
          console.warn('initiateCall failed:', errorValue?.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCall, activeCallLoading, callId, canRunCallQueries, conversation, conversationId, conversationLoading, fetchedOtherUser, initiateCall, isAuthenticated, isConferenceMode, isScreenOnly, me, meLoading, requestedType]);

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
      // iter-111 — REMOVED `initStartedRef.current` from the bail check.
      //
      // Why: in iter-104 we moved the slot-claim (`initStartedRef.current = true`)
      // INTO the useEffect, BEFORE calling startPeerConnection. That fixed the
      // duplicate-PC race, but left this internal bail check still reading
      // `initStartedRef.current` — which is now ALWAYS true by the time
      // startPeerConnection runs. The function then bailed with
      //   "startPeerConnection skipped (callId=true alreadyInit=true ctor=true)"
      // — exactly the symptom in the user's diagnostic. Result: no PC ever
      // created → no SDP exchange → no audio / no video / no screen share.
      //
      // The correct internal idempotency guard is `sessionRef.current` — the
      // PC actually exists. The useEffect already gates the "should we start
      // at all" question; this check only needs to guard against a literal
      // duplicate call after a PC is alive.
      // Idempotency: a live PC means we're done — never release the slot.
      if (sessionRef.current) {
        callDebug.push('CALL', 'startPeerConnection skipped (session already live)');
        return;
      }
      if (!callId || !CallSessionCtor) {
        callDebug.push(
          'CALL',
          `startPeerConnection skipped (callId=${!!callId} session=${!!sessionRef.current} ctor=${!!CallSessionCtor})`,
        );
        // iter-188 (screen share "from day one" bug): this bail used to keep
        // `initStartedRef.current = true`, permanently blocking every retry.
        // On Android the WebRTC module loads ~350ms AFTER mount (screenReady
        // timer), so the screen-only bootstrap ALWAYS hit `ctor=false` here
        // and screen sharing never created a peer connection (the
        // MediaProjection picker never appeared). Release the slot so the
        // kick-off effects can retry once the module is loaded.
        initStartedRef.current = false;
        return;
      }
      if (Platform.OS === 'web') {
        callDebug.push('CALL', 'startPeerConnection skipped: web preview');
        return; // skip on web preview
      }
      // useEffect already set initStartedRef.current = true synchronously before
      // calling us, so we don't need to claim it here.

      callDebug.push(
        'CALL',
        `startPeerConnection asCaller=${asCaller} screenOnly=${isScreenOnly} viewer=${isScreenOnlyReceiver} callType=${callType}`,
      );
      // ┌─────────────────────────────────────────────────────────────────┐
      // │ REMOTE USER ID resolution                                        │
      // │ • Regular call: try ALL known field-name variants on the         │
      // │   `activeCall` row (the backend schema has historically used     │
      // │   `recipientId`, `calleeId`, `calleeUserId`, `recipientUserId`,  │
      // │   `receiverId`, `toUserId` — and the same fanout for the         │
      // │   caller-side field). If none yield a value, fall back to the    │
      // │   hydrated `fetchedOtherUser` from the conversation — that IS    │
      // │   the remote user in any 1-on-1 call.                            │
      // │ • Screen-only:  read from the URL `&peerUserId=` param.          │
      // │                                                                  │
      // │ Bug fixed (iteration-82): on-screen Call Debug overlay showed    │
      // │ `no remoteUserId (screenOnly=false, activeCall=true,             │
      // │ otherUser=true)` in a tight retry loop. Root cause was that the  │
      // │ Convex `calls` row uses `calleeUserId`, not `recipientId`, so    │
      // │ the old `activeCall.recipientId` lookup always returned          │
      // │ undefined → peer connection never created → call/screen-share    │
      // │ hung on "Connecting…" forever.                                   │
      // └─────────────────────────────────────────────────────────────────┘
      let remoteUserId: string | null = null;
      if (isScreenOnly) {
        remoteUserId = peerUserIdParam || null;
      } else {
        const ac: any = activeCall || {};
        const pickCallerField = () =>
          ac.callerId ||
          ac.callerUserId ||
          ac.fromUserId ||
          ac.from ||
          null;
        const pickCalleeField = () =>
          ac.recipientId ||
          ac.recipientUserId ||
          ac.calleeId ||
          ac.calleeUserId ||
          ac.receiverId ||
          ac.toUserId ||
          ac.to ||
          null;
        const fromActive = asCaller ? pickCalleeField() : pickCallerField();
        if (fromActive) {
          remoteUserId = String(fromActive);
        } else if (fetchedOtherUser) {
          // The call row doesn't carry the remote user id (either because
          // the backend schema diverged, or because the safe-query wrapper
          // is briefly serving a stale/null activeCall). Use the
          // conversation's hydrated other user — for a 1-on-1 call this is
          // always the correct remote peer.
          remoteUserId =
            (fetchedOtherUser as any)?._id ||
            (fetchedOtherUser as any)?.userId ||
            null;
          if (remoteUserId) {
            callDebug.push(
              'CALL',
              `remoteUserId resolved from fetchedOtherUser=${String(remoteUserId).slice(0, 8)}…`,
            );
          }
        }
      }
      if (!remoteUserId) {
        callDebug.push(
          'ERR',
          `no remoteUserId (screenOnly=${isScreenOnly}, activeCall=${!!activeCall}, otherUser=${!!fetchedOtherUser})`,
        );
        // Release the slot so a future state update can retry.
        initStartedRef.current = false;
        return;
      }
      partnerUserIdRef.current = remoteUserId;

      // Request permissions
      try {
        // Screen-only RECEIVER (viewer) needs NEITHER camera NOR mic — it's
        // purely receiving. Asking for camera permission and then denying
        // used to throw `permissionDenied=true` which prevented the PC from
        // being created at all. Skip the prompt entirely in viewer mode.
        const isViewerOnly = isScreenOnly && isScreenOnlyReceiver;
        let camGranted = true;
        if (callType === 'video' && !isViewerOnly && !isScreenOnly) {
          // Regular video call — request camera
          const cam = await Camera.requestCameraPermissionsAsync();
          camGranted = cam.status === 'granted';
        }
        if (!isViewerOnly) {
          const micPermission = await Camera.requestMicrophonePermissionsAsync().catch(() => null);
          const micGranted = micPermission?.status === 'granted';
          if (callType === 'video' && !camGranted && !isScreenOnly) {
            setPermissionDenied(true);
            return;
          }
          if (!micGranted && !isScreenOnly) {
            setPermissionDenied(true);
            return;
          }
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
          // ┌─────────────────────────────────────────────────────────────┐
          // │ SCREEN-SHARE PATH: route through `api.screenSharing.        │
          // │ sendSignal({ sessionId, toUserId, type, payload })`.        │
          // │ The plain `api.signaling.send` has a `v.id("calls")`        │
          // │ validator and silently rejects screen-share session ids —   │
          // │ which is why the receiver used to sit forever on           │
          // │ "Waiting for the sender's screen to start broadcasting…".   │
          // └─────────────────────────────────────────────────────────────┘
          if (isScreenOnly) {
            if (!conversationId || !peerUserIdParam) {
              console.warn(
                'screen-share sendSignal skipped — missing sessionId or peerUserId (sessionId=%s peerUserId=%s)',
                conversationId,
                peerUserIdParam,
              );
              return;
            }
            // iter-189: enqueue + patient flush (see flushScreenSignalQueue).
            // The old inline 3-attempt/2s retry dropped the offer forever
            // when the recipient hadn't accepted yet. Order is preserved —
            // the offer always lands before its ICE candidates.
            screenSignalQueueRef.current.push({ type: sig.type, payload: sig.payload });
            void flushScreenSignalQueueRef.current();
            return;
          }

          // ── REGULAR CALL PATH ──────────────────────────────────────────
          // The backend's `signaling.send` validator uses a strict union.
          // Different deployments may use the camelCase `'iceCandidate'` or
          // the kebab `'ice-candidate'` literal — accept either by retrying
          // with the alternative if the first attempt is rejected for
          // type-validation reasons. This is what every "answered call but
          // no audio/video" report comes down to in the wild.
          const tryVariant = async (typeOverride?: string) => {
            const payload = typeOverride ? { ...sig, type: typeOverride as any } : sig;
            await sendSignal(payload as any);
          };
          try {
            await tryVariant();
          } catch (errorValue: any) {
            const message = String(errorValue?.message || '');
            // Only retry the alternate variant if the backend rejected the
            // literal — most other failures are network-level, retrying is
            // pointless.
            const isValidationFailure =
              message.includes('ArgumentValidationError') ||
              message.includes('Validator error') ||
              message.toLowerCase().includes('union') ||
              message.toLowerCase().includes('literal');
            if (isValidationFailure && sig.type === 'ice-candidate') {
              try {
                await tryVariant('iceCandidate');
                return;
              } catch (retryErr: any) {
                console.warn('sendSignal retry (iceCandidate) failed:', retryErr?.message);
                return;
              }
            }
            console.warn('sendSignal failed:', message);
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
          // Detect a video-track presence change on the SAME remote stream
          // (voice→video upgrade). When it flips, bump the generation so the
          // remote <RTCView> remounts and paints the new camera track.
          const check = () => {
            try {
              const hasVideo = ((stream as any)?.getVideoTracks?.() || []).length > 0;
              if (hasVideo !== remoteHasVideoRef.current) {
                remoteHasVideoRef.current = hasVideo;
                setRemoteVideoGen((g) => g + 1);
              }
            } catch {}
          };
          check();
          // The track is sometimes appended a tick after the `track` event fires.
          setTimeout(check, 300);
        },
        onConnectionStateChange: (state) => {
          console.log('[Call] connection state:', state);
          if (state === 'connected') {
            setPeerConnected(true);
          }
          if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            setPeerConnected(false);
            // ICE may temporarily disconnect; only act on fatal states
            if (state === 'failed' || state === 'closed') {
              setStatusText('Connection lost');
            }
          }
        },
        onError: (err) => console.warn('[Call] error:', err?.message),
        onScreenAutoProfile: (profile) => setAutoActiveProfile(profile),
      });

      sessionRef.current = session;

      try {
        // Per Emergent Support guidance (iteration 83): the screen-only
        // VIEWER (receiver of a screen share) must NOT call initLocalMedia
        // at all. The viewer has no media to send — it's purely consuming
        // the sender's stream. WebRTC's setRemoteDescription(offer) will
        // auto-create matching transceivers in the recvonly direction from
        // the sender's offer SDP, so we only need to:
        //   1. createPeerConnection (no local tracks),
        //   2. wait for the sender's offer to arrive via signaling,
        //   3. setRemoteDescription + createAnswer.
        // Calling initLocalMedia on the viewer used to crash both devices
        // (the camera/mic capture failed → exception → fallback paths
        // triggered native crashes on react-native-webrtc@124.0.7).
        const isViewerOnly = isScreenOnly && isScreenOnlyReceiver;
        if (!isViewerOnly) {
          await session.initLocalMedia(startInScreenShare);
        } else {
          callDebug.push(
            'SCRN',
            'viewer-only: skipping initLocalMedia (transceivers auto-created from remote offer)',
          );
        }
        await session.createPeerConnection();
        // ⚠️ FIRE THE TICK ONLY AFTER pc IS CREATED. Bumping the tick
        // earlier (right after `new CallSession`) would cause the
        // signal-processing useEffect to call handleRemoteOffer while
        // `this.pc` is still null inside CallSession, which throws
        // 'Peer connection not initialized' and drops the offer
        // permanently. By deferring the bump until pc exists, we
        // guarantee the offer can be processed end-to-end.
        setSessionReadyTick((tick) => tick + 1);
        if (asCaller) {
          await session.createOffer();
        }
      } catch (errorValue: any) {
        console.warn('startPeerConnection failed:', errorValue?.message);
        callDebug.push('ERR', `startPeerConnection failed: ${errorValue?.message || 'unknown'}`);
        if (startInScreenShare) {
          Platform.OS === 'ios'
            ? alertScreenShareIOSError()
            : console.warn('Screen capture failed:', errorValue?.message);
        }
        setPermissionDenied(true);
      }
    },
    [
      CallSessionCtor,
      activeCall,
      applyAudioMode,
      callId,
      callType,
      conversationId,
      // ⚠ fetchedOtherUser is referenced inside the body (used as the
      // remoteUserId fallback when activeCall is missing the recipient
      // field). Without it in the deps, a stale closure could see
      // fetchedOtherUser === null even after the hook resolves it, causing
      // the "no remoteUserId" retry loop. — Emergent Support iteration 83.
      fetchedOtherUser,
      isScreenOnly,
      isScreenOnlyReceiver,
      peerUserIdParam,
      sendScreenSignal,
      sendSignal,
      startInScreenShare,
    ]
  );

  // Stable ref to the latest startPeerConnection callback so the kick-off
  // useEffects below don't re-fire when the callback identity changes
  // (which it does on EVERY activeCall server re-emit — i.e. every
  // heartbeat tick — because `activeCall` is in the useCallback deps).
  //
  // iter-104 bug: without this ref, the diagnostic overlay showed
  // FOUR `startPeerConnection asCaller=false` log lines within the same
  // second after the user tapped Answer. That meant the useEffect was
  // running 4 times in 4 separate React commits before any of them
  // could set `initStartedRef.current = true` — each one then created
  // its own peer connection, none of which completed the SDP handshake.
  // Symptom: "no audio and in video calls videos are off and no audios".
  const startPeerConnectionRef = useRef(startPeerConnection);
  useEffect(() => {
    startPeerConnectionRef.current = startPeerConnection;
  }, [startPeerConnection]);

  // Stable "remote user is resolved" signal — flips false→true exactly
  // ONCE per call (the moment we can answer "yes I know who to dial").
  // Used as a useEffect dep below so the kick-off retries automatically
  // if the first attempt bailed because activeCall / fetchedOtherUser
  // hadn't synced yet. This replaces the old behavior of putting
  // `startPeerConnection` in the dep array, which caused multiple
  // re-fires on every heartbeat tick.
  const remoteResolved = useMemo(() => {
    if (isScreenOnly) return !!peerUserIdParam;
    const ac: any = activeCall || {};
    const fromActive =
      ac.callerId || ac.callerUserId || ac.fromUserId || ac.from ||
      ac.recipientId || ac.recipientUserId || ac.calleeId || ac.calleeUserId ||
      ac.receiverId || ac.toUserId || ac.to || null;
    if (fromActive) return true;
    if (fetchedOtherUser) return true;
    return false;
  }, [isScreenOnly, peerUserIdParam, activeCall, fetchedOtherUser]);

  // Caller: kick off peer-connection as soon as we have a callId (status may still be ringing).
  // We CLAIM the slot synchronously BEFORE invoking the async function so a
  // back-to-back effect run in the same JS turn can't fire a second time.
  useEffect(() => {
    if (
      isCaller &&
      callId &&
      remoteResolved &&
      CallSessionCtor &&
      !sessionRef.current &&
      !initStartedRef.current
    ) {
      initStartedRef.current = true; // claim BEFORE the await
      void startPeerConnectionRef.current(true);
    }
    // intentionally NOT depending on startPeerConnection — we deref via the
    // ref so heartbeat-driven activeCall re-emits never re-fire this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCaller, callId, remoteResolved, CallSessionCtor]);

  // Callee: kick off peer-connection when answered (status → active)
  useEffect(() => {
    if (
      !isCaller &&
      isActive &&
      callId &&
      remoteResolved &&
      CallSessionCtor &&
      !sessionRef.current &&
      !initStartedRef.current
    ) {
      initStartedRef.current = true; // claim BEFORE the await
      void startPeerConnectionRef.current(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCaller, isActive, callId, remoteResolved, CallSessionCtor]);

  // ====== Screen-only mode: bootstrap peer-connection directly ======
  //
  // iter-112 — SPLIT into TWO effects to eliminate a critical race that was
  // breaking screen sharing entirely.
  //
  // The previous single-effect version did:
  //   1. setCallId(conversationId)      — schedules state update
  //   2. initStartedRef.current = true  — synchronous
  //   3. startPeerConnectionRef.current(asCaller) — SYNCHRONOUS invocation
  //
  // The problem: React state updates are async. The closure inside
  // `startPeerConnectionRef.current` was created on the previous render where
  // `callId === null`. So step 3 invokes that stale closure, which immediately
  // bails out at the internal guard `if (!callId || sessionRef.current || …)`.
  // Meanwhile `initStartedRef.current` is now `true` and the useEffect's deps
  // don't include `callId`, so it never re-fires after the state update
  // propagates → PC is NEVER created → no offer, no track, no media.
  //
  // The symptom users saw: "Screen sharing not working" — the sender's screen
  // never broadcasts, the receiver sits forever on "Connecting to screen…".
  //
  // Fix: split into two effects. Effect A sets `callId` to the session id.
  // Effect B fires AFTER `callId === conversationId` (i.e. the state update
  // has propagated and `startPeerConnectionRef.current` has been refreshed by
  // the ref-sync useEffect above), THEN claims the slot and kicks off the PC.

  // Effect A: ensure callId is set to the screen-share session id when we
  // enter screen-only mode.
  useEffect(() => {
    if (!isScreenOnly) return;
    if (!conversationId) return;
    if (callId === conversationId) return;
    setCallId(conversationId);
    callDebug.push(
      'CALL',
      `screen-only setCallId(${String(conversationId).slice(0, 8)}…)`,
    );
  }, [isScreenOnly, conversationId, callId]);

  // Effect B: kick off the peer connection ONLY after callId has actually
  // been committed to React state (callId === conversationId). At that point
  // the ref-sync useEffect has already refreshed `startPeerConnectionRef.current`
  // with a closure that captures the up-to-date `callId`, so the function
  // body won't bail out at `if (!callId …)`.
  useEffect(() => {
    if (!isScreenOnly) return;
    if (!conversationId) return;
    if (callId !== conversationId) return; // wait for Effect A
    // iter-188: WAIT for the WebRTC module. On Android `CallSessionCtor`
    // loads ~350ms after mount (screenReady timer → require()). The old
    // version claimed the init slot immediately, startPeerConnection bailed
    // with `ctor=false`, and nothing ever retried — screen sharing never
    // got as far as the MediaProjection picker. With `CallSessionCtor` in
    // the dep array this effect simply re-fires once the module is ready.
    if (!CallSessionCtor) {
      callDebug.push('CALL', 'screen-only bootstrap: waiting for WebRTC module…');
      return;
    }
    if (!peerUserIdParam) {
      callDebug.push(
        'ERR',
        'screen-only bootstrap: missing &peerUserId= URL param — cannot establish WebRTC',
      );
      return;
    }
    if (sessionRef.current || initStartedRef.current) return;
    try {
      callDebug.push(
        'CALL',
        `screen-only mount role=${isScreenOnlyReceiver ? 'viewer' : 'sharer'} ` +
          `sessionId=${String(conversationId).slice(0, 8)}… peer=${String(peerUserIdParam).slice(0, 8)}…`,
      );
      initStartedRef.current = true; // claim BEFORE the async kick-off
      if (isScreenOnlyReceiver) {
        void startPeerConnectionRef.current(false);
      } else {
        void startPeerConnectionRef.current(true);
      }
    } catch (errorValue: any) {
      callDebug.push('ERR', `screen-only bootstrap: ${errorValue?.message}`);
      // Release the slot so a future state change can retry.
      initStartedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScreenOnly, isScreenOnlyReceiver, conversationId, peerUserIdParam, callId, CallSessionCtor]);

  // ====== Heartbeat — REQUIRED by the backend's expireDeadCalls cron ======
  //
  // The backend runs `cleanupZombies` / `expireDeadCalls` every 60s. Active
  // calls without a recent `heartbeat` ping (default 60–90s window) are
  // force-`ended` server-side. Without the mobile pinging in on a steady
  // 10s cadence, every answered call would be killed within ~90s of being
  // active — which is exactly the symptom the user reported as
  // "Receiver's app still crashes upon answering calls" (the live
  // `getActiveCall` query re-emits `status: 'ended'` shortly after answer,
  // the call screen renders the error fallback, the user thinks the app
  // crashed).
  //
  // We ping every 10s. The mutation is idempotent server-side and a no-op
  // for non-active calls, so it's safe to keep firing during the brief
  // ringing→active transition.
  useEffect(() => {
    if (!callId || !isActive) return;
    let cancelled = false;
    const ping = async () => {
      if (cancelled || !callId) return;
      try {
        await (heartbeat as any)({ callId });
      } catch (errorValue: any) {
        // Backward-compat: if the backend hasn't yet shipped heartbeat for
        // any reason, swallow the error so it doesn't crash the call.
        const message = String(errorValue?.message || errorValue || '');
        if (!message.includes('CouldNotFindFunction')) {
          console.warn('heartbeat ping failed (non-fatal):', message.slice(0, 100));
        }
      }
    };
    // Fire one immediately so the moment the call becomes active the
    // backend sees a fresh `lastHeartbeat` and never marks it dead in
    // the first 60s window.
    void ping();
    const interval = setInterval(() => void ping(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [callId, isActive, heartbeat]);

  // ====== Process incoming signaling messages ======
  useEffect(() => {
    if (!signals || !Array.isArray(signals) || signals.length === 0) return;
    if (!sessionRef.current) {
      callDebug.push(
        'SIG',
        `← skipped ${signals.length} signal(s): session not ready yet (waiting for sessionReadyTick)`,
      );
      return;
    }

    const messageIds: string[] = [];
    (async () => {
      for (const msg of signals) {
        try {
          // Accept BOTH naming conventions for ICE candidates ('iceCandidate'
          // camelCase from the contract docs + 'ice-candidate' kebab from
          // the historical mobile implementation) — see the matching
          // send-side fallback in the startPeerConnection sendSignal wrapper.
          if (msg.type === 'offer') {
            callDebug.push('SIG', `← offer (processing, ${(msg.payload || '').length}B)`);
            await sessionRef.current?.handleRemoteOffer(msg.payload);
          } else if (msg.type === 'answer') {
            callDebug.push('SIG', `← answer (processing, ${(msg.payload || '').length}B)`);
            await sessionRef.current?.handleRemoteAnswer(msg.payload);
          } else if (
            msg.type === 'ice-candidate' ||
            msg.type === 'iceCandidate' ||
            msg.type === 'ice'
          ) {
            await sessionRef.current?.handleRemoteIceCandidate(msg.payload);
          }
          messageIds.push(msg._id);
        } catch (errorValue: any) {
          console.warn('handle signal failed:', msg.type, errorValue?.message);
          callDebug.push('ERR', `handle ${msg.type} failed: ${errorValue?.message || 'unknown'}`);
        }
      }
      if (messageIds.length > 0) {
        try {
          // Route the ACK to the same channel we received from. The screen-
          // share queue uses `markSignalsConsumed`, the regular call queue
          // uses `markConsumed`.
          if (isScreenOnly) {
            if (markScreenSignalsConsumed) {
              await (markScreenSignalsConsumed as any)({ messageIds });
            }
          } else {
            await markConsumed({ messageIds });
          }
        } catch (errorValue: any) {
          console.warn('markConsumed failed:', errorValue?.message);
        }
      }
    })();
    // sessionReadyTick is a critical dep: when the session is built AFTER
    // the offer arrived (the race that caused the 76s silence in iter-93),
    // this effect re-runs and processes the queued signals.
  }, [signals, sessionReadyTick, markConsumed, markScreenSignalsConsumed, isScreenOnly]);

  // ====== End call ======
  const handleHangup = useCallback(async () => {
    const id = callId;
    sessionRef.current?.close();
    sessionRef.current = null;
    initStartedRef.current = false;
    if (inCallStartedRef.current) {
      InCallAudio.stop();
      inCallStartedRef.current = false;
      callDebug.push('AUDIO', 'InCallManager.stop() (hangup)');
    }
    if (id) {
      try {
        if (activeCall?.status === 'ringing') {
          await declineCall({ callId: id });
        } else {
          await endCall({ callId: id });
        }
      } catch {}
      // iter-137 engagement tracking — count call minutes ONLY for
      // calls that actually connected (otherwise duration is 0 and the
      // tracker no-ops). Fire-and-forget so a failed tracking call
      // never blocks the hangup → router.back() transition.
      try {
        const minutes = Math.max(0, callDurationSec / 60);
        if (minutes > 0) {
          void engagement.call(minutes, callType === 'video');
        }
      } catch {}
      // NOTE: signaling cleanup is intentionally skipped — the backend's
      // confirmed June 2025 contract exposes `signaling.send / poll /
      // markConsumed` only. The `signaling.cleanup` mutation was removed
      // server-side, and the dead-call cron (`expireDeadCalls`) handles
      // pruning expired signaling rows automatically.
    }
    callHost.end();
  }, [activeCall?.status, callId, declineCall, endCall, router, callDurationSec, callType, engagement]);

  const handleDecline = useCallback(async () => {
    const id = callId;
    sessionRef.current?.close();
    sessionRef.current = null;
    initStartedRef.current = false;
    if (inCallStartedRef.current) {
      InCallAudio.stop();
      inCallStartedRef.current = false;
      callDebug.push('AUDIO', 'InCallManager.stop() (decline)');
    }
    if (id) {
      try {
        await declineCall({ callId: id });
      } catch {}
      // Cleanup handled server-side by `expireDeadCalls` cron — see comment above.
    }
    callHost.end();
  }, [callId, declineCall, router]);

  const handleAnswer = useCallback(async () => {
    if (!callId) return;
    callDebug.push('CALL', `handleAnswer → answerCall(${String(callId).slice(0, 8)}…)`);
    try {
      await answerCall({ callId });
      callDebug.push('CALL', 'answerCall mutation OK');
    } catch (errorValue: any) {
      callDebug.push('ERR', `answerCall failed: ${errorValue?.message}`);
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
      if (inCallStartedRef.current) {
        InCallAudio.stop();
        inCallStartedRef.current = false;
        callDebug.push('AUDIO', 'InCallManager.stop() (remote-ended)');
      }
      // Give the user 700ms to see the "Call ended" state before popping
      const timeoutId = setTimeout(() => callHost.end(), 700);
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
      // iter-189: drop any queued screen-share signals — they belong to the
      // session that just ended; the flush loop exits on the empty queue.
      screenSignalQueueRef.current = [];
      screenSignalFirstFailAtRef.current = null;
      if (inCallStartedRef.current) {
        InCallAudio.stop();
        inCallStartedRef.current = false;
      }
    };
  }, []);

  // iter-255: Picture-in-Picture — keep a VIDEO call floating over other apps
  // when the user backgrounds the app. (Audio calls keep running via the iOS
  // `audio`/`voip` background modes + Android foreground-service perms.)
  const inPip = useIsInPip();
  // Android 12+ : auto-slide into PiP the moment the app is backgrounded
  // during a connected video call. Disabled when the call tears down so other
  // screens never auto-PiP.
  useEffect(() => {
    if (!isPipSupported || callType !== 'video') return;
    setPipParams({ autoEnterEnabled: peerConnected, width: 12, height: 16 });
    return () => setPipParams({ autoEnterEnabled: false });
  }, [callType, peerConnected]);
  // Android < 12 fallback: manually request PiP on background.
  useEffect(() => {
    if (!isPipSupported || callType !== 'video') return;
    const sub = AppState.addEventListener('change', (state) => {
      if ((state === 'inactive' || state === 'background') && peerConnected) {
        enterPip({ width: 12, height: 16 });
      }
    });
    return () => sub.remove();
  }, [callType, peerConnected]);

  // ====== Control handlers ======
  // Android hardware BACK while the call is full-screen should MINIMIZE it into
  // the floating window (so the user can browse without dropping the call),
  // never end it. Incoming (not-yet-answered) calls are left alone so back
  // doesn't accidentally swallow the answer/decline decision.
  useEffect(() => {
    if (Platform.OS !== 'android' || isMini || isIncoming) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      callHost.minimize();
      return true;
    });
    return () => sub.remove();
  }, [isMini, isIncoming]);

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

  // "Pop out" → float the call over other apps via OS Picture-in-Picture
  // (matches the web app's Pop out button). On Android this immediately drops
  // the call into a movable PiP window.
  const handlePopOut = useCallback(() => {
    const r = enterPip({ width: 12, height: 16 });
    if (!r.ok) {
      Alert.alert(
        'Pop out unavailable',
        `Picture-in-Picture could not start.\n\nReason: ${r.reason || 'unknown'}`,
      );
    } else if (r.reason === 'native-module-not-linked') {
      Alert.alert(
        'Pop out unavailable',
        'Picture-in-Picture is not available in this build (native module not linked). Please use a fresh production build.',
      );
    }
  }, []);

  // iter-254: switch an in-progress VOICE call to VIDEO. Mirrors the Twilio
  // "Video" control. Publishes our camera (renegotiating the WebRTC peer) and
  // notifies the remote peer (web or mobile) via requestVideoUpgrade so it can
  // flip to video too. autoUpgradedRef prevents the mirror-effect below from
  // re-acquiring the camera after we initiate.
  const switchingVideoRef = useRef(false);
  const autoUpgradedRef = useRef(requestedType === 'video');
  const handleSwitchToVideo = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      Alert.alert('Video', 'Video will be available as soon as the call connects.');
      return;
    }
    if (switchingVideoRef.current || callType === 'video') return;
    switchingVideoRef.current = true;
    autoUpgradedRef.current = true;
    try {
      try {
        await requestVideoUpgrade({ callId });
      } catch {}
      await session.upgradeToVideo();
      setCameraOff(false);
      setCallType('video');
    } catch (e: any) {
      autoUpgradedRef.current = false;
      Alert.alert('Video', e?.message || 'Could not switch to video.');
    } finally {
      switchingVideoRef.current = false;
    }
  }, [callType, callId, requestVideoUpgrade]);

  // ── Video-upgrade handshake (mirrors the web flow) ──────────────────────
  // The web app does NOT silently auto-flip to video. Either party requests;
  // the requester's camera goes on immediately while the other side stays
  // camera-off until they explicitly Accept. State lives on the call doc's
  // `videoUpgrade` = { requestedBy, status: pending|accepted|declined }.
  const respondVideoUpgrade = useMutation((api as any).calls.respondVideoUpgrade);
  const myUserId = me?._id ? String(me._id) : '';
  const peerDisplayName =
    (Array.isArray(rawDisplayName) ? rawDisplayName[0] : rawDisplayName) || 'Your contact';
  const promptedUpgradeRef = useRef<string | null>(null);
  const notifiedDeclineRef = useRef<string | null>(null);

  const acceptVideoUpgrade = useCallback(async () => {
    autoUpgradedRef.current = true;
    try {
      await sessionRef.current?.upgradeToVideo();
      setCameraOff(false);
      setCallType('video');
    } catch (e: any) {
      Alert.alert('Video', e?.message || 'Could not enable the camera.');
    }
    try {
      await respondVideoUpgrade({ callId, accept: true });
    } catch {}
  }, [callId, respondVideoUpgrade]);

  const declineVideoUpgrade = useCallback(async () => {
    try {
      await respondVideoUpgrade({ callId, accept: false });
    } catch {}
  }, [callId, respondVideoUpgrade]);

  useEffect(() => {
    const vu = (activeCall as any)?.videoUpgrade;
    if (!vu || !myUserId) return;
    const key = `${callId}:${vu.requestedAt || vu.status || ''}`;
    // Incoming request from the OTHER party → prompt to accept/decline.
    if (vu.status === 'pending' && vu.requestedBy !== myUserId) {
      if (promptedUpgradeRef.current === key) return;
      promptedUpgradeRef.current = key;
      Alert.alert(
        'Switch to video?',
        `${peerDisplayName} wants to switch to a video call.`,
        [
          { text: 'Decline', style: 'cancel', onPress: () => void declineVideoUpgrade() },
          { text: 'Accept', onPress: () => void acceptVideoUpgrade() },
        ],
      );
      return;
    }
    // I requested and they declined → let me know (my camera stays on; it's a
    // one-way video until they choose to turn theirs on).
    if (vu.status === 'declined' && vu.requestedBy === myUserId) {
      if (notifiedDeclineRef.current === key) return;
      notifiedDeclineRef.current = key;
      Alert.alert('Video', `${peerDisplayName} declined to turn on video.`);
    }
  }, [activeCall, myUserId, callId, peerDisplayName, acceptVideoUpgrade, declineVideoUpgrade]);

  const handleSelectAudioOutput = useCallback((nextOutput: AudioOutputRoute) => {
    // Mark that the user explicitly chose a route — this stops the
    // auto-Bluetooth logic from overriding their manual choice for the rest
    // of the call (e.g. user deliberately switches back to Speaker while a
    // headset is still connected).
    userPickedRouteRef.current = true;
    setAudioOutput(nextOutput);
    setAudioOutputMenuVisible(false);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      Alert.alert('Screen sharing', 'Screen sharing will be available as soon as the call media is ready.');
      return;
    }
    // iter-171: removed the unconditional iOS alert. The Broadcast Upload
    // Extension added by `plugins/withIosBroadcastExtension.js` registers
    // a Smilers broadcast target with iOS at install time. Calling
    // `startScreenShare()` triggers `RPSystemBroadcastPickerView`, which
    // lets the user pick that target. If the extension isn't bundled
    // (e.g. the user is running an old EAS build), `getDisplayMedia`
    // throws synchronously — we catch it below and show the iOS-specific
    // explainer alert as a graceful fallback.
    try {
      if (screenSharing) {
        // In standalone screen-share (screen-only) mode there is no camera to
        // fall back to — restoring it would leak the sharer's front camera to
        // the viewer (the "camera shows when I stop sharing" bug). Only
        // restore the camera for a real video call.
        await session.stopScreenShare(!isScreenOnly && callType === 'video');
        setScreenSharing(false);
        setCameraOff(false);
      } else {
        await session.startScreenShare();
        setScreenSharing(true);
        setCameraOff(false);
      }
    } catch (e: any) {
      if (Platform.OS === 'ios') {
        // The Broadcast Upload Extension isn't present in this build —
        // surface the same explainer that used to gate the entry point.
        alertScreenShareIOSError();
        return;
      }
      Alert.alert('Screen sharing failed', e?.message || 'Could not start screen sharing.');
    }
  }, [screenSharing, callType, isScreenOnly]);

  const handleSelectScreenQuality = useCallback(
    (mode: 'sharp' | 'smooth' | 'auto') => {
      setScreenQuality(mode);
      void sessionRef.current?.setScreenQuality?.(mode);
    },
    [],
  );

  // Push the user's chosen quality profile into the CallSession once the peer
  // connection exists (sessionReadyTick bumps when pc is created). This makes
  // the session adopt the default 'auto' profile and start the motion monitor.
  useEffect(() => {
    if (!sessionRef.current || !screenSharing) return;
    void sessionRef.current.setScreenQuality?.(screenQuality);
  }, [sessionReadyTick, screenQuality, screenSharing]);

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

  const durationLabel = useMemo(() => {
    const m = Math.floor(callDurationSec / 60);
    const s = callDurationSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [callDurationSec]);

  // ── Ad-hoc multiparty: invite someone into THIS 1:1 call. Calling
  // `callInvites.invite` rings them and flips `calls.isConference = true`,
  // which both parties' screens observe and then switch to the mesh engine
  // (we navigate to the reusable /group-call mesh host with the same callId).
  const [invitePickerVisible, setInvitePickerVisible] = useState(false);
  const upgradedToMeshRef = useRef(false);

  const handleAddParticipant = useCallback(() => {
    setAudioOutputMenuVisible(false);
    // Match web: "Add" is allowed while the call is LIVE (ringing or active),
    // not strictly connected. The backend also rejects invites on
    // ended/declined calls (BAD_REQUEST "Call has ended"), which we surface
    // gracefully in handleInvitePerson.
    const isCallLive = activeCall?.status === 'ringing' || activeCall?.status === 'active';
    if (!callId || !isCallLive) {
      Alert.alert('Add people', 'You can add people while the call is ringing or connected.');
      return;
    }
    setInvitePickerVisible(true);
  }, [callId, activeCall?.status]);

  // Reactive watch: as soon as ANY invite exists for this call, it's a
  // conference — used to move BOTH original parties to the mesh host even if
  // `getActiveCall` doesn't echo `isConference` back promptly.
  const { data: callInvitesData, error: callInvitesError } = useReactiveSafeConvexQuery<any[]>(
    (api as any).callInvites.getCallInvites,
    callId ? { callId } : undefined,
    [],
    !!callId,
  );

  // iter-236 (RELIABLE TRIGGER): watch the conference roster for this call.
  // The initiator calls `conference.joinConference({ callId })` the moment
  // they enter the mesh host, so `getParticipants(callId)` becomes non-empty
  // on the OTHER party's device. This is the most reliable cross-device
  // signal — it does NOT depend on the backend flipping `isConference` or on
  // `getCallInvites` returning invites addressed to other users (which it may
  // filter out). During a plain 1:1 call nobody has joined a conference, so
  // the roster stays empty and we never false-trigger.
  const { data: conferenceRosterData, error: conferenceRosterError } = useReactiveSafeConvexQuery<any[]>(
    (api as any).conference.getParticipants,
    callId ? { callId } : undefined,
    [],
    !!callId,
  );

  // Detach the live 1:1 connection and hand off to the mesh host. Idempotent.
  // `fromModal` is true only for the INITIATOR (who has the invite-picker
  // <Modal> open). The OTHER party has no modal — and crucially must NOT use
  // InteractionManager.runAfterInteractions, because the call screen runs
  // continuous animations (CallBackground orbs / ringing pulse) that keep an
  // interaction handle open forever, so the queued navigation never fired
  // until the user tapped something (e.g. End). That was the "have to tap End
  // to see the conference screen" bug. We now navigate directly.
  const triggerMeshUpgrade = useCallback((opts?: { fromModal?: boolean }) => {
    if (upgradedToMeshRef.current) return;
    if (!callId || !conversationId) return;
    upgradedToMeshRef.current = true;
    const fromModal = opts?.fromModal === true;
    if (__DEV__) console.log('[adhoc-upgrade] triggerMeshUpgrade', { callId, fromModal });
    callDebug.push('CALL', `[adhoc-upgrade] triggerMeshUpgrade fromModal=${fromModal}`);
    if (fromModal) {
      // Close the invite sheet FIRST — on Android, router.replace() is
      // silently swallowed while a React Native <Modal> is still mounted.
      setInvitePickerVisible(false);
    }
    const vq = callType === 'video' ? '1' : '0';
    // SEAMLESS HANDOFF: detach the live 1:1 connection (so unmount won't tear
    // it down) and stash it for the mesh host to ADOPT — keeps A↔B audio/video
    // alive with zero interruption; only newly invited people get fresh peers.
    try {
      const session = sessionRef.current;
      const partnerUserId = partnerUserIdRef.current;
      if (session?.detachForHandoff && partnerUserId) {
        const ho = session.detachForHandoff();
        if (ho?.pc) {
          stashCallHandoff({
            callId,
            partnerUserId,
            pc: ho.pc,
            localStream: ho.localStream,
            remoteStream: ho.remoteStream,
            video: callType === 'video',
          });
        }
      }
    } catch {
      /* fall through to a plain mesh join if detach fails */
    }
    const dest =
      `/group-call/${conversationId}?callId=${encodeURIComponent(callId)}&video=${vq}&adhoc=1` as any;
    // Initiator: wait out the modal-dismiss animation (~350ms) so Android
    // doesn't drop the navigation. Other party: navigate immediately (no
    // modal, no InteractionManager — see comment above).
    const navigate = () => {
      if (__DEV__) console.log('[adhoc-upgrade] router.replace →', dest);
      callDebug.push('CALL', `[adhoc-upgrade] router.replace → group-call (fromModal=${fromModal})`);
      try { router.replace(dest); } catch (e) {
        callDebug.push('ERR', `[adhoc-upgrade] replace failed: ${String((e as any)?.message || e)}`);
      }
      // CRITICAL (iter-275): this call screen is NOT a real route — it's
      // rendered by the root-mounted <CallHost/> overlay driven by the
      // `callHost` store (iter-261). `router.replace` only swaps the
      // UNDERLYING expo-router screen to /group-call; the 1:1 overlay stays
      // mounted ON TOP because the store still holds its params, so BOTH
      // parties keep seeing the 1:1 screen until they tap End (which calls
      // callHost.end()). That was the "must tap End to reach the conference"
      // bug. The live PC/streams were already detached + stashed above, so
      // ending the overlay here will NOT drop the call — it just reveals the
      // group-call screen underneath, which adopts the handoff. Defer one
      // tick so router.replace commits first (no flash of the chat list).
      setTimeout(() => {
        try { callHost.end(); } catch (e) {
          callDebug.push('ERR', `[adhoc-upgrade] callHost.end failed: ${String((e as any)?.message || e)}`);
        }
      }, 60);
    };
    if (fromModal) {
      // Initiator: wait out the modal-dismiss animation so Android doesn't
      // drop the navigation.
      setTimeout(navigate, 350);
    } else {
      // Other party: next frame, then a 0ms macrotask — reliably lands the
      // navigation without depending on InteractionManager (which never
      // settles while the call screen animations are running).
      requestAnimationFrame(() => setTimeout(navigate, 0));
    }
  }, [callId, conversationId, callType, router]);

  const handleInvitePerson = useCallback(
    async (inviteeId: string, name: string, hideNumber: boolean) => {
      if (!callId) return;
      try {
        callDebug.push('CALL', `[adhoc-upgrade] invite sent → ${name} (hideNumber=${hideNumber})`);
        await inviteToCall({ callId, inviteeId, hideNumber } as any);
        // The initiator moves to the group screen immediately so they can
        // watch the invitee's ring status (don't wait for the isConference
        // round-trip). fromModal=true → close the picker first + brief delay.
        triggerMeshUpgrade({ fromModal: true });
      } catch (e: any) {
        callDebug.push('ERR', `[adhoc-upgrade] inviteToCall failed: ${String(e?.message || e).slice(0, 60)}`);
        Alert.alert('Could not add', e?.message || `Failed to ring ${name}.`);
        throw e;
      }
    },
    [callId, inviteToCall, triggerMeshUpgrade],
  );

  // The OTHER original party (and any client that missed the direct call)
  // upgrades when: the call doc flips isConference, OR an invite appears for
  // this call, OR the conference roster becomes non-empty (most reliable —
  // the initiator joins the mesh roster the instant they navigate over).
  useEffect(() => {
    if (upgradedToMeshRef.current) return;
    const hasInvite = Array.isArray(callInvitesData) && callInvitesData.length > 0;
    const hasRoster = Array.isArray(conferenceRosterData) && conferenceRosterData.length > 0;
    if (activeCall?.isConference || hasInvite || hasRoster) {
      callDebug.push('CALL', `[adhoc-upgrade] FIRING: conf=${!!activeCall?.isConference} invite=${hasInvite} roster=${hasRoster}`);
      triggerMeshUpgrade();
    } else {
      // Routed through callDebug (not __DEV__ console.log) so it shows in the
      // in-app Diagnostic Logs export even on a production APK — this is how
      // we tell whether the backend signals reach the existing participant.
      callDebug.push(
        'CALL',
        `[adhoc-upgrade] waiting: conf=${activeCall?.isConference ?? 'n/a'} ` +
          `invites=${Array.isArray(callInvitesData) ? callInvitesData.length : 'n/a'} ` +
          `roster=${Array.isArray(conferenceRosterData) ? conferenceRosterData.length : 'n/a'} ` +
          `invErr=${callInvitesError ? String((callInvitesError as any)?.message || callInvitesError).slice(0, 40) : 'none'} ` +
          `rosErr=${conferenceRosterError ? String((conferenceRosterError as any)?.message || conferenceRosterError).slice(0, 40) : 'none'}`,
      );
    }
  }, [activeCall?.isConference, callInvitesData, conferenceRosterData, triggerMeshUpgrade, callId]);

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

  // iter-107: during an OUTGOING VIDEO call that's still ringing, show the
  // local camera feed as a full-screen background instead of the static
  // gradient + initial-letter avatar. Matches WhatsApp / FaceTime UX —
  // the caller sees themselves while they wait for the callee to answer,
  // which confirms that the camera is actually live (and gives the
  // "this is a video call without a video" complaint a proper fix).
  //
  // We keep showing the avatar + name + "Ringing…" chip on top via a
  // dark translucent overlay so the screen remains readable.
  //
  // We DON'T do this for incoming ringing (callee hasn't accepted yet,
  // so streaming their preview before they tap Answer would feel
  // surprising / privacy-invasive).
  const showRingingPreview =
    callType === 'video' &&
    isOutgoingRinging &&
    !!localStreamURL &&
    !cameraOff &&
    RTCViewImpl != null;

  // Play the callee's selected ringtone while an INCOMING call rings.
  // iter-187: outgoing ringback moved to InCallManager's native ringback
  // (see effect above) — the expo-audio player was muted by the in-call
  // audio session. Screen-only mode never rings.
  useRingtonePlayer(
    !isScreenOnly && !!isIncoming,
    { vibrate: !isScreenOnly && !!isIncoming },
  );

  if (Platform.OS === 'android' && !screenReady) {
    return (
      <View style={[styles.container, styles.callLoadingScreen]} testID="call-screen-loading">
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={Colors.white} />
        <Text style={styles.callLoadingText}>Preparing call…</Text>
      </View>
    );
  }

  // ── MINIMIZED (floating window) ──────────────────────
  // Rendered by <CallHost/> inside a small draggable box. Same mounted
  // component (session stays alive) — just a compact surface that taps back to
  // full-screen.
  if (isMini) {
    return (
      <Pressable
        style={{ flex: 1, backgroundColor: '#0b141a' }}
        onPress={() => callHost.maximize()}
        testID="mini-call-surface"
      >
        {showVideo && remoteStreamURL ? (
          <RTCViewImpl key={`remote-mini-${remoteVideoGen}`} streamURL={remoteStreamURL} style={StyleSheet.absoluteFill} objectFit="cover" mirror={false} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: Colors.white, fontSize: 22, fontWeight: '700' }}>{getDisplayInitials(otherName) || '?'}</Text>
            </View>
          </View>
        )}
        <View style={{ position: 'absolute', top: 6, left: 8, right: 8 }} pointerEvents="none">
          <Text style={{ color: Colors.white, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{otherName}</Text>
          <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 10 }} numberOfLines={1}>{isActive ? durationLabel : statusText}</Text>
        </View>
        <View style={{ position: 'absolute', bottom: 8, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 14 }}>
          <TouchableOpacity
            onPress={() => callHost.maximize()}
            style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}
            testID="mini-expand-btn"
          >
            <Ionicons name="expand-outline" size={17} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleHangup}
            style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: Colors.danger, alignItems: 'center', justifyContent: 'center' }}
            testID="mini-end-btn"
          >
            <Ionicons name="call" size={17} color={Colors.white} style={{ transform: [{ rotate: '135deg' }] }} />
          </TouchableOpacity>
        </View>
      </Pressable>
    );
  }

  return (
    <View style={styles.container} testID="call-screen">
      <StatusBar style="light" />
      <InviteContactPicker
        visible={invitePickerVisible}
        onClose={() => setInvitePickerVisible(false)}
        excludeUserIds={[
          me?._id,
          (fetchedOtherUser as any)?._id,
          (fetchedOtherUser as any)?.userId,
          (conversation as any)?.otherUser?._id,
        ].filter(Boolean) as string[]}
        onInvite={handleInvitePerson}
        title="Add to call"
      />
      {/* Video layer or gradient + avatar */}
      {showVideo && remoteStreamURL ? (
        <View style={styles.videoLayer}>
          <RTCViewImpl
            key={`remote-${remoteVideoGen}`}
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
        <View style={StyleSheet.absoluteFill}>
          {showRingingPreview ? (
            // Local-camera-as-background — caller sees themselves while
            // dialing on a video call. The local stream is mirrored
            // (selfie convention) and a translucent dark overlay keeps
            // the avatar/name/status readable on top.
            <>
              <RTCViewImpl
                streamURL={localStreamURL}
                style={StyleSheet.absoluteFill}
                objectFit="cover"
                mirror
              />
              <View style={styles.ringingPreviewScrim} pointerEvents="none" />
            </>
          ) : (
            <CallBackground variant={isIncoming ? 'incoming' : 'warm'} />
          )}
          {/* transparent so the CallBackground / camera preview behind shows
              through — styles.container itself paints an opaque brand color
              which would otherwise hide the animated backdrop. */}
          <SafeAreaView style={[styles.container, styles.containerTransparent]} edges={['top', 'bottom']}>
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
        </View>
      )}

      {/* Conference HUD overlay (Slice C) — opt-in via ?conferenceMode=1 */}
      {isConferenceMode && conversationId ? (
        <ConferenceHUD
          conferenceId={conversationId}
          myUserId={me?._id ? String(me._id) : null}
          onLeave={() => callHost.end()}
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
          allowMic={!isScreenOnlyReceiver}
          muted={muted}
          onToggleMic={toggleMute}
          screenSharing={screenSharing}
          peerConnected={peerConnected}
          onToggleScreenShare={toggleScreenShare}
          screenQuality={screenQuality}
          onSelectQuality={handleSelectScreenQuality}
          autoActiveProfile={autoActiveProfile}
          onStop={() => {
            // Best-effort: tell the backend we're ending the session, then
            // route back. Failure is swallowed because the backend may not
            // have shipped the endpoint yet.
            try {
              (api as any).screenSharing?.stopScreenShare &&
                // No useMutation here because this is a one-shot exit path.
                undefined;
            } catch {
              /* swallow */
            }
            callHost.end();
          }}
          RTCViewImpl={RTCViewImpl}
          sessionId={conversationId || null}
          conversationId={conversationId || null}
        />
      ) : (
        // In-call mode (non-screen-only): mount the switch-share listener so
        // that if a remote viewer requests to take over our screen broadcast,
        // we see the accept/decline modal. The viewer-side "Request to share"
        // button is currently only available via the standalone screen-share
        // route; can be exposed in-call in a follow-up iteration.
        <ScreenShareSwitchControls
          sessionId={conversationId || null}
          conversationId={conversationId || null}
          role="sharer"
        />
      )}

      {/* On-screen debug overlay — bottom-right floating "activity" badge.
          Tap to expand the last ~60 call/screen-share events. Visible in
          production APK to bypass console.log / adb logcat barriers. */}
      <CallDebugOverlay />
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
            <SmallControl
              testID="minimize-call-btn"
              onPress={() => callHost.minimize()}
              icon={<Feather name="minimize-2" size={22} color={Colors.white} />}
              label="Minimize"
            />
            {isPipSupported ? (
              <SmallControl
                testID="pop-out-btn"
                onPress={handlePopOut}
                icon={<MaterialIcons name="picture-in-picture-alt" size={22} color={Colors.white} />}
                label="Pop out"
              />
            ) : null}
          </View>
        ) : isScreenOnly ? null : (
          <View style={styles.controlsSecondaryRow}>
            <SmallControl
              testID="switch-to-video-btn"
              onPress={handleSwitchToVideo}
              icon={<Feather name="video" size={22} color={Colors.white} />}
              label="Video"
            />
            <SmallControl
              testID="minimize-call-btn"
              onPress={() => callHost.minimize()}
              icon={<Feather name="minimize-2" size={22} color={Colors.white} />}
              label="Minimize"
            />
            {isPipSupported ? (
              <SmallControl
                testID="pop-out-btn"
                onPress={handlePopOut}
                icon={<MaterialIcons name="picture-in-picture-alt" size={22} color={Colors.white} />}
                label="Pop out"
              />
            ) : null}
          </View>
        )}
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
  containerTransparent: {
    backgroundColor: 'transparent',
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
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'flex-start',
    columnGap: Spacing.lg,
    rowGap: 12,
    paddingHorizontal: 8,
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

  /* Video layer */
  videoLayer: {
    flex: 1,
    backgroundColor: '#000',
    position: 'relative',
  },
  // iter-107: dark translucent scrim placed OVER the local-camera-as-
  // background during outgoing video-call ringing so the avatar / name /
  // "Ringing…" chip text remain readable on top of the live preview.
  // Slightly stronger than the gradient overlay (0.55) because phone
  // cameras often pick up bright backgrounds.
  ringingPreviewScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 7, 0, 0.55)',
  },
  pipWrap: {
    position: 'absolute',
    // iter-273: move the self-preview to the LOWER-right as a small rectangle
    // (above the controls) so it no longer covers the other participant's face
    // in the upper/centre of the frame. Smaller footprint too.
    bottom: 168,
    right: Spacing.base,
    width: 96,
    height: 130,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  videoTopOverlay: {
    position: 'absolute',
    // iter-273: nudge the participant name higher so it clears the centre.
    top: Spacing.xs,
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
    // iter-273: shift the call buttons lower (less bottom padding above the
    // safe-area inset) so they sit nearer the bottom edge and free the centre.
    paddingBottom: Spacing.base,
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
