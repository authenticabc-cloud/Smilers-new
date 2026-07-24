/**
 * Room detail — shows the join code, and three tabs: Quizzes, Decks,
 * Members. Members can take shared quizzes and add to collaborative decks;
 * admins get a settings gear. Only `generateRoomQuiz` is Premium-gated.
 * getRoom returns null for non-members → we show a "not a member" state.
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
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Colors } from '../../../src/theme';
import { usePremiumAccess } from '../../../src/hooks/usePremiumAccess';
import { isPremiumRequiredError } from '../../../src/lib/study/useStudyAi';
import { useQuizzes } from '../../../src/lib/study/useRevision';
import { useRoom, useRoomDecks, useRoomQuizzes } from '../../../src/lib/study/useRooms';

function pick(o: any, ...keys: string[]) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

type Tab = 'quizzes' | 'decks' | 'members';

export default function RoomDetail() {
  const insets = useSafeAreaInsets();
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const premium = usePremiumAccess();
  const { room, loading } = useRoom(roomId || null);
  const { quizzes, shareQuizToRoom, deleteRoomQuiz, generate, generating } = useRoomQuizzes(roomId || null);
  const { decks, createRoomDeck } = useRoomDecks(roomId || null);

  const [tab, setTab] = useState<Tab>('quizzes');
  const [genOpen, setGenOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [newDeckOpen, setNewDeckOpen] = useState(false);

  const role = pick(room, 'role', 'myRole') || 'member';
  const isAdmin = role === 'owner' || role === 'admin';
  const joinCode = pick(room, 'joinCode', 'code');
  const members: any[] = useMemo(() => {
    const m = pick(room, 'members') || [];
    return Array.isArray(m) ? m : [];
  }, [room]);
  const aiCanRead = !!pick(room, 'aiCanReadRoomContent');

  const copyCode = useCallback(async () => {
    if (!joinCode) return;
    await Clipboard.setStringAsync(String(joinCode));
    Alert.alert('Copied', `Room code ${joinCode} copied to clipboard.`);
  }, [joinCode]);

  if (loading && !room) {
    return (
      <View style={styles.centerRoot}>
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  if (!room) {
    return (
      <View style={styles.centerRoot}>
        <Feather name="lock" size={34} color={Colors.textMuted} />
        <Text style={styles.notMember}>You&apos;re not a member of this room.</Text>
        <TouchableOpacity style={styles.linkBtn} onPress={() => router.replace('/study/rooms' as any)}>
          <Text style={styles.linkText}>Back to Study Rooms</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{pick(room, 'name') || 'Study room'}</Text>
        {isAdmin ? (
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/study/rooms/settings/[roomId]', params: { roomId } } as any)}
            hitSlop={10}
          >
            <Feather name="settings" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      {joinCode ? (
        <TouchableOpacity style={styles.codeCard} onPress={copyCode} activeOpacity={0.7}>
          <View>
            <Text style={styles.codeLabel}>ROOM CODE · tap to copy</Text>
            <Text style={styles.codeValue}>{String(joinCode)}</Text>
          </View>
          <Feather name="copy" size={20} color={Colors.primary} />
        </TouchableOpacity>
      ) : null}

      <View style={styles.tabs}>
        {(['quizzes', 'decks', 'members'] as Tab[]).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabOn]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>
              {t === 'quizzes' ? 'Quizzes' : t === 'decks' ? 'Decks' : `Members (${members.length || pick(room, 'memberCount') || 0})`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {tab === 'quizzes' ? (
          <>
            <View style={styles.rowBtns}>
              <TouchableOpacity style={styles.smallBtn} onPress={() => setGenOpen(true)}>
                <Feather name="zap" size={15} color="#fff" />
                <Text style={styles.smallBtnText}>Generate</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.smallBtn, styles.smallBtnAlt]} onPress={() => setShareOpen(true)}>
                <Feather name="share-2" size={15} color={Colors.primaryDark} />
                <Text style={[styles.smallBtnText, styles.smallBtnTextAlt]}>Share mine</Text>
              </TouchableOpacity>
            </View>
            {quizzes.length === 0 ? (
              <Empty icon="help-circle" text="No shared quizzes yet. Generate one or share yours." />
            ) : (
              quizzes.map((q: any) => (
                <TouchableOpacity
                  key={String(q._id)}
                  style={styles.itemRow}
                  onPress={() => router.push({ pathname: '/study/rooms/quiz/[roomQuizId]', params: { roomQuizId: String(q._id) } } as any)}
                >
                  <View style={styles.itemIcon}>
                    <Feather name="help-circle" size={18} color={Colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemTitle} numberOfLines={1}>{pick(q, 'title', 'topic') || 'Quiz'}</Text>
                    <Text style={styles.itemSub} numberOfLines={1}>
                      {`${pick(q, 'questionCount') ?? (q.questions?.length ?? '')} questions`}
                      {pick(q, 'sharedByName', 'ownerName') ? ` · by ${pick(q, 'sharedByName', 'ownerName')}` : ''}
                    </Text>
                  </View>
                  {isAdmin ? (
                    <TouchableOpacity
                      hitSlop={8}
                      onPress={() =>
                        Alert.alert('Remove quiz?', 'Remove this quiz from the room?', [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Remove', style: 'destructive', onPress: () => deleteRoomQuiz({ roomQuizId: q._id } as any).catch(() => {}) },
                        ])
                      }
                    >
                      <Feather name="trash-2" size={17} color={Colors.textMuted} />
                    </TouchableOpacity>
                  ) : (
                    <Feather name="chevron-right" size={20} color={Colors.textMuted} />
                  )}
                </TouchableOpacity>
              ))
            )}
          </>
        ) : null}

        {tab === 'decks' ? (
          <>
            <TouchableOpacity style={styles.smallBtn} onPress={() => setNewDeckOpen(true)}>
              <Feather name="plus" size={15} color="#fff" />
              <Text style={styles.smallBtnText}>New deck</Text>
            </TouchableOpacity>
            {decks.length === 0 ? (
              <Empty icon="copy" text="No collaborative decks yet. Create one — any member can add cards." />
            ) : (
              decks.map((d: any) => (
                <TouchableOpacity
                  key={String(d._id)}
                  style={styles.itemRow}
                  onPress={() => router.push({ pathname: '/study/rooms/deck/[roomDeckId]', params: { roomDeckId: String(d._id) } } as any)}
                >
                  <View style={styles.itemIcon}>
                    <Feather name="copy" size={18} color={Colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemTitle} numberOfLines={1}>{pick(d, 'title', 'topic') || 'Deck'}</Text>
                    <Text style={styles.itemSub} numberOfLines={1}>{`${pick(d, 'cardCount') ?? (d.cards?.length ?? 0)} cards`}</Text>
                  </View>
                  <Feather name="chevron-right" size={20} color={Colors.textMuted} />
                </TouchableOpacity>
              ))
            )}
          </>
        ) : null}

        {tab === 'members' ? (
          members.length === 0 ? (
            <Empty icon="users" text="Member list unavailable." />
          ) : (
            members.map((m: any, i: number) => {
              const mrole = pick(m, 'role') || 'member';
              return (
                <View key={pick(m, 'userId', '_id') || i} style={styles.itemRow}>
                  <View style={styles.itemIcon}>
                    <Feather name="user" size={18} color={Colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemTitle} numberOfLines={1}>{pick(m, 'name', 'displayName') || 'Member'}</Text>
                    {mrole !== 'member' ? <Text style={styles.itemSub}>{mrole}</Text> : null}
                  </View>
                </View>
              );
            })
          )
        ) : null}
      </ScrollView>

      <GenerateQuizSheet
        visible={genOpen}
        onClose={() => setGenOpen(false)}
        roomId={String(roomId)}
        aiCanRead={aiCanRead}
        premiumBlocked={!premium.hasAccess && !premium.isLoading}
        generate={generate}
        generating={generating}
      />
      <ShareQuizSheet visible={shareOpen} onClose={() => setShareOpen(false)} roomId={String(roomId)} shareQuizToRoom={shareQuizToRoom} />
      <NewDeckSheet visible={newDeckOpen} onClose={() => setNewDeckOpen(false)} roomId={String(roomId)} createRoomDeck={createRoomDeck} />
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

function GenerateQuizSheet({
  visible,
  onClose,
  roomId,
  aiCanRead,
  premiumBlocked,
  generate,
  generating,
}: {
  visible: boolean;
  onClose: () => void;
  roomId: string;
  aiCanRead: boolean;
  premiumBlocked: boolean;
  generate: (a: any) => Promise<any>;
  generating: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [topic, setTopic] = useState('');
  const [subject, setSubject] = useState('');
  const [useRoomContent, setUseRoomContent] = useState(false);

  const submit = useCallback(async () => {
    if (premiumBlocked) {
      onClose();
      Alert.alert('Study AI is Premium', 'Upgrade to generate group quizzes.', [
        { text: 'Not now', style: 'cancel' },
        { text: 'Upgrade', onPress: () => router.push('/premium' as any) },
      ]);
      return;
    }
    if (!topic.trim() && !subject.trim() && !useRoomContent) {
      Alert.alert('Add a topic', 'Type a topic, or use the room’s shared material.');
      return;
    }
    try {
      const res: any = await generate({
        roomId,
        topic: topic.trim() || undefined,
        subject: subject.trim() || undefined,
        useRoomContent,
      });
      onClose();
      setTopic('');
      setSubject('');
      setUseRoomContent(false);
      const id = res?.roomQuizId || res?._id;
      if (id) router.push({ pathname: '/study/rooms/quiz/[roomQuizId]', params: { roomQuizId: String(id) } } as any);
    } catch (err: any) {
      if (isPremiumRequiredError(err)) {
        onClose();
        Alert.alert('Study AI is Premium', 'Upgrade to generate group quizzes.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Upgrade', onPress: () => router.push('/premium' as any) },
        ]);
      } else if (/forbidden/i.test(String(err?.data?.code || err?.message))) {
        Alert.alert('AI access is off', 'Turn on “Let Study AI use this room’s shared material” in room settings to build from room content.');
      } else {
        Alert.alert('Could not generate', err?.data?.message || err?.message || 'Please try again.');
      }
    }
  }, [premiumBlocked, topic, subject, useRoomContent, generate, roomId, onClose]);

  return (
    <SheetShell visible={visible} onClose={generating ? () => {} : onClose} insets={insets} title="Generate a group quiz">
      <TextInput style={styles.field} placeholder="Topic (e.g. Cell division)" placeholderTextColor={Colors.textMuted} value={topic} onChangeText={setTopic} />
      <TextInput style={styles.field} placeholder="Subject (optional)" placeholderTextColor={Colors.textMuted} value={subject} onChangeText={setSubject} />
      {aiCanRead ? (
        <View style={styles.toggleRow}>
          <Text style={styles.toggleText}>Build from the room&apos;s shared material</Text>
          <Switch value={useRoomContent} onValueChange={setUseRoomContent} trackColor={{ true: Colors.primary }} />
        </View>
      ) : (
        <Text style={styles.hintText}>Tip: an admin can enable “Let Study AI use this room’s shared material” in settings to build quizzes from the room’s decks.</Text>
      )}
      <TouchableOpacity style={[styles.primaryBtn, generating && styles.btnDisabled]} onPress={submit} disabled={generating}>
        {generating ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Generate</Text>}
      </TouchableOpacity>
    </SheetShell>
  );
}

function ShareQuizSheet({
  visible,
  onClose,
  roomId,
  shareQuizToRoom,
}: {
  visible: boolean;
  onClose: () => void;
  roomId: string;
  shareQuizToRoom: (a: any) => Promise<any>;
}) {
  const insets = useSafeAreaInsets();
  const { quizzes } = useQuizzes();
  const [busyId, setBusyId] = useState<string | null>(null);

  const share = useCallback(
    async (quizId: string) => {
      setBusyId(quizId);
      try {
        await shareQuizToRoom({ roomId, quizId });
        onClose();
        Alert.alert('Shared', 'Your quiz is now available to the room.');
      } catch (err: any) {
        Alert.alert('Could not share', err?.data?.message || err?.message || 'Please try again.');
      } finally {
        setBusyId(null);
      }
    },
    [roomId, shareQuizToRoom, onClose],
  );

  return (
    <SheetShell visible={visible} onClose={onClose} insets={insets} title="Share one of your quizzes">
      {quizzes.length === 0 ? (
        <Text style={styles.hintText}>You have no quizzes yet. Create one in Revision Studio first.</Text>
      ) : (
        <ScrollView style={{ maxHeight: 320 }}>
          {quizzes.map((q: any) => (
            <TouchableOpacity key={String(q._id)} style={styles.pickerRow} onPress={() => share(String(q._id))} disabled={!!busyId}>
              <Feather name="help-circle" size={16} color={Colors.primary} />
              <Text style={styles.pickerText} numberOfLines={1}>{pick(q, 'title', 'topic') || 'Quiz'}</Text>
              {busyId === String(q._id) ? <ActivityIndicator size="small" color={Colors.primary} /> : <Feather name="share-2" size={16} color={Colors.textMuted} />}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </SheetShell>
  );
}

function NewDeckSheet({
  visible,
  onClose,
  roomId,
  createRoomDeck,
}: {
  visible: boolean;
  onClose: () => void;
  roomId: string;
  createRoomDeck: (a: any) => Promise<any>;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!title.trim()) {
      Alert.alert('Name the deck');
      return;
    }
    setBusy(true);
    try {
      const res: any = await createRoomDeck({ roomId, title: title.trim() });
      onClose();
      setTitle('');
      const id = res?.roomDeckId || res?.deckId || res?._id;
      if (id) router.push({ pathname: '/study/rooms/deck/[roomDeckId]', params: { roomDeckId: String(id) } } as any);
    } catch (err: any) {
      Alert.alert('Could not create deck', err?.data?.message || err?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [title, createRoomDeck, roomId, onClose]);

  return (
    <SheetShell visible={visible} onClose={busy ? () => {} : onClose} insets={insets} title="New collaborative deck">
      <TextInput style={styles.field} placeholder="Deck title" placeholderTextColor={Colors.textMuted} value={title} onChangeText={setTitle} />
      <TouchableOpacity style={[styles.primaryBtn, busy && styles.btnDisabled]} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Create deck</Text>}
      </TouchableOpacity>
    </SheetShell>
  );
}

function SheetShell({
  visible,
  onClose,
  insets,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  insets: { bottom: number };
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView behavior="padding" style={styles.sheetWrap}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>{title}</Text>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  centerRoot: { flex: 1, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  notMember: { color: Colors.textSecondary, fontSize: 15, textAlign: 'center' },
  linkBtn: { paddingVertical: 8 },
  linkText: { color: Colors.primaryDark, fontSize: 15, fontWeight: '700' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  headerTitle: { flex: 1, color: Colors.textPrimary, fontSize: 19, fontWeight: '800' },
  codeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: Colors.primaryLight,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  codeLabel: { color: Colors.primaryDark, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  codeValue: { color: Colors.primaryDark, fontSize: 24, fontWeight: '900', letterSpacing: 4, marginTop: 2 },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: 16,
    backgroundColor: Colors.borderLight,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: 9 },
  tabOn: { backgroundColor: Colors.primary },
  tabText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700' },
  tabTextOn: { color: '#fff' },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  rowBtns: { flexDirection: 'row', gap: 10 },
  smallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 16,
    flex: 1,
  },
  smallBtnAlt: { backgroundColor: Colors.primaryLight },
  smallBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  smallBtnTextAlt: { color: Colors.primaryDark },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
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
  itemTitle: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  itemSub: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
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
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, marginBottom: 6 },
  sheetTitle: { color: Colors.textPrimary, fontSize: 17, fontWeight: '800' },
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
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toggleText: { flex: 1, color: Colors.textPrimary, fontSize: 14, fontWeight: '600' },
  hintText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  pickerText: { flex: 1, color: Colors.textPrimary, fontSize: 14, fontWeight: '600' },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 15,
    marginTop: 4,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  btnDisabled: { opacity: 0.6 },
});
