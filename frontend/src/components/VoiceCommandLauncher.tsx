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
import { useRouter } from 'expo-router';
import { useAuth } from '../providers/AuthProvider';
import { readStoredJson } from '../lib/settingsStorage';
import { parseVoiceCommand, ParsedVoiceCommand } from '../lib/voiceCommandParser';
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

type FlowState = 'idle' | 'listening' | 'recognized' | 'no-match' | 'error';

interface VoiceCommandSheetProps {
  visible: boolean;
  onClose: () => void;
}

function VoiceCommandSheet({ visible, onClose }: VoiceCommandSheetProps) {
  const router = useRouter();
  const [transcript, setTranscript] = useState('');
  const [flow, setFlow] = useState<FlowState>('idle');
  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [parsedCommand, setParsedCommand] = useState<ParsedVoiceCommand | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(300)).current;
  const sessionActiveRef = useRef(false);

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

  // Load assignments when opened (fresh each session in case user changed them)
  useEffect(() => {
    if (!visible) return;
    (async () => {
      const saved = (await readStoredJson(VOICE_TASKS_STORAGE_KEY, null)) as AssignmentMap | null;
      setAssignments(saved || {});
    })();
  }, [visible]);

  // Reset state and stop recognition when closed
  useEffect(() => {
    if (!visible) {
      setTranscript('');
      setFlow('idle');
      setParsedCommand(null);
      setErrorMessage(null);
      if (sessionActiveRef.current) {
        try {
          ExpoSpeechRecognitionModule?.stop();
        } catch {
          // ignore — module may not have started
        }
        sessionActiveRef.current = false;
      }
    }
  }, [visible]);

  // Live transcription event
  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results?.[0]?.transcript || '';
    setTranscript(text);
    if (event.isFinal) {
      handleFinalTranscript(text);
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    sessionActiveRef.current = false;
    setFlow('error');
    setErrorMessage(event.error || 'Could not recognize speech');
  });

  useSpeechRecognitionEvent('end', () => {
    sessionActiveRef.current = false;
    // If we ended without a final result, treat as no-match
    if (flow === 'listening') {
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

  const startListening = useCallback(async () => {
    setTranscript('');
    setParsedCommand(null);
    setErrorMessage(null);
    setFlow('listening');
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

  const executeCommand = useCallback(() => {
    if (!parsedCommand) return;
    const { type, position } = parsedCommand;
    const assignment = assignments[position];
    if (!assignment) {
      Alert.alert(
        `No contact at position ${position}`,
        'Open Settings → Voice Tasks to assign a contact to this number first.'
      );
      onClose();
      return;
    }
    // Route based on command type
    const contactId = encodeURIComponent(assignment.contactId);
    const displayName = encodeURIComponent(assignment.name);
    switch (type) {
      case 'call':
        router.push(`/call/${contactId}?type=voice&displayName=${displayName}` as any);
        break;
      case 'video':
        router.push(`/call/${contactId}?type=video&displayName=${displayName}` as any);
        break;
      case 'voiceNote':
        // Open the chat with intent flag — composer will auto-start recording
        router.push(`/chat/${contactId}?action=voice-note` as any);
        break;
      case 'videoMessage':
        router.push(`/chat/${contactId}?action=video-note` as any);
        break;
      case 'location':
        router.push(`/share-location/${contactId}` as any);
        break;
    }
    onClose();
  }, [assignments, onClose, parsedCommand, router]);

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
                Say e.g. "Call 1" or "Video call 3"
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
            {transcript ? (
              <Text style={styles.transcript} testID="voice-command-transcript">
                "{transcript}"
              </Text>
            ) : null}
            {flow === 'recognized' && parsedCommand ? (
              <Text style={styles.recognized}>
                {commandPreview(parsedCommand, assignments)}
              </Text>
            ) : null}
            {flow === 'no-match' ? (
              <Text style={styles.noMatch}>
                Didn't catch a command. Try saying "Call 1", "Video call 3", or "Voice note to 2".
              </Text>
            ) : null}
            {flow === 'error' ? (
              <Text style={styles.errorText}>{errorMessage}</Text>
            ) : null}
          </View>

          <View style={styles.actionsRow}>
            {flow === 'recognized' && parsedCommand ? (
              <>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionSecondary]}
                  onPress={tryAgain}
                  testID="voice-command-retry"
                >
                  <Text style={styles.actionSecondaryText}>Try again</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionPrimary]}
                  onPress={executeCommand}
                  testID="voice-command-go"
                >
                  <Text style={styles.actionPrimaryText}>Go</Text>
                </TouchableOpacity>
              </>
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

function commandPreview(cmd: ParsedVoiceCommand, assignments: AssignmentMap): string {
  const a = assignments[cmd.position];
  const who = a ? a.name : `position ${cmd.position}`;
  switch (cmd.type) {
    case 'call':
      return `Calling ${who}…`;
    case 'video':
      return `Video calling ${who}…`;
    case 'voiceNote':
      return `Sending voice note to ${who}…`;
    case 'videoMessage':
      return `Sending video message to ${who}…`;
    case 'location':
      return `Sharing location with ${who}…`;
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

  const handlePress = () => {
    fadeIn();
    setSheetVisible(true);
  };

  return (
    <>
      <Animated.View
        style={[styles.fabWrap, { opacity: fabOpacity }]}
        pointerEvents={fabVisible ? 'box-none' : 'none'}
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
      />
    </>
  );
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
