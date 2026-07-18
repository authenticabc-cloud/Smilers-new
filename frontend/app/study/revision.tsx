/**
 * Revision Studio — hub for Quizzes, Flashcards and Notes/Study-Plans.
 * Generation is Premium-gated (revisionAi.*); lists/management are ungated.
 * A "Create" sheet builds new material from pasted text (+ subject/topic).
 * New items start unsaved; the streak header comes from study.progress.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../src/theme';
import { usePremiumAccess } from '../../src/hooks/usePremiumAccess';
import { isPremiumRequiredError } from '../../src/lib/study/useStudyAi';
import {
  useDecks,
  useNotes,
  useQuizzes,
  useRevisionGenerate,
  useStudyProgress,
} from '../../src/lib/study/useRevision';

type Tab = 'quizzes' | 'flashcards' | 'notes';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'quizzes', label: 'Quizzes', icon: 'help-circle' },
  { key: 'flashcards', label: 'Flashcards', icon: 'copy' },
  { key: 'notes', label: 'Notes', icon: 'file-text' },
];

export default function RevisionStudio() {
  const insets = useSafeAreaInsets();
  const premium = usePremiumAccess();
  const [tab, setTab] = useState<Tab>('quizzes');
  const [createOpen, setCreateOpen] = useState(false);

  const { quizzes, setQuizSaved, deleteQuiz } = useQuizzes();
  const { decks, setDeckSaved, deleteDeck } = useDecks();
  const { notes, setNoteSaved, deleteNote } = useNotes();
  const { progress } = useStudyProgress();

  const streak = progress?.currentStreak ?? progress?.streak ?? 0;
  const savedCount =
    (quizzes.filter((q: any) => q.isSaved).length || 0) +
    (decks.filter((d: any) => d.isSaved).length || 0) +
    (notes.filter((n: any) => n.isSaved).length || 0);

  const confirmDelete = useCallback(
    (label: string, fn: () => void) => {
      Alert.alert(`Delete ${label}?`, 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: fn },
      ]);
    },
    [],
  );

  const renderList = () => {
    if (tab === 'quizzes') {
      if (quizzes.length === 0) return <Empty icon="help-circle" text="No quizzes yet. Tap Create to generate one." />;
      return quizzes.map((q: any) => (
        <ItemRow
          key={String(q._id)}
          icon="help-circle"
          title={q.title || q.topic || q.subject || 'Quiz'}
          subtitle={`${(q.questions?.length ?? q.questionCount ?? '')} questions${q.subject ? ` · ${q.subject}` : ''}`}
          isSaved={!!q.isSaved}
          onPress={() => router.push({ pathname: '/study/quiz/[quizId]', params: { quizId: String(q._id) } } as any)}
          onToggleSave={() => setQuizSaved({ quizId: q._id, isSaved: !q.isSaved } as any).catch(() => {})}
          onDelete={() => confirmDelete('quiz', () => deleteQuiz({ quizId: q._id } as any).catch(() => {}))}
        />
      ));
    }
    if (tab === 'flashcards') {
      if (decks.length === 0) return <Empty icon="copy" text="No decks yet. Tap Create to generate flashcards." />;
      return decks.map((d: any) => (
        <ItemRow
          key={String(d._id)}
          icon="copy"
          title={d.title || d.topic || d.subject || 'Flashcard deck'}
          subtitle={`${(d.cards?.length ?? d.cardCount ?? '')} cards${d.subject ? ` · ${d.subject}` : ''}`}
          isSaved={!!d.isSaved}
          onPress={() => router.push({ pathname: '/study/deck/[deckId]', params: { deckId: String(d._id) } } as any)}
          onToggleSave={() => setDeckSaved({ deckId: d._id, isSaved: !d.isSaved } as any).catch(() => {})}
          onDelete={() => confirmDelete('deck', () => deleteDeck({ deckId: d._id } as any).catch(() => {}))}
        />
      ));
    }
    if (notes.length === 0) return <Empty icon="file-text" text="No notes yet. Create a summary or study plan." />;
    return notes.map((n: any) => (
      <ItemRow
        key={String(n._id)}
        icon={n.kind === 'study_plan' ? 'calendar' : 'file-text'}
        title={n.title || n.topic || (n.kind === 'study_plan' ? 'Study plan' : 'Summary')}
        subtitle={n.kind === 'study_plan' ? 'Study plan' : 'Summary'}
        isSaved={!!n.isSaved}
        onPress={() => router.push({ pathname: '/study/note/[noteId]', params: { noteId: String(n._id) } } as any)}
        onToggleSave={() => setNoteSaved({ noteId: n._id, isSaved: !n.isSaved } as any).catch(() => {})}
        onDelete={() => confirmDelete('note', () => deleteNote({ noteId: n._id } as any).catch(() => {}))}
      />
    ));
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Revision Studio</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Feather name="zap" size={16} color={Colors.primary} />
          <Text style={styles.statValue}>{streak}</Text>
          <Text style={styles.statLabel}>day streak</Text>
        </View>
        <View style={styles.statCard}>
          <Feather name="bookmark" size={16} color={Colors.primary} />
          <Text style={styles.statValue}>{savedCount}</Text>
          <Text style={styles.statLabel}>saved</Text>
        </View>
      </View>

      <View style={styles.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, tab === t.key && styles.tabOn]}
            onPress={() => setTab(t.key)}
          >
            <Feather name={t.icon as any} size={15} color={tab === t.key ? '#fff' : Colors.textSecondary} />
            <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {renderList()}
      </ScrollView>

      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 20 }]}
        onPress={() => setCreateOpen(true)}
        activeOpacity={0.85}
      >
        <Feather name="plus" size={22} color="#fff" />
        <Text style={styles.fabText}>Create</Text>
      </TouchableOpacity>

      <CreateSheet
        visible={createOpen}
        tab={tab}
        premiumBlocked={!premium.hasAccess && !premium.isLoading}
        onClose={() => setCreateOpen(false)}
      />
    </View>
  );
}

function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={styles.empty}>
      <Feather name={icon as any} size={28} color={Colors.textMuted} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function ItemRow({
  icon,
  title,
  subtitle,
  isSaved,
  onPress,
  onToggleSave,
  onDelete,
}: {
  icon: string;
  title: string;
  subtitle: string;
  isSaved: boolean;
  onPress: () => void;
  onToggleSave: () => void;
  onDelete: () => void;
}) {
  return (
    <TouchableOpacity style={styles.itemRow} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.itemIcon}>
        <Feather name={icon as any} size={18} color={Colors.primary} />
      </View>
      <View style={styles.itemBody}>
        <Text style={styles.itemTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.itemSub} numberOfLines={1}>{subtitle}</Text>
      </View>
      <TouchableOpacity onPress={onToggleSave} hitSlop={8} style={styles.itemAction}>
        <Feather name="bookmark" size={18} color={isSaved ? Colors.primary : Colors.textMuted} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onDelete} hitSlop={8} style={styles.itemAction}>
        <Feather name="trash-2" size={17} color={Colors.textMuted} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const KIND_OPTIONS: Record<Tab, { key: 'quiz' | 'flashcards' | 'summary' | 'study_plan'; label: string }[]> = {
  quizzes: [{ key: 'quiz', label: 'Quiz' }],
  flashcards: [{ key: 'flashcards', label: 'Flashcards' }],
  notes: [
    { key: 'summary', label: 'Summary' },
    { key: 'study_plan', label: 'Study plan' },
  ],
};

function CreateSheet({
  visible,
  tab,
  premiumBlocked,
  onClose,
}: {
  visible: boolean;
  tab: Tab;
  premiumBlocked: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { run, generating } = useRevisionGenerate();
  const kinds = KIND_OPTIONS[tab];
  const [kind, setKind] = useState(kinds[0].key);
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [sourceText, setSourceText] = useState('');

  // Keep the selected kind valid when the active tab changes.
  useEffect(() => setKind(KIND_OPTIONS[tab][0].key), [tab]);

  const submit = useCallback(async () => {
    if (premiumBlocked) {
      onClose();
      Alert.alert('Study AI is Premium', 'Upgrade to generate quizzes, flashcards and plans.', [
        { text: 'Not now', style: 'cancel' },
        { text: 'Upgrade', onPress: () => router.push('/premium' as any) },
      ]);
      return;
    }
    if (!sourceText.trim() && !topic.trim() && !subject.trim()) {
      Alert.alert('Add a topic or notes', 'Type a topic, or paste some notes to build from.');
      return;
    }
    try {
      const res: any = await run(kind, {
        sourceText: sourceText.trim() || undefined,
        subject: subject.trim() || undefined,
        topic: topic.trim() || undefined,
      });
      onClose();
      setSourceText('');
      setTopic('');
      setSubject('');
      const id = res?.quizId || res?.deckId || res?.noteId;
      if (!id) return;
      if (kind === 'quiz') router.push({ pathname: '/study/quiz/[quizId]', params: { quizId: String(id) } } as any);
      else if (kind === 'flashcards') router.push({ pathname: '/study/deck/[deckId]', params: { deckId: String(id) } } as any);
      else router.push({ pathname: '/study/note/[noteId]', params: { noteId: String(id) } } as any);
    } catch (err: any) {
      if (isPremiumRequiredError(err)) {
        onClose();
        Alert.alert('Study AI is Premium', 'Upgrade to generate revision material.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Upgrade', onPress: () => router.push('/premium' as any) },
        ]);
      } else {
        Alert.alert('Could not generate', err?.data?.message || err?.message || 'Please try again.');
      }
    }
  }, [premiumBlocked, sourceText, topic, subject, run, kind, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={generating ? undefined : onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheetWrap}
      >
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Create revision material</Text>

          {kinds.length > 1 ? (
            <View style={styles.kindRow}>
              {kinds.map((k) => (
                <TouchableOpacity
                  key={k.key}
                  style={[styles.kindChip, kind === k.key && styles.kindChipOn]}
                  onPress={() => setKind(k.key)}
                >
                  <Text style={[styles.kindText, kind === k.key && styles.kindTextOn]}>{k.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          <TextInput
            style={styles.field}
            placeholder="Topic (e.g. Photosynthesis)"
            placeholderTextColor={Colors.textMuted}
            value={topic}
            onChangeText={setTopic}
          />
          <TextInput
            style={styles.field}
            placeholder="Subject (optional)"
            placeholderTextColor={Colors.textMuted}
            value={subject}
            onChangeText={setSubject}
          />
          <TextInput
            style={[styles.field, styles.fieldMulti]}
            placeholder="Or paste your notes to build from…"
            placeholderTextColor={Colors.textMuted}
            value={sourceText}
            onChangeText={setSourceText}
            multiline
          />

          <TouchableOpacity
            style={[styles.generateBtn, generating && styles.generateBtnDisabled]}
            onPress={submit}
            disabled={generating}
          >
            {generating ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Feather name="zap" size={18} color="#fff" />
                <Text style={styles.generateText}>Generate</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  headerTitle: { flex: 1, color: Colors.textPrimary, fontSize: 20, fontWeight: '800' },
  statsRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginBottom: 12 },
  statCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  statValue: { color: Colors.textPrimary, fontSize: 18, fontWeight: '800' },
  statLabel: { color: Colors.textSecondary, fontSize: 12 },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: 16,
    backgroundColor: Colors.borderLight,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 9,
  },
  tabOn: { backgroundColor: Colors.primary },
  tabText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700' },
  tabTextOn: { color: '#fff' },
  content: { padding: 16, paddingBottom: 120, gap: 10 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 56, paddingHorizontal: 24 },
  emptyText: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  itemIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemBody: { flex: 1 },
  itemTitle: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  itemSub: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  itemAction: { padding: 4 },
  fab: {
    position: 'absolute',
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 26,
    paddingHorizontal: 20,
    paddingVertical: 14,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  fabText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 12,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    marginBottom: 6,
  },
  sheetTitle: { color: Colors.textPrimary, fontSize: 17, fontWeight: '800' },
  kindRow: { flexDirection: 'row', gap: 8 },
  kindChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: Colors.borderLight,
  },
  kindChipOn: { backgroundColor: Colors.primary },
  kindText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700' },
  kindTextOn: { color: '#fff' },
  field: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  fieldMulti: { minHeight: 90, textAlignVertical: 'top' },
  generateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 15,
    marginTop: 4,
  },
  generateBtnDisabled: { opacity: 0.6 },
  generateText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
