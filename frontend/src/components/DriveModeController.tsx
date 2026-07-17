import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import { useConvex, useMutation, useQuery } from 'convex/react';
import { createAudioPlayer, type AudioPlayer, type AudioSource } from 'expo-audio';
import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { Colors } from '../theme';
import { DRIVE_DECLINE_REPLY, useDriveMode } from '../lib/driveMode';

// Lazy require so the app still bundles if the native module isn't present.
let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: any = (_e: string, _cb: any) => {};
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('expo-speech-recognition');
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule;
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent;
} catch {
  ExpoSpeechRecognitionModule = null;
}

// While actively in a call the microphone belongs to the call, so we pause
// Drive listening on those routes (the incoming-call RING screen is fine).
const CALL_ROUTE_PREFIXES = ['/twilio-call', '/group-call'];

type CmdKind = 'answer' | 'decline' | 'reject' | 'listen' | 'watch' | null;

function matchCommand(raw: string): CmdKind {
  const t = ` ${raw.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const has = (w: string) => t.includes(` ${w} `);
  if (has('reject')) return 'reject';
  if (has('decline')) return 'decline';
  if (has('answer') || t.includes(' pick up ') || has('pickup') || has('accept')) return 'answer';
  if (has('watch') || t.includes(' play video ')) return 'watch';
  if (has('listen') || t.includes(' play voice ') || t.includes(' play audio ') || t.includes(' play message ') || t.includes(' play the message ')) {
    return 'listen';
  }
  return null;
}

/**
 * DriveModeController — mounted once globally. When Drive Mode is ON it runs a
 * single continuous speech recognizer and maps command words to actions for
 * ALL incoming calls/messages. Shows a status banner, plays voice notes inline,
 * and pops a full-screen player for "watch".
 */
export default function DriveModeController() {
  const enabled = useDriveMode();
  const { isAuthenticated } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const convex = useConvex();
  const insets = useSafeAreaInsets();

  const inCall = CALL_ROUTE_PREFIXES.some((p) => (pathname || '').startsWith(p));
  const active = enabled && isAuthenticated && !inCall && !!ExpoSpeechRecognitionModule;

  const incomingCall = useQuery(
    (api as any).calls.getIncomingCall,
    active ? {} : 'skip',
  ) as any;

  const declineCall = useMutation((api as any).calls.declineCall);
  const answerInvite = useMutation((api as any).callInvites.answerInvite);
  const declineInvite = useMutation((api as any).callInvites.declineInvite);
  const sendMessage = useMutation((api as any).messages.send);

  const [status, setStatus] = useState('Listening…');
  const [videoUri, setVideoUri] = useState<string | null>(null);

  const activeRef = useRef(active);
  const sessionRef = useRef(false);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCmdAt = useRef(0);
  const lastText = useRef('');
  const incomingRef = useRef<any>(null);
  const audioRef = useRef<AudioPlayer | null>(null);
  const flash = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    incomingRef.current = incomingCall;
  }, [incomingCall]);

  const setFlash = useCallback((msg: string, spoken?: string) => {
    setStatus(msg);
    if (flash.current) clearTimeout(flash.current);
    flash.current = setTimeout(() => setStatus('Listening…'), 4000);
    // Spoken confirmation so the driver never needs to look at the screen.
    try {
      Speech.stop();
      Speech.speak(spoken ?? msg, { rate: 1.0, pitch: 1.0 });
    } catch {
      /* TTS is best-effort */
    }
  }, []);

  // Announce Drive Mode turning on/off.
  const prevEnabled = useRef(enabled);
  useEffect(() => {
    if (enabled !== prevEnabled.current) {
      prevEnabled.current = enabled;
      try {
        Speech.stop();
        Speech.speak(enabled ? 'Drive Mode on' : 'Drive Mode off', { rate: 1.0 });
      } catch {}
    }
  }, [enabled]);

  // ---- speech recognizer lifecycle -----------------------------------------
  const startRec = useCallback(async () => {
    if (!activeRef.current || sessionRef.current || !ExpoSpeechRecognitionModule) return;
    try {
      const perm = await ExpoSpeechRecognitionModule.getPermissionsAsync?.();
      if (perm && perm.granted === false) {
        const req = await ExpoSpeechRecognitionModule.requestPermissionsAsync?.();
        if (req && req.granted === false) {
          setStatus('Microphone permission needed');
          return;
        }
      }
      sessionRef.current = true;
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: true,
      });
    } catch {
      sessionRef.current = false;
    }
  }, []);

  const stopRec = useCallback(() => {
    sessionRef.current = false;
    try {
      ExpoSpeechRecognitionModule?.stop?.();
    } catch {}
    if (restartTimer.current) clearTimeout(restartTimer.current);
  }, []);

  const scheduleRestart = useCallback(() => {
    sessionRef.current = false;
    if (!activeRef.current) return;
    if (restartTimer.current) clearTimeout(restartTimer.current);
    restartTimer.current = setTimeout(() => startRec(), 500);
  }, [startRec]);

  useEffect(() => {
    activeRef.current = active;
    if (active) {
      setStatus('Listening…');
      startRec();
    } else {
      stopRec();
    }
    return () => stopRec();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ---- command actions ------------------------------------------------------
  const playVoice = useCallback(async () => {
    try {
      const media = await convex.query((api as any).messages.getLatestIncomingMedia, { mediaType: 'voice' });
      if (!media?.url) {
        setFlash('No new voice note');
        return;
      }
      try {
        audioRef.current?.remove();
      } catch {}
      const p = createAudioPlayer({ uri: media.url } as AudioSource);
      audioRef.current = p;
      p.play();
      setFlash(`Playing voice note from ${media.senderName || 'contact'}`);
    } catch {
      setFlash('Could not play voice note');
    }
  }, [convex, setFlash]);

  const playVideo = useCallback(async () => {
    try {
      const media = await convex.query((api as any).messages.getLatestIncomingMedia, { mediaType: 'video' });
      if (!media?.url) {
        setFlash('No new video message');
        return;
      }
      setVideoUri(media.url);
      setFlash(`Playing video from ${media.senderName || 'contact'}`);
    } catch {
      setFlash('Could not play video');
    }
  }, [convex, setFlash]);

  const doAnswer = useCallback(() => {
    const call = incomingRef.current;
    if (!call) {
      setFlash('No incoming call');
      return;
    }
    setFlash('Answering…');
    if (call.inviteId) {
      void answerInvite({ inviteId: call.inviteId }).catch(() => {});
      router.push(`/group-call/${call.conversationId}` as any);
      return;
    }
    // Route through the proven incoming-call screen (resolves the room from
    // Convex and calls answerCall internally, then joins the Twilio room).
    const q =
      `/incoming-call?autoAnswer=1` +
      `&convexCallId=${encodeURIComponent(String(call._id))}` +
      `&conversationId=${encodeURIComponent(String(call.conversationId))}` +
      `&isVideo=${call.callType === 'video' ? '1' : '0'}` +
      `&callerName=${encodeURIComponent(String(call.callerName || 'Smilers user'))}` +
      (call.callerAvatar ? `&callerAvatar=${encodeURIComponent(String(call.callerAvatar))}` : '');
    router.push(q as any);
  }, [answerInvite, router, setFlash]);

  const doDecline = useCallback(
    (withMessage: boolean) => {
      const call = incomingRef.current;
      if (!call) {
        setFlash('No incoming call');
        return;
      }
      setFlash(withMessage ? 'Declining + replying…' : 'Rejecting…', withMessage ? 'Declining and sending your reply' : 'Call rejected');
      if (call.inviteId) {
        void declineInvite({ inviteId: call.inviteId }).catch(() => {});
      } else {
        void declineCall({ callId: String(call._id) }).catch(() => {});
      }
      if (withMessage && call.conversationId) {
        void sendMessage({
          conversationId: call.conversationId,
          type: 'text',
          text: DRIVE_DECLINE_REPLY,
        }).catch(() => {});
      }
    },
    [declineCall, declineInvite, sendMessage, setFlash],
  );

  const runCommand = useCallback(
    (kind: CmdKind) => {
      if (!kind) return;
      const now = Date.now();
      if (now - lastCmdAt.current < 3500) return; // debounce repeated hits
      lastCmdAt.current = now;
      switch (kind) {
        case 'answer':
          doAnswer();
          break;
        case 'decline':
          doDecline(true);
          break;
        case 'reject':
          doDecline(false);
          break;
        case 'listen':
          void playVoice();
          break;
        case 'watch':
          void playVideo();
          break;
      }
    },
    [doAnswer, doDecline, playVoice, playVideo],
  );

  // ---- recognizer events (hooks must always run) ----------------------------
  useSpeechRecognitionEvent('result', (event: any) => {
    if (!activeRef.current) return;
    const text = event?.results?.[0]?.transcript || '';
    if (!text || text === lastText.current) return;
    const cmd = matchCommand(text);
    if (cmd) {
      lastText.current = text;
      runCommand(cmd);
    }
  });
  useSpeechRecognitionEvent('end', () => scheduleRestart());
  useSpeechRecognitionEvent('error', () => scheduleRestart());

  useEffect(() => {
    return () => {
      try {
        audioRef.current?.remove();
      } catch {}
      try {
        Speech.stop();
      } catch {}
      if (flash.current) clearTimeout(flash.current);
    };
  }, []);

  if (!active && !videoUri) return null;

  return (
    <>
      {active ? (
        <View style={[styles.banner, { top: insets.top + 6 }]} pointerEvents="none">
          <MaterialCommunityIcons name="steering" size={15} color={Colors.white} />
          <Text style={styles.bannerText} numberOfLines={1}>
            Drive Mode • {status}
          </Text>
        </View>
      ) : null}
      {videoUri ? <DriveVideoOverlay uri={videoUri} onClose={() => setVideoUri(null)} /> : null}
    </>
  );
}

function DriveVideoOverlay({ uri, onClose }: { uri: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <View style={styles.videoOverlay}>
      <VideoView style={styles.video} player={player} allowsFullscreen contentFit="contain" />
      <TouchableOpacity
        style={[styles.videoClose, { top: insets.top + 10 }]}
        onPress={onClose}
        testID="drive-video-close"
      >
        <MaterialCommunityIcons name="close" size={26} color={Colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(22,163,74,0.95)',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
    zIndex: 200,
  },
  bannerText: { color: Colors.white, fontWeight: '700', fontSize: 13, flexShrink: 1 },
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 300,
    justifyContent: 'center',
  },
  video: { width: '100%', height: '100%' },
  videoClose: {
    position: 'absolute',
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
