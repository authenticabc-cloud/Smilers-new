import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

function getGroupId(item: any): string | null {
  const value = item?._id || item?.id || item?.conversationId;
  return value ? String(value) : null;
}

export default function ConferenceCreateScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const { data: groups } = useSafeConvexQuery<any[]>(api.conversations.listGroups, {}, []);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = Array.isArray(groups) ? groups : [];
    if (!q) return list;
    return list.filter((item: any) => `${item?.name || ''} ${item?.description || ''}`.toLowerCase().includes(q));
  }, [groups, search]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="conference-create-screen">
      <Header title="New Conference" showBack onBack={() => router.back()} variant="dark" subtitle="Choose a group and start a conference call" />

      <View style={styles.searchWrap} testID="conference-create-search-wrap">
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search groups"
          placeholderTextColor={Colors.textMuted}
          style={styles.searchInput}
          testID="conference-create-search-input"
        />
      </View>

      <FlatList
        data={filteredGroups}
        keyExtractor={(item: any, index) => getGroupId(item) || `group-${index}`}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          const groupId = getGroupId(item);
          const memberCount = item?.memberCount || item?.members?.length || 0;
          return (
            <TouchableOpacity
              style={styles.groupRow}
              activeOpacity={0.8}
              disabled={!groupId}
              onPress={() => (groupId ? router.replace(`/call/${groupId}?type=video` as any) : undefined)}
              testID={`conference-create-group-${groupId || 'unknown'}`}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(item?.name || 'G').charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.groupTextWrap}>
                <Text style={styles.groupName}>{item?.name || 'Group'}</Text>
                <Text style={styles.groupSub} numberOfLines={1}>
                  {memberCount > 0 ? `${memberCount} member${memberCount === 1 ? '' : 's'}` : 'Tap to start a conference'}
                </Text>
              </View>
              <Ionicons name="videocam-outline" size={22} color={Colors.primary} />
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyState} testID="conference-create-empty-state">
            <Ionicons name="videocam-outline" size={38} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No groups available</Text>
            <Text style={styles.emptySub}>Create a group first, then start a conference from it.</Text>
            <TouchableOpacity
              style={styles.ctaButton}
              onPress={() => router.push('/groups-create' as any)}
              testID="conference-create-new-group-button"
            >
              <Text style={styles.ctaButtonText}>Create Group</Text>
            </TouchableOpacity>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  searchWrap: {
    padding: Spacing.base,
    paddingBottom: 0,
  },
  searchInput: {
    minHeight: 46,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  listContent: {
    padding: Spacing.base,
    paddingBottom: 120,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
  },
  avatarText: {
    color: Colors.primary,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  groupTextWrap: { flex: 1 },
  groupName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  groupSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: Spacing.xxl,
    gap: Spacing.sm,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  emptySub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  ctaButton: {
    marginTop: Spacing.md,
    minHeight: 48,
    paddingHorizontal: Spacing.xl,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
  },
  ctaButtonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
});