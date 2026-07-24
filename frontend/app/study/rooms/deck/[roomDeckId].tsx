/**
 * Collaborative room deck — any member can add cards; everyone can study.
 * "Study" flips through the deck; "Add card" appends front/back via
 * addRoomCard. Card authors (and admins) can delete cards.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../../../src/theme';
import { useRoomDeck } from '../../../../src/lib/study/useRooms';

function pick(o: any, ...keys: string[]) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

export default function RoomDeckScreen() {
  const insets = useSafeAreaInsets();
  const { roomDeckId } = useLocalSearchParams<{ roomDeckId: string }>();
  const { deck, loading, addRoomCard, deleteRoomCard } = useRoomDeck(roomDeckId || null);

  const [addOpen, setAddOpen] = useState(false);
  const [studying, setStudying] = useState(false);

  const cards: any[] = useMemo(() => {
    const c = pick(deck, 'cards', 'items') || [];
    return Array.isArray(c) ? c : [];
  }, [deck]);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{pick(deck, 'title', 'topic') || 'Deck'}</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading && !deck ? (
        <View style={styles.center}><ActivityIndicator color={Colors.primary} /></View>
      ) : studying && cards.length > 0 ? (
        <StudyMode cards={cards} onExit={() => setStudying(false)} />
      ) : (
        <>
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.actionBtn, cards.length === 0 && styles.btnDisabled]}
              onPress={() => setStudying(true)}
              disabled={cards.length === 0}
            >
              <Feather name="play" size={16} color="#fff" />
              <Text style={styles.actionText}>Study ({cards.length})</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.actionBtnAlt]} onPress={() => setAddOpen(true)}>
              <Feather name="plus" size={16} color={Colors.primaryDark} />
              <Text style={[styles.actionText, styles.actionTextAlt]}>Add card</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {cards.length === 0 ? (
              <View style={styles.center}>
                <Feather name="copy" size={28} color={Colors.textMuted} />
                <Text style={styles.emptyText}>No cards yet. Add the first one — the whole room shares this deck.</Text>
              </View>
            ) : (
              cards.map((c: any, i: number) => (
                <View key={pick(c, '_id', 'id') || i} style={styles.cardRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardFront}>{String(pick(c, 'front', 'question', 'term') || '')}</Text>
                    <Text style={styles.cardBack}>{String(pick(c, 'back', 'answer', 'definition') || '')}</Text>
                    {pick(c, 'addedByName', 'authorName') ? (
                      <Text style={styles.cardBy}>added by {pick(c, 'addedByName', 'authorName')}</Text>
                    ) : null}
                  </View>
                  {pick(c, 'canDelete') !== false ? (
                    <TouchableOpacity
                      hitSlop={8}
                      onPress={() =>
                        Alert.alert('Delete card?', undefined, [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: () => deleteRoomCard({ cardId: pick(c, '_id', 'id') } as any).catch(() => {}) },
                        ])
                      }
                    >
                      <Feather name="trash-2" size={16} color={Colors.textMuted} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))
            )}
          </ScrollView>
        </>
      )}

      <AddCardSheet visible={addOpen} onClose={() => setAddOpen(false)} roomDeckId={String(roomDeckId)} addRoomCard={addRoomCard} />
    </View>
  );
}

function StudyMode({ cards, onExit }: { cards: any[]; onExit: () => void }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const c = cards[index];
  const front = pick(c, 'front', 'question', 'term');
  const back = pick(c, 'back', 'answer', 'definition');

  const next = useCallback(() => {
    setFlipped(false);
    setIndex((i) => (i + 1) % cards.length);
  }, [cards.length]);

  return (
    <View style={styles.study}>
      <View style={styles.studyTop}>
        <Text style={styles.progress}>{index + 1} / {cards.length}</Text>
        <TouchableOpacity onPress={onExit} hitSlop={8}>
          <Feather name="x" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={styles.flashcard} activeOpacity={0.9} onPress={() => setFlipped((f) => !f)}>
        <Text style={styles.cardHint}>{flipped ? 'ANSWER' : 'TAP TO FLIP'}</Text>
        <Text style={styles.flashText}>{String((flipped ? back : front) || '')}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.nextBtn} onPress={next}>
        <Text style={styles.nextText}>Next</Text>
        <Feather name="arrow-right" size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

function AddCardSheet({
  visible,
  onClose,
  roomDeckId,
  addRoomCard,
}: {
  visible: boolean;
  onClose: () => void;
  roomDeckId: string;
  addRoomCard: (a: any) => Promise<any>;
}) {
  const insets = useSafeAreaInsets();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!front.trim() || !back.trim()) {
      Alert.alert('Fill both sides', 'Add a front (question) and a back (answer).');
      return;
    }
    setBusy(true);
    try {
      await addRoomCard({ roomDeckId, front: front.trim(), back: back.trim() });
      setFront('');
      setBack('');
      onClose();
    } catch (err: any) {
      Alert.alert('Could not add card', err?.data?.message || err?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [front, back, addRoomCard, roomDeckId, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose} />
      <KeyboardAvoidingView behavior="padding" style={styles.sheetWrap}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Add a card</Text>
          <TextInput style={[styles.field, styles.fieldMulti]} placeholder="Front (question / term)" placeholderTextColor={Colors.textMuted} value={front} onChangeText={setFront} multiline />
          <TextInput style={[styles.field, styles.fieldMulti]} placeholder="Back (answer / definition)" placeholderTextColor={Colors.textMuted} value={back} onChangeText={setBack} multiline />
          <TouchableOpacity style={[styles.primaryBtn, busy && styles.btnDisabled]} onPress={submit} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Add card</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 10 },
  headerTitle: { flex: 1, color: Colors.textPrimary, fontSize: 17, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  emptyText: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  actionRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginBottom: 8 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 12 },
  actionBtnAlt: { backgroundColor: Colors.primaryLight },
  actionText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  actionTextAlt: { color: Colors.primaryDark },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  cardFront: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  cardBack: { color: Colors.textSecondary, fontSize: 14, marginTop: 4, lineHeight: 20 },
  cardBy: { color: Colors.textMuted, fontSize: 11, marginTop: 6 },
  study: { flex: 1, padding: 20, gap: 18 },
  studyTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progress: { color: Colors.textSecondary, fontSize: 14, fontWeight: '700' },
  flashcard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  cardHint: { position: 'absolute', top: 16, color: Colors.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  flashText: { color: Colors.textPrimary, fontSize: 22, fontWeight: '700', textAlign: 'center', lineHeight: 30 },
  nextBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 15 },
  nextText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: Colors.background, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 20, paddingTop: 10, gap: 12 },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, marginBottom: 6 },
  sheetTitle: { color: Colors.textPrimary, fontSize: 17, fontWeight: '800' },
  field: { backgroundColor: Colors.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: Colors.textPrimary, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border },
  fieldMulti: { minHeight: 70, textAlignVertical: 'top' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 15, marginTop: 4 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  btnDisabled: { opacity: 0.6 },
});
