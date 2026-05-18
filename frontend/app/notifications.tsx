import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { requestPushDiagnosticsRetry, usePushDiagnostics } from '../src/push/pushDiagnostics';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

const ITEMS = [
  { key: 'messages', title: 'Messages', subtitle: 'New chat messages' },
  { key: 'groups', title: 'Groups', subtitle: 'Group messages and mentions' },
  { key: 'calls', title: 'Calls', subtitle: 'Incoming voice and video calls' },
  { key: 'statuses', title: 'Statuses', subtitle: 'New stories from your contacts' },
  { key: 'reactions', title: 'Reactions', subtitle: 'When someone reacts to your messages' },
  { key: 'mentions', title: 'Mentions', subtitle: 'When you are @mentioned' },
];

export default function NotificationsScreen() {
  const router = useRouter();
  const { data: me, refetch } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null);
  const updateProfile = useMutation(api.users.updateProfile);
  const pushDiagnostics = usePushDiagnostics();
  const notifications = (me?.notifications || {}) as Record<string, boolean | undefined>;
  const canEdit = !!me;
  const [retrying, setRetrying] = useState(false);

  const toggle = useCallback(
    async (key: string, value: boolean) => {
      if (!me) {
        return;
      }
      try {
        await updateProfile({ notifications: { ...notifications, [key]: value } });
        await refetch();
      } catch (errorValue: any) {
        console.warn('Failed to update notification', errorValue);
      }
    },
    [me, notifications, refetch, updateProfile]
  );

  const tokenPreview = useMemo(() => {
    if (!pushDiagnostics.expoPushToken) {
      return 'Not available yet';
    }
    if (pushDiagnostics.expoPushToken.length <= 34) {
      return pushDiagnostics.expoPushToken;
    }
    return `${pushDiagnostics.expoPushToken.slice(0, 24)}…${pushDiagnostics.expoPushToken.slice(-8)}`;
  }, [pushDiagnostics.expoPushToken]);

  const retryPushRegistration = useCallback(async () => {
    setRetrying(true);
    try {
      await requestPushDiagnosticsRetry();
    } catch (errorValue: any) {
      console.warn('Push retry failed', errorValue);
    } finally {
      setRetrying(false);
    }
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="notifications-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="notifications-back-button">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} testID="notifications-header-title">
          Notifications
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content} testID="notifications-scroll-view">
        <Text style={styles.note} testID="notifications-note">
          Choose which notifications you want to receive on this device.
        </Text>
        {!canEdit ? (
          <Text style={styles.helper} testID="notifications-auth-helper">
            Sign in to change notification preferences.
          </Text>
        ) : null}

        <View style={styles.diagnosticsCard} testID="push-diagnostics-card">
          <View style={styles.diagnosticsHeaderRow}>
            <View style={styles.diagnosticsHeaderTextWrap}>
              <Text style={styles.diagnosticsTitle} testID="push-diagnostics-title">Push diagnostics</Text>
              <Text style={styles.diagnosticsSubtitle} testID="push-diagnostics-subtitle">
                Helps confirm token registration on this device.
              </Text>
            </View>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={retryPushRegistration}
              disabled={retrying || !pushDiagnostics.retryAvailable}
              testID="push-diagnostics-retry-button"
            >
              {retrying ? (
                <ActivityIndicator size="small" color={Colors.headerBg} />
              ) : (
                <Text style={styles.retryButtonText}>{pushDiagnostics.retryAvailable ? 'Retry' : 'Native only'}</Text>
              )}
            </TouchableOpacity>
          </View>

          <DiagnosticRow label="Status" value={pushDiagnostics.registrationStatus} testID="push-diagnostics-status" />
          <DiagnosticRow label="Auth session" value={pushDiagnostics.authSessionReady ? 'ready' : 'missing'} testID="push-diagnostics-auth-session" />
          <DiagnosticRow label="Convex auth" value={pushDiagnostics.convexAuthReady ? 'ready' : pushDiagnostics.convexAuthLoading ? 'loading' : 'not ready'} testID="push-diagnostics-convex-auth" />
          <DiagnosticRow label="projectId" value={pushDiagnostics.projectId || 'missing'} testID="push-diagnostics-project-id" />
          <DiagnosticRow label="Permission" value={pushDiagnostics.permissionStatus} testID="push-diagnostics-permission" />
          <DiagnosticRow label="Physical device" value={pushDiagnostics.isPhysicalDevice === null ? 'unknown' : pushDiagnostics.isPhysicalDevice ? 'yes' : 'no'} testID="push-diagnostics-physical-device" />
          <DiagnosticRow label="Push token" value={tokenPreview} testID="push-diagnostics-token" multiline />
          <DiagnosticRow label="Last registered" value={pushDiagnostics.lastRegisteredAt || 'Not yet'} testID="push-diagnostics-last-registered" multiline />
          <DiagnosticRow label="Last error" value={pushDiagnostics.lastError || 'None'} testID="push-diagnostics-last-error" multiline />
        </View>

        {ITEMS.map((item) => (
          <View key={item.key} style={styles.row} testID={`notifications-row-${item.key}`}>
            <View style={styles.flexOne}>
              <Text style={styles.rowTitle} testID={`notifications-title-${item.key}`}>
                {item.title}
              </Text>
              <Text style={styles.rowSub} testID={`notifications-subtitle-${item.key}`}>
                {item.subtitle}
              </Text>
            </View>
            <Switch
              value={notifications[item.key] !== false}
              onValueChange={(value) => toggle(item.key, value)}
              trackColor={{ true: Colors.primary, false: '#cccccc' }}
              disabled={!canEdit}
              testID={`notifications-switch-${item.key}`}
            />
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function DiagnosticRow({ label, value, testID, multiline = false }: { label: string; value: string; testID: string; multiline?: boolean }) {
  return (
    <View style={styles.diagnosticRow} testID={testID}>
      <Text style={styles.diagnosticLabel}>{label}</Text>
      <Text style={styles.diagnosticValue} numberOfLines={multiline ? undefined : 1}>
        {value}
      </Text>
    </View>
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
  note: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.base, lineHeight: 18 },
  helper: { fontSize: FontSize.sm, color: Colors.textMuted, marginBottom: Spacing.base },
  diagnosticsCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    marginBottom: Spacing.lg,
    ...Shadow.sm,
  },
  diagnosticsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: Spacing.base,
    marginBottom: Spacing.sm,
  },
  diagnosticsHeaderTextWrap: { flex: 1, minWidth: 180 },
  diagnosticsTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  diagnosticsSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  retryButton: {
    minWidth: 96,
    minHeight: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.base,
    alignSelf: 'flex-start',
  },
  retryButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.headerBg },
  diagnosticRow: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#00000011',
  },
  diagnosticLabel: { fontSize: FontSize.sm, color: Colors.textMuted, marginBottom: 4 },
  diagnosticValue: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000011',
  },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  content: { padding: Spacing.base },
  flexOne: { flex: 1 },
});