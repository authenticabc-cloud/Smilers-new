import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, Modal, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import FabStack from '../../src/components/FabStack';
import SosButton from '../../src/components/SosButton';
import { api } from '../../src/convexApi';
import { findSavedContactDisplayName, getConversationDisplayName } from '../../src/lib/displayName';
import { readCacheMeta, writeCache } from '../../src/lib/offlineCache';
import OfflineBanner from '../../src/components/OfflineBanner';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';

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
  const loading = conversations === undefined && cachedList === null;

  // iter 160 (offline persistence): hydrate the conversation list from
  // AsyncStorage on cold launch so users see their last-known chats
  // even with no internet. Fresh data from Convex overrides the cache
  // the moment it arrives.
  const userKey = me?._id ? String(me._id) : 'anon';
  const [cachedList, setCachedList] = useState<any[] | null>(null);
  const [cachedTs, setCachedTs] = useState<number | undefined>(undefined);
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

  // Prefer live data; fall back to cache while loading.
  const liveList: any[] | null = Array.isArray(conversations) ? conversations : null;
  const list: any[] = liveList ?? cachedList ?? [];
  const showOfflineBanner = !liveList && Array.isArray(cachedList) && cachedList.length > 0;

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
        data={list}
        keyExtractor={(item: any) => item._id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
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
          </>
        }
        renderItem={({ item }) => (
          <ConversationRow
            item={item}
            currentUserId={me?._id}
            contacts={contacts}
            onPress={() => router.push(`/chat/${item._id}` as any)}
          />
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
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => {}} tintColor={Colors.primary} />}
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
  const savedContactName = findSavedContactDisplayName(contacts, item, currentUserId);
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { paddingBottom: 180 },
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
