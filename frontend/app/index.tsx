import React, { useEffect } from 'react';
import { ActivityIndicator, View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

export default function SignInScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading, isSignInReady, signIn } = useAuth();

  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/(tabs)/chats');
    }
  }, [isAuthenticated, router]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="sign-in-screen">
      <View style={styles.content}>
        <View style={styles.logoWrap}>
          <View style={styles.logoCircle}>
            <Ionicons name="happy" size={72} color={Colors.primary} />
          </View>
          <Text style={styles.brand}>Smilers</Text>
          <Text style={styles.tagline}>Say good morning with a smile</Text>
        </View>

        <View style={styles.bottomSection}>
          <TouchableOpacity
            style={[styles.signInBtn, (!isSignInReady || isLoading) && styles.signInBtnDisabled]}
            onPress={signIn}
            activeOpacity={0.85}
            disabled={!isSignInReady || isLoading}
            testID="sign-in-btn"
          >
            {isLoading && !isAuthenticated ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.signInText}>{isSignInReady ? 'Sign In' : 'Preparing sign in…'}</Text>
            )}
          </TouchableOpacity>
          <Text style={styles.terms}>
            By continuing, you agree to our Terms of Service and Privacy Policy
          </Text>
          <View style={styles.versionBadge} testID="sign-in-version-badge">
            <Text style={styles.versionText} testID="sign-in-version-text">
              v2.0.12 · auth-callback fix
            </Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: Spacing.lg,
    justifyContent: 'space-between',
    paddingVertical: Spacing.xl,
  },
  logoWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoCircle: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
    ...Shadow.md,
  },
  brand: {
    fontSize: 48,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: Spacing.sm,
  },
  tagline: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  bottomSection: {
    paddingBottom: Spacing.base,
  },
  signInBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: Radius.pill,
    alignItems: 'center',
    marginBottom: Spacing.base,
    ...Shadow.md,
  },
  signInText: {
    color: Colors.white,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  signInBtnDisabled: {
    opacity: 0.7,
  },
  terms: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.base,
  },
  versionBadge: {
    backgroundColor: '#16a34a',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    alignSelf: 'center',
    marginTop: 12,
  },
  versionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
