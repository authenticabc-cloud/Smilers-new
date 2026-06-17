import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useConvex, useQuery } from 'convex/react';
import Avatar from '../src/components/Avatar';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import {
  findSavedContactDisplayName,
  getConversationDisplayName,
  getResolvedConversationDisplayName,
} from '../src/lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../src/lib/deviceContactIndex';
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
  const convex = useConvex();
  const me = useQuery(api.users.getCurrentUser, {});
  const contacts = useQuery(api.contacts.getContacts, {}) as any[] | undefined;
  // iter-213: confirmed backend contract — api.archives.listArchived({})
  // returns archived conversations shaped like listConversations. Kept on
  // useSafeConvexQuery so a transient backend hiccup degrades to the empty
  // state instead of crashing the screen.
  const archivedQuery = useSafeConvexQuery<any[] | null>(
    (api as any).archives?.listArchived,
    {},
    null,
    true,
  );
  const loading = archivedQuery.loading;
  const list: any[] = Array.isArray(archivedQuery.data) ? archivedQuery.data : [];

  const handleUnarchive = async (conversationId: string) => {
    try {
      await convex.mutation((api as any).archives.unarchiveConversation, { conversationId });
    } catch (e: any) {
      Alert.alert('Could not unarchive', e?.message || 'Please try again.');
    }
  };

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
            Swipe left on a chat in your Chats list to archive it. Archived chats stay encrypted and accessible here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(item: any) => String(item._id ?? Math.random())}
          contentContainerStyle={{ paddingVertical: Spacing.sm }}
          renderItem={({ item }) => (
            <ArchivedRow
              item={item}
              currentUserId={me?._id}
              contacts={contacts}
              onOpen={() => router.push(`/chat/${item._id}` as any)}
              onUnarchive={() => handleUnarchive(item._id)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ArchivedRow({
  item,
  currentUserId,
  contacts,
  onOpen,
  onUnarchive,
}: {
  item: any;
  currentUserId?: string;
  contacts?: any[];
  onOpen: () => void;
  onUnarchive: () => void;
}) {
  // iter-216: resolve the display name the SAME way the main chats list
  // does (device address book → saved contact → Smilers name), instead of
  // showing the bare "Chat" fallback. Fixes archived rows showing "Chat".
  const deviceIndex = useDeviceContactIndex();
  const deviceName = getResolvedConversationDisplayName(item, currentUserId, deviceIndex, lookupDeviceContactName, '');
  const savedContactName = deviceName || findSavedContactDisplayName(contacts, item, currentUserId);
  const name = savedContactName || getConversationDisplayName(item, currentUserId, 'Smilers user');

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
    <View style={styles.row}>
      <TouchableOpacity style={styles.rowMain} onPress={onOpen} activeOpacity={0.7}>
        <Avatar name={name} size={48} uri={photoUri} />
        <View style={styles.rowText}>
          <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {item.lastMessageText || 'No messages yet'}
          </Text>
        </View>
        <Text style={styles.rowTime}>{relTime(item.lastMessageTime)}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.unarchiveBtn}
        onPress={onUnarchive}
        hitSlop={8}
        testID={`unarchive-${item._id}`}
        accessibilityLabel="Unarchive chat"
      >
        <MaterialCommunityIcons name="archive-arrow-up-outline" size={22} color={Colors.primary} />
      </TouchableOpacity>
    </View>
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
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  unarchiveBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: Spacing.sm,
  },
  rowName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  rowTime: { fontSize: FontSize.xs, color: Colors.textMuted },
});
