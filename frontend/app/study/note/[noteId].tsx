/**
 * Note detail — renders an AI summary or a day-by-day study plan.
 * Tolerant of the backend's exact field names (summary/content, sections,
 * days/plan/schedule). LaTeX fields render via <LatexView/> without `$`.
 */
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../../src/theme';
import { useNote } from '../../../src/lib/study/useRevision';

function pick(o: any, ...keys: string[]) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

function asText(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return pick(v, 'text', 'title', 'label', 'name', 'content') || '';
}

export default function NoteDetail() {
  const insets = useSafeAreaInsets();
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  const { note, loading, setNoteSaved } = useNote(noteId || null);

  const kind = pick(note, 'kind') || 'summary';
  const isPlan = kind === 'study_plan';

  const days: any[] = useMemo(() => {
    const d = pick(note, 'days', 'plan', 'schedule') || [];
    return Array.isArray(d) ? d : [];
  }, [note]);

  const sections: any[] = useMemo(() => {
    const s = pick(note, 'sections') || [];
    return Array.isArray(s) ? s : [];
  }, [note]);

  const bodyText = pick(note, 'content', 'body', 'summary', 'text');
  const keyPoints: any[] = useMemo(() => {
    const p = pick(note, 'keyPoints', 'points', 'bullets') || [];
    return Array.isArray(p) ? p : [];
  }, [note]);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {pick(note, 'title', 'topic') || (isPlan ? 'Study plan' : 'Summary')}
        </Text>
        {note ? (
          <TouchableOpacity
            onPress={() => setNoteSaved({ noteId, isSaved: !note.isSaved } as any).catch(() => {})}
            hitSlop={10}
          >
            <Feather name="bookmark" size={22} color={note.isSaved ? Colors.primary : Colors.textSecondary} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      {loading && !note ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
          <View style={styles.kindBadge}>
            <Feather name={isPlan ? 'calendar' : 'file-text'} size={13} color={Colors.primaryDark} />
            <Text style={styles.kindText}>{isPlan ? 'Study plan' : 'Summary'}</Text>
          </View>

          {isPlan && days.length > 0 ? (
            days.map((d: any, i: number) => {
              const label = pick(d, 'title', 'label', 'day') ?? `Day ${i + 1}`;
              const tasks: any[] = pick(d, 'tasks', 'items', 'activities') || [];
              return (
                <View key={i} style={styles.dayCard}>
                  <View style={styles.dayHead}>
                    <View style={styles.dayNum}>
                      <Text style={styles.dayNumText}>{i + 1}</Text>
                    </View>
                    <Text style={styles.dayTitle}>{String(label)}</Text>
                  </View>
                  {(Array.isArray(tasks) ? tasks : []).map((t: any, ti: number) => (
                    <View key={ti} style={styles.taskRow}>
                      <Feather name="circle" size={7} color={Colors.primary} style={{ marginTop: 7 }} />
                      <Text style={styles.taskText}>{asText(t)}</Text>
                    </View>
                  ))}
                </View>
              );
            })
          ) : null}

          {!isPlan && sections.length > 0
            ? sections.map((s: any, i: number) => {
                const heading = pick(s, 'heading', 'title');
                const points: any[] = pick(s, 'points', 'bullets', 'items') || [];
                const text = pick(s, 'text', 'content', 'body');
                return (
                  <View key={i} style={styles.section}>
                    {heading ? <Text style={styles.sectionHeading}>{String(heading)}</Text> : null}
                    {text ? <Text style={styles.bodyText}>{String(text)}</Text> : null}
                    {(Array.isArray(points) ? points : []).map((p: any, pi: number) => (
                      <View key={pi} style={styles.taskRow}>
                        <Feather name="circle" size={7} color={Colors.primary} style={{ marginTop: 7 }} />
                        <Text style={styles.taskText}>{asText(p)}</Text>
                      </View>
                    ))}
                  </View>
                );
              })
            : null}

          {!isPlan && sections.length === 0 && keyPoints.length > 0 ? (
            <View style={styles.section}>
              {keyPoints.map((p: any, pi: number) => (
                <View key={pi} style={styles.taskRow}>
                  <Feather name="circle" size={7} color={Colors.primary} style={{ marginTop: 7 }} />
                  <Text style={styles.taskText}>{asText(p)}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {bodyText && sections.length === 0 && days.length === 0 && keyPoints.length === 0 ? (
            <Text style={styles.bodyText}>{String(bodyText)}</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  headerTitle: { flex: 1, color: Colors.textPrimary, fontSize: 17, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { padding: 16, gap: 14 },
  kindBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: Colors.primaryLight,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  kindText: { color: Colors.primaryDark, fontSize: 12, fontWeight: '800' },
  dayCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 14,
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  dayHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dayNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNumText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  dayTitle: { flex: 1, color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  section: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 14,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  sectionHeading: { color: Colors.textPrimary, fontSize: 16, fontWeight: '800' },
  taskRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  taskText: { flex: 1, color: Colors.textPrimary, fontSize: 14, lineHeight: 21 },
  bodyText: { color: Colors.textPrimary, fontSize: 15, lineHeight: 23 },
});
