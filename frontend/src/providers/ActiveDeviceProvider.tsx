/**
 * ActiveDeviceProvider — CLIENT-SIDE scaffold for the "one active device only"
 * security policy (Bug 2b).
 *
 * Policy (as requested by the product owner):
 *   • A Smilers account may be actively signed in on ONE device at a time.
 *   • When a user signs in on a NEW device, the OLD device is WARNED and must
 *     CONFIRM the transfer; on confirmation the old device is signed out and
 *     access moves to the new device.
 *   • Claiming/taking over the active slot requires Face ID (biometric) on the
 *     NEW device.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BACKEND DEPENDENCY (owned by the web team's Convex repo — NOT in this app):
 * This scaffold calls the following endpoints IF they exist and no-ops safely
 * otherwise (so shipping this code cannot break anything before the backend is
 * ready). See docs/backend/one-active-device-spec.md for the full contract.
 *
 *   query    api.deviceSessions.getActiveDevice()
 *              → { activeDeviceId, activeDeviceName, updatedAt,
 *                  pendingTakeover?: { deviceId, deviceName, requestedAt } } | null
 *   mutation api.deviceSessions.claimActiveDevice({ deviceId, deviceName,
 *                  platform, faceVerified, requestTakeover })
 *   mutation api.deviceSessions.confirmTakeover({ deviceId })   // OLD device approves
 *   mutation api.deviceSessions.denyTakeover({ deviceId })      // OLD device rejects
 *   mutation api.deviceSessions.heartbeat({ deviceId })          // optional keepalive
 *
 * Enable with EXPO_PUBLIC_ONE_ACTIVE_DEVICE_ENABLED=true once the backend ships.
 * ─────────────────────────────────────────────────────────────────────────
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, AppState } from 'react-native';
import { useMutation } from 'convex/react';

import { api } from '../convexApi';
import { useAuth } from './AuthProvider';
import { useSafeConvexSubscription } from '../hooks/useSafeConvexQuery';
import { getDeviceId, getDeviceName, getDevicePlatformLabel } from '../lib/deviceIdentity';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../theme';

const FEATURE_ENABLED = process.env.EXPO_PUBLIC_ONE_ACTIVE_DEVICE_ENABLED === 'true';

type ActiveDeviceState = {
  activeDeviceId?: string | null;
  activeDeviceName?: string | null;
  updatedAt?: number;
  pendingTakeover?: { deviceId: string; deviceName?: string; requestedAt?: number } | null;
} | null;

/** Prompt Face ID / biometrics. Returns true when the user passes (or when no
 * biometric hardware is enrolled — we don't want to hard-lock the user out on a
 * device without Face ID; the account phone-OTP already gates initial access). */
async function requireFaceId(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const LocalAuthentication = require('expo-local-authentication');
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware || !enrolled) return true; // graceful — no biometrics set up
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Confirm it\'s you to use Smilers on this device',
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

  const getActiveRef = (api as any)?.deviceSessions?.getActiveDevice;
  const claimM = useMutation((api as any)?.deviceSessions?.claimActiveDevice);
  const confirmM = useMutation((api as any)?.deviceSessions?.confirmTakeover);
  const denyM = useMutation((api as any)?.deviceSessions?.denyTakeover);
  const heartbeatM = useMutation((api as any)?.deviceSessions?.heartbeat);

  const backendReady = FEATURE_ENABLED && !!getActiveRef && !!claimM;

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const deviceName = useRef<string>('');
  const platformLabel = useRef<string>('');

  useEffect(() => {
    let alive = true;
    deviceName.current = getDeviceName();
    platformLabel.current = getDevicePlatformLabel();
    void getDeviceId().then((id) => {
      if (alive) setDeviceId(id);
    });
    return () => {
      alive = false;
    };
  }, []);

  const { data: active } = useSafeConvexSubscription<ActiveDeviceState>(
    getActiveRef,
    {},
    null,
    backendReady && isAuthenticated,
  );

  const claimedRef = useRef(false);
  const [takingOver, setTakingOver] = useState(false);
  const [evicted, setEvicted] = useState(false);

  // Reset transient UI state whenever the session/device changes.
  useEffect(() => {
    claimedRef.current = false;
    setEvicted(false);
    setTakingOver(false);
  }, [deviceId, isAuthenticated]);

  const isActiveHere = !!deviceId && active?.activeDeviceId === deviceId;
  const anotherActive = !!active?.activeDeviceId && !!deviceId && active.activeDeviceId !== deviceId;

  // ── First-run claim / takeover request ───────────────────────────────
  useEffect(() => {
    if (!backendReady || !isAuthenticated || !deviceId || claimedRef.current) return;

    // Nobody is active yet → claim this slot (no takeover, no warning needed).
    if (!active?.activeDeviceId) {
      claimedRef.current = true;
      void claimM({
        deviceId,
        deviceName: deviceName.current,
        platform: platformLabel.current,
        faceVerified: false,
        requestTakeover: false,
      }).catch(() => {
        claimedRef.current = false;
      });
      return;
    }

    // We're already the active device → ensure fresh heartbeat, nothing to do.
    if (isActiveHere) {
      claimedRef.current = true;
      if (heartbeatM) void heartbeatM({ deviceId }).catch(() => {});
      return;
    }

    // Another device holds the slot → request a takeover behind Face ID.
    if (anotherActive && !takingOver) {
      claimedRef.current = true;
      setTakingOver(true);
      (async () => {
        const ok = await requireFaceId();
        if (!ok) {
          claimedRef.current = false;
          setTakingOver(false);
          return;
        }
        try {
          await claimM({
            deviceId,
            deviceName: deviceName.current,
            platform: platformLabel.current,
            faceVerified: true,
            requestTakeover: true,
          });
        } catch {
          claimedRef.current = false;
          setTakingOver(false);
        }
      })();
    }
  }, [backendReady, isAuthenticated, deviceId, active, isActiveHere, anotherActive, takingOver, claimM, heartbeatM]);

  // ── Eviction detection ───────────────────────────────────────────────
  // If we WERE the active device and the active slot moved to another device
  // (the user approved a takeover elsewhere), sign out here.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (isActiveHere) wasActiveRef.current = true;
    if (wasActiveRef.current && anotherActive) {
      setEvicted(true);
    }
  }, [isActiveHere, anotherActive]);

  // Periodic heartbeat while we're the active device (keeps "last active" fresh
  // so the backend can show accurate timing to the other device).
  useEffect(() => {
    if (!backendReady || !isActiveHere || !deviceId || !heartbeatM) return;
    const tick = () => void heartbeatM({ deviceId }).catch(() => {});
    const interval = setInterval(tick, 60_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') tick();
    });
    return () => {
      clearInterval(interval);
      try {
        sub.remove();
      } catch {}
    };
  }, [backendReady, isActiveHere, deviceId, heartbeatM]);

  const doSignOut = useCallback(() => {
    void signOut();
  }, [signOut]);

  // ── OLD device: incoming takeover request warning ─────────────────────
  const pending = active?.pendingTakeover;
  const showTakeoverPrompt =
    backendReady && isActiveHere && !!pending?.deviceId && pending.deviceId !== deviceId;

  const [resolving, setResolving] = useState(false);
  const approveTakeover = useCallback(async () => {
    if (!pending?.deviceId || !confirmM) return;
    setResolving(true);
    try {
      await confirmM({ deviceId: pending.deviceId });
      // The getActiveDevice subscription will now report the new device as
      // active → the eviction effect signs us out automatically.
    } catch {
      setResolving(false);
    }
  }, [pending?.deviceId, confirmM]);
  const denyTakeover = useCallback(async () => {
    if (!pending?.deviceId || !denyM) return;
    setResolving(true);
    try {
      await denyM({ deviceId: pending.deviceId });
    } finally {
      setResolving(false);
    }
  }, [pending?.deviceId, denyM]);

  return (
    <View style={styles.flex}>
      {children}

      {/* NEW device is waiting for the old device to approve the takeover. */}
      {backendReady && takingOver && anotherActive && !evicted ? (
        <View style={styles.overlay} testID="active-device-waiting">
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.title}>Waiting for approval</Text>
          <Text style={styles.body}>
            You&apos;re already signed in on {active?.activeDeviceName || 'another device'}. We&apos;ve
            asked that device to approve moving Smilers here. Approve it there to continue.
          </Text>
          <TouchableOpacity style={styles.secondaryBtn} onPress={doSignOut} testID="active-device-waiting-signout">
            <Text style={styles.secondaryBtnText}>Cancel &amp; sign out</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* This device was superseded — access moved elsewhere. */}
      {backendReady && evicted ? (
        <View style={styles.overlay} testID="active-device-evicted">
          <Text style={styles.emoji}>🔒</Text>
          <Text style={styles.title}>Signed in on another device</Text>
          <Text style={styles.body}>
            For your security, Smilers can only be active on one device at a time. Your account is now
            active on {active?.activeDeviceName || 'a new device'}.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={doSignOut} testID="active-device-evicted-signout">
            <Text style={styles.primaryBtnText}>OK, sign out here</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* OLD device: someone is trying to take over — warn and require confirm. */}
      {showTakeoverPrompt && !evicted ? (
        <View style={styles.overlay} testID="active-device-takeover-request">
          <Text style={styles.emoji}>📱</Text>
          <Text style={styles.title}>New sign-in request</Text>
          <Text style={styles.body}>
            {pending?.deviceName || 'A new device'} wants to sign in to your Smilers account. If you
            approve, you&apos;ll be signed out on this device.
          </Text>
          <TouchableOpacity
            style={[styles.primaryBtn, resolving && styles.btnDisabled]}
            onPress={approveTakeover}
            disabled={resolving}
            testID="active-device-approve"
          >
            {resolving ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.primaryBtnText}>Approve &amp; move to new device</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={denyTakeover}
            disabled={resolving}
            testID="active-device-deny"
          >
            <Text style={styles.secondaryBtnText}>No, keep me signed in here</Text>
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
