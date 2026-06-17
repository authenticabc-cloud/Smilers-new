/**
 * Call Diagnostics — on-device viewer for the last call/push diagnostic
 * events recorded via `recordDiagnostic` (AsyncStorage ring buffer). Lets the
 * user (or support) see exactly what happened during the most recent call —
 * [TWILIO-CALL] room/auto-end events, [WAKE] notifee ring events, push/FCM
 * delivery — without digging through server logs. Includes Refresh, Copy
 * (to clipboard) and Clear.
 *
 * Route: /call-diagnostics
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import {
  getStoredDiagnostics,
  clearStoredDiagnostics,
  type DiagnosticEvent,
} from '../src/lib/diagnostics';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../src/theme';

type FilterKey = 'calls' | 'push' | 'all';

const FILTERS: { key: FilterKey; label: string; keywords: string[] }[] = [
  { key: 'calls', label: 'Calls', keywords: ['twilio', 'call', 'wake', 'ring', 'audio', 'pc', 'sig'] },
  { key: 'push', label: 'Push', keywords: ['push', 'fcm', 'notifee', 'notify', 'channel', 'token'] },
  { key: 'all', label: 'All', keywords: [] },
];

const matchesFilter = (e: DiagnosticEvent, keywords: string[]): boolean => {
  if (keywords.length === 0) return true;
  const blob = `${e.tag} ${e.source || ''} ${e.message}`.toLowerCase();
  return keywords.some((k) => blob.includes(k));
};

const fmtTime = (ts: number): string => {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
};

const fmtDate = (ts: number): string => {
  try {
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
};

const tagColor = (tag: string): string => {
  const t = tag.toLowerCase();
  if (t.includes('twilio') || t.includes('call')) return Colors.primary;
  if (t.includes('wake') || t.includes('notifee')) return Colors.success;
  if (t.includes('err') || t.includes('fail')) return Colors.danger;
  return Colors.textSecondary;
};

export default function CallDiagnosticsScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [filter, setFilter] = useState<FilterKey>('calls');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const stored = await getStoredDiagnostics();
    // newest first
    setEvents([...stored].reverse());
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const activeKeywords = FILTERS.find((f) => f.key === filter)?.keywords || [];
  const visible = events.filter((e) => matchesFilter(e, activeKeywords));

  const onCopy = useCallback(async () => {
    const text = visible
      .map((e) => `${fmtDate(e.ts)} ${fmtTime(e.ts)} [${e.tag}]${e.source ? ` (${e.source})` : ''} ${e.message}`)
      .join('\n');
    await Clipboard.setStringAsync(text || 'No events');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [visible]);

  const onClear = useCallback(async () => {
    await clearStoredDiagnostics();
    setEvents([]);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: DiagnosticEvent }) => (
      <View style={styles.row} testID={`diag-row-${item.ts}`}>
        <View style={styles.rowHeader}>
          <View style={[styles.tagPill, { backgroundColor: `${tagColor(item.tag)}22` }]}>
            <Text style={[styles.tagText, { color: tagColor(item.tag) }]} numberOfLines={1}>
              {item.tag || 'log'}
            </Text>
          </View>
          {item.source ? (
            <Text style={styles.source} numberOfLines={1}>
              {item.source}
            </Text>
          ) : null}
          <Text style={styles.time}>{fmtTime(item.ts)}</Text>
        </View>
        <Text style={styles.message}>{item.message}</Text>
      </View>
    ),
    [],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn} testID="diag-back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Call Diagnostics</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={load} hitSlop={10} style={styles.iconBtn} testID="diag-refresh">
            <Feather name="refresh-cw" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onCopy} hitSlop={10} style={styles.iconBtn} testID="diag-copy">
            <Feather name={copied ? 'check' : 'copy'} size={18} color={copied ? Colors.success : Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => setFilter(f.key)}
              testID={`diag-filter-${f.key}`}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
        <View style={styles.flexOne} />
        <TouchableOpacity onPress={onClear} style={styles.clearBtn} testID="diag-clear">
          <Feather name="trash-2" size={14} color={Colors.danger} />
          <Text style={styles.clearText}>Clear</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.center}>
          <Feather name="activity" size={36} color={Colors.border} />
          <Text style={styles.emptyTitle}>No events yet</Text>
          <Text style={styles.emptyBody}>
            Make or receive a call, then come back here to see the ring, answer/decline and
            auto-drop events.
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(e, i) => `${e.ts}-${i}`}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={styles.count}>
              {visible.length} event{visible.length === 1 ? '' : 's'} (newest first)
            </Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flexOne: { flex: 1 },
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
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: { padding: 6 },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  filterChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textSecondary },
  filterTextActive: { color: Colors.headerBg, fontWeight: FontWeight.bold },
  clearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
  clearText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: Colors.danger },
  list: { paddingHorizontal: Spacing.base, paddingBottom: 32 },
  count: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 8 },
  row: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: 12,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 },
  tagPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.sm, maxWidth: 140 },
  tagText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  source: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary },
  time: { fontSize: FontSize.xs, color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
  message: { fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 19 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
});
