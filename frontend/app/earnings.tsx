/**
 * Earnings — Smilers engagement/rewards page.
 *
 * Mirrors the web app's `/earnings` page 1:1 (per provided screenshots):
 *   • Red-gradient header with trending-up icon + "Earnings"
 *   • 4-tab pill row: Overview (active gold) / Top / Referrals / History
 *
 *   • OVERVIEW tab:
 *       - Big red "TOTAL ENGAGEMENTS" card showing the count + level pill
 *         + progress bar to next level + "Referrals to next level" bar
 *       - 4 stat tiles in a 2x2 grid:
 *           Referrals · Messages · Voice Notes · Call Minutes
 *       - "Your Referral Code" card with the code + copy button + hint
 *       - "Level Requirements" card with all 4 levels and their criteria
 *       - "How to Earn Engagements" card with the rules
 *       - Footnote about multipliers
 *
 *   • TOP / REFERRALS / HISTORY tabs render the existing Convex-backed
 *     lists (top earners, my referrals, my transactions) with graceful
 *     fallback empty states.
 */

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Feather,
  Ionicons,
  MaterialCommunityIcons,
} from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { getDisplayInitials, getDisplayNameFromUser } from '../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type Tab = 'overview' | 'top' | 'referrals' | 'history';

interface LevelDef {
  key: 'A' | 'B' | 'C' | 'Gold';
  label: string;
  color: string;
  bg: string;
  next?: number;
  referralsNext?: number;
  description: string;
}

const LEVELS: LevelDef[] = [
  {
    key: 'A',
    label: 'A',
    color: '#DC2626',
    bg: '#FEE2E2',
    next: 20000,
    referralsNext: 50,
    description: '0 – 19,999 engagements · 0 – 49 referrals',
  },
  {
    key: 'B',
    label: 'B',
    color: '#2563EB',
    bg: '#DBEAFE',
    next: 100000,
    referralsNext: 200,
    description: '20,000 – 99,999 engagements · 50+ referrals',
  },
  {
    key: 'C',
    label: 'C',
    color: '#16A34A',
    bg: '#DCFCE7',
    next: 500000,
    referralsNext: 1000,
    description: '100,000 – 499,999 engagements · 200+ referrals',
  },
  {
    key: 'Gold',
    label: 'Gold',
    color: '#CA8A04',
    bg: '#FEF3C7',
    description: '500,000+ engagements · 1,000+ referrals · cashout-eligible',
  },
];

const EARN_RULES = [
  { icon: 'gift', lib: 'feather' as const, label: 'Each successful referral = 2 engagements' },
  { icon: 'message-circle', lib: 'feather' as const, label: 'Each qualifying message (3+ words) = 1 engagement' },
  { icon: 'mic', lib: 'feather' as const, label: 'Each voice note sent = 2 engagements' },
  { icon: 'phone', lib: 'feather' as const, label: 'Each minute of voice or video call = 1 engagement' },
  { icon: 'crown', lib: 'mc' as const, label: 'Premium members earn a 2× multiplier on every engagement' },
  { icon: 'trending-up', lib: 'feather' as const, label: 'Daily activity streaks unlock bonus engagements' },
];

function computeLevelFromCount(count: number): LevelDef {
  if (count >= 500_000) return LEVELS[3];
  if (count >= 100_000) return LEVELS[2];
  if (count >= 20_000) return LEVELS[1];
  return LEVELS[0];
}

function formatNumber(n: number): string {
  if (typeof n !== 'number' || !isFinite(n)) return '0';
  return n.toLocaleString();
}

export default function EarningsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');

  // iter-137: canonical Convex paths confirmed by the web team.
  // `getMyProfile` IS the stats object — it returns every counter the
  // overview tab needs. No more separate `getMyStats` probe.
  const { data: profile } = useSafeConvexQuery<any | null>(
    api.earnings.getMyProfile,
    {},
    null,
    isAuthenticated,
  );
  const { data: referralCode } = useSafeConvexQuery<string | null>(
    api.earnings.getOrCreateReferralCode,
    {},
    null,
    isAuthenticated,
  );
  const { data: top } = useSafeConvexQuery<any[]>(
    api.earnings.getLeaderboard,
    { limit: 20 },
    [],
    isAuthenticated && tab === 'top',
  );
  const { data: referrals } = useSafeConvexQuery<any[]>(
    api.earnings.getMyReferrals,
    {},
    [],
    isAuthenticated && tab === 'referrals',
  );
  const { data: transactions } = useSafeConvexQuery<any[]>(
    api.earnings.getMyTransactions,
    { limit: 50 },
    [],
    isAuthenticated && tab === 'history',
  );

  // --- Derived -------------------------------------------------------------
  // iter-137: read canonical fields exactly as the web app does.
  // The total = `profile.totalEngagements` (the "73" the user expects).
  // Per-activity raw counters are `messageEngagements`, `voiceNoteEngagements`,
  // `callEngagements`. Level + progress come pre-computed from the backend.
  const totalEngagements = Number(profile?.totalEngagements ?? 0);
  const referralCount = Number(profile?.referralCount ?? 0);
  const messageCount = Number(profile?.messageEngagements ?? 0);
  const voiceCount = Number(profile?.voiceNoteEngagements ?? 0);
  const callMinutes = Number(
    profile?.callEngagements ?? profile?.videoCallMinutes ?? 0,
  );

  const currentLevel = useMemo(() => {
    // Web sends `earningsLevel` / `level` as 'A' | 'B' | 'C' | 'Gold'.
    const raw = profile?.earningsLevel || profile?.level;
    const found = raw ? LEVELS.find((l) => l.key === raw) : null;
    return found || computeLevelFromCount(totalEngagements);
  }, [profile, totalEngagements]);

  const engagementsToNext = Number(profile?.nextLevelEngagements ?? 0);
  const engagementsProgressPct = Math.max(
    0,
    Math.min(100, Math.round(Number(profile?.engagementProgress ?? 0))),
  );
  const referralsProgressPct = Math.max(
    0,
    Math.min(100, Math.round(Number(profile?.referralProgress ?? 0))),
  );

  const handleCopyCode = async () => {
    const code = (referralCode as any)?.code || referralCode || '';
    if (!code) {
      Alert.alert('No code yet', 'A referral code will be created shortly.');
      return;
    }
    try {
      await Clipboard.setStringAsync(String(code));
      Alert.alert('Copied', 'Referral code copied to clipboard.');
    } catch {
      Alert.alert('Copy failed', 'Please long-press the code to copy.');
    }
  };

  // --- Render --------------------------------------------------------------
  return (
    <View style={styles.container} testID="earnings-screen">
      {/* Red gradient-like header */}
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            style={styles.headerBackBtn}
            onPress={() => router.back()}
            hitSlop={10}
            testID="earnings-back"
          >
            <Feather name="arrow-left" size={22} color={Colors.white} />
          </TouchableOpacity>
          <Feather name="trending-up" size={24} color={Colors.white} />
          <Text style={styles.headerTitle}>Earnings</Text>
          <View style={{ width: 36 }} />
        </View>
      </SafeAreaView>

      {/* Tab pills */}
      <View style={styles.tabRow}>
        <TabBtn
          tab="overview"
          activeTab={tab}
          setTab={setTab}
          icon="grid"
          label="Overview"
          lib="feather"
        />
        <TabBtn
          tab="top"
          activeTab={tab}
          setTab={setTab}
          icon="trophy"
          label="Top"
          lib="ion"
        />
        <TabBtn
          tab="referrals"
          activeTab={tab}
          setTab={setTab}
          icon="users"
          label="Referrals"
          lib="feather"
        />
        <TabBtn
          tab="history"
          activeTab={tab}
          setTab={setTab}
          icon="clock"
          label="History"
          lib="feather"
        />
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom, 24) + 32 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'overview' ? (
          <>
            {/* Total Engagements hero card */}
            <View style={styles.heroCard} testID="earnings-hero">
              <Text style={styles.heroLabel}>TOTAL ENGAGEMENTS</Text>
              <Text style={styles.heroValue}>{formatNumber(totalEngagements)}</Text>
              <View
                style={[styles.levelPill, { backgroundColor: currentLevel.bg }]}
              >
                <MaterialCommunityIcons
                  name={currentLevel.key === 'Gold' ? 'crown' : 'shield-star'}
                  size={14}
                  color={currentLevel.color}
                />
                <Text style={[styles.levelPillText, { color: currentLevel.color }]}>
                  Level {currentLevel.label}
                </Text>
              </View>

              {currentLevel.next ? (
                <View style={styles.progressBlock}>
                  <View style={styles.progressTopRow}>
                    <Text style={styles.progressLabel}>Engagements to next level</Text>
                    <Text style={styles.progressValue}>
                      {formatNumber(totalEngagements)} / {formatNumber(currentLevel.next)}
                    </Text>
                  </View>
                  <View style={styles.progressBg}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${engagementsProgressPct}%` },
                      ]}
                    />
                  </View>
                </View>
              ) : null}

              {currentLevel.referralsNext ? (
                <View style={[styles.progressBlock, { marginTop: 10 }]}>
                  <View style={styles.progressTopRow}>
                    <Text style={styles.progressLabel}>Referrals to next level</Text>
                    <Text style={styles.progressValue}>
                      {formatNumber(referralCount)} / {formatNumber(currentLevel.referralsNext)}
                    </Text>
                  </View>
                  <View style={styles.progressBg}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${referralsProgressPct}%` },
                      ]}
                    />
                  </View>
                </View>
              ) : null}
            </View>

            {/* 2x2 stat grid */}
            <View style={styles.statsGrid}>
              <StatTile
                icon="users"
                iconColor="#2563EB"
                bg="#DBEAFE"
                title="Referrals"
                value={referralCount}
              />
              <StatTile
                icon="message-circle"
                iconColor="#16A34A"
                bg="#DCFCE7"
                title="Messages"
                subtitle="qualifying"
                value={messageCount}
              />
              <StatTile
                icon="mic"
                iconColor="#7C3AED"
                bg="#EDE9FE"
                title="Voice Notes"
                value={voiceCount}
              />
              <StatTile
                icon="phone"
                iconColor="#EA580C"
                bg="#FED7AA"
                title="Call Minutes"
                value={callMinutes}
              />
            </View>

            {/* Referral code card */}
            <View style={styles.section} testID="earnings-referral-code">
              <View style={styles.sectionHeader}>
                <Feather name="gift" size={18} color={Colors.primary} />
                <Text style={styles.sectionTitle}>Your Referral Code</Text>
              </View>
              <View style={styles.refCodeRow}>
                <Text style={styles.refCode} numberOfLines={1}>
                  {(referralCode as any)?.code || referralCode || '— — —'}
                </Text>
                <TouchableOpacity
                  style={styles.refCopyBtn}
                  onPress={handleCopyCode}
                  activeOpacity={0.85}
                  testID="earnings-copy-code"
                >
                  <Feather name="copy" size={16} color="#3D2A00" />
                  <Text style={styles.refCopyText}>Copy</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.refHint}>
                Each referral who registers = 2 engagements
              </Text>
            </View>

            {/* Level requirements card */}
            <View style={styles.section} testID="earnings-level-requirements">
              <View style={styles.sectionHeader}>
                <Ionicons name="trophy" size={18} color={Colors.primary} />
                <Text style={styles.sectionTitle}>Level Requirements</Text>
              </View>
              <View style={styles.levelsList}>
                {LEVELS.map((lvl) => {
                  const active = lvl.key === currentLevel.key;
                  return (
                    <View
                      key={lvl.key}
                      style={[
                        styles.levelRow,
                        active ? styles.levelRowActive : null,
                      ]}
                    >
                      <View
                        style={[
                          styles.levelBadge,
                          { backgroundColor: lvl.bg, borderColor: lvl.color },
                        ]}
                      >
                        <Text style={[styles.levelBadgeText, { color: lvl.color }]}>
                          {lvl.label}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.levelTitle}>Level {lvl.label}</Text>
                        <Text style={styles.levelDesc}>{lvl.description}</Text>
                      </View>
                      {active ? (
                        <View style={styles.currentTag}>
                          <Text style={styles.currentTagText}>You</Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </View>

            {/* How to earn */}
            <View style={styles.section} testID="earnings-how-to">
              <View style={styles.sectionHeader}>
                <Feather name="info" size={18} color={Colors.primary} />
                <Text style={styles.sectionTitle}>How to Earn Engagements</Text>
              </View>
              <View style={styles.rulesList}>
                {EARN_RULES.map((rule, idx) => (
                  <View key={idx} style={styles.ruleRow}>
                    <View style={styles.ruleIconWrap}>
                      {rule.lib === 'mc' ? (
                        <MaterialCommunityIcons name={rule.icon as any} size={16} color="#3D2A00" />
                      ) : (
                        <Feather name={rule.icon as any} size={16} color="#3D2A00" />
                      )}
                    </View>
                    <Text style={styles.ruleText}>{rule.label}</Text>
                  </View>
                ))}
              </View>
            </View>

            <Text style={styles.footnote}>
              Premium membership unlocks a 2× multiplier on every engagement
              earned. Streak bonuses are applied automatically at the end of
              each active day.
            </Text>
          </>
        ) : null}

        {tab === 'top' ? (
          <TopEarnersList list={top || []} />
        ) : null}

        {tab === 'referrals' ? (
          <ReferralsList list={referrals || []} />
        ) : null}

        {tab === 'history' ? (
          <HistoryList list={transactions || []} />
        ) : null}
      </ScrollView>
    </View>
  );
}

// --- Sub-components ----------------------------------------------------------
function TabBtn({
  tab,
  activeTab,
  setTab,
  icon,
  label,
  lib,
}: {
  tab: Tab;
  activeTab: Tab;
  setTab: (t: Tab) => void;
  icon: any;
  label: string;
  lib: 'feather' | 'ion';
}) {
  const active = tab === activeTab;
  // iter-137: web-style tab — vertical stack (icon on top, label below),
  // active state is a primary-color underline + tinted icon/text. No
  // pill background, mirrors the admin dashboard for consistency.
  return (
    <TouchableOpacity
      style={styles.tabBtn}
      onPress={() => setTab(tab)}
      activeOpacity={0.7}
      testID={`earnings-tab-${tab}`}
    >
      {lib === 'ion' ? (
        <Ionicons
          name={icon}
          size={22}
          color={active ? Colors.primary : Colors.textSecondary}
        />
      ) : (
        <Feather
          name={icon}
          size={22}
          color={active ? Colors.primary : Colors.textSecondary}
        />
      )}
      <Text style={[styles.tabBtnText, active ? styles.tabBtnTextActive : null]}>
        {label}
      </Text>
      <View
        style={[styles.tabBtnUnderline, active ? styles.tabBtnUnderlineActive : null]}
      />
    </TouchableOpacity>
  );
}

function StatTile({
  icon,
  iconColor,
  bg,
  title,
  subtitle,
  value,
}: {
  icon: any;
  iconColor: string;
  bg: string;
  title: string;
  subtitle?: string;
  value: number;
}) {
  return (
    <View style={styles.statTile}>
      <View style={[styles.statIconCircle, { backgroundColor: bg }]}>
        <Feather name={icon} size={20} color={iconColor} />
      </View>
      <Text style={styles.statValue}>{formatNumber(value)}</Text>
      <Text style={styles.statTitle}>{title}</Text>
      {subtitle ? <Text style={styles.statSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function TopEarnersList({ list }: { list: any[] }) {
  if (!Array.isArray(list) || list.length === 0) {
    return (
      <EmptyState
        icon="trophy"
        title="No top earners yet"
        body="Be among the first to earn engagements — your name will appear here as soon as you climb the leaderboard."
      />
    );
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Ionicons name="trophy" size={18} color={Colors.primary} />
        <Text style={styles.sectionTitle}>Top Earners</Text>
      </View>
      {list.map((item: any, idx: number) => (
        <View key={item._id || idx} style={styles.topRow}>
          <Text style={styles.topRank}>#{idx + 1}</Text>
          <View style={styles.topAvatar}>
            {item.avatarUrl ? (
              <Image source={{ uri: item.avatarUrl }} style={styles.topAvatarImg} />
            ) : (
              <Text style={styles.topAvatarText}>
                {getDisplayInitials(getDisplayNameFromUser(item, 'User'))}
              </Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.topName} numberOfLines={1}>
              {getDisplayNameFromUser(item, 'Smilers user')}
            </Text>
            <Text style={styles.topSub}>
              Level {item.level || 'A'} · {formatNumber(item.engagements || item.points || 0)} engagements
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function ReferralsList({ list }: { list: any[] }) {
  if (!Array.isArray(list) || list.length === 0) {
    return (
      <EmptyState
        icon="users"
        title="No referrals yet"
        body="Share your referral code with friends. You'll earn 2 engagements every time someone registers with it."
      />
    );
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Feather name="users" size={18} color={Colors.primary} />
        <Text style={styles.sectionTitle}>Your Referrals</Text>
      </View>
      {list.map((item: any, idx: number) => (
        <View key={item._id || idx} style={styles.topRow}>
          <View style={styles.topAvatar}>
            {item.avatarUrl ? (
              <Image source={{ uri: item.avatarUrl }} style={styles.topAvatarImg} />
            ) : (
              <Text style={styles.topAvatarText}>
                {getDisplayInitials(getDisplayNameFromUser(item, 'Friend'))}
              </Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.topName} numberOfLines={1}>
              {getDisplayNameFromUser(item, 'Friend')}
            </Text>
            <Text style={styles.topSub}>
              Joined {item.joinedAt ? new Date(item.joinedAt).toLocaleDateString() : 'recently'}
            </Text>
          </View>
          <Text style={styles.engagementPlus}>+2</Text>
        </View>
      ))}
    </View>
  );
}

function HistoryList({ list }: { list: any[] }) {
  if (!Array.isArray(list) || list.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="No earnings history yet"
        body="As you engage with Smilers, every action will appear here with the engagements awarded."
      />
    );
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Feather name="clock" size={18} color={Colors.primary} />
        <Text style={styles.sectionTitle}>History</Text>
      </View>
      {list.map((item: any, idx: number) => {
        const amount = Number(item.amount || item.engagements || item.delta || 0);
        const sign = amount >= 0 ? '+' : '';
        return (
          <View key={item._id || idx} style={styles.historyRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.historyTitle}>
                {item.reason || item.label || 'Engagement earned'}
              </Text>
              <Text style={styles.historySub}>
                {item.createdAt
                  ? new Date(item.createdAt).toLocaleString()
                  : item._creationTime
                    ? new Date(item._creationTime).toLocaleString()
                    : ''}
              </Text>
            </View>
            <Text
              style={[
                styles.historyAmount,
                { color: amount < 0 ? '#DC2626' : '#16A34A' },
              ]}
            >
              {sign}
              {formatNumber(amount)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: any;
  title: string;
  body: string;
}) {
  return (
    <View style={styles.emptyWrap} testID="earnings-empty">
      <Feather name={icon} size={42} color={Colors.textMuted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

// --- Styles ------------------------------------------------------------------
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  // Header
  headerSafe: { backgroundColor: '#DC2626' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: 80,
  },
  headerBackBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontSize: 22, fontWeight: FontWeight.bold, color: Colors.white },

  // Tabs — iter-137: web-style icon-above-label + underline.
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 0,
    paddingTop: 10,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: '#EBE5D5',
  },
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    paddingTop: 6,
    paddingBottom: 0,
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: FontWeight.medium,
    color: Colors.textSecondary,
    marginTop: 2,
    marginBottom: 8,
  },
  tabBtnTextActive: {
    color: Colors.primary,
    fontWeight: FontWeight.semibold,
  },
  tabBtnUnderline: {
    height: 2,
    width: '60%',
    backgroundColor: 'transparent',
    borderRadius: 1,
  },
  tabBtnUnderlineActive: {
    backgroundColor: Colors.primary,
  },

  scrollContent: { padding: Spacing.lg, gap: Spacing.md },

  // Hero card
  heroCard: {
    backgroundColor: '#DC2626',
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xl,
    alignItems: 'center',
    gap: 8,
  },
  heroLabel: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: FontSize.sm,
    letterSpacing: 1.4,
    fontWeight: FontWeight.semibold,
  },
  heroValue: { color: Colors.white, fontSize: 56, fontWeight: FontWeight.bold, marginVertical: 4 },
  levelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
  },
  levelPillText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  progressBlock: { width: '100%', marginTop: 18 },
  progressTopRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressLabel: { color: 'rgba(255,255,255,0.85)', fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  progressValue: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  progressBg: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.25)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: Colors.white },

  // Stat grid
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
  statTile: {
    flexBasis: '48%',
    flexGrow: 1,
    backgroundColor: Colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#EBE5D5',
    gap: 4,
  },
  statIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  statValue: { fontSize: 26, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  statTitle: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  statSubtitle: { fontSize: FontSize.xs, color: Colors.textSecondary },

  // Sections
  section: {
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#EBE5D5',
    gap: 14,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },

  // Referral code
  refCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FFFCEC',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#D1A800',
    borderRadius: Radius.md,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  refCode: {
    flex: 1,
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: '#3D2A00',
    letterSpacing: 2,
  },
  refCopyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  refCopyText: { color: '#3D2A00', fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  refHint: { fontSize: FontSize.sm, color: Colors.textSecondary },

  // Level requirements
  levelsList: { gap: 12 },
  levelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#EBE5D5',
  },
  levelRowActive: { borderColor: Colors.primary, backgroundColor: '#FFF7DE' },
  levelBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  levelBadgeText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  levelTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  levelDesc: { marginTop: 2, fontSize: FontSize.sm, color: Colors.textSecondary },
  currentTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: Colors.primary,
    borderRadius: Radius.pill,
  },
  currentTagText: { color: '#3D2A00', fontWeight: FontWeight.bold, fontSize: FontSize.xs },

  // Rules
  rulesList: { gap: 10 },
  ruleRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  ruleIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  ruleText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20 },

  // Footnote
  footnote: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 6,
    paddingHorizontal: Spacing.md,
    lineHeight: 18,
  },

  // Top / Referrals shared
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#EBE5D5',
  },
  topRank: { width: 28, fontWeight: FontWeight.bold, fontSize: FontSize.base, color: Colors.primary },
  topAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
    overflow: 'hidden',
  },
  topAvatarImg: { width: 40, height: 40, borderRadius: 20 },
  topAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold },
  topName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  topSub: { marginTop: 2, fontSize: FontSize.sm, color: Colors.textSecondary },
  engagementPlus: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#16A34A' },

  // History
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#EBE5D5',
  },
  historyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  historySub: { marginTop: 2, fontSize: FontSize.sm, color: Colors.textSecondary },
  historyAmount: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },

  // Empty
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.xl,
    gap: 10,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
});
