/**
 * Flashcard deck — study due cards with a Leitner flip/review flow.
 * Tap to flip; rate 'again' | 'good' | 'easy' → reviewFlashcard (server
 * moves the card across boxes 0..5 with intervals [0,1,2,4,7,15] days).
 * When no cards are due, offer to review the whole deck.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../../src/theme';
import { LatexView } from '../../../src/components/study/LatexView';
import { useDeck, type FlashcardRating } from '../../../src/lib/study/useRevision';

function pick(o: any, ...keys: string[]) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

const RATINGS: { key: FlashcardRating; label: string; color: string }[] = [
  { key: 'again', label: 'Again', color: Colors.danger },
  { key: 'good', label: 'Good', color: Colors.primary },
  { key: 'easy', label: 'Easy', color: Colors.success },
];

export default function DeckStudy() {
  const insets = useSafeAreaInsets();
  const { deckId } = useLocalSearchParams<{ deckId: string }>();
  const { deck, dueCards, loading, reviewFlashcard, setDeckSaved } = useDeck(deckId || null);

  // Queue we walk through this session (snapshot of due cards, falls back to
  // the full deck when nothing is due so the user can always practise).
  const [queue, setQueue] = useState<any[] | null>(null);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewedAll, setReviewedAll] = useState(false);

  const allCards: any[] = useMemo(() => {
    const c = pick(deck, 'cards', 'items') || [];
    return Array.isArray(c) ? c : [];
  }, [deck]);

  // Seed the queue once cards arrive.
  useEffect(() => {
    if (queue !== null) return;
    if (dueCards && dueCards.length > 0) setQueue(dueCards);
    else if (allCards.length > 0) setQueue(allCards);
  }, [queue, dueCards, allCards]);

  const current = queue && index < queue.length ? queue[index] : null;
  const total = queue?.length ?? 0;

  const rate = useCallback(
    async (rating: FlashcardRating) => {
      if (!current) return;
      const cardId = pick(current, '_id', 'cardId', 'id');
      if (cardId) {
        reviewFlashcard({ cardId, rating } as any).catch(() => {});
      }
      setFlipped(false);
      if (index + 1 < total) {
        setIndex((i) => i + 1);
      } else {
        setReviewedAll(true);
      }
    },
    [current, index, total, reviewFlashcard],
  );

  const restart = useCallback(() => {
    setQueue(allCards.length ? allCards : null);
    setIndex(0);
    setFlipped(false);
    setReviewedAll(false);
  }, [allCards]);

  const front = current ? pick(current, 'front', 'question', 'term', 'prompt') : undefined;
  const frontLatex = current ? pick(current, 'frontLatex', 'promptLatex', 'front_latex') : undefined;
  const back = current ? pick(current, 'back', 'answer', 'definition') : undefined;
  const backLatex = current ? pick(current, 'backLatex', 'answerLatex', 'back_latex') : undefined;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {pick(deck, 'title', 'topic', 'subject') || 'Flashcards'}
        </Text>
        {deck ? (
          <TouchableOpacity
            onPress={() => setDeckSaved({ deckId, isSaved: !deck.isSaved } as any).catch(() => {})}
            hitSlop={10}
          >
            <Feather name="bookmark" size={22} color={deck.isSaved ? Colors.primary : Colors.textSecondary} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      {loading && !deck ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : reviewedAll || (queue && total === 0) ? (
        <View style={styles.center}>
          <Feather name="check-circle" size={44} color={Colors.success} />
          <Text style={styles.doneTitle}>All done for now!</Text>
          <Text style={styles.doneSub}>You reviewed every due card in this deck.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={restart}>
            <Feather name="rotate-ccw" size={18} color="#fff" />
            <Text style={styles.primaryBtnText}>Review all again</Text>
          </TouchableOpacity>
        </View>
      ) : !current ? (
        <View style={styles.center}>
          <Text style={styles.doneSub}>This deck has no cards yet.</Text>
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={styles.progress}>
            {index + 1} / {total}
          </Text>

          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.9}
            onPress={() => setFlipped((f) => !f)}
          >
            <Text style={styles.cardHint}>{flipped ? 'ANSWER' : 'TAP TO FLIP'}</Text>
            {!flipped ? (
              <View style={styles.cardContent}>
                {front ? <Text style={styles.cardText}>{String(front)}</Text> : null}
                {frontLatex ? <LatexView latex={String(frontLatex)} size={22} /> : null}
              </View>
            ) : (
              <View style={styles.cardContent}>
                {back ? <Text style={styles.cardText}>{String(back)}</Text> : null}
                {backLatex ? <LatexView latex={String(backLatex)} size={22} color={Colors.primaryDark} /> : null}
              </View>
            )}
          </TouchableOpacity>

          {flipped ? (
            <View style={styles.ratings}>
              {RATINGS.map((r) => (
                <TouchableOpacity
                  key={r.key}
                  style={[styles.ratingBtn, { backgroundColor: r.color }]}
                  onPress={() => rate(r.key)}
                >
                  <Text style={styles.ratingText}>{r.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <TouchableOpacity style={styles.flipBtn} onPress={() => setFlipped(true)}>
              <Feather name="refresh-cw" size={18} color={Colors.primary} />
              <Text style={styles.flipText}>Show answer</Text>
            </TouchableOpacity>
          )}
        </View>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  doneTitle: { color: Colors.textPrimary, fontSize: 19, fontWeight: '800', marginTop: 6 },
  doneSub: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center' },
  body: { flex: 1, padding: 20, justifyContent: 'center', gap: 20 },
  progress: { alignSelf: 'center', color: Colors.textSecondary, fontSize: 14, fontWeight: '700' },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 20,
    minHeight: 260,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  cardHint: {
    position: 'absolute',
    top: 16,
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  cardContent: { alignItems: 'center', gap: 10 },
  cardText: { color: Colors.textPrimary, fontSize: 22, fontWeight: '700', textAlign: 'center', lineHeight: 30 },
  ratings: { flexDirection: 'row', gap: 10 },
  ratingBtn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  ratingText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  flipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primaryLight,
    borderRadius: 14,
    paddingVertical: 15,
  },
  flipText: { color: Colors.primaryDark, fontSize: 15, fontWeight: '800' },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 24,
    marginTop: 8,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
