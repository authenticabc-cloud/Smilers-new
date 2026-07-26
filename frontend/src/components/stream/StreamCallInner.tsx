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
import { ActivityIndicator, Alert, Animated, AppState, Dimensions, FlatList, Image, Modal, PanResponder, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
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
  enterPiPAndroid,
  CallingState,
} from '@stream-io/video-react-native-sdk';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convexApi';
import { createStreamVideoClient } from '../../lib/stream/streamClient';
import { callHost, useCallHost } from '../../lib/call/callHost';
import { useReactiveSafeConvexQuery } from '../../hooks/useReactiveSafeConvexQuery';
import { InterpreterLayer } from '../interpreter/InterpreterLayer';
import {
  useDeviceContactIndex,
  resolveDeviceContactNameFromUser,
} from '../../lib/deviceContactIndex';
import { InCallAudio } from '../../lib/webrtc/inCallManager';
import { getRingDelivery, subscribeRingDelivery } from '../../lib/call/ringDelivery';
import { ControlBtn, AudioOutputMenu } from '../call/CallScreenComponents';
import { useRingtonePlayer } from '../../lib/ringtone/useRingtonePlayer';
import { addStreamParticipant, fetchCallParticipants, removeStreamParticipant, type CallRosterEntry } from '../../lib/twilio/twilioApi';
import type { AudioOutputRoute } from '../call/callTypes';
import * as Haptics from 'expo-haptics';
import { Colors } from '../../theme';
import { recordDiagnostic } from '../../lib/diagnostics';

function fmt(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// Control-button backgrounds: translucent default, highlighted when "on".
const CTRL_BG = 'rgba(255,255,255,0.16)';
const CTRL_BG_ON = 'rgba(233,181,59,0.92)';

/**
 * Auto-enable Stream's Krisp noise + echo cancellation on join when the device
 * supports advanced audio processing. Renders nothing. Native processors are
 * registered in MainApplication.kt (Android) / AppDelegate.swift (iOS).
 */
function NoiseCancellationAutoEnable() {
  const nc = useNoiseCancellation?.() as any;
  const setEnabled = nc?.setEnabled;
  const isEnabled = !!nc?.isEnabled;
  // #3: the user wants noise/echo cancellation ON automatically at call start
  // (the "Noise" control should already be yellow), and only OFF if THEY turn
  // it off. The previous gate required `deviceSupportsAdvancedAudioProcessing`,
  // which is false on some devices even though `setEnabled` works there (proven
  // by the manual toggle turning it on) — so it never auto-engaged. We now try
  // as soon as the NC controller is available and RETRY a few times until it
  // actually sticks (Krisp sometimes needs the audio track live first). Once it
  // succeeds we stop, so a later user OFF is respected.
  const succeededRef = useRef(false);
  const attemptsRef = useRef(0);
  useEffect(() => {
    if (succeededRef.current || !setEnabled) return;
    if (isEnabled) {
      succeededRef.current = true;
      return;
    }
    if (attemptsRef.current >= 5) return;
    const delay = attemptsRef.current === 0 ? 0 : 900;
    const t = setTimeout(() => {
      attemptsRef.current += 1;
      try {
        const r = setEnabled(true);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {}
    }, delay);
    return () => clearTimeout(t);
  }, [setEnabled, isEnabled]);
  return null;
}

type CallUIProps = {
  isVideo: boolean;
  isCaller: boolean;
  peerName: string;
  convStatus: string | undefined;
  callId: string | null;
  onHangup: () => void;
  /** ms epoch when the call was accepted/initiated — for connect-latency telemetry. */
  acceptedAt: number | null;
  /** Stream room id used to add participants + fetch the privacy-aware roster. */
  room: string | null;
  /** This user's Convex id / name / phone — for the add-participant roster. */
  myId: string | null;
  myName: string;
  myPhone: string;
  /** Convex conversation id of the current call (fallback for add routing). */
  conversationId: string;
};

/** In-call UI (inside StreamCall context). */
function CallUI({ isVideo, isCaller, peerName, convStatus, callId, onHangup, acceptedAt, room, myId, myName, myPhone, conversationId }: CallUIProps) {
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
  const [videoMode, setVideoMode] = useState(isVideo); // upgraded when voice→video
  const [audioRoute, setAudioRoute] = useState<AudioOutputRoute>(isVideo ? 'speaker' : 'earpiece');
  const [audioMenuVisible, setAudioMenuVisible] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [callVideoHidden, setCallVideoHidden] = useState(false); // feature 3 (local hide)
  const wasConnectedRef = useRef(false);

  // #5: draggable self-view (local camera preview). Anchored top-right by
  // styles.selfView; we apply a translate on top so the user can move it
  // anywhere and it snaps to stay on-screen.
  const SELF_W = 110;
  const SELF_H = 160;
  const { width: winW, height: winH } = Dimensions.get('window');
  const selfPan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const selfPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
        onPanResponderGrant: () => {
          selfPan.extractOffset();
        },
        onPanResponderMove: Animated.event([null, { dx: selfPan.x, dy: selfPan.y }], {
          useNativeDriver: false,
        }),
        onPanResponderRelease: () => {
          selfPan.flattenOffset();
          // Default anchor is top:60 right:16 → translate range keeps it on-screen.
          const defaultLeft = winW - 16 - SELF_W;
          const defaultTop = 60;
          const x = (selfPan.x as any)._value as number;
          const y = (selfPan.y as any)._value as number;
          const minX = 12 - defaultLeft;
          const maxX = winW - SELF_W - 12 - defaultLeft;
          const minY = 54 - defaultTop;
          const maxY = winH - SELF_H - 120 - defaultTop;
          const cx = Math.min(maxX, Math.max(minX, x));
          const cy = Math.min(maxY, Math.max(minY, y));
          Animated.spring(selfPan, {
            toValue: { x: cx, y: cy },
            useNativeDriver: false,
            friction: 7,
          }).start();
        },
      }),
    [selfPan, winW, winH],
  );

  // Noise / echo cancellation state (Krisp). Only surfaced when the device
  // supports advanced audio processing (native build only).
  const nc = useNoiseCancellation?.() as any;
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
  const remoteHasVideo = !!(remote && ((remote as any).videoStream || (remote as any).publishedTracks?.includes?.(2)));
  const showVideo = (videoMode || remoteHasVideo) && !callVideoHidden;

  // #4 FIX (self-view appears briefly then disappears): the local camera track
  // gets released by WebRTC whenever the app is backgrounded (and Stream can
  // drop the local publish during the SFU renegotiation right after join). The
  // self-view tile then goes black / vanishes until the user toggles the
  // camera off+on. Re-assert `camera.enable()` (a) shortly after we connect and
  // (b) whenever the app returns to the foreground — as long as the user still
  // wants video on. Idempotent and best-effort.
  useEffect(() => {
    if (!call || !connected || !(videoMode && camOn)) return;
    let cancelled = false;
    call.camera.enable().catch(() => {});
    const t = setTimeout(() => {
      if (!cancelled) call.camera.enable().catch(() => {});
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [call, connected, videoMode, camOn]);

  useEffect(() => {
    if (!call) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && videoMode && camOn) {
        // Camera was likely released while backgrounded — re-acquire it so the
        // self-view (and our outgoing video) don't stay black on return.
        setTimeout(() => call.camera.enable().catch(() => {}), 300);
      }
    });
    return () => sub.remove();
  }, [call, videoMode, camOn]);

  // Connection-quality (Stream exposes SfuModels.ConnectionQuality per
  // participant: 0 unknown, 1 poor, 2 good, 3 excellent). Surface the weaker of
  // remote/local so the user gets an honest WhatsApp-style signal indicator.
  const remoteQuality = Number((remote as any)?.connectionQuality ?? 0);
  const localQuality = Number((local as any)?.connectionQuality ?? 0);
  const rated = [remoteQuality, localQuality].filter((q) => q > 0);
  const connQuality = rated.length ? Math.min(...rated) : 0;

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

  // Connect-latency telemetry: record how long from accept/initiate until the
  // remote participant is actually present and media is flowing. Fires once.
  const connectedLoggedRef = useRef(false);
  useEffect(() => {
    if (!connected || connectedLoggedRef.current) return;
    connectedLoggedRef.current = true;
    const ms = acceptedAt ? Date.now() - acceptedAt : -1;
    recordDiagnostic({
      tag: 'CALL',
      source: 'streamTiming',
      message: `connected role=${isCaller ? 'caller' : 'callee'} video=${isVideo} t+connect=${ms}ms callId=${callId || '∅'}`,
    });
  }, [connected, acceptedAt, isCaller, isVideo, callId]);

  // #1/#2 diagnostics: if we joined the Stream room but never see the remote
  // (call spins forever / turns into a missed call even though it was answered),
  // log ONCE at 12s with the room id + role so we can compare BOTH devices' logs
  // and confirm whether caller & callee are actually in the SAME room.
  const stallLoggedRef = useRef(false);
  useEffect(() => {
    if (connected || stallLoggedRef.current) return;
    const t = setTimeout(() => {
      if (connectedLoggedRef.current || stallLoggedRef.current) return;
      stallLoggedRef.current = true;
      recordDiagnostic({
        tag: 'CALL',
        source: 'streamTiming',
        message: `STALL not-connected-after-12s role=${isCaller ? 'caller' : 'callee'} state=${callingState} remotes=${remoteParticipants?.length ?? 0} room=${callId || '∅'}`,
      });
    }, 12000);
    return () => clearTimeout(t);
  }, [connected, isCaller, callingState, remoteParticipants, callId]);


  // End when Convex says ended/declined — but ONLY during the ring phase.
  // Once media is connected, the Stream session is authoritative; a ring
  // TTL/timeout on the Convex record must NOT drop a live call (this was
  // killing connected calls at ~60s).
  useEffect(() => {
    if (wasConnectedRef.current) return;
    if (convStatus === 'ended' || convStatus === 'declined') onHangup();
  }, [convStatus, onHangup]);

  // End if the remote genuinely leaves AFTER connecting.
  // #6b FIX ("other party stays ~30s on 'connecting' after I end"): when the
  // remote DELIBERATELY hangs up, the call record also flips to ended/declined
  // — end almost immediately instead of waiting out the ICE-reconnect grace
  // period (Stream otherwise keeps us in RECONNECTING for ~30s chasing a peer
  // that's gone). A plain participant drop with NO ended-status is treated as a
  // possible transient ICE blip and still gets a short (3s) grace. The
  // remote-present guard keeps a ring-TTL "ended" from killing a live call.
  useEffect(() => {
    if (!wasConnectedRef.current) return;
    if (remoteParticipants.length > 0) return;
    const remoteHungUp =
      convStatus === 'ended' ||
      convStatus === 'declined' ||
      convStatus === 'cancelled' ||
      convStatus === 'missed';
    const t = setTimeout(() => onHangup(), remoteHungUp ? 400 : 3000);
    return () => clearTimeout(t);
  }, [remoteParticipants.length, convStatus, onHangup]);

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

  // Audio output routing. Stream RN does NOT manage audio routing itself, so we
  // drive the native AudioManager via InCallAudio (same as the WebRTC screen).
  const applyAudioRoute = useCallback((route: AudioOutputRoute) => {
    setAudioRoute(route);
    setAudioMenuVisible(false);
    try {
      if (route === 'speaker') InCallAudio.setSpeakerOn(true);
      else if (route === 'bluetooth') InCallAudio.setBluetoothOn(videoMode ? 'video' : 'audio');
      else InCallAudio.setEarpieceOn();
    } catch {}
  }, [videoMode]);

  // Voice → Video upgrade mid-call. Per requirement (2b), the switch now
  // REQUESTS the peer's consent via a Stream custom event; we only publish our
  // camera once they accept. `doEnableVideo` performs the actual upgrade.
  const doEnableVideo = useCallback(async () => {
    if (!call) return;
    try {
      await call.camera.enable();
      setCamOn(true);
      setVideoMode(true);
      applyAudioRoute('speaker');
    } catch {}
  }, [call, applyAudioRoute]);

  const [awaitingVideoAccept, setAwaitingVideoAccept] = useState(false);
  const [incomingVideoReqFrom, setIncomingVideoReqFrom] = useState<string | null>(null);

  const switchToVideo = useCallback(() => {
    if (!call) return;
    setAwaitingVideoAccept(true);
    try {
      void call.sendCustomEvent({ type: 'video-switch-request' }).catch(() => {});
    } catch {}
    // Safety: if no response in 20s, stop waiting.
    setTimeout(() => setAwaitingVideoAccept(false), 20000);
  }, [call]);

  const acceptVideoSwitch = useCallback(() => {
    setIncomingVideoReqFrom(null);
    try {
      void call?.sendCustomEvent({ type: 'video-switch-accept' }).catch(() => {});
    } catch {}
    void doEnableVideo();
  }, [call, doEnableVideo]);

  const declineVideoSwitch = useCallback(() => {
    setIncomingVideoReqFrom(null);
    try {
      void call?.sendCustomEvent({ type: 'video-switch-decline' }).catch(() => {});
    } catch {}
  }, [call]);

  // Feature 3: "Turn off video" hides the OTHER party's video ON THIS SCREEN
  // only. My own outgoing video is unaffected (self-view stays visible). Local
  // toggle — NOT shared — per product spec: A taps → A stops seeing B's video
  // (A's video keeps going out) until A taps again. Nothing is sent to B.
  const toggleCallVideo = useCallback(() => {
    setCallVideoHidden((prev) => !prev);
  }, []);

  // Receive peer signals.
  useEffect(() => {
    if (!call) return;
    const myId = local?.userId;
    const handler = (event: any) => {
      if (event?.user?.id && myId && event.user.id === myId) return; // ignore own echo
      const t = event?.custom?.type;
      if (t === 'video-switch-request') {
        setIncomingVideoReqFrom(event?.user?.name || peerName);
      } else if (t === 'video-switch-accept') {
        setAwaitingVideoAccept(false);
        void doEnableVideo();
      } else if (t === 'video-switch-decline') {
        setAwaitingVideoAccept(false);
        Alert.alert('Video call', `${peerName} declined to switch to video.`);
      }
    };
    let unsub: any;
    try {
      unsub = call.on('custom', handler);
    } catch {}
    return () => {
      try {
        if (typeof unsub === 'function') unsub();
        else call.off?.('custom', handler);
      } catch {}
    };
  }, [call, local?.userId, peerName, doEnableVideo]);


  const popOut = useCallback(() => {
    if (Platform.OS !== 'android') {
      callHost.minimize();
      return;
    }
    try {
      enterPiPAndroid();
    } catch {
      callHost.minimize();
    }
  }, []);

  // ── Add participant (1:1 → conference on Stream SFU) + privacy roster ─────
  const contacts = useQuery(api.contacts.getContacts, {}) as any[] | undefined;
  const getOrCreateDirect = useMutation((api as any).conversations.getOrCreateDirect);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [showRoster, setShowRoster] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [pendingAdd, setPendingAdd] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [roster, setRoster] = useState<CallRosterEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<any>(null);
  const prevRosterRef = useRef<Map<string, string> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // iter-386 (enhancement): proactive WEAK-CONNECTION warning. When the
  // (weaker-of-both) connection quality sits at POOR (1) for >3s while
  // connected, surface a toast so the user knows audio may glitch and it isn't
  // an app bug. Rate-limited to once per 20s and cleared the moment quality
  // recovers, so it never nags on a brief dip. Builds on the connQuality signal
  // already shown by the ConnQualityBars indicator.
  const poorSinceRef = useRef<number | null>(null);
  const lastPoorWarnRef = useRef(0);
  useEffect(() => {
    if (!connected) {
      poorSinceRef.current = null;
      return;
    }
    if (connQuality !== 1) {
      poorSinceRef.current = null;
      return;
    }
    if (poorSinceRef.current == null) poorSinceRef.current = Date.now();
    const t = setTimeout(() => {
      const since = poorSinceRef.current;
      if (since == null) return;
      if (Date.now() - since < 3000) return;
      if (Date.now() - lastPoorWarnRef.current < 20_000) return;
      lastPoorWarnRef.current = Date.now();
      showToast('Weak connection — audio may drop');
    }, 3200);
    return () => clearTimeout(t);
  }, [connected, connQuality, showToast]);

  // Poll the privacy-aware roster while connected so names/masked-numbers stay
  // fresh for everyone (the backend masks hidden numbers per-viewer). We also
  // diff successive snapshots to surface live "joined / left" toasts to EVERY
  // participant (the shared roster is the single source of truth).
  useEffect(() => {
    if (!connected || !room || !myId) return;
    let active = true;
    const load = () => {
      fetchCallParticipants(room, myId).then((list) => {
        if (!active) return;
        setRoster(list);
        const nextMap = new Map(list.map((r) => [r.identity, r.displayName || 'Someone']));
        const prev = prevRosterRef.current;
        if (prev) {
          nextMap.forEach((name, id) => {
            if (id !== myId && !prev.has(id)) showToast(`${name} joined the call`);
          });
          prev.forEach((name, id) => {
            if (id !== myId && !nextMap.has(id)) showToast(`${name} left the call`);
          });
        }
        prevRosterRef.current = nextMap;
      });
    };
    load();
    const iv = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [connected, room, myId, showToast]);

  const inCallIds = useMemo(() => {
    const s = new Set<string>();
    if (myId) s.add(myId);
    (participants || []).forEach((p: any) => p?.userId && s.add(String(p.userId)));
    roster.forEach((r) => r.identity && s.add(r.identity));
    return s;
  }, [myId, participants, roster]);

  const addableContacts = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    return (contacts || [])
      .filter((c) => c?._id && !inCallIds.has(String(c._id)))
      .filter(
        (c) =>
          !q ||
          String(c.name || '').toLowerCase().includes(q) ||
          String(c.phoneNumber || '').includes(q),
      );
  }, [contacts, inCallIds, addSearch]);

  const handleAdd = useCallback(() => {
    if (!room) {
      Alert.alert('Add people', 'The call is still connecting — try again in a moment.');
      return;
    }
    setAddSearch('');
    setPendingAdd(null);
    setShowAddPicker(true);
  }, [room]);

  const confirmAdd = useCallback(
    async (hideNumber: boolean) => {
      const contact = pendingAdd;
      if (!contact?._id || !room || !myId) return;
      setAdding(true);
      try {
        // Resolve a valid direct conversation for the added person so their
        // ring/answer deep-link (/call/<conversationId>) opens a real context.
        let convForAdd = conversationId;
        try {
          const cid = await getOrCreateDirect({ otherUserId: String(contact._id) });
          if (cid) convForAdd = String(cid);
        } catch {
          /* fall back to the current call's conversationId */
        }
        await addStreamParticipant({
          streamRoom: room,
          adderIdentity: myId,
          adderDisplayName: myName,
          adderPhone: myPhone || undefined,
          calleeIdentity: String(contact._id),
          calleeDisplayName: String(contact.name || ''),
          calleePhone: contact.phoneNumber ? String(contact.phoneNumber) : undefined,
          hideNumber,
          isVideo: videoMode,
          conversationId: convForAdd,
        });
        setPendingAdd(null);
        setShowAddPicker(false);
        showToast(`You added ${String(contact.name || 'a contact')}`);
        if (room && myId) fetchCallParticipants(room, myId).then(setRoster);
      } catch (err: any) {
        Alert.alert('Could not add participant', err?.message || 'Please try again.');
      } finally {
        setAdding(false);
      }
    },
    [pendingAdd, room, myId, myName, myPhone, videoMode, conversationId, getOrCreateDirect, showToast],
  );

  const participantCount = (remoteParticipants?.length || 0) + 1; // +1 = me

  // Remove a participant — allowed ONLY for the person who added them (the
  // backend re-checks `added_by` and 403s otherwise; we also gate the UI).
  const handleRemove = useCallback(
    (entry: CallRosterEntry) => {
      if (!room || !myId) return;
      Alert.alert('Remove participant', `Remove ${entry.displayName || 'this person'} from the call?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeStreamParticipant({ streamRoom: room, identity: entry.identity, requesterIdentity: myId });
              showToast(`You removed ${entry.displayName || 'a participant'}`);
              fetchCallParticipants(room, myId).then(setRoster);
            } catch (err: any) {
              Alert.alert('Could not remove', err?.message || 'Please try again.');
            }
          },
        },
      ]);
    },
    [room, myId, showToast],
  );

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

  // iter-385: caller "Reached their phone ✓" — subscribe to the ring-delivery
  // signal recorded by ringWebrtcCall so the caller knows the FCM doorbell
  // actually landed on the callee's device (curbs the frustrated re-dialing
  // that caused overlapping calls). Only meaningful while WE are the caller and
  // the callee hasn't joined yet.
  const [ringDelivered, setRingDelivered] = useState(false);
  useEffect(() => {
    if (!isCaller || !conversationId) return;
    let mounted = true;
    const read = () => {
      const d = getRingDelivery(String(conversationId));
      if (mounted) setRingDelivered(!!(d && d.delivered));
    };
    read();
    const unsub = subscribeRingDelivery(read);
    return () => {
      mounted = false;
      try {
        unsub();
      } catch {}
    };
  }, [isCaller, conversationId]);

  const statusLine = connected
    ? fmt(seconds)
    : isCaller
      ? ringDelivered
        ? 'Ringing • Reached their phone ✓'
        : 'Ringing…'
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
        ) : showVideo && remote && remoteHasVideo ? (
          <ParticipantView
            participant={remote}
            style={StyleSheet.absoluteFill as any}
            ParticipantLabel={null}
            ParticipantVideoFallback={null}
          />
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

      {!inPiP && connected ? (
        <View style={styles.connQualityWrap} pointerEvents="none" testID="conn-quality">
          <ConnQualityBars quality={connQuality} />
        </View>
      ) : null}

      {!inPiP ? (
        hasScreenShare ? (
          <View style={styles.topBar} pointerEvents="none">
            <Text style={styles.topStatus}>
              {hasPublishedScreenShare ? 'You are sharing your screen' : `${peerName} is sharing their screen`}
            </Text>
          </View>
        ) : showVideo && remote && remoteHasVideo ? (
          <View style={styles.topBar} pointerEvents="none">
            <Text style={styles.topName} numberOfLines={1}>
              {peerName}
            </Text>
            <Text style={styles.topStatus}>{statusLine}</Text>
          </View>
        ) : null
      ) : null}

      {!inPiP && videoMode && camOn && local ? (
        <Animated.View
          style={[styles.selfView, { transform: selfPan.getTranslateTransform() }]}
          {...selfPanResponder.panHandlers}
        >
          <ParticipantView participant={local} style={StyleSheet.absoluteFill as any} />
        </Animated.View>
      ) : null}

      {!inPiP ? (
        <SafeAreaView edges={['bottom']} style={styles.controlsWrap}>
          <View style={styles.controlsGrid}>
            <ControlBtn
              testID="stream-mute"
              onPress={toggleMic}
              backgroundColor={micOn ? CTRL_BG : CTRL_BG_ON}
              icon={<Ionicons name={micOn ? 'mic' : 'mic-off'} size={24} color={Colors.white} />}
              label={micOn ? 'Mute' : 'Unmute'}
            />
            <ControlBtn
              testID="stream-nc-toggle"
              onPress={toggleNc}
              backgroundColor={ncEnabled ? CTRL_BG_ON : CTRL_BG}
              icon={<Ionicons name="pulse" size={24} color={Colors.white} />}
              label="Noise"
            />
            <ControlBtn
              testID="stream-audio-route"
              onPress={() => setAudioMenuVisible(true)}
              backgroundColor={audioRoute !== 'earpiece' ? CTRL_BG_ON : CTRL_BG}
              icon={
                <Ionicons
                  name={
                    audioRoute === 'speaker'
                      ? 'volume-high'
                      : audioRoute === 'bluetooth'
                        ? 'bluetooth'
                        : 'phone-portrait-outline'
                  }
                  size={22}
                  color={Colors.white}
                />
              }
              label="Audio"
            />
            {toggleScreenShare ? (
              <ControlBtn
                testID="stream-screenshare-toggle"
                onPress={toggleScreenShare}
                backgroundColor={hasPublishedScreenShare ? CTRL_BG_ON : CTRL_BG}
                icon={
                  <Ionicons
                    name={hasPublishedScreenShare ? 'stop-circle-outline' : 'tv-outline'}
                    size={22}
                    color={Colors.white}
                  />
                }
                label="Screen"
              />
            ) : null}
            <ControlBtn
              testID="stream-add"
              onPress={handleAdd}
              backgroundColor={CTRL_BG}
              icon={<Ionicons name="person-add-outline" size={22} color={Colors.white} />}
              label="Add"
            />
            {videoMode ? (
              <>
                <ControlBtn
                  testID="stream-cam"
                  onPress={toggleCam}
                  backgroundColor={camOn ? CTRL_BG : CTRL_BG_ON}
                  icon={<Ionicons name={camOn ? 'videocam' : 'videocam-off'} size={24} color={Colors.white} />}
                  label={camOn ? 'Camera' : 'Cam off'}
                />
                <ControlBtn
                  testID="stream-flip"
                  onPress={flipCam}
                  backgroundColor={CTRL_BG}
                  icon={<Ionicons name="camera-reverse-outline" size={24} color={Colors.white} />}
                  label="Flip"
                />
              </>
            ) : (
              <ControlBtn
                testID="stream-switch-video"
                onPress={switchToVideo}
                backgroundColor={CTRL_BG}
                icon={<Ionicons name="videocam-outline" size={24} color={Colors.white} />}
                label="Video"
              />
            )}
            <ControlBtn
              testID="stream-minimize"
              onPress={() => callHost.minimize()}
              backgroundColor={CTRL_BG}
              icon={<Ionicons name="contract-outline" size={22} color={Colors.white} />}
              label="Minimize"
            />
            <ControlBtn
              testID="stream-popout"
              onPress={popOut}
              backgroundColor={CTRL_BG}
              icon={<Ionicons name="tablet-landscape-outline" size={22} color={Colors.white} />}
              label="Pop out"
            />
          </View>
          <TouchableOpacity style={styles.endBtn} onPress={onHangup} testID="stream-end">
            <Ionicons
              name="call"
              size={28}
              color={Colors.white}
              style={{ transform: [{ rotate: '135deg' }] }}
            />
          </TouchableOpacity>
        </SafeAreaView>
      ) : null}

      {/* Feature 3: shared hide/show-video pill (only meaningful when real video is present) */}
      {!inPiP && (remoteHasVideo || (videoMode && camOn)) ? (
        <TouchableOpacity style={styles.videoPill} onPress={toggleCallVideo} testID="stream-hide-video">
          <Ionicons name={callVideoHidden ? 'eye-off' : 'eye'} size={16} color={Colors.white} />
          <Text style={styles.videoPillText}>{callVideoHidden ? 'Video off' : 'Turn off video'}</Text>
        </TouchableOpacity>
      ) : null}

      {/* 2b: peer requested to switch to video — needs my consent */}
      {!inPiP && incomingVideoReqFrom ? (
        <View style={styles.waitingWrap} pointerEvents="box-none" testID="stream-video-request">
          <View style={styles.waitingCard}>
            <View style={styles.waitingHeader}>
              <Ionicons name="videocam" size={18} color={Colors.white} />
              <View style={{ flex: 1 }}>
                <Text style={styles.waitingLabel}>Switch to video?</Text>
                <Text style={styles.waitingName} numberOfLines={1}>
                  {incomingVideoReqFrom} wants to turn on video
                </Text>
              </View>
            </View>
            <View style={styles.waitingActions}>
              <TouchableOpacity style={[styles.waitingBtn, styles.waitingDecline]} onPress={declineVideoSwitch}>
                <Text style={styles.waitingBtnText}>Decline</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.waitingBtn, styles.waitingAccept]} onPress={acceptVideoSwitch}>
                <Text style={styles.waitingBtnText}>Accept</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : awaitingVideoAccept ? (
        <View style={styles.videoWaitBanner} pointerEvents="none" testID="stream-video-waiting">
          <ActivityIndicator color={Colors.white} />
          <Text style={styles.videoWaitText}>Waiting for {peerName} to accept video…</Text>
        </View>
      ) : null}

      {audioMenuVisible ? (
        <View style={styles.audioMenuOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill as any}
            activeOpacity={1}
            onPress={() => setAudioMenuVisible(false)}
          />
          <View style={styles.audioMenuAnchor}>
            <AudioOutputMenu value={audioRoute} onSelect={applyAudioRoute} />
          </View>
        </View>
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

      {/* Live roster-change toast (joined / left / added / removed). */}
      {toast && !inPiP && !isMini ? (
        <View style={styles.callToast} pointerEvents="none">
          <Ionicons name="people" size={14} color={Colors.white} />
          <Text style={styles.callToastText} numberOfLines={1}>{toast}</Text>
        </View>
      ) : null}

      {/* Participants pill — tap to open the privacy-aware roster. */}
      {!inPiP && !isMini ? (
        <TouchableOpacity
          style={styles.participantsPill}
          onPress={() => setShowRoster(true)}
          testID="stream-participants-pill"
          hitSlop={8}
        >
          <Ionicons name="people" size={14} color={Colors.white} />
          <Text style={styles.participantsPillText}>
            {participantCount} {participantCount === 1 ? 'person' : 'people'}
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* Add participant: contact picker → hide/show-number privacy step. */}
      <Modal
        visible={showAddPicker}
        transparent
        animationType="slide"
        onRequestClose={() => (adding ? undefined : setShowAddPicker(false))}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{pendingAdd ? 'Share number?' : 'Add to call'}</Text>
              <Pressable onPress={() => (adding ? undefined : setShowAddPicker(false))} hitSlop={8}>
                <Ionicons name="close" size={22} color={Colors.white} />
              </Pressable>
            </View>

            {pendingAdd ? (
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
                  <Ionicons name="eye-off" size={20} color={Colors.white} />
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
                  <Ionicons name="eye" size={20} color={Colors.white} />
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
                <View style={styles.searchRow}>
                  <Ionicons name="search" size={16} color="#888" />
                  <TextInput
                    style={styles.searchInput}
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
                      {contacts === undefined ? 'Loading contacts…' : 'No contacts to add'}
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
                      <View style={styles.addRowTextWrap}>
                        <Text style={styles.addRowName} numberOfLines={1}>{item.name || 'Contact'}</Text>
                        {item.phoneNumber ? (
                          <Text style={styles.addRowPhone} numberOfLines={1}>{item.phoneNumber}</Text>
                        ) : null}
                      </View>
                      <Ionicons name="add-circle" size={22} color={Colors.primary} />
                    </Pressable>
                  )}
                />
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Privacy-aware roster of everyone in the call. */}
      <Modal
        visible={showRoster}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRoster(false)}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>In this call ({participantCount})</Text>
              <Pressable onPress={() => setShowRoster(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color={Colors.white} />
              </Pressable>
            </View>
            <View style={styles.rosterList}>
              <RosterRow name={`${myName || 'You'} (you)`} phone={null} />
              {roster
                .filter((r) => r.identity && r.identity !== myId)
                .map((r) => (
                  <RosterRow
                    key={r.identity}
                    name={r.displayName || 'Smilers user'}
                    phone={r.phoneNumber}
                    hidden={r.hideNumber}
                    onRemove={r.addedBy && myId && r.addedBy === myId ? () => handleRemove(r) : undefined}
                  />
                ))}
            </View>
            <Pressable
              style={styles.rosterAddBtn}
              onPress={() => {
                setShowRoster(false);
                handleAdd();
              }}
            >
              <Ionicons name="person-add" size={18} color={Colors.white} />
              <Text style={styles.rosterAddText}>Add participant</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

    </View>
  );
}

function RosterRow({
  name,
  phone,
  hidden,
  onRemove,
}: {
  name: string;
  phone: string | null;
  hidden?: boolean;
  onRemove?: () => void;
}) {
  return (
    <View style={styles.rosterRow}>
      <View style={[styles.addRowAvatar, styles.addRowAvatarFallback]}>
        <Text style={styles.addRowAvatarText}>{name.trim().charAt(0).toUpperCase()}</Text>
      </View>
      <View style={styles.addRowTextWrap}>
        <Text style={styles.addRowName} numberOfLines={1}>{name}</Text>
        {phone ? (
          <Text style={styles.addRowPhone} numberOfLines={1}>{phone}</Text>
        ) : hidden ? (
          <Text style={styles.rosterHidden}>Number hidden</Text>
        ) : null}
      </View>
      {onRemove ? (
        <TouchableOpacity style={styles.rosterRemoveBtn} onPress={onRemove} hitSlop={8}>
          <Ionicons name="remove-circle" size={24} color="#ff5a5f" />
        </TouchableOpacity>
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
  // When this device was ADDED into an existing Stream call, the ring/answer
  // deep-link carries the shared room id. We then join THAT room directly
  // (there is no Convex ring record for the adder↔me conversation).
  const streamRoomParam = params?.streamRoom || '';

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
  const liveCallIdRef = useRef<string | null>(null);

  const callerId = activeCall?.callerId || activeCall?.callerUserId || null;
  const isCaller = !!(me && callerId && callerId === me._id);
  const convStatus: string | undefined = activeCall?.status;
  const callId: string | undefined = activeCall?._id;
  // Unique-per-call Stream room id (NOT the conversationId) so every call is a
  // fresh room with no lingering "ghost" participants from a previous call.
  // PINNED once known: the Convex ring record has a ~60s TTL and disappears
  // after it's answered/expires; without pinning, `callId` would flip to
  // undefined mid-call and tear down the (live) Stream session — this was the
  // real cause of calls dropping ~1 minute in. Reset when the conversation
  // changes (e.g. accepting a call-waiting call).
  const [pinnedRoom, setPinnedRoom] = useState<string | null>(null);
  useEffect(() => {
    setPinnedRoom(null);
    liveCallIdRef.current = null;
  }, [conversationId]);
  useEffect(() => {
    const rid = callId || createdCallId;
    if (rid && !pinnedRoom) setPinnedRoom(String(rid));
  }, [callId, createdCallId, pinnedRoom]);
  useEffect(() => {
    if (callId) liveCallIdRef.current = String(callId);
  }, [callId]);
  const streamCallId: string | undefined = streamRoomParam || pinnedRoom || callId || createdCallId || undefined;

  // Role resolution. The foreground listener routes an in-app incoming call to
  // /call/<id> WITHOUT answer=1, so we must show Accept/Decline here (the old
  // screen did). A call answered from the notification arrives WITH answer=1
  // (already accepted). The caller is whoever initiated / owns the record.
  const iAmCaller = isCaller || didInitiate;
  const accepted = iAmCaller || isAnswering || locallyAccepted;

  // #3: on the CALLEE side, the "peer" is the caller — show the name THIS user
  // saved for them in their device address book (not the caller's Google/account
  // display name). The caller side already gets the right name from the launch
  // param (resolved at dial time), so only resolve here when we're the callee.
  const contactIndex = useDeviceContactIndex();
  const peerUserForName = useQuery(
    (api as any).users.getUserById,
    !iAmCaller && callerId ? ({ userId: callerId } as any) : 'skip',
  ) as any;
  const resolvedPeerName = useMemo(() => {
    if (!iAmCaller) {
      const fromContacts = resolveDeviceContactNameFromUser(
        contactIndex,
        peerUserForName || (activeCall as any)?.caller,
      );
      if (fromContacts) return fromContacts;
    }
    return displayName;
  }, [iAmCaller, peerUserForName, activeCall, contactIndex, displayName]);


  // Connect-latency telemetry: T0 = the moment the call is accepted/initiated.
  const [acceptedAt, setAcceptedAt] = useState<number | null>(null);
  const acceptedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (accepted && acceptedAtRef.current == null) {
      acceptedAtRef.current = Date.now();
      setAcceptedAt(acceptedAtRef.current);
    }
  }, [accepted]);
  const activeCallReady = !activeCallLoading && !!activeCall;
  const isIncomingPending =
    activeCallReady && !iAmCaller && !isAnswering && !locallyAccepted && convStatus === 'ringing';

  // #7: play the callee's selected ringtone (+ vibrate) while the in-app
  // incoming-call UI is showing — the FOREGROUND ring the Stream screen was
  // missing (the callee saw Accept/Decline but heard nothing).
  useRingtonePlayer(isIncomingPending, { vibrate: isIncomingPending });

  // #5 FIX (caller hears no ringing): the old WebRTC screen played the bundled
  // Smilers ringback tone to the CALLER while waiting for the callee to answer;
  // the Stream screen never wired it, so the caller only *saw* "ringing" with
  // silence. `InCallAudio.startRingback()` plays on Android's VOICE-CALL stream
  // (survives the in-call audio session). Play it while our outgoing call is
  // still ringing and stop the moment we connect / the call ends.
  const isOutgoingRinging =
    activeCallReady && iAmCaller && !accepted && convStatus === 'ringing';
  useEffect(() => {
    if (!isOutgoingRinging) return;
    InCallAudio.startRingback?.();
    return () => {
      InCallAudio.stopRingback?.();
    };
  }, [isOutgoingRinging]);

  // #3: the caller hung up WHILE it was still ringing → the Convex record flips
  // to ended/declined (or disappears). Close the callee's incoming UI instead
  // of letting them tap Accept and connect into a dead room. Only before we've
  // accepted/connected (once connected, CallUI owns teardown).
  useEffect(() => {
    if (accepted) return;
    if (!sawCallRef.current) return; // never saw a call yet — nothing to end
    const ended =
      convStatus === 'ended' ||
      convStatus === 'declined' ||
      convStatus === 'missed' ||
      convStatus === 'cancelled';
    if (ended && !endedRef.current) {
      endedRef.current = true;
      callHost.end();
    }
  }, [accepted, convStatus]);

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

  // Latency: begin creating (or reusing) the singleton Stream client the
  // instant the screen mounts — in PARALLEL with the Convex ring round-trip
  // that resolves `streamCallId`. Without this, join() couldn't even start
  // until AFTER the client was created post-accept, adding its cost to the
  // critical path. The promise is cached so the join effect awaits the same
  // in-flight client instead of kicking off a second create.
  const clientWarmupRef = useRef<Promise<any> | null>(null);
  useEffect(() => {
    if (!clientWarmupRef.current) {
      clientWarmupRef.current = createStreamVideoClient().catch(() => null);
    }
  }, []);

  // 4) Join the Stream call (media) — only once ACCEPTED (caller, notification
  //    answer, or in-app Accept) AND we have the unique per-call room id.
  //    ring:false → no Stream push (Ashwini's doorbell owns ringing).
  useEffect(() => {
    if (!streamCallId || !accepted) return;
    let mounted = true;
    let joined: any = null;
    (async () => {
      try {
        const t0 = acceptedAtRef.current || Date.now();
        // Reuse the mount-time warmup so the client WS is already connecting.
        const c = await (clientWarmupRef.current || createStreamVideoClient());
        if (!c || !mounted) return;
        setClient(c);
        recordDiagnostic({
          tag: 'CALL',
          source: 'streamTiming',
          message: `client-ready t+${Date.now() - t0}ms callId=${streamCallId}`,
        });

        // Attempt a join with a watchdog. Stream retries join up to 3× with
        // exponential backoff internally (≈35–60s of dead air on a flaky edge),
        // and the End button feels frozen during it. We cap the SDK retries and
        // race each attempt against a 14s watchdog, then retry ONCE with a fresh
        // call object (a new attempt often lands on a healthy SFU edge instantly).
        const joinOnce = async (attempt: number): Promise<any> => {
          if (endedRef.current || !mounted) return null;
          const streamCall = c.call('default', streamCallId);
          // Pre-set device state BEFORE joining so a VOICE call never turns the
          // camera on (Stream's default 'default' call type publishes video on
          // join otherwise → New #2: "voice call shows my own video").
          try {
            await streamCall.microphone.enable();
            if (isVideo) await streamCall.camera.enable();
            else await streamCall.camera.disable();
          } catch {}
          const tJoin = Date.now();
          const timeout = new Promise((_r, rej) =>
            setTimeout(() => rej(new Error('join-watchdog-timeout')), 14000),
          );
          await Promise.race([
            streamCall.join({ create: true, ring: false, notify: false, maxJoinRetries: 1 }),
            timeout,
          ]);
          recordDiagnostic({
            tag: 'CALL',
            source: 'streamTiming',
            message: `join-done t+${Date.now() - t0}ms (join=${Date.now() - tJoin}ms attempt=${attempt}) callId=${streamCallId}`,
          });
          return streamCall;
        };

        let streamCall: any = null;
        try {
          streamCall = await joinOnce(1);
        } catch (firstErr: any) {
          recordDiagnostic({
            tag: 'CALL',
            source: 'streamTiming',
            message: `join-retry after=${firstErr?.message || firstErr} callId=${streamCallId}`,
          });
          if (mounted && !endedRef.current) streamCall = await joinOnce(2);
        }
        if (!streamCall || !mounted) {
          try {
            streamCall?.leave();
          } catch {}
          return;
        }
        joined = streamCall;
        setCall(streamCall);
      } catch (e: any) {
        recordDiagnostic({
          tag: 'CALL',
          source: 'streamTiming',
          message: `join-fail callId=${streamCallId} err=${e?.message || e}`,
        });
        /* both attempts failed — screen shows Connecting…; user can hang up */
      }
    })();
    return () => {
      mounted = false;
      try {
        joined?.leave();
      } catch {}
    };
  }, [streamCallId, accepted, isVideo]);

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
    const cid = liveCallIdRef.current || callId;
    if (cid) void endCall({ callId: String(cid) }).catch(() => {});
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
          {resolvedPeerName}
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
          {resolvedPeerName}
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
            peerName={resolvedPeerName}
            convStatus={convStatus}
            callId={callId ? String(callId) : streamCallId ? String(streamCallId) : null}
            onHangup={hangup}
            acceptedAt={acceptedAt}
            room={streamCallId ? String(streamCallId) : null}
            myId={me?._id ? String(me._id) : null}
            myName={String(me?.name || me?.displayName || 'You')}
            myPhone={String(me?.phoneE164 || me?.phone || '')}
            conversationId={conversationId}
          />
          {waitingBanner}
        </NoiseCancellationProvider>
      </StreamCall>
    </StreamVideo>
  );
}

// In-call connection-quality indicator (WhatsApp-style signal bars). Maps
// Stream's per-participant ConnectionQuality (1 poor / 2 good / 3 excellent)
// to 3 bars + colour. Renders nothing useful until a rating exists.
function ConnQualityBars({ quality }: { quality: number }) {
  const level = quality >= 3 ? 3 : quality === 2 ? 2 : quality === 1 ? 1 : 0;
  const color = level >= 3 ? '#34D399' : level === 2 ? '#FBBF24' : level === 1 ? '#F87171' : 'rgba(255,255,255,0.35)';
  const label = level >= 3 ? 'Excellent' : level === 2 ? 'Good' : level === 1 ? 'Poor' : '';
  const heights = [7, 11, 15];
  return (
    <View style={styles.connBarsRow}>
      {heights.map((h, i) => (
        <View
          key={i}
          style={[
            styles.connBar,
            { height: h, backgroundColor: i < level ? color : 'rgba(255,255,255,0.22)' },
          ]}
        />
      ))}
      {label ? <Text style={[styles.connLabel, { color }]}>{label}</Text> : null}
    </View>
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
  connQualityWrap: {
    position: 'absolute',
    top: 54,
    left: 16,
    zIndex: 56,
    elevation: 15,
  },
  connBarsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 10,
  },
  connBar: {
    width: 4,
    borderRadius: 2,
  },
  connLabel: {
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 6,
    alignSelf: 'center',
  },
  selfView: {
    position: 'absolute',
    top: 60,
    right: 16,
    width: 110,
    height: 160,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    zIndex: 55,
    elevation: 14,
  },
  controlsWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: 10 },
  controlsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: 14,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  endBtn: {
    alignSelf: 'center',
    marginTop: 14,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioMenuOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 60,
  },
  audioMenuAnchor: {
    width: '82%',
    maxWidth: 360,
  },
  videoPill: {
    position: 'absolute',
    top: 156,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    zIndex: 40,
  },
  videoPillText: { color: Colors.white, fontSize: 13, fontWeight: '600' },
  videoWaitBanner: {
    position: 'absolute',
    top: 54,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(20,20,20,0.92)',
    paddingVertical: 12,
    borderRadius: 14,
    zIndex: 50,
  },
  videoWaitText: { color: Colors.white, fontSize: 14, fontWeight: '600' },
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

  // ── Add participant / roster ──────────────────────────────────────────────
  participantsPill: {
    position: 'absolute',
    top: 54,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    zIndex: 45,
  },
  participantsPillText: { color: Colors.white, fontSize: 12, fontWeight: '600' },
  callToast: {
    position: 'absolute',
    top: 92,
    alignSelf: 'center',
    maxWidth: '86%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.72)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    zIndex: 60,
  },
  callToastText: { color: Colors.white, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
    maxHeight: '78%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sheetTitle: { color: Colors.white, fontSize: 18, fontWeight: '700' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 8,
  },
  searchInput: { flex: 1, color: Colors.white, fontSize: 15, padding: 0 },
  addList: { maxHeight: 360 },
  addEmpty: { color: '#888', textAlign: 'center', paddingVertical: 28, fontSize: 14 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  addRowAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#333' },
  addRowAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  addRowAvatarText: { color: Colors.white, fontSize: 18, fontWeight: '700' },
  addRowTextWrap: { flex: 1 },
  addRowName: { color: Colors.white, fontSize: 16, fontWeight: '500' },
  addRowPhone: { color: '#9a9a9a', fontSize: 13, marginTop: 1 },
  privacyStep: { alignItems: 'center', paddingTop: 8, paddingBottom: 6, gap: 8 },
  privacyAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyAvatarText: { color: Colors.white, fontSize: 26, fontWeight: '700' },
  privacyName: { color: Colors.white, fontSize: 18, fontWeight: '700' },
  privacyMsg: { color: '#b5b5b5', fontSize: 14, textAlign: 'center', paddingHorizontal: 16, marginBottom: 6 },
  privacyChoice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    width: '100%',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  privacyHide: { backgroundColor: 'rgba(255,255,255,0.10)' },
  privacyShow: { backgroundColor: 'rgba(255,255,255,0.06)' },
  privacyChoiceText: { flex: 1 },
  privacyChoiceTitle: { color: Colors.white, fontSize: 16, fontWeight: '600' },
  privacyChoiceSub: { color: '#9a9a9a', fontSize: 12, marginTop: 1 },
  privacyBack: { paddingVertical: 12 },
  privacyBackText: { color: Colors.primary, fontSize: 15, fontWeight: '600' },
  rosterList: { gap: 4 },
  rosterRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  rosterHidden: { color: '#777', fontSize: 13, fontStyle: 'italic', marginTop: 1 },
  rosterRemoveBtn: { padding: 4 },
  rosterAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 14,
  },
  rosterAddText: { color: Colors.white, fontSize: 16, fontWeight: '700' },
});
