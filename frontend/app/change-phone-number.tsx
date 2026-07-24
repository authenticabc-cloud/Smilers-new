/**
 * Change Phone Number screen — Identity Rework (iter-166).
 *
 * Lets a signed-in user update the phone number associated with
 * their Smilers account using the canonical Convex actions:
 *   - api.users.startChangeNumber({ newPhoneE164 })   action
 *       → { otpRequestId, expiresAt }
 *   - api.users.confirmChangeNumber({ otpRequestId, code }) action
 *       → { success, oldPhoneE164, newPhoneE164 }
 *
 * Backend enforces:
 *   - phoneE164 must be E.164 (we parse client-side via libphonenumber-js)
 *   - REJECT if newPhoneE164 already belongs to another user (CONFLICT)
 *   - REJECT if it's already yours (BAD_REQUEST)
 *   - On confirm: updates users.phoneE164, bumps users.numberChangedAt,
 *     and inserts a `numberChanged` system message into every conversation
 *     the user is in (canonical contract).
 *
 * Both endpoints are Convex Actions (they hit Twilio Verify), so we use
 * `useAction`, NOT `useMutation`.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { CountryPicker } from 'react-native-country-codes-picker';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { useRouter } from 'expo-router';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import Header from '../src/components/Header';
import { useScreenCaptureProtection } from '../src/hooks/useScreenCaptureProtection';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

const RESEND_SECONDS = 30;

export default function ChangePhoneNumberScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  // iter-134 security hardening: prevent screenshots/screen recording on
  // this screen because it briefly displays the user's new phone number
  // and the SMS OTP, both of which are credentials.
  useScreenCaptureProtection('change-phone-number');

  // Reactive user record so the "current number" auto-refreshes after
  // a successful change (Convex pushes the patched value immediately).
  const meQuery = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip') as any | undefined;
  const me: any = meQuery ?? null;
  const updateCurrentUser = useMutation(api.users.updateCurrentUser);

  const sendOtp = useAction((api as any).users?.startChangeNumber);
  const verifyOtp = useAction((api as any).users?.confirmChangeNumber);

  const [step, setStep] = useState<'enter' | 'otp' | 'done'>('enter');
  const [pickerVisible, setPickerVisible] = useState(false);
  const [countryCode, setCountryCode] = useState('+1');
  const [countryFlag, setCountryFlag] = useState('🇺🇸');
  const [phoneLocal, setPhoneLocal] = useState('');
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const pendingPhoneRef = useRef<string>('');
  // iter-166: the backend issues an `otpRequestId` from startChangeNumber
  // that confirmChangeNumber needs. Track it across the two steps.
  const otpRequestIdRef = useRef<string>('');
  // Track the final OLD number returned by the backend on confirm so the
  // success screen can show "switched from X to Y".
  const completedOldNumberRef = useRef<string>('');

  // Existing number on the account (read-only display) — prefer the canonical
  // `phoneE164` if the backend ships it (iter-166 schema), else fall back
  // to the legacy `phone` field for users not yet migrated.
  const currentPhone: string = useMemo(() => {
    const e164 = typeof me?.phoneE164 === 'string' ? me.phoneE164.trim() : '';
    const legacy = typeof me?.phone === 'string' ? me.phone.trim() : '';
    return e164.length > 0 ? e164 : legacy.length > 0 ? legacy : '—';
  }, [me?.phone, me?.phoneE164]);

  // Resend cooldown
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const handleSendOtp = async () => {
    if (!isAuthenticated) {
      Alert.alert('Not signed in', 'Please sign in before changing your number.');
      return;
    }
    if (!sendOtp) {
      Alert.alert(
        'Update needed',
        'This version of Smilers can\u2019t change your number yet. Please install the latest app update.',
      );
      return;
    }
    const raw = `${countryCode}${phoneLocal.replace(/\D/g, '')}`;
    const parsed = parsePhoneNumberFromString(raw);
    if (!parsed || !parsed.isValid()) {
      Alert.alert('Invalid number', 'Please enter a valid mobile phone number.');
      return;
    }
    const e164 = parsed.number;
    // Canonical compare uses phoneE164; legacy `phone` accepted as fallback.
    const myCanonical = typeof me?.phoneE164 === 'string' ? me.phoneE164 : (typeof me?.phone === 'string' ? me.phone : '');
    if (e164 === myCanonical) {
      Alert.alert(
        'Same number',
        'That number is already linked to your account. Enter a different number to change it.',
      );
      return;
    }
    pendingPhoneRef.current = e164;
    setSubmitting(true);
    try {
      // Canonical contract: `startChangeNumber({ newPhoneE164 })` → `{ otpRequestId, expiresAt }`.
      const res: any = await sendOtp({ newPhoneE164: e164 });
      const requestId = typeof res?.otpRequestId === 'string' ? res.otpRequestId : '';
      if (!requestId) {
        throw new Error('Server did not return an OTP request id.');
      }
      otpRequestIdRef.current = requestId;
      setStep('otp');
      setResendIn(RESEND_SECONDS);
    } catch (errorValue: any) {
      const msg = errorValue?.data?.message || errorValue?.message || 'Could not send code. Try again.';
      // Backend throws CONFLICT if newPhoneE164 already belongs to another account.
      const isConflict =
        /already in use|conflict|409|in_use|already linked/i.test(String(msg)) ||
        /CONFLICT/i.test(String(errorValue?.data?.code || ''));
      Alert.alert(
        isConflict ? 'Number already in use' : 'Could not send code',
        isConflict
          ? 'Another Smilers account already uses that number. Please use a different one.'
          : msg,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async () => {
    const code = otp.trim();
    if (code.length < 4) {
      Alert.alert('Enter the code', 'Please enter the 6-digit code we sent.');
      return;
    }
    if (!verifyOtp) {
      Alert.alert(
        'Update needed',
        'This version of Smilers can\u2019t change your number yet. Please install the latest app update.',
      );
      return;
    }
    if (!otpRequestIdRef.current) {
      Alert.alert('Session expired', 'Please go back and request a new code.');
      return;
    }
    setSubmitting(true);
    try {
      // Canonical: `confirmChangeNumber({ otpRequestId, code })`
      //   → `{ success: true, oldPhoneE164, newPhoneE164 }`
      const res: any = await verifyOtp({
        otpRequestId: otpRequestIdRef.current,
        code,
      });
      completedOldNumberRef.current = typeof res?.oldPhoneE164 === 'string' ? res.oldPhoneE164 : '';
      // Refresh the user record so the new phone propagates to the rest
      // of the UI (Account screen pulls from the same reactive query).
      try {
        await updateCurrentUser({});
      } catch {
        // non-fatal — useQuery will eventually refresh on its own.
      }
      setStep('done');
    } catch (errorValue: any) {
      const msg = errorValue?.data?.message || errorValue?.message || 'Invalid code.';
      Alert.alert('Verification failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resendIn > 0) return;
    if (!sendOtp) return;
    setSubmitting(true);
    try {
      // Resend = restart the OTP session (re-issue a fresh otpRequestId)
      // so the backend's pending-change record stays consistent.
      const res: any = await sendOtp({ newPhoneE164: pendingPhoneRef.current });
      const requestId = typeof res?.otpRequestId === 'string' ? res.otpRequestId : '';
      if (requestId) otpRequestIdRef.current = requestId;
      setResendIn(RESEND_SECONDS);
    } catch (errorValue: any) {
      const msg = errorValue?.data?.message || errorValue?.message || 'Could not resend. Try again.';
      Alert.alert('Resend failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="change-phone-screen">
      <Header title="Change phone number" showBack onBack={() => router.back()} variant="dark" />

      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior="padding"
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {step === 'done' ? (
            <View style={styles.successBlock} testID="change-phone-success">
              <View style={[styles.iconCircle, { backgroundColor: '#DCFCE7' }]}>
                <Feather name="check" size={36} color="#15803D" />
              </View>
              <Text style={styles.title}>Number updated</Text>
              <Text style={styles.subtitle}>
                {completedOldNumberRef.current
                  ? `Your Smilers account is now linked to ${pendingPhoneRef.current} (previously ${completedOldNumberRef.current}). A system note has been posted in your conversations so contacts know the change.`
                  : `Your Smilers account is now linked to ${pendingPhoneRef.current}. A system note has been posted in your conversations so contacts know the change.`}
              </Text>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => router.back()}
                testID="change-phone-done-btn"
              >
                <Text style={styles.primaryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.iconWrap}>
                <View style={styles.iconCircle}>
                  <Feather
                    name={step === 'enter' ? 'phone' : 'message-circle'}
                    size={40}
                    color={Colors.primary}
                  />
                </View>
              </View>

              <Text style={styles.title}>
                {step === 'enter' ? 'Enter your new number' : 'Verify the code'}
              </Text>
              <Text style={styles.subtitle}>
                {step === 'enter'
                  ? 'We\'ll send a 6-digit code to confirm you own the new number. Your messages, contacts, and groups stay linked to your account.'
                  : `We sent a 6-digit code to ${pendingPhoneRef.current}. Enter it below to switch your account over.`}
              </Text>

              <View style={styles.currentCard} testID="current-number-card">
                <Text style={styles.currentLabel}>Current number</Text>
                <Text style={styles.currentValue}>{currentPhone}</Text>
              </View>

              {step === 'enter' ? (
                <>
                  <View style={styles.phoneRow}>
                    <TouchableOpacity
                      style={styles.countryBtn}
                      onPress={() => setPickerVisible(true)}
                      activeOpacity={0.7}
                      disabled={submitting}
                      testID="change-phone-country-btn"
                    >
                      <Text style={styles.flag}>{countryFlag}</Text>
                      <Text style={styles.code}>{countryCode}</Text>
                      <Feather name="chevron-down" size={16} color={Colors.textSecondary} />
                    </TouchableOpacity>
                    <TextInput
                      style={styles.phoneInput}
                      value={phoneLocal}
                      onChangeText={setPhoneLocal}
                      placeholder="New phone number"
                      placeholderTextColor={Colors.textMuted}
                      keyboardType="phone-pad"
                      autoFocus
                      editable={!submitting}
                      testID="change-phone-input"
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]}
                    onPress={handleSendOtp}
                    disabled={submitting}
                    testID="change-phone-send-otp-btn"
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
                    testID="change-phone-otp-input"
                  />

                  <TouchableOpacity
                    style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]}
                    onPress={handleVerifyOtp}
                    disabled={submitting}
                    testID="change-phone-verify-btn"
                  >
                    {submitting ? (
                      <ActivityIndicator color={Colors.white} />
                    ) : (
                      <Text style={styles.primaryBtnText}>Verify & switch</Text>
                    )}
                  </TouchableOpacity>

                  <View style={styles.resendRow}>
                    <Text style={styles.resendLabel}>Didn&apos;t get it?</Text>
                    <TouchableOpacity
                      onPress={handleResend}
                      disabled={resendIn > 0 || submitting}
                    >
                      <Text
                        style={[
                          styles.resendLink,
                          (resendIn > 0 || submitting) && { color: Colors.textMuted },
                        ]}
                        testID="change-phone-resend-otp-btn"
                      >
                        {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity
                    style={styles.changeNumberBtn}
                    onPress={() => {
                      setStep('enter');
                      setOtp('');
                      setResendIn(0);
                    }}
                    testID="change-phone-back-btn"
                  >
                    <Text style={styles.changeNumberText}>Use a different number</Text>
                  </TouchableOpacity>
                </>
              )}

              <View style={styles.noteCard}>
                <Ionicons name="information-circle-outline" size={18} color={Colors.textSecondary} />
                <Text style={styles.noteText}>
                  Standard SMS rates may apply. Your old number is detached once the new one is
                  verified.
                </Text>
              </View>
            </>
          )}
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
  flexOne: { flex: 1 },
  scroll: { padding: Spacing.lg, paddingTop: Spacing.lg, paddingBottom: 48 },
  iconWrap: { alignItems: 'center', marginBottom: Spacing.lg },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.sm,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  subtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.sm,
    marginBottom: Spacing.lg,
    lineHeight: 20,
  },
  currentCard: {
    padding: Spacing.base,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.lg,
  },
  currentLabel: {
    fontSize: 11,
    fontWeight: FontWeight.semibold,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  currentValue: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
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
  noteCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: Spacing.base,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: Spacing.lg,
  },
  noteText: {
    flex: 1,
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  successBlock: {
    alignItems: 'center',
    paddingTop: Spacing.xl,
    gap: Spacing.md,
  },
});
