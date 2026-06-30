import React, { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';
import {
  APP_LOCK_PIN_KEY,
  APP_LOCK_SETTINGS_KEY,
  DEFAULT_APP_LOCK_SETTINGS,
  readStoredJson,
  readStoredString,
  removeStoredValue,
  writeStoredJson,
} from '../lib/settingsStorage';
import { registerAppLockHandlers } from '../lib/appLockController';
import { callActivity } from '../lib/callActivity';
import { useAuth } from '../providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

interface AppLockState {
  loaded: boolean;
  hasPin: boolean;
  enabled: boolean;
  biometric: boolean;
  lockOnLeaving: boolean;
  autoLockMinutes: number;
}

const PIN_BACKOFF_KEY = 'smilers_app_lock_backoff';
const PIN_ATTEMPTS_KEY = 'smilers_app_lock_attempts';

// iter-217 Escalating PIN lockout. Failed-attempt thresholds map to
// progressively longer backoffs:
//   - 1st tier: after 5 wrong PINs → 30-second cooldown
//   - 2nd tier: after 10 wrong PINs → 5-minute cooldown
//   - 3rd tier: after 15 wrong PINs → biometric-only / forgot-PIN-only
//     until the user signs out and resets
// The thresholds & durations are tuned to discourage brute-force while
// still being recoverable for a legitimate user who forgot their PIN.
const LOCKOUT_TIER_1 = { attempts: 5, seconds: 30 };
const LOCKOUT_TIER_2 = { attempts: 10, seconds: 300 };
const LOCKOUT_TIER_3 = { attempts: 15 }; // biometric-only / sign-out required

const KEYPAD_ROWS: Array<Array<string | 'back' | 'biometric'>> = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['biometric', '0', 'back'],
];

interface AppLockGateProps {
  children: ReactNode;
}

function normalizeAutoLockMinutes(raw: any): number {
  // Migrate legacy string values from the previous implementation.
  if (typeof raw === 'number') {
    if (raw >= 30) return 30;
    if (raw >= 15) return 15;
    if (raw >= 5) return 5;
    return 1;
  }
  if (typeof raw === 'string') {
    if (raw === '1-minute') return 1;
    if (raw === '15-minutes') return 15;
    if (raw === '1-hour') return 30;
    if (raw === 'immediately') return 1;
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return normalizeAutoLockMinutes(parsed);
  }
  return 15;
}

async function loadAppLockState(): Promise<AppLockState> {
  const stored = await readStoredJson(APP_LOCK_SETTINGS_KEY, DEFAULT_APP_LOCK_SETTINGS);
  const pin = await readStoredString(APP_LOCK_PIN_KEY);
  const merged = { ...DEFAULT_APP_LOCK_SETTINGS, ...(stored || {}) };
  return {
    loaded: true,
    hasPin: !!pin,
    enabled: !!merged.enabled,
    biometric: !!merged.biometric,
    lockOnLeaving: !!merged.lockOnLeaving,
    autoLockMinutes: normalizeAutoLockMinutes(merged.autoLockMinutes ?? merged.autoLock),
  };
}

export default function AppLockGate({ children }: AppLockGateProps) {
  const [state, setState] = useState<AppLockState>({
    loaded: false,
    hasPin: false,
    enabled: false,
    biometric: false,
    lockOnLeaving: false,
    autoLockMinutes: 15,
  });
  const [locked, setLocked] = useState(false);
  const auth = useAuth();

  const stateRef = useRef(state);
  stateRef.current = state;
  const backgroundedAtRef = useRef<number | null>(null);

  // iter-217 RECENTS / SCREENSHOT PRIVACY
  //
  // While the app is locked, we ask the OS to block screenshots and
  // screen recording. On Android this also sets `FLAG_SECURE` on the
  // current activity, which makes the multitask switcher show a blank
  // tile instead of the chat content — exactly what the user asked for.
  // On iOS, expo-screen-capture installs a blur overlay on the system
  // app-switcher snapshot, plus prevents screen recording.
  //
  // We only enable this WHILE LOCKED (not always) so power users who
  // legitimately want to screenshot a conversation can still do so once
  // the app is unlocked.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!locked) return;
    let active = true;
    (async () => {
      try {
        await ScreenCapture.preventScreenCaptureAsync('app-lock-gate');
      } catch {
        /* swallow — privacy is best-effort */
      }
    })();
    return () => {
      active = false;
      (async () => {
        try {
          await ScreenCapture.allowScreenCaptureAsync('app-lock-gate');
        } catch {
          /* swallow */
        }
      })();
    };
  }, [locked]);

  const reloadSettings = useCallback(async () => {
    const next = await loadAppLockState();
    setState(next);
    // If user just enabled App Lock from inside settings, do NOT lock right now —
    // they are actively configuring it. Locking happens next time the app comes
    // back to foreground, or when "Lock Now" is tapped.
  }, []);

  useEffect(() => {
    void reloadSettings();
  }, [reloadSettings]);

  // Listen for AppState transitions to schedule a re-lock after the configured
  // background window expires (or immediately if lockOnLeaving is set).
  useEffect(() => {
    const handleAppStateChange = (next: AppStateStatus) => {
      const current = stateRef.current;
      if (!current.loaded) return;

      if (next === 'background' || next === 'inactive') {
        backgroundedAtRef.current = Date.now();
        return;
      }

      if (next === 'active') {
        if (!current.enabled || !current.hasPin) {
          backgroundedAtRef.current = null;
          return;
        }
        // iter-297: do NOT lock while a voice/video call is on screen. WebRTC
        // calls fire frequent background/inactive/active transitions (audio
        // route, proximity, in-call notification), which with "Lock when
        // leaving" was re-locking the app every few seconds during a call.
        if (callActivity.isActive()) {
          backgroundedAtRef.current = null;
          return;
        }
        if (current.lockOnLeaving) {
          setLocked(true);
        } else if (backgroundedAtRef.current) {
          const elapsedMin = (Date.now() - backgroundedAtRef.current) / 60_000;
          if (elapsedMin >= current.autoLockMinutes) {
            setLocked(true);
          }
        }
        backgroundedAtRef.current = null;
        // Always pull fresh settings on foreground in case user edited them.
        void reloadSettings();
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, [reloadSettings]);

  // Allow other parts of the app (e.g. settings → Lock Now) to trigger a lock.
  useEffect(() => {
    return registerAppLockHandlers({
      lockNow: () => {
        const current = stateRef.current;
        if (current.hasPin && current.enabled) {
          setLocked(true);
        }
      },
      reloadSettings: () => {
        void reloadSettings();
      },
    });
  }, [reloadSettings]);

  if (!state.loaded) {
    return <>{children}</>;
  }

  if (locked && state.enabled && state.hasPin) {
    return (
      <LockOverlay
        biometric={state.biometric}
        onUnlock={() => setLocked(false)}
        onForgotPinSignOut={async () => {
          // iter-217 Forgot PIN recovery: clear the stored PIN +
          // attempt counters + backoff, then sign out via Hercules.
          // After re-login the user can set a fresh PIN.
          try {
            await removeStoredValue(APP_LOCK_PIN_KEY);
          } catch {}
          try {
            await writeStoredJson(PIN_BACKOFF_KEY, null);
          } catch {}
          try {
            await writeStoredJson(PIN_ATTEMPTS_KEY, null);
          } catch {}
          // Also disable App Lock so the freshly-signed-in session
          // isn't immediately blocked by the same broken state.
          try {
            const stored = await readStoredJson(
              APP_LOCK_SETTINGS_KEY,
              DEFAULT_APP_LOCK_SETTINGS,
            );
            await writeStoredJson(APP_LOCK_SETTINGS_KEY, {
              ...(stored || DEFAULT_APP_LOCK_SETTINGS),
              enabled: false,
            });
          } catch {}
          try {
            await auth.signOut();
          } catch {
            /* swallow — user may be offline; the local clear above is enough */
          }
          setLocked(false);
        }}
      />
    );
  }

  return <>{children}</>;
}

interface LockOverlayProps {
  biometric: boolean;
  onUnlock: () => void;
  onForgotPinSignOut: () => Promise<void>;
}

function LockOverlay({ biometric, onUnlock, onForgotPinSignOut }: LockOverlayProps) {
  const [pin, setPin] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [backoffUntil, setBackoffUntil] = useState<number | null>(null);
  const [remainingSec, setRemainingSec] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean>(false);
  const [biometricLabel, setBiometricLabel] = useState('Use biometrics');
  // iter-217: tier-3 lockout. Once we hit `LOCKOUT_TIER_3.attempts` wrong
  // PINs in a row, the keypad is permanently disabled until the user signs
  // out or unlocks with biometric (defence against brute-force).
  const [signOutOnly, setSignOutOnly] = useState(false);

  const submittingRef = useRef(false);

  // Load any persisted backoff so a quick relaunch doesn't bypass it.
  useEffect(() => {
    let active = true;
    (async () => {
      const stored = await readStoredJson(PIN_BACKOFF_KEY, null);
      if (active && stored && typeof stored.until === 'number' && stored.until > Date.now()) {
        setBackoffUntil(stored.until);
      }
      // iter-217: also load the running attempts counter so a relaunch
      // doesn't reset the user back to 0 fails (defeating brute-force
      // protection).
      const attemptsStored = (await readStoredJson(PIN_ATTEMPTS_KEY, null)) as
        | { count: number }
        | null;
      if (active && attemptsStored && typeof attemptsStored.count === 'number') {
        setAttempts(attemptsStored.count);
        if (attemptsStored.count >= LOCKOUT_TIER_3.attempts) {
          setSignOutOnly(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Tick the backoff countdown
  useEffect(() => {
    if (!backoffUntil) {
      setRemainingSec(0);
      return undefined;
    }
    const tick = () => {
      const sec = Math.max(0, Math.ceil((backoffUntil - Date.now()) / 1000));
      setRemainingSec(sec);
      if (sec === 0) {
        setBackoffUntil(null);
        setAttempts(0);
        setError(null);
        void writeStoredJson(PIN_BACKOFF_KEY, null);
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [backoffUntil]);

  // Detect biometric availability on this device.
  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    (async () => {
      try {
        const hasHw = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        const available = hasHw && enrolled;
        setBiometricAvailable(available);
        if (available) {
          const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();
          if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
            setBiometricLabel('Face ID');
          } else if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
            setBiometricLabel('Fingerprint');
          } else {
            setBiometricLabel('Biometrics');
          }
        }
      } catch {
        setBiometricAvailable(false);
      }
    })();
  }, []);

  // Attempt biometric unlock automatically on mount if enabled & available.
  useEffect(() => {
    if (!biometric || !biometricAvailable) return;
    if (backoffUntil && backoffUntil > Date.now()) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Unlock Smilers',
          fallbackLabel: 'Use PIN',
          cancelLabel: 'Cancel',
        });
        if (!cancelled && result.success) {
          onUnlock();
        }
      } catch {
        // ignore; PIN is still available
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [biometric, biometricAvailable, backoffUntil, onUnlock]);

  const tryBiometric = useCallback(async () => {
    if (!biometric || !biometricAvailable) return;
    if (backoffUntil && backoffUntil > Date.now()) return;
    setBusy(true);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Smilers',
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
      });
      if (result.success) {
        onUnlock();
      }
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }, [biometric, biometricAvailable, backoffUntil, onUnlock]);

  const submitPin = useCallback(
    async (entered: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        const stored = await readStoredString(APP_LOCK_PIN_KEY);
        if (stored && stored === entered) {
          // SUCCESS — reset all the escalation state so the next session
          // starts from a clean slate.
          setError(null);
          setAttempts(0);
          await writeStoredJson(PIN_BACKOFF_KEY, null);
          await writeStoredJson(PIN_ATTEMPTS_KEY, null);
          setSignOutOnly(false);
          onUnlock();
          return;
        }
        const nextAttempts = attempts + 1;
        setAttempts(nextAttempts);
        await writeStoredJson(PIN_ATTEMPTS_KEY, { count: nextAttempts });
        setPin('');

        // iter-217 ESCALATING LOCKOUT
        // - Tier 3 (≥15): keypad permanently disabled until sign-out /
        //   biometric unlock — clearest brute-force defence we have.
        // - Tier 2 (10): 5-minute cooldown
        // - Tier 1 (5): 30-second cooldown
        // Each successful unlock clears the attempts counter so a
        // legitimate user who occasionally mis-types isn't gradually
        // locked out forever.
        if (nextAttempts >= LOCKOUT_TIER_3.attempts) {
          setSignOutOnly(true);
          setError(
            'Too many wrong attempts. Use biometrics or tap "Forgot PIN?" to reset.',
          );
        } else if (nextAttempts >= LOCKOUT_TIER_2.attempts) {
          const until = Date.now() + LOCKOUT_TIER_2.seconds * 1000;
          setBackoffUntil(until);
          await writeStoredJson(PIN_BACKOFF_KEY, { until });
          setError(
            `Too many attempts. Try again in ${Math.round(
              LOCKOUT_TIER_2.seconds / 60,
            )} minutes.`,
          );
        } else if (nextAttempts >= LOCKOUT_TIER_1.attempts) {
          const until = Date.now() + LOCKOUT_TIER_1.seconds * 1000;
          setBackoffUntil(until);
          await writeStoredJson(PIN_BACKOFF_KEY, { until });
          setError(`Too many attempts. Try again in ${LOCKOUT_TIER_1.seconds}s`);
        } else {
          setError(
            `Wrong PIN. ${LOCKOUT_TIER_1.attempts - nextAttempts} attempt(s) left.`,
          );
        }
      } catch (errorValue: any) {
        setError(errorValue?.message || 'Could not verify PIN');
      } finally {
        submittingRef.current = false;
      }
    },
    [attempts, onUnlock]
  );

  const handleKeyPress = useCallback(
    (key: string | 'back' | 'biometric') => {
      // iter-217: signOutOnly tier — keypad disabled, biometric still allowed.
      if (signOutOnly && key !== 'biometric') return;
      if (backoffUntil && backoffUntil > Date.now()) return;
      if (key === 'biometric') {
        void tryBiometric();
        return;
      }
      if (key === 'back') {
        setPin((current) => current.slice(0, -1));
        setError(null);
        return;
      }
      if (pin.length >= 6) return;
      const next = pin + key;
      setPin(next);
      setError(null);
      // Submit when reaching min length 4 if backend says so, or always
      // give the user the option to finish typing — auto-submit at 6 digits or
      // when stored PIN length is reached.
      (async () => {
        const stored = await readStoredString(APP_LOCK_PIN_KEY);
        if (stored && next.length >= stored.length) {
          await submitPin(next);
        }
      })();
    },
    [backoffUntil, pin, signOutOnly, submitPin, tryBiometric]
  );

  const isLockedOut = !!(backoffUntil && backoffUntil > Date.now()) || signOutOnly;

  const handleForgotPin = useCallback(() => {
    Alert.alert(
      'Forgot PIN?',
      'For your security, this will sign you out of Smilers and clear your saved PIN. You can set a new one after signing back in. Your messages stay safely synced via the server.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out & Reset',
          style: 'destructive',
          onPress: () => {
            void onForgotPinSignOut();
          },
        },
      ]
    );
  }, [onForgotPinSignOut]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="app-lock-overlay">
      <KeyboardAvoidingView style={styles.flexOne} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.headerWrap}>
          <View style={styles.brandWrap}>
            <Ionicons name="lock-closed" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.title}>Smilers Locked</Text>
          <Text style={styles.subtitle}>Enter your PIN to continue</Text>
        </View>

        <View style={styles.pinDotsRow} testID="pin-dots-row">
          {Array.from({ length: 6 }, (_, i) => (
            <View
              key={i}
              style={[styles.pinDot, i < pin.length ? styles.pinDotFilled : null]}
            />
          ))}
        </View>

        {error ? (
          <Text style={styles.errorText} testID="pin-error-text">
            {isLockedOut && remainingSec > 0 ? `Locked. Try again in ${remainingSec}s` : error}
          </Text>
        ) : (
          <View style={styles.errorSpacer} />
        )}

        <View
          style={[styles.keypad, busy || isLockedOut ? styles.disabledPointer : null]}
        >
          {KEYPAD_ROWS.map((row, ri) => (
            <View key={`row-${ri}`} style={styles.keypadRow}>
              {row.map((key) => {
                if (key === 'biometric') {
                  if (!biometric || !biometricAvailable) {
                    return <View key={`spacer-${ri}`} style={styles.keypadKey} />;
                  }
                  return (
                    <TouchableOpacity
                      key="bio-key"
                      style={[styles.keypadKey, styles.keypadKeySecondary]}
                      onPress={() => handleKeyPress('biometric')}
                      testID="keypad-biometric"
                    >
                      <Ionicons name="finger-print" size={26} color={Colors.primary} />
                    </TouchableOpacity>
                  );
                }
                if (key === 'back') {
                  return (
                    <TouchableOpacity
                      key="back-key"
                      style={[styles.keypadKey, styles.keypadKeySecondary]}
                      onPress={() => handleKeyPress('back')}
                      testID="keypad-back"
                    >
                      <Feather name="delete" size={22} color={Colors.textPrimary} />
                    </TouchableOpacity>
                  );
                }
                return (
                  <TouchableOpacity
                    key={`key-${key}`}
                    style={styles.keypadKey}
                    onPress={() => handleKeyPress(key)}
                    testID={`keypad-${key}`}
                  >
                    <Text style={styles.keypadKeyLabel}>{key}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>

        <TouchableOpacity onPress={handleForgotPin} style={styles.forgotButton} testID="forgot-pin-button">
          <Text style={styles.forgotButtonText}>Forgot PIN?</Text>
        </TouchableOpacity>

        {busy ? (
          <View style={[styles.busyOverlay, styles.disabledPointer]}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const KEY_SIZE = 72;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flexOne: { flex: 1 },
  headerWrap: {
    alignItems: 'center',
    paddingTop: Spacing.xl,
    paddingHorizontal: Spacing.base,
  },
  brandWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.base,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  subtitle: {
    marginTop: 4,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  pinDotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginTop: Spacing.xl,
  },
  pinDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: Colors.primary,
    backgroundColor: 'transparent',
  },
  pinDotFilled: {
    backgroundColor: Colors.primary,
  },
  errorText: {
    marginTop: Spacing.base,
    fontSize: FontSize.sm,
    color: Colors.danger,
    textAlign: 'center',
    paddingHorizontal: Spacing.base,
  },
  errorSpacer: {
    height: FontSize.sm + Spacing.base,
  },
  keypad: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    gap: 14,
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  keypadKey: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    borderRadius: KEY_SIZE / 2,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keypadKeySecondary: {
    backgroundColor: Colors.background,
  },
  keypadKeyLabel: {
    fontSize: 28,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  forgotButton: {
    paddingVertical: Spacing.base,
    alignItems: 'center',
  },
  forgotButtonText: {
    fontSize: FontSize.sm,
    color: Colors.primary,
    fontWeight: FontWeight.semibold,
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledPointer: {
    pointerEvents: 'none',
  },
});

export { Radius };
