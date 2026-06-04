/**
 * Diary screen — LOCAL-ONLY personal notes (iter-111).
 *
 * ⚠ PRIVACY-CRITICAL DESIGN ⚠
 *
 * Diary used to route through `/chat/<id>?mode=diary` and back itself
 * with a server-side self-conversation. On the current backend, that
 * resulted in cross-user data leakage (one user's Diary view contained
 * another user's PDFs/videos — see screenshot from 2026-06-04 14:08).
 *
 * iter-111 rewrites Diary as a 100% LOCAL screen that:
 *   - Reads/writes ONLY from AsyncStorage via /src/lib/diaryStore.ts
 *   - NEVER calls a Convex mutation or query
 *   - NEVER mounts the regular chat screen so there's zero risk of
 *     diary chrome leaking onto another conversation's data
 *   - Per-user storage key (`smilers.diary.<userId>.entries.v1`) so
 *     multi-account devices don't cross-contaminate
 *
 * Functionality on parity with the web app spec (per user screenshots):
 *   ✓ Blue book avatar + "Diary / Your personal notes" header
 *   ✓ Search icon → "Search diary messages…" overlay with live filter
 *   ✓ Composer "Write a note…" + send → appends to local store
 *   ✓ Renders forwarded messages with their source attribution
 *   ✓ Long-press to delete a single entry
 *   ✓ Header menu → "Clear all entries" with confirmation
 *
 * Re-enabling cloud sync is a backend dependency, NOT a code dependency:
 * once `api.diary.appendEntry` / `api.diary.listEntries` exist with a
 * per-user isolated table, swap `appendDiaryEntry` / `readDiaryEntries`
 * for Convex mutations + reactive queries here. No call-site changes
 * needed elsewhere.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import {
  appendDiaryEntry,
  clearDiary,
  deleteDiaryEntry,
  readDiaryEntries,
  type DiaryEntry,
} from '../src/lib/diaryStore';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

function formatTime(ms: number): string {
  try {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDay(ms: number): string {
  try {
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

interface RenderItem {
  type: 'day' | 'entry';
  day?: string;
  entry?: DiaryEntry;
  key: string;
}

export default function DiaryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useQuery(api.users.getCurrentUser);
  const myUserId = me?._id ? String(me._id) : null;
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const listRef = useRef<FlatList<RenderItem> | null>(null);

  // Initial load.
  useEffect(() => {
    if (!myUserId) return;
    let cancelled = false;
    (async () => {
      const data = await readDiaryEntries(myUserId);
      if (!cancelled) {
        setEntries(data);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [myUserId]);

  const visibleEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      const text = (e.text || '').toLowerCase();
      const fileName = (e.attachment?.fileName || '').toLowerCase();
      const forwardedFromName = (e.forwardedFrom?.conversationName || '').toLowerCase();
      return text.includes(q) || fileName.includes(q) || forwardedFromName.includes(q);
    });
  }, [entries, searchQuery]);

  // Build display rows with day separators. Newest-at-bottom convention.
  const rows: RenderItem[] = useMemo(() => {
    const sorted = [...visibleEntries].sort((a, b) => a._creationTime - b._creationTime);
    const out: RenderItem[] = [];
    let lastDay = '';
    for (const entry of sorted) {
      const day = formatDay(entry._creationTime);
      if (day !== lastDay) {
        out.push({ type: 'day', day, key: `day-${entry._creationTime}` });
        lastDay = day;
      }
      out.push({ type: 'entry', entry, key: entry._id });
    }
    return out;
  }, [visibleEntries]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || !myUserId) return;
    setDraft('');
    const entry = await appendDiaryEntry(myUserId, { kind: 'text', text });
    setEntries((prev) => [...prev, entry]);
    requestAnimationFrame(() => {
      try { listRef.current?.scrollToEnd({ animated: true }); } catch {}
    });
  }, [draft, myUserId]);

  const handleDelete = useCallback(async (entryId: string) => {
    if (!myUserId) return;
    await deleteDiaryEntry(myUserId, entryId);
    setEntries((prev) => prev.filter((e) => e._id !== entryId));
    setPendingDeleteId(null);
  }, [myUserId]);

  const handleClearAll = useCallback(() => {
    Alert.alert(
      'Clear all diary entries?',
      'This will permanently remove every note you\u2019ve saved to Diary on THIS device. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: async () => {
            if (!myUserId) return;
            await clearDiary(myUserId);
            setEntries([]);
            setShowMenu(false);
          },
        },
      ],
    );
  }, [myUserId]);

  const renderItem = useCallback(({ item }: { item: RenderItem }) => {
    if (item.type === 'day') {
      return (
        <View style={styles.dayChipWrap}>
          <Text style={styles.dayChip}>{item.day}</Text>
        </View>
      );
    }
    const entry = item.entry as DiaryEntry;
    const time = formatTime(entry._creationTime);
    return (
      <Pressable
        onLongPress={() => setPendingDeleteId(entry._id)}
        delayLongPress={350}
        style={styles.bubbleRow}
      >
        <View style={styles.bubble}>
          {entry.forwardedFrom ? (
            <View style={styles.forwardedHeader}>
              <Feather name="corner-up-right" size={12} color={Colors.diary} />
              <Text style={styles.forwardedHeaderText} numberOfLines={1}>
                Forwarded from {entry.forwardedFrom.conversationName || 'a chat'}
                {entry.forwardedFrom.originalSenderName
                  ? ` · ${entry.forwardedFrom.originalSenderName}`
                  : ''}
              </Text>
            </View>
          ) : null}
          {entry.attachment ? (
            <View style={styles.attachmentWrap}>
              {entry.kind === 'image' && entry.attachment.mediaUrl ? (
                <Image
                  source={{ uri: entry.attachment.mediaUrl }}
                  style={styles.attachmentImage}
                  resizeMode="cover"
                />
              ) : (
                <View style={styles.attachmentFile}>
                  <MaterialCommunityIcons
                    name={
                      entry.kind === 'video'
                        ? 'video-outline'
                        : entry.kind === 'audio'
                          ? 'microphone-outline'
                          : entry.kind === 'gif'
                            ? 'file-gif-box'
                            : 'file-outline'
                    }
                    size={20}
                    color={Colors.diaryDark}
                  />
                  <Text style={styles.attachmentFileName} numberOfLines={1}>
                    {entry.attachment.fileName || entry.kind.toUpperCase()}
                  </Text>
                </View>
              )}
            </View>
          ) : null}
          {entry.text ? <Text style={styles.bubbleText}>{entry.text}</Text> : null}
          <Text style={styles.bubbleTime}>{time}</Text>
        </View>
      </Pressable>
    );
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="diary-screen">
      <View style={[styles.header, { paddingTop: 8 }]} testID="diary-header">
        <TouchableOpacity
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/(tabs)/chats' as any);
          }}
          style={styles.headerIconBtn}
          testID="diary-back-btn"
        >
          <Feather name="arrow-left" size={22} color={Colors.white} />
        </TouchableOpacity>
        <View style={styles.headerAvatar}>
          <MaterialCommunityIcons name="book-account-outline" size={20} color={Colors.white} />
        </View>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle} numberOfLines={1}>Diary</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>Your personal notes</Text>
        </View>
        <TouchableOpacity
          onPress={() => {
            const next = !searchOpen;
            setSearchOpen(next);
            if (!next) setSearchQuery('');
          }}
          style={styles.headerIconBtn}
          testID="diary-search-btn"
        >
          <Feather name={searchOpen ? 'x' : 'search'} size={20} color={Colors.white} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setShowMenu(true)}
          style={styles.headerIconBtn}
          testID="diary-menu-btn"
        >
          <Feather name="more-vertical" size={20} color={Colors.white} />
        </TouchableOpacity>
      </View>

      {searchOpen ? (
        <View style={styles.searchBar}>
          <Feather name="search" size={16} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search diary messages…"
            placeholderTextColor={Colors.textMuted}
            autoFocus
            returnKeyType="search"
            testID="diary-search-input"
          />
          {searchQuery.length > 0 ? (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
              <Feather name="x-circle" size={16} color={Colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
      >
        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={Colors.diary} size="large" />
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.emptyWrap}>
            <View style={styles.emptyIcon}>
              <MaterialCommunityIcons name="book-account-outline" size={36} color={Colors.diaryDark} />
            </View>
            <Text style={styles.emptyTitle}>
              {searchQuery ? 'No matching notes' : 'Your Diary is empty'}
            </Text>
            <Text style={styles.emptyBody}>
              {searchQuery
                ? 'Try a different search term.'
                : 'Notes you save here stay private to this device. Forward any message from a chat to save it here.'}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() => {
              try { listRef.current?.scrollToEnd({ animated: false }); } catch {}
            }}
            testID="diary-list"
          />
        )}

        <View style={[styles.composer, { paddingBottom: Math.max(8, insets.bottom) }]}>
          <TextInput
            style={styles.composerInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Write a note…"
            placeholderTextColor={Colors.textMuted}
            multiline
            testID="diary-composer"
          />
          <TouchableOpacity
            style={[styles.composerSend, !draft.trim() ? styles.composerSendDisabled : null]}
            onPress={handleSend}
            disabled={!draft.trim()}
            testID="diary-send-btn"
          >
            <Feather name="send" size={18} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Delete-entry confirmation sheet */}
      <Modal
        transparent
        visible={!!pendingDeleteId}
        animationType="fade"
        onRequestClose={() => setPendingDeleteId(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPendingDeleteId(null)}>
          <Pressable style={styles.confirmSheet}>
            <Text style={styles.confirmTitle}>Delete this note?</Text>
            <Text style={styles.confirmBody}>
              The note will be permanently removed from your Diary on this device.
            </Text>
            <View style={styles.confirmRow}>
              <TouchableOpacity
                style={styles.confirmCancel}
                onPress={() => setPendingDeleteId(null)}
              >
                <Text style={styles.confirmCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmDelete}
                onPress={() => pendingDeleteId && handleDelete(pendingDeleteId)}
              >
                <Text style={styles.confirmDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Header overflow menu */}
      <Modal
        transparent
        visible={showMenu}
        animationType="fade"
        onRequestClose={() => setShowMenu(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setShowMenu(false)}>
          <Pressable style={styles.menuSheet}>
            <TouchableOpacity style={styles.menuItem} onPress={handleClearAll}>
              <Feather name="trash-2" size={16} color={Colors.danger} />
              <Text style={[styles.menuItemText, { color: Colors.danger }]}>Clear all entries</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flexOne: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: Colors.diary,
    gap: 6,
  },
  headerIconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.diaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
  },
  headerTextWrap: { flex: 1, marginLeft: 4 },
  headerTitle: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  headerSubtitle: { color: Colors.white, opacity: 0.85, fontSize: FontSize.xs },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#E4B53B',
    backgroundColor: '#FFFCF4',
  },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl, gap: Spacing.md },
  emptyIcon: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.diaryLight,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  emptyTitle: { fontSize: 18, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center' },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  listContent: { padding: 12, paddingBottom: 80 },
  dayChipWrap: { alignItems: 'center', marginVertical: 8 },
  dayChip: {
    fontSize: FontSize.xs, fontWeight: FontWeight.semibold,
    color: Colors.textMuted,
    backgroundColor: Colors.surface,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  bubbleRow: { alignItems: 'flex-end', marginVertical: 2 },
  bubble: {
    maxWidth: '85%',
    backgroundColor: Colors.diaryLight,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.md,
    ...Shadow.sm,
  },
  bubbleText: { color: Colors.textPrimary, fontSize: FontSize.base, lineHeight: 22 },
  bubbleTime: { color: Colors.textMuted, fontSize: 11, marginTop: 4, alignSelf: 'flex-end' },
  forwardedHeader: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  forwardedHeaderText: { color: Colors.diaryDark, fontSize: 11, fontWeight: FontWeight.semibold, flex: 1 },
  attachmentWrap: { marginBottom: 6, borderRadius: Radius.md, overflow: 'hidden' },
  attachmentImage: { width: 220, height: 160, borderRadius: Radius.md },
  attachmentFile: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.white,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.diaryLight,
  },
  attachmentFileName: { color: Colors.textPrimary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, flex: 1 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: Colors.white,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    backgroundColor: Colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 20,
  },
  composerSend: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.diary,
    alignItems: 'center', justifyContent: 'center',
  },
  composerSendDisabled: { opacity: 0.4 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
  },
  confirmSheet: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    width: '100%',
    maxWidth: 360,
    gap: Spacing.sm,
  },
  confirmTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  confirmBody: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  confirmRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  confirmCancel: { paddingHorizontal: 16, paddingVertical: 10 },
  confirmCancelText: { color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  confirmDelete: {
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: Colors.danger,
    borderRadius: Radius.md,
  },
  confirmDeleteText: { color: Colors.white, fontWeight: FontWeight.bold },
  menuSheet: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.sm,
    width: '100%',
    maxWidth: 280,
    ...Shadow.lg,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  menuItemText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
});
