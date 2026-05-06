import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather } from '@expo/vector-icons';
import { CountryPicker } from 'react-native-country-codes-picker';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useAction } from 'convex/react';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

const RESEND_SECONDS = 30;

export default function PhoneVerifyScreen() {
  const router = useRouter();
  const { signOut, userInfo } = useAuth();
  const me = useQuery(api.users.getCurrentUser);

  const sendOtp = useAction(api.phoneAuth.sendOtp);
  const verifyOtp = useAction(api.phoneAuth.verifyOtp);

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [pickerVisible, setPickerVisible] = useState(false);
  const [countryCode, setCountryCode] = useState('+1');
  const [countryFlag, setCountryFlag] = useState('🇺🇸');
  const [phoneLocal, setPhoneLocal] = useState('');
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const fullPhoneRef = useRef<string>('');

  // If user already has a verified phone, skip this screen entirely
  useEffect(() => {
    if (me && me.phone && me.phoneVerified) {
      router.replace('/(tabs)/chats');
    }
  }, [me, router]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const handleSendOtp = async () => {
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
    const code = otp.trim();
    if (code.length < 4) {
      Alert.alert('Enter the code', 'Please enter the 6-digit code we sent.');
      return;
    }
    setSubmitting(true);
    try {
      await verifyOtp({ phone: fullPhoneRef.current, code });
      // Success! Convex query will refresh and `me.phoneVerified` will be true
      // → useEffect above redirects to home automatically
      router.replace('/(tabs)/chats');
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
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
                  testID="phone-input"
                />
              </View>

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
                <Text style={styles.resendLabel}>Didn't get it?</Text>
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
