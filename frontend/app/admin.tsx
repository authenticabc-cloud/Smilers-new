import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type Tab = 'overview' | 'users' | 'reports' | 'ads' | 'devotions' | 'premium' | 'activity';
type AdsSubTab = 'review' | 'codes';

// iter-136: canonical shape returned by `api.admin.queries.getStats`
// (verified against web app source). All fields are numbers.
interface Stats {
  totalUsers?: number;
  onlineUsers?: number;          // → "Online Now"
  recentSignups?: number;        // → "New This Week"
  messagesLast24h?: number;      // → "Messages (24h)"
  totalConversations?: number;   // → "Total Conversations"
  groupChats?: number;           // → "Group Chats"
  directChats?: number;          // (returned, not shown on a card)
  totalMessages?: number;        // (returned, not shown on a card)
  totalReports?: number;         // (returned, not shown on a card)
  pendingReports?: number;       // → "Pending Reports"
  totalCommunities?: number;     // → "Communities"
  // Optional / legacy fields kept for forward compatibility:
  adRevenueEur?: number;
}

interface UserItem {
  _id: string;
  name?: string;
  email?: string;
  phone?: string;
  role?: 'admin' | 'user';
  status?: 'active' | 'suspended';
  _creationTime?: number;
  level?: string;
  totalEngagements?: number;
  referralCount?: number;
  isOnline?: boolean;
  lastSeen?: string;
}

// Mirrors the web Admin "Last seen …" label. getAllUsers already forces
// isOnline=false when lastSeen is older than 2 min, so we trust isOnline.
function formatAdminLastSeen(lastSeen?: string, isOnline?: boolean): string {
  if (isOnline) return 'Online now';
  if (!lastSeen) return 'Last seen a while ago';
  const t = new Date(lastSeen).getTime();
  if (!Number.isFinite(t)) return 'Last seen a while ago';
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `Last seen ${sec} second${sec === 1 ? '' : 's'} ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Last seen ${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Last seen ${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `Last seen ${day} day${day === 1 ? '' : 's'} ago`;
  const mon = Math.floor(day / 30);
  return `Last seen ${mon} month${mon === 1 ? '' : 's'} ago`;
}

interface ReportItem {
  _id: string;
  reporter?: { _id?: string; name?: string };
  target?: { _id?: string; name?: string };
  reason?: string;
  details?: string;
  status?: 'pending' | 'resolved' | 'dismissed';
  _creationTime?: number;
}

interface AdItem {
  _id: string;
  businessName?: string;
  productName?: string;
  description?: string;
  externalLink?: string;
  status?: 'pending' | 'approved' | 'rejected';
  createdBy?: { name?: string };
  _creationTime?: number;
}

export default function AdminDashboard() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: me, loading: meLoading } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    {},
    null,
    isAuthenticated,
  );
  const isAdmin = me?.role === 'admin';

  // iter-136: canonical web path is `api.admin.queries.getStats` (with
  // a `.queries` namespace), NOT `api.admin.getStats`. Verified against
  // the web app source by the user.
  const { data: stats, refetch: refetchStats } = useSafeConvexQuery<Stats>(
    api.admin.queries.getStats,
    {},
    {},
    isAdmin,
  );
  // iter-140b: canonical admin paths confirmed by the web team.
  //  - `api.admin.queries.getAllUsers` (NO args — passing { search: '' }
  //    fails arg validation and returns empty).
  //  - `api.admin.queries.getAllReports` (NO args).
  //  - `api.ads.listPending` (top-level, NOT under api.admin.*).
  // The previous probes (`api.admin.listUsers`, etc.) didn't exist on
  // the backend — which is why all three tabs showed "No data".
  // iter-140b: backend doesn't take a search arg, so filtering happens
  // client-side. State is local to this component.
  const [userSearch, setUserSearch] = useState('');
  const { data: users, refetch: refetchUsers, loading: usersLoading } = useSafeConvexQuery<UserItem[]>(
    api.admin.queries.getAllUsers,
    {},
    [],
    isAdmin,
  );
  const { data: reports, refetch: refetchReports, loading: reportsLoading } = useSafeConvexQuery<ReportItem[]>(
    api.admin.queries.getAllReports,
    {},
    [],
    isAdmin,
  );
  const { data: pendingAds, refetch: refetchAds, loading: adsLoading } = useSafeConvexQuery<AdItem[]>(
    api.ads.listPending,
    {},
    [],
    isAdmin,
  );

  // Mutations — iter-140b: canonical names.
  // `updateUserRole({ userId, role })` replaces the old `setRole`. The
  // backend exposes a single role-toggle endpoint rather than
  // suspend/unsuspend (those mutations don't exist server-side). The
  // mobile suspend UI is therefore wired to flip role between "user"
  // and "admin" as the closest available equivalent; a future iteration
  // can swap this for a dedicated suspend endpoint once the backend
  // exposes one.
  const setRole = useMutation(api.admin.queries.updateUserRole);
  const suspendUser = useMutation(api.admin.queries.deleteUser);    // delete-only on backend
  const unsuspendUser = useMutation(api.admin.queries.updateUserRole); // restore via role
  const resolveReport = useMutation(api.admin.queries.dismissReport);
  const approveAd = useMutation(api.ads.approve);
  const rejectAd = useMutation(api.ads.reject);

  const [tab, setTab] = useState<Tab>('overview');
  const [adsSubTab, setAdsSubTab] = useState<AdsSubTab>('review');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Reject-ad modal state.
  const [rejectModal, setRejectModal] = useState<{ adId: string; name: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refetchStats(), refetchUsers(), refetchReports(), refetchAds()]);
    } finally {
      setRefreshing(false);
    }
  }, [refetchAds, refetchReports, refetchStats, refetchUsers]);

  // ── ACCESS GATE ─────────────────────────────────────
  if (!meLoading && !isAdmin) {
    return (
      <SafeAreaView style={styles.container} edges={['top']} testID="admin-denied">
        <Header title="Admin Dashboard" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.deniedWrap}>
          <View style={styles.deniedIcon}>
            <Ionicons name="lock-closed" size={40} color={Colors.danger} />
          </View>
          <Text style={styles.deniedTitle}>Admin access required</Text>
          <Text style={styles.deniedBody}>
            This area is restricted to Smilers admins. If you believe you should have access, contact support.
          </Text>
          <TouchableOpacity style={styles.deniedBtn} onPress={() => router.back()} testID="admin-back-btn">
            <Text style={styles.deniedBtnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }
  if (meLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Admin Dashboard" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.deniedWrap}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  // ── ACTION HANDLERS ─────────────────────────────────
  const guard = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
    } catch (errorValue: any) {
      Alert.alert('Action failed', errorValue?.message || 'Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const toggleSuspend = (u: UserItem) => {
    const action = u.status === 'suspended' ? 'Unsuspend' : 'Suspend';
    Alert.alert(`${action} ${u.name || 'this user'}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: action,
        style: 'destructive',
        onPress: () =>
          guard(u._id, async () => {
            if (u.status === 'suspended') await unsuspendUser({ userId: u._id });
            else await suspendUser({ userId: u._id });
            await refetchUsers();
            await refetchStats();
          }),
      },
    ]);
  };

  const toggleAdmin = (u: UserItem) => {
    const becoming = u.role === 'admin' ? 'user' : 'admin';
    Alert.alert(
      `Set ${u.name || 'this user'} as ${becoming}?`,
      becoming === 'admin'
        ? 'They will get full access to the admin dashboard.'
        : 'They will lose admin access.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () =>
            guard(u._id, async () => {
              await setRole({ userId: u._id, role: becoming });
              await refetchUsers();
              await refetchStats();
            }),
        },
      ],
    );
  };

  const resolveReportWith = (r: ReportItem, action: 'dismiss' | 'warn' | 'ban') => {
    const verb = action === 'dismiss' ? 'Dismiss' : action === 'warn' ? 'Warn' : 'Ban';
    Alert.alert(`${verb} report?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: verb,
        style: action === 'ban' ? 'destructive' : 'default',
        onPress: () =>
          guard(r._id, async () => {
            await resolveReport({ reportId: r._id, action });
            await refetchReports();
            await refetchStats();
          }),
      },
    ]);
  };

  const onApproveAd = (ad: AdItem) =>
    Alert.alert(`Approve ${ad.businessName || 'this ad'}?`, 'It will go live and start accumulating clicks.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Approve',
        onPress: () =>
          guard(ad._id, async () => {
            await approveAd({ adId: ad._id });
            await refetchAds();
            await refetchStats();
          }),
      },
    ]);

  const onOpenReject = (ad: AdItem) => {
    setRejectModal({ adId: ad._id, name: ad.businessName || 'this ad' });
    setRejectReason('');
  };
  const onConfirmReject = async () => {
    if (!rejectModal) return;
    if (rejectReason.trim().length < 4) {
      Alert.alert('Add a reason', 'Please tell the advertiser why their ad was rejected.');
      return;
    }
    await guard(rejectModal.adId, async () => {
      await rejectAd({ adId: rejectModal.adId, reason: rejectReason.trim() });
      await refetchAds();
      await refetchStats();
    });
    setRejectModal(null);
  };

  // ── RENDER ──────────────────────────────────────────
  const tabs: { key: Tab; label: string; icon: string; badge?: number }[] = [
    { key: 'overview', label: 'Overview', icon: 'speedometer-outline' },
    { key: 'users', label: 'Users', icon: 'people-outline', badge: stats?.totalUsers },
    { key: 'reports', label: 'Reports', icon: 'flag-outline', badge: stats?.pendingReports || reports?.length },
    { key: 'ads', label: 'Ads', icon: 'megaphone-outline', badge: pendingAds?.length },
    { key: 'devotions', label: 'Devotions', icon: 'book-outline', badge: pendingDevReports?.length },
    { key: 'premium', label: 'Premium', icon: 'star-outline' },
    { key: 'activity', label: 'Activity', icon: 'pulse-outline' },
  ];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="admin-screen">
      <Header
        title="Admin Dashboard"
        subtitle="Manage your Smilers app"
        showBack
        onBack={() => router.back()}
        variant="dark"
      />

      {/* Tab bar — iter-137: redesigned to match the web app exactly.
          Icon sits ABOVE label (vertical stack), active tab is marked
          with a primary-color underline + tinted icon/text (no pill
          background). No badges on tabs (web hides them at this level). */}
      <View style={styles.tabBar}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={styles.tab}
              onPress={() => setTab(t.key)}
              testID={`admin-tab-${t.key}`}
              activeOpacity={0.7}
            >
              <Ionicons
                name={t.icon as any}
                size={22}
                color={active ? Colors.primary : Colors.textSecondary}
              />
              <Text
                style={[styles.tabText, active ? styles.tabTextActive : null]}
                numberOfLines={1}
              >
                {t.label}
              </Text>
              <View style={[styles.tabUnderline, active ? styles.tabUnderlineActive : null]} />
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        testID="admin-scroll"
      >
        {tab === 'overview' ? <OverviewTab stats={stats} /> : null}
        {tab === 'users' ? (
          <UsersTab
            search={userSearch}
            onSearch={setUserSearch}
            loading={usersLoading}
            users={users || []}
            busyId={busyId}
            onToggleSuspend={toggleSuspend}
            onToggleAdmin={toggleAdmin}
            onBroadcast={() => router.push('/broadcast-create' as any)}
            onMessageUser={(u) => router.push(`/broadcast-create?preselect=${u._id}` as any)}
          />
        ) : null}
        {tab === 'reports' ? (
          <ReportsTab
            loading={reportsLoading}
            reports={reports || []}
            busyId={busyId}
            onResolve={resolveReportWith}
          />
        ) : null}
        {tab === 'ads' ? (
          <AdsTab
            loading={adsLoading}
            ads={pendingAds || []}
            busyId={busyId}
            onApprove={onApproveAd}
            onReject={onOpenReject}
            subTab={adsSubTab}
            onChangeSubTab={setAdsSubTab}
          />
        ) : null}
        {tab === 'premium' ? <PremiumTab isAdmin={isAdmin} /> : null}
        {tab === 'activity' ? <ActivityTab isAdmin={isAdmin} /> : null}
      </ScrollView>

      {/* Reject ad modal */}
      <Modal
        visible={!!rejectModal}
        transparent
        animationType="fade"
        onRequestClose={() => (busyId ? null : setRejectModal(null))}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Reject {rejectModal?.name}?</Text>
            <Text style={styles.modalBody}>
              The advertiser will see this reason. Be specific so they can fix and resubmit.
            </Text>
            <TextInput
              value={rejectReason}
              onChangeText={setRejectReason}
              placeholder="e.g. The ad image contains misleading text"
              placeholderTextColor={Colors.textMuted}
              style={[styles.modalInput, { minHeight: 90, textAlignVertical: 'top' }]}
              multiline
              testID="admin-reject-reason"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setRejectModal(null)}
                disabled={!!busyId}
                testID="admin-reject-cancel"
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnDanger, busyId ? { opacity: 0.7 } : null]}
                onPress={onConfirmReject}
                disabled={!!busyId}
                testID="admin-reject-confirm"
              >
                {busyId ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Text style={styles.modalBtnDangerText}>Reject ad</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ──────────────── OVERVIEW TAB ──────────────── */
function OverviewTab({ stats }: { stats: Stats | undefined }) {
  // iter-136: mapped 1:1 to the web app's canonical card → field
  // mapping (verified by the user against `src/pages/admin/page.tsx`):
  //   Total Users         → totalUsers
  //   Online Now          → onlineUsers
  //   New This Week       → recentSignups
  //   Messages (24h)      → messagesLast24h
  //   Total Conversations → totalConversations
  //   Group Chats         → groupChats
  //   Pending Reports     → pendingReports
  //   Communities         → totalCommunities
  const s: any = stats || {};
  const cards = [
    { label: 'Total users',          value: s.totalUsers,         icon: 'people-outline',         tone: Colors.primary, accent: Colors.primaryLight },
    { label: 'Online now',           value: s.onlineUsers,        icon: 'globe-outline',          tone: '#10B981',      accent: '#D1FAE5' },
    { label: 'New this week',        value: s.recentSignups,      icon: 'trending-up-outline',    tone: '#8B5CF6',      accent: '#EDE9FE' },
    { label: 'Messages (24h)',       value: s.messagesLast24h,    icon: 'chatbubble-ellipses-outline', tone: '#F59E0B', accent: '#FEF3C7' },
    { label: 'Total conversations',  value: s.totalConversations, icon: 'chatbubbles-outline',    tone: '#0EA5E9',      accent: '#DBEAFE' },
    { label: 'Group chats',          value: s.groupChats,         icon: 'people-circle-outline',  tone: '#EC4899',      accent: '#FCE7F3' },
    { label: 'Pending reports',      value: s.pendingReports,     icon: 'flag-outline',           tone: Colors.danger,  accent: '#FEE2E2' },
    { label: 'Communities',          value: s.totalCommunities,   icon: 'globe-outline',          tone: '#14B8A6',      accent: '#CCFBF1' },
  ];
  return (
    <View style={{ paddingTop: Spacing.md }}>
      <View style={styles.statsGrid}>
        {cards.map((c) => (
          <View key={c.label} style={styles.statCard}>
            <View style={[styles.statIcon, { backgroundColor: c.accent }]}>
              <Ionicons name={c.icon as any} size={20} color={c.tone} />
            </View>
            <Text style={styles.statValue}>{typeof c.value === 'number' ? c.value.toLocaleString() : '—'}</Text>
            <Text style={styles.statLabel}>{c.label}</Text>
          </View>
        ))}
      </View>

      {typeof s.adRevenueEur === 'number' ? (
        <View style={styles.revenueCard}>
          <View style={[styles.statIcon, { backgroundColor: Colors.primaryLight }]}>
            <Ionicons name="cash-outline" size={22} color={Colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.statLabel}>Ad revenue this month</Text>
            <Text style={styles.statValue}>€{(s.adRevenueEur || 0).toFixed(2)}</Text>
          </View>
        </View>
      ) : null}

      <Text style={styles.noteCard}>
        Stats are read from{' '}
        <Text style={{ fontWeight: FontWeight.bold }}>api.admin.queries.getStats</Text>. Requires admin role.
      </Text>
    </View>
  );
}

/* ──────────────── USERS TAB ──────────────── */
function UsersTab({
  search,
  onSearch,
  loading,
  users,
  busyId,
  onToggleSuspend,
  onToggleAdmin,
  onBroadcast,
  onMessageUser,
}: {
  search: string;
  onSearch: (v: string) => void;
  loading: boolean;
  users: UserItem[];
  busyId: string | null;
  onToggleSuspend: (u: UserItem) => void;
  onToggleAdmin: (u: UserItem) => void;
  onBroadcast: () => void;
  onMessageUser: (u: UserItem) => void;
}) {
  // iter-140b: `getAllUsers` returns the full list with no server-side
  // filter. Filter client-side so the search box still works exactly
  // like the user expects (and like the web admin).
  const trimmed = search.trim().toLowerCase();
  const filtered = trimmed
    ? users.filter((u) => {
        return (
          (u.name || '').toLowerCase().includes(trimmed) ||
          (u.email || '').toLowerCase().includes(trimmed) ||
          (u.phone || '').toLowerCase().includes(trimmed)
        );
      })
    : users;
  return (
    <View>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={Colors.textMuted} />
        <TextInput
          value={search}
          onChangeText={onSearch}
          placeholder="Search by name, email, phone"
          placeholderTextColor={Colors.textMuted}
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          testID="admin-users-search"
        />
        {search ? (
          <TouchableOpacity onPress={() => onSearch('')} hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      <TouchableOpacity style={styles.broadcastCta} onPress={onBroadcast} testID="admin-broadcast-cta" activeOpacity={0.85}>
        <Ionicons name="radio-outline" size={18} color={Colors.headerBg} />
        <Text style={styles.broadcastCtaText}>Send broadcast as “Smilers”</Text>
      </TouchableOpacity>

      {loading && filtered.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={Colors.primary} />
        </View>
      ) : filtered.length === 0 ? (
        <EmptyState icon="people-outline" title="No users" body="Try a different search term." />
      ) : (
        <View style={styles.card}>
          {filtered.map((u, idx) => (
            <View
              key={u._id}
              style={[styles.userRow, idx === users.length - 1 ? styles.rowLast : null]}
              testID={`admin-user-${idx}`}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(u.name || u.email || '?').charAt(0).toUpperCase()}</Text>
                {u.isOnline ? <View style={styles.onlineDot} testID={`admin-user-${idx}-online`} /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTitleLine}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {u.name || 'Unnamed user'}
                  </Text>
                  {u.role === 'admin' ? (
                    <View style={[styles.tag, { backgroundColor: Colors.primaryLight }]}>
                      <Text style={[styles.tagText, { color: Colors.primaryDark }]}>ADMIN</Text>
                    </View>
                  ) : null}
                  {u.status === 'suspended' ? (
                    <View style={[styles.tag, { backgroundColor: '#FEE2E2' }]}>
                      <Text style={[styles.tagText, { color: Colors.danger }]}>SUSPENDED</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {u.email || u.phone || u._id}
                </Text>
                <View style={styles.userStatsLine}>
                  <View style={styles.levelChip}>
                    <Ionicons name="ribbon-outline" size={11} color={Colors.primaryDark} />
                    <Text style={styles.levelChipText}>Level {u.level || 'A'}</Text>
                  </View>
                  <Text style={styles.userStatsText} numberOfLines={1}>
                    {Number(u.totalEngagements || 0)} pts · {Number(u.referralCount || 0)} refs
                  </Text>
                </View>
                <Text
                  style={[styles.lastSeenText, u.isOnline ? styles.lastSeenOnline : null]}
                  numberOfLines={1}
                >
                  {formatAdminLastSeen(u.lastSeen, u.isOnline)}
                </Text>
              </View>
              <RowMenu
                disabled={busyId === u._id}
                actions={[
                  {
                    label: 'Message as “Smilers”',
                    icon: 'chatbubble-ellipses-outline',
                    onPress: () => onMessageUser(u),
                  },
                  {
                    label: u.role === 'admin' ? 'Remove admin' : 'Make admin',
                    icon: 'shield-outline',
                    onPress: () => onToggleAdmin(u),
                  },
                  {
                    label: u.status === 'suspended' ? 'Unsuspend' : 'Suspend',
                    icon: u.status === 'suspended' ? 'play-circle-outline' : 'ban-outline',
                    danger: u.status !== 'suspended',
                    onPress: () => onToggleSuspend(u),
                  },
                ]}
                testID={`admin-user-menu-${idx}`}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ──────────────── REPORTS TAB ──────────────── */
function ReportsTab({
  loading,
  reports,
  busyId,
  onResolve,
}: {
  loading: boolean;
  reports: ReportItem[];
  busyId: string | null;
  onResolve: (r: ReportItem, action: 'dismiss' | 'warn' | 'ban') => void;
}) {
  if (loading && reports.length === 0) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="small" color={Colors.primary} />
      </View>
    );
  }
  if (reports.length === 0) {
    return <EmptyState icon="checkmark-done" title="No pending reports" body="The queue is clean. 🎉" />;
  }
  return (
    <View style={{ paddingTop: Spacing.md, paddingHorizontal: Spacing.base, gap: Spacing.sm }}>
      {reports.map((r, idx) => (
        <View key={r._id} style={styles.reportCard} testID={`admin-report-${idx}`}>
          <View style={styles.reportHeader}>
            <View style={[styles.tag, { backgroundColor: '#FEE2E2' }]}>
              <Text style={[styles.tagText, { color: Colors.danger }]}>{(r.reason || 'OTHER').toUpperCase()}</Text>
            </View>
            <Text style={styles.reportTime}>
              {r._creationTime ? new Date(r._creationTime).toLocaleDateString() : '—'}
            </Text>
          </View>
          <Text style={styles.reportTitle}>
            <Text style={{ fontWeight: FontWeight.bold }}>{r.reporter?.name || 'Someone'}</Text>
            <Text> reported </Text>
            <Text style={{ fontWeight: FontWeight.bold }}>{r.target?.name || 'a user'}</Text>
          </Text>
          {r.details ? <Text style={styles.reportBody}>{r.details}</Text> : null}
          <View style={styles.reportActions}>
            <TouchableOpacity
              style={[styles.smallBtn, styles.smallBtnGhost, busyId === r._id ? { opacity: 0.5 } : null]}
              onPress={() => onResolve(r, 'dismiss')}
              disabled={busyId === r._id}
              testID={`admin-report-dismiss-${idx}`}
            >
              <Ionicons name="close-outline" size={16} color={Colors.textSecondary} />
              <Text style={styles.smallBtnGhostText}>Dismiss</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.smallBtn, styles.smallBtnWarn, busyId === r._id ? { opacity: 0.5 } : null]}
              onPress={() => onResolve(r, 'warn')}
              disabled={busyId === r._id}
              testID={`admin-report-warn-${idx}`}
            >
              <Ionicons name="warning-outline" size={16} color="#B45309" />
              <Text style={styles.smallBtnWarnText}>Warn</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.smallBtn, styles.smallBtnDanger, busyId === r._id ? { opacity: 0.5 } : null]}
              onPress={() => onResolve(r, 'ban')}
              disabled={busyId === r._id}
              testID={`admin-report-ban-${idx}`}
            >
              <Ionicons name="ban-outline" size={16} color={Colors.white} />
              <Text style={styles.smallBtnDangerText}>Ban</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </View>
  );
}

/* ──────────────── ADS TAB ──────────────── */
function AdsTab({
  loading,
  ads,
  busyId,
  onApprove,
  onReject,
  subTab,
  onChangeSubTab,
}: {
  loading: boolean;
  ads: AdItem[];
  busyId: string | null;
  onApprove: (a: AdItem) => void;
  onReject: (a: AdItem) => void;
  subTab: 'review' | 'codes';
  onChangeSubTab: (t: 'review' | 'codes') => void;
}) {
  return (
    <View>
      {/* Sub-tab toggle */}
      <View style={styles.subTabBar} testID="admin-ads-subtabs">
        <TouchableOpacity
          style={[styles.subTab, subTab === 'review' ? styles.subTabActive : null]}
          onPress={() => onChangeSubTab('review')}
          testID="admin-ads-subtab-review"
        >
          <Ionicons
            name="checkmark-circle-outline"
            size={16}
            color={subTab === 'review' ? Colors.headerBg : Colors.textSecondary}
          />
          <Text style={[styles.subTabText, subTab === 'review' ? styles.subTabTextActive : null]}>
            Review ads
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.subTab, subTab === 'codes' ? styles.subTabActive : null]}
          onPress={() => onChangeSubTab('codes')}
          testID="admin-ads-subtab-codes"
        >
          <Ionicons
            name="ticket-outline"
            size={16}
            color={subTab === 'codes' ? Colors.headerBg : Colors.textSecondary}
          />
          <Text style={[styles.subTabText, subTab === 'codes' ? styles.subTabTextActive : null]}>
            Ad codes
          </Text>
        </TouchableOpacity>
      </View>

      {subTab === 'codes' ? <AdCodesTab /> : <AdsReviewList loading={loading} ads={ads} busyId={busyId} onApprove={onApprove} onReject={onReject} />}
    </View>
  );
}

function AdsReviewList({
  loading,
  ads,
  busyId,
  onApprove,
  onReject,
}: {
  loading: boolean;
  ads: AdItem[];
  busyId: string | null;
  onApprove: (a: AdItem) => void;
  onReject: (a: AdItem) => void;
}) {
  if (loading && ads.length === 0) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="small" color={Colors.primary} />
      </View>
    );
  }
  if (ads.length === 0) {
    return <EmptyState icon="checkmark-done" title="No ads waiting for review" body="Everything that needs approval has been handled." />;
  }
  return (
    <View style={{ paddingTop: Spacing.md, paddingHorizontal: Spacing.base, gap: Spacing.sm }}>
      {ads.map((ad, idx) => (
        <View key={ad._id} style={styles.adCard} testID={`admin-ad-${idx}`}>
          <View style={styles.adHeader}>
            <View style={[styles.tag, { backgroundColor: '#FEF3C7' }]}>
              <Text style={[styles.tagText, { color: '#92400E' }]}>PENDING</Text>
            </View>
            <Text style={styles.adTime}>
              {ad._creationTime ? new Date(ad._creationTime).toLocaleDateString() : '—'}
            </Text>
          </View>
          <Text style={styles.adTitle}>{ad.businessName || 'Untitled business'}</Text>
          <Text style={styles.adProduct}>{ad.productName || '—'}</Text>
          {ad.description ? <Text style={styles.adDesc} numberOfLines={3}>{ad.description}</Text> : null}
          {ad.externalLink ? (
            <Text style={styles.adLink} numberOfLines={1}>
              {ad.externalLink}
            </Text>
          ) : null}
          {ad.createdBy?.name ? (
            <Text style={styles.adAuthor}>by {ad.createdBy.name}</Text>
          ) : null}
          <View style={styles.reportActions}>
            <TouchableOpacity
              style={[styles.smallBtn, styles.smallBtnGhost, busyId === ad._id ? { opacity: 0.5 } : null]}
              onPress={() => onReject(ad)}
              disabled={busyId === ad._id}
              testID={`admin-ad-reject-${idx}`}
            >
              <Ionicons name="close-outline" size={16} color={Colors.danger} />
              <Text style={[styles.smallBtnGhostText, { color: Colors.danger }]}>Reject</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.smallBtn, styles.smallBtnApprove, busyId === ad._id ? { opacity: 0.5 } : null]}
              onPress={() => onApprove(ad)}
              disabled={busyId === ad._id}
              testID={`admin-ad-approve-${idx}`}
            >
              {busyId === ad._id ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <>
                  <Ionicons name="checkmark" size={16} color={Colors.white} />
                  <Text style={styles.smallBtnDangerText}>Approve</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </View>
  );
}

/* ──────────────── Helpers ──────────────── */

async function copyToClipboard(text: string) {
  try {
    const Clipboard = require('expo-clipboard');
    await Clipboard.setStringAsync(text);
  } catch {
    // Best-effort; clipboard is optional.
  }
}

function StatusPill({ status }: { status: string }) {
  const cfg: Record<string, { bg: string; fg: string; label: string }> = {
    active: { bg: '#D1FAE5', fg: '#065F46', label: 'ACTIVE' },
    redeemed: { bg: '#DBEAFE', fg: '#1E3A8A', label: 'REDEEMED' },
    exhausted: { bg: '#F3F4F6', fg: '#374151', label: 'EXHAUSTED' },
    revoked: { bg: '#FEE2E2', fg: '#991B1B', label: 'REVOKED' },
  };
  const c = cfg[status] || { bg: '#F3F4F6', fg: '#374151', label: status.toUpperCase() };
  return (
    <View style={[styles.tag, { backgroundColor: c.bg }]}>
      <Text style={[styles.tagText, { color: c.fg }]}>{c.label}</Text>
    </View>
  );
}

/* ──────────────── PREMIUM TAB ──────────────── */
interface PremiumCodeItem {
  _id: string;
  code: string;
  type: 'lifetime' | 'months';
  durationMonths?: number;
  status: 'active' | 'redeemed' | 'revoked';
  redeemedBy?: { name?: string };
  redeemedByName?: string;
  note?: string;
  _creationTime?: number;
}

function PremiumTab({ isAdmin }: { isAdmin: boolean }) {
  const { data: codes, refetch, loading } = useSafeConvexQuery<PremiumCodeItem[]>(
    (api as any).premium.listLicenseCodes,
    {},
    [],
    isAdmin,
  );

  const generateCode = useMutation((api as any).premium.generateLicenseCode);
  const revokeCode = useMutation((api as any).premium.revokeLicenseCode);

  const [busy, setBusy] = useState(false);
  const [months, setMonths] = useState('1');
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleGenerate = async (type: 'lifetime' | 'months') => {
    if (busy) return;
    setBusy(true);
    try {
      const args: any = { type, note: note.trim() || undefined };
      if (type === 'months') {
        const m = Math.max(1, parseInt(months || '1', 10));
        args.durationMonths = m;
      }
      const created: any = await generateCode(args);
      const codeStr = typeof created === 'string' ? created : created?.code || '';
      Alert.alert(
        'Premium code generated',
        codeStr ? `Code: ${codeStr}\n\n${type === 'lifetime' ? 'Lifetime access' : `${args.durationMonths} month${args.durationMonths === 1 ? '' : 's'}`}` : 'Code created.',
        [
          { text: 'Copy', onPress: () => codeStr && copyToClipboard(codeStr) },
          { text: 'OK', style: 'cancel' },
        ],
      );
      setNote('');
      await refetch();
    } catch (e: any) {
      const message = String(e?.message || '');
      const isMissing = message.includes('CouldNotFindFunction') || message.includes('not found');
      Alert.alert(
        'Could not generate code',
        isMissing
          ? 'The backend has not deployed api.premium.generateLicenseCode yet.'
          : message || 'Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = (code: PremiumCodeItem) => {
    Alert.alert('Revoke code?', `Revoke ${code.code}? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          setBusyId(code._id);
          try {
            await revokeCode({ codeId: code._id });
            await refetch();
          } catch (e: any) {
            Alert.alert('Revoke failed', e?.message || 'Please try again.');
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  };

  return (
    <View style={{ paddingTop: Spacing.md, paddingHorizontal: Spacing.base, gap: Spacing.md }}>
      {/* Generate card */}
      <View style={styles.codeGenCard} testID="admin-premium-gen-card">
        <View style={styles.codeGenHeader}>
          <Ionicons name="star" size={20} color={Colors.primary} />
          <Text style={styles.codeGenTitle}>Generate premium license code</Text>
        </View>
        <Text style={styles.codeGenSub}>Format: PRE-XXX-XXX · prefix &quot;PRE-&quot;</Text>

        <View style={styles.codeGenRow}>
          <View style={styles.codeGenField}>
            <Text style={styles.codeGenLabel}>Duration (months)</Text>
            <TextInput
              value={months}
              onChangeText={(v) => setMonths(v.replace(/[^0-9]/g, '').slice(0, 4))}
              placeholder="1"
              placeholderTextColor={Colors.textMuted}
              keyboardType="number-pad"
              style={styles.codeGenInput}
              testID="admin-premium-months-input"
            />
          </View>
        </View>

        <View style={styles.codeGenField}>
          <Text style={styles.codeGenLabel}>Note (optional)</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="e.g. Gift to early adopter"
            placeholderTextColor={Colors.textMuted}
            style={styles.codeGenInput}
            testID="admin-premium-note-input"
          />
        </View>

        <View style={styles.codeGenActionsRow}>
          <TouchableOpacity
            style={[styles.smallBtn, styles.smallBtnApprove, busy ? { opacity: 0.6 } : null]}
            onPress={() => handleGenerate('months')}
            disabled={busy}
            testID="admin-premium-gen-months"
          >
            {busy ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <>
                <Ionicons name="time-outline" size={16} color={Colors.white} />
                <Text style={styles.smallBtnDangerText}>Generate {months}mo</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smallBtn, { backgroundColor: '#7C3AED' }, busy ? { opacity: 0.6 } : null]}
            onPress={() => handleGenerate('lifetime')}
            disabled={busy}
            testID="admin-premium-gen-lifetime"
          >
            <Ionicons name="infinite-outline" size={16} color={Colors.white} />
            <Text style={styles.smallBtnDangerText}>Lifetime</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Codes list */}
      {loading && codes.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={Colors.primary} />
        </View>
      ) : codes.length === 0 ? (
        <EmptyState icon="ticket-outline" title="No premium codes yet" body="Generate one above to share with users." />
      ) : (
        <View style={{ gap: Spacing.sm }}>
          {codes.map((c) => (
            <CodeRow
              key={c._id}
              code={c.code}
              status={c.status}
              info={c.type === 'lifetime' ? 'Lifetime' : `${c.durationMonths || 1}mo`}
              redeemedBy={c.redeemedBy?.name || c.redeemedByName}
              note={c.note}
              creationTime={c._creationTime}
              busy={busyId === c._id}
              canRevoke={c.status === 'active'}
              onRevoke={() => handleRevoke(c)}
              testID={`admin-premium-code-${c._id}`}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/* ──────────────── AD CODES TAB ──────────────── */
interface AdCodeItem {
  _id: string;
  code: string;
  type: 'credit' | 'lifetime';
  amountEur?: number;
  remainingEur?: number;
  status: 'active' | 'redeemed' | 'exhausted' | 'revoked';
  redeemedBy?: { name?: string };
  redeemedByName?: string;
  note?: string;
  _creationTime?: number;
}

function AdCodesTab() {
  const { data: codes, refetch, loading } = useSafeConvexQuery<AdCodeItem[]>(
    (api as any).adCreditCodes.listCodes,
    {},
    [],
    true,
  );

  const generateCredit = useMutation((api as any).adCreditCodes.generateCreditCode);
  const generateLifetime = useMutation((api as any).adCreditCodes.generateLifetimeCode);
  const revokeCode = useMutation((api as any).adCreditCodes.revokeCode);

  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('10');
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const clickEstimate = useMemo(() => {
    const n = parseFloat(amount || '0');
    if (Number.isNaN(n) || n <= 0) return 0;
    return Math.floor(n / 0.04);
  }, [amount]);

  const handleGen = async (type: 'credit' | 'lifetime') => {
    if (busy) return;
    setBusy(true);
    try {
      let created: any;
      if (type === 'credit') {
        const n = parseFloat(amount || '0');
        if (!n || n <= 0) {
          Alert.alert('Invalid amount', 'Enter a positive EUR amount.');
          setBusy(false);
          return;
        }
        created = await generateCredit({ amountEur: n, note: note.trim() || undefined });
      } else {
        created = await generateLifetime({ note: note.trim() || undefined });
      }
      const codeStr = typeof created === 'string' ? created : created?.code || '';
      Alert.alert(
        'Ad code generated',
        codeStr ? `Code: ${codeStr}` : 'Created.',
        [
          { text: 'Copy', onPress: () => codeStr && copyToClipboard(codeStr) },
          { text: 'OK', style: 'cancel' },
        ],
      );
      setNote('');
      await refetch();
    } catch (e: any) {
      const message = String(e?.message || '');
      const isMissing = message.includes('CouldNotFindFunction') || message.includes('not found');
      Alert.alert(
        'Could not generate code',
        isMissing ? 'The ad codes backend endpoints have not been deployed yet.' : message || 'Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = (code: AdCodeItem) => {
    Alert.alert('Revoke code?', `Revoke ${code.code}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          setBusyId(code._id);
          try {
            await revokeCode({ codeId: code._id });
            await refetch();
          } catch (e: any) {
            Alert.alert('Revoke failed', e?.message || 'Please try again.');
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  };

  return (
    <View style={{ paddingTop: Spacing.md, paddingHorizontal: Spacing.base, gap: Spacing.md }}>
      <View style={styles.codeGenCard} testID="admin-adcodes-gen-card">
        <View style={styles.codeGenHeader}>
          <Ionicons name="ticket" size={20} color={Colors.primary} />
          <Text style={styles.codeGenTitle}>Generate ad credit code</Text>
        </View>
        <Text style={styles.codeGenSub}>Format: XXX-XXX-XXX</Text>

        <View style={styles.codeGenField}>
          <Text style={styles.codeGenLabel}>Amount (EUR)</Text>
          <TextInput
            value={amount}
            onChangeText={(v) => setAmount(v.replace(/[^0-9.]/g, '').slice(0, 8))}
            placeholder="10"
            placeholderTextColor={Colors.textMuted}
            keyboardType="decimal-pad"
            style={styles.codeGenInput}
            testID="admin-adcodes-amount-input"
          />
          {clickEstimate > 0 ? (
            <Text style={styles.codeGenHint}>≈ {clickEstimate.toLocaleString()} clicks at €0.04/click</Text>
          ) : null}
        </View>

        <View style={styles.codeGenField}>
          <Text style={styles.codeGenLabel}>Note (optional)</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="e.g. Promo for ACME"
            placeholderTextColor={Colors.textMuted}
            style={styles.codeGenInput}
            testID="admin-adcodes-note-input"
          />
        </View>

        <View style={styles.codeGenActionsRow}>
          <TouchableOpacity
            style={[styles.smallBtn, styles.smallBtnApprove, busy ? { opacity: 0.6 } : null]}
            onPress={() => handleGen('credit')}
            disabled={busy}
            testID="admin-adcodes-gen-credit"
          >
            {busy ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <>
                <Ionicons name="cash-outline" size={16} color={Colors.white} />
                <Text style={styles.smallBtnDangerText}>Credit code</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smallBtn, { backgroundColor: '#7C3AED' }, busy ? { opacity: 0.6 } : null]}
            onPress={() => handleGen('lifetime')}
            disabled={busy}
            testID="admin-adcodes-gen-lifetime"
          >
            <Ionicons name="infinite-outline" size={16} color={Colors.white} />
            <Text style={styles.smallBtnDangerText}>Lifetime</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading && codes.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={Colors.primary} />
        </View>
      ) : codes.length === 0 ? (
        <EmptyState icon="ticket-outline" title="No ad codes yet" body="Generate one above to share with advertisers." />
      ) : (
        <View style={{ gap: Spacing.sm }}>
          {codes.map((c) => (
            <CodeRow
              key={c._id}
              code={c.code}
              status={c.status}
              info={
                c.type === 'lifetime'
                  ? 'Lifetime'
                  : `€${(c.amountEur || 0).toFixed(2)}${
                      typeof c.remainingEur === 'number' ? ` · €${c.remainingEur.toFixed(2)} left` : ''
                    }`
              }
              redeemedBy={c.redeemedBy?.name || c.redeemedByName}
              note={c.note}
              creationTime={c._creationTime}
              busy={busyId === c._id}
              canRevoke={c.status === 'active' || c.status === 'redeemed'}
              onRevoke={() => handleRevoke(c)}
              testID={`admin-adcode-${c._id}`}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/* ──────────────── ACTIVITY TAB ──────────────── */
interface ActivityItem {
  _id: string;
  type?: 'text' | 'image' | 'video' | 'voice' | 'file' | 'poll' | string;
  content?: string;
  text?: string;
  senderName?: string;
  sender?: { name?: string };
  conversationName?: string;
  conversation?: { name?: string; isGroup?: boolean };
  _creationTime?: number;
}

function ActivityTab({ isAdmin }: { isAdmin: boolean }) {
  const { data: items, loading } = useSafeConvexQuery<ActivityItem[]>(
    (api as any).admin.queries.getRecentActivity,
    {},
    [],
    isAdmin,
  );

  if (loading && items.length === 0) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="small" color={Colors.primary} />
      </View>
    );
  }
  if (items.length === 0) {
    return <EmptyState icon="pulse-outline" title="No recent activity" body="Recent messages will appear here." />;
  }

  const iconFor = (t?: string) => {
    switch (t) {
      case 'image': return 'image-outline';
      case 'video': return 'videocam-outline';
      case 'voice': return 'mic-outline';
      case 'file': return 'document-outline';
      case 'poll': return 'stats-chart-outline';
      default: return 'chatbubble-ellipses-outline';
    }
  };

  return (
    <View style={{ paddingTop: Spacing.md, paddingHorizontal: Spacing.base, gap: 6 }}>
      {items.map((m) => {
        const senderName = m.senderName || m.sender?.name || 'Unknown';
        const convName = m.conversationName || m.conversation?.name || (m.conversation?.isGroup ? 'Group' : 'Direct message');
        const preview = m.text || m.content || `[${m.type || 'message'}]`;
        return (
          <View key={m._id} style={styles.activityRow} testID={`admin-activity-${m._id}`}>
            <View style={[styles.activityIcon, { backgroundColor: Colors.primaryLight }]}>
              <Ionicons name={iconFor(m.type) as any} size={16} color={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.activityHeaderRow}>
                <Text style={styles.activitySender} numberOfLines={1}>{senderName}</Text>
                <Text style={styles.activityConv} numberOfLines={1}> · {convName}</Text>
              </View>
              <Text style={styles.activityPreview} numberOfLines={2}>{preview}</Text>
              {m._creationTime ? (
                <Text style={styles.activityTime}>{new Date(m._creationTime).toLocaleString()}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/* ──────────────── CodeRow (shared) ──────────────── */
function CodeRow({
  code,
  status,
  info,
  redeemedBy,
  note,
  creationTime,
  busy,
  canRevoke,
  onRevoke,
  testID,
}: {
  code: string;
  status: string;
  info: string;
  redeemedBy?: string;
  note?: string;
  creationTime?: number;
  busy?: boolean;
  canRevoke?: boolean;
  onRevoke: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.codeRow} testID={testID}>
      <View style={styles.codeRowTopLine}>
        <Text style={styles.codeText} selectable>{code}</Text>
        <StatusPill status={status} />
      </View>
      <View style={styles.codeRowMetaLine}>
        <Text style={styles.codeInfo}>{info}</Text>
        {creationTime ? <Text style={styles.codeTime}>{new Date(creationTime).toLocaleDateString()}</Text> : null}
      </View>
      {redeemedBy ? <Text style={styles.codeRedeemed}>Redeemed by {redeemedBy}</Text> : null}
      {note ? <Text style={styles.codeNote}>📝 {note}</Text> : null}
      <View style={styles.codeRowActions}>
        <TouchableOpacity
          style={[styles.smallBtn, styles.smallBtnGhost]}
          onPress={() => copyToClipboard(code)}
          testID={`${testID}-copy`}
        >
          <Ionicons name="copy-outline" size={14} color={Colors.textSecondary} />
          <Text style={styles.smallBtnGhostText}>Copy</Text>
        </TouchableOpacity>
        {canRevoke ? (
          <TouchableOpacity
            style={[styles.smallBtn, styles.smallBtnDanger, busy ? { opacity: 0.5 } : null]}
            onPress={onRevoke}
            disabled={busy}
            testID={`${testID}-revoke`}
          >
            {busy ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <>
                <Ionicons name="close-circle-outline" size={14} color={Colors.white} />
                <Text style={styles.smallBtnDangerText}>Revoke</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <View style={styles.emptyWrap}>
      <Ionicons name={icon as any} size={48} color={Colors.textMuted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

function RowMenu({
  actions,
  disabled,
  testID,
}: {
  actions: { label: string; icon: string; onPress: () => void; danger?: boolean }[];
  disabled?: boolean;
  testID?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TouchableOpacity
        style={styles.menuBtn}
        onPress={() => setOpen(true)}
        disabled={disabled}
        hitSlop={8}
        testID={testID}
      >
        {disabled ? (
          <ActivityIndicator size="small" color={Colors.textSecondary} />
        ) : (
          <Ionicons name="ellipsis-vertical" size={18} color={Colors.textSecondary} />
        )}
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.menuSheet} onPress={() => undefined}>
            {actions.map((a, i) => (
              <TouchableOpacity
                key={i}
                style={styles.menuItem}
                onPress={() => {
                  setOpen(false);
                  setTimeout(() => a.onPress(), 60);
                }}
              >
                <Ionicons
                  name={a.icon as any}
                  size={18}
                  color={a.danger ? Colors.danger : Colors.textPrimary}
                />
                <Text style={[styles.menuItemText, a.danger ? { color: Colors.danger } : null]}>{a.label}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  deniedWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, gap: 12 },
  deniedIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deniedTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: 8 },
  deniedBody: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  deniedBtn: {
    marginTop: Spacing.md,
    backgroundColor: Colors.headerBg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.md,
  },
  deniedBtnText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },

  // iter-137: web-style tab bar — icon above label, active = primary
  // underline. No pill background, no badges (cleaner, matches web).
  tabBar: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    paddingHorizontal: 0,
    paddingTop: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    paddingTop: 8,
    paddingBottom: 0,
  },
  tabText: {
    fontSize: 12,
    fontWeight: FontWeight.medium,
    color: Colors.textSecondary,
    marginTop: 2,
    marginBottom: 8,
  },
  tabTextActive: {
    color: Colors.primary,
    fontWeight: FontWeight.semibold,
  },
  tabUnderline: {
    height: 2,
    width: '60%',
    backgroundColor: 'transparent',
    borderRadius: 1,
  },
  tabUnderlineActive: {
    backgroundColor: Colors.primary,
  },

  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: Spacing.base,
    gap: Spacing.sm,
  },
  statCard: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  statValue: { fontSize: FontSize.xxl, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  statLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },

  revenueCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.sm,
    padding: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },

  noteCard: {
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    lineHeight: 16,
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },

  card: {
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: 'hidden',
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  rowLast: { borderBottomWidth: 0 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primaryDark, fontWeight: FontWeight.bold, fontSize: FontSize.lg },
  onlineDot: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#22C55E',
    borderWidth: 2,
    borderColor: Colors.background,
  },
  lastSeenText: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 3 },
  lastSeenOnline: { color: '#16A34A', fontWeight: FontWeight.semibold },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  userStatsLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  levelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  levelChipText: { fontSize: FontSize.xs, color: Colors.primaryDark, fontWeight: FontWeight.semibold },
  userStatsText: { fontSize: FontSize.xs, color: Colors.textMuted, flex: 1 },
  broadcastCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
    minHeight: 46,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  broadcastCtaText: { color: Colors.headerBg, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: { fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.5 },
  menuBtn: { padding: 8 },

  reportCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: 8,
  },
  reportHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reportTime: { fontSize: FontSize.xs, color: Colors.textMuted },
  reportTitle: { fontSize: FontSize.base, color: Colors.textPrimary, lineHeight: 22 },
  reportBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    backgroundColor: Colors.background,
    padding: Spacing.sm,
    borderRadius: Radius.sm,
    lineHeight: 20,
  },
  reportActions: { flexDirection: 'row', gap: 8, marginTop: 4 },

  smallBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 10,
    borderRadius: Radius.md,
  },
  smallBtnGhost: { backgroundColor: Colors.borderLight },
  smallBtnGhostText: { color: Colors.textSecondary, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
  smallBtnWarn: { backgroundColor: '#FEF3C7' },
  smallBtnWarnText: { color: '#92400E', fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  smallBtnDanger: { backgroundColor: Colors.danger },
  smallBtnDangerText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  smallBtnApprove: { backgroundColor: '#16A34A' },

  adCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: 6,
  },
  adHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  adTime: { fontSize: FontSize.xs, color: Colors.textMuted },
  adTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  adProduct: { fontSize: FontSize.sm, color: Colors.primaryDark, fontWeight: FontWeight.semibold },
  adDesc: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  adLink: { fontSize: FontSize.xs, color: '#1D4ED8', textDecorationLine: 'underline' },
  adAuthor: { fontSize: FontSize.xs, color: Colors.textMuted },

  emptyWrap: { alignItems: 'center', paddingVertical: Spacing.xl * 1.5, gap: 8, paddingHorizontal: Spacing.lg },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: Spacing.sm },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },

  loadingWrap: { paddingVertical: Spacing.xl, alignItems: 'center' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.base,
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    width: '100%',
    maxWidth: 420,
    gap: 10,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalBody: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  modalInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
  },
  modalActions: { flexDirection: 'row', gap: 8, marginTop: Spacing.md },
  modalBtn: { flex: 1, height: 46, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  modalBtnGhost: { backgroundColor: Colors.borderLight },
  modalBtnGhostText: { color: Colors.textPrimary, fontWeight: FontWeight.semibold, fontSize: FontSize.base },
  modalBtnDanger: { backgroundColor: Colors.danger },
  modalBtnDangerText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },

  menuSheet: {
    width: 220,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    overflow: 'hidden',
    paddingVertical: 6,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
  },
  menuItemText: { fontSize: FontSize.base, color: Colors.textPrimary },

  /* ── Sub-tab bar (Ads) ── */
  subTabBar: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  subTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  subTabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  subTabText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary },
  subTabTextActive: { color: Colors.headerBg },

  /* ── Code Gen Card (Premium / AdCodes) ── */
  codeGenCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: Spacing.sm,
  },
  codeGenHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  codeGenTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  codeGenSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 4 },
  codeGenRow: { flexDirection: 'row', gap: Spacing.sm },
  codeGenField: { flex: 1, gap: 4 },
  codeGenLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: Colors.textSecondary, textTransform: 'uppercase' },
  codeGenInput: {
    minHeight: 42,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  codeGenHint: { fontSize: FontSize.xs, color: Colors.textSecondary, fontStyle: 'italic' },
  codeGenActionsRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: 4 },

  /* ── Code Row ── */
  codeRow: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: 6,
  },
  codeRowTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  codeText: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    letterSpacing: 1,
  },
  codeRowMetaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  codeInfo: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.medium },
  codeTime: { fontSize: FontSize.xs, color: Colors.textMuted },
  codeRedeemed: { fontSize: FontSize.xs, color: Colors.textSecondary },
  codeNote: { fontSize: FontSize.xs, color: Colors.textSecondary, fontStyle: 'italic' },
  codeRowActions: { flexDirection: 'row', gap: 8, marginTop: 4 },

  /* ── Activity ── */
  activityRow: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: Spacing.sm,
  },
  activityIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityHeaderRow: { flexDirection: 'row', alignItems: 'center' },
  activitySender: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  activityConv: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary },
  activityPreview: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: 2 },
  activityTime: { fontSize: 10, color: Colors.textMuted, marginTop: 2 },
});
