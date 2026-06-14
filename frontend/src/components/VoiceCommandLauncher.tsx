import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import { useConvex, useMutation } from 'convex/react';
import { useAudioRecorder, useAudioRecorderState, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { readStoredJson, writeStoredJson } from '../lib/settingsStorage';
import { parseVoiceCommand, isStopCommand, VoiceCommand } from '../lib/voiceCommandParser';
import { uploadFile } from '../lib/uploadFile';
import { triggerTranscription } from '../lib/triggerTranscription';
import { subscribeTouchActivity } from '../lib/touchActivity';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../theme';

// Lazy/web-safe load of the speech-recognition native module. On web the
// package may not have an implementation; we still want the rest of the app
// to bundle cleanly. Falls back to a no-op shape.
let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: any = (_event: string, _cb: any) => {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('expo-speech-recognition');
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule;
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent;
} catch {
  ExpoSpeechRecognitionModule = null;
}

const VOICE_TASKS_STORAGE_KEY = 'smilers_voice_task_contacts_v1';

interface Assignment {
  position: number;
  contactId: string;
  name: string;
  avatar?: string | null;
  phone?: string | null;
}

type AssignmentMap = Record<number, Assignment>;

type FlowState = 'idle' | 'listening' | 'recognized' | 'no-match' | 'error' | 'recording-voice' | 'sending';

interface VoiceCommandSheetProps {
  visible: boolean;
  onClose: () => void;
}

function VoiceCommandSheetInner({ visible, onClose }: VoiceCommandSheetProps) {
  const router = useRouter();
  const convex = useConvex();
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const [transcript, setTranscript] = useState('');
  const [flow, setFlow] = useState<FlowState>('idle');
  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [parsedCommand, setParsedCommand] = useState<VoiceCommand | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  // iter-202: hands-free voice-note recording state. We open the recorder
  // INSIDE the sheet for `voice_note` commands so the user never leaves
  // the launcher — exactly like the web `voice-task-commander` overlay.
  const [recordingTarget, setRecordingTarget] = useState<{
    conversationId: string;
    name: string;
  } | null>(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder, 250);
  const recordingStartedAtRef = useRef<number>(0);
  const sendMessage = useMutation(api.messages.send);
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(300)).current;
  const sessionActiveRef = useRef(false);
  // iter-202: refs to break the speech-recognition event race condition.
  // The native `end` event fires immediately after `result(isFinal)` on
  // Android — its closure captured the previous render's `flow` value
  // (`'listening'`) and overwrote the just-set `'recognized'` state with
  // `'no-match'`. We now atomically track "did we already commit a final
  // result?" via a ref the `end` handler can read synchronously.
  const finalHandledRef = useRef(false);
  const flowRef = useRef<FlowState>('idle');
  // Forward declarations for recording — defined later as useCallback;
  // we expose them through refs so the speech-recognition event
  // listeners (which close over a stale render) can always call the
  // freshest implementation.
  const stopRecordingAndSendRef = useRef<null | (() => void)>(null);
  const startRawListenerRef = useRef<null | (() => void)>(null);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);

  // Slide-up animation
  useEffect(() => {
    if (visible) {
      slideAnim.setValue(300);
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [slideAnim, visible]);

  // Pulse animation while listening
  useEffect(() => {
    if (flow === 'listening') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 700,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0,
            duration: 700,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    pulseAnim.setValue(0);
    return undefined;
  }, [flow, pulseAnim]);

  // Load assignments when opened (fresh each session in case user changed them).
  // iter-165: local-first read for speed and offline robustness, then if the
  // local map is empty AND we have a Convex client, attempt to hydrate from
  // the canonical `api.voiceTaskContacts.getMyVoiceTaskContacts` query
  // (same shape used by /voice-tasks settings screen). This lets the FAB
  // work cross-device — e.g. user set their positions on the web app and
  // hasn't yet opened mobile Settings → Voice Tasks. NEVER overwrites a
  // non-empty local map (regulations: respect the user's local-first wishes
  // and the per-position mutation history). NEVER stores audio or transcript.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const saved = (await readStoredJson(VOICE_TASKS_STORAGE_KEY, null)) as AssignmentMap | null;
      if (cancelled) return;
      if (saved && Object.keys(saved).length > 0) {
        setAssignments(saved);
        return;
      }
      // Convex fallback — only when local is empty so we never override
      // user-curated mobile assignments with stale server state.
      try {
        const fn = (api as any).voiceTaskContacts?.getMyVoiceTaskContacts;
        if (!fn || !convex) return;
        const result = await convex.query(fn, {});
        if (cancelled) return;
        if (!Array.isArray(result)) return;
        const map: AssignmentMap = {};
        for (const item of result) {
          const position = Number(item?.position);
          if (!position || position < 1 || position > 10) continue;
          map[position] = {
            position,
            contactId: String(item?.contactId || item?.userId || ''),
            name: String(item?.name || 'Contact'),
            avatar: item?.avatar || null,
            phone: item?.phone || null,
          };
        }
        if (Object.keys(map).length === 0) return;
        setAssignments(map);
        // Mirror to local so subsequent sheet opens are instant + offline.
        try {
          await writeStoredJson(VOICE_TASKS_STORAGE_KEY, map);
        } catch {
          /* swallow */
        }
      } catch {
        /* swallow — Convex unreachable, local-first is good enough */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, visible]);

  // Reset state and stop recognition when closed
  useEffect(() => {
    if (!visible) {
      setTranscript('');
      setFlow('idle');
      setParsedCommand(null);
      setErrorMessage(null);
      setExecuting(false);
      setRecordingTarget(null);
      finalHandledRef.current = false;
      if (sessionActiveRef.current) {
        try {
          ExpoSpeechRecognitionModule?.stop();
        } catch {
          // ignore — module may not have started
        }
        sessionActiveRef.current = false;
      }
      // Abort any in-progress recording on close (don't send).
      if (recorderState.isRecording) {
        try { audioRecorder.stop(); } catch {}
      }
    }
    // We intentionally only depend on `visible` — recorder refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Live transcription event
  useSpeechRecognitionEvent('result', (event: any) => {
    const text = event.results?.[0]?.transcript || '';
    setTranscript(text);
    // iter-202: during hands-free recording, check the canonical
    // "smiley" stop-word on EVERY result (interim and final) so the
    // send fires with minimal latency — exactly like the web
    // commander's interim-result handler.
    if (flowRef.current === 'recording-voice' && isStopCommand(text)) {
      finalHandledRef.current = true;
      stopRecordingAndSendRef.current?.();
      return;
    }
    if (event.isFinal) {
      // iter-201: mark the ref synchronously BEFORE the `end` event
      // can fire — Android dispatches `end` immediately after
      // `result(isFinal)` and the previous closure-based check raced
      // with React's render.
      finalHandledRef.current = true;
      handleFinalTranscript(text);
    }
  });

  useSpeechRecognitionEvent('error', (event: any) => {
    sessionActiveRef.current = false;
    // iter-202: during recording, auto-restart the recognizer instead
    // of bailing out — the web app does the same (200ms restart).
    if (flowRef.current === 'recording-voice') {
      setTimeout(() => {
        try {
          startRawListenerRef.current?.();
        } catch {}
      }, 300);
      return;
    }
    finalHandledRef.current = true;
    setFlow('error');
    setErrorMessage(event.error || 'Could not recognize speech');
  });

  useSpeechRecognitionEvent('end', () => {
    sessionActiveRef.current = false;
    // iter-202: keep recognizer running during recording — auto-restart.
    if (flowRef.current === 'recording-voice') {
      setTimeout(() => {
        try {
          startRawListenerRef.current?.();
        } catch {}
      }, 200);
      return;
    }
    // iter-201: only fall back to "no-match" if we never received a
    // final result. Reading the ref (not state) makes this synchronous
    // and immune to the result→end render race that previously
    // overwrote a freshly-set 'recognized' state.
    if (!finalHandledRef.current && flowRef.current === 'listening') {
      setFlow('no-match');
    }
  });

  const handleFinalTranscript = useCallback(
    (text: string) => {
      const parsed = parseVoiceCommand(text);
      setParsedCommand(parsed);
      if (parsed) {
        setFlow('recognized');
      } else {
        setFlow('no-match');
      }
      try {
        ExpoSpeechRecognitionModule?.stop();
      } catch {
        // ignore
      }
      sessionActiveRef.current = false;
    },
    []
  );

  // iter-202: TRUE hands-free — auto-execute as soon as a command is
  // recognized. The web `voice-task-commander` runs the action
  // immediately on parse; we removed the "Go" confirmation step to
  // match. The stop_command case is the lone exception — when said
  // outside a recording session it's a no-op that just nudges the user.
  const executeCommandRef = useRef<null | (() => void)>(null);
  useEffect(() => {
    if (flow !== 'recognized') return;
    if (!parsedCommand) return;
    if (parsedCommand.type === 'stop_command') return; // handled separately
    const t = setTimeout(() => {
      try { executeCommandRef.current?.(); } catch {}
    }, 250); // tiny pause so the green check is visible
    return () => clearTimeout(t);
  }, [flow, parsedCommand]);

  const startListening = useCallback(async () => {
    setTranscript('');
    setParsedCommand(null);
    setErrorMessage(null);
    setFlow('listening');
    finalHandledRef.current = false;
    if (!ExpoSpeechRecognitionModule) {
      setFlow('error');
      setErrorMessage(
        Platform.OS === 'web'
          ? 'Voice commands work only on the installed mobile app, not on the web preview.'
          : 'Speech recognition is unavailable on this build.'
      );
      return;
    }
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        setFlow('error');
        setErrorMessage(
          'Microphone & speech recognition permission is required. Please grant access in your phone\'s settings.'
        );
        return;
      }
      sessionActiveRef.current = true;
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: false,
        requiresOnDeviceRecognition: false,
        addsPunctuation: false,
      });
    } catch (errorValue: any) {
      sessionActiveRef.current = false;
      setFlow('error');
      setErrorMessage(errorValue?.message || 'Could not start speech recognition');
    }
  }, []);

  // Auto-start listening when the sheet opens
  useEffect(() => {
    if (visible && flow === 'idle') {
      const id = setTimeout(() => startListening(), 250);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [flow, startListening, visible]);

  // iter-202: hands-free voice-note recording. After Convex creates/finds
  // the direct conversation we:
  //   1. Switch the sheet to its recording UI.
  //   2. Configure audio mode for recording + start the audio recorder.
  //   3. Re-arm the speech recognizer in continuous mode listening for
  //      the "smiley" stop-word (interim results, ~200ms restart loop —
  //      same behavior as the web commander).
  //   4. When `isStopCommand` fires (interim OR final), `stopRecordingAndSend`
  //      stops capture, uploads via the canonical `messages.generateUploadUrl`
  //      flow, and sends a `messages.send({ type: 'voice', ... })`.
  const startRawListener = useCallback(() => {
    if (!ExpoSpeechRecognitionModule) return;
    try {
      sessionActiveRef.current = true;
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: true,
        requiresOnDeviceRecognition: false,
        addsPunctuation: false,
      });
    } catch {
      sessionActiveRef.current = false;
    }
  }, []);
  useEffect(() => {
    startRawListenerRef.current = startRawListener;
  }, [startRawListener]);

  const stopRecordingAndSend = useCallback(async () => {
    if (!recordingTarget) return;
    if (flowRef.current === 'sending') return; // already in flight
    setFlow('sending');
    // Stop the recognizer.
    try {
      ExpoSpeechRecognitionModule?.stop();
    } catch {}
    sessionActiveRef.current = false;

    let uri: string | undefined;
    try {
      await audioRecorder.stop();
      uri = audioRecorder.uri || undefined;
    } catch {
      /* recorder may already be stopped */
    }
    const totalMs = Math.max(0, Date.now() - recordingStartedAtRef.current);
    if (!uri || totalMs < 600) {
      Alert.alert('Recording too short', 'Try saying a few more words before "Smiley".');
      setFlow('idle');
      setRecordingTarget(null);
      onClose();
      return;
    }
    try {
      const mime = 'audio/m4a';
      const storageId = await uploadFile(convex, uri, mime);
      const result: any = await sendMessage({
        conversationId: recordingTarget.conversationId as any,
        type: 'voice',
        storageId,
        mimeType: mime,
        duration: Math.max(1, Math.round(totalMs / 1000)),
        fileName: 'voice-task-note.m4a',
      });
      // iter-203: kick off Whisper transcription so the recipient's chat
      // doesn't sit stuck on "Transcribing…" forever. The normal chat
      // composer calls this after every voice send — our voice-task
      // path was silently skipping it.
      const messageId =
        (typeof result === 'string' && result) ||
        (result && (result._id || result.messageId)) ||
        null;
      if (messageId) {
        try {
          await triggerTranscription({
            convex,
            messageId: String(messageId),
            storageId: String(storageId),
            localFileUri: uri,
            fileName: 'voice-task-note.m4a',
          });
        } catch {
          // Transcription failure is non-fatal — the message is already sent.
        }
      }
    } catch (errorValue: any) {
      Alert.alert(
        'Couldn\u2019t send voice note',
        errorValue?.message || 'Please try again from the chat composer.'
      );
    }
    setRecordingTarget(null);
    setFlow('idle');
    onClose();
  }, [audioRecorder, convex, onClose, recordingTarget, sendMessage]);
  useEffect(() => {
    stopRecordingAndSendRef.current = stopRecordingAndSend;
  }, [stopRecordingAndSend]);

  const executeCommand = useCallback(async () => {
    if (!parsedCommand || executing) return;
    // stop_command on its own (no active recording) — just nudge the user.
    if (parsedCommand.type === 'stop_command') {
      Alert.alert(
        'Say a command first',
        '"Smiley" sends a recorded voice note. Try saying "Call 1" or "Voice note to 2" first.'
      );
      onClose();
      return;
    }
    const position = parsedCommand.position;
    const assignment = assignments[position];
    if (!assignment) {
      Alert.alert(
        `No contact at position ${position}`,
        'Open Settings \u2192 Voice Tasks to assign a contact to this number first.'
      );
      onClose();
      return;
    }

    // Resolve the user → conversation. SAME canonical mutation the web
    // commander uses (`getOrCreateDirect({ otherUserId })`) and that
    // every other entry point on native uses (contact card, search,
    // share-receiver, user profile). Without this the /call and /chat
    // routes can't find the conversation.
    setExecuting(true);
    let conversationId: string | null = null;
    try {
      const result: any = await getOrCreateDirect({ otherUserId: assignment.contactId as any });
      const rawId = result?._id || result?.conversationId || result?.id || result;
      if (typeof rawId === 'string' && rawId.length > 0) conversationId = rawId;
    } catch (errorValue: any) {
      setExecuting(false);
      Alert.alert(
        'Couldn\u2019t reach this contact',
        errorValue?.message ||
          'We couldn\u2019t open a chat with this contact. Please check your connection and try again.'
      );
      return;
    }
    if (!conversationId) {
      setExecuting(false);
      Alert.alert(
        'Couldn\u2019t reach this contact',
        'The contact assigned to this slot couldn\u2019t be opened. Please re-assign them in Settings \u2192 Voice Tasks.'
      );
      return;
    }

    const encodedConv = encodeURIComponent(conversationId);
    const displayName = encodeURIComponent(assignment.name);
    switch (parsedCommand.type) {
      case 'voice_call':
        router.push(`/call/${encodedConv}?type=voice&displayName=${displayName}` as any);
        setExecuting(false);
        onClose();
        return;
      case 'video_call':
        router.push(`/call/${encodedConv}?type=video&displayName=${displayName}` as any);
        setExecuting(false);
        onClose();
        return;
      case 'share_location':
        router.push(`/share-location/${encodedConv}` as any);
        setExecuting(false);
        onClose();
        return;
      case 'video_message':
        // Hands-free video in-sheet is a follow-up (needs camera surface).
        // For now we open the chat with the video-note intent flag — the
        // chat composer auto-starts video capture.
        router.push(`/chat/${encodedConv}?action=video-note` as any);
        setExecuting(false);
        onClose();
        return;
      case 'voice_note': {
        // Hands-free voice-note recording, in-sheet. Mirrors the web
        // commander's overlay behavior.
        try {
          if (ExpoSpeechRecognitionModule) {
            const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
            if (!perm?.granted) {
              setExecuting(false);
              Alert.alert(
                'Microphone & speech permission required',
                'We need both microphone and speech recognition to record voice notes hands-free.'
              );
              return;
            }
          }
          await setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
            interruptionMode: 'duckOthers',
            shouldRouteThroughEarpiece: false,
          });
          // Stop any prior recognizer session first.
          try { ExpoSpeechRecognitionModule?.stop(); } catch {}
          sessionActiveRef.current = false;
          // Start audio capture.
          await audioRecorder.prepareToRecordAsync();
          await audioRecorder.record();
          recordingStartedAtRef.current = Date.now();
          setRecordingTarget({ conversationId, name: assignment.name });
          setFlow('recording-voice');
          finalHandledRef.current = false;
          // Re-arm the recognizer in continuous mode — listening for "smiley".
          startRawListener();
        } catch (errorValue: any) {
          setFlow('idle');
          setRecordingTarget(null);
          Alert.alert(
            'Couldn\u2019t start recording',
            errorValue?.message || 'Please try again.'
          );
        }
        setExecuting(false);
        return;
      }
    }
  }, [
    assignments,
    audioRecorder,
    executing,
    getOrCreateDirect,
    onClose,
    parsedCommand,
    router,
    startRawListener,
  ]);
  // iter-202 hands-free auto-execute: keep the ref fresh so the
  // useEffect above can fire `executeCommand` the instant a command is
  // recognized, no "Go" tap required.
  useEffect(() => {
    executeCommandRef.current = executeCommand;
  }, [executeCommand]);

  const tryAgain = useCallback(() => {
    setTranscript('');
    setParsedCommand(null);
    setFlow('idle');
    setTimeout(() => startListening(), 150);
  }, [startListening]);

  const pulseScale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.35],
  });
  const pulseOpacity = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.35, 0],
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} testID="voice-command-backdrop" />
        <Animated.View
          style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}
          testID="voice-command-sheet"
        >
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <View style={styles.titleColumn}>
              <Text style={styles.title}>Voice Command</Text>
              <Text style={styles.subtitle}>
                Say e.g. &quot;Call 1&quot; or &quot;Video call 3&quot;
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12} testID="voice-command-close">
              <Ionicons name="close" size={24} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <View style={styles.micWrap}>
            <Animated.View
              style={[
                styles.micPulse,
                { transform: [{ scale: pulseScale }], opacity: pulseOpacity },
              ]}
            />
            <View
              style={[
                styles.micBubble,
                flow === 'recognized' && styles.micBubbleSuccess,
                flow === 'error' && styles.micBubbleError,
                flow === 'no-match' && styles.micBubbleNoMatch,
              ]}
            >
              {flow === 'recognized' ? (
                <Feather name="check" size={36} color={Colors.white} />
              ) : flow === 'error' ? (
                <Feather name="alert-circle" size={36} color={Colors.white} />
              ) : flow === 'no-match' ? (
                <Feather name="help-circle" size={36} color={Colors.white} />
              ) : (
                <Feather name="mic" size={36} color={Colors.white} />
              )}
            </View>
          </View>

          <View style={styles.transcriptBlock}>
            {flow === 'listening' ? (
              <Text style={styles.transcriptStatus}>Listening…</Text>
            ) : null}
            {flow === 'recording-voice' && recordingTarget ? (
              <>
                <Text style={[styles.transcriptStatus, { color: Colors.danger }]}>
                  Recording \u2022 {Math.floor((recorderState.durationMillis || 0) / 1000)}s
                </Text>
                <Text style={styles.recognized}>
                  Voice note to {recordingTarget.name} \u2014 say "Smiley" to send.
                </Text>
              </>
            ) : null}
            {flow === 'sending' ? (
              <Text style={styles.transcriptStatus}>Sending\u2026</Text>
            ) : null}
            {transcript && (flow === 'listening' || flow === 'recording-voice') ? (
              <Text style={styles.transcript} testID="voice-command-transcript">
                &quot;{transcript}&quot;
              </Text>
            ) : null}
            {flow === 'recognized' && parsedCommand ? (
              <Text style={styles.recognized}>
                {commandPreview(parsedCommand, assignments)}
              </Text>
            ) : null}
            {flow === 'no-match' ? (
              <Text style={styles.noMatch}>
                Didn&apos;t catch a command. Try saying &quot;Call 1&quot;, &quot;Video call 3&quot;, or &quot;Voice note to 2&quot;.
              </Text>
            ) : null}
            {flow === 'error' ? (
              <Text style={styles.errorText}>{errorMessage}</Text>
            ) : null}
          </View>

          <View style={styles.actionsRow}>
            {flow === 'recording-voice' ? (
              <>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionSecondary]}
                  onPress={() => {
                    // Cancel recording without sending.
                    try { ExpoSpeechRecognitionModule?.stop(); } catch {}
                    sessionActiveRef.current = false;
                    try { audioRecorder.stop(); } catch {}
                    setRecordingTarget(null);
                    setFlow('idle');
                    onClose();
                  }}
                  testID="voice-command-record-cancel"
                >
                  <Text style={styles.actionSecondaryText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionPrimary]}
                  onPress={() => stopRecordingAndSendRef.current?.()}
                  testID="voice-command-record-send"
                >
                  <Text style={styles.actionPrimaryText}>Send now</Text>
                </TouchableOpacity>
              </>
            ) : flow === 'recognized' && parsedCommand ? (
              // iter-202 hands-free: no buttons — auto-executes via the
              // useEffect on `flow === 'recognized'`. The visible green
              // check + "Calling X…" preview is all the feedback needed.
              null
            ) : flow === 'no-match' || flow === 'error' ? (
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionPrimary, styles.actionFullWidth]}
                onPress={tryAgain}
                testID="voice-command-retry-only"
              >
                <Text style={styles.actionPrimaryText}>Try again</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function commandPreview(cmd: VoiceCommand, assignments: AssignmentMap): string {
  if (cmd.type === 'stop_command') return 'Say a command like "Call 1" first.';
  const a = assignments[cmd.position];
  const who = a ? a.name : `position ${cmd.position}`;
  switch (cmd.type) {
    case 'voice_call':
      return `Calling ${who}\u2026`;
    case 'video_call':
      return `Video calling ${who}\u2026`;
    case 'voice_note':
      return `Voice note to ${who} \u2014 say "Smiley" to send.`;
    case 'video_message':
      return `Video message to ${who}\u2026`;
    case 'share_location':
      return `Sharing location with ${who}\u2026`;
  }
}

/**
 * Floating mic button that's visible across authenticated screens. Mirrors the
 * web app's behavior: shows a muted-mic icon in a white circle by default,
 * auto-hides after a short period of inactivity, and pops back in on the
 * next screen touch. Tap to open the voice command sheet.
 */
const IDLE_FADE_MS = 2800;
const FADE_DURATION_MS = 280;

export default function VoiceCommandLauncher() {
  const { isAuthenticated } = useAuth();
  // iter-139: hide the voice-command FAB on screens where it visually
  // overlaps important content (admin pages, security pages, full-screen
  // modals like Status / Call / Compose). The web app does the same —
  // the floating mic only appears on chat/contact/home surfaces. Match
  // is done by string prefix so any nested route under these prefixes
  // is also hidden (e.g. `/admin/users/foo`).
  const pathname = usePathname();
  const isHiddenRoute = (() => {
    const path = typeof pathname === 'string' ? pathname : '';
    return (
      path.startsWith('/admin') ||
      path.startsWith('/face-id') ||
      path.startsWith('/status-view') ||
      path.startsWith('/status-compose') ||
      path.startsWith('/call') ||
      path.startsWith('/phone-verify') ||
      path.startsWith('/change-phone-number') ||
      path.startsWith('/find-by-phone') ||
      path.startsWith('/share-receiver') ||
      path.startsWith('/screen-share') ||
      path.startsWith('/sign-in') ||
      path.startsWith('/encryption') ||
      path.startsWith('/app-lock') ||
      path.startsWith('/emergency') ||
      path.startsWith('/voice-tasks')
    );
  })();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [fabVisible, setFabVisible] = useState(true);
  const fabOpacity = useRef(new Animated.Value(1)).current;
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fadeIn = useCallback(() => {
    setFabVisible((current) => {
      if (current) return current;
      Animated.timing(fabOpacity, {
        toValue: 1,
        duration: FADE_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return true;
    });
  }, [fabOpacity]);

  const fadeOut = useCallback(() => {
    setFabVisible((current) => {
      if (!current) return current;
      Animated.timing(fabOpacity, {
        toValue: 0,
        duration: FADE_DURATION_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return false;
    });
  }, [fabOpacity]);

  const scheduleHide = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    hideTimeoutRef.current = setTimeout(() => {
      fadeOut();
    }, IDLE_FADE_MS);
  }, [fadeOut]);

  const handleActivity = useCallback(() => {
    fadeIn();
    scheduleHide();
  }, [fadeIn, scheduleHide]);

  // Subscribe to global touch activity so any tap anywhere on screen
  // reappears the FAB and resets the auto-hide timer.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const unsubscribe = subscribeTouchActivity(handleActivity);
    // Show on mount, then schedule the first hide.
    handleActivity();
    return () => {
      unsubscribe();
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [handleActivity, isAuthenticated]);

  // When the app comes back to foreground, make sure the FAB shows again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        handleActivity();
      }
    });
    return () => sub.remove();
  }, [handleActivity]);

  // While the voice sheet is open we don't want the FAB hiding underneath it.
  useEffect(() => {
    if (sheetVisible) {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      fadeIn();
    } else if (isAuthenticated) {
      handleActivity();
    }
  }, [fadeIn, handleActivity, isAuthenticated, sheetVisible]);

  if (!isAuthenticated) return null;
  // iter-139: skip rendering the FAB entirely on hidden routes so it
  // can never overlap admin/security UI.
  if (isHiddenRoute) return null;

  const handlePress = () => {
    fadeIn();
    setSheetVisible(true);
  };

  return (
    <>
      <Animated.View
        style={[styles.fabWrap, { opacity: fabOpacity, pointerEvents: fabVisible ? 'box-none' : 'none' }]}
      >
        <TouchableOpacity
          style={styles.fab}
          onPress={handlePress}
          testID="voice-command-fab"
          activeOpacity={0.85}
          accessibilityLabel="Voice command (muted, tap to listen)"
        >
          <Feather name="mic-off" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
      </Animated.View>
      <VoiceCommandSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        // iter-207 idle-crash fix: the SHEET is now conditionally
        // mounted via `visible` AND we use a `key` so React fully
        // tears it down between sessions. Previously the sheet was
        // always rendered (just with `visible=false`), which kept its
        // `useAudioRecorder` (native AudioRecorder instance) and
        // continuous speech-recognition event listeners attached for
        // the entire app lifetime — that resource hold caused the
        // "Smilers has stopped" idle crashes the user reported.
      />
    </>
  );
}

// iter-207: wrap the sheet so the heavy native hooks (audio recorder,
// speech recognizer) only allocate while it's visible. Conditional
// rendering at the boundary keeps the sheet component itself simple
// and idiomatic.
function VoiceCommandSheet(props: VoiceCommandSheetProps) {
  if (!props.visible) return null;
  return <VoiceCommandSheetInner {...props} />;
}

const styles = StyleSheet.create({
  fabWrap: {
    position: 'absolute',
    right: 18,
    bottom: 92,
    width: 52,
    height: 52,
    zIndex: 50,
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    ...Shadow.lg,
  },
  backdropWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 24,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.18)',
    marginTop: 8,
    marginBottom: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingTop: 4,
    paddingBottom: Spacing.sm,
  },
  titleColumn: { flex: 1, paddingRight: Spacing.sm },
  title: {
    fontSize: 18,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 13,
    color: Colors.textSecondary,
  },
  micWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
    paddingBottom: 16,
    height: 140,
  },
  micPulse: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.primary,
  },
  micBubble: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBubbleSuccess: {
    backgroundColor: Colors.success,
  },
  micBubbleError: {
    backgroundColor: Colors.danger,
  },
  micBubbleNoMatch: {
    backgroundColor: Colors.textSecondary,
  },
  transcriptBlock: {
    paddingHorizontal: Spacing.lg,
    minHeight: 70,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transcriptStatus: {
    fontSize: 13,
    color: Colors.primary,
    fontWeight: FontWeight.semibold,
    marginBottom: 4,
  },
  transcript: {
    fontSize: 18,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  recognized: {
    marginTop: 8,
    fontSize: 14,
    color: Colors.success,
    fontWeight: FontWeight.semibold,
    textAlign: 'center',
  },
  noMatch: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  errorText: {
    fontSize: 14,
    color: Colors.danger,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    minHeight: 64,
  },
  actionBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionFullWidth: { flex: 1 },
  actionPrimary: {
    backgroundColor: Colors.primary,
  },
  actionDisabled: {
    opacity: 0.6,
  },
  actionPrimaryText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
  actionSecondary: {
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  actionSecondaryText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
});
