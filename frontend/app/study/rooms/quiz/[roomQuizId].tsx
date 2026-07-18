/**
 * Room quiz — take a shared quiz (server-side grading) and view the room
 * leaderboard (best attempt per member). Mirrors the personal quiz runner
 * but submits via `submitRoomQuizAttempt` and shows a leaderboard tab.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../../../src/theme';
import { LatexView } from '../../../../src/components/study/LatexView';
import { useRoomQuiz } from '../../../../src/lib/study/useRooms';

function pick(o: any, ...keys: string[]) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

export default function RoomQuizRunner() {
  const insets = useSafeAreaInsets();
  const { roomQuizId } = useLocalSearchParams<{ roomQuizId: string }>();
  const { data, loading, submitRoomQuizAttempt } = useRoomQuiz(roomQuizId || null);

  const [view, setView] = useState<'quiz' | 'board'>('quiz');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [graded, setGraded] = useState<any[] | null>(null);
  const [score, setScore] = useState<{ correct: number; total: number } | null>(null);

  // getRoomQuiz may return the quiz flat or nested under `quiz`.
  const quiz = pick(data, 'quiz') || data;
  const questions: any[] = useMemo(() => {
    const q = pick(quiz, 'questions', 'items') || [];
    return Array.isArray(q) ? q : [];
  }, [quiz]);
  const leaderboard: any[] = useMemo(() => {
    const lb = pick(data, 'leaderboard') || pick(quiz, 'leaderboard') || [];
    return Array.isArray(lb) ? lb : [];
  }, [data, quiz]);

  const gradedByNumber = useMemo(() => {
    const map: Record<number, any> = {};
    (graded || []).forEach((g: any) => {
      const n = pick(g, 'number');
      if (n != null) map[Number(n)] = g;
    });
    return map;
  }, [graded]);

  const submit = useCallback(async () => {
    if (submitting) return;
    const payload = questions.map((q: any, i: number) => {
      const number = pick(q, 'number') ?? i + 1;
      return { number, given: answers[number] ?? '' };
    });
    if (payload.some((p) => !String(p.given).trim())) {
      Alert.alert('Answer all questions', 'Please attempt every question before submitting.');
      return;
    }
    setSubmitting(true);
    try {
      const res: any = await submitRoomQuizAttempt({ roomQuizId, answers: payload } as any);
      const g = pick(res, 'graded') || res?.attempt?.graded || [];
      setGraded(Array.isArray(g) ? g : []);
      const correct = (Array.isArray(g) ? g : []).filter((x: any) => pick(x, 'correct') === true).length;
      setScore({ correct, total: payload.length });
    } catch (err: any) {
      Alert.alert('Could not submit', err?.data?.message || err?.message || 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [submitting, questions, answers, submitRoomQuizAttempt, roomQuizId]);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{pick(quiz, 'title', 'topic') || 'Group quiz'}</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.tabs}>
        <TouchableOpacity style={[styles.tab, view === 'quiz' && styles.tabOn]} onPress={() => setView('quiz')}>
          <Text style={[styles.tabText, view === 'quiz' && styles.tabTextOn]}>Quiz</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, view === 'board' && styles.tabOn]} onPress={() => setView('board')}>
          <Text style={[styles.tabText, view === 'board' && styles.tabTextOn]}>Leaderboard</Text>
        </TouchableOpacity>
      </View>

      {loading && !data ? (
        <View style={styles.center}><ActivityIndicator color={Colors.primary} /></View>
      ) : view === 'board' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {leaderboard.length === 0 ? (
            <View style={styles.center}><Text style={styles.emptyText}>No attempts yet. Be the first!</Text></View>
          ) : (
            leaderboard.map((row: any, i: number) => (
              <View key={pick(row, 'userId', '_id') || i} style={styles.lbRow}>
                <Text style={[styles.lbRank, i < 3 && styles.lbRankTop]}>{i + 1}</Text>
                <Text style={styles.lbName} numberOfLines={1}>{pick(row, 'name', 'displayName') || 'Member'}</Text>
                <Text style={styles.lbScore}>
                  {pick(row, 'score', 'best', 'correct') ?? 0}
                  {pick(row, 'total') ? `/${pick(row, 'total')}` : ''}
                </Text>
              </View>
            ))
          )}
        </ScrollView>
      ) : questions.length === 0 ? (
        <View style={styles.center}><Text style={styles.emptyText}>This quiz has no questions yet.</Text></View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 100 }]}>
          {score ? (
            <View style={styles.scoreCard}>
              <Text style={styles.scoreValue}>{score.correct}/{score.total}</Text>
              <Text style={styles.scoreLabel}>Your best is on the leaderboard</Text>
            </View>
          ) : null}

          {questions.map((q: any, i: number) => {
            const number = pick(q, 'number') ?? i + 1;
            const prompt = pick(q, 'prompt', 'question', 'text');
            const promptLatex = pick(q, 'promptLatex', 'prompt_latex');
            const options: any[] = pick(q, 'options', 'choices') || [];
            const g = gradedByNumber[Number(number)];
            const isCorrect = g ? pick(g, 'correct') === true : undefined;
            const correctAnswer = g ? pick(g, 'correctAnswer', 'correct_answer', 'answer') : undefined;
            const explanation = g ? pick(g, 'explanation', 'rationale') : undefined;

            return (
              <View key={number} style={styles.qCard}>
                <View style={styles.qHead}>
                  <View style={styles.qNum}><Text style={styles.qNumText}>{number}</Text></View>
                  {prompt ? <Text style={styles.qPrompt}>{String(prompt)}</Text> : null}
                </View>
                {promptLatex ? <LatexView latex={String(promptLatex)} size={16} /> : null}

                {options.length > 0 ? (
                  <View style={styles.options}>
                    {options.map((opt: any, oi: number) => {
                      const label = typeof opt === 'string' ? opt : pick(opt, 'label', 'text', 'value');
                      const value = typeof opt === 'string' ? opt : pick(opt, 'value', 'label', 'text');
                      const selected = answers[number] === value;
                      const showCorrect = g && String(correctAnswer) === String(value);
                      return (
                        <TouchableOpacity
                          key={oi}
                          disabled={!!graded}
                          style={[
                            styles.option,
                            selected && styles.optionSel,
                            showCorrect && styles.optionCorrect,
                            g && selected && isCorrect === false && styles.optionWrong,
                          ]}
                          onPress={() => setAnswers((p) => ({ ...p, [number]: String(value) }))}
                        >
                          <Text style={[styles.optionText, selected && styles.optionTextSel]}>{String(label)}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ) : (
                  <TextInput
                    style={[styles.answerInput, graded && styles.answerLocked]}
                    placeholder="Your answer"
                    placeholderTextColor={Colors.textMuted}
                    value={answers[number] ?? ''}
                    onChangeText={(t) => setAnswers((p) => ({ ...p, [number]: t }))}
                    editable={!graded}
                  />
                )}

                {g ? (
                  <View style={[styles.feedback, isCorrect ? styles.feedbackOk : styles.feedbackBad]}>
                    <Feather name={isCorrect ? 'check-circle' : 'x-circle'} size={15} color={isCorrect ? Colors.success : Colors.danger} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.feedbackTitle}>{isCorrect ? 'Correct' : `Answer: ${String(correctAnswer ?? '')}`}</Text>
                      {explanation ? <Text style={styles.feedbackText}>{String(explanation)}</Text> : null}
                    </View>
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      )}

      {view === 'quiz' && questions.length > 0 && !graded ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
          <TouchableOpacity style={[styles.primaryBtn, submitting && styles.btnDisabled]} onPress={submit} disabled={submitting}>
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Submit</Text>}
          </TouchableOpacity>
        </View>
      ) : null}
      {view === 'quiz' && graded ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setView('board')}>
            <Feather name="award" size={18} color="#fff" />
            <Text style={styles.primaryBtnText}>View leaderboard</Text>
          </TouchableOpacity>
        </View>
      ) : null}
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
  },
  headerTitle: { flex: 1, color: Colors.textPrimary, fontSize: 17, fontWeight: '700' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 4, backgroundColor: Colors.borderLight, borderRadius: 12, padding: 4, gap: 4 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 9 },
  tabOn: { backgroundColor: Colors.primary },
  tabText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700' },
  tabTextOn: { color: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: Colors.textSecondary, fontSize: 14 },
  content: { padding: 16, gap: 14 },
  lbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  lbRank: { width: 24, textAlign: 'center', color: Colors.textSecondary, fontSize: 16, fontWeight: '800' },
  lbRankTop: { color: Colors.primary },
  lbName: { flex: 1, color: Colors.textPrimary, fontSize: 15, fontWeight: '600' },
  lbScore: { color: Colors.primaryDark, fontSize: 16, fontWeight: '800' },
  scoreCard: { alignItems: 'center', backgroundColor: Colors.primaryLight, borderRadius: 16, paddingVertical: 20 },
  scoreValue: { color: Colors.primaryDark, fontSize: 34, fontWeight: '900' },
  scoreLabel: { color: Colors.primaryDark, fontSize: 13, fontWeight: '600', marginTop: 2 },
  qCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 14,
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  qHead: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  qNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  qNumText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  qPrompt: { flex: 1, color: Colors.textPrimary, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  options: { gap: 8 },
  option: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: Colors.background, borderWidth: 1.5, borderColor: Colors.border },
  optionSel: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  optionCorrect: { borderColor: Colors.success, backgroundColor: 'rgba(34,197,94,0.1)' },
  optionWrong: { borderColor: Colors.danger, backgroundColor: 'rgba(239,68,68,0.08)' },
  optionText: { color: Colors.textPrimary, fontSize: 14 },
  optionTextSel: { fontWeight: '700' },
  answerInput: { backgroundColor: Colors.background, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: Colors.textPrimary, borderWidth: 1.5, borderColor: Colors.border },
  answerLocked: { opacity: 0.7 },
  feedback: { flexDirection: 'row', gap: 8, borderRadius: 12, padding: 10 },
  feedbackOk: { backgroundColor: 'rgba(34,197,94,0.1)' },
  feedbackBad: { backgroundColor: 'rgba(239,68,68,0.08)' },
  feedbackTitle: { color: Colors.textPrimary, fontSize: 13, fontWeight: '700' },
  feedbackText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 2 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 15,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  btnDisabled: { opacity: 0.6 },
});
