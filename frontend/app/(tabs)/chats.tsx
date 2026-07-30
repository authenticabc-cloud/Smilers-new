import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, Modal, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useConvex, useMutation } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import FabStack from '../../src/components/FabStack';
import SosButton from '../../src/components/SosButton';
import DriveModeToggle from '../../src/components/DriveModeToggle';
import { LoginApprovalBanner } from '../../src/components/LoginApprovalBanner';
import { LiveLocationRequestBanner } from '../../src/components/LiveLocationRequestBanner';
import { PhotoSaveRequestBanner } from '../../src/components/PhotoSaveRequestBanner';
import { PhoneViewRequestBanner } from '../../src/components/PhoneViewRequestBanner';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { readCacheMeta, writeCache } from '../../src/lib/offlineCache';
import { loadAllChatDrafts, type DraftPreview } from '../../src/lib/chatDrafts';
import { getMutedConversations } from '../../src/lib/mutedConversations';
import AsyncStorage from '@react-native-async-storage/async-storage';
import OfflineBanner from '../../src/components/OfflineBanner';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';
// iter-220: pull-to-refresh now forces a Convex socket reconnect — the
// single most effective recovery when the React Native WebSocket has
// silently died (the "ghost connection" pattern called out by Emergent
// support). Wired to the existing manual escape hatch from v2.1.83.
import { forceConvexReconnect } from '../../src/providers/useConvexAutoReconnect';
import { requestConvexReauth } from '../../src/providers/ConvexClientProvider';
import { useAuth } from '../../src/providers/AuthProvider';
// iter-221: connection-status banner + foreground-triggered auto-refresh.
import ConnectionStatusBanner from '../../src/components/ConnectionStatusBanner';
import { AppState } from 'react-native';
// sml-008: don't tear down the live socket mid-call — see handlePullToReconnect below.
import { callHost } from '../../src/lib/call/callHost';
import * as Haptics from 'expo-haptics';
import UndoSnackbar from '../../src/components/UndoSnackbar';
import { readStoredString, writeStoredString } from '../../src/lib/settingsStorage';
import ConversationRow, { formatTypingLabel } from '../../src/components/ConversationRow';
import {
  findSavedContactDisplayName,
  getResolvedConversationDisplayName,
} from '../../src/lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../src/lib/deviceContactIndex';
import { cacheConversationName, cacheUserName } from '../../src/push/notificationNameCache';
import ChatSwipeRow from '../../src/components/ChatSwipeRow';
import { useLocalReadMap } from '../../src/hooks/useLocalReadMap';
import { conversationLastActivityMs, isLocallyRead, markLocallyRead, clearLocalRead, effectiveUnread, noteReadBaseline } from '../../src/lib/localReadState';

const CHAT_FILTER_KEY = 'chats_filter_v1';
const WHATS_NEW_KEY = 'whatsnew_swipe_read_v1';
// Single list-level typing query (needs backend typing.getTypingForConversations).
// Off by default → each row uses its own subscription until the backend + flag are live.
const BATCH_TYPING_ENABLED = process.env.EXPO_PUBLIC_BATCH_TYPING_ENABLED === 'true';
const MARK_UNREAD_ENABLED = process.env.EXPO_PUBLIC_MARK_UNREAD_ENABLED === 'true';

export default function ChatsScreen() {
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);
  const [chatFilter, setChatFilter] = useState<'all' | 'unread'>('all');
  const [mutedIds, setMutedIds] = useState<Set<string>>(new Set());
  const chatFilterLoaded = useRef(false);
  useEffect(() => {
    readStoredString(CHAT_FILTER_KEY)
      .then((v) => {
        if (v === 'unread') setChatFilter('unread');
      })
      .catch(() => {})
      .finally(() => {
        chatFilterLoaded.current = true;
      });
  }, []);
  useEffect(() => {
    if (!chatFilterLoaded.current) return;
    writeStoredString(CHAT_FILTER_KEY, chatFilter).catch(() => {});
  }, [chatFilter]);
  // iter-313: pin Voice Task contacts to the top of the chat list, in their
  // assigned 1..10 order. Off by default (chats stay time-ordered); persisted
  // locally so the choice survives restarts.
  const [pinVoiceTasks, setPinVoiceTasks] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const v = await AsyncStorage.getItem('smilers_pin_voice_task_chats');
        if (alive && v === '1') setPinVoiceTasks(true);
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, []);
  const togglePinVoiceTasks = useCallback(() => {
    setShowMenu(false);
    setPinVoiceTasks((prev) => {
      const next = !prev;
      AsyncStorage.setItem('smilers_pin_voice_task_chats', next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);
  const me = useQuery(api.users.getCurrentUser, {});
  const contacts = useQuery(api.contacts.getContacts, {});
  const conversations = useQuery(api.conversations.listConversations);

  // Proactively cache EVERY 1:1 conversation's DEVICE-CONTACT name (not just the
  // rows currently rendered by the virtualized list) so background/killed message
  // push notifications always show the same name the chat list shows — instead of
  // the sender's Google/account name. Re-runs when the device contact index loads.
  const deviceIndexForCache = useDeviceContactIndex();
  useEffect(() => {
    if (!Array.isArray(conversations) || !me?._id) return;
    for (const item of conversations as any[]) {
      const isGroup =
        item?.isGroup ||
        item?.type === 'group' ||
        (Array.isArray(item?.participants) && item.participants.length > 2);
      if (isGroup || !item?._id) continue;
      const deviceName = getResolvedConversationDisplayName(
        item,
        me._id,
        deviceIndexForCache,
        lookupDeviceContactName,
        '',
      );
      const savedContactName =
        deviceName || findSavedContactDisplayName(contacts, item, me._id);
      // Only cache a genuinely resolved (device/saved-contact) name — never the
      // bare account/fallback name, which would be a no-op override anyway.
      const name = savedContactName;
      if (name) {
        cacheConversationName(String(item._id), name);
        const otherUserId =
          item?.otherUserId || item?.otherParticipant?._id || item?.otherUser?._id;
        if (otherUserId) cacheUserName(String(otherUserId), name);
      }
    }
  }, [conversations, contacts, deviceIndexForCache, me?._id]);

  // Composer drafts per conversation — refreshed whenever the list regains
  // focus (e.g. returning from a chat where a draft was started/cleared) so the
  // "Draft:" preview stays in sync.
  const [drafts, setDrafts] = useState<Record<string, DraftPreview>>({});
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void loadAllChatDrafts().then((map) => {
        if (alive) setDrafts(map);
      });
      // iter-404: refresh the muted-conversation set so the chat list shows the
      // bell-off indicator (and reflects mutes toggled from a chat screen).
      void getMutedConversations().then((ids) => {
        if (alive) setMutedIds(new Set(ids));
      });
      return () => {
        alive = false;
      };
    }, []),
  );
  // Voice Task roster (positions 1..10) — used to optionally pin those
  // contacts' chats to the top in the same order they occupy in Voice Tasks.
  const voiceTaskRows = useQuery(
    (api as any).voiceTaskContacts?.getMyVoiceTaskContacts,
    {},
  ) as any[] | undefined;
  // iter-213: archived chats sync against the shared Convex backend
  // (api.archives.*). The main list does NOT exclude archived rows and
  // carries no isArchived flag, so we fetch the archived id set and
  // filter client-side — exactly how the web app does it.
  const convex = useConvex();
  const archivedIds = useQuery((api as any).archives.getArchivedIds, {}) as string[] | undefined;

  // Per-conversation unread counts { convId: count } — drives the "Mark all as
  // read" menu action.
  const unreadCounts = useQuery((api as any).messages.getUnreadCounts, {}) as
    | Record<string, number>
    | undefined;
  const markRead = useMutation(api.messages.markRead);
  const markUnread = useMutation((api as any).messages.markUnread);
  // iter-340: on-device read overlay so opening a chat clears its list badge
  // instantly even when the backend unread count is slow/inconsistent.
  const localRead = useLocalReadMap();
  const effUnread = useCallback(
    (item: any): number => {
      const id = String(item?._id || '');
      const backend = Number(unreadCounts?.[id]) || 0;
      if (backend <= 0) return 0;
      // Subtract the already-read baseline so a NEW message only surfaces the
      // genuinely-new count (not the stale bulk the backend never cleared).
      return effectiveUnread(localRead, id, conversationLastActivityMs(item), backend);
    },
    [unreadCounts, localRead],
  );

  // Track the "already-read" baseline for every conversation currently in the
  // read state, so when a new message arrives we can show only the new count.
  useEffect(() => {
    if (!unreadCounts) return;
    for (const item of orderedList as any[]) {
      const id = String(item?._id || '');
      if (!id) continue;
      const backend = Number(unreadCounts[id]) || 0;
      if (isLocallyRead(localRead, id, conversationLastActivityMs(item))) {
        noteReadBaseline(id, backend);
      }
    }
    // orderedList is intentionally omitted; unreadCounts/localRead drive updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadCounts, localRead]);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [undoReadId, setUndoReadId] = useState<string | null>(null);
  const [whatsNewVisible, setWhatsNewVisible] = useState(false);
  useEffect(() => {
    readStoredString(WHATS_NEW_KEY)
      .then((v) => {
        if (v !== '1') setWhatsNewVisible(true);
      })
      .catch(() => {});
  }, []);
  const dismissWhatsNew = useCallback(() => {
    setWhatsNewVisible(false);
    writeStoredString(WHATS_NEW_KEY, '1').catch(() => {});
  }, []);

  // Keep the app-icon (launcher) badge in sync — see the effect below
  // `displayList` where we can compute the locally-adjusted total.

  const handleMarkAllRead = useCallback(() => {
    setShowMenu(false);
    const ids = Object.entries(unreadCounts || {})
      .filter(([, count]) => Number(count) > 0)
      .map(([id]) => id);
    if (ids.length === 0) {
      Alert.alert('All caught up', 'You have no unread chats.');
      return;
    }
    Alert.alert(
      'Mark all as read?',
      `This will mark ${ids.length} chat${ids.length > 1 ? 's' : ''} as read and clear their notifications.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark all read',
          onPress: async () => {
            setMarkingAllRead(true);
            let clearFn: ((id: string) => Promise<void>) | null = null;
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              clearFn = require('../../src/push/notifeeMessageDisplay').clearConversationNotifications;
            } catch {}
            for (const id of ids) {
              markLocallyRead(id);
              try {
                await markRead({ conversationId: id });
              } catch {}
              try {
                if (clearFn) await clearFn(id);
              } catch {}
            }
            // Reset the launcher badge immediately (reactive sync also follows).
            try {
              const { setAppBadgeCount } = require('../../src/push/notifeeMessageDisplay');
              await setAppBadgeCount(0);
            } catch {}
            setMarkingAllRead(false);
          },
        },
      ],
    );
  }, [unreadCounts, markRead]);

  // iter 160 (offline persistence): hydrate the conversation list from
  // AsyncStorage on cold launch so users see their last-known chats
  // even with no internet. Fresh data from Convex overrides the cache
  // the moment it arrives.
  const userKey = me?._id ? String(me._id) : 'anon';
  const [cachedList, setCachedList] = useState<any[] | null>(null);
  const [cachedTs, setCachedTs] = useState<number | undefined>(undefined);

  // iter-200 (fix "No chats yet" flash): `loading` must be declared
  // AFTER `cachedList` — the previous ordering was a TDZ error that
  // silently evaluated `cachedList` as `undefined`, making `loading`
  // permanently false. As a result, the empty state was rendered the
  // moment the Convex websocket dropped to `undefined` during a
  // reconnect / auth handshake, even though real chats existed.
  //
  // We now also treat "live query still resolving AND we have no
  // cached fallback" as loading, and we additionally hold the loading
  // state for a brief moment after auth/me resolves so a freshly
  // mounted screen never flickers an empty state while the first
  // query is on the wire.
  const [authSettleElapsed, setAuthSettleElapsed] = useState(false);
  // iter-220: pull-to-refresh now triggers a real Convex socket
  // reconnect. The `refreshing` flag stays true for ~2s so the user
  // gets a visible "Reconnecting…" indicator from the native
  // RefreshControl spinner — one-tap recovery from the "ghost
  // connection" pattern that Emergent support flagged.
  const [reconnecting, setReconnecting] = useState(false);
  const handlePullToReconnect = useCallback(async () => {
    if (reconnecting) return;
    // sml-008: this screen stays mounted underneath the call overlay
    // (<CallHost/> renders at the app root, never unmounting the tab behind
    // it), so this AppState-triggered reconnect was firing within ~1s of
    // EVERY call start and hard-tearing-down the Convex socket
    // (forceConvexReconnect always follows with closeAndReconnect) — the
    // exact socket the call screen depends on to reactively learn the call
    // was declined/ended. Skip entirely while a call is in progress.
    if (callHost.isActive()) return;
    setReconnecting(true);
    try {
      // Force a fresh Convex re-authentication (rotate the OIDC id_token) in
      // addition to the socket reconnect. On slow networks the overnight
      // token-refresh race can leave Convex unauthenticated — a plain socket
      // reconnect reuses the SAME rejected token, so we bump the auth epoch to
      // actually mint a fresh one, then reconnect the socket.
      requestConvexReauth('chats-pull-to-refresh');
      await forceConvexReconnect('chats-pull-to-refresh');
    } catch {
      /* never let pull-to-refresh crash the app */
    }
    // Keep the spinner visible long enough for the user to see SOMETHING
    // happened — even if the reconnect completes instantly. 1.8s is the
    // sweet spot where it feels responsive but visible.
    setTimeout(() => setReconnecting(false), 1800);
  }, [reconnecting]);

  // Dedicated recovery for the "No chats yet" empty state — this is the BROKEN
  // state (signed in locally but Convex unauthenticated), so we do the full fix
  // a manual sign-out/sign-in does: a SILENT re-login (mints a fresh token off
  // the live SSO session, no wall) → push it to Convex → reconnect the socket.
  const { trySilentReauth } = useAuth();
  const handleEmptyReconnect = useCallback(async () => {
    if (reconnecting || callHost.isActive()) return;
    setReconnecting(true);
    try {
      let restored = false;
      if (typeof trySilentReauth === 'function') {
        try {
          restored = await trySilentReauth();
        } catch {
          restored = false;
        }
      }
      requestConvexReauth(restored ? 'empty-reconnect-post-silent' : 'empty-reconnect');
      await forceConvexReconnect('chats-empty-reconnect');
    } catch {
      /* never let the recovery button crash the app */
    }
    setTimeout(() => setReconnecting(false), 1800);
  }, [reconnecting, trySilentReauth]);

  // iter-221 D — auto pull-to-refresh on FOREGROUND (iter-380 HARDENED).
  //
  // When the user brings the app back from background, the OS may have
  // killed the Convex WebSocket silently — a real resume should refresh.
  //
  // BUT device logs (session with rapid AppState churn) showed some devices
  // flapping active↔background every 1-2s. The old unconditional reconnect
  // fired `closeAndReconnect()` on EVERY 'active', tearing down the Convex
  // socket faster than it could re-authenticate and load — so `me` /
  // conversations NEVER resolved and the app showed a permanent BLANK screen
  // ("nothing shows") recoverable only by clearing storage. We now only
  // reconnect on a GENUINE resume: the app was backgrounded for a meaningful
  // duration AND not more often than a cooldown. Spurious sub-3s flaps (which
  // don't actually kill the socket) are ignored so a flapping device can't
  // weaponise this into a reconnect storm.
  const fgBgAtRef = useRef<number | null>(null);
  const lastFgReconnectRef = useRef(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        if (fgBgAtRef.current == null) fgBgAtRef.current = Date.now();
        return;
      }
      if (next === 'active') {
        const bgAt = fgBgAtRef.current;
        fgBgAtRef.current = null;
        const bgDuration = bgAt ? Date.now() - bgAt : 0;
        if (bgDuration < 3000) return; // spurious flap — socket is fine
        if (Date.now() - lastFgReconnectRef.current < 20_000) return; // cooldown
        lastFgReconnectRef.current = Date.now();
        void handlePullToReconnect();
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {}
    };
  }, [handlePullToReconnect]);
  useEffect(() => {
    setAuthSettleElapsed(false);
    const t = setTimeout(() => setAuthSettleElapsed(true), 1500);
    return () => clearTimeout(t);
  }, [userKey]);
  const liveResolved = Array.isArray(conversations);
  const loading =
    !liveResolved && (cachedList === null || cachedList.length === 0 || !authSettleElapsed);
  useEffect(() => {
    let alive = true;
    (async () => {
      const meta = await readCacheMeta<any[]>('conversations', userKey);
      if (alive && meta) {
        if (Array.isArray(meta.data)) setCachedList(meta.data);
        setCachedTs(meta.ts);
      }
    })();
    return () => { alive = false; };
  }, [userKey]);
  useEffect(() => {
    if (Array.isArray(conversations)) {
      // Don't clobber a known-good cached list with an empty live result
      // (the transient empty-resolve during re-auth that caused the "No chats
      // yet" lockout). Only persist when live has rows, or when we have no
      // cached rows yet (legitimately-empty accounts still cache []).
      if (conversations.length > 0 || !(Array.isArray(cachedList) && cachedList.length > 0)) {
        void writeCache('conversations', userKey, conversations);
        setCachedTs(Date.now());
      }
    }
  }, [conversations, userKey, cachedList]);
  // iter-191: persist a copy of `me` under a FIXED key so screens that can
  // mount while Convex is still (re)authenticating — the share sheet — can
  // resolve the correct per-user cache key instead of falling back to 'anon'.
  useEffect(() => {
    if (me?._id) void writeCache('me', 'self', me);
  }, [me]);

  // Prefer live data; fall back to cache while loading.
  const liveList: any[] | null = Array.isArray(conversations) ? conversations : null;
  // iter-241 ("No chats yet" lockout fix): when the live query resolves to an
  // EMPTY array (which happens transiently during a Convex re-auth / socket
  // handshake, or when the identity token in SecureStore goes stale) we must
  // NOT blow away a known-good list. Prefer live only when it actually has
  // rows; otherwise fall back to the cached list. This is what kept users
  // stuck on "No chats yet" until a full reinstall.
  const liveHasRows = Array.isArray(liveList) && liveList.length > 0;
  const cacheHasRows = Array.isArray(cachedList) && cachedList.length > 0;
  const list: any[] = liveHasRows ? liveList! : cacheHasRows ? cachedList! : liveList ?? cachedList ?? [];
  const showOfflineBanner = (!liveList || (!liveHasRows && cacheHasRows)) && cacheHasRows;

  // If live came back empty but we DO have cached chats, the session/socket is
  // almost certainly in a bad state — actively recover by forcing a Convex
  // reconnect (once per empty-resolve) instead of leaving the user stranded.
  const recoveredEmptyRef = useRef(false);
  // iter-316: hard time-based cooldown. `forceConvexReconnect` is NOT
  // rate-limited, and `recoveredEmptyRef` resets the moment rows briefly
  // appear — so an oscillating live query (empty→rows→empty every ~2s) could
  // weaponise this into a reconnect STORM ("disco" flicker + constant token
  // refresh + push re-register). Never fire this recovery more than once per
  // 30s regardless of the ref, so a flapping socket can't runaway.
  const lastEmptyRecoverAtRef = useRef(0);
  useEffect(() => {
    if (liveResolved && !liveHasRows && cacheHasRows) {
      const now = Date.now();
      if (!recoveredEmptyRef.current && now - lastEmptyRecoverAtRef.current > 30_000) {
        recoveredEmptyRef.current = true;
        lastEmptyRecoverAtRef.current = now;
        requestConvexReauth('chats-empty-with-cache');
        void forceConvexReconnect('chats-empty-with-cache');
      }
    } else if (liveHasRows) {
      recoveredEmptyRef.current = false;
    }
  }, [liveResolved, liveHasRows, cacheHasRows]);

  // iter-213: archived chats — filter them out of the main list and keep
  // a count for the "Archived" pinned row (shown only when count > 0).
  const archivedSet = useMemo(
    () => new Set((archivedIds || []).map((id: any) => String(id))),
    [archivedIds],
  );
  const visibleList = useMemo(
    () => list.filter((c: any) => !archivedSet.has(String(c?._id))),
    [list, archivedSet],
  );
  const archivedCount = archivedIds?.length ?? 0;

  // iter-313: map each Voice Task contact's user id → its position (1..10),
  // then (when the pin toggle is on) sort matching conversations to the top in
  // that order. Non-voice-task chats keep their normal recency order below.
  const voiceTaskOrder = useMemo(() => {
    const map = new Map<string, number>();
    (Array.isArray(voiceTaskRows) ? voiceTaskRows : []).forEach((r: any) => {
      const uid = String(r?.contactId || r?.userId || '');
      const pos = Number(r?.position);
      if (uid && pos >= 1 && pos <= 10) map.set(uid, pos);
    });
    return map;
  }, [voiceTaskRows]);

  const orderedList = useMemo(() => {
    if (!pinVoiceTasks || voiceTaskOrder.size === 0) return visibleList;
    const peerId = (c: any): string =>
      String(
        c?.otherUserId ||
          c?.otherParticipant?._id ||
          c?.otherUser?._id ||
          c?.otherParticipantId ||
          '',
      );
    const pinned: any[] = [];
    const rest: any[] = [];
    visibleList.forEach((c: any) => {
      const pos = voiceTaskOrder.get(peerId(c));
      if (pos) pinned.push({ c, pos });
      else rest.push(c);
    });
    pinned.sort((a, b) => a.pos - b.pos);
    return [...pinned.map((p) => p.c), ...rest];
  }, [pinVoiceTasks, voiceTaskOrder, visibleList]);

  // Draft bump: conversations with an unsent draft float to the top so the
  // user can pick up where they paused. Skipped when Voice-Task pinning is on
  // (that's an explicit ordering the user chose). Stable — relative order
  // within the drafted / non-drafted groups is preserved.
  const finalList = useMemo(() => {
    if (pinVoiceTasks) return orderedList;
    if (!drafts || Object.keys(drafts).length === 0) return orderedList;
    const withDraft: any[] = [];
    const without: any[] = [];
    orderedList.forEach((c: any) => (drafts[String(c?._id)] ? withDraft.push(c) : without.push(c)));
    if (withDraft.length === 0) return orderedList;
    return [...withDraft, ...without];
  }, [pinVoiceTasks, orderedList, drafts]);

  // Unread-first ordering: chats with unread messages float up (kept below any
  // Voice-Task pins and drafted chats). Stable — preserves recency order within
  // each bucket. Skipped entirely when Voice-Task pinning is on (explicit order).
  const displayList = useMemo(() => {
    if (pinVoiceTasks) return finalList;
    const rank = (c: any): number => {
      if (drafts && drafts[String(c?._id)]) return 3; // drafts stay on top
      if (effUnread(c) > 0) return 2; // then unread
      return 1;
    };
    const decorated = finalList.map((c: any, i: number) => ({ c, i }));
    decorated.sort((a, b) => rank(b.c) - rank(a.c) || a.i - b.i);
    return decorated.map((x) => x.c);
  }, [pinVoiceTasks, finalList, drafts, effUnread]);

  // Keep the app-icon (launcher) badge in sync with the LOCALLY-adjusted total
  // unread count (opened chats are suppressed even if the backend count lags).
  useEffect(() => {
    const total = displayList.reduce((sum: number, c: any) => sum + effUnread(c), 0);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setAppBadgeCount } = require('../../src/push/notifeeMessageDisplay');
      void setAppBadgeCount(total);
    } catch {}
  }, [displayList, effUnread]);

  // "Unread" filter chip: show only conversations with unread messages.
  const filteredList = useMemo(() => {
    if (chatFilter !== 'unread') return displayList;
    return displayList.filter((c: any) => effUnread(c) > 0);
  }, [chatFilter, displayList, effUnread]);
  const totalUnreadChats = useMemo(
    () => displayList.filter((c: any) => effUnread(c) > 0).length,
    [displayList, effUnread],
  );

  // One list-level typing subscription for all visible rows (perf: avoids one
  // Convex subscription per row). Returns { [conversationId]: [{ name }] }.
  const visibleConvIds = useMemo(
    () => (BATCH_TYPING_ENABLED ? filteredList.map((c: any) => String(c?._id)).filter(Boolean) : []),
    [filteredList],
  );
  const { data: typingMap } = useSafeConvexQuery<Record<string, any[]>>(
    (api as any).typing.getTypingForConversations,
    { conversationIds: visibleConvIds },
    {},
    BATCH_TYPING_ENABLED && visibleConvIds.length > 0,
  );

  const handleArchive = useCallback(
    async (conversationId: string) => {
      try {
        await convex.mutation((api as any).archives.archiveConversation, { conversationId });
      } catch (e: any) {
        Alert.alert('Could not archive', e?.message || 'Please try again.');
      }
    },
    [convex],
  );

  const handleMenuPress = (route: string) => {
    setShowMenu(false);
    router.push(route as any);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="chats-screen">
      <Header
        title="Smilers"
        variant="light"
        // iter-140b: render the user's profile photo as a tappable
        // circle on the LEFT side of the header — this is what the web
        // app shows in the top-left corner of the Chats list. Tapping
        // it opens the Account screen. Falls back to initials when the
        // profile photo isn't set yet.
        leftAction={
          <TouchableOpacity
            onPress={() => router.push('/account' as any)}
            testID="chats-header-avatar"
            accessibilityLabel="Open account"
            style={{ marginRight: 12 }}
          >
            <Avatar
              name={(me as any)?.name || (me as any)?.displayName || ''}
              size={36}
              uri={
                (me as any)?.profilePicture ||
                (me as any)?.avatarUrl ||
                (me as any)?.avatar
              }
            />
          </TouchableOpacity>
        }
        right={
          <>
            <TouchableOpacity onPress={() => router.push('/search' as any)} testID="search-btn">
              <Ionicons name="search-outline" size={22} color={Colors.textPrimary} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowMenu(true)}
              testID="menu-btn"
              style={{ marginLeft: 16 }}
            >
              <Feather name="more-vertical" size={22} color={Colors.textPrimary} />
            </TouchableOpacity>
          </>
        }
      />

      <OfflineBanner visible={showOfflineBanner} ts={cachedTs} />
      {/* iter-221 C — visible "Reconnecting…" banner when Convex WebSocket
          stays disconnected >5s. Sits at the top of the chat list so the
          user gets immediate visual confirmation of why their data isn't
          updating and a one-tap manual Retry button. */}
      <ConnectionStatusBanner />

      <Modal
        visible={showMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMenu(false)}
      >
        <Pressable style={menuStyles.backdrop} onPress={() => setShowMenu(false)}>
          <View style={menuStyles.popover}>
            <MenuItem
              icon={<Feather name="check-circle" size={20} color={Colors.textPrimary} />}
              label={markingAllRead ? 'Marking…' : 'Mark all as read'}
              onPress={handleMarkAllRead}
              testID="menu-mark-all-read"
            />
            <MenuItem
              icon={<Feather name="phone" size={20} color={Colors.textPrimary} />}
              label="Calls"
              onPress={() => handleMenuPress('/calls')}
              testID="menu-calls"
            />
            <MenuItem
              icon={<Feather name="bookmark" size={20} color={Colors.textPrimary} />}
              label="Starred Messages"
              onPress={() => handleMenuPress('/starred')}
              testID="menu-starred"
            />
            <MenuItem
              icon={<Feather name="archive" size={20} color={Colors.textPrimary} />}
              label="Archived Chats"
              onPress={() => handleMenuPress('/archived')}
              testID="menu-archived"
            />
            <MenuItem
              icon={<Feather name="filter" size={20} color={Colors.textPrimary} />}
              label="Filter Bin"
              onPress={() => handleMenuPress('/filter-bin')}
              testID="menu-filter-bin"
            />
            <TouchableOpacity
              style={menuStyles.row}
              onPress={togglePinVoiceTasks}
              activeOpacity={0.6}
              testID="menu-pin-voice-tasks"
            >
              <View style={menuStyles.iconWrap}>
                <MaterialCommunityIcons
                  name={pinVoiceTasks ? 'pin' : 'pin-outline'}
                  size={20}
                  color={pinVoiceTasks ? Colors.primary : Colors.textPrimary}
                />
              </View>
              <Text style={menuStyles.label}>Pin Voice Task chats</Text>
              <View style={{ flex: 1 }} />
              <Feather
                name={pinVoiceTasks ? 'check-circle' : 'circle'}
                size={18}
                color={pinVoiceTasks ? Colors.primary : Colors.textMuted}
              />
            </TouchableOpacity>
            <MenuItem
              icon={<Feather name="lock" size={20} color={Colors.textPrimary} />}
              label="Encryption"
              onPress={() => handleMenuPress('/encryption')}
              testID="menu-encryption"
            />
            <MenuItem
              icon={<Feather name="settings" size={20} color={Colors.textPrimary} />}
              label="Settings"
              onPress={() => handleMenuPress('/settings')}
              isLast
              testID="menu-settings"
            />
          </View>
        </Pressable>
      </Modal>

      <FlatList
        data={filteredList}
        keyExtractor={(item: any) => item._id}
        contentContainerStyle={styles.listContent}
        // Perf: bound the render window so only the visible rows mount. This is
        // the fix for the chat-list freeze — without these, EVERY conversation
        // row mounted at once, and each row opens its own live Convex typing
        // subscription (BATCH_TYPING_ENABLED is off by default), so a long list
        // spun up dozens of simultaneous subscriptions + re-rendered them all on
        // any parent state change. Virtualization keeps mounted rows (and their
        // subscriptions) to ~one screenful; off-screen rows unmount and close.
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={50}
        windowSize={9}
        removeClippedSubviews
        ListHeaderComponent={
          <>
            <View style={styles.filterChipsRow}>
              <TouchableOpacity
                style={[styles.filterChip, chatFilter === 'all' && styles.filterChipActive]}
                onPress={() => setChatFilter('all')}
                activeOpacity={0.7}
                testID="chat-filter-all"
              >
                <Text style={[styles.filterChipText, chatFilter === 'all' && styles.filterChipTextActive]}>All</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.filterChip, chatFilter === 'unread' && styles.filterChipActive]}
                onPress={() => setChatFilter('unread')}
                activeOpacity={0.7}
                testID="chat-filter-unread"
              >
                <Text style={[styles.filterChipText, chatFilter === 'unread' && styles.filterChipTextActive]}>
                  {totalUnreadChats > 0 ? `Unread (${totalUnreadChats > 99 ? '99+' : totalUnreadChats})` : 'Unread'}
                </Text>
              </TouchableOpacity>
            </View>
            {chatFilter === 'all' ? (
              <>
            {whatsNewVisible ? (
              <View style={styles.whatsNewCard} testID="whats-new-tip">
                <Feather name="zap" size={18} color={Colors.primary} />
                <View style={styles.whatsNewTextWrap}>
                  <Text style={styles.whatsNewTitle}>New gestures</Text>
                  <Text style={styles.whatsNewBody}>
                    Swipe a chat left to mark it read, and tap the Unread filter to focus on what needs a reply.
                  </Text>
                </View>
                <TouchableOpacity onPress={dismissWhatsNew} hitSlop={10} testID="whats-new-dismiss">
                  <Feather name="x" size={18} color={Colors.textMuted} />
                </TouchableOpacity>
              </View>
            ) : null}
            {/* iter-186: pending desktop login approvals (contract §5.5) */}
            <LoginApprovalBanner />
            {/* Incoming live-location requests — tap to confirm & share. */}
            <LiveLocationRequestBanner />
            {/* Incoming profile-photo save requests — approve/decline. */}
            <PhotoSaveRequestBanner />
            {/* Incoming phone-number view requests — approve/decline. */}
            <PhoneViewRequestBanner />
            <PinnedRow
              iconBg={Colors.aiBadge}
              iconBgDark={Colors.aiBadgeDark}
              icon={<MaterialCommunityIcons name="creation" size={24} color={Colors.white} />}
              title="Smilers AI"
              subtitle="Ask me anything, I'm here to help!"
              badge="AI"
              badgeColor={Colors.aiBadge}
              onPress={() => router.push('/ai-chat' as any)}
              testID="chat-ai"
            />
            {/* Diary — personal-notes self-conversation (iter-109 web parity).
                Sits between Smilers AI and Devotion in the pinned-row stack.
                Blue/indigo palette + "You" badge mirrors the web app screenshot. */}
            <PinnedRow
              iconBg={Colors.diary}
              iconBgDark={Colors.diaryDark}
              icon={<MaterialCommunityIcons name="book-account-outline" size={22} color={Colors.white} />}
              title="Diary"
              subtitle="Save notes, files, and forwarded messages"
              badge="You"
              badgeColor={Colors.diary}
              onPress={() => router.push('/diary' as any)}
              testID="chat-diary"
            />
            {/* Devotion entry pinned at top of chats (iter-102 web parity).
                Sits between Smilers AI and Chat Once. Teal/sage colour
                matches the web app's design language. */}
            <PinnedRow
              iconBg={Colors.devotion}
              iconBgDark={Colors.devotionDark}
              icon={<MaterialCommunityIcons name="book-open-page-variant-outline" size={22} color={Colors.white} />}
              title="Devotion"
              subtitle="Share and receive devotional broadcasts"
              badge="Broadcast"
              badgeColor={Colors.devotion}
              onPress={() => router.push('/devotionals' as any)}
              testID="chat-devotion"
            />
            <PinnedRow
              iconBg={Colors.chatOnce}
              iconBgDark={Colors.chatOnceDark}
              icon={<Feather name="globe" size={24} color={Colors.white} />}
              title="Chat Once"
              subtitle="Anonymous chat with anyone - no contacts n..."
              badge="24h"
              badgeColor={Colors.chatOnce}
              onPress={() => router.push('/chat-once' as any)}
              testID="chat-once"
            />
            {/* iter-364: "Archived" — restyled as a vibrant floating gradient
                banner. It serves as the visual BORDERLINE between the feature
                rows above (Smilers AI, Diary, Devotion, Chat Once) and the real
                conversations below. Shown only when there's ≥1 archived chat. */}
            {archivedCount > 0 ? (
              <TouchableOpacity
                onPress={() => router.push('/archived' as any)}
                activeOpacity={0.85}
                testID="chat-archived"
              >
                <LinearGradient
                  colors={['#A855F7', '#6366F1', '#3B82F6', '#14B8A6']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.archivedBanner}
                >
                  <View style={styles.archivedIconWrap}>
                    <Feather name="archive" size={20} color={Colors.white} />
                  </View>
                  <View style={styles.archivedMiddle}>
                    <Text style={styles.archivedTitle}>Archived</Text>
                    <Text style={styles.archivedSubtitle} numberOfLines={1}>
                      {archivedCount === 1
                        ? '1 chat tucked away'
                        : `${archivedCount} chats tucked away`}
                    </Text>
                  </View>
                  <View style={styles.archivedCountPill}>
                    <Text style={styles.archivedCountText}>{archivedCount}</Text>
                  </View>
                  <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.95)" />
                </LinearGradient>
              </TouchableOpacity>
            ) : null}

            {/* iter-365: when there are NO archived chats (so the gradient
                banner above is hidden), a slim gradient line still marks the
                borderline between the feature section and the conversations. */}
            {archivedCount === 0 ? (
              <LinearGradient
                colors={['#A855F7', '#6366F1', '#3B82F6', '#14B8A6']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.featureDivider}
              />
            ) : null}
              </>
            ) : null}
          </>
        }
        renderItem={({ item }) => {
          const rowUnread = effUnread(item);
          return (
          <ChatSwipeRow
            onArchive={() => handleArchive(item._id)}
            hasUnread={rowUnread > 0}
            onMarkRead={async () => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              markLocallyRead(String(item._id), conversationLastActivityMs(item));
              try {
                await markRead({ conversationId: String(item._id) });
              } catch {}
              setUndoReadId(String(item._id));
              try {
                const { clearConversationNotifications } = require('../../src/push/notifeeMessageDisplay');
                await clearConversationNotifications(String(item._id));
              } catch {}
            }}
          >
            <ConversationRow
              item={item}
              currentUserId={me?._id}
              contacts={contacts}
              draft={drafts[String(item._id)]}
              unreadCount={rowUnread}
              muted={mutedIds.has(String(item._id))}
              typingFromParent={BATCH_TYPING_ENABLED}
              typingLabel={
                BATCH_TYPING_ENABLED
                  ? formatTypingLabel((typingMap as any)?.[String(item._id)] || [], me?._id)
                  : null
              }
              onPress={() => {
                // Jump straight to the system message when this row's latest
                // activity is a group event that involves you (e.g. "Kojo
                // added you"). Requires the backend to expose `lastMessageId`
                // + `lastSystemKind`/`lastSystemMeta` on the conversation row.
                const meta = (item as any)?.lastSystemMeta || {};
                const targetIds: string[] = Array.isArray(meta.targetIds)
                  ? meta.targetIds.map((t: any) => String(t))
                  : meta.targetId
                  ? [String(meta.targetId)]
                  : [];
                const involvesMe =
                  !!me?._id &&
                  targetIds.includes(String(me._id)) &&
                  String(meta.actorId || '') !== String(me._id);
                const jumpId = (item as any)?.lastMessageId;
                const suffix = involvesMe && jumpId ? `?jump=${jumpId}` : '';
                router.push(`/chat/${item._id}${suffix}` as any);
              }}
            />
          </ChatSwipeRow>
          );
        }}
        ListEmptyComponent={
          !loading ? (
            chatFilter === 'unread' ? (
              <View style={styles.empty}>
                <View style={styles.emptyIconWrap}>
                  <Feather name="check-circle" size={32} color={Colors.textMuted} />
                </View>
                <Text style={styles.emptyTitle}>No unread chats</Text>
                <Text style={styles.emptySub}>You&apos;re all caught up</Text>
                <TouchableOpacity
                  style={styles.showAllBtn}
                  onPress={() => setChatFilter('all')}
                  activeOpacity={0.7}
                  testID="chat-show-all"
                >
                  <Text style={styles.showAllBtnText}>Show all chats</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.empty}>
                <View style={styles.emptyIconWrap}>
                  <Feather name="message-square" size={32} color={Colors.textMuted} />
                </View>
                <Text style={styles.emptyTitle}>No chats yet</Text>
                <Text style={styles.emptySub}>Go to Contacts to start a new conversation</Text>
                {/* Manual recovery escape hatch. On very poor networks the
                    overnight token-refresh race can leave the app signed-in
                    locally but Convex unauthenticated → chats look empty. This
                    forces a fresh re-auth + socket reconnect on demand (the
                    auto-watchdog also does this, but users on the worst
                    networks get a one-tap fix here too). */}
                <TouchableOpacity
                  style={styles.reconnectBtn}
                  onPress={handleEmptyReconnect}
                  activeOpacity={0.7}
                  disabled={reconnecting}
                  testID="chats-empty-reconnect"
                >
                  <Feather
                    name="refresh-cw"
                    size={15}
                    color={Colors.primary}
                    style={{ marginRight: 8 }}
                  />
                  <Text style={styles.reconnectBtnText}>
                    {reconnecting ? 'Reconnecting…' : "Not seeing your chats? Reconnect"}
                  </Text>
                </TouchableOpacity>
              </View>
            )
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={reconnecting}
            onRefresh={handlePullToReconnect}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
            title={reconnecting ? 'Reconnecting…' : ''}
            titleColor={Colors.primary}
          />
        }
      />

      <SosButton onPress={() => router.push('/emergency' as any)} />
      <DriveModeToggle />
      <FabStack
        onPencil={() => router.push('/(tabs)/contacts')}
        onBuilding={() => router.push('/community-create' as any)}
        onBroadcast={me?.role === 'admin' ? () => router.push('/broadcast-create' as any) : undefined}
        onPeople={() => router.push('/groups-create' as any)}
      />
      <UndoSnackbar
        visible={!!undoReadId && MARK_UNREAD_ENABLED}
        message="Marked as read"
        onUndo={async () => {
          if (!undoReadId) return;
          clearLocalRead(undoReadId);
          try {
            await markUnread({ conversationId: undoReadId });
          } catch {}
        }}
        onDismiss={() => setUndoReadId(null)}
      />
    </SafeAreaView>
  );
}

function PinnedRow({
  iconBg,
  icon,
  title,
  subtitle,
  badge,
  badgeColor,
  onPress,
  testID,
}: {
  iconBg: string;
  iconBgDark?: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badge: string;
  badgeColor: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.7} testID={testID}>
      <View style={[styles.pinnedIcon, { backgroundColor: iconBg }]}>{icon}</View>
      <View style={styles.rowMiddle}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={[styles.badge, { backgroundColor: `${badgeColor}22` }]}>
        <Text style={[styles.badgeText, { color: badgeColor }]}>{badge}</Text>
      </View>
    </TouchableOpacity>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { paddingBottom: 180 },
  archivedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 18,
    ...Shadow.md,
  },
  featureDivider: {
    height: 3,
    borderRadius: 2,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 12,
    opacity: 0.55,
  },
  archivedIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  archivedMiddle: {
    flex: 1,
    marginLeft: Spacing.md,
  },
  archivedTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    marginBottom: 2,
    letterSpacing: 0.2,
  },
  archivedSubtitle: {
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.9)',
    fontWeight: FontWeight.medium,
  },
  archivedCountPill: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.28)',
    marginRight: 6,
  },
  archivedCountText: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },
  swipeArchiveAction: {
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    width: 92,
    gap: 4,
  },
  swipeArchiveText: {
    color: Colors.white,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
  },
  swipeReadAction: {
    backgroundColor: Colors.success || '#22c55e',
    justifyContent: 'center',
    alignItems: 'center',
    width: 92,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  pinnedIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.sm,
  },
  rowMiddle: {
    flex: 1,
    marginLeft: Spacing.md,
  },
  filterChipsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surfaceAlt || Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterChipText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  filterChipTextActive: {
    color: Colors.white,
  },
  showAllBtn: {
    marginTop: Spacing.md,
    paddingHorizontal: 20,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  showAllBtnText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
  reconnectBtn: {
    marginTop: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: 'transparent',
  },
  reconnectBtnText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
  },
  whatsNewCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  whatsNewTextWrap: { flex: 1 },
  whatsNewTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  whatsNewBody: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 17 },
  rowTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  rowTitleUnread: {
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  rowSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  rowSubtitleUnread: {
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
  },
  draftPrefix: {
    color: Colors.danger,
    fontWeight: FontWeight.semibold,
  },
  rowTyping: {
    color: Colors.primary,
    fontStyle: 'italic',
  },
  rowTime: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginLeft: Spacing.sm,
  },
  rowRightCol: {
    marginLeft: Spacing.sm,
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 4,
  },
  rowTimeUnread: {
    color: Colors.tickRed,
    fontWeight: FontWeight.semibold,
    marginLeft: 0,
  },
  unreadPill: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: Colors.tickRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadPillText: { fontSize: 11, fontWeight: '700', color: Colors.white },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radius.pill,
    marginLeft: Spacing.sm,
  },
  badgeText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
  },
  empty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl * 2,
    paddingHorizontal: Spacing.lg,
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 16,
    backgroundColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.base,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginBottom: Spacing.xs,
  },
  emptySub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
});


function MenuItem({
  icon,
  label,
  onPress,
  isLast,
  testID,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  isLast?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[menuStyles.row, isLast && menuStyles.rowLast]}
      onPress={onPress}
      activeOpacity={0.6}
      testID={testID}
    >
      <View style={menuStyles.iconWrap}>{icon}</View>
      <Text style={menuStyles.label}>{label}</Text>
    </TouchableOpacity>
  );
}

const menuStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  popover: {
    position: 'absolute',
    top: 56,
    right: 12,
    minWidth: 220,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  iconWrap: {
    width: 30,
    alignItems: 'flex-start',
  },
  label: {
    fontSize: 16,
    color: Colors.textPrimary,
    fontWeight: '500',
  },
});
