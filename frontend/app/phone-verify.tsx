import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather } from '@expo/vector-icons';
import { CountryPicker } from 'react-native-country-codes-picker';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { useRouter } from 'expo-router';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import { PHONE_VERIFIED_INSTALL_KEY, writeInstallMarker, markDeviceProvisioned, resolveInstallVerified } from '../src/lib/settingsStorage';
import { useAuth } from '../src/providers/AuthProvider';
import { useScreenCaptureProtection } from '../src/hooks/useScreenCaptureProtection';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

const RESEND_SECONDS = 30;

export default function PhoneVerifyScreen() {
  const router = useRouter();
  const { signOut, isAuthenticated } = useAuth();
  // iter-134 security hardening: prevent screenshots/screen recording
  // while the user is on the OTP step — the 6-digit code on-screen is
  // an authentication credential.
  useScreenCaptureProtection('phone-verify');
  const updateCurrentUser = useMutation(api.users.updateCurrentUser);
  // Reactive subscription: any backend change (e.g. verifyOtp -> savePhoneVerified)
  // propagates immediately so we don't need refetches or rely on stale local state.
  const meQuery = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const me: any = meQuery ?? null;
  const meLoading = isAuthenticated && meQuery === undefined;

  const sendOtp = useAction(api.phoneAuthAction.sendOtp);
  const verifyOtp = useAction(api.phoneAuthAction.verifyOtp);

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [pickerVisible, setPickerVisible] = useState(false);
  const [countryCode, setCountryCode] = useState('+1');
  const [countryFlag, setCountryFlag] = useState('🇺🇸');
  const [phoneLocal, setPhoneLocal] = useState('');
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [hasVerifiedInstall, setHasVerifiedInstall] = useState(false);
  const [syncingUser, setSyncingUser] = useState(false);
  const fullPhoneRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    const loadInstallMarker = async () => {
      // Skip verification if this install is already verified OR (on an in-place
      // update) the account is server-verified and the device was provisioned.
      const verified = await resolveInstallVerified(Boolean(me?.phoneVerified), me?.email);
      if (!cancelled) {
        setHasVerifiedInstall(verified);
      }
    };
    void loadInstallMarker();
    return () => {
      cancelled = true;
    };
  }, [me]);

  // The local install marker is the SINGLE source of truth. We deliberately do
  // NOT self-heal from the server `phoneVerified` flag: after every fresh
  // install (incl. reinstalls on the same device), the user MUST complete phone
  // verification again — even if their account was verified on a prior install.
  useEffect(() => {
    if (hasVerifiedInstall) {
      router.replace('/(tabs)/chats');
    }
  }, [hasVerifiedInstall, router]);

  useEffect(() => {
    if (!isAuthenticated || meLoading || me || syncingUser) {
      return;
    }

    let cancelled = false;
    let timeoutId = null;

    const ensureUser = async () => {
      setSyncingUser(true);
      // Safety timeout: if Convex hangs (e.g. auth handshake stuck), don't lock the UI forever.
      timeoutId = setTimeout(() => {
        if (!cancelled) {
          console.warn('phone-verify: ensureUser timed out after 12s, releasing UI');
          setSyncingUser(false);
        }
      }, 12000);
      try {
        await updateCurrentUser({});
        // No refetch needed — useQuery is reactive and will pick up the new user record.
      } catch (errorValue: any) {
        if (!cancelled) {
          console.warn('phone-verify updateCurrentUser failed:', errorValue?.message || errorValue);
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (!cancelled) {
          setSyncingUser(false);
        }
      }
    };

    void ensureUser();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isAuthenticated, me, meLoading, syncingUser, updateCurrentUser]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const ensureReadyForOtp = async () => {
    if (!isAuthenticated) {
      Alert.alert('Still signing in', 'Please complete sign-in before requesting a verification code.');
      return false;
    }

    // If we already have the user record loaded, we're good.
    if (me) {
      return true;
    }

    // No record yet: try to sync inline (don't bail just because background sync is in-flight).
    setSyncingUser(true);
    try {
      await updateCurrentUser({});
      return true;
    } catch (errorValue: any) {
      Alert.alert(
        'Could not reach Smilers',
        errorValue?.message ||
          'We could not finish connecting your account. Check your connection and try again.'
      );
      return false;
    } finally {
      setSyncingUser(false);
    }
  };

  const handleSendOtp = async () => {
    const ready = await ensureReadyForOtp();
    if (!ready) {
      return;
    }

    const raw = `${countryCode}${phoneLocal.replace(/\D/g, '')}`;
    const parsed = parsePhoneNumberFromString(raw);
    if (!parsed || !parsed.isValid()) {
      Alert.alert('Invalid number', 'Please enter a valid mobile phone number.');
      return;
    }
    const e164 = parsed.number; // +14155551234
    fullPhoneRef.current = e164;
    setSubmitting(true);
    try {
      await sendOtp({ phone: e164 });
      setStep('otp');
      setResendIn(RESEND_SECONDS);
    } catch (e: any) {
      const msg = e?.data?.message || e?.message || 'Could not send code. Try again.';
      Alert.alert('Could not send code', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async () => {
    const ready = await ensureReadyForOtp();
    if (!ready) {
      return;
    }

    const code = otp.trim();
    if (code.length < 4) {
      Alert.alert('Enter the code', 'Please enter the 6-digit code we sent.');
      return;
    }
    setSubmitting(true);
    try {
      await verifyOtp({ phone: fullPhoneRef.current, code });
      // Write the local install marker — this triggers the redirect effect immediately
      // and is the single source of truth for "this device has verified".
      await writeInstallMarker(PHONE_VERIFIED_INSTALL_KEY, 'true');
      // Also mark the device provisioned so a FUTURE in-place update (where the
      // install marker might be missing) can skip re-verification via the
      // server-verified fallback, while a true reinstall still re-verifies.
      await markDeviceProvisioned();
      setHasVerifiedInstall(true);
      // Refresh the user record once so we have name/avatar locally; useQuery will keep it live.
      try {
        await updateCurrentUser({});
      } catch (refreshErr) {
        console.warn('phone-verify: post-verify updateCurrentUser failed (non-fatal):', refreshErr);
      }
    } catch (e: any) {
      const msg = e?.data?.message || e?.message || 'Invalid code.';
      Alert.alert('Verification failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resendIn > 0) return;
    setSubmitting(true);
    try {
      await sendOtp({ phone: fullPhoneRef.current });
      setResendIn(RESEND_SECONDS);
    } catch (e: any) {
      const msg = e?.data?.message || e?.message || 'Could not resend. Try again.';
      Alert.alert('Resend failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="phone-verify-screen">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.iconWrap}>
            <View style={styles.iconCircle}>
              <Feather
                name={step === 'phone' ? 'phone' : 'message-circle'}
                size={44}
                color={Colors.primary}
              />
            </View>
          </View>

          <Text style={styles.title}>
            {step === 'phone' ? 'Verify your phone number' : 'Enter the code'}
          </Text>
          <Text style={styles.subtitle}>
            {step === 'phone'
              ? 'Smilers requires phone verification to keep the community real and spam-free. Standard SMS rates may apply.'
              : `We sent a 6-digit code to ${fullPhoneRef.current}. Enter it below to verify.`}
          </Text>

          {step === 'phone' ? (
            <>
              <View style={styles.phoneRow}>
                <TouchableOpacity
                  style={styles.countryBtn}
                  onPress={() => setPickerVisible(true)}
                  activeOpacity={0.7}
                  disabled={submitting}
                  testID="country-picker-btn"
                >
                  <Text style={styles.flag}>{countryFlag}</Text>
                  <Text style={styles.code}>{countryCode}</Text>
                  <Feather name="chevron-down" size={16} color={Colors.textSecondary} />
                </TouchableOpacity>
                <TextInput
                  style={styles.phoneInput}
                  value={phoneLocal}
                  onChangeText={setPhoneLocal}
                  placeholder="Phone number"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="phone-pad"
                  autoFocus
                  editable={!submitting}
                  testID="phone-input"
                />
              </View>

              {meLoading || syncingUser ? (
                <View style={styles.connectingPill} testID="phone-verify-connecting-row">
                  <ActivityIndicator size="small" color={Colors.primary} />
                  <Text style={styles.connectingText}>Connecting your Smilers account…</Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]}
                onPress={handleSendOtp}
                disabled={submitting}
                testID="send-otp-btn"
              >
                {submitting ? (
                  <ActivityIndicator color={Colors.white} />
                ) : (
                  <Text style={styles.primaryBtnText}>Send code</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TextInput
                style={styles.otpInput}
                value={otp}
                onChangeText={(v) => setOtp(v.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                placeholderTextColor={Colors.textMuted}
                keyboardType="number-pad"
                autoFocus
                maxLength={6}
                testID="otp-input"
              />

              <TouchableOpacity
                style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]}
                onPress={handleVerifyOtp}
                disabled={submitting}
                testID="verify-otp-btn"
              >
                {submitting ? (
                  <ActivityIndicator color={Colors.white} />
                ) : (
                  <Text style={styles.primaryBtnText}>Verify</Text>
                )}
              </TouchableOpacity>

              <View style={styles.resendRow}>
                <Text style={styles.resendLabel}>Didn&apos;t get it?</Text>
                <TouchableOpacity onPress={handleResend} disabled={resendIn > 0 || submitting}>
                  <Text
                    style={[
                      styles.resendLink,
                      (resendIn > 0 || submitting) && { color: Colors.textMuted },
                    ]}
                    testID="resend-otp-btn"
                  >
                    {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={styles.changeNumberBtn}
                onPress={() => {
                  setStep('phone');
                  setOtp('');
                  setResendIn(0);
                }}
                testID="change-number-btn"
              >
                <Text style={styles.changeNumberText}>Use a different number</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity style={styles.signOutBtn} onPress={signOut} testID="phone-verify-sign-out">
            <Ionicons name="log-out-outline" size={18} color={Colors.danger} />
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <CountryPicker
        show={pickerVisible}
        lang="en"
        pickerButtonOnPress={(item) => {
          setCountryCode(item.dial_code);
          setCountryFlag(item.flag);
          setPickerVisible(false);
        }}
        onBackdropPress={() => setPickerVisible(false)}
        style={{
          modal: { height: 500, backgroundColor: Colors.surface },
          textInput: {
            color: Colors.textPrimary,
            backgroundColor: Colors.background,
            paddingHorizontal: 14,
          },
          countryButtonStyles: { backgroundColor: Colors.surface },
          dialCode: { color: Colors.textPrimary },
          countryName: { color: Colors.textPrimary },
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: Spacing.lg, paddingTop: Spacing.xl },
  iconWrap: { alignItems: 'center', marginBottom: Spacing.lg },
  iconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.sm,
  },
  title: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  subtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.base,
    marginBottom: Spacing.xl,
    lineHeight: 20,
  },
  phoneRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  countryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  flag: { fontSize: 22 },
  code: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  phoneInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  otpInput: {
    fontSize: 32,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    paddingVertical: 16,
    paddingHorizontal: 20,
    textAlign: 'center',
    letterSpacing: 12,
    marginBottom: Spacing.lg,
  },
  primaryBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: Radius.pill,
    alignItems: 'center',
    ...Shadow.md,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  connectingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: Spacing.lg,
  },
  connectingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: Spacing.lg,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  connectingText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },
  primaryBtnText: {
    color: Colors.white,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  resendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.lg,
  },
  resendLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  resendLink: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.primary,
  },
  changeNumberBtn: {
    alignSelf: 'center',
    marginTop: Spacing.md,
  },
  changeNumberText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textDecorationLine: 'underline',
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.xxl,
    paddingVertical: Spacing.md,
  },
  signOutText: {
    color: Colors.danger,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
