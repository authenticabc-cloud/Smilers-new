import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { readStoredJson, writeStoredJson } from '../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const VOICE_PREFS_KEY = 'smilers_voice_tasks_prefs';

type WakeWord = 'hey_smilers' | 'smilers' | 'off';
type Activation = 'wake' | 'button' | 'both';
type ConfirmLevel = 'always' | 'critical' | 'never';

interface CommandFlags {
  call: boolean;
  message: boolean;
  schedule: boolean;
  money: boolean;
  sos: boolean;
  status: boolean;
  read: boolean;
}

interface VoicePrefs {
  enabled: boolean;
  wakeWord: WakeWord;
  activation: Activation;
  confirm: ConfirmLevel;
  voiceFeedback: boolean;
  haptics: boolean;
  commands: CommandFlags;
}

const DEFAULT_PREFS: VoicePrefs = {
  enabled: false,
  wakeWord: 'hey_smilers',
  activation: 'both',
  confirm: 'critical',
  voiceFeedback: true,
  haptics: true,
  commands: {
    call: true,
    message: true,
    schedule: true,
    money: false,
    sos: true,
    status: false,
    read: true,
  },
};

const WAKE_LABEL: Record<WakeWord, string> = {
  hey_smilers: '“Hey Smilers”',
  smilers: '“Smilers”',
  off: 'Off',
};

const ACTIVATION_LABEL: Record<Activation, string> = {
  wake: 'Wake word',
  button: 'Long-press',
  both: 'Both',
};

const CONFIRM_LABEL: Record<ConfirmLevel, string> = {
  always: 'Always',
  critical: 'Money & SOS only',
  never: 'Never',
};

const COMMAND_LIST: { key: keyof CommandFlags; title: string; sub: string; icon: string; tone: string }[] = [
  { key: 'call', title: 'Call a contact', sub: '“Call Jane”', icon: 'call-outline', tone: Colors.primary },
  { key: 'message', title: 'Send a message', sub: '“Tell Bob I’m on my way”', icon: 'send-outline', tone: '#0EA5E9' },
  { key: 'schedule', title: 'Schedule a message', sub: '“Remind Mom tomorrow at 9am”', icon: 'time-outline', tone: '#8B5CF6' },
  { key: 'money', title: 'Send money', sub: '“Send $20 to Alex”', icon: 'cash-outline', tone: '#10B981' },
  { key: 'sos', title: 'Trigger SOS', sub: '“Help me”', icon: 'alert-circle-outline', tone: Colors.danger },
  { key: 'status', title: 'Update status', sub: '“Set status to busy”', icon: 'happy-outline', tone: '#F59E0B' },
  { key: 'read', title: 'Read messages', sub: '“What did I miss?”', icon: 'book-outline', tone: '#6366F1' },
];

interface MicPermission {
  granted: boolean;
  canAskAgain: boolean;
  status: 'unknown' | 'granted' | 'denied' | 'undetermined';
}

export default function VoiceTasksScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: me, refetch } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    {},
    null,
    isAuthenticated,
  );
  const updateProfile = useMutation(api.users.updateProfile);

  const [prefs, setPrefs] = useState<VoicePrefs>(DEFAULT_PREFS);
  const [hydrated, setHydrated] = useState(false);
  const [mic, setMic] = useState<MicPermission>({ granted: false, canAskAgain: true, status: 'unknown' });
  const [demoTranscript, setDemoTranscript] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);

  // Hydrate prefs (Convex first, then local).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let initial: VoicePrefs | null = null;
      if (me?.voiceTasks && typeof me.voiceTasks === 'object') {
        initial = {
          ...DEFAULT_PREFS,
          ...me.voiceTasks,
          commands: { ...DEFAULT_PREFS.commands, ...(me.voiceTasks.commands || {}) },
        };
      } else {
        const local = (await readStoredJson(VOICE_PREFS_KEY, null)) as VoicePrefs | null;
        if (local) {
          initial = {
            ...DEFAULT_PREFS,
            ...local,
            commands: { ...DEFAULT_PREFS.commands, ...(local.commands || {}) },
          };
        }
      }
      if (!cancelled) {
        setPrefs(initial || DEFAULT_PREFS);
        setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me]);

  // Check mic permission on mount.
  const refreshMic = useCallback(async () => {
    try {
      const perm = await Audio.getPermissionsAsync();
      setMic({
        granted: !!perm.granted,
        canAskAgain: !!perm.canAskAgain,
        status: (perm.granted ? 'granted' : perm.canAskAgain ? 'undetermined' : 'denied') as MicPermission['status'],
      });
    } catch {
      setMic({ granted: false, canAskAgain: true, status: 'unknown' });
    }
  }, []);

  useEffect(() => {
    void refreshMic();
  }, [refreshMic]);

  const requestMic = useCallback(async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      setMic({
        granted: !!perm.granted,
        canAskAgain: !!perm.canAskAgain,
        status: perm.granted ? 'granted' : 'denied',
      });
      if (!perm.granted && !perm.canAskAgain) {
        Alert.alert(
          'Microphone access denied',
          'Open Settings to allow Smilers to use your microphone for voice commands.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open settings', onPress: () => Linking.openSettings() },
          ],
        );
      }
    } catch {
      Alert.alert('Could not request mic permission', 'Please try again.');
    }
  }, []);

  const persist = useCallback(
    async (next: VoicePrefs) => {
      setPrefs(next);
      try {
        await writeStoredJson(VOICE_PREFS_KEY, next);
      } catch {}
      try {
        await updateProfile({ voiceTasks: next });
        try {
          await refetch();
        } catch {}
      } catch (errorValue: any) {
        console.warn('updateProfile(voiceTasks) failed:', errorValue?.message);
      }
    },
    [refetch, updateProfile],
  );

  const setEnabled = useCallback(
    async (v: boolean) => {
      // If enabling, ensure mic permission first.
      if (v && !mic.granted) {
        await requestMic();
      }
      void persist({ ...prefs, enabled: v });
    },
    [mic.granted, persist, prefs, requestMic],
  );

  const setWakeWord = (w: WakeWord) => void persist({ ...prefs, wakeWord: w });
  const setActivation = (a: Activation) => void persist({ ...prefs, activation: a });
  const setConfirm = (c: ConfirmLevel) => void persist({ ...prefs, confirm: c });
  const setVoiceFeedback = (v: boolean) => void persist({ ...prefs, voiceFeedback: v });
  const setHapticsPref = (v: boolean) => void persist({ ...prefs, haptics: v });
  const toggleCommand = (key: keyof CommandFlags) => (v: boolean) =>
    void persist({ ...prefs, commands: { ...prefs.commands, [key]: v } });

  // Demo: play a short scripted transcript. Uses haptic taps as the only "audio"
  // since we don't have an offline TTS dependency installed.
  const runDemo = useCallback(async () => {
    if (demoRunning) return;
    const steps = [
      { text: prefs.wakeWord === 'off' ? '(long-press detected)' : `Hearing: ${WAKE_LABEL[prefs.wakeWord]}…`, delay: 600 },
      { text: 'Listening…', delay: 900 },
      { text: '“Call Jane”', delay: 1100 },
      { text: 'Got it — calling Jane.', delay: 1200 },
    ];
    setDemoRunning(true);
    for (const step of steps) {
      setDemoTranscript(step.text);
      if (prefs.haptics) {
        try {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {}
      }
      await new Promise((r) => setTimeout(r, step.delay));
    }
    setDemoTranscript('Ready.');
    setDemoRunning(false);
  }, [demoRunning, prefs.haptics, prefs.wakeWord]);

  const wakes: WakeWord[] = ['hey_smilers', 'smilers', 'off'];
  const activations: Activation[] = ['wake', 'button', 'both'];
  const confirms: ConfirmLevel[] = ['always', 'critical', 'never'];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="voice-tasks-screen">
      <Header title="Voice Tasks" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {/* Hero card */}
        <View style={styles.heroCard}>
          <View style={styles.heroIconWrap}>
            <Ionicons name="mic" size={36} color={Colors.primary} />
          </View>
          <Text style={styles.heroTitle}>
            {prefs.enabled ? 'Voice Tasks is on' : 'Hands-free Smilers'}
          </Text>
          <Text style={styles.heroSub}>
            {prefs.enabled
              ? `Say ${WAKE_LABEL[prefs.wakeWord]} or long-press to start a command.`
              : 'Send messages, place calls, and trigger SOS with just your voice.'}
          </Text>

          {/* Mic permission status */}
          {!mic.granted ? (
            <View style={styles.permCard}>
              <Ionicons name="warning-outline" size={18} color="#B45309" />
              <View style={styles.flexOne}>
                <Text style={styles.permTitle}>Microphone access needed</Text>
                <Text style={styles.permSub}>
                  {mic.canAskAgain
                    ? 'Smilers needs the mic to hear your commands.'
                    : 'Mic access is blocked. Open Settings to allow it.'}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.permBtn}
                onPress={mic.canAskAgain ? requestMic : () => Linking.openSettings()}
                testID="voice-tasks-mic-allow"
              >
                <Text style={styles.permBtnText}>{mic.canAskAgain ? 'Allow' : 'Settings'}</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={styles.heroRow}>
            <Text style={styles.heroRowLabel}>Enable Voice Tasks</Text>
            <Switch
              value={prefs.enabled}
              onValueChange={setEnabled}
              trackColor={{ true: Colors.primary, false: Colors.border }}
              thumbColor={Colors.white}
              testID="voice-tasks-master-toggle"
              disabled={!hydrated}
            />
          </View>
        </View>

        {/* Demo */}
        <View style={[styles.card, { marginTop: Spacing.base }]}>
          <View style={styles.demoHeader}>
            <View style={styles.flexOne}>
              <Text style={styles.cardTitle}>Try a command</Text>
              <Text style={styles.cardSub}>See what Voice Tasks looks like before going live.</Text>
            </View>
            <TouchableOpacity
              style={[styles.demoBtn, demoRunning ? { opacity: 0.7 } : null]}
              onPress={runDemo}
              disabled={demoRunning}
              testID="voice-tasks-demo"
            >
              {demoRunning ? (
                <ActivityIndicator size="small" color={Colors.headerBg} />
              ) : (
                <>
                  <Ionicons name="sparkles-outline" size={16} color={Colors.headerBg} />
                  <Text style={styles.demoBtnText}>Demo</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
          {demoTranscript ? (
            <View style={styles.demoBox}>
              <Ionicons name={demoRunning ? 'mic' : 'checkmark-circle'} size={16} color={Colors.primary} />
              <Text style={styles.demoText}>{demoTranscript}</Text>
            </View>
          ) : null}
        </View>

        {/* Activation */}
        <Text style={styles.sectionLabel}>Activation</Text>
        <View style={styles.card}>
          <View style={styles.cardSection}>
            <Text style={styles.fieldLabel}>Wake word</Text>
            <View style={styles.segment}>
              {wakes.map((w) => (
                <Pressable
                  key={w}
                  style={[styles.segmentBtn, prefs.wakeWord === w ? styles.segmentBtnActive : null]}
                  onPress={() => setWakeWord(w)}
                  testID={`voice-tasks-wake-${w}`}
                >
                  <Text
                    style={[styles.segmentText, prefs.wakeWord === w ? styles.segmentTextActive : null]}
                    numberOfLines={1}
                  >
                    {WAKE_LABEL[w]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.divider} />
          <View style={styles.cardSection}>
            <Text style={styles.fieldLabel}>How to start a command</Text>
            <View style={styles.segment}>
              {activations.map((a) => (
                <Pressable
                  key={a}
                  style={[styles.segmentBtn, prefs.activation === a ? styles.segmentBtnActive : null]}
                  onPress={() => setActivation(a)}
                  testID={`voice-tasks-activation-${a}`}
                >
                  <Text
                    style={[styles.segmentText, prefs.activation === a ? styles.segmentTextActive : null]}
                    numberOfLines={1}
                  >
                    {ACTIVATION_LABEL[a]}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.helper}>
              {prefs.activation === 'wake'
                ? 'Speak the wake word at any time.'
                : prefs.activation === 'button'
                  ? 'Long-press the floating Voice Tasks button to start.'
                  : 'Use whichever feels more natural in the moment.'}
            </Text>
          </View>
        </View>

        {/* Commands */}
        <Text style={styles.sectionLabel}>Commands</Text>
        <View style={styles.card}>
          {COMMAND_LIST.map((cmd, index) => (
            <View
              key={cmd.key}
              style={[styles.row, index === COMMAND_LIST.length - 1 ? styles.rowLast : null]}
              testID={`voice-tasks-cmd-${cmd.key}`}
            >
              <View style={[styles.iconWrap, { backgroundColor: `${cmd.tone}22` }]}>
                <Ionicons name={cmd.icon as any} size={20} color={cmd.tone} />
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.rowTitle}>{cmd.title}</Text>
                <Text style={styles.rowSub}>{cmd.sub}</Text>
              </View>
              <Switch
                value={prefs.commands[cmd.key]}
                onValueChange={toggleCommand(cmd.key)}
                trackColor={{ true: Colors.primary, false: Colors.border }}
                thumbColor={Colors.white}
                disabled={!prefs.enabled}
                testID={`voice-tasks-cmd-toggle-${cmd.key}`}
              />
            </View>
          ))}
        </View>

        {/* Confirmation & feedback */}
        <Text style={styles.sectionLabel}>Confirmation & feedback</Text>
        <View style={styles.card}>
          <View style={styles.cardSection}>
            <Text style={styles.fieldLabel}>Confirm before acting</Text>
            <View style={styles.segment}>
              {confirms.map((c) => (
                <Pressable
                  key={c}
                  style={[styles.segmentBtn, prefs.confirm === c ? styles.segmentBtnActive : null]}
                  onPress={() => setConfirm(c)}
                  testID={`voice-tasks-confirm-${c}`}
                >
                  <Text
                    style={[styles.segmentText, prefs.confirm === c ? styles.segmentTextActive : null]}
                    numberOfLines={1}
                  >
                    {CONFIRM_LABEL[c]}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.helper}>
              {prefs.confirm === 'always'
                ? 'You’ll be asked to confirm every command.'
                : prefs.confirm === 'critical'
                  ? 'Only money transfers and SOS need confirmation.'
                  : 'Commands run immediately. Use with care.'}
            </Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Ionicons name="volume-medium-outline" size={22} color={Colors.primary} />
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>Voice feedback</Text>
              <Text style={styles.rowSub}>Smilers speaks confirmations aloud</Text>
            </View>
            <Switch
              value={prefs.voiceFeedback}
              onValueChange={setVoiceFeedback}
              trackColor={{ true: Colors.primary, false: Colors.border }}
              thumbColor={Colors.white}
              testID="voice-tasks-voice-feedback"
            />
          </View>
          <View style={styles.divider} />
          <View style={[styles.row, styles.rowLast]}>
            <Ionicons name="pulse-outline" size={22} color={Colors.primary} />
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>Haptic feedback</Text>
              <Text style={styles.rowSub}>Vibrate when a command is recognized</Text>
            </View>
            <Switch
              value={prefs.haptics}
              onValueChange={setHapticsPref}
              trackColor={{ true: Colors.primary, false: Colors.border }}
              thumbColor={Colors.white}
              testID="voice-tasks-haptics"
            />
          </View>
        </View>

        {/* Privacy note */}
        <View style={styles.tipCard}>
          <Ionicons name="lock-closed-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.tipText}>
            Voice is processed on-device wherever possible. Audio is never stored after a command is handled, and Smilers
            cannot access your microphone unless Voice Tasks is on.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  heroCard: {
    margin: Spacing.base,
    padding: Spacing.lg,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    alignItems: 'center',
  },
  heroIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  heroTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: 2,
    textAlign: 'center',
  },
  heroSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: Spacing.sm,
  },
  permCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: '#FFFBEB',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#FDE68A',
    padding: Spacing.md,
    marginTop: Spacing.md,
    alignSelf: 'stretch',
  },
  permTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: '#92400E',
  },
  permSub: { fontSize: FontSize.xs, color: '#78350F', marginTop: 2, lineHeight: 16 },
  permBtn: {
    backgroundColor: '#B45309',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.md,
  },
  permBtnText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.xs,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.lg,
    alignSelf: 'stretch',
  },
  heroRowLabel: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },

  card: {
    marginHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: 'hidden',
  },
  cardTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  cardSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  cardSection: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    gap: 8,
  },
  fieldLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },

  demoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  demoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  demoBtnText: {
    color: Colors.headerBg,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.sm,
  },
  demoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    margin: Spacing.base,
    marginTop: 0,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    backgroundColor: Colors.primaryLight,
    borderRadius: Radius.md,
  },
  demoText: {
    flex: 1,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.primaryDark,
  },

  segment: {
    flexDirection: 'row',
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    padding: 4,
    gap: 4,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentBtnActive: { backgroundColor: Colors.primary },
  segmentText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  segmentTextActive: { color: Colors.headerBg },

  helper: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 6,
    lineHeight: 16,
  },

  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginLeft: Spacing.base,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  rowLast: { borderBottomWidth: 0 },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMid: { flex: 1 },
  rowTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },

  tipCard: {
    flexDirection: 'row',
    gap: Spacing.sm,
    margin: Spacing.base,
    padding: Spacing.md,
    backgroundColor: '#FFFBEB',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  tipText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  flexOne: { flex: 1 },
});
