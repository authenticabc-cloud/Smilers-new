import React from 'react';
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

export default function BlockedScreen() {
  const router = useRouter();
  const { data: blocked, refetch } = useSafeConvexQuery<any[]>(api.blocking.getBlockedUsers, {}, []);
  const unblock = useMutation(api.blocking.unblockUser);

  const onUnblock = (user: any) => {
    Alert.alert(`Unblock ${user.name || 'this user'}?`, 'They will be able to message and call you again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unblock',
        onPress: async () => {
          try {
            await unblock({ userId: user._id });
            await refetch();
          } catch (errorValue: any) {
            Alert.alert('Failed', errorValue?.message);
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="blocked-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="blocked-back-button">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} testID="blocked-header-title">
          Blocked Users
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <FlatList
        data={blocked}
        keyExtractor={(item: any) => item._id}
        contentContainerStyle={styles.content}
        testID="blocked-list"
        renderItem={({ item, index }: any) => (
          <View style={styles.row} testID={`blocked-row-${index}`}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(item.name || '?').charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.flexOne}>
              <Text style={styles.rowTitle} testID={`blocked-name-${index}`}>
                {item.name || 'User'}
              </Text>
              <Text style={styles.rowSub} testID={`blocked-contact-${index}`}>
                {item.phone || item.email || '—'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.unblockBtn}
              onPress={() => onUnblock(item)}
              testID={`blocked-unblock-button-${index}`}
            >
              <Text style={styles.unblockText}>Unblock</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty} testID="blocked-empty-state">
            <Ionicons name="shield-checkmark-outline" size={64} color={Colors.primary} />
            <Text style={styles.emptyTitle}>No one is blocked</Text>
            <Text style={styles.emptySub}>When you block someone, they'll appear here.</Text>
          </View>
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
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000022',
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  headerSpacer: { width: 26 },
  content: { padding: Spacing.base, flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000011',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  unblockBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    minHeight: 44,
    justifyContent: 'center',
  },
  unblockText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  empty: { alignItems: 'center', padding: Spacing.xl, gap: 8, marginTop: 60 },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginTop: 12,
  },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  flexOne: { flex: 1 },
});