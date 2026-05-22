import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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

function formatConferenceDate(ts?: number): string {
  if (!ts) return 'Today';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ts));
  } catch {
    return 'Today';
  }
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
  const [inviteCode, setInviteCode] = useState('');

  const { data: groups, loading: groupsLoading } = useSafeConvexQuery<any[]>(
    api.conversations.listGroups,
    {},
    [],
    true,
  );

  // Conferences come from a dedicated backend list — NOT from filtering the
  // groups list (which only ever contains groups). When the backend hasn't
  // shipped `conferences.listConferences` yet this safely returns [], so the
  // Conferences tab simply shows the empty state instead of falsely listing
  // groups as conferences.
  const { data: conferences, loading: conferencesLoading } = useSafeConvexQuery<any[]>(
    (api as any).conferences.listConferences,
    {},
    [],
    tab === 'conferences',
  );

  const activeLoading = tab === 'conferences' ? conferencesLoading : groupsLoading;

  const list = useMemo(() => {
    const raw: any[] = tab === 'groups'
      ? (Array.isArray(groups) ? groups : [])
      : (Array.isArray(conferences) ? conferences : []);
    const q = search.trim().toLowerCase();
    if (!q) return raw;
    return raw.filter((g: any) =>
      `${g.name || ''} ${g.description || ''} ${g.lastMessageText || ''}`.toLowerCase().includes(q),
    );
  }, [conferences, groups, search, tab]);

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
      router.push(`/call/${itemId}?type=video` as any);
      return;
    }
    router.push(`/chat/${itemId}` as any);
  };

  if (tab === 'conferences') {
    return (
      <SafeAreaView style={styles.conferenceScreen} edges={['top']} testID="conference-screen">
        <View style={styles.conferenceHeader} testID="conference-header">
          <TouchableOpacity
            onPress={() => setTab('groups')}
            style={styles.conferenceHeaderButton}
            testID="conference-back-button"
          >
            <Ionicons name="arrow-back" size={28} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.conferenceHeaderTitle} testID="conference-header-title">Conferences</Text>
          <TouchableOpacity onPress={onAdd} style={styles.conferenceHeaderButton} testID="conference-add-button">
            <Ionicons name="add" size={30} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>

        <View style={styles.conferenceSearchOuter} testID="conference-search-outer">
          <View style={styles.conferenceSearchPill}>
            <Feather name="search" size={18} color={Colors.textMuted} />
            <TextInput
              placeholder="Search conferences..."
              placeholderTextColor="#A29A8E"
              value={search}
              onChangeText={setSearch}
              style={styles.conferenceSearchInput}
              autoCapitalize="none"
              autoCorrect={false}
              testID="conference-search-input"
            />
          </View>
        </View>

        <View style={styles.inviteRow} testID="conference-invite-row">
          <TextInput
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder="ENTER INVITE CODE..."
            placeholderTextColor="#9C9487"
            style={styles.inviteInput}
            autoCapitalize="characters"
            autoCorrect={false}
            testID="conference-invite-input"
          />
          <TouchableOpacity
            style={styles.joinButton}
            onPress={() => Alert.alert('Conference invite codes', 'I’ll wire the join flow when you share the detailed conference instructions.')}
            testID="conference-join-button"
          >
            <Text style={styles.joinButtonText}>Join</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={list}
          keyExtractor={(item: any, index) => getListItemId(item) || `conference-${index}`}
          contentContainerStyle={styles.conferenceListContent}
          renderItem={({ item }) => {
            const itemId = getListItemId(item);
            const memberCount = item?.memberCount || item?.members?.length || 0;
            const badgeText = item?.scheduleLabel || item?.frequency || 'weekly';
            return (
              <TouchableOpacity
                style={styles.conferenceRow}
                activeOpacity={0.82}
                onPress={() => openItem(item)}
                disabled={!itemId}
                testID={`conference-row-${itemId || 'unknown'}`}
              >
                <View style={styles.conferenceIconWrap}>
                  <Ionicons name="videocam" size={24} color={Colors.textPrimary} />
                </View>
                <View style={styles.conferenceInfoWrap}>
                  <Text style={styles.conferenceName} numberOfLines={1}>{(item?.name || 'Conference').toUpperCase()}</Text>
                  <View style={styles.conferenceMetaRow}>
                    <Text style={styles.conferenceMetaText}>{formatConferenceDate(item?.updatedAt || item?._creationTime)}</Text>
                    <View style={styles.conferenceMembersWrap}>
                      <Ionicons name="people-outline" size={14} color={Colors.textSecondary} />
                      <Text style={styles.conferenceMetaText}>{memberCount}</Text>
                    </View>
                  </View>
                </View>
                <View style={styles.conferenceBadge} testID={`conference-badge-${itemId || 'unknown'}`}>
                  <Text style={styles.conferenceBadgeText}>{badgeText}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            activeLoading ? (
              <View style={styles.loadingState} testID="conference-loading-state">
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={styles.loadingText}>Loading conferences…</Text>
              </View>
            ) : (
              <View style={styles.conferenceEmpty} testID="conference-empty-state">
                <Ionicons name="videocam-outline" size={40} color={Colors.textMuted} />
                <Text style={styles.emptyTitle}>No conferences yet</Text>
                <Text style={styles.emptySub}>Tap the + button above to create your first conference.</Text>
              </View>
            )
          }
        />

        <TouchableOpacity style={styles.sosButton} onPress={() => router.push('/emergency' as any)} testID="conference-sos-button">
          <Text style={styles.sosButtonText}>SOS</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

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
                  ? 'Tap + to start a new group conversation'
                  : 'Tap + to create your first conference'}
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
  conferenceScreen: { flex: 1, backgroundColor: '#F7F3EC' },
  conferenceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F0C96C',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 18,
  },
  conferenceHeaderButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  conferenceHeaderTitle: {
    fontSize: 24,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  conferenceSearchOuter: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  conferenceSearchPill: {
    minHeight: 48,
    borderRadius: 28,
    backgroundColor: '#EDE6DA',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  conferenceSearchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
  },
  inviteInput: {
    flex: 1,
    minHeight: 44,
    fontSize: FontSize.base,
    color: '#7E776C',
    letterSpacing: 0.8,
  },
  joinButton: {
    minWidth: 74,
    minHeight: 38,
    borderRadius: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A9D2F3',
  },
  joinButtonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  conferenceListContent: {
    paddingBottom: 120,
  },
  conferenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  conferenceIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 14,
    backgroundColor: '#F4CD75',
    alignItems: 'center',
    justifyContent: 'center',
  },
  conferenceInfoWrap: {
    flex: 1,
  },
  conferenceName: {
    fontSize: 17,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  conferenceMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 5,
  },
  conferenceMetaText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  conferenceMembersWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  conferenceBadge: {
    minHeight: 30,
    paddingHorizontal: 12,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#B8D9F2',
  },
  conferenceBadgeText: {
    fontSize: FontSize.sm,
    color: '#41627C',
    fontWeight: FontWeight.medium,
  },
  conferenceEmpty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl * 2,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
  },
  sosButton: {
    position: 'absolute',
    left: 16,
    bottom: 92,
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E53B30',
  },
  sosButtonText: {
    fontSize: 18,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },

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
