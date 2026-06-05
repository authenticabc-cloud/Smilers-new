import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import Avatar from '../src/components/Avatar';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../src/theme';

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

export default function ArchivedScreen() {
  const router = useRouter();
  // iter-115: switched from raw useQuery to useSafeConvexQuery. The raw
  // hook throws a SYNCHRONOUS error during render when the backend
  // endpoint is missing (CouldNotFindFunction), which crashed the entire
  // app ("Smilers has stopped") the moment the user tapped Archived
  // Chats. The safe variant degrades to an empty list + empty-state UI
  // when the backend doesn't expose `conversations.listArchived` yet.
  //
  // Also probe two endpoint name variants so a backend rename doesn't
  // dead-end us:
  //   1. `conversations.listArchived`  (preferred / mobile-spec)
  //   2. `conversations.getArchived`   (web-app legacy name)
  const primaryArchived = useSafeConvexQuery<any[] | null>(
    (api as any).conversations?.listArchived,
    {},
    null,
    true,
  );
  const legacyArchived = useSafeConvexQuery<any[] | null>(
    (api as any).conversations?.getArchived,
    {},
    null,
    primaryArchived.data === null,
  );

  const archived = primaryArchived.data ?? legacyArchived.data;
  const loading = primaryArchived.loading && legacyArchived.loading;
  const list: any[] = Array.isArray(archived) ? archived : [];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Archived Chats</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <Text style={styles.muted}>Loading…</Text>
        </View>
      ) : list.length === 0 ? (
        <View style={styles.center}>
          <View style={styles.iconCircle}>
            <Feather name="archive" size={40} color={Colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>No archived chats</Text>
          <Text style={styles.emptySubtitle}>
            Long-press a chat from your Chats list and choose Archive to hide it here. Archived chats stay encrypted and accessible.
          </Text>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(item: any) => String(item._id ?? Math.random())}
          contentContainerStyle={{ paddingVertical: Spacing.sm }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() => router.push(`/chat/${item._id}` as any)}
            >
              <Avatar name={item.name || item.otherUserName || '?'} size={48} />
              <View style={styles.rowText}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name || item.otherUserName || 'Chat'}
                </Text>
                <Text style={styles.rowSubtitle} numberOfLines={1}>
                  {item.lastMessageText || 'No messages yet'}
                </Text>
              </View>
              <Text style={styles.rowTime}>{relTime(item.lastMessageTime)}</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  backBtn: { width: 24 },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: 12 },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptySubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.lg,
    lineHeight: 20,
  },
  muted: { color: Colors.textSecondary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  rowText: { flex: 1 },
  rowName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  rowTime: { fontSize: FontSize.xs, color: Colors.textMuted },
});
