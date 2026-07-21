/**
 * CallReadinessPanel — the "why won't my calls ring?" checklist.
 *
 * Renders at the top of the Call Diagnostics screen. It summarises, at a
 * glance, every prerequisite that must be satisfied for an incoming call to
 * actually ring on this device, with a one-tap fix for each:
 *
 *   1. Backend fix live      — fetches /api/health and confirms the deployed
 *                              relay has the 6-second call dedupe window (the
 *                              fix for "calls only ring after a time gap").
 *   2. Notifications allowed — runtime notification permission.
 *   3. Push registered       — the device's FCM token is registered with the
 *                              backend (from the live push-diagnostics state).
 *   4. Full-screen calls     — Android 14+ USE_FULL_SCREEN_INTENT grant (can't
 *                              be read from JS, so it's an actionable item).
 *   5. Battery unrestricted  — battery-optimization exemption so the headless
 *                              JS process can wake for a call when killed.
 *
 * Grant state for (4) and (5) cannot be queried from JS without a custom
 * native module, so those are shown as actions (open the exact settings page)
 * rather than pass/fail. (2) and (3) are real pass/fail. (1) reflects the
 * deployed backend so you can verify a redeploy took effect.
 *
 * The "Re-enable one-time prompts" button clears the AsyncStorage flags so the
 * automatic battery / full-screen prompts appear again on next launch (per the
 * support recommendation for users who dismissed them).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { Feather } from '@expo/vector-icons';
import {
  usePushDiagnostics,
  requestPushDiagnosticsRetry,
} from '../push/pushDiagnostics';
import {
  isAndroid14Plus,
  openFullScreenIntentSettings,
  requestBatteryOptimizationExemption,
  clearPromptMemory,
  clearBatteryOptPromptMemory,
} from '../lib/fullScreenIntentPermission';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

type RowState = 'ok' | 'warn' | 'action' | 'loading';

function StatusIcon({ state }: { state: RowState }) {
  if (state === 'loading') return <ActivityIndicator size="small" color={Colors.textSecondary} />;
  if (state === 'ok') return <Feather name="check-circle" size={18} color={Colors.success} />;
  if (state === 'warn') return <Feather name="alert-triangle" size={18} color={Colors.danger} />;
  return <Feather name="chevron-right-circle" size={18} color={Colors.primary} />;
}

function Row({
  title,
  detail,
  state,
  actionLabel,
  onAction,
  testID,
}: {
  title: string;
  detail: string;
  state: RowState;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.rowIcon}>
        <StatusIcon state={state} />
      </View>
      <View style={styles.flexOne}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail} numberOfLines={2}>
          {detail}
        </Text>
      </View>
      {actionLabel && onAction ? (
        <TouchableOpacity style={styles.rowAction} onPress={onAction} testID={testID ? `${testID}-action` : undefined}>
          <Text style={styles.rowActionText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default function CallReadinessPanel() {
  const push = usePushDiagnostics();
  const [notifGranted, setNotifGranted] = useState<boolean | null>(null);
  const [backend, setBackend] = useState<
    { state: RowState; detail: string } | null
  >(null);
  const [msgDataOnly, setMsgDataOnly] = useState<
    { state: RowState; detail: string } | null
  >(null);

  const checkNotif = useCallback(async () => {
    try {
      const s = await Notifications.getPermissionsAsync();
      const granted =
        s.granted ||
        s.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
        s.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
      setNotifGranted(!!granted);
    } catch {
      setNotifGranted(false);
    }
  }, []);

  const checkBackend = useCallback(async () => {
    setBackend({ state: 'loading', detail: 'Checking deployed backend…' });
    const base = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
    if (!base) {
      setBackend({ state: 'warn', detail: 'No backend URL in this build.' });
      return;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${base}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      const json = await resp.json();
      const pp = json?.push_pipeline || {};
      const win = Number(pp.call_dedupe_window_seconds);
      if (win === 6) {
        setBackend({
          state: 'ok',
          detail: `Call fix live · build ${pp.build || '?'}`,
        });
      } else {
        setBackend({
          state: 'warn',
          detail: `Old backend (dedupe=${pp.call_dedupe_window_seconds ?? '?'}). Redeploy, then re-check.`,
        });
      }
      // Message-duplicate check: messages MUST be data-only, otherwise Android
      // shows the OS banner AND the app's own notification (= the duplicate).
      if (pp.message_data_only === true) {
        setMsgDataOnly({ state: 'ok', detail: 'Messages are data-only (single notification).' });
      } else {
        setMsgDataOnly({
          state: 'warn',
          detail: 'Messages NOT data-only — duplicates expected. Redeploy the backend.',
        });
      }
    } catch {
      setBackend({ state: 'warn', detail: 'Backend unreachable from this device.' });
      setMsgDataOnly({ state: 'warn', detail: 'Backend unreachable from this device.' });
    }
  }, []);

  useEffect(() => {
    void checkNotif();
    void checkBackend();
  }, [checkNotif, checkBackend]);

  const pushRegistered = push.registrationStatus === 'registered';
  const tokenPreview = push.expoPushToken ? `${push.expoPushToken.slice(0, 18)}…` : 'no token yet';

  const reEnablePrompts = useCallback(async () => {
    await clearPromptMemory();
    await clearBatteryOptPromptMemory();
  }, []);

  return (
    <View style={styles.card} testID="call-readiness-panel">
      <View style={styles.titleRow}>
        <Feather name="phone-call" size={15} color={Colors.primary} />
        <Text style={styles.title}>Call readiness</Text>
        <View style={styles.flexOne} />
        <TouchableOpacity
          onPress={() => {
            void checkNotif();
            void checkBackend();
          }}
          hitSlop={8}
          testID="call-readiness-refresh"
        >
          <Feather name="refresh-cw" size={15} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <Row
        title="Backend call fix"
        detail={backend?.detail || 'Checking…'}
        state={backend?.state || 'loading'}
        actionLabel={backend?.state === 'warn' ? 'Re-check' : undefined}
        onAction={backend?.state === 'warn' ? checkBackend : undefined}
        testID="readiness-backend"
      />

      <Row
        title="Message notifications"
        detail={msgDataOnly?.detail || 'Checking…'}
        state={msgDataOnly?.state || 'loading'}
        actionLabel={msgDataOnly?.state === 'warn' ? 'Re-check' : undefined}
        onAction={msgDataOnly?.state === 'warn' ? checkBackend : undefined}
        testID="readiness-msg-dataonly"
      />

      <Row
        title="Notifications allowed"
        detail={notifGranted == null ? 'Checking…' : notifGranted ? 'Granted' : 'Blocked — calls cannot show'}
        state={notifGranted == null ? 'loading' : notifGranted ? 'ok' : 'warn'}
        actionLabel={notifGranted === false ? 'Fix' : undefined}
        onAction={
          notifGranted === false
            ? async () => {
                await Notifications.requestPermissionsAsync();
                await checkNotif();
              }
            : undefined
        }
        testID="readiness-notif"
      />

      <Row
        title="Push registered"
        detail={pushRegistered ? `Registered · ${tokenPreview}` : `Status: ${push.registrationStatus} · ${push.lastError || tokenPreview}`}
        state={pushRegistered ? 'ok' : 'warn'}
        actionLabel={pushRegistered ? undefined : 'Retry'}
        onAction={pushRegistered ? undefined : () => { void requestPushDiagnosticsRetry(); }}
        testID="readiness-push"
      />

      {Platform.OS === 'android' ? (
        <>
          {isAndroid14Plus() ? (
            <Row
              title="Full-screen calls"
              detail="Android 14+: allow full-screen notifications so calls ring on the lock screen."
              state="action"
              actionLabel="Open"
              onAction={() => { void openFullScreenIntentSettings(); }}
              testID="readiness-fsi"
            />
          ) : null}
          <Row
            title="Battery unrestricted"
            detail="Allow background running so calls ring when the app is closed."
            state="action"
            actionLabel="Allow"
            onAction={() => { void requestBatteryOptimizationExemption(); }}
            testID="readiness-battery"
          />
        </>
      ) : null}

      <View style={styles.footerRow}>
        <TouchableOpacity onPress={() => { void Linking.openSettings(); }} testID="readiness-app-settings">
          <Text style={styles.footerLink}>App settings</Text>
        </TouchableOpacity>
        {Platform.OS === 'android' ? (
          <TouchableOpacity onPress={reEnablePrompts} testID="readiness-reenable-prompts">
            <Text style={styles.footerLink}>Re-enable one-time prompts</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.hint}>
        Place a test call, then check the events below. A healthy incoming call shows a WAKE (ring
        shown) event; if you see the push arrive but no WAKE, the ring failed to display.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
  card: {
    marginHorizontal: Spacing.base,
    marginTop: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  title: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.05)',
  },
  rowIcon: { width: 22, alignItems: 'center' },
  rowTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowDetail: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  rowAction: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  rowActionText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.headerBg },
  footerRow: { flexDirection: 'row', gap: 18, marginTop: 10 },
  footerLink: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: Colors.primary },
  hint: { marginTop: 10, fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 },
});
