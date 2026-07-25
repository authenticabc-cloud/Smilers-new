import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Notifications from 'expo-notifications';
import { requestPushDiagnosticsRetry, usePushDiagnostics } from '../src/push/pushDiagnostics';
import { describePushProjectMismatch } from '../src/push/usePushNotifications';
import { triggerEmergentSelfTestPush } from '../src/push/useEmergentPush';
import { useAuth } from '../src/providers/AuthProvider';
import {
  loadNotificationPrefs,
  saveNotificationPref,
  type NotificationPrefs,
} from '../src/push/notificationPrefs';
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
  const { userInfo } = useAuth();
  const pushDiagnostics = usePushDiagnostics();

  // Per-DEVICE notification prefs, stored locally (see notificationPrefs.ts).
  // Not on the Convex profile — that caused a `users:updateProfile` Server
  // Error and the toggles are device-scoped ("...on this device") anyway.
  const [prefs, setPrefs] = useState<NotificationPrefs>({});
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    loadNotificationPrefs().then((p) => {
      if (!cancelled) {
        setPrefs(p);
        setPrefsLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const canEdit = prefsLoaded;
  const isOn = useCallback((key: string) => prefs[key] !== false, [prefs]);
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [runningLocalTest, setRunningLocalTest] = useState(false);
  const [runningRemoteTest, setRunningRemoteTest] = useState(false);
  const [localTestResult, setLocalTestResult] = useState('Not run yet');
  const [remoteTestResult, setRemoteTestResult] = useState('Not run yet');
  // iter-128b: independent legacy-path diagnostic. Bypasses our FastAPI
  // + Emergent relay entirely and hits Expo's exp.host directly with
  // the device's Expo push token. This is the EXACT path Emergent
  // Support's "we uploaded FCM credentials" fix targets, so a green
  // result here means their fix took effect. Critical for diagnosing
  // DeviceNotRegistered / InvalidCredentials / MismatchSenderId errors
  // without me having to run curl from a terminal.
  const [runningLegacyTest, setRunningLegacyTest] = useState(false);
  const [legacyTestResult, setLegacyTestResult] = useState('Not run yet');
  // iter-116: prominent warning shown if the runtime projectId baked
  // into the installed APK doesn't match the Expo project where the
  // FCM v1 credentials are uploaded. Caught instantly without needing
  // the user to share screenshots / share Expo Receipt error text.
  const projectMismatchWarning = useMemo(() => describePushProjectMismatch(), []);

  const toggle = useCallback(
    async (key: string, value: boolean) => {
      // Optimistic + instant local persistence. No network, so it can't fail
      // with a Convex Server Error anymore.
      setPrefs((prev) => ({ ...prev, [key]: value }));
      setSaveError('');
      try {
        const next = await saveNotificationPref(key, value);
        setPrefs(next);
        // iter-385: push the updated toggles to the backend immediately so it
        // can suppress opted-out message/group pushes server-side (the JS-only
        // suppression was bypassed by the OS auto-displaying notification
        // pushes). Best-effort; the next app-open re-register also syncs.
        try {
          const { reregisterPushDevice } = require('../src/push/useEmergentPush');
          void reregisterPushDevice();
        } catch {}
      } catch (errorValue: any) {
        const msg = errorValue?.message || String(errorValue);
        setSaveError(`Couldn't save "${key}": ${msg}`);
        const restored = await loadNotificationPrefs();
        setPrefs(restored);
        console.warn('Failed to update notification pref', errorValue);
      }
    },
    []
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

  const copyDiagnostics = useCallback(async () => {
    const diagnosticText = [
      'Smilers Push Diagnostics',
      `Status: ${pushDiagnostics.registrationStatus}`,
      `Auth session: ${pushDiagnostics.authSessionReady ? 'ready' : 'missing'}`,
      `Convex auth: ${pushDiagnostics.convexAuthReady ? 'ready' : pushDiagnostics.convexAuthLoading ? 'loading' : 'not ready'}`,
      `projectId: ${pushDiagnostics.projectId || 'missing'}`,
      `Permission: ${pushDiagnostics.permissionStatus}`,
      `Physical device: ${pushDiagnostics.isPhysicalDevice === null ? 'unknown' : pushDiagnostics.isPhysicalDevice ? 'yes' : 'no'}`,
      `Push token: ${pushDiagnostics.expoPushToken || 'Not available yet'}`,
      `Last registered: ${pushDiagnostics.lastRegisteredAt || 'Not yet'}`,
      `Last error: ${pushDiagnostics.lastError || 'None'}`,
      `Updated at: ${pushDiagnostics.lastUpdatedAt || 'Unknown'}`,
    ].join('\n');

    await Clipboard.setStringAsync(diagnosticText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [pushDiagnostics]);

  const runLocalNotificationTest = useCallback(async () => {
    setRunningLocalTest(true);
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Smilers local notification test',
          body: 'If you can see this, native notification rendering works on this device.',
          data: { type: 'diagnostic-local-test' },
          sound: 'default',
        },
        trigger: null,
      });
      setLocalTestResult('Sent local test notification. If nothing appeared, rendering is the blocker.');
    } catch (errorValue: any) {
      setLocalTestResult(`Local test failed: ${errorValue?.message || 'Unknown error'}`);
    } finally {
      setRunningLocalTest(false);
    }
  }, []);

  // iter-128b: Direct legacy-path self-test. Hits Expo's exp.host
  // directly with the device's Expo push token, then fetches the
  // receipt. This is the ENTIRE path Emergent Support's "we uploaded
  // FCM credentials" fix targets, so it's the definitive test of
  // whether their fix took effect. Surfaces the EXACT upstream error
  // (DeviceNotRegistered / InvalidCredentials / MismatchSenderId)
  // so the user can forward it to Emergent Support if needed.
  const runLegacySelfTest = useCallback(async () => {
    if (!pushDiagnostics.expoPushToken) {
      setLegacyTestResult(
        'Legacy self-test unavailable: no Expo push token yet — wait for native registration to complete.',
      );
      return;
    }

    setRunningLegacyTest(true);
    setLegacyTestResult('Sending direct to Expo (exp.host)…');
    try {
      const sendResponse = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: pushDiagnostics.expoPushToken,
          title: 'Smilers legacy-path probe',
          body: 'If you see this, Expo→FCM delivery is working. Emergent Support credential upload took effect.',
          data: { type: 'diagnostic-legacy-probe' },
          sound: 'default',
          channelId: 'messages',
          priority: 'high',
          ttl: 600,
          _displayInForeground: true,
        }),
      });
      const sendPayload = await sendResponse.json();
      const ticketId =
        sendPayload?.data?.id ||
        (Array.isArray(sendPayload?.data) ? sendPayload.data[0]?.id : null);
      if (!ticketId) {
        const errorMessage =
          sendPayload?.errors?.[0]?.message ||
          sendPayload?.data?.message ||
          'Expo did not return a ticket id.';
        setLegacyTestResult(`Send rejected by Expo: ${errorMessage}`);
        return;
      }

      setLegacyTestResult(
        `Expo ticket ${ticketId} created. Waiting 4s for receipt…`,
      );
      await new Promise((resolve) => setTimeout(resolve, 4000));

      const receiptResponse = await fetch(
        'https://exp.host/--/api/v2/push/getReceipts',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [ticketId] }),
        },
      );
      const receiptPayload = await receiptResponse.json();
      const receipt = receiptPayload?.data?.[ticketId];

      if (!receipt) {
        setLegacyTestResult(
          `Ticket ${ticketId} created but no receipt yet from Expo. If notification did NOT arrive, the channel/credentials are probably broken — try again in 30s.`,
        );
        return;
      }

      if (receipt.status === 'ok') {
        setLegacyTestResult(
          `✓ Expo receipt: OK. Legacy path WORKS — Emergent Support's FCM credential upload is in effect. If you did NOT see a banner on screen, the device's Notification Settings for Smilers are silenced (Settings → Apps → Smilers → Notifications).\n\nTicket: ${ticketId}`,
        );
        return;
      }

      // Common errors with diagnostic guidance
      const errCode = receipt?.details?.error || receipt?.message || 'unknown';
      let hint = '';
      if (errCode === 'DeviceNotRegistered') {
        hint =
          '\n→ Likely cause: the Expo token stored on this device was issued under a DIFFERENT Firebase configuration than the FCM credentials Emergent Support uploaded. Either (a) the package name mismatch (your APK = app.emergent.smilersmobiled270e79f vs Emergent\'s FCM registration), or (b) the token rotated after install but Convex still has the old one. Action: forward this exact error to Emergent Support.';
      } else if (errCode === 'InvalidCredentials') {
        hint =
          '\n→ Likely cause: Emergent Support uploaded the wrong FCM credential format (legacy server key vs FCM v1 service account). Expo requires FCM V1 since June 2024.';
      } else if (errCode === 'MismatchSenderId') {
        hint =
          '\n→ Likely cause: Emergent uploaded FCM creds from a DIFFERENT Firebase project than the one this APK was built against. Sender IDs must match.';
      }
      setLegacyTestResult(
        `✗ Expo receipt error: ${errCode}.\nMessage: ${receipt?.message || 'no message'}${hint}\n\nTicket: ${ticketId}`,
      );
    } catch (errorValue: any) {
      setLegacyTestResult(
        `Legacy self-test failed (network): ${errorValue?.message || 'Unknown error'}`,
      );
    } finally {
      setRunningLegacyTest(false);
    }
  }, [pushDiagnostics.expoPushToken]);

  const runRemoteSelfTest = useCallback(async () => {
    // relay (FastAPI /api/self-test-push → Emergent → FCM/APNs) instead
    // of the legacy Expo push endpoint. This validates the ENTIRE new
    // pipeline end-to-end:
    //   1. FastAPI auth (EMERGENT_PUSH_KEY) — fails fast with a clear
    //      "missing or invalid" error if the deployer hasn't injected
    //      the real key yet.
    //   2. Emergent relay → FCM/APNs delivery to THIS device's native
    //      token (registered earlier by useEmergentPush).
    //   3. Notification arrival on the device.
    const targetUserId = userInfo?.sub;
    if (!targetUserId) {
      setRemoteTestResult(
        'Remote self-test unavailable: not signed in (no OIDC subject available).',
      );
      return;
    }

    setRunningRemoteTest(true);
    setRemoteTestResult('Sending self-test push via FCM v1 (primary) + Emergent relay (backup)…');
    try {
      const result = await triggerEmergentSelfTestPush(targetUserId);
      const fcm = result?.fcm;
      if (fcm && fcm.attempted) {
        const lines: string[] = [];
        lines.push(
          `FCM v1: ${fcm.success_count}/${fcm.token_count} device(s) delivered`,
        );
        if (fcm.success_count && fcm.success_count > 0) {
          lines.push('✓ Notification should arrive on this device within ~3s.');
        }
        if (fcm.errors && fcm.errors.length > 0) {
          lines.push(`✗ Errors: ${fcm.errors.slice(0, 2).join('; ')}`);
          // Token rotation hint
          if (
            fcm.errors.some(
              (e) =>
                e.includes('registration token is not a valid') ||
                e.includes('NotFound') ||
                e.includes('Unregistered'),
            )
          ) {
            lines.push(
              '→ Token rotated — kill + reopen the app to refresh, then retry.',
            );
          }
        }
        setRemoteTestResult(lines.join('\n'));
      } else {
        setRemoteTestResult(
          'FCM v1 not attempted — no device tokens registered in backend yet.\n' +
            '→ Make sure you signed in AFTER installing this build (iter-129+). The native token register only fires after auth completes.',
        );
      }
    } catch (errorValue: any) {
      setRemoteTestResult(
        `Self-test request failed: ${errorValue?.message || 'Unknown error'}.\n` +
          'If 401/403 → INTERNAL_PUSH_TOKEN mismatch between FastAPI and the deployer.\n' +
          'If 502/503 → backend is unreachable.\n' +
          'If HTTP 500 with EMERGENT_PUSH_KEY → relay creds not injected (FCM v1 path is independent and should still work).',
      );
    } finally {
      setRunningRemoteTest(false);
    }
  }, [userInfo?.sub]);

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
            Loading your preferences…
          </Text>
        ) : null}

        {saveError ? (
          <View style={styles.saveErrorBox} testID="notifications-save-error">
            <Ionicons name="warning" size={18} color="#8B5A00" style={{ marginRight: 8 }} />
            <Text style={styles.saveErrorText}>{saveError}</Text>
          </View>
        ) : null}

        {/* iter-176: 'Push diagnostics' section hidden for production
            publish. Diagnostic data is still collected behind the scenes
            (registration retry, token preview, etc.) — only the user-
            facing UI is gated. To re-enable for internal builds:
            wrap the JSX block back in. */}
        {false ? (
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

          {/* iter-116: projectId mismatch warning — surfaced PROMINENTLY at the
              top of the diagnostics card so the user instantly sees when an
              FCM remote self-test failure is caused by a build/credentials
              project mismatch (vs. a real FCM config issue). */}
          {projectMismatchWarning ? (
            <View style={styles.warningBanner} testID="push-diagnostics-project-mismatch">
              <Ionicons name="warning" size={20} color="#8B5A00" style={{ marginRight: 8 }} />
              <Text style={styles.warningBannerText}>{projectMismatchWarning}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={styles.copyButton}
            onPress={copyDiagnostics}
            testID="push-diagnostics-copy-button"
          >
            <Text style={styles.copyButtonText}>{copied ? 'Copied' : 'Copy diagnostics'}</Text>
          </TouchableOpacity>

          <View style={styles.testButtonsRow}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={runLocalNotificationTest}
              disabled={runningLocalTest}
              testID="push-diagnostics-local-test-button"
            >
              {runningLocalTest ? <ActivityIndicator size="small" color={Colors.primary} /> : <Text style={styles.secondaryButtonText}>Test local notification</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={runRemoteSelfTest}
              disabled={runningRemoteTest}
              testID="push-diagnostics-remote-test-button"
            >
              {runningRemoteTest ? <ActivityIndicator size="small" color={Colors.primary} /> : <Text style={styles.secondaryButtonText}>Test remote self-push (Emergent)</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={runLegacySelfTest}
              disabled={runningLegacyTest}
              testID="push-diagnostics-legacy-test-button"
            >
              {runningLegacyTest ? <ActivityIndicator size="small" color={Colors.primary} /> : <Text style={styles.secondaryButtonText}>Test direct (Expo/FCM)</Text>}
            </TouchableOpacity>
          </View>

          <DiagnosticRow label="Local test" value={localTestResult} testID="push-diagnostics-local-test-result" multiline />
          <DiagnosticRow label="Remote self-test (Emergent)" value={remoteTestResult} testID="push-diagnostics-remote-test-result" multiline />
          <DiagnosticRow label="Direct test (Expo/FCM)" value={legacyTestResult} testID="push-diagnostics-legacy-test-result" multiline />

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
        ) : null}

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
              value={isOn(item.key)}
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
  saveErrorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFF4D6',
    borderColor: '#E4B53B',
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.base,
  },
  saveErrorText: { flex: 1, fontSize: FontSize.sm, color: '#3D2A00', lineHeight: 18 },
  diagnosticsCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    marginBottom: Spacing.lg,
    ...Shadow.sm,
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFF4D6',
    borderColor: '#E4B53B',
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  warningBannerText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: '#3D2A00',
    lineHeight: 18,
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
  copyButton: {
    minHeight: 42,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
  },
  copyButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primary },
  testButtonsRow: {
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  secondaryButton: {
    minHeight: 42,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#00000018',
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.base,
  },
  secondaryButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
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