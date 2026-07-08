import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/providers/AuthProvider';
import { setPendingReferralCode, getPendingReferralCode, isReferralLocked } from '../src/lib/referralAttribution';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

export default function SignInScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading, signIn, lastError, authMode } = useAuth();
  const [showReferral, setShowReferral] = useState(false);
  const [refInput, setRefInput] = useState('');
  const [savedCode, setSavedCode] = useState<string | null>(null);
  // iter-338: a referral code can be redeemed only ONCE per user. When the
  // backend has recorded a referrer, we hide manual entry entirely.
  const [referralLocked, setReferralLocked] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/(tabs)/chats');
    }
  }, [isAuthenticated, router]);

  // Show any code already captured (deep-link / install referrer / prior entry).
  useEffect(() => {
    void getPendingReferralCode().then((c) => setSavedCode(c));
    void isReferralLocked().then(setReferralLocked);
  }, []);

  const openReferral = () => {
    setRefInput(savedCode || '');
    setShowReferral(true);
  };

  const handleSaveReferral = async () => {
    const code = await setPendingReferralCode(refInput);
    setSavedCode(code);
    setShowReferral(false);
  };

  const handleSignIn = async () => {
    if (authMode === 'webview') {
      router.push('/auth-webview');
      return;
    }
    await signIn();
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="sign-in-screen">
      <View style={styles.content}>
        <View style={styles.spacer} />

        <View style={styles.logoWrap}>
          <View style={styles.logoTile}>
            <Ionicons name="chatbubble-outline" size={70} color={Colors.white} />
          </View>
          <Text style={styles.brand}>Smilers</Text>
          <Text style={styles.tagline}>Say good morning with a smile</Text>
        </View>

        <View style={styles.bottomSection}>
          {lastError ? (
            <View style={styles.errorBox} testID="sign-in-error-box">
              <Ionicons name="alert-circle" size={18} color="#FCA5A5" />
              <Text style={styles.errorText}>{lastError}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.signInBtn, isLoading && styles.signInBtnDisabled]}
            onPress={handleSignIn}
            activeOpacity={0.9}
            disabled={isLoading}
            testID="sign-in-btn"
          >
            {isLoading ? (
              <ActivityIndicator color="#3A2608" />
            ) : (
              <>
                <Feather name="log-in" size={22} color="#3A2608" />
                <Text style={styles.signInText}>Sign In</Text>
              </>
            )}
          </TouchableOpacity>
          {referralLocked ? (
            <View style={styles.referralLink} testID="referral-code-applied">
              <Text style={[styles.referralLinkText, styles.referralAppliedText]}>
                ✓ Referral code applied
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              onPress={openReferral}
              style={styles.referralLink}
              activeOpacity={0.7}
              testID="referral-code-link"
            >
              <Text style={styles.referralLinkText}>
                {savedCode ? `Referral code: ${savedCode} · Change` : 'Do you have a referral code?'}
              </Text>
            </TouchableOpacity>
          )}

          <Text style={styles.terms}>
            By continuing, you agree to our Terms of Service and Privacy Policy
          </Text>
        </View>
      </View>

      <Modal
        visible={showReferral}
        transparent
        animationType="fade"
        onRequestClose={() => setShowReferral(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Enter referral code</Text>
            <Text style={styles.modalSubtitle}>
              Have a code from a friend? Enter it now — it&apos;ll be applied when you sign in.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={refInput}
              onChangeText={(t) => setRefInput(t.toUpperCase())}
              placeholder="e.g. AB12CD34"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={64}
              testID="referral-code-input"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setShowReferral(false)}
                testID="referral-cancel"
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={handleSaveReferral}
                testID="referral-save"
              >
                <Text style={styles.modalBtnPrimaryText}>Save code</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#3A2608' },
  content: {
    flex: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.xxl,
  },
  spacer: { flex: 1 },
  logoWrap: { alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.xxl },
  logoTile: {
    width: 132,
    height: 132,
    borderRadius: 32,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
    ...Shadow.lg,
  },
  brand: { fontSize: 44, fontWeight: FontWeight.bold, color: Colors.white, letterSpacing: -0.5, marginBottom: Spacing.xs },
  tagline: {
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.55)',
    textAlign: 'center',
    fontStyle: 'italic',
  },
  bottomSection: { paddingBottom: Spacing.base },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(220, 38, 38, 0.15)',
    borderRadius: Radius.md,
    padding: 12,
    marginBottom: Spacing.base,
    borderWidth: 1,
    borderColor: 'rgba(252, 165, 165, 0.3)',
  },
  errorText: { color: '#FCA5A5', fontSize: FontSize.sm, flex: 1 },
  signInBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.primary,
    paddingVertical: 18,
    borderRadius: Radius.pill,
    marginBottom: Spacing.base,
    ...Shadow.md,
  },
  signInBtnDisabled: { opacity: 0.7 },
  signInText: { color: '#3A2608', fontSize: FontSize.lg, fontWeight: FontWeight.bold, letterSpacing: 0.3 },
  terms: {
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    paddingHorizontal: Spacing.base,
    lineHeight: 20,
  },
  referralLink: {
    alignSelf: 'center',
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  referralLinkText: {
    fontSize: FontSize.base,
    color: Colors.primary,
    fontWeight: FontWeight.semibold,
    textDecorationLine: 'underline',
    textAlign: 'center',
  },
  referralAppliedText: {
    color: Colors.textSecondary,
    textDecorationLine: 'none',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: Spacing.xs,
    marginBottom: Spacing.base,
    lineHeight: 20,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    letterSpacing: 2,
    fontWeight: FontWeight.semibold,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: Spacing.base },
  modalBtn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: Radius.md, minHeight: 44, justifyContent: 'center' },
  modalBtnGhost: { backgroundColor: Colors.surface },
  modalBtnGhostText: { color: Colors.textPrimary, fontWeight: FontWeight.semibold, fontSize: FontSize.base },
  modalBtnPrimary: { backgroundColor: Colors.primary },
  modalBtnPrimaryText: { color: '#3A2608', fontWeight: FontWeight.bold, fontSize: FontSize.base },
});
