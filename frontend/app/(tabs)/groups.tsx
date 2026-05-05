import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import { api } from '../../src/convexApi';
import { Colors, FontSize, FontWeight, Spacing, Shadow } from '../../src/theme';

export default function GroupsScreen() {
  const router = useRouter();
  const groups = useQuery(api.conversations.listGroups);
  const list: any[] = Array.isArray(groups) ? groups : [];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="groups-screen">
      <Header title="Groups" variant="dark" />
      <FlatList
        data={list}
        keyExtractor={(item: any) => item._id}
        contentContainerStyle={{ paddingBottom: 100 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => router.push(`/chat/${item._id}` as any)}
            activeOpacity={0.7}
            testID={`group-${item._id}`}
          >
            <Avatar name={item.name} size={48} />
            <View style={styles.mid}>
              <Text style={styles.name}>{item.name || 'Group'}</Text>
              <Text style={styles.sub} numberOfLines={1}>
                {item.lastMessageText || item.description || 'Tap to open'}
              </Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          groups !== undefined ? (
            <View style={styles.empty}>
              <Feather name="users" size={32} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No groups yet</Text>
              <Text style={styles.emptySub}>Create a group to chat with multiple people</Text>
            </View>
          ) : null
        }
      />
      <TouchableOpacity style={styles.fab} activeOpacity={0.85} testID="new-group-fab">
        <Feather name="plus" size={24} color={Colors.white} />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  mid: { flex: 1 },
  name: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  sub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  empty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl * 2,
    gap: Spacing.sm,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
  },
  emptySub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  fab: {
    position: 'absolute',
    bottom: Spacing.base,
    right: Spacing.base,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.md,
  },
});
