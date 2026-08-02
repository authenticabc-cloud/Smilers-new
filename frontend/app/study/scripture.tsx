/**
 * Scripture reader — Bible & Quran (Study Materials).
 * Modes: "Read alone" (private) or "Read with all" (leader broadcasts the
 * position over the active Stream call so everyone's screen follows along).
 * NATIVE-ONLY for "read with all" (needs a live Stream call); "read alone"
 * works everywhere.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useQuery } from 'convex/react';

import { Colors } from '../../src/theme';
import { api } from '../../src/convexApi';
import {
  BIBLE_BOOKS,
  BIBLE_LANGUAGES,
  QURAN_LANGUAGES,
  fetchBibleChapter,
  fetchSurah,
  fetchSurahs,
  type BibleVerse,
  type QuranAyah,
  type Surah,
} from '../../src/lib/scripture/api';
import { useScriptureSync, type ScripturePosition } from '../../src/lib/scripture/sync';
import { useRoom } from '../../src/lib/study/useRooms';

type Material = 'bible' | 'quran';

function pickField(o: any, ...keys: string[]) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

export default function ScriptureScreen() {
  const params = useLocalSearchParams<{ type?: string; roomId?: string }>();
  const material: Material = params.type === 'quran' ? 'quran' : 'bible';
  const roomId = params.roomId || null;
  const me = useQuery(api.users.getCurrentUser, {}) as any;
  const myId = me?._id ? String(me._id) : 'me';

  // When reading inside a Study Room, only the room's admin/chief (the session
  // initiator) is the LEADER who broadcasts the position; every other member is
  // a FOLLOWER whose screen scrolls along. Previously `isLeader = mode==='all'`
  // made EVERY "Read with all" member a leader, so nobody ever subscribed to
  // the leader's position — the reason followers never saw the reader's screen.
  const { room } = useRoom(roomId);
  const roomRole = pickField(room, 'role', 'myRole', 'memberRole') || 'member';
  const isRoomAdmin = roomRole === 'owner' || roomRole === 'admin' || roomRole === 'chief';

  const [mode, setMode] = useState<'choose' | 'alone' | 'all'>('choose');
  // Leader = in "Read with all" AND (either the room admin/initiator, or there
  // is no room context — e.g. a plain 1:1/group call where the opener leads).
  const isLeader = mode === 'all' && (roomId ? isRoomAdmin : true);

  // Bible state
  const [bLangIdx, setBLangIdx] = useState(0);
  const [book, setBook] = useState(43); // John
  const [chapter, setChapter] = useState(3);
  const [verses, setVerses] = useState<BibleVerse[]>([]);
  const [bookName, setBookName] = useState('John');

  // Quran state
  const [qLangIdx, setQLangIdx] = useState(0);
  const [surahs, setSurahs] = useState<Surah[]>([]);
  const [surah, setSurah] = useState(1);
  const [ayahs, setAyahs] = useState<QuranAyah[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | 'book' | 'chapter' | 'surah' | 'lang'>(null);

  const scrollRef = useRef<ScrollView>(null);
  const contentH = useRef(0);
  const layoutH = useRef(0);
  const lastBroadcast = useRef(0);
  const applyingRemote = useRef(false);

  const bibleLang = BIBLE_LANGUAGES[bLangIdx];
  const quranLang = QURAN_LANGUAGES[qLangIdx];

  // ── Followers apply the leader's position ─────────────────────────────────
  const onRemote = useCallback(
    (pos: ScripturePosition) => {
      if (pos.leaderId === myId) return;
      applyingRemote.current = true;
      if (pos.material === 'bible') {
        if (pos.book && pos.book !== book) setBook(pos.book);
        if (pos.chapter && pos.chapter !== chapter) setChapter(pos.chapter);
        if (pos.translation) {
          const idx = BIBLE_LANGUAGES.findIndex((l) => l.translation === pos.translation);
          if (idx >= 0 && idx !== bLangIdx) setBLangIdx(idx);
        }
      } else {
        if (pos.surah && pos.surah !== surah) setSurah(pos.surah);
        if (pos.edition) {
          const idx = QURAN_LANGUAGES.findIndex((l) => l.edition === pos.edition);
          if (idx >= 0 && idx !== qLangIdx) setQLangIdx(idx);
        }
      }
      // Scroll to the leader's fraction.
      const max = Math.max(0, contentH.current - layoutH.current);
      scrollRef.current?.scrollTo({ y: pos.scrollPct * max, animated: true });
      setTimeout(() => {
        applyingRemote.current = false;
      }, 250);
    },
    [book, chapter, surah, bLangIdx, qLangIdx, myId],
  );

  const { broadcast } = useScriptureSync(mode === 'all' || mode === 'alone', isLeader, onRemote);

  const emit = useCallback(
    (scrollPct: number) => {
      if (!isLeader) return;
      broadcast({
        material,
        translation: material === 'bible' ? bibleLang.translation || undefined : undefined,
        edition: material === 'quran' ? quranLang.edition : undefined,
        book: material === 'bible' ? book : undefined,
        chapter: material === 'bible' ? chapter : undefined,
        surah: material === 'quran' ? surah : undefined,
        scrollPct,
        leaderId: myId,
        ts: Date.now(),
      });
    },
    [isLeader, material, bibleLang, quranLang, book, chapter, surah, myId, broadcast],
  );

  // ── Data loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (material !== 'quran') return;
    fetchSurahs().then(setSurahs).catch(() => {});
  }, [material]);

  useEffect(() => {
    if (material !== 'bible' || mode === 'choose') return;
    let active = true;
    setLoading(true);
    setError(null);
    if (!bibleLang.translation) {
      setError(`${bibleLang.label} isn't available yet — try another language.`);
      setVerses([]);
      setLoading(false);
      return;
    }
    fetchBibleChapter(bibleLang.translation, book, chapter)
      .then((d) => {
        if (!active) return;
        setVerses(d.verses);
        setBookName(d.book_name || BIBLE_BOOKS[book - 1]?.name || '');
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    if (isLeader) emit(0);
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, mode, bLangIdx, book, chapter]);

  useEffect(() => {
    if (material !== 'quran' || mode === 'choose') return;
    let active = true;
    setLoading(true);
    setError(null);
    fetchSurah(surah, quranLang.edition)
      .then((d) => {
        if (!active) return;
        setAyahs(d.ayahs);
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    if (isLeader) emit(0);
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, mode, qLangIdx, surah]);

  const onScroll = useCallback(
    (e: any) => {
      if (applyingRemote.current || !isLeader) return;
      const now = Date.now();
      if (now - lastBroadcast.current < 350) return;
      lastBroadcast.current = now;
      const max = Math.max(1, contentH.current - layoutH.current);
      emit(Math.min(1, Math.max(0, e.nativeEvent.contentOffset.y / max)));
    },
    [isLeader, emit],
  );

  const currentBook = BIBLE_BOOKS[book - 1];
  const langList = material === 'bible' ? BIBLE_LANGUAGES : QURAN_LANGUAGES;
  const setLangIdx = material === 'bible' ? setBLangIdx : setQLangIdx;
  const currentSurah = surahs.find((s) => s.number === surah);

  // ── Mode chooser ───────────────────────────────────────────────────────────
  if (mode === 'choose') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Header title={material === 'bible' ? 'Bible' : 'Quran'} />
        <View style={styles.chooseWrap}>
          <Feather name={material === 'bible' ? 'book-open' : 'book'} size={48} color={Colors.primary} />
          <Text style={styles.chooseTitle}>How would you like to read?</Text>
          <TouchableOpacity style={[styles.chooseBtn, styles.choosePrimary]} onPress={() => setMode('alone')}>
            <Feather name="user" size={20} color={Colors.white} />
            <View style={{ flex: 1 }}>
              <Text style={styles.chooseBtnTitle}>Read alone</Text>
              <Text style={styles.chooseBtnSub}>Just for you, privately</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chooseBtn, styles.chooseGhost]} onPress={() => setMode('all')}>
            <Feather name="users" size={20} color={Colors.textPrimary} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.chooseBtnTitle, { color: Colors.textPrimary }]}>Read with all</Text>
              <Text style={styles.chooseBtnSub}>Everyone in the call follows as you scroll</Text>
            </View>
          </TouchableOpacity>
          <Text style={styles.chooseHint}>“Read with all” needs an active study-room call.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Header
        title={material === 'bible' ? 'Bible' : 'Quran'}
        badge={mode === 'all' ? (isLeader ? 'Reading to all' : 'Following') : undefined}
      />

      {/* Selector bar */}
      <View style={styles.selBar}>
        <TouchableOpacity style={styles.selPill} onPress={() => setPicker('lang')}>
          <Feather name="globe" size={14} color={Colors.primaryDark} />
          <Text style={styles.selText}>
            {material === 'bible' ? `${bibleLang.label} · ${bibleLang.version}` : quranLang.label}
          </Text>
        </TouchableOpacity>
        {material === 'bible' ? (
          <>
            <TouchableOpacity style={styles.selPill} onPress={() => setPicker('book')}>
              <Text style={styles.selText}>{currentBook?.name}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selPill} onPress={() => setPicker('chapter')}>
              <Text style={styles.selText}>Ch. {chapter}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity style={styles.selPill} onPress={() => setPicker('surah')}>
            <Text style={styles.selText}>
              {currentSurah ? `${currentSurah.number}. ${currentSurah.englishName}` : `Surah ${surah}`}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Feather name="alert-triangle" size={16} color={Colors.warningDark} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={Colors.primary} size="large" /></View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.reader}
          contentContainerStyle={{ padding: 18, paddingBottom: 60 }}
          scrollEventThrottle={100}
          onScroll={onScroll}
          onContentSizeChange={(_w, h) => (contentH.current = h)}
          onLayout={(e) => (layoutH.current = e.nativeEvent.layout.height)}
        >
          {material === 'bible' ? (
            <>
              <Text style={styles.passageTitle}>{bookName} {chapter}</Text>
              {verses.map((v) => (
                <Text key={v.verse} style={styles.verse}>
                  <Text style={styles.verseNum}>{v.verse} </Text>
                  {v.text}
                </Text>
              ))}
            </>
          ) : (
            <>
              <Text style={styles.passageTitle}>
                {currentSurah ? currentSurah.englishName : `Surah ${surah}`}
              </Text>
              {ayahs.map((a) => (
                <View key={a.numberInSurah} style={styles.ayah}>
                  {a.arabic ? <Text style={styles.arabic}>{a.arabic}</Text> : null}
                  <Text style={styles.verse}>
                    <Text style={styles.verseNum}>{a.numberInSurah}. </Text>
                    {a.text}
                  </Text>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}

      {/* Pickers */}
      <PickerModal
        visible={picker === 'lang'}
        title="Language / Version"
        onClose={() => setPicker(null)}
        data={langList.map((l, i) => ({ key: String(i), label: material === 'bible' ? `${(l as any).label} · ${(l as any).version}` : (l as any).label, disabled: material === 'bible' && !(l as any).translation }))}
        onSelect={(k) => { setLangIdx(Number(k)); setPicker(null); }}
      />
      <PickerModal
        visible={picker === 'book'}
        title="Book"
        onClose={() => setPicker(null)}
        data={BIBLE_BOOKS.map((b) => ({ key: String(b.nr), label: b.name }))}
        onSelect={(k) => { const nr = Number(k); setBook(nr); setChapter(1); setPicker(null); }}
      />
      <PickerModal
        visible={picker === 'chapter'}
        title="Chapter"
        onClose={() => setPicker(null)}
        data={Array.from({ length: currentBook?.chapters || 1 }, (_v, i) => ({ key: String(i + 1), label: `Chapter ${i + 1}` }))}
        onSelect={(k) => { setChapter(Number(k)); setPicker(null); }}
      />
      <PickerModal
        visible={picker === 'surah'}
        title="Surah"
        onClose={() => setPicker(null)}
        data={surahs.map((s) => ({ key: String(s.number), label: `${s.number}. ${s.englishName} — ${s.englishNameTranslation}` }))}
        onSelect={(k) => { setSurah(Number(k)); setPicker(null); }}
      />
    </SafeAreaView>
  );
}

function Header({ title, badge }: { title: string; badge?: string }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
        <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{title}</Text>
      {badge ? (
        <View style={styles.badge}>
          <Feather name="radio" size={12} color={Colors.white} />
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
    </View>
  );
}

function PickerModal({
  visible,
  title,
  data,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  data: { key: string; label: string; disabled?: boolean }[];
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8}><Feather name="x" size={22} color={Colors.textPrimary} /></Pressable>
          </View>
          <FlatList
            data={data}
            keyExtractor={(i) => i.key}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.modalRow}
                disabled={item.disabled}
                onPress={() => onSelect(item.key)}
              >
                <Text style={[styles.modalRowText, item.disabled && styles.modalRowDisabled]}>
                  {item.label}{item.disabled ? '  (soon)' : ''}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '800', color: Colors.textPrimary },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: Colors.danger, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14 },
  badgeText: { color: Colors.white, fontSize: 11, fontWeight: '800' },
  chooseWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  chooseTitle: { fontSize: 20, fontWeight: '800', color: Colors.textPrimary, marginBottom: 8 },
  chooseBtn: { flexDirection: 'row', alignItems: 'center', gap: 14, width: '100%', padding: 18, borderRadius: 16 },
  choosePrimary: { backgroundColor: Colors.primary },
  chooseGhost: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chooseBtnTitle: { fontSize: 17, fontWeight: '800', color: Colors.white },
  chooseBtnSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  chooseHint: { fontSize: 12, color: Colors.textSecondary, textAlign: 'center', marginTop: 6 },
  selBar: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 10, flexWrap: 'wrap' },
  selPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20 },
  selText: { fontSize: 13, fontWeight: '700', color: Colors.textPrimary },
  reader: { flex: 1, backgroundColor: Colors.surface },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  passageTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginBottom: 14 },
  verse: { fontSize: 18, lineHeight: 30, color: Colors.textPrimary, marginBottom: 8 },
  verseNum: { fontSize: 13, fontWeight: '800', color: Colors.primaryDark },
  ayah: { marginBottom: 16 },
  arabic: { fontSize: 24, lineHeight: 42, color: Colors.textPrimary, textAlign: 'right', marginBottom: 6 },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.warningLight, marginHorizontal: 12, borderRadius: 12, padding: 12, marginBottom: 8 },
  errorText: { flex: 1, color: Colors.warningDark, fontSize: 13 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: Colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '72%', paddingBottom: 20 },
  modalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  modalTitle: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary },
  modalRow: { paddingVertical: 14, paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: Colors.borderLight },
  modalRowText: { fontSize: 16, color: Colors.textPrimary },
  modalRowDisabled: { color: Colors.textMuted },
});
