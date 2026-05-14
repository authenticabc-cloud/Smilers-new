import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import FabStack from '../../src/components/FabStack';
import SosButton from '../../src/components/SosButton';
import { api } from '../../src/convexApi';
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
  const conversations = useQuery(api.conversations.listConversations);
  const loading = conversations === undefined;
  const list: any[] = Array.isArray(conversations) ? conversations : [];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="chats-screen">
      <Header
        title="Smilers"
        variant="light"
        right={
          <>
            <TouchableOpacity onPress={() => router.push('/search' as any)} testID="search-btn">
              <Ionicons name="search-outline" size={22} color={Colors.textPrimary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/settings')} testID="menu-btn">
              <Feather name="more-vertical" size={22} color={Colors.textPrimary} />
            </TouchableOpacity>
          </>
        }
      />

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
        onBuilding={() => {}}
        onBroadcast={() => {}}
        onPeople={() => router.push('/(tabs)/groups')}
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

function ConversationRow({ item, onPress }: { item: any; onPress: () => void }) {
  const name = item.name || item.otherUserName || 'Smilers User';
  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.7} testID={`conv-${item._id}`}>
      <Avatar name={name} size={52} />
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
