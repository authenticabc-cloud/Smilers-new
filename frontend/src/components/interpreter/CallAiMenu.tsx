/**
 * CallAiMenu — "Tap AI" in-call assistant.
 * Operates on the live call transcript (built from interpreter subtitles):
 * Summarize · Notes · Action points · Calendar event · Translate · Share.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Calendar from 'expo-calendar';
import { Colors } from '../../theme';
import type { SubtitleLine } from '../../lib/interpreter/useTranslatedPlayback';

const CALL_AI_ENDPOINT = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}/api/call-ai`;

type Task = 'summary' | 'notes' | 'action_points' | 'calendar';
type CalEvent = { title: string; start: string; end: string; notes: string };

const ACTIONS: { task: Task; label: string; icon: string }[] = [
  { task: 'summary', label: 'Summarize call', icon: 'file-text' },
  { task: 'notes', label: 'Take notes', icon: 'edit-3' },
  { task: 'action_points', label: 'Action points', icon: 'check-square' },
  { task: 'calendar', label: 'Create calendar event', icon: 'calendar' },
];

export function CallAiMenu({
  visible,
  onClose,
  subtitles,
  listeningLanguage,
  onOpenInterpreter,
}: {
  visible: boolean;
  onClose: () => void;
  subtitles: SubtitleLine[];
  listeningLanguage: string;
  onOpenInterpreter: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<'menu' | 'loading' | 'result'>('menu');
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [resultText, setResultText] = useState('');
  const [event, setEvent] = useState<CalEvent | null>(null);

  const transcript = useMemo(
    () =>
      subtitles
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((l) => `${l.isMe ? 'Me' : l.speakerName || 'Speaker'}: ${l.originalText}`)
        .join('\n'),
    [subtitles],
  );

  const reset = () => {
    setPhase('menu');
    setActiveTask(null);
    setResultText('');
    setEvent(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const run = async (task: Task) => {
    if (!transcript.trim()) {
      Alert.alert('Nothing to work with yet', 'Turn on Translate and talk a little first — the AI works on what was said.');
      return;
    }
    setActiveTask(task);
    setPhase('loading');
    setResultText('');
    setEvent(null);
    try {
      const resp = await fetch(CALL_AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          transcript: transcript.slice(0, 20000),
          target_language: listeningLanguage,
          now_iso: new Date().toISOString(),
        }),
      });
      if (!resp.ok) throw new Error(String(resp.status));
      const data = await resp.json();
      if (task === 'calendar') {
        if (data?.event?.start) {
          setEvent(data.event as CalEvent);
        } else {
          setResultText('No clear event or time was mentioned in this call.');
        }
      } else {
        setResultText(String(data?.text || '').trim() || 'No output.');
      }
      setPhase('result');
    } catch {
      setResultText('Could not reach the AI service. Please try again.');
      setPhase('result');
    }
  };

  const addToCalendar = async () => {
    if (!event) return;
    try {
      const { status, canAskAgain } = await Calendar.requestCalendarPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Calendar access needed',
          'Allow calendar access to save this event.',
          canAskAgain
            ? [{ text: 'OK' }]
            : [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: () => Linking.openSettings() },
              ],
        );
        return;
      }
      let calId: string | null = null;
      if (Platform.OS === 'ios') {
        const def = await Calendar.getDefaultCalendarAsync();
        calId = def?.id || null;
      }
      if (!calId) {
        const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
        const writable = cals.find((c) => c.allowsModifications) || cals[0];
        calId = writable?.id || null;
      }
      if (!calId) {
        Alert.alert('No calendar found', 'Could not find a calendar to add the event to.');
        return;
      }
      const start = new Date(event.start);
      const end = event.end ? new Date(event.end) : new Date(start.getTime() + 60 * 60 * 1000);
      await Calendar.createEventAsync(calId, {
        title: event.title,
        startDate: start,
        endDate: end,
        notes: event.notes,
      });
      Alert.alert('Added to calendar', `"${event.title}" was saved to your calendar.`);
      close();
    } catch {
      Alert.alert('Could not add event', 'Something went wrong saving to your calendar.');
    }
  };

  const shareTranscript = () => {
    if (!transcript.trim()) {
      Alert.alert('No transcript yet', 'Turn on Translate and talk a little first.');
      return;
    }
    Share.share({ message: transcript }).catch(() => {});
  };

  const copyResult = () => Clipboard.setStringAsync(resultText).catch(() => {});
  const shareResult = () => Share.share({ message: resultText }).catch(() => {});

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              {phase !== 'menu' ? (
                <Pressable onPress={reset} hitSlop={8} style={styles.backBtn}>
                  <Feather name="chevron-left" size={22} color="#fff" />
                </Pressable>
              ) : (
                <Feather name="zap" size={18} color={Colors.primary} />
              )}
              <Text style={styles.title}>
                {phase === 'menu'
                  ? 'AI assistant'
                  : activeTask === 'summary'
                    ? 'Call summary'
                    : activeTask === 'notes'
                      ? 'Notes'
                      : activeTask === 'action_points'
                        ? 'Action points'
                        : 'Calendar event'}
              </Text>
            </View>
            <Pressable onPress={close} hitSlop={8}>
              <Feather name="x" size={22} color="#fff" />
            </Pressable>
          </View>

          {phase === 'menu' ? (
            <View>
              {ACTIONS.map((a) => (
                <Pressable key={a.task} style={styles.row} onPress={() => run(a.task)}>
                  <Feather name={a.icon as any} size={20} color={Colors.primary} />
                  <Text style={styles.rowLabel}>{a.label}</Text>
                  <Feather name="chevron-right" size={18} color="#777" />
                </Pressable>
              ))}
              <Pressable style={styles.row} onPress={() => { onOpenInterpreter(); close(); }}>
                <Feather name="globe" size={20} color={Colors.primary} />
                <Text style={styles.rowLabel}>Translate settings</Text>
                <Feather name="chevron-right" size={18} color="#777" />
              </Pressable>
              <Pressable style={styles.row} onPress={shareTranscript}>
                <Feather name="share-2" size={20} color={Colors.primary} />
                <Text style={styles.rowLabel}>Share transcript</Text>
                <Feather name="chevron-right" size={18} color="#777" />
              </Pressable>
            </View>
          ) : phase === 'loading' ? (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.loadingText}>Working on it…</Text>
            </View>
          ) : (
            <ScrollView style={styles.resultScroll} contentContainerStyle={styles.resultContent}>
              {event ? (
                <View>
                  <Text style={styles.eventTitle}>{event.title}</Text>
                  <View style={styles.eventRow}>
                    <Feather name="clock" size={14} color="#bbb" />
                    <Text style={styles.eventMeta}>
                      {new Date(event.start).toLocaleString()}
                    </Text>
                  </View>
                  {event.notes ? <Text style={styles.eventNotes}>{event.notes}</Text> : null}
                  <Pressable style={styles.primaryBtn} onPress={addToCalendar}>
                    <Feather name="calendar" size={18} color="#222" />
                    <Text style={styles.primaryBtnText}>Add to calendar</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <Text style={styles.resultText}>{resultText}</Text>
                  <View style={styles.resultActions}>
                    <Pressable style={styles.secondaryBtn} onPress={copyResult}>
                      <Feather name="copy" size={16} color="#fff" />
                      <Text style={styles.secondaryBtnText}>Copy</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryBtn} onPress={shareResult}>
                      <Feather name="share-2" size={16} color="#fff" />
                      <Text style={styles.secondaryBtnText}>Share</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 14,
    maxHeight: '82%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: { marginLeft: -4 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  rowLabel: { color: '#fff', fontSize: 16, fontWeight: '500', flex: 1 },
  loading: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 12 },
  loadingText: { color: '#9a9a9a', fontSize: 14 },
  resultScroll: { maxHeight: 420 },
  resultContent: { paddingVertical: 8, paddingBottom: 20 },
  resultText: { color: '#fff', fontSize: 15, lineHeight: 22 },
  resultActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  secondaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  eventTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  eventMeta: { color: '#bbb', fontSize: 14 },
  eventNotes: { color: '#c7c7cc', fontSize: 14, lineHeight: 20, marginTop: 4 },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 20,
  },
  primaryBtnText: { color: '#222', fontSize: 16, fontWeight: '700' },
});
