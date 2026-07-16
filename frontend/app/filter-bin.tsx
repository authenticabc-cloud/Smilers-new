import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import FilterIndicator, { FILTER_BLACK } from '../src/components/FilterIndicator';
import { api } from '../src/convexApi';
import { useReactiveSafeConvexQuery } from '../src/hooks/useReactiveSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

function relativeTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export default function FilterBinScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  const { data: bin, loading } = useReactiveSafeConvexQuery<any[]>(
    (api as any).filtering?.getFilterBin,
    {},
    [],
    isAuthenticated,
  );

  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const markCallNoticesRead = useMutation((api as any).filtering?.markCallNoticesRead);
  const unfilterUser = useMutation((api as any).filtering?.unfilterUser);

  const openChat = useCallback(
    async (item: any) => {
      const otherUserId = String(item?.userId || '');
      if (!otherUserId) return;
      // Clear this person's blocked-call notices when you view them.
      if (typeof markCallNoticesRead === 'function') {
        markCallNoticesRead({ otherUserId }).catch(() => {});
      }
      let conversationId = item?.conversationId;
      if (!conversationId) {
        try {
          conversationId = await getOrCreateDirect({ otherUserId });
        } catch {
          Alert.alert('Unable to open chat', 'Please try again.');
          return;
        }
      }
      router.push(`/chat/${conversationId}` as any);
    },
    [getOrCreateDirect, markCallNoticesRead, router],
  );

  const confirmUnfilter = useCallback(
    (item: any) => {
      const otherUserId = String(item?.userId || '');
      if (!otherUserId) return;
      Alert.alert(
        `Unfilter ${item?.name || 'user'}?`,
        'Their messages and calls will return to your normal chats.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Unfilter',
            onPress: () => {
              if (typeof unfilterUser === 'function') {
                unfilterUser({ filteredId: otherUserId }).catch((e: any) =>
                  Alert.alert('Unfilter failed', String(e?.message || e)),
                );
              }
            },
          },
        ],
      );
    },
    [unfilterUser],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="filter-bin-screen">
      <Header title="Filter Bin" showBack onBack={() => router.back()} variant="dark" />
      <FlatList
        data={Array.isArray(bin) ? bin : []}
        keyExtractor={(item: any, i) => String(item?.filterEntryId || item?.userId || i)}
        contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
        ListHeaderComponent={
          <Text style={styles.caption}>
            Messages from filtered people land here. You can still chat and call them normally.
          </Text>
        }
        renderItem={({ item }) => {
          const initial = (item?.name || '?').charAt(0).toUpperCase();
          const unread = Number(item?.unreadCount) || 0;
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => openChat(item)}
              onLongPress={() => confirmUnfilter(item)}
              delayLongPress={300}
              testID={`filter-bin-row-${item?.userId}`}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initial}</Text>
                {item?.isOnline ? <View style={styles.onlineDot} /> : null}
              </View>
              <View style={styles.mid}>
                <View style={styles.nameLine}>
                  <FilterIndicator iFilteredThem theyFilteredMe={false} size={14} style={styles.pinIndicator} />
                  <Text style={styles.name} numberOfLines={1}>{item?.name || 'User'}</Text>
                </View>
                <Text style={styles.sub} numberOfLines={1}>
                  {item?.lastMessageText || 'No messages yet'}
                </Text>
              </View>
              <View style={styles.right}>
                {item?.lastMessageTime ? (
                  <Text style={styles.time}>{relativeTime(item.lastMessageTime)}</Text>
                ) : null}
                {unread > 0 ? (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadText}>{unread > 99 ? '99+' : unread}</Text>
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          loading ? (
            <View style={styles.center} testID="filter-bin-loading">
              <ActivityIndicator size="large" color={Colors.primary} />
            </View>
          ) : (
            <View style={styles.center} testID="filter-bin-empty">
              <Ionicons name="funnel-outline" size={48} color={FILTER_BLACK} />
              <Text style={styles.emptyTitle}>Filter bin is empty</Text>
              <Text style={styles.emptySub}>
                Filter someone from their profile to route their messages here without blocking them.
              </Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  caption: { fontSize: FontSize.sm, color: Colors.textSecondary, padding: Spacing.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80, gap: 10, paddingHorizontal: 32 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    gap: 12,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.primary },
  onlineDot: {
    position: 'absolute',
    right: 0,
    bottom: 2,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: '#22C55E',
    borderWidth: 2,
    borderColor: Colors.background,
  },
  mid: { flex: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center' },
  pinIndicator: { marginRight: 5 },
  name: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  right: { alignItems: 'flex-end', gap: 6 },
  time: { fontSize: FontSize.xs, color: Colors.textMuted },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: { color: '#fff', fontSize: FontSize.xs, fontWeight: FontWeight.bold },
});
