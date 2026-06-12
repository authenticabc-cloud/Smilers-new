/**
 * Approve Desktop Login (iter-186) — the native side of the web team's
 * Desktop Login Approval contract (DESKTOP_LOGIN_APPROVAL_NATIVE_CONTRACT.md).
 *
 * Entry points:
 *  - Push notification (data.type === "login-approval") routes here with
 *    `?code=XXXXXXXX` (handled in src/push/usePushNotifications.ts)
 *  - Chats-tab banner when api.loginApprovals.listPendingForMe has rows
 *  - Settings → "Approve Desktop Login" (opens the pending list + QR scan)
 *  - Deep link smilers://approve-login?code=XXXXXXXX
 *
 * Security rule from the contract: `approve` is NEVER called without a
 * successful device biometric / PIN check (expo-local-authentication).
 * `deny` requires no check.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Device from 'expo-device';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

const EMPTY_PENDING: any[] = [];

/** Pull the 8-char code out of a scanned QR (raw code or approve-login URL). */
export function extractApprovalCode(raw: string): string | null {
  const text = String(raw || '').trim();
  const urlMatch = text.match(/[?&]code=([A-Za-z0-9]{4,16})/);
  if (urlMatch) return urlMatch[1].toUpperCase();
  if (/^[A-Fa-f0-9]{8}$/.test(text)) return text.toUpperCase();
  return null;
}

/** Map ConvexError codes from the contract to human copy. */
function describeApprovalError(errorValue: any): string {
  const dataCode =
    typeof errorValue?.data === 'object' && errorValue?.data !== null
      ? String((errorValue.data as any).code || '')
      : typeof errorValue?.data === 'string'
        ? errorValue.data
        : '';
  const message = String(errorValue?.message || '');
  const haystack = `${dataCode} ${message}`;
  if (haystack.includes('BAD_REQUEST')) return 'This request expired. Generate a new code on your computer and try again.';
  if (haystack.includes('CONFLICT')) return 'This request was already approved or denied.';
  if (haystack.includes('FORBIDDEN')) return "This request isn't yours.";
  if (haystack.includes('NOT_FOUND')) return 'Request not found. The code may be wrong or expired.';
  if (haystack.includes('UNAUTHENTICATED')) return 'Please sign in again, then retry.';
  return 'Something went wrong. Please try again.';
}

function formatCountdown(msLeft: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function ApproveLoginScreen() {
  const router = useRouter();
  const { code: codeParam } = useLocalSearchParams<{ code?: string }>();
  const { isAuthenticated } = useAuth();

  const [selectedCode, setSelectedCode] = useState<string | null>(
    typeof codeParam === 'string' && codeParam.trim() ? codeParam.trim().toUpperCase() : null,
  );
  const [scanMode, setScanMode] = useState(false);
  const [busy, setBusy] = useState<null | 'approve' | 'deny'>(null);
  const [outcome, setOutcome] = useState<null | { kind: 'approved' | 'denied'; deviceName: string }>(null);
  const [errorText, setErrorText] = useState('');
  const [nowTs, setNowTs] = useState(Date.now());
  const [scanned, setScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const approveMutation = useMutation((api as any).loginApprovals.approve);
  const denyMutation = useMutation((api as any).loginApprovals.deny);

  // Live pending list — also keeps deviceName + expiresAt for the selected code.
  const { data: pending, loading: pendingLoading } = useSafeConvexQuery<any[]>(
    (api as any).loginApprovals.listPendingForMe,
    {},
    EMPTY_PENDING,
    isAuthenticated,
  );
  const pendingList = Array.isArray(pending) ? pending : EMPTY_PENDING;
  const selectedRequest = useMemo(
    () => (selectedCode ? pendingList.find((row: any) => String(row.code).toUpperCase() === selectedCode) : undefined),
    [pendingList, selectedCode],
  );

  // 1-second tick for the expiry countdown.
  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (scanMode && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [scanMode, permission, requestPermission]);

  const msLeft = selectedRequest ? Math.max(0, Number(selectedRequest.expiresAt) - nowTs) : null;
  const isExpired = msLeft !== null && msLeft <= 0;

  const onApprove = useCallback(async () => {
    if (!selectedCode || busy) return;
    setErrorText('');
    // SECURITY: contract section 5 — approve only after biometric/PIN success.
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = hasHardware ? await LocalAuthentication.isEnrolledAsync() : false;
      const securityLevel = await LocalAuthentication.getEnrolledLevelAsync();
      // SECRET = device PIN/pattern/password, BIOMETRIC = fingerprint/face.
      const hasAnyDeviceLock = enrolled || securityLevel !== LocalAuthentication.SecurityLevel.NONE;
      if (!hasAnyDeviceLock) {
        Alert.alert(
          'Screen lock required',
          'To approve desktop sign-ins, set up a fingerprint, face unlock, or PIN in your phone settings first.',
        );
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm to approve desktop sign-in',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false, // allow device PIN fallback per user choice
      });
      if (!result.success) {
        return; // stay on the prompt; do nothing (contract 5.2)
      }
    } catch (authError: any) {
      Alert.alert('Verification unavailable', authError?.message || 'Could not start the biometric check.');
      return;
    }

    setBusy('approve');
    try {
      await approveMutation({
        code: selectedCode,
        resolvedByDevice: Device.deviceName || 'Smilers phone',
      });
      setOutcome({ kind: 'approved', deviceName: selectedRequest?.deviceName || 'your computer' });
    } catch (errorValue: any) {
      setErrorText(describeApprovalError(errorValue));
    } finally {
      setBusy(null);
    }
  }, [approveMutation, busy, selectedCode, selectedRequest?.deviceName]);

  const onDeny = useCallback(async () => {
    if (!selectedCode || busy) return;
    setErrorText('');
    setBusy('deny');
    try {
      await denyMutation({
        code: selectedCode,
        resolvedByDevice: Device.deviceName || 'Smilers phone',
      });
      setOutcome({ kind: 'denied', deviceName: selectedRequest?.deviceName || 'the computer' });
    } catch (errorValue: any) {
      setErrorText(describeApprovalError(errorValue));
    } finally {
      setBusy(null);
    }
  }, [busy, denyMutation, selectedCode, selectedRequest?.deviceName]);

  const onScannedQr = useCallback(
    ({ data }: { data: string }) => {
      if (scanned) return;
      setScanned(true);
      const code = extractApprovalCode(data);
      if (!code) {
        Alert.alert('Not a login QR', 'This code is not a Smilers desktop login QR.');
        setTimeout(() => setScanned(false), 1500);
        return;
      }
      setSelectedCode(code);
      setScanMode(false);
      setScanned(false);
    },
    [scanned],
  );

  // ─── Render branches ───

  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="approve-login-back">
        <Ionicons name="arrow-back" size={24} color={Colors.white} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Desktop Login</Text>
      <View style={styles.backBtn} />
    </View>
  );

  if (outcome) {
    const approvedKind = outcome.kind === 'approved';
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.centerWrap} testID="approve-login-outcome">
          <View style={[styles.outcomeCircle, approvedKind ? styles.outcomeCircleOk : styles.outcomeCircleDeny]}>
            <Feather name={approvedKind ? 'check' : 'x'} size={44} color={Colors.white} />
          </View>
          <Text style={styles.outcomeTitle} testID="approve-login-outcome-title">
            {approvedKind ? 'Desktop unlocked' : 'Sign-in denied'}
          </Text>
          <Text style={styles.outcomeText}>
            {approvedKind
              ? `${outcome.deviceName} is now signed in and trusted.`
              : `The sign-in on ${outcome.deviceName} was blocked.`}
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()} testID="approve-login-done">
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (scanMode) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.scanWrap} testID="approve-login-scanner">
          {permission?.granted ? (
            <CameraView
              style={styles.camera}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={scanned ? undefined : onScannedQr}
            />
          ) : (
            <View style={styles.centerWrap}>
              <MaterialCommunityIcons name="camera-off-outline" size={42} color={Colors.textMuted} />
              <Text style={styles.mutedText}>Camera permission is needed to scan the QR code.</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => requestPermission()} testID="approve-login-grant-camera">
                <Text style={styles.primaryBtnText}>Allow camera</Text>
              </TouchableOpacity>
            </View>
          )}
          <Text style={styles.scanHint}>Point your camera at the QR code on your computer screen.</Text>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setScanMode(false)} testID="approve-login-cancel-scan">
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (selectedCode) {
    // Detail / confirm view for one request.
    const deviceName = selectedRequest?.deviceName || 'your computer';
    const requestMissing = !pendingLoading && !selectedRequest;
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.centerWrap} testID="approve-login-detail">
          <View style={styles.deviceCircle}>
            <MaterialCommunityIcons name="monitor-lock" size={40} color={Colors.primaryDark} />
          </View>
          <Text style={styles.detailTitle}>Approve sign-in on {deviceName}?</Text>
          {pendingLoading && !selectedRequest ? (
            <ActivityIndicator size="small" color={Colors.primary} style={styles.detailSpinner} />
          ) : null}
          {requestMissing || isExpired ? (
            <View style={styles.expiredPill} testID="approve-login-expired">
              <Feather name="clock" size={14} color="#92400E" />
              <Text style={styles.expiredText}>
                {isExpired
                  ? 'This request expired. Generate a new code on your computer.'
                  : 'This request is no longer pending — it may have expired or been handled already.'}
              </Text>
            </View>
          ) : selectedRequest ? (
            <Text style={styles.countdownText} testID="approve-login-countdown">
              Expires in {formatCountdown(msLeft ?? 0)}
            </Text>
          ) : null}
          <Text style={styles.securityNote}>
            Only approve if YOU are signing in on this computer right now.
          </Text>
          {errorText ? (
            <Text style={styles.errorText} testID="approve-login-error">{errorText}</Text>
          ) : null}
          <TouchableOpacity
            style={[styles.primaryBtn, (busy || isExpired || requestMissing) ? styles.btnDisabled : null]}
            onPress={onApprove}
            disabled={!!busy || isExpired || requestMissing}
            testID="approve-login-approve-btn"
          >
            {busy === 'approve' ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <>
                <MaterialCommunityIcons name="fingerprint" size={20} color={Colors.white} />
                <Text style={styles.primaryBtnText}>Approve with fingerprint / PIN</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.denyBtn, busy ? styles.btnDisabled : null]}
            onPress={onDeny}
            disabled={!!busy}
            testID="approve-login-deny-btn"
          >
            {busy === 'deny' ? (
              <ActivityIndicator size="small" color={Colors.danger} />
            ) : (
              <Text style={styles.denyBtnText}>Deny — this isn&apos;t me</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setSelectedCode(null)} style={styles.linkBtn} testID="approve-login-back-to-list">
            <Text style={styles.linkText}>View all pending requests</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // List view: all pending requests + scan entry.
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <View style={styles.listWrap} testID="approve-login-list">
        <Text style={styles.listIntro}>
          Sign-ins on a computer wait here for your approval.
        </Text>
        {pendingLoading ? (
          <ActivityIndicator size="large" color={Colors.primary} style={styles.listSpinner} />
        ) : pendingList.length === 0 ? (
          <View style={styles.emptyWrap} testID="approve-login-empty">
            <MaterialCommunityIcons name="monitor-shimmer" size={44} color={Colors.textMuted} />
            <Text style={styles.mutedText}>No pending desktop sign-ins.</Text>
          </View>
        ) : (
          pendingList.map((row: any) => {
            const rowMsLeft = Math.max(0, Number(row.expiresAt) - nowTs);
            return (
              <TouchableOpacity
                key={row._id}
                style={styles.pendingRow}
                onPress={() => setSelectedCode(String(row.code).toUpperCase())}
                testID={`approve-login-pending-${row.code}`}
              >
                <View style={styles.pendingIcon}>
                  <MaterialCommunityIcons name="monitor-lock" size={22} color={Colors.primaryDark} />
                </View>
                <View style={styles.flexOne}>
                  <Text style={styles.pendingName}>{row.deviceName || 'Computer'}</Text>
                  <Text style={styles.pendingSub}>Expires in {formatCountdown(rowMsLeft)}</Text>
                </View>
                <Feather name="chevron-right" size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            );
          })
        )}
        <TouchableOpacity style={styles.scanBtn} onPress={() => setScanMode(true)} testID="approve-login-open-scanner">
          <Ionicons name="qr-code-outline" size={20} color={Colors.primaryDark} />
          <Text style={styles.scanBtnText}>Scan QR on your computer</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    minHeight: 56,
    backgroundColor: Colors.headerBg,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.base,
  },
  deviceCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  detailSpinner: { marginVertical: 2 },
  countdownText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'] as any,
  },
  securityNote: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  expiredPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderRadius: Radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  expiredText: { flex: 1, fontSize: FontSize.sm, color: '#92400E', lineHeight: 18 },
  errorText: {
    fontSize: FontSize.sm,
    color: Colors.danger,
    textAlign: 'center',
  },
  primaryBtn: {
    minHeight: 50,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 26,
    alignSelf: 'stretch',
    ...Shadow.sm,
  },
  primaryBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  denyBtn: {
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  denyBtnText: { color: Colors.danger, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  btnDisabled: { opacity: 0.5 },
  linkBtn: { paddingVertical: 8 },
  linkText: { color: Colors.primaryDark, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  outcomeCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outcomeCircleOk: { backgroundColor: '#16A34A' },
  outcomeCircleDeny: { backgroundColor: Colors.danger },
  outcomeTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  outcomeText: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  scanWrap: { flex: 1, padding: Spacing.base, gap: Spacing.base },
  camera: { flex: 1, borderRadius: Radius.lg, overflow: 'hidden' },
  scanHint: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  secondaryBtn: {
    minHeight: 46,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  secondaryBtnText: { color: Colors.textPrimary, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  listWrap: { flex: 1, padding: Spacing.base, gap: Spacing.sm },
  listIntro: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: 4 },
  listSpinner: { marginTop: Spacing.xl },
  emptyWrap: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.sm },
  mutedText: { fontSize: FontSize.sm, color: Colors.textMuted, textAlign: 'center' },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: 14,
    ...Shadow.sm,
  },
  pendingIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  pendingSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, fontVariant: ['tabular-nums'] as any },
  scanBtn: {
    marginTop: Spacing.sm,
    minHeight: 48,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  scanBtnText: { color: Colors.primaryDark, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
});
