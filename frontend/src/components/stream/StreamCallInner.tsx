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
import { ActivityIndicator, Alert, Animated, AppState, Dimensions, FlatList, Image, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
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
import { getAddRequest, subscribeAddRequest, clearAddRequest, type PendingAddRequest } from '../../lib/call/callAddRequestStore';
import { ControlBtn, AudioOutputMenu } from '../call/CallScreenComponents';
import { useRingtonePlayer } from '../../lib/ringtone/useRingtonePlayer';
import { useRingbackPlayer } from '../../lib/ringtone/useRingbackPlayer';
import { addStreamParticipant, fetchCallParticipants, removeStreamParticipant, groupCallAgain, reportParticipantStatus, requestAddParticipant, declineAddRequest, adminKickParticipant, resetCallRoster, type CallRosterEntry } from '../../lib/twilio/twilioApi';
import type { AudioOutputRoute } from '../call/callTypes';
import * as Haptics from 'expo-haptics';
import { Colors } from '../../theme';
import { recordDiagnostic } from '../../lib/diagnostics';
import { setActiveCall } from '../../lib/call/activeCallRegistry';
import CallBackground from '../CallBackground';

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
  /** Group-call orchestration (Phase 2). */
  isGroupCall: boolean;
  isGroupAdmin: boolean;
  adminIdentities: string[];
  conversationName: string;
  /** Reports Stream media-connected state up so the caller's ringback can stop
   * the instant the callee actually joins (not merely when the ring record
   * changes). */
  onConnectedChange?: (connected: boolean) => void;
  /** Fired the instant this side detects the call is ending (remote left or
   *  Convex flipped to ended) — used to play the "Ciao" end-tone immediately,
   *  while the audio session is still active, on the side that did NOT tap End. */
  onEnding?: () => void;
  /** True when THIS device joined an already-live call via the add-participant
   * deep-link (carries a streamRoom param). Late joiners can hit a publish race
   * where the pre-join mic.enable() never lands the audio track on the SFU, so
   * others can't hear them — we force one fresh publish after connecting. */
  isAddedParticipant: boolean;
};

// Visual mapping for group-call member DERIVED statuses shown in the live
// waiting strip + roster (mirrors the WebRTC group-call invite strip).
//   joined  → connected now
//   ringing → still being rung (pending, within the ring window)
//   missed  → rang but no answer (ring timed out / declined)
//   left    → was in the call and has left
type DerivedRosterStatus = 'joined' | 'ringing' | 'missed' | 'left';

const GROUP_STATUS_META: Record<DerivedRosterStatus, { label: string; color: string }> = {
  joined: { label: 'Joined', color: '#34C759' },
  ringing: { label: 'Ringing…', color: '#E4B53B' },
  missed: { label: 'Missed', color: '#FF3B30' },
  left: { label: 'Left', color: '#8E8E93' },
};

// A 'pending' entry becomes "Missed" once this long passes with no answer
// (the ring auto-times-out at ~35s; the grace avoids a premature flip).
const MISSED_AFTER_MS = 40000;

function deriveRosterStatus(r: CallRosterEntry, nowMs: number): DerivedRosterStatus {
  if (r.status === 'joined') return 'joined';
  if (r.status === 'left') return 'left';
  if (r.status === 'declined' || r.status === 'missed') return 'missed';
  // 'pending' → still ringing unless the ring window has elapsed unanswered.
  const rang = r.rangAt ? Date.parse(r.rangAt) : 0;
  if (rang && nowMs - rang > MISSED_AFTER_MS) return 'missed';
  return 'ringing';
}

// Whether the "Dial again" affordance should be visible to THIS viewer for a
// missed/left participant. Rule: if the person was added with the number
// SHOWN, everyone in the call may re-dial them; if added with the number
// HIDDEN, only the person who added them may re-dial.
function canRedialEntry(r: CallRosterEntry, myId: string | null): boolean {
  if (!r.hideNumber) return true;
  return !!(myId && r.addedBy && r.addedBy === myId);
}

/** True when a Stream participant's microphone is muted (no published audio
 *  track). Stream SFU track types: AUDIO=1, VIDEO=2 — we already key video off
 *  publishedTracks.includes(2), so audio is 1. */
function isParticipantMuted(p: any): boolean {
  const tracks = p?.publishedTracks;
  if (Array.isArray(tracks)) return !tracks.includes(1);
  return !p?.audioStream; // fallback: no audio stream object → treat as muted
}

const GRID_PER_PAGE = 9; // max tiles a single page holds before paginating.

/** Paginated, swipeable multi-party tile grid. Fits as many participants as a
 *  page comfortably holds (auto columns/rows), then spills onto extra pages you
 *  swipe left/right through — with page dots. Each tile shows the name, a
 *  mute icon and an active-speaker highlight. */
function ParticipantGridPager({ participants, width }: { participants: any[]; width: number }) {
  const pages = useMemo(() => {
    const out: any[][] = [];
    for (let i = 0; i < participants.length; i += GRID_PER_PAGE) out.push(participants.slice(i, i + GRID_PER_PAGE));
    return out;
  }, [participants]);
  const [page, setPage] = useState(0);

  return (
    <View style={StyleSheet.absoluteFill as any}>
      <FlatList
        data={pages}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, i) => `gridpage-${i}`}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width)))}
        renderItem={({ item }) => {
          const n = item.length;
          const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
          const rows = Math.ceil(n / cols);
          const tW = `${100 / cols}%`;
          const tH = `${100 / rows}%`;
          return (
            <View style={{ width, height: '100%', flexDirection: 'row', flexWrap: 'wrap' }}>
              {item.map((p: any) => {
                const pName = String(p?.name || p?.userId || 'Member');
                const pMuted = isParticipantMuted(p);
                const pSpeaking = !!p?.isSpeaking && !pMuted;
                return (
                  <View
                    key={p.sessionId || p.userId}
                    style={[styles.gridTile, { width: tW as any, height: tH as any }]}
                  >
                    <View style={[styles.gridTileInner, pSpeaking ? styles.gridTileSpeaking : null]}>
                      <ParticipantView
                        participant={p}
                        style={StyleSheet.absoluteFill as any}
                        ParticipantLabel={null}
                        ParticipantVideoFallback={() => (
                          <View style={styles.gridFallback}>
                            <View style={[styles.gridAvatar, pSpeaking ? styles.gridAvatarSpeaking : null]}>
                              <Text style={styles.gridAvatarText}>{pName.trim().charAt(0).toUpperCase()}</Text>
                            </View>
                          </View>
                        )}
                        videoZOrder={0}
                      />
                      <View style={styles.gridNameBadge} pointerEvents="none">
                        {pMuted ? <Ionicons name="mic-off" size={12} color="#FF6B6B" style={{ marginRight: 4 }} /> : null}
                        <Text style={styles.gridNameText} numberOfLines={1}>{pName}</Text>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          );
        }}
      />
      {pages.length > 1 ? (
        <View style={styles.pagerDots} pointerEvents="none">
          {pages.map((_, i) => (
            <View key={`dot-${i}`} style={[styles.pagerDot, i === page ? styles.pagerDotActive : null]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** In-call UI (inside StreamCall context). */
function CallUI({ isVideo, isCaller, peerName, convStatus, callId, onHangup, acceptedAt, room, myId, myName, myPhone, conversationId, isGroupCall, isGroupAdmin, adminIdentities, conversationName, onConnectedChange, onEnding, isAddedParticipant }: CallUIProps) {
  const call = useCall();
  const { mode } = useCallHost();
  const isMini = mode === 'mini';
  const { useCallCallingState, useRemoteParticipants, useLocalParticipant, useParticipants, useHasOngoingScreenShare, useCameraState } =
    useCallStateHooks();
  const callingState = useCallCallingState();
  // Live camera status ('enabled' | 'disabled' | ...) so we never issue a
  // REDUNDANT camera.enable() while the camera is already on / mid-acquire.
  // Redundant enables were tearing the Camera2 session down and re-running
  // getUserMedia, which flickered the self-view and could drop our publish to
  // the SFU (so the remote saw no video). See ensureCameraOn() below.
  const camState = useCameraState() as any;
  const cameraStatus = camState?.status as string | undefined;
  // Preferred camera direction ('front' | 'back'). Front camera video is
  // mirrored (selfie-style) — the rear camera is NOT — matching the legacy
  // WebRTC self-view and standard call UX.
  const cameraDirection = camState?.direction as string | undefined;
  const selfMirror = cameraDirection !== 'back';
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
  const playedConnectedToneRef = useRef(false);

  // ── Guarded camera enable (fixes self-view flicker + dropped remote video) ──
  // Multiple effects (connect re-assert, AppState resume, isVideo init) each
  // used to call `call.camera.enable()`. Fired back-to-back — or again on every
  // Stream reconnect — these piled up and forced the camera to fully re-acquire
  // (Camera2 disconnect → new getUserMedia), which is exactly the self-view
  // flicker seen in device logs and can drop the outgoing publish so the peer
  // sees no video. `ensureCameraOn` makes the enable IDEMPOTENT: it no-ops when
  // the camera is already enabled and coalesces rapid repeat calls (min gap).
  const cameraStatusRef = useRef<string | undefined>(cameraStatus);
  cameraStatusRef.current = cameraStatus;
  const lastCamEnableRef = useRef(0);
  const ensureCameraOn = useCallback(() => {
    if (!call) return;
    if (cameraStatusRef.current === 'enabled') return; // already on — don't churn
    const now = Date.now();
    if (now - lastCamEnableRef.current < 1200) return; // coalesce rapid repeats
    lastCamEnableRef.current = now;
    call.camera.enable().catch(() => {});
  }, [call]);

  // #5: draggable self-view (local camera preview). Anchored top-right by
  // styles.selfView; we apply a translate on top so the user can move it
  // anywhere and it snaps to stay on-screen.
  const SELF_W = 110;
  const SELF_H = 160;
  const { width: winW, height: winH } = Dimensions.get('window');
  const selfPan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  // Double-tap the self-view tile to flip the camera (front ⇄ rear). Kept in a
  // ref so the pan responder (created once) always calls the latest flipCam.
  const flipCamRef = useRef<() => void>(() => {});
  const lastSelfTapRef = useRef(0);
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
        onPanResponderRelease: (_e, g) => {
          selfPan.flattenOffset();
          // A near-stationary release is a TAP, not a drag → detect a double-tap
          // (two taps within 300ms) and flip the camera.
          const wasTap = Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6;
          if (wasTap) {
            const now = Date.now();
            if (now - lastSelfTapRef.current < 300) {
              lastSelfTapRef.current = 0;
              try {
                flipCamRef.current?.();
              } catch {}
            } else {
              lastSelfTapRef.current = now;
            }
          }
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
  // Report media-connected up to the parent so the caller's ringback stops the
  // instant the callee truly joins (see ringback gate in StreamCallInner).
  useEffect(() => {
    onConnectedChange?.(connected);
  }, [connected, onConnectedChange]);
  const remoteHasVideo = !!(remote && ((remote as any).videoStream || (remote as any).publishedTracks?.includes?.(2)));
  const showVideo = (videoMode || remoteHasVideo) && !callVideoHidden;
  // Remote mic / active-speaker state for the 1:1 (single-remote) layout so
  // the user can see when the other person mutes themselves or is talking.
  const remoteMuted = !!remote && isParticipantMuted(remote);
  const remoteSpeaking = !!(remote as any)?.isSpeaking && !remoteMuted;
  const isMultiParty = remoteParticipants.length > 1;

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
    ensureCameraOn();
    // One delayed re-assert in case the camera was released during the SFU
    // renegotiation right after join. ensureCameraOn() no-ops if already on.
    const t = setTimeout(() => {
      if (!cancelled) ensureCameraOn();
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [call, connected, videoMode, camOn, ensureCameraOn]);

  useEffect(() => {
    if (!call) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && videoMode && camOn) {
        // Camera was likely released while backgrounded — re-acquire it so the
        // self-view (and our outgoing video) don't stay black on return.
        setTimeout(() => ensureCameraOn(), 300);
      }
    });
    return () => sub.remove();
  }, [call, videoMode, camOn, ensureCameraOn]);

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
        if (isVideo) ensureCameraOn();
        else await call.camera.disable();
      } catch {}
    })();
  }, [call, isVideo, ensureCameraOn]);

  // Self-heal a STUCK mic publish: symptom is "others can't hear the person who
  // answered (esp. from the call notification)". If I intend mic ON and I'm
  // connected, but my own local audio track isn't actually published a couple
  // seconds after connecting, force a fresh publish (disable→enable). Gated on
  // the actual publish state so it NEVER churns a healthy call, and capped at 2
  // attempts so it can't loop.
  const micHealRef = useRef(0);
  useEffect(() => {
    if (!call || !connected || !micOn) return;
    const t = setTimeout(async () => {
      try {
        if (isParticipantMuted(local) && micHealRef.current < 2) {
          micHealRef.current += 1;
          await call.microphone.disable();
          await call.microphone.enable();
        }
      } catch {}
    }, 2500);
    return () => clearTimeout(t);
  }, [call, connected, micOn, local]);

  // ── FIX (added participants can't be heard) ────────────────────────────────
  // When this device was ADDED into an already-live call, the pre-join
  // `microphone.enable()` frequently races the SFU join negotiation: the local
  // SDK marks the mic "unmuted" (publishedTracks reports audio) yet the audio
  // track never actually lands on the SFU, so the ORIGINAL participants never
  // hear the new person. The conditional self-heal above then no-ops because it
  // trusts the (wrong) local publish state. So for late joiners we FORCE exactly
  // one fresh publish (disable → short gap → enable) a moment after connecting,
  // regardless of the reported track state. This re-runs the SFU publish
  // negotiation and reliably delivers audio to everyone. Runs once; never
  // touches the working 1:1 / original-participant paths.
  const forcedRepublishRef = useRef(false);
  useEffect(() => {
    if (!call || !connected || !micOn || !isAddedParticipant) return;
    if (forcedRepublishRef.current) return;
    forcedRepublishRef.current = true;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        await call.microphone.disable();
        await new Promise((r) => setTimeout(r, 250));
        if (!cancelled) await call.microphone.enable();
      } catch {}
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [call, connected, micOn, isAddedParticipant]);

  useEffect(() => {
    if (!connected) return;
    wasConnectedRef.current = true;
    // iter-428: play the deep "Connected" tone to THIS participant the moment
    // media connects (once per call). 1:1 → both sides connect when the callee
    // answers so both hear it; group → each participant hears it upon joining
    // (connected = JOINED && a remote is present), and the initiator hears it
    // together with the first person who joins. Voice & video alike.
    if (!playedConnectedToneRef.current) {
      playedConnectedToneRef.current = true;
      InCallAudio.playCallConnectedTone?.();
    }
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
    // Play the "Ciao" end-tone NOW (not after the teardown delay below): once
    // the remote has left, the Stream audio session is about to be torn down,
    // and a tone played inside the delayed hangup often gets cut off on THIS
    // (non-End-tapping) side. Firing it here — while audio is still active —
    // is what makes Ciao play reliably on BOTH sides. onEnding is idempotent.
    if (remoteHungUp) onEnding?.();
    const t = setTimeout(() => onHangup(), remoteHungUp ? 400 : 3000);
    return () => clearTimeout(t);
  }, [remoteParticipants.length, convStatus, onHangup, onEnding]);

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
  flipCamRef.current = flipCam;

  // Audio output routing. Stream RN does NOT manage audio routing itself, so we
  // drive the native AudioManager via InCallAudio (same as the WebRTC screen).
  // `userPickedRouteRef` records an EXPLICIT user selection so the auto-Bluetooth
  // detector below never overrides a manual choice.
  const userPickedRouteRef = useRef(false);
  const btWasAvailableRef = useRef(false);
  const audioToastRef = useRef<((msg: string) => void) | null>(null);
  const routeToastLabel = (route: AudioOutputRoute): string =>
    route === 'bluetooth'
      ? '🎧 Audio: Bluetooth'
      : route === 'speaker'
        ? '🔊 Audio: Speaker'
        : '📞 Audio: Earpiece';
  const routeAudioNative = useCallback((route: AudioOutputRoute) => {
    setAudioRoute(route);
    try {
      if (route === 'speaker') InCallAudio.setSpeakerOn(true);
      else if (route === 'bluetooth') InCallAudio.setBluetoothOn(videoMode ? 'video' : 'audio');
      else InCallAudio.setEarpieceOn();
    } catch {}
  }, [videoMode]);
  const applyAudioRoute = useCallback((route: AudioOutputRoute) => {
    userPickedRouteRef.current = true; // manual selection wins over auto-routing
    setAudioMenuVisible(false);
    routeAudioNative(route);
    audioToastRef.current?.(routeToastLabel(route));
  }, [routeAudioNative]);

  // Auto-detect & auto-route Bluetooth for Stream calls (voice & video), exactly
  // like the custom-WebRTC screen. Stream never starts an InCallManager session,
  // so on Android a paired headset was never picked up — audio stayed on the
  // earpiece/speaker. When a headset is available (paired before OR connected
  // mid-call) and the user hasn't explicitly chosen another output, route to it;
  // fall back to speaker (video) / earpiece (voice) when it disconnects. A short
  // toast tells the user which output the audio jumped to.
  // Android-only — iOS AVAudioSession already auto-routes to Bluetooth.
  useEffect(() => {
    if (!connected) return undefined;
    void InCallAudio.ensureBluetoothPermission();
    const unsubscribe = InCallAudio.addAudioDeviceChangedListener(({ available }) => {
      const btAvailable = available.includes('BLUETOOTH');
      if (btAvailable && !userPickedRouteRef.current) {
        if (!btWasAvailableRef.current) audioToastRef.current?.(routeToastLabel('bluetooth'));
        routeAudioNative('bluetooth');
      } else if (!btAvailable && btWasAvailableRef.current && !userPickedRouteRef.current) {
        const fallback: AudioOutputRoute = videoMode ? 'speaker' : 'earpiece';
        audioToastRef.current?.(routeToastLabel(fallback));
        routeAudioNative(fallback);
      }
      btWasAvailableRef.current = btAvailable;
    });
    return unsubscribe;
  }, [connected, videoMode, routeAudioNative]);

  // Voice → Video upgrade mid-call. Per requirement (2b), the switch now
  // REQUESTS the peer's consent via a Stream custom event; we only publish our
  // camera once they accept. `doEnableVideo` performs the actual upgrade.
  const doEnableVideo = useCallback(async () => {
    if (!call) return;
    try {
      await call.camera.enable();
      setCamOn(true);
      setVideoMode(true);
      // Keep Bluetooth if a headset is driving the call; otherwise use the
      // loudspeaker for hands-free video. Don't mark this as a manual pick so
      // the auto-Bluetooth detector still applies.
      routeAudioNative(btWasAvailableRef.current ? 'bluetooth' : 'speaker');
    } catch {}
  }, [call, routeAudioNative]);

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
  const addGroupMemberMutation = useMutation((api as any).conversations.addGroupMember);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [showRoster, setShowRoster] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [pendingAdd, setPendingAdd] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [addPermanent, setAddPermanent] = useState(false);
  const [roster, setRoster] = useState<CallRosterEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<any>(null);
  const prevRosterRef = useRef<Map<string, string> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);
  // Expose showToast to the audio-route callbacks defined earlier in the
  // component (they hold a ref because showToast is declared after them).
  audioToastRef.current = showToast;

  // Announce remote mic changes with a toast so people notice even when they
  // aren't looking at that person's tile (1:1 and multiparty). A short
  // per-participant grace after first sighting avoids spurious toasts while
  // their audio publish is still settling right after they join.
  const muteStateRef = useRef<Map<string, boolean>>(new Map());
  const muteSeenAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!connected) return;
    const now = Date.now();
    const prev = muteStateRef.current;
    const seen = muteSeenAtRef.current;
    const nextIds = new Set<string>();
    remoteParticipants.forEach((p: any) => {
      const id = String(p?.userId || p?.sessionId || '');
      if (!id) return;
      nextIds.add(id);
      const muted = isParticipantMuted(p);
      if (!seen.has(id)) seen.set(id, now);
      const settled = now - (seen.get(id) as number) > 2500;
      const was = prev.get(id);
      if (was !== undefined && was !== muted && settled) {
        showToast(`${String(p?.name || 'Participant')} ${muted ? 'muted' : 'unmuted'}`);
      }
      prev.set(id, muted);
    });
    for (const id of Array.from(prev.keys())) {
      if (!nextIds.has(id)) {
        prev.delete(id);
        seen.delete(id);
      }
    }
  }, [remoteParticipants, connected, showToast]);

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

  // Roster with a derived per-viewer status, recomputed each poll so a
  // 'pending' entry flips to "Missed" once the ring window elapses.
  const rosterWithStatus = useMemo(
    () => {
      const now = Date.now();
      return roster.map((r) => ({ ...r, derived: deriveRosterStatus(r, now) }));
    },
    [roster],
  );

  // A "conference" is ANY multi-party call — a real group-conversation call OR
  // a 1:1/direct call that had people ADDED into it (which is NOT a group
  // conversation, so `isGroupCall` is false for it). The Joined/Missed/Left
  // tags, Dial-again, the joined-report and the left-auto-detect must all be
  // active for these added-participant calls too — gating them on `isGroupCall`
  // was why none of it rendered for "scammers blacklist" (shown as "3 people").
  const isConferenceCall =
    isGroupCall ||
    (remoteParticipants?.length || 0) > 1 ||
    rosterWithStatus.some((r) => r.identity && r.identity !== myId);

  const inCallIds = useMemo(() => {
    const s = new Set<string>();
    if (myId) s.add(myId);
    (participants || []).forEach((p: any) => p?.userId && s.add(String(p.userId)));
    // Only people who are actually here (joined) or still being rung count as
    // "in call". Missed / left / declined entries are re-addable, so they must
    // NOT block re-selection in the add picker (fixes the "stuck in list,
    // can't re-add until removed" bug).
    rosterWithStatus.forEach((r) => {
      if (r.identity && (r.derived === 'joined' || r.derived === 'ringing')) s.add(r.identity);
    });
    return s;
  }, [myId, participants, rosterWithStatus]);

  // ── Group call: report MY status "joined" once connected so every
  // participant's waiting strip shows me green (mirrors the legacy WebRTC
  // invite strip). Pending/declined come from the ring + decline signals.
  const reportedJoinedRef = useRef(false);
  useEffect(() => {
    if (!isConferenceCall || !connected || !room || !myId) return;
    if (reportedJoinedRef.current) return;
    reportedJoinedRef.current = true;
    void reportParticipantStatus({ streamRoom: room, identity: myId, status: 'joined', displayName: myName });
  }, [isConferenceCall, connected, room, myId, myName]);

  // ── Backup "Left" auto-detection ─────────────────────────────────────────
  // The leaving participant reports 'left' on hangup, but a killed / crashed /
  // offline app can't send that. So EVERY other participant also watches the
  // live Stream SFU roster: a member whose backend status is 'joined' but who
  // is no longer among the live Stream participants for > LEFT_GRACE_MS is
  // reported 'left' on their behalf. Idempotent — safe if several clients
  // report the same person at once. A short grace avoids false positives from
  // transient SFU reconnects, and a per-id "already reported" latch prevents
  // re-report loops (cleared the moment they reappear, e.g. after a redial).
  const presentUserIds = useMemo(() => {
    const s = new Set<string>();
    (participants || []).forEach((p: any) => p?.userId && s.add(String(p.userId)));
    return s;
  }, [participants]);
  const absentSinceRef = useRef<Map<string, number>>(new Map());
  const leftReportedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isConferenceCall || !connected || !room || !myId) return;
    const LEFT_GRACE_MS = 8000;
    const check = () => {
      const now = Date.now();
      const absent = absentSinceRef.current;
      roster.forEach((r) => {
        const id = r.identity;
        if (!id || id === myId) return;
        // Only ever downgrade someone the backend still considers 'joined'.
        if (r.status !== 'joined') {
          absent.delete(id);
          return;
        }
        if (presentUserIds.has(id)) {
          absent.delete(id);
          leftReportedRef.current.delete(id); // present again → allow future detection
          return;
        }
        // 'joined' per backend but absent from the live SFU roster.
        if (!absent.has(id)) absent.set(id, now);
        const since = absent.get(id) as number;
        if (now - since >= LEFT_GRACE_MS && !leftReportedRef.current.has(id)) {
          leftReportedRef.current.add(id);
          void reportParticipantStatus({
            streamRoom: room,
            identity: id,
            status: 'left',
            displayName: r.displayName || '',
          }).then(() => {
            if (room && myId) fetchCallParticipants(room, myId).then(setRoster);
          });
        }
      });
    };
    check();
    const iv = setInterval(check, 2000);
    return () => clearInterval(iv);
  }, [isConferenceCall, connected, room, myId, roster, presentUserIds]);

  // Waiting strip: members who have NOT joined (ringing/missed/left). Excludes
  // me and anyone already joined so the strip only shows who we're waiting on
  // or can dial again.
  const waitingMembers = useMemo(
    () => rosterWithStatus.filter((r) => r.identity && r.identity !== myId && r.derived !== 'joined'),
    [rosterWithStatus, myId],
  );
  const hasPendingOrDeclined = waitingMembers.length > 0;

  // Group summary counts for the participants pill: how many have joined
  // (+1 for me, who is always joined) vs. how many are still ringing.
  const groupJoinedCount = useMemo(
    () => rosterWithStatus.filter((r) => r.identity && r.identity !== myId && r.derived === 'joined').length + 1,
    [rosterWithStatus, myId],
  );
  const groupRingingCount = useMemo(
    () => rosterWithStatus.filter((r) => r.identity && r.identity !== myId && r.derived === 'ringing').length,
    [rosterWithStatus, myId],
  );

  // Mid-call "Call Again" — re-ring ONLY the pending/declined members.
  const [callingAgain, setCallingAgain] = useState(false);
  const handleCallAgain = useCallback(async () => {
    if (!room || !myId || callingAgain) return;
    setCallingAgain(true);
    try {
      const n = await groupCallAgain({
        streamRoom: room,
        conversationId,
        callerIdentity: myId,
        callerDisplayName: myName,
        callerPhone: myPhone || undefined,
        conversationName,
        isVideo: videoMode,
      });
      showToast(n > 0 ? `Ringing ${n} ${n === 1 ? 'person' : 'people'} again…` : 'Everyone has already joined');
      if (room && myId) fetchCallParticipants(room, myId).then(setRoster);
    } finally {
      setCallingAgain(false);
    }
  }, [room, myId, callingAgain, conversationId, myName, myPhone, conversationName, videoMode, showToast]);

  // Dial-again for a SINGLE missed/left participant. Re-rings just that person
  // by re-running the add-participant flow (preserving their original
  // show/hide-number choice), which resets their roster entry to 'pending'.
  const [redialingIds, setRedialingIds] = useState<string[]>([]);
  const handleRedial = useCallback(
    async (entry: CallRosterEntry) => {
      if (!room || !myId || !entry?.identity) return;
      if (redialingIds.includes(entry.identity)) return;
      setRedialingIds((prev) => [...prev, entry.identity]);
      try {
        // Resolve a direct conversation so the ring/answer deep-link opens a
        // real context for the callee (any participant may create one).
        let convForAdd = conversationId;
        try {
          const cid = await getOrCreateDirect({ otherUserId: entry.identity });
          if (cid) convForAdd = String(cid);
        } catch {
          /* fall back to the current conversationId */
        }
        await addStreamParticipant({
          streamRoom: room,
          adderIdentity: myId,
          adderDisplayName: myName,
          adderPhone: myPhone || undefined,
          calleeIdentity: entry.identity,
          calleeDisplayName: entry.displayName || '',
          calleePhone: entry.phoneNumber || undefined,
          hideNumber: entry.hideNumber,
          isVideo: videoMode,
          conversationId: convForAdd,
        });
        showToast(`Ringing ${entry.displayName || 'them'} again…`);
        fetchCallParticipants(room, myId).then(setRoster);
      } catch (err: any) {
        Alert.alert('Could not dial again', err?.message || 'Please try again.');
      } finally {
        setRedialingIds((prev) => prev.filter((id) => id !== entry.identity));
      }
    },
    [room, myId, redialingIds, conversationId, myName, myPhone, videoMode, getOrCreateDirect, showToast],
  );

  // ── Admin: incoming "request to add X" (from a non-admin) → Approve/Decline.
  const [addReq, setAddReq] = useState<PendingAddRequest | null>(getAddRequest());
  useEffect(() => {
    const unsub = subscribeAddRequest(() => setAddReq(getAddRequest()));
    return unsub;
  }, []);
  const [resolvingReq, setResolvingReq] = useState(false);
  // Only the admins on THIS call see the prompt (match room when known).
  const showAddReq =
    isGroupCall && isGroupAdmin && !!addReq &&
    (!room || !addReq.streamRoom || addReq.streamRoom === room);

  const approveAddReq = useCallback(async () => {
    if (!addReq || !room || !myId || resolvingReq) return;
    setResolvingReq(true);
    try {
      let convForAdd = conversationId;
      try {
        const cid = await getOrCreateDirect({ otherUserId: addReq.targetIdentity });
        if (cid) convForAdd = String(cid);
      } catch {
        /* fall back */
      }
      await addStreamParticipant({
        streamRoom: room,
        adderIdentity: myId,
        adderDisplayName: myName,
        adderPhone: myPhone || undefined,
        calleeIdentity: addReq.targetIdentity,
        calleeDisplayName: addReq.targetName || '',
        calleePhone: addReq.targetPhone || undefined,
        hideNumber: false,
        isVideo: videoMode,
        conversationId: convForAdd,
      });
      if (addReq.addPermanently) {
        try {
          await addGroupMemberMutation({ conversationId, userId: addReq.targetIdentity });
        } catch {
          /* non-fatal */
        }
      }
      showToast(`Added ${addReq.targetName || 'the requested person'}`);
      if (room && myId) fetchCallParticipants(room, myId).then(setRoster);
    } catch (err: any) {
      Alert.alert('Could not add', err?.message || 'Please try again.');
    } finally {
      clearAddRequest();
      setResolvingReq(false);
    }
  }, [addReq, room, myId, resolvingReq, conversationId, myName, myPhone, videoMode, getOrCreateDirect, addGroupMemberMutation, showToast]);

  const declineAddReq = useCallback(async () => {
    if (!addReq || resolvingReq) return;
    setResolvingReq(true);
    try {
      await declineAddRequest({
        requesterIdentity: addReq.requesterIdentity,
        targetName: addReq.targetName,
        adminName: myName,
      });
    } finally {
      clearAddRequest();
      setResolvingReq(false);
    }
  }, [addReq, resolvingReq, myName]);


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
    setAddPermanent(false);
    setShowAddPicker(true);
  }, [room]);

  const confirmAdd = useCallback(
    async (hideNumber: boolean, permanent: boolean) => {
      const contact = pendingAdd;
      if (!contact?._id || !room || !myId) return;
      setAdding(true);
      try {
        // Non-admin in a GROUP call → cannot add directly. Send an approval
        // request to all admins (they approve/decline in-call). Mirrors the
        // WebRTC waiting flow: the person shows once an admin approves.
        if (isGroupCall && !isGroupAdmin) {
          const ok = await requestAddParticipant({
            streamRoom: room,
            conversationId,
            requesterIdentity: myId,
            requesterName: myName,
            targetIdentity: String(contact._id),
            targetName: String(contact.name || ''),
            targetPhone: contact.phoneNumber ? String(contact.phoneNumber) : undefined,
            adminIdentities: adminIdentities || [],
            isVideo: videoMode,
            addPermanently: permanent,
          });
          setPendingAdd(null);
          setShowAddPicker(false);
          showToast(ok ? 'Request sent to the group admins' : 'Could not send request');
          return;
        }

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
        // Admin opted to also add them to the group permanently.
        if (isGroupCall && isGroupAdmin && permanent) {
          try {
            await addGroupMemberMutation({ conversationId, userId: String(contact._id) });
          } catch {
            showToast('Added to call (couldn’t add to group permanently)');
          }
        }
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
    [pendingAdd, room, myId, myName, myPhone, videoMode, conversationId, getOrCreateDirect, showToast, isGroupCall, isGroupAdmin, adminIdentities, addGroupMemberMutation],
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
              if (isGroupCall && isGroupAdmin) {
                await adminKickParticipant({ streamRoom: room, identity: entry.identity, requesterIdentity: myId });
              } else {
                await removeStreamParticipant({ streamRoom: room, identity: entry.identity, requesterIdentity: myId });
              }
              showToast(`You removed ${entry.displayName || 'a participant'}`);
              fetchCallParticipants(room, myId).then(setRoster);
            } catch (err: any) {
              Alert.alert('Could not remove', err?.message || 'Please try again.');
            }
          },
        },
      ]);
    },
    [room, myId, showToast, isGroupCall, isGroupAdmin],
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
        ) : remoteParticipants.length > 1 ? (
          // Multi-party (3+ in call): a paginated, swipeable grid. Rendering
          // every remote is what registers each for Stream track subscription —
          // with the old single-`remote` layout the 3rd+ person was neither
          // seen nor heard. Tiles are compact so many fit per page; extra
          // people spill onto swipeable pages.
          <ParticipantGridPager participants={remoteParticipants} width={winW} />
        ) : showVideo && remote && remoteHasVideo ? (
          <ParticipantView
            participant={remote}
            style={StyleSheet.absoluteFill as any}
            ParticipantLabel={null}
            ParticipantVideoFallback={null}
            videoZOrder={0}
          />
        ) : (
          <View style={styles.centerFill}>
            <View style={[styles.avatarBig, remoteSpeaking ? styles.avatarBigSpeaking : null]}>
              <Ionicons name="person" size={64} color={Colors.white} />
            </View>
            <View style={styles.peerNameRow}>
              {remoteMuted && connected ? (
                <Ionicons name="mic-off" size={16} color="#FF6B6B" style={{ marginRight: 6 }} />
              ) : null}
              <Text style={styles.peerName} numberOfLines={1}>
                {peerName}
              </Text>
            </View>
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
        ) : !isMultiParty && showVideo && remote && remoteHasVideo ? (
          <View style={styles.topBar} pointerEvents="none">
            <View style={styles.topNameRow}>
              {remoteMuted ? (
                <Ionicons name="mic-off" size={15} color="#FF6B6B" style={{ marginRight: 6 }} />
              ) : null}
              <Text style={styles.topName} numberOfLines={1}>
                {peerName}
              </Text>
            </View>
            <Text style={styles.topStatus}>{statusLine}</Text>
          </View>
        ) : null
      ) : null}

      {!inPiP && videoMode && camOn && local ? (
        <Animated.View
          style={[styles.selfView, { transform: selfPan.getTranslateTransform() }]}
          {...selfPanResponder.panHandlers}
        >
          <ParticipantView
            participant={local}
            style={StyleSheet.absoluteFill as any}
            ParticipantLabel={null}
            ParticipantVideoFallback={null}
            videoZOrder={1}
            mirror={selfMirror}
          />
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
          topOffset={isConferenceCall && hasPendingOrDeclined ? 150 : 90}
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
            {isConferenceCall
              ? groupRingingCount > 0
                ? `${groupJoinedCount} joined · ${groupRingingCount} ringing`
                : `${groupJoinedCount} in call`
              : `${participantCount} ${participantCount === 1 ? 'person' : 'people'}`}
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* Group-call waiting strip — mirrors the WebRTC invite strip: a live
          horizontal list of members we're still waiting on (Ringing/Declined),
          plus a "Call again" chip that re-rings only them. */}
      {isConferenceCall && !inPiP && !isMini && hasPendingOrDeclined ? (
        <View style={styles.waitStrip} testID="group-call-waiting-strip">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.waitStripContent}
          >
            {waitingMembers.map((m) => {
              const meta = GROUP_STATUS_META[m.derived] || GROUP_STATUS_META.ringing;
              const showRedial = (m.derived === 'missed' || m.derived === 'left') && canRedialEntry(m, myId);
              const canRemove =
                (isGroupCall && isGroupAdmin) || (!!m.addedBy && !!myId && m.addedBy === myId);
              const isRedialing = redialingIds.includes(m.identity);
              return (
                <View key={m.identity} style={styles.waitChip} testID={`group-call-wait-chip-${m.identity}`}>
                  <View style={[styles.waitDot, { backgroundColor: meta.color }]} />
                  <Text style={styles.waitChipName} numberOfLines={1}>{m.displayName || 'Member'}</Text>
                  <Text style={[styles.waitChipStatus, { color: meta.color }]}>{meta.label}</Text>
                  {showRedial ? (
                    <Pressable
                      hitSlop={8}
                      onPress={() => handleRedial(m)}
                      disabled={isRedialing}
                      testID={`group-call-wait-redial-${m.identity}`}
                    >
                      {isRedialing ? (
                        <ActivityIndicator size="small" color="#34C759" />
                      ) : (
                        <Ionicons name="call" size={16} color="#34C759" />
                      )}
                    </Pressable>
                  ) : null}
                  {canRemove ? (
                    <Pressable hitSlop={8} onPress={() => handleRemove(m)} testID={`group-call-wait-kick-${m.identity}`}>
                      <Ionicons name="close-circle" size={16} color="rgba(255,255,255,0.7)" />
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
            <TouchableOpacity
              style={styles.waitAgainChip}
              onPress={handleCallAgain}
              disabled={callingAgain}
              testID="group-call-call-again"
            >
              {callingAgain ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Ionicons name="refresh" size={15} color={Colors.white} />
              )}
              <Text style={styles.waitAgainText}>Call again</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      ) : null}

      {/* Admin: a non-admin requested adding someone → Approve / Decline. */}
      {showAddReq && addReq && !inPiP && !isMini ? (
        <View style={styles.addReqBanner} testID="group-call-add-request">
          <View style={styles.addReqTextWrap}>
            <Text style={styles.addReqTitle} numberOfLines={1}>
              {addReq.requesterName || 'A member'} wants to add {addReq.targetName || 'someone'}
            </Text>
            {addReq.addPermanently ? (
              <Text style={styles.addReqSub}>Will also be added to the group</Text>
            ) : null}
          </View>
          <TouchableOpacity
            style={[styles.addReqBtn, styles.addReqDecline]}
            onPress={declineAddReq}
            disabled={resolvingReq}
            testID="group-call-add-request-decline"
          >
            <Ionicons name="close" size={18} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.addReqBtn, styles.addReqApprove]}
            onPress={approveAddReq}
            disabled={resolvingReq}
            testID="group-call-add-request-approve"
          >
            {resolvingReq ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Ionicons name="checkmark" size={18} color={Colors.white} />
            )}
          </TouchableOpacity>
        </View>
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
              <Text style={styles.sheetTitle}>
                {pendingAdd
                  ? isGroupCall && !isGroupAdmin
                    ? 'Request to add'
                    : 'Share number?'
                  : 'Add to call'}
              </Text>
              <Pressable onPress={() => (adding ? undefined : setShowAddPicker(false))} hitSlop={8}>
                <Ionicons name="close" size={22} color={Colors.white} />
              </Pressable>
            </View>

            {pendingAdd ? (
              isGroupCall && !isGroupAdmin ? (
                // Non-admin → cannot add directly; request admin approval.
                <View style={styles.privacyStep}>
                  <View style={styles.privacyAvatar}>
                    <Text style={styles.privacyAvatarText}>
                      {String(pendingAdd.name || '?').trim().charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.privacyName}>{pendingAdd.name || 'Contact'}</Text>
                  <Text style={styles.privacyMsg}>
                    Only group admins can add people. Send a request for an admin to approve
                    adding {String(pendingAdd.name || 'this contact').split(' ')[0]} to the call.
                  </Text>
                  <Pressable
                    style={[styles.privacyChoice, styles.privacyShow]}
                    disabled={adding}
                    onPress={() => confirmAdd(false, false)}
                  >
                    <Ionicons name="paper-plane" size={20} color={Colors.white} />
                    <View style={styles.privacyChoiceText}>
                      <Text style={styles.privacyChoiceTitle}>{adding ? 'Sending…' : 'Send request to admins'}</Text>
                      <Text style={styles.privacyChoiceSub}>An admin will approve or decline</Text>
                    </View>
                  </Pressable>
                  <Pressable style={styles.privacyBack} disabled={adding} onPress={() => setPendingAdd(null)}>
                    <Text style={styles.privacyBackText}>Back</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.privacyStep}>
                  <View style={styles.privacyAvatar}>
                    <Text style={styles.privacyAvatarText}>
                      {String(pendingAdd.name || '?').trim().charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.privacyName}>{pendingAdd.name || 'Contact'}</Text>
                  {isGroupCall && isGroupAdmin ? (
                    <Pressable
                      style={styles.permToggle}
                      disabled={adding}
                      onPress={() => setAddPermanent((v) => !v)}
                      testID="group-call-add-permanent"
                    >
                      <Ionicons
                        name={addPermanent ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={addPermanent ? Colors.primary : Colors.white}
                      />
                      <Text style={styles.permToggleText}>Also add to the group permanently</Text>
                    </Pressable>
                  ) : null}
                  <Text style={styles.privacyMsg}>
                    Should other participants be able to see{' '}
                    {String(pendingAdd.name || 'this contact').split(' ')[0]}&apos;s phone number?
                  </Text>
                  <Pressable
                    style={[styles.privacyChoice, styles.privacyHide]}
                    disabled={adding}
                    onPress={() => confirmAdd(true, addPermanent)}
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
                    onPress={() => confirmAdd(false, addPermanent)}
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
              )
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
              <RosterRow name={`${myName || 'You'} (you)`} phone={null} status={isConferenceCall ? 'joined' : undefined} />
              {rosterWithStatus
                .filter((r) => r.identity && r.identity !== myId)
                .map((r) => {
                  const showRedial =
                    isConferenceCall &&
                    (r.derived === 'missed' || r.derived === 'left') &&
                    canRedialEntry(r, myId);
                  return (
                    <RosterRow
                      key={r.identity}
                      name={r.displayName || 'Smilers user'}
                      phone={r.phoneNumber}
                      hidden={r.hideNumber}
                      status={isConferenceCall ? r.derived : undefined}
                      onRedial={showRedial ? () => handleRedial(r) : undefined}
                      redialing={redialingIds.includes(r.identity)}
                      onRemove={
                        (isGroupCall && isGroupAdmin) || (r.addedBy && myId && r.addedBy === myId)
                          ? () => handleRemove(r)
                          : undefined
                      }
                    />
                  );
                })}
            </View>
            {isConferenceCall && hasPendingOrDeclined ? (
              <Pressable
                style={styles.rosterAgainBtn}
                onPress={handleCallAgain}
                disabled={callingAgain}
                testID="group-call-roster-again"
              >
                {callingAgain ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Ionicons name="refresh" size={18} color={Colors.white} />
                )}
                <Text style={styles.rosterAddText}>Call again ({waitingMembers.length})</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={styles.rosterAddBtn}
              onPress={() => {
                setShowRoster(false);
                handleAdd();
              }}
            >
              <Ionicons name="person-add" size={18} color={Colors.white} />
              <Text style={styles.rosterAddText}>
                {isGroupCall && !isGroupAdmin ? 'Request to add someone' : 'Add participant'}
              </Text>
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
  status,
  onRedial,
  redialing,
}: {
  name: string;
  phone: string | null;
  hidden?: boolean;
  onRemove?: () => void;
  status?: DerivedRosterStatus;
  onRedial?: () => void;
  redialing?: boolean;
}) {
  const meta = status ? GROUP_STATUS_META[status] : null;
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
      {meta ? (
        <View style={styles.rosterStatusWrap}>
          <View style={[styles.waitDot, { backgroundColor: meta.color }]} />
          <Text style={[styles.rosterStatusText, { color: meta.color }]}>{meta.label}</Text>
        </View>
      ) : null}
      {onRedial ? (
        <TouchableOpacity style={styles.rosterRedialBtn} onPress={onRedial} disabled={redialing} hitSlop={8}>
          {redialing ? (
            <ActivityIndicator size="small" color="#34C759" />
          ) : (
            <Ionicons name="call" size={22} color="#34C759" />
          )}
        </TouchableOpacity>
      ) : null}
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

  // ── Group-call orchestration context (Phase 2) ──────────────────────────
  // Admins/members are fields on the group conversation doc (web-team contract:
  // getConversation → { admins[], chiefAdmin, adminOrder[], type }).
  const convDoc = useQuery(
    (api as any).conversations.getConversation,
    canQuery ? ({ conversationId } as any) : 'skip',
  ) as any;
  const isGroupConv = convDoc?.type === 'group' || convDoc?.isGroup === true;
  const isGroupCall = params?.group === '1' || params?.group === 'true' || isGroupConv;
  const adminIdentities = useMemo(
    () => (Array.isArray(convDoc?.admins) ? convDoc.admins.map((a: any) => String(a)) : []),
    [convDoc],
  );
  const isGroupAdmin = !!(me?._id && adminIdentities.includes(String(me._id)));
  const conversationName = String(convDoc?.name || convDoc?.groupName || displayName || 'Group call');

  const [client, setClient] = useState<any>(undefined);
  const [call, setCall] = useState<any>(null);
  const [didInitiate, setDidInitiate] = useState(false);
  const [locallyAccepted, setLocallyAccepted] = useState(false);
  const [createdCallId, setCreatedCallId] = useState<string | null>(null);
  // Retry / recovery state so a rare failed join never dead-ends on a frozen
  // "Connecting…" screen. `rejoinNonce` re-runs the join effect with a FRESH
  // call object (often lands on a healthy SFU edge instantly); `joinFailed`
  // flips when both watchdog attempts miss so the UI can offer a Retry.
  const [rejoinNonce, setRejoinNonce] = useState(0);
  const [joinFailed, setJoinFailed] = useState(false);
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
  // Canonical Stream room — DETERMINISTIC from the conversationId, per the
  // confirmed backend contract (the FCM ring payload carries
  // `twilio_room_name = "smilers_conv_<conversationId>"`; the web caller joins
  // that exact room). The room is NOT keyed to the call-record id (`callId`) —
  // using `callId` was the mismatch that left the callee joining a different
  // room than the caller ("answered but never connects"). Deriving from
  // conversationId means BOTH devices land in the same room immediately, with
  // no dependency on the short-TTL Convex ring record resolving first (which
  // also caused mid-call teardown). An explicit `streamRoom` param (group
  // add-participant flow) still overrides; the old call-record ids stay only as
  // last-resort fallbacks.
  const canonicalRoom = conversationId ? `smilers_conv_${conversationId}` : undefined;
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
  const streamCallId: string | undefined =
    streamRoomParam || canonicalRoom || pinnedRoom || callId || createdCallId || undefined;

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

  // Register this call in the global active-call registry the moment it goes
  // active (answered on the callee side, or initiated on the caller side).
  // This does two jobs:
  //   1. A SECOND incoming call can now detect "user is already on a call" and
  //      render the in-call call-waiting overlay instead of hijacking the
  //      ongoing call (hasOtherActiveCall in useIncomingCallListener).
  //   2. It records the answer, so the missed-call listener never fires a
  //      FALSE "missed call" when THIS call is later hung up — the answer path
  //      through the native notification / Stream UI bypasses the listener's
  //      own userAnsweredRef. Cleared on unmount.
  useEffect(() => {
    if (accepted && (callId || conversationId)) {
      setActiveCall({
        callId: callId ? String(callId) : null,
        conversationId: conversationId ? String(conversationId) : null,
      });
    }
  }, [accepted, callId, conversationId]);
  useEffect(() => () => setActiveCall(null), []);
  const activeCallReady = !activeCallLoading && !!activeCall;
  const isIncomingPending =
    activeCallReady && !iAmCaller && !isAnswering && !locallyAccepted && convStatus === 'ringing';

  // #7: play the callee's selected ringtone (+ vibrate) while the in-app
  // incoming-call UI is showing — the FOREGROUND ring the Stream screen was
  // missing (the callee saw Accept/Decline but heard nothing).
  useRingtonePlayer(isIncomingPending, { vibrate: isIncomingPending });

  // #5 FIX (caller hears no ringing): the REAL root cause was the gate below —
  // `!accepted` is ALWAYS false for the caller (accepted = iAmCaller || …), so
  // `isOutgoingRinging` could never be true and the ringback never started. The
  // caller therefore heard silence until the callee answered. The correct
  // "still ringing" signal is: I'm the caller, the ring record still says
  // 'ringing', and the callee has NOT yet media-connected (lifted up from
  // CallUI via onConnectedChange). Ringback then plays for the whole outgoing
  // ring window and stops the instant we connect / the call ends.
  const [remoteConnected, setRemoteConnected] = useState(false);
  // Sticky latch: once the call has EVER media-connected (remote joined), stays
  // true for the rest of this call. The Ciaooo end-tone gates on THIS, not the
  // live `remoteConnected` — because for the side that did NOT tap End, the
  // remote leaves first (flipping remoteConnected → false) before their
  // auto-end hangup() runs, which previously suppressed their Ciao. An
  // unanswered/declined call never connects, so this stays false → still silent.
  const everConnectedRef = useRef(false);
  const ciaoPlayedRef = useRef(false);
  // Play the warm "Ciao" call-end tone exactly ONCE per call, and only if the
  // call actually connected (unanswered/declined rings stay silent). Callable
  // from both the local End tap (hangup) and the remote-left detector in CallUI
  // (onEnding) — whichever fires first wins, the other is a no-op.
  const playCiaoOnce = useCallback(() => {
    if (ciaoPlayedRef.current || !everConnectedRef.current) return;
    ciaoPlayedRef.current = true;
    InCallAudio.playCallEndTone?.();
  }, []);
  const handleConnectedChange = useCallback((v: boolean) => {
    if (v) everConnectedRef.current = true;
    setRemoteConnected(v);
  }, []);
  const isOutgoingRinging =
    activeCallReady && iAmCaller && convStatus === 'ringing' && !remoteConnected;
  useRingbackPlayer(isOutgoingRinging);

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
    // Fresh call ⇒ fresh roster. The room id is deterministic per conversation,
    // so wipe any leftover roster from a PRIOR call in this conversation before
    // this new one seeds (prevents stale added/left people offering a "redial").
    // 1:1 only here — group calls clear inside /calls/group-ring at start.
    if (!isGroupCall && canonicalRoom) void resetCallRoster(canonicalRoom);
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
    isGroupCall,
    canonicalRoom,
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
    setJoinFailed(false);
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
          if (mounted) setJoinFailed(true);
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
        if (mounted) setJoinFailed(true);
        /* both attempts failed — screen now offers a Retry (see loading UI) */
      }
    })();
    return () => {
      mounted = false;
      try {
        joined?.leave();
      } catch {}
    };
  }, [streamCallId, accepted, isVideo, rejoinNonce]);

  // User-driven recovery: drop the stuck call object and re-run the join effect
  // with a fresh Stream call (new SFU edge). Safe — it never fires on its own
  // during a legitimate ring; it's triggered by the Retry button, or by the
  // callee-only watchdog below (the callee has already answered, so there's no
  // ring to disturb).
  const retryJoin = useCallback(() => {
    setJoinFailed(false);
    setCall(null);
    setRejoinNonce((n) => n + 1);
  }, []);

  // "Still connecting…" affordance: surface a Retry after 15s of not being
  // media-connected (or immediately once a join has failed). Timer restarts on
  // each rejoin and stops the moment we connect.
  const [connectElapsed, setConnectElapsed] = useState(0);
  useEffect(() => {
    if (remoteConnected) {
      setConnectElapsed(0);
      return;
    }
    const start = Date.now();
    const iv = setInterval(() => setConnectElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [remoteConnected, rejoinNonce]);
  // Caller gets a longer threshold (an unanswered ring is normal); the callee
  // has answered, so being stuck past ~12s means something is wrong.
  const showRetry = joinFailed || connectElapsed >= (iAmCaller ? 30 : 12);

  // Callee-only auto-recovery: if we joined the room but the caller never shows
  // up within 18s (a stalled SFU negotiation — the "I answered but it stays
  // Connecting forever / never connects" report), do ONE automatic fresh
  // rejoin. Caller is excluded because their "no remote yet" is just a normal
  // unanswered ring, which must not be churned.
  const autoRejoinedRef = useRef(false);
  useEffect(() => {
    if (iAmCaller || remoteConnected || !call || autoRejoinedRef.current) return;
    const t = setTimeout(() => {
      if (!remoteConnected && !autoRejoinedRef.current) {
        autoRejoinedRef.current = true;
        recordDiagnostic({
          tag: 'CALL',
          source: 'streamTiming',
          message: `auto-rejoin callee joined-but-no-remote-18s callId=${streamCallId || '∅'}`,
        });
        retryJoin();
      }
    }, 18000);
    return () => clearTimeout(t);
  }, [iAmCaller, remoteConnected, call, retryJoin, streamCallId]);

  const acceptIncoming = useCallback(() => {
    setLocallyAccepted(true);
    if (callId) void answerCall({ callId: String(callId) }).catch(() => {});
  }, [callId, answerCall]);

  const declineIncoming = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (callId) void declineCall({ callId: String(callId) }).catch(() => {});
    // Group call: report my "declined" status so every participant's waiting
    // strip shows me red (mirrors the WebRTC invite strip).
    // Conference call (group OR a call I was added into): report my "declined"
    // status so the adder/participants see me flip to Missed with Dial-again.
    if ((isGroupCall || !!streamRoomParam) && streamCallId && me?._id) {
      void reportParticipantStatus({
        streamRoom: String(streamCallId),
        identity: String(me._id),
        status: 'declined',
        displayName: String(me?.name || me?.displayName || ''),
      });
    }
    callHost.end();
  }, [callId, declineCall, isGroupCall, streamRoomParam, streamCallId, me]);

  const hangup = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    // iter-427: play the "Ciaooo" call-end tone to the leaving participant.
    // 1:1 → both sides run hangup (local End, or remote-ended via CallUI's
    // onHangup) so both hear it; group → only the member who leaves runs it.
    // Gated on everConnectedRef (sticky) so an unanswered/cancelled ring stays
    // silent, while the side that didn't tap End still plays it even though the
    // remote (and thus live remoteConnected) has already gone.
    if (everConnectedRef.current) playCiaoOnce();
    // Group call: tell everyone I've LEFT (so my roster tag flips Joined→Left
    // and a Dial-again affordance appears per the number-visibility rules).
    // Only when I actually connected — an unanswered/cancelled ring is handled
    // by the missed-call path instead.
    // Conference call (group OR a direct call I was added into): tell everyone
    // I've LEFT (so my roster tag flips Joined→Left and a Dial-again affordance
    // appears per the number-visibility rules). `streamRoomParam` marks that I
    // joined via an add-participant invite, so this fires for added people too
    // — not only group-conversation calls. Only when I actually connected.
    if ((isGroupCall || !!streamRoomParam) && everConnectedRef.current && streamCallId && me?._id) {
      void reportParticipantStatus({
        streamRoom: String(streamCallId),
        identity: String(me._id),
        status: 'left',
        displayName: String(me?.name || me?.displayName || ''),
      });
    }
    const cid = liveCallIdRef.current || callId;
    if (cid) void endCall({ callId: String(cid) }).catch(() => {});
    try {
      call?.leave();
    } catch {}
    callHost.end();
  }, [callId, call, endCall, isGroupCall, streamRoomParam, streamCallId, me, playCiaoOnce]);

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
            <View style={styles.waitingBadge}>
              <Ionicons name={waitingIsVideo ? 'videocam' : 'call'} size={18} color={Colors.white} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.waitingLabel}>Incoming {waitingIsVideo ? 'video' : 'voice'} call</Text>
              <Text style={styles.waitingName} numberOfLines={1}>
                {waitingName}
              </Text>
            </View>
          </View>
          <Text style={styles.waitingHint}>Answering will end your current call.</Text>
          <View style={styles.waitingActions}>
            <TouchableOpacity
              style={[styles.waitingBtn, styles.waitingDecline]}
              activeOpacity={0.85}
              onPress={declineWaiting}
              testID="stream-call-waiting-decline"
            >
              <Ionicons name="close" size={18} color={Colors.white} />
              <Text style={styles.waitingBtnText}>Decline</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.waitingBtn, styles.waitingAccept]}
              activeOpacity={0.85}
              onPress={acceptWaiting}
              testID="stream-call-waiting-accept"
            >
              <MaterialCommunityIcons name="phone-check" size={18} color={Colors.white} />
              <Text style={styles.waitingBtnText}>End &amp; Answer</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    ) : null;

  if (isIncomingPending) {
    return (
      <View style={styles.loading}>
        <CallBackground variant="incoming" />
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
        <CallBackground variant="incoming" />
        <ActivityIndicator color={Colors.primary} size="large" />
        <Text style={styles.loadingText}>{isCaller ? 'Calling…' : 'Connecting…'}</Text>
        <Text style={styles.loadingName} numberOfLines={1}>
          {resolvedPeerName}
        </Text>
        {showRetry ? (
          <>
            <Text style={styles.loadingHint}>Taking longer than usual…</Text>
            <TouchableOpacity style={styles.retryPill} onPress={retryJoin} testID="call-retry">
              <Ionicons name="refresh" size={18} color={Colors.white} />
              <Text style={styles.retryPillText}>Retry</Text>
            </TouchableOpacity>
          </>
        ) : null}
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
            isGroupCall={isGroupCall}
            isGroupAdmin={isGroupAdmin}
            adminIdentities={adminIdentities}
            conversationName={conversationName}
            onConnectedChange={handleConnectedChange}
            onEnding={playCiaoOnce}
            isAddedParticipant={!!streamRoomParam}
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
  loadingHint: { color: '#9CA3AF', fontSize: 14, marginTop: 18 },
  retryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: Colors.primary,
    minHeight: 44,
  },
  retryPillText: { color: Colors.white, fontSize: 16, fontWeight: '700' },

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
  waitingBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waitingLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  waitingName: { color: Colors.white, fontSize: 17, fontWeight: '700', marginTop: 1 },
  waitingHint: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 10 },
  waitingActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  waitingBtn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  waitingAccept: { backgroundColor: '#22C55E' },
  waitingDecline: { backgroundColor: '#EF4444' },
  waitingBtnText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  remoteArea: { ...StyleSheet.absoluteFillObject },
  gridWrap: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#000' },
  gridTile: { padding: 5 },
  gridTileInner: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#0B0B0B',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  gridTileSpeaking: { borderWidth: 2, borderColor: '#34C759' },
  gridFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#161616' },
  gridAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridAvatarSpeaking: { borderWidth: 3, borderColor: '#34C759' },
  gridAvatarText: { color: Colors.white, fontSize: 28, fontWeight: '700' },
  gridNameBadge: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    maxWidth: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  gridNameText: { color: Colors.white, fontSize: 12, fontWeight: '600' },
  pagerDots: {
    position: 'absolute',
    bottom: 8,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  pagerDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.35)' },
  pagerDotActive: { backgroundColor: Colors.white, width: 9, height: 9, borderRadius: 5 },
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
  avatarBigSpeaking: { borderWidth: 4, borderColor: '#34C759' },
  peerNameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', maxWidth: '86%' },
  peerName: { color: Colors.white, fontSize: 24, fontWeight: '700' },
  statusText: { color: '#9CA3AF', fontSize: 16, marginTop: 8 },
  topBar: { position: 'absolute', top: 56, left: 0, right: 0, alignItems: 'center' },
  topNameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', maxWidth: '86%' },
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
    width: 124,
    height: 176,
    borderRadius: 14,
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
  rosterRedialBtn: { padding: 4, marginRight: 2 },
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

  // ── Group-call waiting strip + status UI (Phase 2) ──────────────────────
  waitStrip: { position: 'absolute', top: 92, left: 0, right: 0 },
  waitStripContent: { paddingHorizontal: 12, gap: 8, alignItems: 'center' },
  waitChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  waitDot: { width: 8, height: 8, borderRadius: 4 },
  waitChipName: { color: Colors.white, fontSize: 13, fontWeight: '600', maxWidth: 110 },
  waitChipStatus: { fontSize: 11, fontWeight: '700' },
  waitAgainChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  waitAgainText: { color: Colors.white, fontSize: 13, fontWeight: '700' },
  permToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'stretch',
    paddingVertical: 10,
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  permToggleText: { color: Colors.white, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  rosterAgainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 14,
    paddingVertical: 12,
    marginTop: 12,
  },
  rosterStatusWrap: { flexDirection: 'row', alignItems: 'center', gap: 5, marginRight: 6 },
  rosterStatusText: { fontSize: 12, fontWeight: '700' },
  addReqBanner: {
    position: 'absolute',
    top: 140,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(20,20,20,0.92)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  addReqTextWrap: { flex: 1 },
  addReqTitle: { color: Colors.white, fontSize: 13, fontWeight: '700' },
  addReqSub: { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 1 },
  addReqBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  addReqApprove: { backgroundColor: '#34C759' },
  addReqDecline: { backgroundColor: 'rgba(255,255,255,0.18)' },
});
