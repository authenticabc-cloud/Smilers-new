/**
 * /app/twilio-call.tsx — standalone Twilio Video call screen (Phase A.3).
 *
 * Route params:
 *   room       — Twilio room name
 *   identity   — local user identity (OIDC sub / Convex user _id)
 *   isVideo    — '1' for video call, '0' for voice-only
 *   isCaller   — '1' if this device initiated the call
 *   token      — optional pre-minted JWT (caller path passes it from
 *                /api/twilio/initiate-call to skip a round-trip)
 *   callees    — comma-separated identities (caller path only)
 *   title      — optional display name shown in the header
 *
 * Caller flow:
 *   Pre-mount: caller already POSTed /api/twilio/initiate-call →
 *   received room + token → navigate here with both as params.
 *
 * Callee flow:
 *   Accepts incoming push payload (which contains the room name) →
 *   navigates here without a token → screen fetches its own via
 *   /api/twilio/video-token → connects.
 *
 * Deliberately isolated from /app/call/[conversationId].tsx so the
 * legacy stack remains intact during the migration. Phase A.4 will
 * wire this in as the default call path when EXPO_PUBLIC_USE_TWILIO=1.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { requestCameraPermissionsAsync, requestMicrophonePermissionsAsync } from 'expo-camera';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';

import { api } from '../src/convexApi';
import {
  fetchTwilioToken,
  endTwilioCall,
  addTwilioParticipant,
  removeTwilioParticipant,
  fetchCallParticipants,
  type CallRosterEntry,
} from '../src/lib/twilio/twilioApi';
import { useTwilioCallSession } from '../src/lib/twilio/useTwilioCallSession';
import { recordDiagnostic } from '../src/lib/diagnostics';
import { setPipParams, enterPip, useIsInPip, isPipSupported } from '../src/lib/pip';
import { InCallAudio } from '../src/lib/webrtc/inCallManager';
import CallErrorBoundary from '../src/components/CallErrorBoundary';
import { Colors } from '../src/theme';

type AudioOutputRoute = 'earpiece' | 'speaker' | 'bluetooth';

// iter-238: the call screen mounts as a modal stack with NO outer error
// boundary, so ANY uncaught JS error during mount (e.g. a native-module
// init failure, a stale ref deref) takes down the whole React tree and the
// OS shows a hard "app has a bug" crash. Wrap the screen so such errors show
// a friendly fallback (and get logged) instead of crashing the app.
export default function TwilioCallScreen() {
  const router = useRouter();
  const onClose = useCallback(() => {
    try {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch {
      /* best effort */
    }
  }, [router]);
  return (
    <CallErrorBoundary onClose={onClose}>
      <TwilioCallScreenInner />
    </CallErrorBoundary>
  );
}

function TwilioCallScreenInner() {
  // iter-222: keep the screen ON for the entire call so it never dims/sleeps
  // mid-conversation (paired with the native showWhenLocked/turnScreenOn
  // wake-on-incoming via the withCallWakeScreen config plugin).
  useKeepAwake();
  const params = useLocalSearchParams<{
    room?: string;
    identity?: string;
    isVideo?: string;
    isCaller?: string;
    token?: string;
    title?: string;
    autoShare?: string;
    startMuted?: string;
    calleeId?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const roomName = String(params.room || '');
  const identity = String(params.identity || '');
  const isVideo = String(params.isVideo || '1') === '1';
  const isCaller = String(params.isCaller || '0') === '1';
  const title = String(params.title || roomName);
  // iter-243: the callee's Convex user id (1-on-1 caller flow) — used to show
  // "Ringing…" when they are online vs "Calling…" when offline (WhatsApp-style).
  const calleeId = String(params.calleeId || '');
  // Screen-share session: the sharer auto-starts the screen broadcast on
  // connect (and optionally starts muted when sharing without narration).
  const autoShare = String(params.autoShare || '0') === '1';
  const startMuted = String(params.startMuted || '0') === '1';
  const region = process.env.EXPO_PUBLIC_TWILIO_REGION || 'ie1';

  const [token, setToken] = useState<string | null>(params.token ? String(params.token) : null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // iter-236: Twilio's native connect() does NOT request runtime mic/camera
  // permission (unlike react-native-webrtc's getUserMedia). Without RECORD_AUDIO
  // granted, the Android SDK can't create the local audio track and the room
  // connection hangs in "connecting" forever. So we MUST request mic (+ camera
  // for video) BEFORE enabling connect. Default true on web (no native SDK).
  const [permsReady, setPermsReady] = useState(Platform.OS === 'web');

  // iter-243: WhatsApp-style caller status. Look up the callee's live presence
  // (the app keeps users "online" via a 60s heartbeat; getUserById reports
  // isOnline=false once lastSeen is >2min stale). We show "Ringing…" when the
  // callee is online (their device can ring now) and "Calling…" when offline
  // (the call is placed but not ringing). 1-on-1 caller flow only.
  const calleeUser = useQuery(
    api.users.getUserById,
    isCaller && calleeId ? ({ userId: calleeId } as any) : 'skip',
  ) as any;
  // iter-244: robust online detection — works whether the Convex backend
  // exposes an explicit isOnline/online boolean OR only a lastSeen timestamp
  // (online if seen within the 2-min heartbeat window). This is what makes the
  // "Ringing…" vs "Calling…" indicator reflect reality instead of always
  // defaulting to "Calling…".
  const calleeOnline = useMemo(() => {
    if (!calleeUser) return false;
    if (calleeUser.isOnline === true || calleeUser.online === true) return true;
    const raw =
      calleeUser.lastSeen ?? calleeUser.lastActiveAt ?? calleeUser.updatedAt ?? null;
    let ts = 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) ts = raw;
    else if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) ts = parsed;
    }
    if (ts) return Date.now() - ts < 120000;
    return false;
  }, [calleeUser]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        const mic = await requestMicrophonePermissionsAsync();
        let camGranted = true;
        if (isVideo) {
          const cam = await requestCameraPermissionsAsync();
          camGranted = cam.granted;
        }
        recordDiagnostic({
          tag: 'TWILIO-CALL',
          source: isCaller ? 'caller' : 'callee',
          message: `perms mic=${mic.granted} cam=${isVideo ? camGranted : 'n/a'} canAskAgain=${mic.canAskAgain}`,
        });
        if (cancelled) return;
        if (mic.granted && camGranted) {
          setPermsReady(true);
          return;
        }
        // Denied — cannot place a call without the microphone. Per the
        // permission contract, surface an Open Settings path instead of
        // dead-ending on a silent "connecting" spinner.
        Alert.alert(
          'Permission required',
          isVideo
            ? 'Camera and microphone access are needed to make video calls.'
            : 'Microphone access is needed to make calls.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => router.back() },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      } catch (err: any) {
        // If the permission module itself throws, don't hard-block the call —
        // let connect() proceed (the OS may already have granted access).
        recordDiagnostic({
          tag: 'TWILIO-CALL',
          source: isCaller ? 'caller' : 'callee',
          message: `perms-error ${err?.message || err}`,
        });
        if (!cancelled) setPermsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isVideo, isCaller, router]);

  // Callee path: fetch own token. Caller path skips this (token already
  // provided by initiate-call).
  useEffect(() => {
    if (token || !roomName || !identity) return;
    let cancelled = false;
    fetchTwilioToken(identity, roomName)
      .then((res) => {
        if (!cancelled) setToken(res.token);
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err?.message || 'token fetch failed');
      });
    return () => {
      cancelled = true;
    };
  }, [token, roomName, identity]);

  const enabled = Boolean(token && roomName && identity && permsReady);
  // Stable wrapper so the call session never rebuilds; the real handler is
  // (re)assigned every render below with fresh closures.
  const dataHandlerRef = useRef<(message: string) => void>(() => {});
  const host = useTwilioCallSession({
    identity,
    roomName,
    token: token || '',
    isVideo,
    isCaller,
    region,
    enabled,
    onDataMessage: (m) => dataHandlerRef.current(m),
  });

  // Local UI state for mute / video / speaker buttons.
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(isVideo);
  // iter-232: full audio routing (earpiece / speaker / bluetooth) for BOTH
  // voice and video calls, via InCallManager (same engine the rest of the app
  // uses). Default mirrors the system dialer: video → speaker, voice → earpiece.
  const [audioOutput, setAudioOutput] = useState<AudioOutputRoute>(isVideo ? 'speaker' : 'earpiece');
  const [showAudioPicker, setShowAudioPicker] = useState(false);
  const [btAvailable, setBtAvailable] = useState(false);

  // iter-233 — multiparty (add participant) + privacy-aware roster.
  const me = useQuery(api.users.getCurrentUser, {}) as any;
  const myContacts = useQuery(api.contacts.getContacts, {}) as any[] | undefined;
  const myName = String(me?.name || me?.displayName || '');
  const conversationId = roomName.startsWith('smilers_conv_')
    ? roomName.slice('smilers_conv_'.length)
    : null;

  const [roster, setRoster] = useState<CallRosterEntry[]>([]);
  const [showRoster, setShowRoster] = useState(false);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [pendingAdd, setPendingAdd] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);

  // Poll the privacy-aware roster while connected so names/numbers stay fresh
  // for everyone (the backend masks hidden numbers per-viewer).
  useEffect(() => {
    if (host.state !== 'connected' && host.state !== 'reconnecting') return;
    let active = true;
    const load = () => {
      fetchCallParticipants(roomName, identity).then((list) => {
        if (active) setRoster(list);
      });
    };
    load();
    const iv = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [host.state, roomName, identity]);

  // Identities already in the call — so we don't offer to re-add them.
  const inCallIds = useMemo(() => {
    const s = new Set<string>();
    s.add(identity);
    host.participants.forEach((p) => p.identity && s.add(p.identity));
    roster.forEach((r) => r.identity && s.add(r.identity));
    return s;
  }, [identity, host.participants, roster]);

  const addableContacts = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    return (myContacts || [])
      .filter((c) => c?._id && !inCallIds.has(String(c._id)))
      .filter(
        (c) =>
          !q ||
          String(c.name || '').toLowerCase().includes(q) ||
          String(c.phoneNumber || '').includes(q),
      );
  }, [myContacts, inCallIds, addSearch]);

  const openAddFlow = () => {
    setAddSearch('');
    setPendingAdd(null);
    setShowAddPicker(true);
  };

  const confirmAdd = async (hideNumber: boolean) => {
    const contact = pendingAdd;
    if (!contact?._id) return;
    setAdding(true);
    try {
      await addTwilioParticipant({
        roomName,
        adderIdentity: identity,
        adderDisplayName: myName,
        calleeIdentity: String(contact._id),
        calleeDisplayName: String(contact.name || ''),
        calleePhone: contact.phoneNumber ? String(contact.phoneNumber) : undefined,
        hideNumber,
        isVideo: isVideoMode,
        conversationId,
      });
      setPendingAdd(null);
      setShowAddPicker(false);
      fetchCallParticipants(roomName, identity).then(setRoster);
    } catch (err: any) {
      Alert.alert('Could not add participant', err?.message || 'Please try again.');
    } finally {
      setAdding(false);
    }
  };

  // Host controls (only the call initiator). Remove = server-enforced
  // disconnect via Twilio REST. Mute = cooperative request over the data
  // channel (the target mutes itself), since Twilio can't force-mute a
  // remote track server-side.
  const handleRemoveParticipant = (p: { identity: string; name: string }) => {
    Alert.alert('Remove from call', `Remove ${p.name} from this call?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await removeTwilioParticipant({
              roomName,
              identity: p.identity,
              requesterIdentity: identity,
            });
            fetchCallParticipants(roomName, identity).then(setRoster);
          } catch (err: any) {
            Alert.alert('Could not remove', err?.message || 'Please try again.');
          }
        },
      },
    ]);
  };

  const handleMuteParticipant = (p: { identity: string; name: string }) => {
    host.session?.sendData(JSON.stringify({ t: 'force-mute', from: identity, target: p.identity }));
    Alert.alert('Mute requested', `Asked ${p.name} to mute their microphone.`);
  };

  // Merge live Twilio participants with backend roster metadata for display.
  const rosterByIdentity = useMemo(() => {
    const m = new Map<string, CallRosterEntry>();
    roster.forEach((r) => r.identity && m.set(r.identity, r));
    return m;
  }, [roster]);
  // Resolve friendly names from the viewer's own contacts as a fallback.
  const contactNameById = useMemo(() => {
    const m = new Map<string, string>();
    (myContacts || []).forEach((c) => c?._id && m.set(String(c._id), String(c.name || '')));
    return m;
  }, [myContacts]);
  const participantCount = host.participants.length + 1; // +1 = me

  // iter-230 — voice→video upgrade. The call is in "video mode" if it started
  // as video, OUR camera is on, OR the remote published a camera track. This
  // lets a voice call flip to a video layout mid-call.
  const remoteHasVideo = host.participants.some((p) => !!p.cameraTrackSid);
  const isVideoMode = isVideo || videoOn || remoteHasVideo;
  // Callee side of the handshake: remote asked us to switch to video.
  const [incomingUpgrade, setIncomingUpgrade] = useState(false);
  // Caller side: we asked and are waiting for them to turn their camera on.
  const [awaitingUpgrade, setAwaitingUpgrade] = useState(false);

  // Once both cameras are on, clear the "waiting" hint.
  useEffect(() => {
    if (awaitingUpgrade && remoteHasVideo) setAwaitingUpgrade(false);
  }, [awaitingUpgrade, remoteHasVideo]);

  // Alert the callee with vibration + haptics the moment an upgrade request
  // arrives, so they notice even if they aren't looking at the screen.
  useEffect(() => {
    if (!incomingUpgrade) return;
    try {
      Vibration.vibrate([0, 350, 200, 350]);
    } catch {}
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
    return () => {
      try {
        Vibration.cancel();
      } catch {}
    };
  }, [incomingUpgrade]);

  const enableLocalCamera = useCallback(async () => {
    setVideoOn(true);
    await host.session?.setVideoEnabled(true);
  }, [host.session]);

  // Initiator: turn on our camera immediately (one-sided until they accept)
  // and ask the other side to join with video.
  const handleRequestVideo = useCallback(async () => {
    await enableLocalCamera();
    setAwaitingUpgrade(true);
    host.session?.sendData(JSON.stringify({ t: 'vid-req', from: identity }));
  }, [enableLocalCamera, host.session, identity]);

  const handleAcceptUpgrade = useCallback(async () => {
    setIncomingUpgrade(false);
    await enableLocalCamera();
    host.session?.sendData(JSON.stringify({ t: 'vid-acc', from: identity }));
  }, [enableLocalCamera, host.session, identity]);

  const handleDeclineUpgrade = useCallback(() => {
    setIncomingUpgrade(false);
    host.session?.sendData(JSON.stringify({ t: 'vid-dec', from: identity }));
  }, [host.session, identity]);

  // Handle inbound signaling messages. Reassigned each render so it always
  // sees fresh state; the hook calls it via the stable wrapper above.
  dataHandlerRef.current = (raw: string) => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'vid-req') {
      // Only prompt if our camera is still off.
      if (!videoOn) setIncomingUpgrade(true);
    } else if (msg.t === 'vid-acc') {
      setAwaitingUpgrade(false);
    } else if (msg.t === 'vid-dec') {
      setAwaitingUpgrade(false);
      Alert.alert(
        'Camera stayed off',
        'Your contact kept their camera off — they can still see your video.',
      );
    } else if (msg.t === 'force-mute') {
      // The host asked us to mute. Cooperative mute (we mute ourselves).
      if (msg.target === identity && !muted) {
        setMuted(true);
        host.session?.setMuted(true);
        Alert.alert('Microphone muted', 'The host muted your microphone.');
      }
    }
  };

  // iter-229 — Picture-in-Picture (Android only). When the user swipes the
  // app away mid VIDEO call, collapse into a small PiP window so the call
  // keeps running and the remote video stays visible to BOTH parties (the
  // other side is unaffected). `inPip` lets us hide all chrome (header,
  // controls, self-PiP) while shrunk.
  const inPip = useIsInPip();

  // Enable Android 12+ auto-enter once we're in an active VIDEO call; disable
  // again when the call tears down so other screens never auto-PiP.
  useEffect(() => {
    if (!isPipSupported || !isVideoMode) return;
    const active = host.state === 'connected' || host.state === 'reconnecting';
    setPipParams({ autoEnterEnabled: active, width: 12, height: 16 });
    return () => setPipParams({ autoEnterEnabled: false });
  }, [isVideoMode, host.state]);

  // Fallback for Android < 12 (no auto-enter): manually request PiP the moment
  // the app is backgrounded during an active video call.
  useEffect(() => {
    if (!isPipSupported || !isVideoMode) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (
        (next === 'inactive' || next === 'background') &&
        (host.state === 'connected' || host.state === 'reconnecting') &&
        !navigatedRef.current
      ) {
        enterPip({ width: 12, height: 16 });
      }
    });
    return () => sub.remove();
  }, [isVideoMode, host.state]);

  // iter-216: auto-close the call screen when the call ends remotely.
  // Once the room is completed (caller hung up / callee declined →
  // /api/twilio/end-call), Twilio disconnects us — but nothing was
  // navigating the receiver away, so they were stranded on a dead
  // "Connecting…"/call view. When our session reaches a terminal state
  // AFTER having been active, leave the screen. Guarded so an initial
  // 'failed' (e.g. web stub) never triggers it.
  const navigatedRef = useRef(false);
  const hadConnectedRef = useRef(false);
  const closeScreen = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  useEffect(() => {
    if (host.state === 'connected' || host.state === 'reconnecting') {
      hadConnectedRef.current = true;
    }
    // iter-245: only auto-close on a terminal state if the call had ACTUALLY
    // connected (a clean hang-up / remote end). An INITIAL connect that fails
    // (e.g. callee "failed" before ever connecting) must STAY on screen so the
    // user can read the error and tap Retry — previously this auto-closed
    // after 700ms because wasActiveRef flipped true during 'connecting',
    // which is exactly the "screen shows failed for a second then drops back"
    // the receiver reported.
    if (
      (host.state === 'disconnected' || host.state === 'failed') &&
      hadConnectedRef.current
    ) {
      recordDiagnostic({
        tag: 'TWILIO-CALL',
        source: 'screen',
        message: `auto-close room=${roomName} state=${host.state}`,
      });
      const t = setTimeout(closeScreen, 700);
      return () => clearTimeout(t);
    }
  }, [host.state, closeScreen, roomName]);

  // iter-218 — Issue 3: end the call automatically when the OTHER side
  // leaves. Twilio does NOT disconnect the remaining participant when one
  // party hangs up/declines, so the local room state stays 'connected'
  // (alone) and the screen never auto-closed. We track whether a remote
  // participant ever joined; once they ALL leave again, we treat it as the
  // call having ended and tear down our side too (leave + complete room +
  // close), so the receiver/caller is never stranded on a dead screen.
  const hadRemoteRef = useRef(false);
  useEffect(() => {
    const remoteCount = host.participants?.length || 0;
    if (remoteCount > 0) {
      hadRemoteRef.current = true;
      return;
    }
    if (
      hadRemoteRef.current &&
      remoteCount === 0 &&
      !navigatedRef.current &&
      (host.state === 'connected' || host.state === 'reconnecting')
    ) {
      recordDiagnostic({
        tag: 'TWILIO-CALL',
        source: 'screen',
        message: `remote-left auto-end room=${roomName}`,
      });
      const t = setTimeout(() => {
        try {
          host.session?.leave();
        } catch {}
        endTwilioCall(roomName).catch(() => {});
        closeScreen();
      }, 800);
      return () => clearTimeout(t);
    }
  }, [host.participants, host.state, host.session, roomName, closeScreen]);

  // iter-218 — Issue 3 (caller side): if the callee never answers, end the
  // call as "no answer" after the ring window instead of leaving the caller
  // stranded on "Waiting for others to join…" until they manually tap End.
  // The ring window matches the callee's notifee RING_TIMEOUT (35s).
  useEffect(() => {
    if (!isCaller) return;
    if (host.state !== 'connecting' && host.state !== 'connected') return;
    if ((host.participants?.length || 0) > 0) return; // answered → not a no-answer
    const RING_TIMEOUT_MS = 35000;
    const t = setTimeout(() => {
      if ((host.participants?.length || 0) === 0 && !navigatedRef.current) {
        recordDiagnostic({
          tag: 'TWILIO-CALL',
          source: 'screen',
          message: `caller no-answer ring-timeout room=${roomName}`,
        });
        try {
          host.session?.leave();
        } catch {}
        endTwilioCall(roomName).catch(() => {});
        closeScreen();
      }
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [isCaller, host.state, host.participants, host.session, roomName, closeScreen]);

  // iter-242: caller-side RINGBACK tone. While the caller is waiting for the
  // callee to answer (we're in the Twilio room but no remote participant has
  // joined yet) play the looping ringback so the caller audibly hears the call
  // "ringing". Stops instantly when the callee joins, the call ends, or the
  // screen unmounts. Uses InCallManager's VOICE_CALL-stream ringback so it is
  // NOT muted by MODE_IN_COMMUNICATION.
  useEffect(() => {
    if (!isCaller) return;
    const remoteCount = host.participants?.length || 0;
    const waiting =
      remoteCount === 0 &&
      (host.state === 'connecting' || host.state === 'connected' || host.state === 'reconnecting');
    if (waiting) {
      InCallAudio.startRingback();
      return () => InCallAudio.stopRingback();
    }
    InCallAudio.stopRingback();
  }, [isCaller, host.participants, host.state]);
  // MODE_IN_COMMUNICATION + chooseAudioRoute), the same path the rest of the
  // app uses. Twilio's own speaker toggle only did speaker-on/off and forced
  // speaker for video — so video calls never responded to earpiece/Bluetooth.
  const inCallStartedRef = useRef(false);
  // iter-245: start the audio session as soon as permissions are ready (even
  // while still ringing) so react-native-incall-manager begins emitting
  // onAudioDeviceChanged — otherwise a paired Bluetooth headset is never
  // detected until after the call connects and the BT route stays hidden.
  useEffect(() => {
    if (Platform.OS === 'web' || !permsReady) return;
    if (!inCallStartedRef.current) {
      InCallAudio.start(isVideoMode ? 'video' : 'audio');
      inCallStartedRef.current = true;
    }
  }, [permsReady, isVideoMode]);
  useEffect(() => {
    if (host.state !== 'connected' && host.state !== 'reconnecting') return;
    if (!inCallStartedRef.current) {
      InCallAudio.start(isVideoMode ? 'video' : 'audio');
      inCallStartedRef.current = true;
    }
    if (audioOutput === 'speaker') {
      InCallAudio.setSpeakerOn(true);
    } else if (audioOutput === 'bluetooth') {
      InCallAudio.setBluetoothOn(isVideoMode ? 'video' : 'audio');
    } else {
      InCallAudio.setEarpieceOn();
    }
  }, [audioOutput, host.state, isVideoMode]);

  // Release the audio session when leaving the call screen.
  useEffect(() => () => InCallAudio.stop(), []);

  // Screen-share session (iter-234): once connected, auto-start the screen
  // broadcast (Android) and optionally start muted. Runs once.
  const autoShareDoneRef = useRef(false);
  useEffect(() => {
    if (host.state !== 'connected' || autoShareDoneRef.current) return;
    autoShareDoneRef.current = true;
    if (startMuted) {
      setMuted(true);
      host.session?.setMuted(true);
    }
    if (autoShare && Platform.OS !== 'ios' && host.screenShareState !== 'on') {
      host.session?.setScreenShareEnabled(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.state]);

  // Auto-switch to Bluetooth when a headset connects mid-call; fall back to
  // speaker (video) / earpiece (voice) when it disconnects — mirrors the
  // system dialer. Also tracks availability so the picker can show/hide BT.
  const btWasAvailableRef = useRef(false);
  useEffect(() => {
    const unsubscribe = InCallAudio.addAudioDeviceChangedListener(({ available }) => {
      const has = available.includes('BLUETOOTH');
      setBtAvailable(has);
      if (has && !btWasAvailableRef.current) {
        setAudioOutput('bluetooth');
      } else if (!has && btWasAvailableRef.current) {
        setAudioOutput((current) =>
          current === 'bluetooth' ? (isVideoMode ? 'speaker' : 'earpiece') : current,
        );
      }
      btWasAvailableRef.current = has;
    });
    return unsubscribe;
  }, [isVideoMode]);

  // When a voice call is upgraded to video, bump earpiece → speaker (phone-like)
  // unless the user is on Bluetooth.
  const prevVideoModeRef = useRef(isVideoMode);
  useEffect(() => {
    if (isVideoMode && !prevVideoModeRef.current) {
      setAudioOutput((current) => (current === 'earpiece' ? 'speaker' : current));
    }
    prevVideoModeRef.current = isVideoMode;
  }, [isVideoMode]);

  const handleMute = async () => {
    const next = !muted;
    setMuted(next);
    await host.session?.setMuted(next);
  };

  const handleVideo = async () => {
    const next = !videoOn;
    setVideoOn(next);
    await host.session?.setVideoEnabled(next);
  };

  const handleFlip = () => host.session?.flipCamera();

  const selectAudioRoute = (route: AudioOutputRoute) => {
    setAudioOutput(route);
    setShowAudioPicker(false);
  };

  // Icon/label for the current audio route (shown on the control button).
  const audioRouteIcon: keyof typeof Feather.glyphMap =
    audioOutput === 'speaker' ? 'volume-2' : audioOutput === 'bluetooth' ? 'bluetooth' : 'phone-call';
  const audioRouteLabel =
    audioOutput === 'speaker' ? 'Speaker' : audioOutput === 'bluetooth' ? 'Bluetooth' : 'Earpiece';

  const handleScreenShare = () => {
    // Phase A.5: iOS requires a ReplayKit Broadcast Extension target
    // (separate Xcode work). Block on iOS with an explanatory alert
    // until that lands. Android works out of the box via MediaProjection.
    if (Platform.OS === 'ios') {
      Alert.alert(
        'Coming soon on iOS',
        'Full-device screen sharing on iOS requires a Broadcast Upload Extension that ships in a later build. Available on Android now.',
      );
      return;
    }
    const next = host.screenShareState !== 'on';
    host.session?.setScreenShareEnabled(next);
  };

  const handleHangup = () => {
    try {
      host.session?.leave();
    } finally {
      // Force-complete the Twilio room so the call ends for EVERYONE.
      // Twilio does not auto-disconnect the remaining participant when
      // one side leaves, so without this the other phone keeps ringing /
      // stays connected. Fire-and-forget + idempotent on the backend.
      endTwilioCall(roomName).catch(() => {});
      recordDiagnostic({
        tag: 'TWILIO-CALL',
        source: 'screen',
        message: `hangup room=${roomName} final_state=${host.state}`,
      });
      // Go back to wherever launched the call (guarded against the
      // auto-close effect also firing on the resulting 'disconnected').
      closeScreen();
    }
  };

  // -----------------------------------------------------------
  // Render
  // -----------------------------------------------------------

  if (Platform.OS === 'web' || !host.isSupported) {
    return (
      <View style={[styles.container, { padding: 24, justifyContent: 'center' }]}>
        <Text style={styles.errorText}>
          {host.error || 'Twilio Video is not supported on web. Open this screen from a mobile build.'}
        </Text>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (fetchError) {
    return (
      <View style={[styles.container, { padding: 24, justifyContent: 'center' }]}>
        <Feather name="alert-triangle" size={32} color="#ff6b6b" />
        <Text style={styles.errorText}>Could not fetch call token: {fetchError}</Text>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Hidden Twilio host component — never visible itself; it's the
          imperative engine and the source of all events. */}
      <View style={styles.hidden}>{host.videoElement}</View>

      {/* Remote participant tiles (grid) */}
      <View style={styles.remoteArea}>
        {host.participants.length === 0 ? (
          <View style={styles.placeholder}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.placeholderText}>
              {host.state === 'connecting'
                ? isCaller && calleeId
                  ? calleeOnline
                    ? 'Ringing…'
                    : 'Calling…'
                  : 'Connecting…'
                : host.state === 'connected'
                ? isCaller && calleeId
                  ? calleeOnline
                    ? 'Ringing…'
                    : 'Calling…'
                  : 'Waiting for others to join…'
                : host.state}
            </Text>
            {/* iter-245: surface the exact Twilio failure reason + a Retry so
                a "failed" connect is diagnosable (screenshot/report) instead
                of a silent spinner. */}
            {host.state === 'failed' && host.error ? (
              <Text style={styles.placeholderError}>{host.error}</Text>
            ) : null}
            {host.state === 'failed' ? (
              <Pressable onPress={() => host.session?.connect()} style={styles.retryBtn}>
                <Feather name="rotate-cw" size={16} color="#fff" />
                <Text style={styles.retryBtnText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          host.participants.map((p) => {
            // iter-229: when a participant shares their SCREEN, show it large
            // (full tile) with their CAMERA as a small PiP overlay on top —
            // so the receiver sees BOTH the shared screen and the sharer's
            // face simultaneously (option 1a). The shared screen renders even
            // on a voice call (no `isVideo` gate).
            const hasScreen = !!p.screenTrackSid;
            const camera = host.renderParticipantView(p, styles.remoteVideo);

            if (hasScreen) {
              const screen = host.renderParticipantScreenView(p, styles.remoteVideo);
              return (
                <View key={p.sid} style={styles.remoteVideo}>
                  {screen}
                  {camera ? (
                    <View style={styles.remoteCameraPip}>
                      {host.renderParticipantView(p, styles.remoteCameraPipInner)}
                    </View>
                  ) : null}
                  <View style={styles.screenShareBadge}>
                    <Feather name="monitor" size={10} color="#fff" />
                    <Text style={styles.screenShareBadgeText}>Sharing screen</Text>
                  </View>
                </View>
              );
            }

            return camera ? (
              <View key={p.sid} style={styles.remoteVideo}>
                {camera}
              </View>
            ) : (
              <View key={p.sid} style={[styles.remoteVideo, styles.audioTile]}>
                <Feather name="user" size={56} color={Colors.white} />
                <Text style={styles.audioName}>{p.identity}</Text>
              </View>
            );
          })
        )}
      </View>

      {/* Local self-view (PiP top-right) — only when our camera is on & not shrunk */}
      {videoOn && !inPip ? (
        <View style={[styles.localPip, { top: insets.top + 12 }]}>
          {host.renderLocalView(styles.localPipInner, videoOn)}
        </View>
      ) : null}

      {/* Top header */}
      {!inPip ? (
        <View style={[styles.header, { top: insets.top + 8 }]}>
          <Text style={styles.titleText} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.subTitle}>{host.state}</Text>
          <Pressable onPress={() => setShowRoster(true)} style={styles.participantsPill} hitSlop={8}>
            <Feather name="users" size={13} color="#fff" />
            <Text style={styles.participantsPillText}>
              {participantCount} {participantCount === 1 ? 'person' : 'people'}
            </Text>
            <Feather name="chevron-right" size={13} color="#bbb" />
          </Pressable>
        </View>
      ) : null}

      {/* iter-230 — incoming voice→video upgrade request (callee side). */}
      {incomingUpgrade && !inPip ? (
        <View style={[styles.upgradeBanner, { bottom: insets.bottom + 120 }]}>
          <Feather name="video" size={20} color="#fff" />
          <Text style={styles.upgradeText} numberOfLines={2}>
            {title} wants to switch to video
          </Text>
          <View style={styles.upgradeActions}>
            <Pressable onPress={handleDeclineUpgrade} style={[styles.upgradeBtn, styles.upgradeDecline]} hitSlop={6}>
              <Text style={styles.upgradeBtnText}>Not now</Text>
            </Pressable>
            <Pressable onPress={handleAcceptUpgrade} style={[styles.upgradeBtn, styles.upgradeAccept]} hitSlop={6}>
              <Text style={styles.upgradeBtnText}>Turn on camera</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Bottom controls — fixed, wrapping bar (no horizontal scroll so the
          buttons stay put and contained on every screen width). */}
      {!inPip ? (
      <View style={[styles.controls, { paddingBottom: insets.bottom + 16 }]}>
        <ControlBtn icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} onPress={handleMute} active={muted} />
        {isVideoMode ? (
          <ControlBtn icon={videoOn ? 'video' : 'video-off'} label={videoOn ? 'Stop video' : 'Start video'} onPress={handleVideo} active={!videoOn} />
        ) : (
          <ControlBtn icon="video" label={awaitingUpgrade ? 'Requested' : 'Video'} onPress={handleRequestVideo} active={awaitingUpgrade} />
        )}
        {isVideoMode ? <ControlBtn icon="rotate-cw" label="Flip" onPress={handleFlip} /> : null}
        <ControlBtn
          icon={audioRouteIcon}
          label={audioRouteLabel}
          onPress={() => setShowAudioPicker(true)}
          active={audioOutput === 'speaker' || audioOutput === 'bluetooth'}
        />
        <ControlBtn
          icon="monitor"
          label={host.screenShareState === 'on' ? 'Stop share' : 'Share'}
          onPress={handleScreenShare}
          active={host.screenShareState === 'on'}
        />
        <ControlBtn icon="user-plus" label="Add" onPress={openAddFlow} />
        <Pressable onPress={handleHangup} style={[styles.controlBtn, styles.hangupBtn]}>
          <Feather name="phone-off" size={22} color="#fff" />
          <Text style={styles.hangupLabel}>End</Text>
        </Pressable>
      </View>
      ) : null}

      {/* iter-232 — audio output route picker (earpiece / speaker / bluetooth). */}
      <Modal
        visible={showAudioPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAudioPicker(false)}
      >
        <Pressable style={styles.audioBackdrop} onPress={() => setShowAudioPicker(false)}>
          <Pressable style={[styles.audioSheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => undefined}>
            <Text style={styles.audioSheetTitle}>Audio output</Text>
            <AudioRouteRow icon="phone-call" label="Earpiece" selected={audioOutput === 'earpiece'} onPress={() => selectAudioRoute('earpiece')} />
            <AudioRouteRow icon="volume-2" label="Speaker" selected={audioOutput === 'speaker'} onPress={() => selectAudioRoute('speaker')} />
            {/* iter-245: always offer Bluetooth (was hidden until an
                onAudioDeviceChanged event flipped btAvailable, which only fires
                after the call connects — so it was effectively never shown).
                selectAudioRoute('bluetooth') requests BLUETOOTH_CONNECT and
                routes SCO; if no device is paired it falls back gracefully. */}
            <AudioRouteRow
              icon="bluetooth"
              label={btAvailable ? 'Bluetooth' : 'Bluetooth (connect a device)'}
              selected={audioOutput === 'bluetooth'}
              onPress={() => selectAudioRoute('bluetooth')}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* iter-233 — Add participant: contact picker → privacy choice. */}
      <Modal
        visible={showAddPicker}
        transparent
        animationType="slide"
        onRequestClose={() => (adding ? undefined : setShowAddPicker(false))}
      >
        <View style={styles.addBackdrop}>
          <View style={[styles.addSheet, { paddingBottom: insets.bottom + 12 }]}>
            <View style={styles.addHeader}>
              <Text style={styles.addTitle}>{pendingAdd ? 'Share number?' : 'Add to call'}</Text>
              <Pressable onPress={() => (adding ? undefined : setShowAddPicker(false))} hitSlop={8}>
                <Feather name="x" size={22} color="#fff" />
              </Pressable>
            </View>

            {pendingAdd ? (
              // Privacy step — regulatory: adder decides number visibility.
              <View style={styles.privacyStep}>
                <View style={styles.privacyAvatar}>
                  <Text style={styles.privacyAvatarText}>
                    {String(pendingAdd.name || '?').trim().charAt(0).toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.privacyName}>{pendingAdd.name || 'Contact'}</Text>
                <Text style={styles.privacyMsg}>
                  Should other participants be able to see{' '}
                  {String(pendingAdd.name || 'this contact').split(' ')[0]}&apos;s phone number?
                </Text>
                <Pressable
                  style={[styles.privacyChoice, styles.privacyHide]}
                  disabled={adding}
                  onPress={() => confirmAdd(true)}
                >
                  <Feather name="eye-off" size={20} color="#fff" />
                  <View style={styles.privacyChoiceText}>
                    <Text style={styles.privacyChoiceTitle}>Hide number</Text>
                    <Text style={styles.privacyChoiceSub}>Others won&apos;t see their phone number</Text>
                  </View>
                </Pressable>
                <Pressable
                  style={[styles.privacyChoice, styles.privacyShow]}
                  disabled={adding}
                  onPress={() => confirmAdd(false)}
                >
                  <Feather name="eye" size={20} color="#fff" />
                  <View style={styles.privacyChoiceText}>
                    <Text style={styles.privacyChoiceTitle}>Show number</Text>
                    <Text style={styles.privacyChoiceSub}>Others will see their phone number</Text>
                  </View>
                </Pressable>
                <Pressable style={styles.privacyBack} disabled={adding} onPress={() => setPendingAdd(null)}>
                  <Text style={styles.privacyBackText}>{adding ? 'Adding…' : 'Back'}</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <View style={styles.addSearchRow}>
                  <Feather name="search" size={16} color="#888" />
                  <TextInput
                    style={styles.addSearchInput}
                    placeholder="Search contacts"
                    placeholderTextColor="#888"
                    value={addSearch}
                    onChangeText={setAddSearch}
                    autoCorrect={false}
                  />
                </View>
                <FlatList
                  data={addableContacts}
                  keyExtractor={(item) => String(item._id)}
                  keyboardShouldPersistTaps="handled"
                  style={styles.addList}
                  ListEmptyComponent={
                    <Text style={styles.addEmpty}>
                      {myContacts === undefined ? 'Loading contacts…' : 'No contacts to add'}
                    </Text>
                  }
                  renderItem={({ item }) => (
                    <Pressable style={styles.addRow} onPress={() => setPendingAdd(item)}>
                      {item.avatar ? (
                        <Image source={{ uri: item.avatar }} style={styles.addRowAvatar} />
                      ) : (
                        <View style={[styles.addRowAvatar, styles.addRowAvatarFallback]}>
                          <Text style={styles.addRowAvatarText}>
                            {String(item.name || '?').trim().charAt(0).toUpperCase()}
                          </Text>
                        </View>
                      )}
                      <View style={styles.addRowText}>
                        <Text style={styles.addRowName} numberOfLines={1}>{item.name || 'Contact'}</Text>
                        {item.phoneNumber ? (
                          <Text style={styles.addRowPhone} numberOfLines={1}>{item.phoneNumber}</Text>
                        ) : null}
                      </View>
                      <Feather name="plus-circle" size={22} color={Colors.primary} />
                    </Pressable>
                  )}
                />
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* iter-233 — Participant roster (privacy-aware numbers). */}
      <Modal
        visible={showRoster}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRoster(false)}
      >
        <View style={styles.addBackdrop}>
          <View style={[styles.addSheet, { paddingBottom: insets.bottom + 12 }]}>
            <View style={styles.addHeader}>
              <Text style={styles.addTitle}>In this call ({participantCount})</Text>
              <Pressable onPress={() => setShowRoster(false)} hitSlop={8}>
                <Feather name="x" size={22} color="#fff" />
              </Pressable>
            </View>
            <View style={styles.rosterList}>
              <RosterRow name={`${myName || 'You'} (you)`} phone={null} />
              {host.participants.map((p) => {
                const meta = rosterByIdentity.get(p.identity);
                const name = meta?.displayName || contactNameById.get(p.identity) || p.identity;
                return (
                  <RosterRow
                    key={p.sid}
                    name={name}
                    phone={meta?.phoneNumber || null}
                    hidden={meta?.hideNumber}
                    isHost={isCaller}
                    onRemove={() => handleRemoveParticipant({ identity: p.identity, name })}
                    onMute={() => handleMuteParticipant({ identity: p.identity, name })}
                  />
                );
              })}
            </View>
            <Pressable style={styles.rosterAddBtn} onPress={() => { setShowRoster(false); openAddFlow(); }}>
              <Feather name="user-plus" size={18} color="#fff" />
              <Text style={styles.rosterAddText}>Add participant</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

interface RosterRowProps {
  name: string;
  phone: string | null;
  hidden?: boolean;
  isHost?: boolean;
  onRemove?: () => void;
  onMute?: () => void;
}

function RosterRow({ name, phone, hidden, isHost, onRemove, onMute }: RosterRowProps) {
  return (
    <View style={styles.rosterRow}>
      <View style={[styles.addRowAvatar, styles.addRowAvatarFallback]}>
        <Text style={styles.addRowAvatarText}>{name.trim().charAt(0).toUpperCase()}</Text>
      </View>
      <View style={styles.addRowText}>
        <Text style={styles.addRowName} numberOfLines={1}>{name}</Text>
        {phone ? (
          <Text style={styles.addRowPhone} numberOfLines={1}>{phone}</Text>
        ) : hidden ? (
          <Text style={styles.rosterHidden}>Number hidden</Text>
        ) : null}
      </View>
      {isHost ? (
        <View style={styles.rosterActions}>
          <Pressable onPress={onMute} hitSlop={8} style={styles.rosterIconBtn}>
            <Feather name="mic-off" size={18} color="#ddd" />
          </Pressable>
          <Pressable onPress={onRemove} hitSlop={8} style={styles.rosterIconBtn}>
            <Feather name="user-x" size={18} color="#e63946" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

interface AudioRouteRowProps {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  selected: boolean;
  onPress: () => void;
}

function AudioRouteRow({ icon, label, selected, onPress }: AudioRouteRowProps) {
  return (
    <Pressable onPress={onPress} style={[styles.audioRow, selected && styles.audioRowSelected]}>
      <Feather name={icon} size={20} color={selected ? Colors.primary : '#fff'} />
      <Text style={[styles.audioRowLabel, selected && styles.audioRowLabelSelected]}>{label}</Text>
      {selected ? <Feather name="check" size={18} color={Colors.primary} style={styles.audioRowCheck} /> : null}
    </Pressable>
  );
}

interface ControlBtnProps {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  active?: boolean;
}

function ControlBtn({ icon, label, onPress, active }: ControlBtnProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.controlBtn, active && styles.controlBtnActive]}
      hitSlop={8}
    >
      <Feather name={icon} size={22} color={active ? '#222' : '#fff'} />
      <Text style={[styles.controlLabel, active && styles.controlLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101010' },
  hidden: { width: 0, height: 0, position: 'absolute' },
  remoteArea: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  placeholderText: { color: '#ccc', fontSize: 15 },
  placeholderError: {
    color: '#ff8a80',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 24,
    backgroundColor: Colors.primary,
  },
  retryBtnText: { color: '#fff', fontWeight: FontWeight.bold, fontSize: 14 },
  remoteVideo: { flexGrow: 1, flexBasis: '45%', minWidth: 160, backgroundColor: '#000' },
  audioTile: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  audioName: { color: '#fff', fontSize: 15 },
  localPip: {
    position: 'absolute',
    right: 12,
    width: 110,
    height: 160,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  localPipInner: { flex: 1 },
  remoteCameraPip: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    width: 110,
    height: 150,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 2,
    borderColor: '#ffb74d',
  },
  remoteCameraPipInner: { flex: 1 },
  screenSharePip: {
    position: 'absolute',
    right: 12,
    width: 110,
    height: 160,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#ffb74d',
  },
  screenShareBadge: {
    position: 'absolute',
    bottom: 4, left: 4, flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(255,183,77,0.85)',
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6,
  },
  screenShareBadgeText: { fontSize: 9, color: '#fff', fontWeight: '700' },
  header: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 4 },
  titleText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  subTitle: { color: '#999', fontSize: 12 },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    rowGap: 12,
    columnGap: 14,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  controlBtn: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  controlBtnActive: { backgroundColor: '#fff' },
  controlLabel: { fontSize: 9, color: '#fff', marginTop: 1 },
  controlLabelActive: { color: '#222' },
  hangupBtn: { backgroundColor: '#e63946' },
  hangupLabel: { fontSize: 9, color: '#fff', marginTop: 1 },
  audioBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  audioSheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  audioSheetTitle: {
    color: '#8e8e93',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 4,
  },
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  audioRowSelected: { backgroundColor: 'rgba(255,255,255,0.06)' },
  audioRowLabel: { color: '#fff', fontSize: 16, fontWeight: '500', flex: 1 },
  audioRowLabelSelected: { color: Colors.primary },
  audioRowCheck: { marginLeft: 'auto' },
  participantsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 16,
  },
  participantsPillText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  addBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  addSheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 14,
    maxHeight: '78%',
  },
  addHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  addTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  addSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 8,
  },
  addSearchInput: { flex: 1, color: '#fff', fontSize: 15, padding: 0 },
  addList: { maxHeight: 360 },
  addEmpty: { color: '#888', textAlign: 'center', paddingVertical: 28, fontSize: 14 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  addRowAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#333' },
  addRowAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  addRowAvatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  addRowText: { flex: 1 },
  addRowName: { color: '#fff', fontSize: 16, fontWeight: '500' },
  addRowPhone: { color: '#9a9a9a', fontSize: 13, marginTop: 1 },
  privacyStep: { alignItems: 'center', paddingTop: 8, paddingBottom: 6, gap: 8 },
  privacyAvatar: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  privacyAvatarText: { color: '#fff', fontSize: 26, fontWeight: '700' },
  privacyName: { color: '#fff', fontSize: 18, fontWeight: '700' },
  privacyMsg: { color: '#b5b5b5', fontSize: 14, textAlign: 'center', paddingHorizontal: 16, marginBottom: 6 },
  privacyChoice: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    width: '100%', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16,
  },
  privacyHide: { backgroundColor: 'rgba(255,255,255,0.10)' },
  privacyShow: { backgroundColor: 'rgba(255,255,255,0.06)' },
  privacyChoiceText: { flex: 1 },
  privacyChoiceTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  privacyChoiceSub: { color: '#9a9a9a', fontSize: 12, marginTop: 1 },
  privacyBack: { paddingVertical: 12 },
  privacyBackText: { color: Colors.primary, fontSize: 15, fontWeight: '600' },
  rosterList: { gap: 4 },
  rosterRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  rosterHidden: { color: '#777', fontSize: 13, fontStyle: 'italic', marginTop: 1 },
  rosterActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rosterIconBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  rosterAddBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 14, marginTop: 14,
  },
  rosterAddText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  upgradeBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(20,20,20,0.95)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 10,
  },
  upgradeText: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  upgradeActions: { flexDirection: 'row', gap: 10, marginTop: 2 },
  upgradeBtn: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 24 },
  upgradeDecline: { backgroundColor: 'rgba(255,255,255,0.14)' },
  upgradeAccept: { backgroundColor: Colors.primary },
  upgradeBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  errorText: { color: '#ff8a8a', fontSize: 15, textAlign: 'center', marginVertical: 12 },
  backBtn: { backgroundColor: Colors.primary, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8, alignSelf: 'center' },
  backBtnText: { color: Colors.white, fontWeight: '600' },
});
