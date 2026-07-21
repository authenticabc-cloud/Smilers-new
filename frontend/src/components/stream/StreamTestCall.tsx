/**
 * StreamTestCall — isolated Stream Video 1:1 connection test (NATIVE ONLY).
 *
 * Purpose: validate that Stream's media/connection layer works on a real device
 * build BEFORE we wire it under the full production call screen. Two devices
 * (or two accounts) enter the SAME room code and should see/hear each other.
 *
 * Uses the exact hybrid pattern (integration playbook): shared deterministic
 * call id, ring:false + notify:false (NO Stream ringing — Ashwini's FCM doorbell
 * owns ringing), custom UI via StreamCall + useCallStateHooks + ParticipantView.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
// @ts-expect-error — native-only Stream SDK, resolved in the dev/prod build
import {
  StreamVideo,
  StreamCall,
  ParticipantView,
  useCall,
  useCallStateHooks,
  CallingState,
} from '@stream-io/video-react-native-sdk';
import { createStreamVideoClient } from '../../lib/stream/streamClient';
import { Colors } from '../../theme';

function fmt(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** In-call UI once the Stream call object exists. */
function CallUI({ isVideo, onEnd }: { isVideo: boolean; onEnd: () => void }) {
  const call = useCall();
  const { useCallCallingState, useRemoteParticipants, useLocalParticipant } = useCallStateHooks();
  const callingState = useCallCallingState();
  const remoteParticipants = useRemoteParticipants();
  const local = useLocalParticipant();

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(isVideo);
  const [seconds, setSeconds] = useState(0);
  const wasConnectedRef = useRef(false);

  const remote = remoteParticipants[0];
  const connected = callingState === CallingState.JOINED && !!remote;

  // Enable mic + (for video) camera on mount.
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

  // Call timer starts once the remote joins.
  useEffect(() => {
    if (!connected) return;
    wasConnectedRef.current = true;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [connected]);

  // End the screen when the remote leaves after having been connected.
  useEffect(() => {
    if (wasConnectedRef.current && remoteParticipants.length === 0) {
      onEnd();
    }
  }, [remoteParticipants.length, onEnd]);

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

  const hangup = useCallback(async () => {
    try {
      await call?.leave();
    } catch {}
    onEnd();
  }, [call, onEnd]);

  return (
    <View style={styles.callRoot}>
      {/* Remote video (or avatar placeholder) */}
      <View style={styles.remoteArea}>
        {isVideo && remote ? (
          <ParticipantView participant={remote} style={StyleSheet.absoluteFill as any} />
        ) : (
          <View style={styles.centerFill}>
            <View style={styles.avatarBig}>
              <Ionicons name="person" size={64} color={Colors.white} />
            </View>
            <Text style={styles.statusText}>
              {connected
                ? isVideo
                  ? 'Connected'
                  : `In call · ${fmt(seconds)}`
                : callingState === CallingState.JOINED
                  ? 'Waiting for the other side to join…'
                  : 'Connecting…'}
            </Text>
            {connected && isVideo ? <Text style={styles.timerText}>{fmt(seconds)}</Text> : null}
          </View>
        )}
      </View>

      {/* Local self-view (video only) */}
      {isVideo && camOn && local ? (
        <View style={styles.selfView}>
          <ParticipantView participant={local} style={StyleSheet.absoluteFill as any} />
        </View>
      ) : null}

      {/* Controls */}
      <SafeAreaView edges={['bottom']} style={styles.controlsWrap}>
        <View style={styles.controlsRow}>
          <TouchableOpacity style={[styles.ctrl, !micOn && styles.ctrlOff]} onPress={toggleMic}>
            <Ionicons name={micOn ? 'mic' : 'mic-off'} size={26} color={Colors.white} />
          </TouchableOpacity>
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
          <TouchableOpacity style={[styles.ctrl, styles.ctrlEnd]} onPress={hangup}>
            <Ionicons name="call" size={26} color={Colors.white} style={{ transform: [{ rotate: '135deg' }] }} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

export default function StreamTestCall() {
  const [client, setClient] = useState<any>(undefined);
  const [call, setCall] = useState<any>(null);
  const [room, setRoom] = useState('');
  const [isVideo, setIsVideo] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const c = await createStreamVideoClient();
        if (mounted) setClient(c);
      } catch (e: any) {
        if (mounted) setError(e?.message || 'Failed to init Stream client');
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const startTest = useCallback(async () => {
    if (!client) {
      setError('Stream client not ready (are you signed in?)');
      return;
    }
    const id = room.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) {
      setError('Enter a room code (both devices must type the same code)');
      return;
    }
    setError(null);
    setJoining(true);
    try {
      const c = client.call('default', id);
      const myId = client.streamClient?._user?.id || client._user?.id || '';
      await c.getOrCreate({
        ring: false,
        notify: false,
        data: { custom: { room: id, video: isVideo }, members: myId ? [{ user_id: myId }] : [] },
      });
      await c.join();
      setCall(c);
    } catch (e: any) {
      setError(e?.message || 'Could not join the test call');
      setJoining(false);
    }
  }, [client, room, isVideo]);

  const endCall = useCallback(() => {
    try {
      call?.leave?.();
    } catch {}
    setCall(null);
    setJoining(false);
  }, [call]);

  // In a call → render the Stream context + UI.
  if (client && call) {
    return (
      <StreamVideo client={client}>
        <StreamCall call={call}>
          <CallUI isVideo={isVideo} onEnd={endCall} />
        </StreamCall>
      </StreamVideo>
    );
  }

  // Lobby / setup screen.
  return (
    <SafeAreaView style={styles.lobby}>
      <Text style={styles.title}>Stream connection test</Text>
      <Text style={styles.subtitle}>
        Enter the SAME room code on two devices (or two accounts) and tap Connect. You should see/hear
        each other. This tests only the Stream media connection.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="Room code (e.g. test123)"
        placeholderTextColor={Colors.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        value={room}
        onChangeText={setRoom}
        editable={!joining}
      />

      <View style={styles.modeRow}>
        <TouchableOpacity
          style={[styles.modeBtn, !isVideo && styles.modeBtnActive]}
          onPress={() => setIsVideo(false)}
          disabled={joining}
        >
          <Ionicons name="call" size={18} color={Colors.white} />
          <Text style={styles.modeBtnText}>Voice</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeBtn, isVideo && styles.modeBtnActive]}
          onPress={() => setIsVideo(true)}
          disabled={joining}
        >
          <Ionicons name="videocam" size={18} color={Colors.white} />
          <Text style={styles.modeBtnText}>Video</Text>
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.connectBtn, (joining || !client) && styles.connectBtnDisabled]}
        onPress={startTest}
        disabled={joining || !client}
      >
        {joining ? (
          <ActivityIndicator color={Colors.white} />
        ) : (
          <Text style={styles.connectText}>{client ? 'Connect' : 'Preparing…'}</Text>
        )}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  lobby: { flex: 1, backgroundColor: '#0B0B0B', padding: 24, justifyContent: 'center' },
  title: { color: Colors.white, fontSize: 24, fontWeight: '700', marginBottom: 8 },
  subtitle: { color: '#9CA3AF', fontSize: 14, lineHeight: 20, marginBottom: 24 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: Colors.white,
    fontSize: 16,
    marginBottom: 16,
  },
  modeRow: { flexDirection: 'row', gap: 12, marginBottom: 24 },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  modeBtnActive: { backgroundColor: Colors.primary },
  modeBtnText: { color: Colors.white, fontWeight: '600' },
  error: { color: '#F87171', marginBottom: 16, fontSize: 14 },
  connectBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  connectBtnDisabled: { opacity: 0.6 },
  connectText: { color: Colors.white, fontSize: 17, fontWeight: '700' },

  callRoot: { flex: 1, backgroundColor: '#000' },
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
  statusText: { color: Colors.white, fontSize: 18, fontWeight: '600' },
  timerText: { color: Colors.textSecondary, fontSize: 16, marginTop: 8 },
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
    justifyContent: 'center',
    gap: 20,
    paddingVertical: 28,
  },
  ctrl: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlOff: { backgroundColor: 'rgba(255,255,255,0.4)' },
  ctrlEnd: { backgroundColor: '#EF4444' },
});
