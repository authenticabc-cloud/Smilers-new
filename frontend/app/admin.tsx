import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
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

type Tab = 'overview' | 'users' | 'reports' | 'ads';

interface Stats {
  totalUsers?: number;
  activeUsersToday?: number;
  newUsersThisWeek?: number;
  pendingReports?: number;
  pendingAds?: number;
  adRevenueEur?: number;
  suspendedUsers?: number;
}

interface UserItem {
  _id: string;
  name?: string;
  email?: string;
  phone?: string;
  role?: 'admin' | 'user';
  status?: 'active' | 'suspended';
  _creationTime?: number;
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

  // Queries (enabled only for admins to avoid Convex errors).
  const { data: stats, refetch: refetchStats } = useSafeConvexQuery<Stats>(
    api.admin.getStats,
    {},
    {},
    isAdmin,
  );
  const [userSearch, setUserSearch] = useState('');
  const { data: users, refetch: refetchUsers, loading: usersLoading } = useSafeConvexQuery<UserItem[]>(
    api.admin.listUsers,
    { search: userSearch.trim() },
    [],
    isAdmin,
  );
  const { data: reports, refetch: refetchReports, loading: reportsLoading } = useSafeConvexQuery<ReportItem[]>(
    api.admin.listReports,
    { status: 'pending' },
    [],
    isAdmin,
  );
  const { data: pendingAds, refetch: refetchAds, loading: adsLoading } = useSafeConvexQuery<AdItem[]>(
    api.ads.listPendingForReview,
    {},
    [],
    isAdmin,
  );

  const setRole = useMutation(api.admin.setRole);
  const suspendUser = useMutation(api.admin.suspendUser);
  const unsuspendUser = useMutation(api.admin.unsuspendUser);
  const resolveReport = useMutation(api.admin.resolveReport);
  const approveAd = useMutation(api.ads.approveAd);
  const rejectAd = useMutation(api.ads.rejectAd);

  const [tab, setTab] = useState<Tab>('overview');
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
    { key: 'ads', label: 'Ads', icon: 'megaphone-outline', badge: stats?.pendingAds || pendingAds?.length },
  ];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="admin-screen">
      <Header
        title="Admin Dashboard"
        subtitle={me?.name ? `Signed in as ${me.name}` : 'Admin'}
        showBack
        onBack={() => router.back()}
        variant="dark"
      />

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, active ? styles.tabActive : null]}
              onPress={() => setTab(t.key)}
              testID={`admin-tab-${t.key}`}
            >
              <Ionicons name={t.icon as any} size={18} color={active ? Colors.headerBg : Colors.textSecondary} />
              <Text style={[styles.tabText, active ? styles.tabTextActive : null]} numberOfLines={1}>
                {t.label}
              </Text>
              {typeof t.badge === 'number' && t.badge > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{t.badge > 99 ? '99+' : t.badge}</Text>
                </View>
              ) : null}
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
          />
        ) : null}
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
  const cards = [
    { label: 'Total users', value: stats?.totalUsers, icon: 'people-outline', tone: Colors.primary, accent: Colors.primaryLight },
    { label: 'Active today', value: stats?.activeUsersToday, icon: 'pulse-outline', tone: '#10B981', accent: '#D1FAE5' },
    { label: 'New this week', value: stats?.newUsersThisWeek, icon: 'person-add-outline', tone: '#0EA5E9', accent: '#DBEAFE' },
    { label: 'Pending reports', value: stats?.pendingReports, icon: 'flag-outline', tone: Colors.danger, accent: '#FEE2E2' },
    { label: 'Pending ads', value: stats?.pendingAds, icon: 'megaphone-outline', tone: '#F59E0B', accent: '#FEF3C7' },
    { label: 'Suspended', value: stats?.suspendedUsers, icon: 'ban-outline', tone: '#6B7280', accent: '#F3F4F6' },
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

      {typeof stats?.adRevenueEur === 'number' ? (
        <View style={styles.revenueCard}>
          <View style={[styles.statIcon, { backgroundColor: Colors.primaryLight }]}>
            <Ionicons name="cash-outline" size={22} color={Colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.statLabel}>Ad revenue this month</Text>
            <Text style={styles.statValue}>€{(stats.adRevenueEur || 0).toFixed(2)}</Text>
          </View>
        </View>
      ) : null}

      <Text style={styles.noteCard}>
        Stats are read from{' '}
        <Text style={{ fontWeight: FontWeight.bold }}>api.admin.getStats</Text>. Missing values mean that field isn’t
        returned by the backend yet — no action needed on the mobile side.
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
}: {
  search: string;
  onSearch: (v: string) => void;
  loading: boolean;
  users: UserItem[];
  busyId: string | null;
  onToggleSuspend: (u: UserItem) => void;
  onToggleAdmin: (u: UserItem) => void;
}) {
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

      {loading && users.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={Colors.primary} />
        </View>
      ) : users.length === 0 ? (
        <EmptyState icon="people-outline" title="No users" body="Try a different search term." />
      ) : (
        <View style={styles.card}>
          {users.map((u, idx) => (
            <View
              key={u._id}
              style={[styles.userRow, idx === users.length - 1 ? styles.rowLast : null]}
              testID={`admin-user-${idx}`}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(u.name || u.email || '?').charAt(0).toUpperCase()}</Text>
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
              </View>
              <RowMenu
                disabled={busyId === u._id}
                actions={[
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

  tabBar: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: Colors.background,
    minHeight: 38,
  },
  tabActive: { backgroundColor: Colors.primary },
  tabText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: Colors.textSecondary },
  tabTextActive: { color: Colors.headerBg },
  tabBadge: {
    backgroundColor: Colors.danger,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 16,
    alignItems: 'center',
  },
  tabBadgeText: { color: Colors.white, fontSize: 9, fontWeight: FontWeight.bold },

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
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
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
});
