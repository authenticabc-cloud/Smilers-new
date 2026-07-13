/**
 * Broadcast history — device-local audit log of announcements the admin has
 * sent as "Smilers" from this device. Shows message text, recipient/sent/failed
 * counts and when it was sent. Read-only + Clear.
 *
 * Route: /broadcast-history
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import {
  getBroadcastHistory,
  clearBroadcastHistory,
  type BroadcastLogEntry,
} from '../src/lib/broadcastHistory';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const fmtWhen = (ts: number): string => {
  try {
    const d = new Date(ts);
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    return '';
  }
};

export default function BroadcastHistoryScreen() {
  const router = useRouter();
  const [items, setItems] = useState<BroadcastLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setItems(await getBroadcastHistory());
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onClear = useCallback(() => {
    Alert.alert('Clear history?', 'This removes the local record of past broadcasts on this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearBroadcastHistory();
          setItems([]);
        },
      },
    ]);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: BroadcastLogEntry }) => (
      <View style={styles.card} testID={`bh-row-${item.id}`}>
        <View style={styles.cardHeader}>
          <Text style={styles.when}>{fmtWhen(item.ts)}</Text>
          <View style={styles.statsRow}>
            <View style={[styles.statPill, styles.sentPill]}>
              <Feather name="check" size={12} color="#166534" />
              <Text style={[styles.statText, { color: '#166534' }]}>{item.sent}</Text>
            </View>
            {item.failed > 0 ? (
              <View style={[styles.statPill, styles.failPill]}>
                <Feather name="x" size={12} color={Colors.danger} />
                <Text style={[styles.statText, { color: Colors.danger }]}>{item.failed}</Text>
              </View>
            ) : null}
            <Text style={styles.totalText}>of {item.total}</Text>
          </View>
        </View>
        <Text style={styles.message}>{item.text}</Text>
      </View>
    ),
    [],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn} testID="bh-back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Broadcast history</Text>
        <TouchableOpacity onPress={onClear} hitSlop={10} style={styles.clearBtn} testID="bh-clear" disabled={items.length === 0}>
          <Feather name="trash-2" size={16} color={items.length === 0 ? Colors.textMuted : Colors.danger} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="radio" size={36} color={Colors.border} />
          <Text style={styles.emptyTitle}>No broadcasts yet</Text>
          <Text style={styles.emptyBody}>
            Announcements you send as “Smilers” from this device will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(e) => e.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={styles.note}>Recorded on this device only</Text>
          }
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
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  backBtn: { width: 32 },
  headerTitle: { flex: 1, fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  clearBtn: { padding: 6 },
  list: { paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm, paddingBottom: 32 },
  note: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 8 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: 12,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  when: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: FontWeight.medium },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statPill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: Radius.sm },
  sentPill: { backgroundColor: '#DCFCE7' },
  failPill: { backgroundColor: `${Colors.danger}18` },
  statText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  totalText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  message: { fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 19 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
});
