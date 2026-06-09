/**
 * Calls — global call history list (per Smilers web parity).
 *
 * Backed by canonical Convex contract (confirmed iter 155):
 *   - api.calls.listMyCallHistory({})
 *     → [{ _id, _creationTime, conversationId, callerId, callType:'voice'|'video',
 *          outcome:'completed'|'missed'|'declined', startedAt, endedAt?, durationSeconds?,
 *          isConference?, wasRecorded?, direction:'incoming'|'outgoing',
 *          otherName, otherAvatar?, otherUserId?, isGroup }]
 *
 * Tapping a row → open the conversation chat.
 * Tapping the trailing phone/video icon → call back (api.calls.initiateCall via /call/[id]).
 */

import React, { useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { getDisplayInitials } from '../src/lib/displayName';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type Outcome = 'completed' | 'missed' | 'declined';
type CallType = 'voice' | 'video';
type Direction = 'incoming' | 'outgoing';

interface CallHistoryEntry {
  _id: string;
  _creationTime: number;
  conversationId: string;
  callerId: string;
  callType: CallType;
  outcome: Outcome;
  startedAt?: number;
  endedAt?: number;
  durationSeconds?: number;
  isConference?: boolean;
  wasRecorded?: boolean;
  direction: Direction;
  otherName?: string;
  otherAvatar?: string | null;
  otherUserId?: string;
  isGroup?: boolean;
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function formatRelativeTime(ts?: number): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yest.toDateString();
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return t;
    if (isYesterday) return `Yesterday, ${t}`;
    // Older than yesterday — show e.g. "Jun 7, 10:35 PM"
    const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${datePart}, ${t}`;
  } catch {
    return '';
  }
}

function getOutcomeLabel(entry: CallHistoryEntry): string {
  if (entry.outcome === 'missed') return 'Missed';
  if (entry.outcome === 'declined') return 'Declined';
  if (entry.outcome === 'completed') {
    const dur = formatDuration(entry.durationSeconds);
    if (entry.direction === 'outgoing') return dur ? `Outgoing \u00B7 ${dur}` : 'Outgoing';
    return dur ? `Incoming \u00B7 ${dur}` : 'Incoming';
  }
  // Treat anything unknown as 'No answer' for safety
  return 'No answer';
}

function isNegativeOutcome(entry: CallHistoryEntry): boolean {
  return entry.outcome === 'missed' || entry.outcome === 'declined';
}

function getOutcomeIcon(entry: CallHistoryEntry): { name: any; color: string } {
  if (entry.outcome === 'missed' || entry.outcome === 'declined') {
    return { name: 'phone-missed', color: '#EF4444' };
  }
  if (entry.direction === 'outgoing') return { name: 'phone-outgoing', color: '#10B981' };
  return { name: 'phone-incoming', color: '#10B981' };
}

export default function CallsScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  const { data: history, loading, error } = useSafeConvexQuery<CallHistoryEntry[]>(
    (api as any).calls.listMyCallHistory,
    {},
    [],
    !!isAuthenticated,
  );

  const items = useMemo(() => {
    if (!Array.isArray(history)) return [];
    return history.slice().sort((a, b) => (b.startedAt || b._creationTime || 0) - (a.startedAt || a._creationTime || 0));
  }, [history]);

  const openConversation = useCallback(
    (entry: CallHistoryEntry) => {
      if (!entry.conversationId) return;
      router.push(`/chat/${entry.conversationId}` as any);
    },
    [router],
  );

  const callBack = useCallback(
    (entry: CallHistoryEntry) => {
      if (!entry.conversationId) return;
      const type = entry.callType === 'video' ? 'video' : 'voice';
      router.push(`/call/${entry.conversationId}?type=${type}` as any);
    },
    [router],
  );

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="calls-screen">
        <Header title="Calls" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>Sign in required</Text>
          <Text style={styles.emptyBody}>Sign in to view your call history.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="calls-screen">
      <Header title="Calls" showBack onBack={() => router.back()} variant="dark" />
      {loading && items.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyWrap}>
          <MaterialCommunityIcons name="phone-outline" size={48} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>No calls yet</Text>
          <Text style={styles.emptyBody}>
            {error ? 'Could not load call history. Try again later.' : 'Your call history will appear here.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item._id)}
          renderItem={({ item }) => {
            const outcomeIcon = getOutcomeIcon(item);
            const isNeg = isNegativeOutcome(item);
            const title = item.otherName || (item.isGroup ? 'Group call' : 'Unknown');
            return (
              <TouchableOpacity
                onPress={() => openConversation(item)}
                activeOpacity={0.7}
                style={styles.row}
                testID={`call-row-${item._id}`}
              >
                <View style={[styles.avatar, item.isGroup ? styles.avatarGroup : null]}>
                  {item.isGroup ? (
                    <Feather name="users" size={22} color={'#92400E'} />
                  ) : (
                    <Text style={styles.avatarText}>{getDisplayInitials(title, 1)}</Text>
                  )}
                </View>
                <View style={styles.rowMid}>
                  <Text
                    style={[styles.rowTitle, isNeg ? styles.rowTitleDanger : null]}
                    numberOfLines={1}
                  >
                    {title}
                  </Text>
                  <View style={styles.rowSubLine}>
                    <MaterialCommunityIcons
                      name={outcomeIcon.name as any}
                      size={14}
                      color={outcomeIcon.color}
                    />
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {getOutcomeLabel(item)}{' '}{'\u00B7'}{' '}{formatRelativeTime(item.startedAt || item._creationTime)}
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => callBack(item)}
                  hitSlop={8}
                  style={styles.callBackBtn}
                  testID={`call-back-${item._id}`}
                >
                  {item.callType === 'video' ? (
                    <Feather name="video" size={22} color={Colors.primary} />
                  ) : (
                    <Feather name="phone" size={22} color={Colors.primary} />
                  )}
                </TouchableOpacity>
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { paddingBottom: 24 },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(60, 40, 0, 0.10)',
    marginLeft: 72,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    minHeight: 64,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarGroup: { backgroundColor: '#FDE68A' },
  avatarText: { color: '#92400E', fontWeight: FontWeight.bold, fontSize: 18 },
  rowMid: { flex: 1, gap: 2 },
  rowTitle: {
    fontSize: 17,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  rowTitleDanger: { color: '#EF4444' },
  rowSubLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary },
  callBackBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
  },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: Spacing.lg,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
});
