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
import { useAuth, type SessionHealth, type StoredValueInfo } from '../src/providers/AuthProvider';
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

// iter-316: human-friendly "how long ago" for the Session health card.
const fmtRelative = (ts: number | null): string => {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) {
    // future (e.g. token expiry) → "in Xm"
    const ahead = Math.abs(diff);
    if (ahead < 60_000) return `in ${Math.round(ahead / 1000)}s`;
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)}m`;
    return `in ${Math.round(ahead / 3_600_000)}h`;
  }
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
};

// A backend is "safe" for persistence if the token survives an app relaunch.
const isSafeBackend = (b: StoredValueInfo['backend']): boolean =>
  b === 'securestore' || b === 'securestore-chunked' || b === 'securestore-legacy' || b === 'localStorage';

const backendLabel = (info: StoredValueInfo): string => {
  switch (info.backend) {
    case 'securestore':
      return 'SecureStore';
    case 'securestore-chunked':
      return `SecureStore (chunked ×${info.chunks ?? '?'})`;
    case 'securestore-legacy':
      return 'SecureStore (legacy)';
    case 'asyncstorage-fallback':
      return 'AsyncStorage (fallback)';
    case 'localStorage':
      return 'localStorage (web)';
    default:
      return 'not stored';
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
  const { getSessionHealth } = useAuth();
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [health, setHealth] = useState<SessionHealth | null>(null);
  const [filter, setFilter] = useState<FilterKey>('calls');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const stored = await getStoredDiagnostics();
    // newest first
    setEvents([...stored].reverse());
    try {
      setHealth(await getSessionHealth());
    } catch {
      setHealth(null);
    }
    setLoading(false);
  }, [getSessionHealth]);

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

      {health ? (
        <View
          style={[
            styles.healthCard,
            health.refreshToken.backend === 'asyncstorage-fallback' && styles.healthCardWarn,
          ]}
          testID="session-health-card"
        >
          <View style={styles.healthTitleRow}>
            <Feather
              name="shield"
              size={15}
              color={health.authenticated && !health.sessionExpired ? Colors.success : Colors.danger}
            />
            <Text style={styles.healthTitle}>Session health</Text>
            <View style={styles.flexOne} />
            <View
              style={[
                styles.healthStatusPill,
                {
                  backgroundColor: health.sessionExpired
                    ? `${Colors.danger}22`
                    : health.authenticated
                      ? `${Colors.success}22`
                      : `${Colors.textSecondary}22`,
                },
              ]}
            >
              <Text
                style={[
                  styles.healthStatusText,
                  { color: health.sessionExpired ? Colors.danger : health.authenticated ? Colors.success : Colors.textSecondary },
                ]}
              >
                {health.sessionExpired ? 'Expired' : health.authenticated ? 'Signed in' : 'Signed out'}
              </Text>
            </View>
          </View>

          <View style={styles.healthLine}>
            <Text style={styles.healthLabel}>Last token refresh</Text>
            <Text style={styles.healthValue}>{fmtRelative(health.lastRefreshAt)}</Text>
          </View>
          <View style={styles.healthLine}>
            <Text style={styles.healthLabel}>Access token expires</Text>
            <Text style={styles.healthValue}>{fmtRelative(health.tokenExpiry)}</Text>
          </View>
          <View style={styles.healthLine}>
            <Text style={styles.healthLabel}>Refresh token storage</Text>
            <Text
              style={[
                styles.healthValue,
                !isSafeBackend(health.refreshToken.backend) && styles.healthValueWarn,
              ]}
            >
              {backendLabel(health.refreshToken)}
              {health.refreshToken.chars > 0 ? ` · ${health.refreshToken.chars}c` : ''}
            </Text>
          </View>
          <View style={styles.healthLine}>
            <Text style={styles.healthLabel}>ID token storage</Text>
            <Text style={styles.healthValue}>
              {backendLabel(health.idToken)}
              {health.idToken.chars > 0 ? ` · ${health.idToken.chars}c` : ''}
            </Text>
          </View>
          {health.lastRefreshError ? (
            <View style={styles.healthLine}>
              <Text style={styles.healthLabel}>Last refresh error</Text>
              <Text style={[styles.healthValue, styles.healthValueWarn]} numberOfLines={1}>
                {health.lastRefreshError}
              </Text>
            </View>
          ) : null}
          {health.refreshToken.backend === 'asyncstorage-fallback' ? (
            <Text style={styles.healthNote}>
              ⚠️ Refresh token stored via AsyncStorage fallback (SecureStore rejected it). Session
              is preserved but less encrypted — report this if you see it.
            </Text>
          ) : health.refreshToken.backend === 'securestore-chunked' ? (
            <Text style={styles.healthNoteOk}>
              ✓ Large token safely chunked into SecureStore — survives relaunch (this is the
              iter-316 fix in action).
            </Text>
          ) : null}
        </View>
      ) : null}

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
  healthCard: {
    marginHorizontal: Spacing.base,
    marginTop: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  healthCardWarn: { borderColor: Colors.danger, borderWidth: 1 },
  healthTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  healthTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  healthStatusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.sm },
  healthStatusText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  healthLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 3 },
  healthLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, flexShrink: 0, marginRight: 12 },
  healthValue: {
    fontSize: FontSize.xs,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
    flexShrink: 1,
    textAlign: 'right',
  },
  healthValueWarn: { color: Colors.danger },
  healthNote: { marginTop: 8, fontSize: FontSize.xs, color: Colors.danger, lineHeight: 17 },
  healthNoteOk: { marginTop: 8, fontSize: FontSize.xs, color: Colors.success, lineHeight: 17 },
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
