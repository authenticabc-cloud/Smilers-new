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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchTwilioToken, endTwilioCall } from '../src/lib/twilio/twilioApi';
import { useTwilioCallSession } from '../src/lib/twilio/useTwilioCallSession';
import { recordDiagnostic } from '../src/lib/diagnostics';
import { Colors } from '../src/theme';

export default function TwilioCallScreen() {
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
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const roomName = String(params.room || '');
  const identity = String(params.identity || '');
  const isVideo = String(params.isVideo || '1') === '1';
  const isCaller = String(params.isCaller || '0') === '1';
  const title = String(params.title || roomName);
  const region = process.env.EXPO_PUBLIC_TWILIO_REGION || 'ie1';

  const [token, setToken] = useState<string | null>(params.token ? String(params.token) : null);
  const [fetchError, setFetchError] = useState<string | null>(null);

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

  const enabled = Boolean(token && roomName && identity);
  const host = useTwilioCallSession({
    identity,
    roomName,
    token: token || '',
    isVideo,
    isCaller,
    region,
    enabled,
  });

  // Local UI state for mute / video / speaker buttons.
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(isVideo);
  const [speakerOn, setSpeakerOn] = useState(isVideo); // default speaker on for video

  // iter-216: auto-close the call screen when the call ends remotely.
  // Once the room is completed (caller hung up / callee declined →
  // /api/twilio/end-call), Twilio disconnects us — but nothing was
  // navigating the receiver away, so they were stranded on a dead
  // "Connecting…"/call view. When our session reaches a terminal state
  // AFTER having been active, leave the screen. Guarded so an initial
  // 'failed' (e.g. web stub) never triggers it.
  const navigatedRef = useRef(false);
  const wasActiveRef = useRef(false);
  const closeScreen = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  useEffect(() => {
    if (host.state === 'connecting' || host.state === 'connected' || host.state === 'reconnecting') {
      wasActiveRef.current = true;
    }
    if ((host.state === 'disconnected' || host.state === 'failed') && wasActiveRef.current) {
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

  useEffect(() => {
    if (host.session && host.state === 'connected') {
      // Apply initial speaker preference once we're in the room.
      try {
        host.session.setSpeakerOn(speakerOn);
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.state]);

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

  const handleSpeaker = () => {
    const next = !speakerOn;
    setSpeakerOn(next);
    host.session?.setSpeakerOn(next);
  };

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
              {host.state === 'connecting' ? 'Connecting…' : host.state === 'connected' ? 'Waiting for others to join…' : host.state}
            </Text>
          </View>
        ) : (
          host.participants.map((p) => {
            // iter-228: render the remote video tile whenever the participant
            // has a video track — this includes a SHARED SCREEN even during a
            // voice call (previously gated on `isVideo`, so a screen share on a
            // voice call never appeared on the receiver).
            const remote = p.videoTrackSid
              ? host.renderParticipantView(p, styles.remoteVideo)
              : null;
            return remote ? (
              <View key={p.sid} style={styles.remoteVideo}>
                {remote}
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

      {/* Local self-view (PiP top-right) — only when video on */}
      {isVideo && videoOn ? (
        <View style={[styles.localPip, { top: insets.top + 12 }]}>
          {host.renderLocalView(styles.localPipInner, videoOn)}
        </View>
      ) : null}

      {/* Top header */}
      <View style={[styles.header, { top: insets.top + 8 }]}>
        <Text style={styles.titleText} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.subTitle}>
          {host.state}
          {host.participants.length > 0 ? `  •  ${host.participants.length} participant${host.participants.length === 1 ? '' : 's'}` : ''}
        </Text>
      </View>

      {/* Bottom controls */}
      <View style={[styles.controls, { paddingBottom: insets.bottom + 20 }]}>
        <ControlBtn icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} onPress={handleMute} active={muted} />
        {isVideo ? (
          <ControlBtn icon={videoOn ? 'video' : 'video-off'} label={videoOn ? 'Stop video' : 'Start video'} onPress={handleVideo} active={!videoOn} />
        ) : null}
        {isVideo ? (
          <ControlBtn icon="rotate-cw" label="Flip" onPress={handleFlip} />
        ) : (
          <ControlBtn icon={speakerOn ? 'volume-2' : 'volume'} label="Speaker" onPress={handleSpeaker} active={speakerOn} />
        )}
        <ControlBtn
          icon="monitor"
          label={host.screenShareState === 'on' ? 'Stop share' : 'Share'}
          onPress={handleScreenShare}
          active={host.screenShareState === 'on'}
        />
        <Pressable onPress={handleHangup} style={[styles.controlBtn, styles.hangupBtn]}>
          <Feather name="phone-off" size={24} color="#fff" />
          <Text style={styles.hangupLabel}>End</Text>
        </Pressable>
      </View>
    </View>
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
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 8,
  },
  controlBtn: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  controlBtnActive: { backgroundColor: '#fff' },
  controlLabel: { fontSize: 9, color: '#fff', marginTop: 1 },
  controlLabelActive: { color: '#222' },
  hangupBtn: { backgroundColor: '#e63946' },
  hangupLabel: { fontSize: 9, color: '#fff', marginTop: 1 },
  errorText: { color: '#ff8a8a', fontSize: 15, textAlign: 'center', marginVertical: 12 },
  backBtn: { backgroundColor: Colors.primary, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8, alignSelf: 'center' },
  backBtnText: { color: Colors.white, fontWeight: '600' },
});
