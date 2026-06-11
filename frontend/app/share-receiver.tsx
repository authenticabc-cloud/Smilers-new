/**
 * /share-receiver — iter-170 OS Share Sheet target screen.
 *
 * Native flow:
 *   1. User shares text/URL/image/video/file from any app (Photos, Safari,
 *      Files, WhatsApp, etc.) and picks "Smilers" in the OS share sheet.
 *   2. The expo-share-intent extension/intent-filter launches the app
 *      with the payload available via `useShareIntent()`.
 *   3. This screen reads that payload, asks the user to pick one or more
 *      recipients (recent chats first, then full contacts list),
 *      previews what will be sent, and on confirm fans it out to every
 *      selected recipient using the canonical `api.messages.send`
 *      mutations (same path the chat composer uses).
 *
 * Backend contracts used (all pre-existing — no schema changes):
 *   - api.contacts.getContacts           list contacts
 *   - api.conversations.listConversations recent chats (for ordering)
 *   - api.conversations.getOrCreateDirect lazy-create DM when picking a
 *     contact who doesn't have a conversation yet
 *   - api.messages.send                  text + media send
 *
 * UX choices (matching user spec):
 *   - Multi-recipient fan-out
 *   - Stay-in-app on completion (returns to first selected chat, falls
 *     back to chats list)
 *   - MessageSecurityScanner runs at the SEND boundary; dangerous files
 *     (.exe/.apk/...) are skipped silently per recipient and surfaced in
 *     the result toast.
 *
 * IMPORTANT — this screen is a NO-OP on web preview / Expo Go because
 * `expo-share-intent` only registers via the native extension/intent
 * filters. We render a helpful explanation in that case rather than
 * stranding the user on a blank screen.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useConvex, useMutation } from 'convex/react';
// iter-170: expo-share-intent is platform-specific. Importing statically
// on web causes the proxy/native-module bridge to throw at hook-time.
// We load it dynamically inside ShareReceiverNative instead.
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { appendDiaryEntry, type DiaryEntryKind } from '../src/lib/diaryStore';
import { uploadFile } from '../src/lib/uploadFile';
import { scanMessage as scanMessageDeep } from '../src/lib/messageSecurityScanner';
import Header from '../src/components/Header';
import {
  classifyFile,
  sendSharedPayloadToConversation,
  type SharedPayload,
  type SendOutcome,
} from '../src/lib/sendSharedPayload';
import { getDisplayNameFromUser, getDisplayInitials } from '../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

// Local aliases — these helpers used to be named `resolveDisplayName`
// and `initialsOf` in earlier drafts. Keeping the call-sites short.
const resolveContactName = (entity: any) => getDisplayNameFromUser(entity, '');
const initialsOf = (name: string) => getDisplayInitials(name, 1);

interface Recipient {
  /** Either conversationId (preferred when known) or `user:<userId>`. */
  key: string;
  /** Existing conversation id (string). */
  conversationId?: string;
  /** Contact userId — used to lazy-create a DM if no conversation exists. */
  userId?: string;
  /** True when this row represents a group chat (DM otherwise). */
  isGroup?: boolean;
  /** True when this row is the user's own Diary (self-conversation). */
  isDiary?: boolean;
  /** Optional member count to surface as a subtitle for groups. */
  memberCount?: number;
  name: string;
  avatarUrl?: string | null;
  /** Last conversation timestamp for sorting (ms). */
  lastActivity?: number;
}

export default function ShareReceiverScreen() {
  // iter-170: expo-share-intent's `useShareIntent` hook calls into the
  // native module which doesn't exist on web preview / Expo Go. Bail to
  // the explanation surface BEFORE invoking any other hooks so we don't
  // try to call hooks in a doomed render.
  if (Platform.OS === 'web') {
    return <ShareReceiverWeb />;
  }
  return <ShareReceiverNative />;
}

function ShareReceiverWeb() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useRouter } = require('expo-router');
  const router = useRouter();
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header title="Share to Smilers" showBack onBack={() => router.back()} variant="dark" />
      <View style={styles.web}>
        <Ionicons name="share-social-outline" size={56} color={Colors.textMuted} />
        <Text style={styles.webTitle}>Native share sheet only</Text>
        <Text style={styles.webBody}>
          Smilers appears in the OS share menu on iOS and Android. This is a native feature —
          install the latest mobile build, then share from any app (Photos, Safari, Files, …)
          and pick Smilers.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function ShareReceiverNative() {
  // iter-170: dynamic require — keeps the static dep graph free of the
  // expo-share-intent native binding so web bundling doesn't pull in
  // unreachable native code paths.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useShareIntent } = require('expo-share-intent');
  const router = useRouter();
  const convex = useConvex();
  const { isAuthenticated } = useAuth();

  const { isReady, hasShareIntent, shareIntent, resetShareIntent, error } =
    useShareIntent({ debug: false });

  const sendMessage = useMutation(api.messages.send);
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  // iter-172: Diary cloud-write mutation. Diary is a local-first feature
  // (AsyncStorage primary), but we ALSO push to the optional `api.diary.
  // appendEntry` so the entry shows up cross-device. Probed lazily —
  // safe when the backend hasn't shipped diary endpoints yet (mutation
  // resolves to undefined and we skip the cloud write).
  const appendDiaryCloud = useMutation((api as any).diary?.appendEntry);

  // iter-172: current user — needed for the Diary row's userId scope.
  const { data: meData } = useSafeConvexQuery<any>(
    api.users.getCurrentUser,
    {},
    null,
    !!isAuthenticated,
  );
  const myUserId: string | null = meData?._id ? String(meData._id) : null;

  // Recent chats — same query as the chats tab. Used to surface frequent
  // recipients at the top so the user can fan-out with one tap.
  // Using `useSafeConvexQuery` (the same wrapper Contacts uses) is the
  // safer pattern here — it tolerates a missing function ref on early
  // mounts and dynamically toggles `enabled` based on auth.
  const { data: conversationsData } = useSafeConvexQuery<any[]>(
    api.conversations.listConversations,
    {},
    [],
    !!isAuthenticated,
  );
  const conversations: any[] | undefined = conversationsData;

  // Contacts — full directory for search-by-name.
  const { data: contactsData } = useSafeConvexQuery<any[]>(
    api.contacts.getContacts,
    {},
    [],
    !!isAuthenticated,
  );
  const contacts: any[] | undefined = contactsData;

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Record<string, Recipient>>({});
  const [sending, setSending] = useState(false);

  // Normalize the share intent into our `SharedPayload` shape. Recomputed
  // whenever the intent changes (a new share can arrive while this screen
  // is open if the user backgrounds + re-shares).
  const payload: SharedPayload = useMemo(() => {
    if (!shareIntent) return {};
    const result: SharedPayload = {};
    // Text + URL: prefer the URL field if present, fall back to text.
    const rawUrl = (shareIntent as any).webUrl as string | null | undefined;
    const rawText = shareIntent.text || '';
    if (rawUrl && rawUrl.length > 0) {
      result.text = rawUrl;
      // If the user attached a comment, append it.
      if (rawText && rawText !== rawUrl) {
        result.text = `${rawUrl}\n${rawText}`;
      }
    } else if (rawText.length > 0) {
      result.text = rawText;
    }
    if (Array.isArray(shareIntent.files) && shareIntent.files.length > 0) {
      // iter-176 defense-in-depth: an older upstream bug in
      // expo-share-intent@5.1.1 could produce a malformed array where
      // single-file SEND intents emitted `[fileInfo, ["type", "file"]]`
      // (a stray Pair element). We patch the lib (scripts/patch-expo-
      // share-intent.js), but even if that ever regresses, the filter
      // below tolerates the malformed shape by keeping only entries
      // that have a usable URI.
      const validFiles = shareIntent.files.filter((file: any) => {
        if (!file || typeof file !== 'object') return false;
        return !!(file.path || file.contentUri || file.filePath || file.uri);
      });
      if (validFiles.length > 0) {
        result.files = validFiles.map((file: any) => {
          const mimeType = file.mimeType || file.type || 'application/octet-stream';
          const uri = file.path
            || file.contentUri
            || (file.filePath ? `file://${file.filePath}` : null)
            || file.uri
            || '';
          return {
            uri,
            mimeType,
            fileName: file.fileName || 'shared',
            fileSize: typeof file.size === 'number'
              ? file.size
              : (typeof file.fileSize === 'string' ? Number(file.fileSize) : undefined),
            kind: classifyFile(mimeType),
          };
        });
      }
    }
    return result;
  }, [shareIntent]);

  /**
   * Build the recipient list:
   *   - Recent DMs (with their lastActivity timestamps) sorted desc
   *   - Then contacts not already represented as recent DMs
   *   - Filter by `search` (case-insensitive) over name fields
   */
  const recipients: Recipient[] = useMemo(() => {
    const map = new Map<string, Recipient>();

    // 1) Recent DMs + group conversations
    if (Array.isArray(conversations)) {
      for (const conv of conversations) {
        if (!conv || !conv._id) continue;
        const isGroup = !!conv.isGroup;
        // Group: render with group icon + member-count subtitle, no peer.
        // Direct: render with peer name + avatar.
        const peer = conv.otherUser || conv.peer || {};
        const name = isGroup
          ? (conv.title || conv.name || conv.groupName || 'Group chat')
          : (resolveContactName(peer) || conv.title || conv.name || 'Direct chat');
        const userId = !isGroup && peer?._id ? String(peer._id) : undefined;
        const key = `conv:${conv._id}`;
        map.set(key, {
          key,
          conversationId: String(conv._id),
          userId,
          isGroup,
          memberCount: typeof conv.memberCount === 'number'
            ? conv.memberCount
            : (Array.isArray(conv.members) ? conv.members.length : undefined),
          name,
          avatarUrl: isGroup
            ? (conv.groupAvatarUrl || conv.avatarUrl || null)
            : (peer?.avatarUrl || peer?.profilePictureUrl || null),
          lastActivity:
            typeof conv.lastMessageAt === 'number'
              ? conv.lastMessageAt
              : typeof conv._creationTime === 'number'
              ? conv._creationTime
              : 0,
        });
      }
    }

    // 2) Contacts not yet in the recent list
    if (Array.isArray(contacts)) {
      for (const contact of contacts) {
        if (!contact || !contact._id) continue;
        // De-duplicate by userId; if a contact already appears as a recent
        // DM peer, skip — we'll reuse that conversationId.
        const userId = String(contact._id);
        let alreadyPresent = false;
        for (const r of map.values()) {
          if (r.userId === userId) {
            alreadyPresent = true;
            break;
          }
        }
        if (alreadyPresent) continue;
        const key = `user:${userId}`;
        map.set(key, {
          key,
          userId,
          name: resolveContactName(contact) || 'Contact',
          avatarUrl: contact.avatarUrl || contact.profilePictureUrl || null,
          lastActivity: 0,
        });
      }
    }

    let list = Array.from(map.values());

    // Search filter
    const q = search.trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter((r) => r.name.toLowerCase().includes(q));
    }

    // Sort: recents first (by lastActivity desc), then alphabetical
    list.sort((a, b) => {
      const aRecent = (a.lastActivity || 0) > 0 ? 1 : 0;
      const bRecent = (b.lastActivity || 0) > 0 ? 1 : 0;
      if (aRecent !== bRecent) return bRecent - aRecent;
      if (aRecent === 1) return (b.lastActivity || 0) - (a.lastActivity || 0);
      return a.name.localeCompare(b.name);
    });

    // iter-172: synthetic "My Diary" row pinned at the very top so the
    // user can quickly save anything to their own self-conversation.
    // We only surface it when the user is authenticated AND the row
    // wouldn't be filtered out by their search query.
    const diaryName = 'My Diary';
    const showDiary = !!myUserId && (q.length === 0 || diaryName.toLowerCase().includes(q));
    if (showDiary) {
      list.unshift({
        key: 'diary:self',
        isDiary: true,
        name: diaryName,
        avatarUrl: null,
      });
    }

    return list;
  }, [contacts, conversations, myUserId, search]);

  const toggleSelected = useCallback((r: Recipient) => {
    setSelected((prev) => {
      const copy = { ...prev };
      if (copy[r.key]) delete copy[r.key];
      else copy[r.key] = r;
      return copy;
    });
  }, []);

  const selectedList = useMemo(() => Object.values(selected), [selected]);

  const payloadSummary: string = useMemo(() => {
    const parts: string[] = [];
    if (payload.text) {
      const trimmed = payload.text.length > 60 ? `${payload.text.slice(0, 60)}…` : payload.text;
      parts.push(trimmed);
    }
    if (payload.files && payload.files.length > 0) {
      parts.push(`${payload.files.length} attachment${payload.files.length > 1 ? 's' : ''}`);
    }
    return parts.join(' • ') || 'Nothing to share';
  }, [payload]);

  const handleSend = useCallback(async () => {
    if (selectedList.length === 0) {
      Alert.alert('Pick a recipient', 'Select at least one chat or contact to share with.');
      return;
    }
    if (!payload.text && (!payload.files || payload.files.length === 0)) {
      Alert.alert('Nothing to share', 'The shared content is empty.');
      return;
    }
    setSending(true);
    // Track per-recipient outcomes so we can report a useful summary at the
    // end (e.g. "Sent to 3 chats, 1 file blocked").
    const allOutcomes: { recipient: Recipient; outcomes: SendOutcome[] }[] = [];
    let firstConversationId: string | null = null;
    let diaryHit = false;

    for (const r of selectedList) {
      // iter-172: Diary branch — bypass conversation send entirely.
      // Diary writes go to local AsyncStorage (always) + optional cloud
      // `api.diary.appendEntry` (when wired). We upload attachments
      // through the same `uploadFile` helper so a single storageId
      // works across devices.
      if (r.isDiary) {
        try {
          const outcomes: SendOutcome[] = [];
          // Attachments first.
          for (const file of (payload.files || [])) {
            const scan = scanMessageDeep({ fileName: file.fileName, mimeType: file.mimeType });
            if (scan.shouldAutoDelete) {
              outcomes.push({ ok: false, reason: scan.findings[0]?.reason || 'Blocked: risky file type' });
              continue;
            }
            try {
              const storageId = await uploadFile(convex, file.uri, file.mimeType);
              const kind: DiaryEntryKind = file.kind === 'image'
                ? 'image'
                : file.kind === 'video'
                ? 'video'
                : 'file';
              const attachment = {
                storageId,
                fileName: file.fileName,
                mimeType: file.mimeType,
                fileSize: typeof file.fileSize === 'number' ? file.fileSize : null,
              };
              const entry = await appendDiaryEntry(myUserId, { kind, attachment });
              if (appendDiaryCloud) {
                // Cloud write is best-effort — diary is local-first.
                try {
                  await (appendDiaryCloud as any)({
                    kind,
                    attachment,
                    _creationTime: entry._creationTime,
                  });
                } catch { /* swallow */ }
              }
              outcomes.push({ ok: true });
            } catch (errorValue: any) {
              outcomes.push({ ok: false, reason: errorValue?.message || 'Upload failed' });
            }
          }
          // Text last (mirrors chat behaviour).
          const cleanText = (payload.text || '').trim();
          if (cleanText.length > 0) {
            try {
              const entry = await appendDiaryEntry(myUserId, { kind: 'text', text: cleanText });
              if (appendDiaryCloud) {
                try {
                  await (appendDiaryCloud as any)({
                    kind: 'text',
                    text: cleanText,
                    _creationTime: entry._creationTime,
                  });
                } catch { /* swallow */ }
              }
              outcomes.push({ ok: true });
            } catch (errorValue: any) {
              outcomes.push({ ok: false, reason: errorValue?.message || 'Save failed' });
            }
          }
          allOutcomes.push({ recipient: r, outcomes });
          if (outcomes.some((o) => o.ok)) diaryHit = true;
        } catch (errorValue: any) {
          allOutcomes.push({
            recipient: r,
            outcomes: [{ ok: false, reason: errorValue?.message || 'Diary save failed' }],
          });
        }
        continue;
      }

      // Resolve conversationId — lazy-create if we only have a userId.
      let convId = r.conversationId;
      try {
        if (!convId && r.userId) {
          const conv: any = await getOrCreateDirect({ otherUserId: r.userId });
          convId = typeof conv === 'string' ? conv : conv?._id || conv?.conversationId;
        }
      } catch (errorValue: any) {
        allOutcomes.push({
          recipient: r,
          outcomes: [
            { ok: false, reason: errorValue?.message || 'Could not start a chat with this contact.' },
          ],
        });
        continue;
      }
      if (!convId) {
        allOutcomes.push({
          recipient: r,
          outcomes: [{ ok: false, reason: 'No conversation id resolved.' }],
        });
        continue;
      }
      if (!firstConversationId) firstConversationId = convId;
      const outcomes = await sendSharedPayloadToConversation(
        convex,
        sendMessage as any,
        convId,
        payload,
      );
      allOutcomes.push({ recipient: r, outcomes });
    }

    setSending(false);

    // Tally success / failure for the toast.
    let sentChats = 0;
    let blockedCount = 0;
    let failedCount = 0;
    for (const row of allOutcomes) {
      const anyOk = row.outcomes.some((o) => o.ok);
      if (anyOk) sentChats += 1;
      const blocked = row.outcomes.filter((o) => !o.ok && /block/i.test(o.reason || '')).length;
      const failed = row.outcomes.filter((o) => !o.ok && !/block/i.test(o.reason || '')).length;
      blockedCount += blocked;
      failedCount += failed;
    }

    // Clear native payload so the next launch starts clean.
    try {
      resetShareIntent(true);
    } catch {
      /* ignore */
    }

    const lines = [`Sent to ${sentChats} chat${sentChats === 1 ? '' : 's'}`];
    if (blockedCount > 0) lines.push(`${blockedCount} item(s) blocked (risky file)`);
    if (failedCount > 0) lines.push(`${failedCount} send(s) failed`);

    // Stay in-app: if any conversation was sent to, route into the first
    // one. If ONLY the Diary was selected, route to the Diary screen so
    // the user sees their saved entries. Otherwise fall back to /chats.
    if (firstConversationId) {
      router.replace(`/chat/${firstConversationId}` as any);
    } else if (diaryHit) {
      router.replace('/diary' as any);
    } else {
      router.replace('/(tabs)/chats' as any);
    }

    // Show the summary AFTER navigation so it's visible on top of the chat.
    setTimeout(() => Alert.alert('Share complete', lines.join('\n')), 300);
  }, [appendDiaryCloud, convex, getOrCreateDirect, myUserId, payload, resetShareIntent, router, selectedList, sendMessage]);

  // Render row
  const renderItem = useCallback(
    ({ item }: { item: Recipient }) => {
      const isSelected = !!selected[item.key];
      const init = initialsOf(item.name);
      const subtitle = item.isDiary
        ? 'Save to your private notes'
        : item.isGroup
        ? `${typeof item.memberCount === 'number' ? item.memberCount : 0} members`
        : null;
      return (
        <TouchableOpacity
          style={styles.row}
          onPress={() => toggleSelected(item)}
          testID={`share-recipient-${item.key}`}
        >
          {item.avatarUrl ? (
            <Image source={{ uri: item.avatarUrl }} style={styles.avatar} />
          ) : (
            <View
              style={[
                styles.avatarFallback,
                item.isGroup && styles.avatarFallbackGroup,
                item.isDiary && styles.avatarFallbackDiary,
              ]}
            >
              {item.isDiary ? (
                <Feather name="bookmark" size={20} color={Colors.headerBg} />
              ) : item.isGroup ? (
                <Ionicons name="people" size={20} color={Colors.headerBg} />
              ) : (
                <Text style={styles.avatarInit}>{init}</Text>
              )}
            </View>
          )}
          <View style={styles.rowMid}>
            <Text style={styles.rowName} numberOfLines={1}>
              {item.name}
            </Text>
            {subtitle ? (
              <Text style={styles.rowSub} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
            {isSelected ? <Feather name="check" size={14} color={Colors.white} /> : null}
          </View>
        </TouchableOpacity>
      );
    },
    [selected, toggleSelected],
  );

  // ─── Web / Expo Go fallback ────────────────────────────────────────
  if (Platform.OS === 'web') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Share to Smilers" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.web}>
          <Ionicons name="share-social-outline" size={56} color={Colors.textMuted} />
          <Text style={styles.webTitle}>Native share sheet only</Text>
          <Text style={styles.webBody}>
            Smilers appears in the OS share menu on iOS and Android. This is a native feature —
            install the latest mobile build, then share from any app (Photos, Safari, Files, …)
            and pick Smilers.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Loading ────────────────────────────────────────────────────────
  if (!isReady) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Share to Smilers" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  // ─── No payload — entered the screen directly ──────────────────────
  if (!hasShareIntent && !payload.text && (!payload.files || payload.files.length === 0)) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Share to Smilers" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.center}>
          <Ionicons name="share-social-outline" size={56} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>Nothing shared yet</Text>
          <Text style={styles.emptyBody}>
            To use Smilers as a share destination, open any app (Photos, Safari, Files…), tap the
            system Share button, and pick Smilers.
          </Text>
          {error ? <Text style={styles.errorText}>{String(error)}</Text> : null}
        </View>
      </SafeAreaView>
    );
  }

  // ─── Main picker ────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header
        title="Share to Smilers"
        showBack
        onBack={() => router.back()}
        variant="dark"
      />

      {/* Payload summary card */}
      <View style={styles.summary}>
        <Feather name="upload-cloud" size={18} color={Colors.primary} />
        <Text style={styles.summaryText} numberOfLines={2}>
          {payloadSummary}
        </Text>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Feather name="search" size={16} color={Colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search chats and contacts"
          placeholderTextColor={Colors.textMuted}
          autoCorrect={false}
          testID="share-search"
        />
      </View>

      <FlatList
        data={recipients}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.divider} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No matches</Text>
            <Text style={styles.emptyBody}>
              Add a contact in the Contacts tab and they will appear here.
            </Text>
          </View>
        }
      />

      {/* Confirm bar */}
      <View style={styles.confirmBar}>
        <Text style={styles.confirmCount}>
          {selectedList.length} selected
        </Text>
        <TouchableOpacity
          style={[styles.sendBtn, (selectedList.length === 0 || sending) && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={selectedList.length === 0 || sending}
          testID="share-send-btn"
        >
          {sending ? (
            <ActivityIndicator size="small" color={Colors.headerBg} />
          ) : (
            <>
              <Feather name="send" size={16} color={Colors.headerBg} />
              <Text style={styles.sendBtnText}>Send</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: Spacing.sm },
  web: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: Spacing.md },
  webTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  webBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 380,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    padding: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  summaryText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  listContent: { paddingHorizontal: Spacing.base, paddingTop: Spacing.md, paddingBottom: 100 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 12,
  },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Distinct background for group avatars so they read differently
  // from initial-only DM avatars in the list.
  avatarFallbackGroup: {
    backgroundColor: Colors.primary,
  },
  // Diary uses the same gold tone but adds a subtle gold ring so it
  // visibly stands out as a private/system row.
  avatarFallbackDiary: {
    backgroundColor: Colors.primary,
    borderWidth: 2,
    borderColor: Colors.primaryDark,
  },
  avatarInit: { fontSize: 16, fontWeight: FontWeight.bold, color: Colors.headerBg },
  rowMid: { flex: 1, gap: 2 },
  rowName: { fontSize: FontSize.base, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.xs, color: Colors.textSecondary },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.borderLight, marginLeft: 44 + 12 },
  empty: { alignItems: 'center', padding: Spacing.xl, gap: Spacing.sm, marginTop: 40 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  errorText: { color: Colors.danger, fontSize: FontSize.sm, marginTop: Spacing.sm },
  confirmBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.base,
    paddingTop: 12,
    paddingBottom: 24,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  confirmCount: { fontSize: FontSize.sm, color: Colors.textSecondary },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: Radius.lg,
  },
  sendBtnDisabled: { opacity: 0.5 },
  sendBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
});
