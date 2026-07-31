import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../convexApi';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors } from '../theme';

/**
 * GroupApprovalBadge — a red "N awaiting approval" pill shown on a group row
 * for ADMINS ONLY. Driven by the reactive `messageApproval.getPendingCount`
 * query, which the backend enforces to return 0 for non-admins — so regular
 * members never see the badge. Renders nothing when the count is 0 (or the
 * function isn't deployed). Kept as a tiny isolated component so each group
 * row owns its own live subscription only while mounted (FlatList unmounts
 * off-screen rows), and a parent re-render doesn't re-run every row's query.
 */
function GroupApprovalBadgeInner({ conversationId }: { conversationId: string }) {
  const { data: pendingCount } = useSafeConvexQuery<number>(
    (api as any).messageApproval?.getPendingCount,
    conversationId ? { conversationId } : {},
    0,
    !!conversationId,
  );
  const count = Number(pendingCount) || 0;
  if (count <= 0) return null;
  return (
    <View style={styles.badge} testID={`group-approval-badge-${conversationId}`}>
      <Ionicons name="shield-checkmark" size={11} color={Colors.white} />
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

export const GroupApprovalBadge = React.memo(GroupApprovalBadgeInner);

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: Colors.danger || '#E53935',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginLeft: 6,
    alignSelf: 'center',
  },
  badgeText: {
    color: Colors.white,
    fontSize: 11,
    fontWeight: '700',
  },
});
