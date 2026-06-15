/**
 * Diary screen — personal notes with OPTIONAL cloud sync.
 *
 * iter-117 update: ADDED an opportunistic backend sync probe.
 *
 *   - On mount, mobile probes `api.diary.listEntries({})` via
 *     `useSafeConvexQuery`. If the backend exposes that endpoint AND
 *     returns an array, those cloud entries become the SOURCE OF TRUTH
 *     (merged with any unsync'd local drafts).
 *   - All NEW writes (send + delete + clear) try the backend first;
 *     local AsyncStorage is the fallback if the endpoint is missing or
 *     the call fails.
 *   - On first successful list-from-cloud, any local-only entries are
 *     "flushed" to the cloud one-by-one (so previously-saved offline
 *     notes don't get lost when the backend ships).
 *   - If the backend endpoints DON'T exist yet, behavior is identical
 *     to iter-111 — 100% local AsyncStorage, no risk of cross-user
 *     contamination.
 *
 * iter-117 also ADDS long-press → Copy / Forward / Delete menu:
 *   - Copy: copies the entry's text (or fileName if no text) to the
 *     system clipboard via expo-clipboard.
 *   - Forward: opens a "Forward to" sheet listing the user's
 *     conversations; on tap, sends the entry's content as a new
 *     message via `messages.send`. Works for text and for attachments
 *     (attachments forward by including the mediaUrl as a fileUrl).
 *
 * iter-117 backend contract: see /app/MOBILE_BACKEND_CONTRACT.md
 * Section 34 for the exact `diary.*` endpoints the backend agent must
 * provide.
 *
 * ⚠ PRIVACY-CRITICAL DESIGN (CARRIED FORWARD FROM iter-111) ⚠
 *
 * If the backend `diary.*` namespace is wired with PROPER per-user
 * scoping (every query/mutation derives userId from the auth context,
 * never accepts a userId arg from the client), this is safe. If the
 * backend agent EVER accepts a `userId` parameter from the client side
 * for diary operations, that's a cross-user data leak vector — flag
 * IMMEDIATELY and revert to local-only.
 *
 * The web app and mobile app share the same Convex deployment. The
 * sync key is the AUTHENTICATED USER ID — same user across devices
 * sees the same diary.
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
import { useMutation, useQuery } from 'convex/react';
import * as Clipboard from 'expo-clipboard';
import { api } from '../src/convexApi';
import Avatar from '../src/components/Avatar';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
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

/**
 * Merge cloud + local diary entries by `_id`, with cloud entries
 * winning on conflict (cloud is the source of truth once we're
 * connected). Stable sort by `_creationTime` ascending so the
 * newest-at-bottom convention is preserved.
 */
function mergeEntries(cloud: DiaryEntry[], local: DiaryEntry[]): DiaryEntry[] {
  const byId = new Map<string, DiaryEntry>();
  // Local first, cloud overrides.
  for (const e of local) byId.set(e._id, e);
  for (const e of cloud) byId.set(e._id, e);
  return Array.from(byId.values()).sort((a, b) => a._creationTime - b._creationTime);
}

export default function DiaryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useQuery(api.users.getCurrentUser);
  const myUserId = me?._id ? String(me._id) : null;

  // ─── Cloud sync probe ──────────────────────────────────────────
  // If `api.diary.listEntries` exists, this returns the cloud entries.
  // If not, `data` stays `[]` and we operate from local AsyncStorage.
  const cloudEntriesQuery = useSafeConvexQuery<DiaryEntry[] | null>(
    (api as any).diary?.listEntries,
    {},
    null,
    !!myUserId,
  );
  // Reactive: if the backend ships diary support later in this session,
  // the data will flow in WITHOUT a page reload.
  const cloudReady = Array.isArray(cloudEntriesQuery.data);
  const cloudEntries = useMemo<DiaryEntry[]>(
    () => (cloudReady ? (cloudEntriesQuery.data as DiaryEntry[]) : []),
    [cloudReady, cloudEntriesQuery.data],
  );

  // Cloud write mutations (resolved lazily — if undefined, we skip).
  //
  // iter-223 RETRY-STORM GUARD: prior to this fix, `useMutation` with an
  // undefined function reference would still return a callable that, when
  // invoked, kept retrying on the backend ("function not found" error)
  // every second forever — corrupting the Convex client's sync state
  // and freezing every other query on "Loading…" with the "Base version
  // mismatch" fatal error. The backend now exposes `diary.appendEntry`
  // so the immediate symptom is gone, but we ALSO defensively gate
  // every cloud-write call on the function actually existing — so a
  // future missing function can never repeat this disaster.
  const appendEntryAvailable = Boolean((api as any).diary?.appendEntry);
  const deleteEntryAvailable = Boolean((api as any).diary?.deleteEntry);
  const clearDiaryAvailable = Boolean((api as any).diary?.clearDiary);
  const appendEntryCloud = useMutation((api as any).diary?.appendEntry);
  const deleteEntryCloud = useMutation((api as any).diary?.deleteEntry);
  const clearDiaryCloud = useMutation((api as any).diary?.clearDiary);
  // Forward-target write — same mutation the rest of the app uses.
  const sendMessage = useMutation((api as any).messages.send);

  // Forward picker: list of conversations to forward to. Cheap to
  // always keep this loaded so the picker opens snappily.
  const { data: conversationsForForward } = useSafeConvexQuery<any[]>(
    (api as any).conversations.listConversations,
    {},
    [],
    true,
  );

  // ─── Local store (still primary when cloud unavailable) ──────
  const [localEntries, setLocalEntries] = useState<DiaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [actionEntry, setActionEntry] = useState<DiaryEntry | null>(null);
  const [showForwardSheet, setShowForwardSheet] = useState(false);
  const [forwardSource, setForwardSource] = useState<DiaryEntry | null>(null);
  const localFlushedRef = useRef(false);
  const listRef = useRef<FlatList<RenderItem> | null>(null);

  // Initial local load.
  useEffect(() => {
    if (!myUserId) return;
    let cancelled = false;
    (async () => {
      const data = await readDiaryEntries(myUserId);
      if (!cancelled) {
        setLocalEntries(data);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [myUserId]);

  // ─── Local-only-to-cloud flush ────────────────────────────────
  // Once cloud is ready AND we have local entries that aren't yet on
  // cloud, push them up so the user's offline notes don't get lost.
  // Only happens ONCE per session via localFlushedRef.
  useEffect(() => {
    if (localFlushedRef.current) return;
    if (!cloudReady) return;
    if (!appendEntryCloud) return;
    // iter-223 guard: never queue a mutation to a backend function that
    // doesn't exist — that triggers Convex's per-second retry storm.
    if (!appendEntryAvailable) {
      localFlushedRef.current = true;
      return;
    }
    if (!myUserId) return;
    if (localEntries.length === 0) return;

    const cloudIds = new Set(cloudEntries.map((e) => e._id));
    const orphans = localEntries.filter((e) => !cloudIds.has(e._id));
    if (orphans.length === 0) {
      localFlushedRef.current = true;
      return;
    }
    localFlushedRef.current = true;
    (async () => {
      for (const entry of orphans) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await (appendEntryCloud as any)({
            kind: entry.kind,
            text: entry.text,
            attachment: entry.attachment,
            forwardedFrom: entry.forwardedFrom,
            clientCreationTime: entry._creationTime,
          });
          // On success, drop the local copy so we don't double-show
          // after the cloud query refreshes.
          // eslint-disable-next-line no-await-in-loop
          await deleteDiaryEntry(myUserId, entry._id);
        } catch {
          // Best-effort — leave the orphan local; next session retries.
        }
      }
      setLocalEntries(await readDiaryEntries(myUserId));
    })();
  }, [cloudReady, cloudEntries, localEntries, myUserId, appendEntryCloud]);

  // ─── Display entries: cloud if ready, else local ──────────────
  const allEntries = useMemo<DiaryEntry[]>(() => {
    if (cloudReady) return mergeEntries(cloudEntries, localEntries);
    return localEntries;
  }, [cloudReady, cloudEntries, localEntries]);

  const visibleEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allEntries;
    return allEntries.filter((e) => {
      const text = (e.text || '').toLowerCase();
      const fileName = (e.attachment?.fileName || '').toLowerCase();
      const forwardedFromName = (e.forwardedFrom?.conversationName || '').toLowerCase();
      return text.includes(q) || fileName.includes(q) || forwardedFromName.includes(q);
    });
  }, [allEntries, searchQuery]);

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

  // ─── Send a new diary note ─────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || !myUserId) return;
    setDraft('');
    // Try cloud first; fall back to local. iter-223: existence guard
    // — never enqueue a mutation to a non-existent backend function.
    if (cloudReady && appendEntryAvailable && typeof appendEntryCloud === 'function') {
      try {
        await (appendEntryCloud as any)({
          kind: 'text',
          text,
          attachment: null,
          forwardedFrom: null,
        });
        // Cloud query will refresh reactively.
        requestAnimationFrame(() => {
          try { listRef.current?.scrollToEnd({ animated: true }); } catch {}
        });
        return;
      } catch {
        // Fall through to local.
      }
    }
    const entry = await appendDiaryEntry(myUserId, { kind: 'text', text });
    setLocalEntries((prev) => [...prev, entry]);
    requestAnimationFrame(() => {
      try { listRef.current?.scrollToEnd({ animated: true }); } catch {}
    });
  }, [draft, myUserId, cloudReady, appendEntryCloud]);

  // ─── Delete one entry ─────────────────────────────────────────
  const handleDelete = useCallback(async (entryId: string) => {
    if (!myUserId) return;
    // Cloud delete (if the entry is cloud-resident).
    const isCloudEntry = cloudEntries.some((e) => e._id === entryId);
    if (isCloudEntry && deleteEntryAvailable && typeof deleteEntryCloud === 'function') {
      try {
        await (deleteEntryCloud as any)({ entryId });
      } catch (errorValue: any) {
        Alert.alert('Failed to delete', String(errorValue?.message || errorValue));
        return;
      }
    } else {
      await deleteDiaryEntry(myUserId, entryId);
      setLocalEntries((prev) => prev.filter((e) => e._id !== entryId));
    }
    setPendingDeleteId(null);
    setActionEntry(null);
  }, [myUserId, cloudEntries, deleteEntryCloud]);

  // ─── Clear all entries ─────────────────────────────────────────
  const handleClearAll = useCallback(() => {
    Alert.alert(
      'Clear all diary entries?',
      'This will permanently remove every note you\u2019ve saved to Diary' +
        (cloudReady ? ', across all your devices.' : ' on THIS device.') +
        ' This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: async () => {
            if (!myUserId) return;
            if (cloudReady && clearDiaryAvailable && typeof clearDiaryCloud === 'function') {
              try {
                await (clearDiaryCloud as any)({});
              } catch (errorValue: any) {
                Alert.alert('Failed', String(errorValue?.message || errorValue));
                setShowMenu(false);
                return;
              }
            }
            await clearDiary(myUserId);
            setLocalEntries([]);
            setShowMenu(false);
          },
        },
      ],
    );
  }, [myUserId, cloudReady, clearDiaryCloud]);

  // ─── Copy an entry's content to clipboard ─────────────────────
  const handleCopy = useCallback(async (entry: DiaryEntry) => {
    try {
      const payload =
        (entry.text && entry.text.trim()) ||
        entry.attachment?.fileName ||
        entry.attachment?.mediaUrl ||
        '';
      if (!payload) {
        Alert.alert('Nothing to copy', 'This note has no text content.');
        setActionEntry(null);
        return;
      }
      await Clipboard.setStringAsync(payload);
      setActionEntry(null);
      // Subtle confirmation — same pattern used in chat copy.
      Alert.alert('Copied', payload.length > 80 ? `${payload.slice(0, 80)}…` : payload);
    } catch (errorValue: any) {
      Alert.alert('Copy failed', String(errorValue?.message || errorValue));
    }
  }, []);

  // ─── Forward an entry to a chat ───────────────────────────────
  const handleForward = useCallback((entry: DiaryEntry) => {
    setForwardSource(entry);
    setShowForwardSheet(true);
    setActionEntry(null);
  }, []);

  const doForwardToConversation = useCallback(
    async (targetConvId: string) => {
      const entry = forwardSource;
      if (!entry) return;
      setShowForwardSheet(false);
      setForwardSource(null);
      try {
        // Build a message payload that mirrors what the chat composer
        // sends. Text and attachment metadata are both handled.
        const args: any = {
          conversationId: targetConvId,
          text: entry.text || '',
        };
        if (entry.attachment) {
          if (entry.attachment.storageId) args.attachmentStorageId = entry.attachment.storageId;
          if (entry.attachment.mediaUrl) args.mediaUrl = entry.attachment.mediaUrl;
          if (entry.attachment.fileName) args.fileName = entry.attachment.fileName;
          if (entry.attachment.mimeType) args.mimeType = entry.attachment.mimeType;
          if (entry.attachment.fileSize) args.fileSize = entry.attachment.fileSize;
          if (entry.attachment.audioDuration) args.audioDuration = entry.attachment.audioDuration;
        }
        await (sendMessage as any)(args);
        Alert.alert('Forwarded', 'Note sent to the selected chat.');
      } catch (errorValue: any) {
        Alert.alert('Forward failed', String(errorValue?.message || errorValue));
      }
    },
    [forwardSource, sendMessage],
  );

  // ─── Render one entry bubble ──────────────────────────────────
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
        onLongPress={() => setActionEntry(entry)}
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

  // ─── Sync status indicator (cloud/local) ──────────────────────
  const syncBadge = useMemo(() => {
    if (cloudReady) {
      return { text: 'Synced with Smilers cloud', color: Colors.diaryDark, icon: 'cloud-check' as const };
    }
    return { text: 'Saved on this device', color: Colors.textMuted, icon: 'cloud-off-outline' as const };
  }, [cloudReady]);

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
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            <MaterialCommunityIcons name={syncBadge.icon} size={12} color={Colors.white} />
            {'  '}{syncBadge.text}
          </Text>
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
                : cloudReady
                  ? 'Notes you save here sync across all your devices. Forward any message from a chat to save it here.'
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

      {/* ─── Long-press action menu (Copy / Forward / Delete) ─── */}
      <Modal
        transparent
        visible={!!actionEntry}
        animationType="fade"
        onRequestClose={() => setActionEntry(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setActionEntry(null)}>
          <Pressable style={styles.menuSheet}>
            <Text style={styles.actionMenuTitle} numberOfLines={2}>
              {actionEntry?.text || actionEntry?.attachment?.fileName || 'Diary note'}
            </Text>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => actionEntry && handleCopy(actionEntry)}
              testID="diary-action-copy"
            >
              <Feather name="copy" size={16} color={Colors.textPrimary} />
              <Text style={styles.menuItemText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => actionEntry && handleForward(actionEntry)}
              testID="diary-action-forward"
            >
              <Feather name="corner-up-right" size={16} color={Colors.textPrimary} />
              <Text style={styles.menuItemText}>Forward to a chat</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                if (!actionEntry) return;
                setPendingDeleteId(actionEntry._id);
                setActionEntry(null);
              }}
              testID="diary-action-delete"
            >
              <Feather name="trash-2" size={16} color={Colors.danger} />
              <Text style={[styles.menuItemText, { color: Colors.danger }]}>Delete</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ─── Delete-entry confirmation sheet ────────────────────── */}
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
              The note will be permanently removed from your Diary{cloudReady ? ', across all devices.' : ' on this device.'}
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

      {/* ─── Header overflow menu ───────────────────────────────── */}
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

      {/* ─── Forward-to-chat picker ────────────────────────────── */}
      <Modal
        transparent
        visible={showForwardSheet}
        animationType="slide"
        onRequestClose={() => { setShowForwardSheet(false); setForwardSource(null); }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => { setShowForwardSheet(false); setForwardSource(null); }}
        >
          <Pressable style={styles.forwardSheet}>
            <View style={styles.forwardSheetHandle} />
            <Text style={styles.forwardSheetTitle}>Forward to</Text>
            <FlatList
              data={Array.isArray(conversationsForForward) ? conversationsForForward : []}
              keyExtractor={(item: any) => String(item._id)}
              contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
              renderItem={({ item }) => {
                const label =
                  item?.name ||
                  item?.otherUserName ||
                  item?.title ||
                  'Chat';
                return (
                  <TouchableOpacity
                    style={styles.forwardRow}
                    onPress={() => doForwardToConversation(item._id)}
                    testID={`diary-forward-target-${item._id}`}
                  >
                    <Avatar name={label} size={40} />
                    <View style={styles.forwardRowText}>
                      <Text style={styles.forwardRowName} numberOfLines={1}>{label}</Text>
                      {item?.lastMessageText ? (
                        <Text style={styles.forwardRowSubtitle} numberOfLines={1}>
                          {item.lastMessageText}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <View style={{ padding: Spacing.lg, alignItems: 'center' }}>
                  <Text style={{ color: Colors.textMuted }}>
                    No conversations to forward to yet.
                  </Text>
                </View>
              }
            />
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
    maxWidth: 320,
    ...Shadow.lg,
  },
  actionMenuTitle: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    fontWeight: FontWeight.semibold,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  menuItemText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  forwardSheet: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    backgroundColor: Colors.white,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    paddingTop: Spacing.sm,
    paddingHorizontal: Spacing.base,
    maxHeight: '70%',
  },
  forwardSheetHandle: {
    alignSelf: 'center',
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  forwardSheetTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary,
    marginBottom: Spacing.sm,
  },
  forwardRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  forwardRowText: { flex: 1 },
  forwardRowName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  forwardRowSubtitle: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },
});
