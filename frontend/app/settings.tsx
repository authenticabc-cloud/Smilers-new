import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useServerStatus } from '../src/hooks/useServerStatus';
import { Colors, FontSize, FontWeight, Spacing } from '../src/theme';

type IconLib = 'ion' | 'mc';
type Row = {
  key: string;
  route: string;
  title: string;
  sub: string;
  icon: string;
  lib: IconLib;
  danger?: boolean;
  /** Green accent (e.g. Earnings) — mirrors how `danger` renders red. */
  success?: boolean;
  adminOnly?: boolean;
  /**
   * iter-173 — mirrors the web app's "👑 Premium" badge next to gated
   * features. The screen these point to is wrapped in <PremiumGate>,
   * so the badge is purely visual cue, not a hard gate.
   */
  premium?: boolean;
};

const ITEMS: Row[] = [
  // iter-176: 'Diagnostic Logs' row was removed for production publish.
  // iter-214: briefly re-enabled for triaging push/loading regressions.
  // 2026-07-06: hidden again for the Play Store launch (user request). The
  // /diagnostic-logs and /call-diagnostics routes still exist and can be
  // reached directly or re-listed here later if needed.
  { key: 'lockscreen-wake', route: '/lockscreen-wake', title: 'Lockscreen Wake', sub: 'Allow incoming calls to wake the locked screen', icon: 'cellphone-screenshot', lib: 'mc' },
  { key: 'privacy', route: '/privacy', title: 'Privacy', sub: 'Last seen, profile photo, about', icon: 'shield-outline', lib: 'ion' },
  { key: 'app-lock', route: '/app-lock', title: 'App Lock', sub: 'PIN code and biometric unlock', icon: 'fingerprint', lib: 'mc' },
  { key: 'face-id', route: '/face-id', title: 'Face ID', sub: 'Verify identity on new devices', icon: 'face-recognition', lib: 'mc', premium: true },
  { key: 'desktop-login', route: '/approve-login', title: 'Approve Desktop Login', sub: 'Approve or scan a sign-in on your computer', icon: 'monitor-lock', lib: 'mc' },
  { key: 'notifications', route: '/notifications', title: 'Notifications', sub: 'Message, group, and call alerts', icon: 'notifications-outline', lib: 'ion' },
  { key: 'call-recording', route: '/call-recording', title: 'Call Recording', sub: 'Auto-record voice & video calls with exceptions', icon: 'record-rec', lib: 'mc' },
  { key: 'admin', route: '/admin', title: 'Admin Dashboard', sub: 'Manage users, reports, and app data', icon: 'crown-outline', lib: 'mc', adminOnly: true },
  { key: 'earnings', route: '/earnings', title: 'Earnings', sub: 'Levels, engagements, and referrals', icon: 'gift-outline', lib: 'ion', success: true },
  { key: 'blocked', route: '/blocked', title: 'Blocked Users', sub: 'Manage your block list', icon: 'ban-outline', lib: 'ion', danger: true },
  { key: 'scheduled', route: '/scheduled', title: 'Scheduled Messages', sub: 'View and manage scheduled messages', icon: 'time-outline', lib: 'ion' },
  { key: 'screen-share', route: '/screen-share', title: 'Share Screen', sub: 'Share your screen with another user, even outside a call', icon: 'monitor-share', lib: 'mc' },
  { key: 'quick-replies', route: '/templates', title: 'Quick Replies', sub: 'Create and manage message templates', icon: 'message-text-outline', lib: 'mc' },
  { key: 'chat-appearance', route: '/chat-appearance', title: 'Chat Appearance', sub: 'Wallpapers and bubble themes', icon: 'brush-outline', lib: 'ion' },
  { key: 'media-auto-download', route: '/media-auto-download', title: 'Media Auto-Download', sub: 'Auto-save photos, videos, audio & docs to your device', icon: 'cloud-download-outline', lib: 'ion' },
  { key: 'photo-privacy', route: '/photo-privacy', title: 'Profile Photo Privacy', sub: 'Choose who can save your profile photo', icon: 'lock-closed-outline', lib: 'ion' },
  { key: 'languages', route: '/languages', title: 'Languages', sub: 'Select languages to skip translation', icon: 'globe-outline', lib: 'ion' },
  { key: 'ringtones', route: '/ringtones', title: 'Ringtones', sub: 'Choose your incoming call ringtone', icon: 'musical-notes-outline', lib: 'ion' },
  { key: 'backup', route: '/backup', title: 'Backup & Storage', sub: 'Auto backup and frequency settings', icon: 'server-outline', lib: 'ion' },
  { key: 'voice-tasks', route: '/voice-tasks', title: 'Voice Tasks', sub: 'Hands-free voice commands for contacts', icon: 'mic-outline', lib: 'ion', premium: true },
  { key: 'trustees', route: '/trustees', title: 'Trustees', sub: 'Manage your emergency contacts (max 5)', icon: 'shield-checkmark-outline', lib: 'ion' },
  { key: 'emergency', route: '/emergency', title: 'Emergency', sub: 'Alert your trustees in an emergency', icon: 'alert-circle-outline', lib: 'ion', danger: true, premium: true },
  { key: 'chat-once', route: '/chat-once', title: 'Chat Once', sub: 'Temporary anonymous conversations', icon: 'message-circle', lib: 'mc', premium: true },
  { key: 'help', route: '/help', title: 'Help & Support', sub: 'FAQs, contact support team', icon: 'help-circle-outline', lib: 'ion' },
  { key: 'server-status', route: '/server-status', title: 'Server Status', sub: 'Backend health, version & integrations', icon: 'pulse-outline', lib: 'ion' },
  { key: 'account', route: '/account', title: 'Account', sub: 'Sign out, delete account', icon: 'lock-closed-outline', lib: 'ion', danger: true },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const me: any = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const isAdmin = me?.role === 'admin';
  const visibleItems = ITEMS.filter((item) => !item.adminOnly || isAdmin);
  const { status: serverStatus } = useServerStatus();
  const isDegraded = serverStatus?.status === 'degraded';

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="settings-screen">
      <Header title="Settings" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {isDegraded ? (
          <TouchableOpacity
            style={styles.degradedBanner}
            activeOpacity={0.8}
            testID="settings-degraded-banner"
            onPress={() => router.push('/server-status' as any)}
          >
            <Ionicons name="alert-circle" size={20} color={Colors.danger} />
            <Text style={styles.degradedText}>Some services are degraded — tap for details</Text>
            <Feather name="chevron-right" size={18} color={Colors.danger} />
          </TouchableOpacity>
        ) : null}
        {visibleItems.map((item) => (
          <TouchableOpacity
            key={item.key}
            style={styles.row}
            activeOpacity={0.7}
            testID={`settings-${item.key}`}
            onPress={() => router.push(item.route as any)}
          >
            <View style={[styles.iconWrap, item.danger ? { backgroundColor: '#FEE2E2' } : item.success ? { backgroundColor: '#DCFCE7' } : undefined]}>
              {item.lib === 'mc' ? (
                <MaterialCommunityIcons
                  name={item.icon as any}
                  size={22}
                  color={item.danger ? Colors.danger : item.success ? '#16A34A' : Colors.primary}
                />
              ) : (
                <Ionicons
                  name={item.icon as any}
                  size={22}
                  color={item.danger ? Colors.danger : item.success ? '#16A34A' : Colors.primary}
                />
              )}
            </View>
            <View style={styles.rowMid}>
              <View style={styles.titleRow}>
                <Text style={[styles.rowTitle, item.danger ? { color: Colors.danger } : item.success ? { color: '#16A34A' } : null]}>{item.title}</Text>
                {item.premium ? (
                  <View style={styles.premiumBadge} testID={`settings-premium-${item.key}`}>
                    <MaterialCommunityIcons name="crown-outline" size={11} color={Colors.primaryDark} />
                    <Text style={styles.premiumBadgeText}>Premium</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.rowSub}>{item.sub}</Text>
            </View>
            <Feather name="chevron-right" size={22} color={Colors.textMuted} />
          </TouchableOpacity>
        ))}
        <View style={styles.footer}>
          <Text style={styles.footerVersion}>Smilers v1.0</Text>
          <Text style={styles.footerTag}>Built with love</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  degradedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: Spacing.base,
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#FEE2E2',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.danger,
  },
  degradedText: { flex: 1, fontSize: FontSize.sm, color: Colors.danger, fontWeight: FontWeight.semibold },
  // iter-142: bring Settings rows visually in line with the web app.
  //  • Bumped title to 17 (web uses ~17/18 px bold).
  //  • Lowered divider opacity so the page reads as a continuous
  //    cream surface like the web rather than a list of boxed rows.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 16,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(60, 40, 0, 0.08)',
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMid: { flex: 1 },
  // iter-173: row title now sits in a flex row alongside the optional
  // Premium badge — matches the web app treatment.
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  // Small gold-on-cream pill with a crown glyph. Mirrors the web app's
  // "👑 Premium" badge sitting next to gated feature names.
  premiumBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: Colors.primaryLight,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.primary,
  },
  premiumBadgeText: {
    fontSize: 11,
    fontWeight: FontWeight.bold,
    color: Colors.primaryDark,
    letterSpacing: 0.2,
  },
  rowSub: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 3,
  },
  footer: { alignItems: 'center', paddingVertical: Spacing.xl, gap: 4 },
  footerVersion: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  footerTag: { fontSize: FontSize.xs, color: Colors.textMuted },
});
