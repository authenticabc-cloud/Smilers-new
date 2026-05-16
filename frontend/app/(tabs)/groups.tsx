import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

type Tab = 'groups' | 'conferences';

function formatRelativeDays(ts?: number): string {
  if (!ts) return '—';
  const diffMs = Date.now() - ts;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) {
    const hours = Math.floor(diffMs / 3_600_000);
    if (hours < 1) return 'now';
    return `${hours}h`;
  }
  if (days === 1) return '1 day';
  return `${days} days`;
}

function getListItemId(item: any): string | null {
  const value = item?._id || item?.id || item?.conversationId || item?.conferenceId;
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

export default function GroupsScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('groups');
  const [search, setSearch] = useState('');

  const { data: groups, loading: groupsLoading } = useSafeConvexQuery<any[]>(
    api.conversations.listGroups,
    {},
    [],
    true,
  );

  const conferenceCandidates = useMemo(() => {
    const raw = Array.isArray(groups) ? groups : [];
    return raw.filter((item: any) => (item?.type || 'group') === 'group');
  }, [groups]);

  const activeLoading = groupsLoading;

  const list = useMemo(() => {
    const raw: any[] = tab === 'groups'
      ? (Array.isArray(groups) ? groups : [])
      : conferenceCandidates;
    const q = search.trim().toLowerCase();
    if (!q) return raw;
    return raw.filter((g: any) =>
      `${g.name || ''} ${g.description || ''} ${g.lastMessageText || ''}`.toLowerCase().includes(q),
    );
  }, [conferenceCandidates, groups, search, tab]);

  const onAdd = () => {
    if (tab === 'groups') {
      router.push('/groups-create' as any);
      return;
    }
    router.push('/conference-create' as any);
  };

  const openItem = (item: any) => {
    const itemId = getListItemId(item);
    if (!itemId) {
      return;
    }
    if (tab === 'conferences') {
      router.push(`/call/${itemId}` as any);
      return;
    }
    router.push(`/chat/${itemId}` as any);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="groups-screen">
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{tab === 'groups' ? 'Groups' : 'Conferences'}</Text>
        <TouchableOpacity hitSlop={10} onPress={onAdd} testID="groups-add-btn" style={styles.headerBtn}>
          <Feather name="plus" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setTab('groups')}
          activeOpacity={0.7}
          testID="groups-tab-groups"
        >
          <View style={styles.tabLabelRow}>
            <Ionicons
              name="people-outline"
              size={18}
              color={tab === 'groups' ? Colors.primary : Colors.textSecondary}
            />
            <Text style={[styles.tabText, tab === 'groups' ? styles.tabTextActive : null]}>Groups</Text>
          </View>
          {tab === 'groups' ? <View style={styles.tabIndicator} /> : null}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setTab('conferences')}
          activeOpacity={0.7}
          testID="groups-tab-conferences"
        >
          <View style={styles.tabLabelRow}>
            <Ionicons
              name="videocam-outline"
              size={18}
              color={tab === 'conferences' ? Colors.primary : Colors.textSecondary}
            />
            <Text style={[styles.tabText, tab === 'conferences' ? styles.tabTextActive : null]}>Conferences</Text>
          </View>
          {tab === 'conferences' ? <View style={styles.tabIndicator} /> : null}
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchOuter}>
        <View style={styles.searchPill}>
          <Feather name="search" size={18} color={Colors.textMuted} />
          <TextInput
            placeholder={tab === 'groups' ? 'Search groups...' : 'Search conferences...'}
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            testID="groups-search"
          />
        </View>
      </View>

      <FlatList
        data={list}
        keyExtractor={(item: any, index) => getListItemId(item) || `${tab}-fallback-${index}`}
        contentContainerStyle={{ paddingBottom: 120 }}
        renderItem={({ item }) => {
          const memberCount = item.memberCount || item.members?.length || 0;
          const sub =
            tab === 'conferences'
              ? memberCount > 0
                ? `${memberCount} member${memberCount === 1 ? '' : 's'} ready for conference`
                : 'Tap to start a conference'
              : item.lastMessageText ||
                item.description ||
                (memberCount > 0 ? `${memberCount} member${memberCount === 1 ? '' : 's'}` : 'Tap to open');
          const stamp = formatRelativeDays(item.lastMessageAt || item.updatedAt || item._creationTime);
          const initial = (item.name || 'G').charAt(0).toUpperCase();
          const itemId = getListItemId(item);
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => openItem(item)}
              activeOpacity={0.7}
              disabled={!itemId}
              testID={`group-${itemId || 'unknown'}`}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initial}</Text>
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name || 'Group'}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {sub}
                </Text>
              </View>
              <View style={styles.rowRight}>
                <Text style={styles.rowStamp}>{stamp}</Text>
                {memberCount > 0 ? (
                  <View style={styles.memberCount}>
                    <Ionicons name="people-outline" size={14} color={Colors.textSecondary} />
                    <Text style={styles.memberCountText}>{memberCount}</Text>
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          activeLoading ? (
            <View style={styles.loadingState} testID="groups-loading-state">
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.loadingText}>Loading {tab === 'groups' ? 'groups' : 'conferences'}…</Text>
            </View>
          ) : (
            <View style={styles.empty} testID="groups-empty">
              <Ionicons
                name={tab === 'groups' ? 'people-outline' : 'videocam-outline'}
                size={42}
                color={Colors.textMuted}
              />
              <Text style={styles.emptyTitle}>
                {tab === 'groups' ? 'No groups yet' : 'No conferences yet'}
              </Text>
              <Text style={styles.emptySub}>
                {tab === 'groups'
                  ? 'Create a group to chat with multiple people'
                  : 'Create a group first, then start a conference from it'}
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

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
    backgroundColor: Colors.background,
  },
  headerTitle: {
    fontSize: 32,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },

  tabsRow: {
    flexDirection: 'row',
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tabText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  tabTextActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 3,
    width: 80,
    borderRadius: 2,
    backgroundColor: Colors.primary,
  },

  searchOuter: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
  },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#EDE5D2',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderRadius: Radius.pill,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000012',
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: FontSize.xl },
  rowMid: { flex: 1 },
  rowName: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  rowRight: { alignItems: 'flex-end', gap: 4 },
  rowStamp: { fontSize: FontSize.sm, color: Colors.textSecondary },
  memberCount: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  memberCountText: { fontSize: FontSize.sm, color: Colors.textSecondary },

  empty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl * 2,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: Spacing.sm },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  loadingState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Spacing.xxl * 2,
    gap: Spacing.sm,
  },
  loadingText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
});
