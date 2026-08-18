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
 *     (.exe/.bat/...) are skipped silently per recipient and surfaced in
 *     the result toast.
 *
 * IMPORTANT — this screen is a NO-OP on web preview / Expo Go because
 * `expo-share-intent` only registers via the native extension/intent
 * filters. We render a helpful explanation in that case rather than
 * stranding the user on a blank screen.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useAppShareIntent } from '../src/lib/shareIntentContext';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { appendDiaryEntry, type DiaryEntryKind } from '../src/lib/diaryStore';
import { readCacheMeta, writeCache } from '../src/lib/offlineCache';
import { ConnectionStatusPill } from '../src/components/ConnectionStatusPill';
import { getRecentShareTargets, recordShareTargets } from '../src/lib/recentShareTargets';
import { uploadFile } from '../src/lib/uploadFile';
import { scanMessage as scanMessageDeep } from '../src/lib/messageSecurityScanner';
import Header from '../src/components/Header';
import {
  classifyFile,
  sendSharedPayloadToConversation,
  checkShareFileSize,
  type SharedPayload,
  type SendOutcome,
} from '../src/lib/sendSharedPayload';
import {
  getDisplayNameFromUser,
  getDisplayInitials,
  getResolvedDisplayName,
  getResolvedConversationDisplayName,
} from '../src/lib/displayName';
import {
  useDeviceContactIndex,
  lookupDeviceContactName,
} from '../src/lib/deviceContactIndex';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

// Local aliases — these helpers used to be named `resolveDisplayName`
// and `initialsOf` in earlier drafts. Keeping the call-sites short.
const resolveContactName = (entity: any) => getDisplayNameFromUser(entity, '');
const initialsOf = (name: string) => getDisplayInitials(name, 1);

/** iter-178: Stable identity for share-frequency tracking — survives a
 * contact row becoming a conversation row on later shares. */
const stableIdOf = (r: { userId?: string; conversationId?: string }): string | null =>
  r.userId ? `u:${r.userId}` : r.conversationId ? `c:${r.conversationId}` : null;

/** First non-empty string among the candidates (broad avatar-field resolver). */
function pickAvatarUrl(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}


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
  /** True when this row is pinned because the user shares to it often. */
  isFrequent?: boolean;
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
  const router = useRouter();
  const convex = useConvex();
  const { isAuthenticated } = useAuth();

  // iter-177 ROOT-CAUSE FIX: read the SHARED share-intent state from
  // AppShareIntentProvider (mounted once at the app root) instead of
  // creating a private `useShareIntent()` instance here. The private
  // instance mounted AFTER the global ShareIntentRouter had already
  // consumed the one-shot native payload, so this screen's copy was
  // permanently empty → "Nothing shared yet" every time.
  const { isReady, hasShareIntent, shareIntent, resetShareIntent, error } =
    useAppShareIntent();

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
  const liveUserId: string | null = meData?._id ? String(meData._id) : null;
  // iter-191: last-known user id from the offline cache. When Convex is
  // (temporarily) unauthenticated on a share-sheet cold start,
  // getCurrentUser is null — which previously made the cache lookup use
  // the 'anon' key and MISS the cache written under the real user id.
  const [cachedUserId, setCachedUserId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    readCacheMeta<any>('me', 'self')
      .then((meta) => {
        if (alive && meta?.data?._id) setCachedUserId(String(meta.data._id));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (meData?._id) void writeCache('me', 'self', meData);
  }, [meData]);
  const myUserId: string | null = liveUserId || cachedUserId;

  // Recent chats — same query as the chats tab. Used to surface frequent
  // recipients at the top so the user can fan-out with one tap.
  // Using `useSafeConvexQuery` (the same wrapper Contacts uses) is the
  // safer pattern here — it tolerates a missing function ref on early
  // mounts and dynamically toggles `enabled` based on auth.
  const { data: conversationsData, loading: conversationsLoading } = useSafeConvexQuery<any[]>(
    api.conversations.listConversations,
    {},
    [],
    !!isAuthenticated,
  );

  // Contacts — full directory for search-by-name.
  const { data: contactsData, loading: contactsLoading } = useSafeConvexQuery<any[]>(
    api.contacts.getContacts,
    {},
    [],
    !!isAuthenticated,
  );

  // iter-350: authoritative list of the viewer's GROUP conversations. The
  // recent `listConversations` only surfaces groups with recent activity,
  // so a dedicated Groups tab needs this complete list to let users share
  // into any group they belong to.
  const { data: groupsData } = useSafeConvexQuery<any[]>(
    (api as any).conversations.listGroups,
    {},
    [],
    !!isAuthenticated,
  );

  // iter-190 ("contacts do not appear" fix): hydrate from the SAME offline
  // cache the Chats tab maintains (scope 'conversations', iter-160). On a
  // flaky connection / cold-start auth race the live queries silently
  // settle to [] — the Chats tab masks that with its cache, but this
  // screen showed "No matches" with a full address book. Live data still
  // wins the moment it arrives, and we write-through both scopes so the
  // picker keeps working fully offline.
  const userKey = myUserId || 'anon';
  const [cachedConversations, setCachedConversations] = useState<any[] | null>(null);
  const [cachedContacts, setCachedContacts] = useState<any[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [convMeta, contactMeta] = await Promise.all([
        readCacheMeta<any[]>('conversations', userKey),
        readCacheMeta<any[]>('contacts', userKey),
      ]);
      if (!alive) return;
      if (convMeta && Array.isArray(convMeta.data)) setCachedConversations(convMeta.data);
      if (contactMeta && Array.isArray(contactMeta.data)) setCachedContacts(contactMeta.data);
    })();
    return () => {
      alive = false;
    };
  }, [userKey]);
  useEffect(() => {
    if (Array.isArray(conversationsData) && conversationsData.length > 0) {
      void writeCache('conversations', userKey, conversationsData);
    }
  }, [conversationsData, userKey]);
  useEffect(() => {
    if (Array.isArray(contactsData) && contactsData.length > 0) {
      void writeCache('contacts', userKey, contactsData);
    }
  }, [contactsData, userKey]);

  // Prefer live data when it has rows; otherwise fall back to the cache.
  const conversations: any[] | undefined =
    Array.isArray(conversationsData) && conversationsData.length > 0
      ? conversationsData
      : (cachedConversations ?? conversationsData);
  const contacts: any[] | undefined =
    Array.isArray(contactsData) && contactsData.length > 0
      ? contactsData
      : (cachedContacts ?? contactsData);
  // True while we have nothing at all to show but the queries are still
  // resolving — drives a spinner instead of a misleading "No matches".
  const directoryLoading =
    (conversationsLoading || contactsLoading) &&
    (!conversations || conversations.length === 0) &&
    (!contacts || contacts.length === 0);

  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'chats' | 'groups'>('chats');
  const [selected, setSelected] = useState<Record<string, Recipient>>({});
  const [sending, setSending] = useState(false);
  // iter-196: live upload progress + cancellation (big APKs aren't a
  // silent spinner anymore).
  const [uploadProgress, setUploadProgress] = useState<null | {
    index: number;
    total: number;
    fraction: number;
  }>(null);
  const uploadCancelRef = useRef<null | (() => void)>(null);
  const cancelRequestedRef = useRef(false);

  // iter-177: device address-book index — recipient names must match what
  // the user saved on their phone (same override as Chats/Contacts tabs),
  // NOT the Smilers/Google account name.
  const deviceIndex = useDeviceContactIndex();

  // iter-178: "Frequently shared" — stable ids (`u:<userId>` / `c:<convId>`)
  // of past share targets, ranked by use count. Loaded once per mount.
  const [frequentRank, setFrequentRank] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    let cancelled = false;
    if (!myUserId) return;
    getRecentShareTargets(myUserId).then((stats) => {
      if (cancelled) return;
      setFrequentRank(new Map(stats.map((s, i) => [s.id, i])));
    });
    return () => {
      cancelled = true;
    };
  }, [myUserId]);

  // Normalize the share intent into our `SharedPayload` shape. Recomputed
  // whenever the intent changes (a new share can arrive while this screen
  // is open if the user backgrounds + re-shares).
  const livePayload: SharedPayload = useMemo(() => {
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

  // iter-177 hardening: SNAPSHOT the first non-empty payload into local
  // state. The library resets its state on app-background
  // (`resetOnBackground`) and after any consumer calls resetShareIntent —
  // without this snapshot a brief interruption (notification shade,
  // app-switch) while picking recipients would wipe the share and dump
  // the user back on "Nothing shared yet" mid-flow.
  const [payloadSnapshot, setPayloadSnapshot] = useState<SharedPayload | null>(null);
  useEffect(() => {
    if (livePayload.text || (livePayload.files && livePayload.files.length > 0)) {
      setPayloadSnapshot(livePayload);
    }
  }, [livePayload]);
  const payload: SharedPayload = payloadSnapshot ?? livePayload;

  /**
   * Build the recipient list:
   *   - Recent DMs (with their lastActivity timestamps) sorted desc
   *   - Then contacts not already represented as recent DMs
   *   - Filter by `search` (case-insensitive) over name fields
   */
  const recipients: Recipient[] = useMemo(() => {
    const map = new Map<string, Recipient>();


    // 1) Recent DMs (groups live in the dedicated Groups tab)
    if (Array.isArray(conversations)) {
      for (const conv of conversations) {
        if (!conv || !conv._id) continue;
        if (conv.isGroup) continue; // groups handled by groupRecipients
        const isGroup = false;
        // Group: render with group icon + member-count subtitle, no peer.
        // Direct: render with peer name + avatar.
        const peer = conv.otherUser || conv.peer || {};
        // iter-177: device-saved contact name takes priority (exactly like
        // the Chats tab). Falls back to the Smilers profile name chain.
        const name = isGroup
          ? (conv.title || conv.name || conv.groupName || 'Group chat')
          : (getResolvedConversationDisplayName(conv, myUserId, deviceIndex, lookupDeviceContactName, '')
            || getResolvedDisplayName(peer, deviceIndex, lookupDeviceContactName, '')
            || resolveContactName(peer)
            || conv.title || conv.name || 'Direct chat');
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
            ? pickAvatarUrl(conv.groupIcon, conv.icon, conv.groupAvatarUrl, conv.avatar, conv.avatarUrl, conv.photo)
            : pickAvatarUrl(
                peer?.avatar,
                peer?.avatarUrl,
                peer?.profilePicture,
                peer?.profilePictureUrl,
                peer?.photo,
                conv.otherUser?.avatar,
                conv.otherUser?.profilePicture,
                conv.avatar,
                conv.avatarUrl,
              ),
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
          // iter-177: device-saved contact name first, Smilers name after.
          name: getResolvedDisplayName(contact, deviceIndex, lookupDeviceContactName, '')
            || resolveContactName(contact)
            || 'Contact',
          avatarUrl: pickAvatarUrl(
            contact.avatar,
            contact.avatarUrl,
            contact.profilePicture,
            contact.profilePictureUrl,
            contact.photo,
          ),
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

    // iter-178: pin up to 3 "Frequently shared" targets right below the
    // Diary row, ranked by past share usage (stable across visits).
    if (frequentRank.size > 0) {
      const frequent: Recipient[] = [];
      const rest: Recipient[] = [];
      for (const r of list) {
        const id = r.userId ? `u:${r.userId}` : r.conversationId ? `c:${r.conversationId}` : null;
        const rank = id != null ? frequentRank.get(id) : undefined;
        if (rank !== undefined && frequent.length < 3) {
          frequent.push({ ...r, isFrequent: true });
        } else {
          rest.push(r);
        }
      }
      frequent.sort((a, b) => {
        const idA = a.userId ? `u:${a.userId}` : `c:${a.conversationId}`;
        const idB = b.userId ? `u:${b.userId}` : `c:${b.conversationId}`;
        return (frequentRank.get(idA) ?? 99) - (frequentRank.get(idB) ?? 99);
      });
      list = [...frequent, ...rest];
    }

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
  }, [contacts, conversations, deviceIndex, frequentRank, myUserId, search]);

  // iter-350: Groups tab list — every group the viewer belongs to (merges the
  // authoritative `listGroups` with any group rows already in the recents so
  // nothing is missed), filtered by the same search box.
  const groupRecipients: Recipient[] = useMemo(() => {
    const map = new Map<string, Recipient>();
    const addGroup = (conv: any, lastActivity: number) => {
      if (!conv || !conv._id) return;
      const key = `conv:${conv._id}`;
      if (map.has(key)) return;
      const name = conv.title || conv.name || conv.groupName || 'Group chat';
      map.set(key, {
        key,
        conversationId: String(conv._id),
        isGroup: true,
        memberCount:
          typeof conv.memberCount === 'number'
            ? conv.memberCount
            : Array.isArray(conv.members)
            ? conv.members.length
            : undefined,
        name,
        avatarUrl: pickAvatarUrl(
          conv.groupIcon,
          conv.icon,
          conv.groupAvatarUrl,
          conv.avatar,
          conv.avatarUrl,
          conv.photo,
        ),
        lastActivity,
      });
    };
    if (Array.isArray(groupsData)) {
      for (const g of groupsData) {
        addGroup(
          g,
          typeof g?.lastMessageAt === 'number'
            ? g.lastMessageAt
            : typeof g?._creationTime === 'number'
            ? g._creationTime
            : 0,
        );
      }
    }
    // Merge any group conversations from the recents list (defensive).
    if (Array.isArray(conversations)) {
      for (const conv of conversations) {
        if (conv?.isGroup) {
          addGroup(
            conv,
            typeof conv.lastMessageAt === 'number' ? conv.lastMessageAt : 0,
          );
        }
      }
    }
    let list = Array.from(map.values());
    const q = search.trim().toLowerCase();
    if (q.length > 0) list = list.filter((r) => r.name.toLowerCase().includes(q));
    list.sort((a, b) => {
      if ((b.lastActivity || 0) !== (a.lastActivity || 0)) {
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [groupsData, conversations, search]);

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
    cancelRequestedRef.current = false;
    setUploadProgress(null);
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
              outcomes.push({ ok: false, blocked: true, reason: scan.findings[0]?.reason || 'Risky file type' });
              continue;
            }
            // iter-195: size gate before upload (same as chat sends).
            const sizeError = await checkShareFileSize(file);
            if (sizeError) {
              outcomes.push({ ok: false, reason: sizeError });
              continue;
            }
            try {
              const storageId = await uploadFile(convex, file.uri, file.mimeType, undefined, {
                onProgress: (fraction) =>
                  setUploadProgress({ index: 0, total: (payload.files || []).length, fraction }),
                cancelRef: uploadCancelRef,
              });
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
        {
          onFileProgress: (index, total, fraction) =>
            setUploadProgress({ index, total, fraction }),
          cancelRef: uploadCancelRef,
          shouldAbort: () => cancelRequestedRef.current,
        },
      );
      allOutcomes.push({ recipient: r, outcomes });
      if (cancelRequestedRef.current) break;
    }

    setSending(false);
    setUploadProgress(null);

    // Tally success / failure for the toast.
    let sentChats = 0;
    let blockedCount = 0;
    let failedCount = 0;
    const blockedReasons = new Set<string>();
    const failedReasons = new Set<string>();
    for (const row of allOutcomes) {
      const anyOk = row.outcomes.some((o) => o.ok);
      if (anyOk) sentChats += 1;
      for (const o of row.outcomes) {
        if (o.ok) continue;
        if (o.blocked) {
          blockedCount += 1;
          if (o.reason) blockedReasons.add(o.reason);
        } else {
          failedCount += 1;
          if (o.reason) failedReasons.add(o.reason);
        }
      }
    }

    // Clear native payload so the next launch starts clean.
    try {
      resetShareIntent(true);
    } catch {
      /* ignore */
    }

    // iter-178: remember successful targets for the "Frequently shared"
    // pins on the next share. Best-effort, never blocks navigation.
    const successfulIds = allOutcomes
      .filter((row) => !row.recipient.isDiary && row.outcomes.some((o) => o.ok))
      .map((row) => stableIdOf(row.recipient))
      .filter((id): id is string => !!id);
    if (successfulIds.length > 0) {
      recordShareTargets(myUserId, successfulIds).catch(() => {});
    }

    const lines = [`Sent to ${sentChats} chat${sentChats === 1 ? '' : 's'}`];
    if (blockedCount > 0) {
      lines.push(
        `${blockedCount} item(s) blocked for your safety` +
          (blockedReasons.size > 0 ? `\n(${Array.from(blockedReasons).join('; ')})` : ''),
      );
      lines.push('Smilers blocks risky file types like .exe and .bat.');
    }
    if (failedCount > 0) {
      lines.push(
        `${failedCount} send(s) failed` +
          (failedReasons.size > 0 ? `\n(${Array.from(failedReasons).join('; ')})` : ''),
      );
    }

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
        : item.isFrequent
        ? 'Frequently shared'
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

      {/* iter-192: live connection indicator — removes ambiguity between
          "still reconnecting" and "genuinely no contacts". */}
      <ConnectionStatusPill />

      {/* Payload summary card */}
      <View style={styles.summary}>
        <Feather name="upload-cloud" size={18} color={Colors.primary} />
        <Text style={styles.summaryText} numberOfLines={2}>
          {payloadSummary}
        </Text>
      </View>

      {/* iter-350: Chats / Groups tabs */}
      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'chats' && styles.tabActive]}
          onPress={() => setActiveTab('chats')}
          testID="share-tab-chats"
        >
          <Text style={[styles.tabText, activeTab === 'chats' && styles.tabTextActive]}>Chats</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'groups' && styles.tabActive]}
          onPress={() => setActiveTab('groups')}
          testID="share-tab-groups"
        >
          <Text style={[styles.tabText, activeTab === 'groups' && styles.tabTextActive]}>
            Groups{groupRecipients.length > 0 ? ` (${groupRecipients.length})` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Feather name="search" size={16} color={Colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder={activeTab === 'groups' ? 'Search groups' : 'Search chats and contacts'}
          placeholderTextColor={Colors.textMuted}
          autoCorrect={false}
          testID="share-search"
        />
      </View>

      <FlatList
        data={activeTab === 'groups' ? groupRecipients : recipients}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.divider} />}
        ListEmptyComponent={
          directoryLoading ? (
            <View style={styles.empty} testID="share-directory-loading">
              <ActivityIndicator color={Colors.primary} />
              <Text style={styles.emptyBody}>Loading your chats and contacts…</Text>
            </View>
          ) : activeTab === 'groups' ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No groups</Text>
              <Text style={styles.emptyBody}>
                {search.trim().length > 0
                  ? 'No group matches your search.'
                  : 'You are not a member of any group yet.'}
              </Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No matches</Text>
              <Text style={styles.emptyBody}>
                {search.trim().length > 0
                  ? 'No chat or contact matches your search.'
                  : 'We couldn\u2019t load your chats — check your connection and try again. New contacts can be added in the Contacts tab.'}
              </Text>
            </View>
          )
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

      {/* iter-196: upload progress overlay (percent + cancel) — big files
          like APKs are no longer a silent spinner. */}
      {sending && uploadProgress ? (
        <View style={styles.progressOverlay} testID="upload-progress-overlay">
          <View style={styles.progressCard}>
            <Text style={styles.progressTitle}>
              {uploadProgress.total > 1
                ? `Uploading file ${Math.min(uploadProgress.index + 1, uploadProgress.total)} of ${uploadProgress.total}…`
                : 'Uploading…'}
            </Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(uploadProgress.fraction * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.progressPercent} testID="upload-progress-percent">
              {Math.round(uploadProgress.fraction * 100)}%
            </Text>
            <TouchableOpacity
              style={styles.progressCancelBtn}
              onPress={() => {
                cancelRequestedRef.current = true;
                uploadCancelRef.current?.();
              }}
              testID="upload-cancel-button"
            >
              <Text style={styles.progressCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
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
  tabsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tabActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  tabText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textSecondary },
  tabTextActive: { color: Colors.headerBg },
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
  progressOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  progressCard: {
    alignSelf: 'stretch',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: 20,
    alignItems: 'center',
    gap: 12,
  },
  progressTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  progressTrack: {
    alignSelf: 'stretch',
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.borderLight,
    overflow: 'hidden',
  },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: Colors.primary },
  progressPercent: { fontSize: FontSize.sm, color: Colors.textSecondary, fontVariant: ['tabular-nums'] as any },
  progressCancelBtn: {
    minHeight: 42,
    paddingHorizontal: 22,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressCancelText: { color: Colors.danger, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
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
