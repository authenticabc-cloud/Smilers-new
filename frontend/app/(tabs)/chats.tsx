import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, Modal, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery, useConvex } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import FabStack from '../../src/components/FabStack';
import SosButton from '../../src/components/SosButton';
import { LoginApprovalBanner } from '../../src/components/LoginApprovalBanner';
import { api } from '../../src/convexApi';
import { findSavedContactDisplayName, getConversationDisplayName, getResolvedConversationDisplayName } from '../../src/lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../src/lib/deviceContactIndex';
import { readCacheMeta, writeCache } from '../../src/lib/offlineCache';
import OfflineBanner from '../../src/components/OfflineBanner';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';
// iter-220: pull-to-refresh now forces a Convex socket reconnect — the
// single most effective recovery when the React Native WebSocket has
// silently died (the "ghost connection" pattern called out by Emergent
// support). Wired to the existing manual escape hatch from v2.1.83.
import { forceConvexReconnect } from '../../src/providers/useConvexAutoReconnect';
// iter-221: connection-status banner + foreground-triggered auto-refresh.
import ConnectionStatusBanner from '../../src/components/ConnectionStatusBanner';
import { AppState } from 'react-native';

function relTime(iso?: string) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`;
    return `${Math.floor(diff / 86_400_000)}d`;
  } catch {
    return '';
  }
}

export default function ChatsScreen() {
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);
  const me = useQuery(api.users.getCurrentUser, {});
  const contacts = useQuery(api.contacts.getContacts, {});
  const conversations = useQuery(api.conversations.listConversations);
  // iter-213: archived chats sync against the shared Convex backend
  // (api.archives.*). The main list does NOT exclude archived rows and
  // carries no isArchived flag, so we fetch the archived id set and
  // filter client-side — exactly how the web app does it.
  const convex = useConvex();
  const archivedIds = useQuery((api as any).archives.getArchivedIds, {}) as string[] | undefined;

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
    setReconnecting(true);
    try {
      await forceConvexReconnect('chats-pull-to-refresh');
    } catch {
      /* never let pull-to-refresh crash the app */
    }
    // Keep the spinner visible long enough for the user to see SOMETHING
    // happened — even if the reconnect completes instantly. 1.8s is the
    // sweet spot where it feels responsive but visible.
    setTimeout(() => setReconnecting(false), 1800);
  }, [reconnecting]);

  // iter-221 D — auto pull-to-refresh on FOREGROUND.
  //
  // When the user brings the app back from background, the OS may have
  // killed the Convex WebSocket silently. useConvexAutoReconnect
  // already fires a soft reconnect on AppState 'active' — here we ALSO
  // surface the same visible "Reconnecting…" spinner the user gets
  // from a manual pull, so they have immediate visual feedback that
  // the chat list is being refreshed and they don't need to pull
  // themselves.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
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
      void writeCache('conversations', userKey, conversations);
      setCachedTs(Date.now());
    }
  }, [conversations, userKey]);
  // iter-191: persist a copy of `me` under a FIXED key so screens that can
  // mount while Convex is still (re)authenticating — the share sheet — can
  // resolve the correct per-user cache key instead of falling back to 'anon'.
  useEffect(() => {
    if (me?._id) void writeCache('me', 'self', me);
  }, [me]);

  // Prefer live data; fall back to cache while loading.
  const liveList: any[] | null = Array.isArray(conversations) ? conversations : null;
  const list: any[] = liveList ?? cachedList ?? [];
  const showOfflineBanner = !liveList && Array.isArray(cachedList) && cachedList.length > 0;

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
        data={visibleList}
        keyExtractor={(item: any) => item._id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            {/* iter-186: pending desktop login approvals (contract §5.5) */}
            <LoginApprovalBanner />
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
            {/* iter-213: "Archived" row — shown only when there's at least
                one archived chat (matches the web app). Sits directly
                below Chat Once. */}
            {archivedCount > 0 ? (
              <TouchableOpacity
                onPress={() => router.push('/archived' as any)}
                style={styles.row}
                activeOpacity={0.7}
                testID="chat-archived"
              >
                <View style={[styles.pinnedIcon, styles.archivedIcon]}>
                  <Feather name="archive" size={22} color={Colors.textSecondary} />
                </View>
                <View style={styles.rowMiddle}>
                  <Text style={styles.rowTitle}>Archived</Text>
                  <Text style={styles.rowSubtitle} numberOfLines={1}>
                    {archivedCount} {archivedCount === 1 ? 'chat' : 'chats'}
                  </Text>
                </View>
              </TouchableOpacity>
            ) : null}
          </>
        }
        renderItem={({ item }) => (
          <SwipeToArchive onArchive={() => handleArchive(item._id)}>
            <ConversationRow
              item={item}
              currentUserId={me?._id}
              contacts={contacts}
              onPress={() => router.push(`/chat/${item._id}` as any)}
            />
          </SwipeToArchive>
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <View style={styles.emptyIconWrap}>
                <Feather name="message-square" size={32} color={Colors.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>No chats yet</Text>
              <Text style={styles.emptySub}>Go to Contacts to start a new conversation</Text>
            </View>
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
      <FabStack
        onPencil={() => router.push('/(tabs)/contacts')}
        onBuilding={() => router.push('/community-create' as any)}
        onBroadcast={() => router.push('/broadcast-create' as any)}
        onPeople={() => router.push('/groups-create' as any)}
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

function ConversationRow({ item, currentUserId, contacts, onPress }: { item: any; currentUserId?: string; contacts?: any[]; onPress: () => void }) {
  // iter-176: Device address-book name beats both the saved-contact name
  // AND the Smilers display name. e.g. if your phone has the other user
  // saved as "ABC Albania", you'll see "ABC Albania" here instead of the
  // user's Google account name "Smilers".
  const deviceIndex = useDeviceContactIndex();
  const deviceName = getResolvedConversationDisplayName(item, currentUserId, deviceIndex, lookupDeviceContactName, '');
  const savedContactName = deviceName || findSavedContactDisplayName(contacts, item, currentUserId);
  const name = savedContactName || getConversationDisplayName(item, currentUserId, 'Smilers user');
  // iter-140b: resolve the photo URL from the same sources the web app
  // uses. Order of precedence:
  //  1. Conversation-level avatar (group photo or pre-computed
  //     other-participant photo from `api.conversations.list`).
  //  2. Other-participant's profilePicture / avatar (DM only).
  //  3. The saved-contact photo from the user's contacts list.
  const otherUserPhoto =
    item?.avatar ||
    item?.avatarUrl ||
    item?.photo ||
    item?.profilePicture ||
    item?.otherUser?.profilePicture ||
    item?.otherUser?.avatar ||
    item?.otherParticipant?.profilePicture ||
    item?.otherParticipant?.avatar;
  const contactRecord = (contacts || []).find((c: any) => {
    const ids = [c?.userId, c?.user?._id, c?._id, c?.contactUserId].filter(Boolean);
    return (
      (item?.otherUserId && ids.includes(item.otherUserId)) ||
      (item?.otherParticipant?._id && ids.includes(item.otherParticipant._id))
    );
  });
  const photoUri: string | undefined =
    otherUserPhoto ||
    contactRecord?.profilePicture ||
    contactRecord?.user?.profilePicture ||
    contactRecord?.avatar ||
    contactRecord?.user?.avatar;
  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.7} testID={`conv-${item._id}`}>
      <Avatar name={name} size={52} uri={photoUri} />
      <View style={styles.rowMiddle}>
        <Text style={styles.rowTitle}>{name}</Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {item.lastMessageText || 'Start chatting…'}
        </Text>
      </View>
      <Text style={styles.rowTime}>{relTime(item.lastMessageTime)}</Text>
    </TouchableOpacity>
  );
}

function SwipeToArchive({ onArchive, children }: { onArchive: () => void; children: React.ReactNode }) {
  const ref = React.useRef<Swipeable>(null);
  const renderRightActions = () => (
    <RectButton
      style={styles.swipeArchiveAction}
      onPress={() => {
        ref.current?.close();
        onArchive();
      }}
    >
      <Feather name="archive" size={22} color={Colors.white} />
      <Text style={styles.swipeArchiveText}>Archive</Text>
    </RectButton>
  );
  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={48}
      overshootRight={false}
      renderRightActions={renderRightActions}
      // iter-216: match the web app — a full left-swipe auto-archives,
      // no tap needed (the action button was also getting hidden behind
      // the floating quick-action buttons on the right edge).
      onSwipeableOpen={(direction) => {
        if (direction === 'right') {
          ref.current?.close();
          onArchive();
        }
      }}
    >
      {children}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { paddingBottom: 180 },
  archivedIcon: {
    backgroundColor: Colors.borderLight,
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
  rowTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  rowSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  rowTime: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginLeft: Spacing.sm,
  },
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
