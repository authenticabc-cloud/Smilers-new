import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

export default function SignInScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading, signIn, lastError, authMode } = useAuth();

  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/(tabs)/chats');
    }
  }, [isAuthenticated, router]);

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
          <Text style={styles.terms}>
            By continuing, you agree to our Terms of Service and Privacy Policy
          </Text>
        </View>
      </View>
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
});
