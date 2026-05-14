import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const LEVEL_INFO: Record<string, { color: string; perks: string }> = {
  A: { color: '#9CA3AF', perks: 'Starter level — keep engaging to level up' },
  B: { color: '#60A5FA', perks: 'Higher earning rate · priority support' },
  C: { color: '#F59E0B', perks: 'Premium features unlocked' },
  Gold: { color: '#EAB308', perks: 'Cashout-eligible · all features' },
};

export default function EarningsScreen() {
  const router = useRouter();
  const { data: profile } = useSafeConvexQuery<any | null>(api.earnings.getMyProfile, {}, null);
  const { data: transactions } = useSafeConvexQuery<any[]>(api.earnings.getMyTransactions, { limit: 20 }, []);
  const { data: referrals } = useSafeConvexQuery<any[]>(api.earnings.getMyReferrals, {}, []);
  const { data: referralCode } = useSafeConvexQuery<string | null>(
    api.earnings.getOrCreateReferralCode,
    {},
    null
  );

  const level = profile?.level || 'A';
  const points = profile?.points || 0;
  const info = LEVEL_INFO[level] || LEVEL_INFO.A;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="earnings-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="earnings-back-button">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} testID="earnings-header-title">
          Earnings & Rewards
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent} testID="earnings-scroll-view">
        <View style={[styles.levelCard, { backgroundColor: info.color }]} testID="earnings-level-card">
          <Text style={styles.levelLabel}>YOUR LEVEL</Text>
          <Text style={styles.levelValue} testID="earnings-level-value">
            {level}
          </Text>
          <Text style={styles.levelPerks} testID="earnings-level-perks">
            {info.perks}
          </Text>
          <View style={styles.pointsRow} testID="earnings-points-row">
            <Ionicons name="sparkles" size={18} color={Colors.white} />
            <Text style={styles.points} testID="earnings-points-value">
              {points.toLocaleString()} pts
            </Text>
          </View>
        </View>

        <View style={styles.quickActions} testID="earnings-quick-actions">
          <TouchableOpacity style={styles.quickActionCard} onPress={() => router.push('/wallet' as any)} testID="earnings-wallet-button">
            <View style={styles.quickActionIcon}>
              <MaterialCommunityIcons name="wallet-outline" size={22} color={Colors.primary} />
            </View>
            <Text style={styles.quickActionTitle}>Gold Wallet</Text>
            <Text style={styles.quickActionSub}>Manage withdrawals and payout methods</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickActionCard} onPress={() => router.push('/send-money' as any)} testID="earnings-send-money-button">
            <View style={styles.quickActionIcon}>
              <Feather name="send" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.quickActionTitle}>Send Money</Text>
            <Text style={styles.quickActionSub}>Transfer funds or request money from contacts</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section} testID="earnings-referral-section">
          <Text style={styles.sectionTitle}>Referral Code</Text>
          <View style={styles.codeBox} testID="earnings-referral-box">
            <Text style={styles.codeText} testID="earnings-referral-code">
              {referralCode || '—'}
            </Text>
            <Text style={styles.codeSub} testID="earnings-referral-count">
              {referrals.length} successful referral{referrals.length === 1 ? '' : 's'}
            </Text>
          </View>
        </View>

        <View style={styles.section} testID="earnings-activity-section">
          <Text style={styles.sectionTitle}>Recent Activity</Text>
          {transactions.length > 0 ? (
            transactions.map((transaction: any, index: number) => (
              <View key={transaction._id} style={styles.txRow} testID={`earnings-transaction-row-${index}`}>
                <View
                  style={[
                    styles.txIcon,
                    { backgroundColor: (transaction.amount || 0) >= 0 ? '#DCFCE7' : '#FEE2E2' },
                  ]}
                >
                  <Ionicons
                    name={(transaction.amount || 0) >= 0 ? 'add' : 'remove'}
                    size={18}
                    color={(transaction.amount || 0) >= 0 ? '#16a34a' : '#B91C1C'}
                  />
                </View>
                <View style={styles.flexOne}>
                  <Text style={styles.txTitle} testID={`earnings-transaction-title-${index}`}>
                    {transaction.reason || transaction.type || 'Transaction'}
                  </Text>
                  <Text style={styles.txSub} testID={`earnings-transaction-date-${index}`}>
                    {new Date(transaction._creationTime).toLocaleDateString()}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.txAmount,
                    { color: (transaction.amount || 0) >= 0 ? '#16a34a' : '#B91C1C' },
                  ]}
                  testID={`earnings-transaction-amount-${index}`}
                >
                  {(transaction.amount || 0) >= 0 ? '+' : ''}
                  {transaction.amount}
                </Text>
              </View>
            ))
          ) : (
            <View style={styles.empty} testID="earnings-empty-state">
              <Text style={styles.emptyText}>Start chatting to earn points!</Text>
            </View>
          )}
        </View>
      </ScrollView>
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
  levelCard: { margin: Spacing.base, padding: Spacing.lg, borderRadius: Radius.lg, alignItems: 'flex-start' },
  levelLabel: { color: Colors.white, fontSize: FontSize.xs, letterSpacing: 2, opacity: 0.85, marginBottom: 4 },
  levelValue: { color: Colors.white, fontSize: 64, fontWeight: '800', lineHeight: 70 },
  levelPerks: { color: Colors.white, fontSize: FontSize.sm, opacity: 0.9, marginTop: 8, marginBottom: 16 },
  pointsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
  },
  points: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  quickActions: { paddingHorizontal: Spacing.base, gap: Spacing.md },
  quickActionCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: '#00000011',
  },
  quickActionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  quickActionTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  quickActionSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, lineHeight: 20 },
  section: { paddingHorizontal: Spacing.base, marginTop: Spacing.lg },
  sectionTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  codeBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: Radius.md,
    padding: Spacing.base,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#00000011',
  },
  codeText: { fontSize: 22, fontWeight: '800', color: Colors.primary, letterSpacing: 2 },
  codeSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000011',
  },
  txIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  txTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  txSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  txAmount: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  empty: { padding: Spacing.lg, alignItems: 'center' },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.sm },
  scrollContent: { paddingBottom: 32 },
  flexOne: { flex: 1 },
});