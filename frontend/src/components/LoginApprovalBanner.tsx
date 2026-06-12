/**
 * LoginApprovalBanner (iter-186) — surfaces pending desktop login
 * approvals at the top of the Chats tab (contract section 5.5: "on app
 * open, also call listPendingForMe and show any waiting requests in
 * case the push was missed"). Live subscription — disappears the moment
 * the request is approved/denied/expired.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { FontSize, FontWeight, Radius, Shadow } from '../theme';

const EMPTY_PENDING: any[] = [];

export function LoginApprovalBanner() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: pending } = useSafeConvexQuery<any[]>(
    (api as any).loginApprovals.listPendingForMe,
    {},
    EMPTY_PENDING,
    isAuthenticated,
  );
  const pendingList = Array.isArray(pending) ? pending : EMPTY_PENDING;
  // Filter out anything already past expiry so the banner never lingers.
  const now = Date.now();
  const active = pendingList.filter((row: any) => Number(row.expiresAt) > now);
  if (active.length === 0) return null;

  const first = active[0];
  return (
    <TouchableOpacity
      style={styles.banner}
      onPress={() => router.push(`/approve-login?code=${encodeURIComponent(String(first.code))}` as any)}
      activeOpacity={0.85}
      testID="login-approval-banner"
    >
      <View style={styles.iconWrap}>
        <MaterialCommunityIcons name="monitor-lock" size={20} color="#92400E" />
      </View>
      <View style={styles.flexOne}>
        <Text style={styles.title} testID="login-approval-banner-title">
          Desktop login waiting for approval
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {first.deviceName || 'A computer'} is trying to sign in — tap to review
        </Text>
      </View>
      <Feather name="chevron-right" size={20} color="#92400E" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FEF3C7',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: '#FCD34D',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    ...Shadow.sm,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FDE68A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: '#92400E' },
  sub: { fontSize: FontSize.xs, color: '#B45309', marginTop: 1 },
});
