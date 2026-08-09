/**
 * ActiveDeviceProvider — CLIENT implementation of the "one active device only"
 * security policy (Bug 2b).
 *
 * Policy (as requested by the product owner):
 *   • A Smilers account may be actively signed in on ONE device at a time.
 *   • When a user signs in on a NEW device while another device is live, the NEW
 *     device must pass Face ID (biometric) to TAKE OVER; taking over REVOKES the
 *     old device, which is signed out on its next heartbeat.
 *   • If Face ID is cancelled, the incumbent device stays active and the new
 *     device is kept out (signed out).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BACKEND CONTRACT (native-one-active-device-contract.json, owned by the web
 * team's Convex repo). All require an authenticated user. `deviceId` is a stable
 * client-generated string.
 *
 *   mutation deviceSessions.claimActiveDevice({ deviceId, deviceName?, platform? })
 *     → { result: "active" }
 *     | { result: "takeover_required",
 *         currentDevice: { deviceId, deviceName, platform, lastHeartbeatAt } }
 *   mutation deviceSessions.confirmTakeover({ deviceId })  → { result: "active" }   // after Face ID
 *   mutation deviceSessions.denyTakeover({ deviceId })     → { result: "denied" }   // Face ID cancelled
 *   mutation deviceSessions.heartbeat({ deviceId })        → { revoked, isActive }  // every ~30s
 *   query    deviceSessions.getActiveDevice()  → null | { deviceId, deviceName, platform, status, claimedAt, lastHeartbeatAt }
 *
 * Recommended flow: sign in → claimActiveDevice → if "active" proceed + heartbeat;
 * if "takeover_required" prompt Face ID → confirmTakeover (proceed) or denyTakeover
 * (stay out). While in-app, heartbeat every ~30s and log out on revoked:true.
 *
 * Enable with EXPO_PUBLIC_ONE_ACTIVE_DEVICE_ENABLED=true.
 * ─────────────────────────────────────────────────────────────────────────
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, AppState, Platform } from 'react-native';
import { useMutation } from 'convex/react';

import { api } from '../convexApi';
import { useAuth } from './AuthProvider';
import { getDeviceId, getDeviceName } from '../lib/deviceIdentity';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../theme';

const FEATURE_ENABLED = process.env.EXPO_PUBLIC_ONE_ACTIVE_DEVICE_ENABLED === 'true';
const HEARTBEAT_MS = 30_000;

type IncumbentDevice = {
  deviceId: string;
  deviceName?: string | null;
  platform?: string | null;
  lastHeartbeatAt?: string | null;
};

type Phase = 'checking' | 'active' | 'takeover_prompt' | 'evicted' | 'kept_out';

/** Prompt Face ID / biometrics. Returns true when the user passes (or when no
 * biometric hardware is enrolled — we don't want to hard-lock the user out on a
 * device without Face ID; the account phone-OTP already gates initial access). */
/** Human-friendly platform label from the contract's raw platform string. */
function platformLabel(platform?: string | null): string | null {
  switch ((platform || '').toLowerCase()) {
    case 'ios':
      return 'iPhone / iPad';
    case 'android':
      return 'Android';
    case 'web':
      return 'Web';
    default:
      return null;
  }
}

/** "just now" / "3 min ago" / "2 hr ago" / "yesterday" from an ISO timestamp. */
function relativeTime(iso?: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

async function requireFaceId(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const LocalAuthentication = require('expo-local-authentication');
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware || !enrolled) return true; // graceful — no biometrics set up
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: "Confirm it's you to use Smilers on this device",
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return !!res?.success;
  } catch {
    return true; // never hard-fail the app if the module misbehaves
  }
}

export function ActiveDeviceProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, signOut } = useAuth();

  const claimM = useMutation((api as any)?.deviceSessions?.claimActiveDevice);
  const confirmM = useMutation((api as any)?.deviceSessions?.confirmTakeover);
  const denyM = useMutation((api as any)?.deviceSessions?.denyTakeover);
  const heartbeatM = useMutation((api as any)?.deviceSessions?.heartbeat);

  const backendReady = FEATURE_ENABLED && !!claimM;

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const deviceNameRef = useRef<string>('');
  const platformRef = useRef<string>(Platform.OS);

  const [phase, setPhase] = useState<Phase>('checking');
  const [incumbent, setIncumbent] = useState<IncumbentDevice | null>(null);
  const [busy, setBusy] = useState(false);

  const claimedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    deviceNameRef.current = getDeviceName();
    platformRef.current = Platform.OS; // "ios" | "android" | "web" — matches contract
    void getDeviceId().then((id) => {
      if (alive) setDeviceId(id);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Reset transient state on session/device change so a re-login re-claims.
  useEffect(() => {
    claimedRef.current = false;
    setPhase('checking');
    setIncumbent(null);
    setBusy(false);
  }, [deviceId, isAuthenticated]);

  const startActive = useCallback(() => {
    setPhase('active');
    setIncumbent(null);
    setBusy(false);
  }, []);

  // ── Sign-in claim ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!backendReady || !isAuthenticated || !deviceId || claimedRef.current) return;
    claimedRef.current = true;
    (async () => {
      try {
        const res = await claimM({
          deviceId,
          deviceName: deviceNameRef.current,
          platform: platformRef.current,
        });
        if (res?.result === 'takeover_required') {
          setIncumbent(res.currentDevice || null);
          setPhase('takeover_prompt');
        } else {
          startActive();
        }
      } catch {
        // Backend error → fail open (don't lock the user out of their app).
        claimedRef.current = false;
        startActive();
      }
    })();
  }, [backendReady, isAuthenticated, deviceId, claimM, startActive]);

  // ── Heartbeat while active ────────────────────────────────────────────
  useEffect(() => {
    if (!backendReady || phase !== 'active' || !deviceId || !heartbeatM) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await heartbeatM({ deviceId });
        if (!stopped && res?.revoked) {
          setPhase('evicted');
        }
      } catch {
        // ignore transient heartbeat errors
      }
    };
    void tick();
    const interval = setInterval(tick, HEARTBEAT_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void tick();
    });
    return () => {
      stopped = true;
      clearInterval(interval);
      try {
        sub.remove();
      } catch {}
    };
  }, [backendReady, phase, deviceId, heartbeatM]);

  const doSignOut = useCallback(() => {
    void signOut();
  }, [signOut]);

  // ── NEW device: take over (Face ID) ──────────────────────────────────
  const doTakeover = useCallback(async () => {
    if (!deviceId || !confirmM || busy) return;
    setBusy(true);
    const ok = await requireFaceId();
    if (!ok) {
      // User cancelled Face ID → stay out; tell backend to drop pending intent.
      try {
        if (denyM) await denyM({ deviceId });
      } catch {}
      setPhase('kept_out');
      setBusy(false);
      return;
    }
    try {
      await confirmM({ deviceId });
      startActive();
    } catch {
      setBusy(false);
    }
  }, [deviceId, confirmM, denyM, busy, startActive]);

  const cancelTakeover = useCallback(async () => {
    if (!deviceId || busy) {
      doSignOut();
      return;
    }
    setBusy(true);
    try {
      if (denyM) await denyM({ deviceId });
    } catch {}
    doSignOut();
  }, [deviceId, denyM, busy, doSignOut]);

  return (
    <View style={styles.flex}>
      {children}

      {/* NEW device: another device is live — require Face ID to take over. */}
      {backendReady && phase === 'takeover_prompt' ? (
        <View style={styles.overlay} testID="active-device-takeover">
          <Text style={styles.emoji}>📱</Text>
          <Text style={styles.title}>Already signed in elsewhere</Text>
          <Text style={styles.body}>
            Your Smilers account is active on another device. To use it here, confirm it&apos;s you —
            the other device will be signed out.
          </Text>

          <View style={styles.deviceCard} testID="active-device-incumbent-detail">
            <Text style={styles.deviceIcon}>💻</Text>
            <View style={styles.deviceInfo}>
              <Text style={styles.deviceName} numberOfLines={1}>
                {incumbent?.deviceName || 'Another device'}
              </Text>
              <Text style={styles.deviceMeta} numberOfLines={1}>
                {[platformLabel(incumbent?.platform), relativeTime(incumbent?.lastHeartbeatAt) && `Active ${relativeTime(incumbent?.lastHeartbeatAt)}`]
                  .filter(Boolean)
                  .join('  •  ') || 'Currently signed in'}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, busy && styles.btnDisabled]}
            onPress={doTakeover}
            disabled={busy}
            testID="active-device-takeover-confirm"
          >
            {busy ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.primaryBtnText}>Use Smilers here (Face ID)</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={cancelTakeover}
            disabled={busy}
            testID="active-device-takeover-cancel"
          >
            <Text style={styles.secondaryBtnText}>Cancel &amp; sign out</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* This device was revoked — access moved elsewhere. */}
      {backendReady && phase === 'evicted' ? (
        <View style={styles.overlay} testID="active-device-evicted">
          <Text style={styles.emoji}>🔒</Text>
          <Text style={styles.title}>Signed in on another device</Text>
          <Text style={styles.body}>
            For your security, Smilers can only be active on one device at a time. Your account is now
            active on a different device.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={doSignOut} testID="active-device-evicted-signout">
            <Text style={styles.primaryBtnText}>OK, sign out here</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* NEW device: user declined Face ID — kept out; incumbent stays active. */}
      {backendReady && phase === 'kept_out' ? (
        <View style={styles.overlay} testID="active-device-kept-out">
          <Text style={styles.emoji}>🙅</Text>
          <Text style={styles.title}>Not signed in here</Text>
          <Text style={styles.body}>
            You kept Smilers active on {incumbent?.deviceName || 'your other device'}. To use it on
            this device instead, sign in again and confirm with Face ID.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={doSignOut} testID="active-device-kept-out-signout">
            <Text style={styles.primaryBtnText}>Sign out</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.md,
    zIndex: 9999,
  },
  emoji: { fontSize: 56 },
  deviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    ...Shadow.sm,
  },
  deviceIcon: { fontSize: 30 },
  deviceInfo: { flex: 1, gap: 2 },
  deviceName: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  deviceMeta: { fontSize: FontSize.sm, color: Colors.textSecondary },
  title: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  body: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.md,
  },
  primaryBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: Radius.pill,
    alignItems: 'center',
    alignSelf: 'stretch',
    ...Shadow.md,
  },
  primaryBtnText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  secondaryBtn: { paddingVertical: 12, paddingHorizontal: 20, alignItems: 'center' },
  secondaryBtnText: { color: Colors.danger, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  btnDisabled: { opacity: 0.6 },
});
