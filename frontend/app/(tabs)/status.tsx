import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import { api } from '../../src/convexApi';
import { Colors, FontSize, FontWeight, Spacing, Shadow } from '../../src/theme';

export default function StatusScreen() {
  const statusGroups = useQuery(api.statuses.listStatusGroups);
  const myStatuses = useQuery(api.statuses.getMyStatuses);

  const others: any[] = Array.isArray(statusGroups) ? statusGroups : [];
  const mine: any[] = Array.isArray(myStatuses) ? myStatuses : [];

  const data = [...others];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="status-screen">
      <Header title="Status" variant="dark" />

      <FlatList
        data={data}
        keyExtractor={(item: any, idx: number) => item.userId || String(idx)}
        contentContainerStyle={{ paddingBottom: 100 }}
        ListHeaderComponent={
          <>
            <TouchableOpacity style={styles.myRow} activeOpacity={0.7} testID="my-status-row">
              <View style={styles.myAvatarWrap}>
                <Avatar name="Me" size={52} />
                <View style={styles.plusBadge}>
                  <Feather name="plus" size={14} color={Colors.white} />
                </View>
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.rowName}>My Status</Text>
                <Text style={styles.rowSub}>
                  {mine.length > 0 ? `${mine.length} active update${mine.length === 1 ? '' : 's'}` : 'Tap to add status update'}
                </Text>
              </View>
            </TouchableOpacity>
            {others.length > 0 && <Text style={styles.section}>RECENT UPDATES</Text>}
          </>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} activeOpacity={0.7}>
            <View style={[styles.statusRing]}>
              <Avatar name={item.name} size={50} />
            </View>
            <View style={styles.rowMid}>
              <Text style={styles.rowName}>{item.name || 'Smilers user'}</Text>
              <Text style={styles.rowSub}>{item.count || 1} update{(item.count || 1) === 1 ? '' : 's'}</Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          statusGroups !== undefined ? (
            <View style={styles.empty}>
              <Ionicons name="disc-outline" size={36} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No updates yet</Text>
              <Text style={styles.emptySub}>Statuses you share will appear here for 24h</Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  myRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  myAvatarWrap: { position: 'relative' },
  plusBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    backgroundColor: Colors.primary,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.background,
  },
  section: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    letterSpacing: 1,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
  },
  statusRing: {
    padding: 2,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: Colors.primary,
  },
  rowMid: { flex: 1 },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  empty: {
    alignItems: 'center',
    paddingTop: Spacing.xxl * 2,
    gap: 6,
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
    paddingHorizontal: Spacing.lg,
    textAlign: 'center',
  },
});
