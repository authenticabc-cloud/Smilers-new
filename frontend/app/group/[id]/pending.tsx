/**
 * /group/[id]/pending  ▸  Pending Messages queue (iter-151)
 *
 * Canonical contract: `api.messageApproval.getPendingMessages`,
 * `approveMessage`, `rejectMessage`.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../../../src/convexApi';
import { useSafeConvexQuery } from '../../../src/hooks/useSafeConvexQuery';
import ScreenErrorBoundary from '../../../src/components/ScreenErrorBoundary';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../../src/theme';

export default function PendingMessagesScreen() {
  const router = useRouter();
  return (
    <ScreenErrorBoundary screenName="group-pending" onClose={() => router.back()}>
      <PendingInner />
    </ScreenErrorBoundary>
  );
}

function PendingInner() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id;
  const { data: pending, loading, refetch } = useSafeConvexQuery<any[]>(
    (api as any).messageApproval?.getPendingMessages,
    conversationId ? { conversationId } : {},
    [],
    !!conversationId,
  );
  const approveM = useMutation((api as any).messageApproval?.approveMessage);
  const rejectM = useMutation((api as any).messageApproval?.rejectMessage);
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleApprove = async (pendingMessageId: string) => {
    if (typeof approveM !== 'function') return;
    setBusyId(pendingMessageId);
    try {
      await approveM({ pendingMessageId });
      await refetch();
    } catch (e: any) {
      Alert.alert('Approve failed', e?.message?.slice(0, 200) || 'Try again later.');
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (pendingMessageId: string) => {
    if (typeof rejectM !== 'function') return;
    setBusyId(pendingMessageId);
    try {
      await rejectM({ pendingMessageId });
      await refetch();
    } catch (e: any) {
      Alert.alert('Reject failed', e?.message?.slice(0, 200) || 'Try again later.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="group-pending-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="arrow-back" size={26} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Pending Messages</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={Colors.primary} size="large" style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={pending || []}
          keyExtractor={(it: any) => String(it._id)}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Feather name="check-circle" size={42} color="#22A06B" />
              </View>
              <Text style={styles.emptyTitle}>All clear</Text>
              <Text style={styles.emptyBody}>No messages waiting for approval.</Text>
            </View>
          }
          renderItem={({ item }: any) => {
            const id = String(item._id);
            const isBusy = busyId === id;
            return (
              <View style={styles.card} testID={`pending-card-${id}`}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardSender} numberOfLines={1}>{item.senderName || 'Unknown'}</Text>
                  <Text style={styles.cardTime}>{relativeTime(item._creationTime)}</Text>
                </View>
                <Text style={styles.cardType}>{String(item.type || 'text').toUpperCase()}</Text>
                {item.text ? <Text style={styles.cardText} numberOfLines={6}>{item.text}</Text> : null}
                {item.mediaUrl ? <Text style={styles.cardMedia}>📎 {item.fileName || 'Media attachment'}</Text> : null}
                <View style={styles.cardActions}>
                  <TouchableOpacity
                    style={[styles.rejectBtn, isBusy && styles.disabled]}
                    onPress={() => handleReject(id)}
                    disabled={isBusy}
                    testID={`pending-reject-${id}`}
                  >
                    <Text style={styles.rejectBtnText}>Reject</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.approveBtn, isBusy && styles.disabled]}
                    onPress={() => handleApprove(id)}
                    disabled={isBusy}
                    testID={`pending-approve-${id}`}
                  >
                    <Text style={styles.approveBtnText}>{isBusy ? 'Working…' : 'Approve'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

function relativeTime(ts?: number) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: {
    height: Platform.select({ ios: 100, default: 88 }),
    backgroundColor: '#D67200',
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.md,
  },
  headerTitle: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.white },
  listContent: { padding: Spacing.base, paddingBottom: 80 },
  separator: { height: Spacing.md },
  empty: { paddingTop: 80, alignItems: 'center', gap: 10 },
  emptyIcon: { width: 78, height: 78, borderRadius: 39, backgroundColor: 'rgba(34,160,107,0.15)', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.base, color: Colors.textSecondary },
  card: {
    padding: Spacing.base,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: Spacing.sm,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardSender: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary, flex: 1, marginRight: 8 },
  cardTime: { fontSize: FontSize.xs, color: Colors.textMuted },
  cardType: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: FontWeight.bold, letterSpacing: 1.2 },
  cardText: { fontSize: FontSize.base, color: Colors.textPrimary, lineHeight: 22 },
  cardMedia: { fontSize: FontSize.sm, color: Colors.textSecondary },
  cardActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: 4 },
  rejectBtn: { flex: 1, height: 44, borderRadius: Radius.md, borderWidth: 1.5, borderColor: '#D63030', alignItems: 'center', justifyContent: 'center' },
  rejectBtnText: { color: '#D63030', fontWeight: FontWeight.bold },
  approveBtn: { flex: 1, height: 44, borderRadius: Radius.md, backgroundColor: '#22A06B', alignItems: 'center', justifyContent: 'center' },
  approveBtnText: { color: Colors.white, fontWeight: FontWeight.bold },
  disabled: { opacity: 0.6 },
});
