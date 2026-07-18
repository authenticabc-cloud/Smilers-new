/**
 * StudyAnswer — renders a structured Study AI reply (Phase 1 contract).
 * Tolerant of camelCase or snake_case field names so it stays robust
 * against small contract differences. Renders LaTeX via <LatexView/>.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../theme';
import { LatexView } from './LatexView';

function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

interface Step {
  number?: number;
  title?: string;
  explanation?: string;
  formulaLatex?: string;
}

export function StudyAnswer({ answer }: { answer: any }) {
  if (!answer) return null;

  const summary = pick(answer, 'summary');
  const rawSteps = pick(answer, 'steps') || [];
  const steps: Step[] = (Array.isArray(rawSteps) ? rawSteps : []).map((s: any, i: number) => ({
    number: pick(s, 'number') ?? i + 1,
    title: pick(s, 'title'),
    explanation: pick(s, 'explanation', 'text'),
    formulaLatex: pick(s, 'formulaLatex', 'formula_latex'),
  }));
  const finalAnswer = pick(answer, 'finalAnswer', 'final_answer');
  const finalAnswerLatex = pick(answer, 'finalAnswerLatex', 'final_answer_latex');
  const commonMistake = pick(answer, 'commonMistake', 'common_mistake');
  const checkQuestion = pick(answer, 'checkQuestion', 'check_question');
  const clarification = pick(answer, 'clarificationQuestion', 'clarification_question');
  const needsClarification = pick(answer, 'needsClarification', 'needs_clarification');
  const subject = pick(answer, 'subject');
  const topic = pick(answer, 'topic');
  // Plain-text fallback when the reply isn't structured.
  const plain = pick(answer, 'content', 'body', 'answer', 'message');

  const hasStructured = summary || steps.length || finalAnswer || finalAnswerLatex;

  return (
    <View style={styles.card}>
      {(subject || topic) ? (
        <View style={styles.tagRow}>
          <Feather name="book-open" size={12} color={Colors.primary} />
          <Text style={styles.tag}>
            {[subject, topic].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ) : null}

      {needsClarification && clarification ? (
        <View style={styles.clarify}>
          <Feather name="help-circle" size={16} color={Colors.warning || '#B8860B'} />
          <Text style={styles.clarifyText}>{String(clarification)}</Text>
        </View>
      ) : null}

      {summary ? <Text style={styles.summary}>{String(summary)}</Text> : null}

      {steps.map((s, i) => (
        <View key={i} style={styles.step}>
          <View style={styles.stepHead}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{s.number ?? i + 1}</Text>
            </View>
            {s.title ? <Text style={styles.stepTitle}>{s.title}</Text> : null}
          </View>
          {s.explanation ? <Text style={styles.stepText}>{s.explanation}</Text> : null}
          {s.formulaLatex ? <LatexView latex={s.formulaLatex} /> : null}
        </View>
      ))}

      {finalAnswer || finalAnswerLatex ? (
        <View style={styles.finalBox}>
          <Text style={styles.finalLabel}>Answer</Text>
          {finalAnswerLatex ? (
            <LatexView latex={finalAnswerLatex} color={Colors.primary} size={20} />
          ) : (
            <Text style={styles.finalText}>{String(finalAnswer)}</Text>
          )}
        </View>
      ) : null}

      {commonMistake ? (
        <View style={styles.noteRow}>
          <Feather name="alert-triangle" size={13} color="#C0392B" />
          <Text style={styles.noteText}>
            <Text style={styles.noteBold}>Common mistake: </Text>
            {String(commonMistake)}
          </Text>
        </View>
      ) : null}

      {checkQuestion ? (
        <View style={styles.checkRow}>
          <Feather name="check-circle" size={13} color={Colors.primary} />
          <Text style={styles.checkText}>{String(checkQuestion)}</Text>
        </View>
      ) : null}

      {!hasStructured && plain ? <Text style={styles.summary}>{String(plain)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tag: { color: Colors.primary, fontSize: 12, fontWeight: '700' },
  clarify: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: 'rgba(184,134,11,0.12)',
    borderRadius: 10,
    padding: 10,
  },
  clarifyText: { flex: 1, color: Colors.textPrimary, fontSize: 14, lineHeight: 20 },
  summary: { color: Colors.textPrimary, fontSize: 15, lineHeight: 22 },
  step: { gap: 6 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  stepTitle: { flex: 1, color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  stepText: { color: Colors.textSecondary, fontSize: 14, lineHeight: 21, marginLeft: 30 },
  finalBox: {
    backgroundColor: 'rgba(37,99,235,0.08)',
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  finalLabel: {
    color: Colors.primary,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  finalText: { color: Colors.textPrimary, fontSize: 17, fontWeight: '700' },
  noteRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  noteText: { flex: 1, color: Colors.textSecondary, fontSize: 13, lineHeight: 19 },
  noteBold: { fontWeight: '700', color: Colors.textPrimary },
  checkRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    backgroundColor: Colors.surfaceMuted || 'rgba(0,0,0,0.03)',
    borderRadius: 10,
    padding: 10,
  },
  checkText: { flex: 1, color: Colors.textPrimary, fontSize: 14, lineHeight: 20 },
});
