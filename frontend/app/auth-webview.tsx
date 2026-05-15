import React, { useMemo, useState, useCallback } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { WebView } from 'react-native-webview';
import Header from '../src/components/Header';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

const WEB_APP_URL = process.env.EXPO_PUBLIC_WEB_APP_URL || 'https://smilers.online';

function buildSignInUrl(callbackUrl: string) {
  const url = new URL(WEB_APP_URL);
  url.searchParams.set('mobile_app', '1');
  url.searchParams.set('mobile_platform', Platform.OS);
  url.searchParams.set('mobile_callback', callbackUrl);
  return url.toString();
}

function getAllParamsFromUrl(url: string) {
  const result: Record<string, string> = {};
  try {
    const questionIndex = url.indexOf('?');
    if (questionIndex >= 0) {
      const query = new URLSearchParams(url.slice(questionIndex + 1));
      query.forEach((value, key) => {
        result[key] = value;
      });
    }
    const hashIndex = url.indexOf('#');
    if (hashIndex >= 0) {
      const hash = new URLSearchParams(url.slice(hashIndex + 1));
      hash.forEach((value, key) => {
        result[key] = value;
      });
    }
  } catch (errorValue) {
    console.warn('Failed to parse auth bridge URL', errorValue);
  }
  return result;
}

export default function AuthWebviewScreen() {
  const router = useRouter();
  const { acceptTokens, setAuthError } = useAuth();
  const [isLoadingPage, setIsLoadingPage] = useState(true);
  const [statusText, setStatusText] = useState('Opening Smilers sign-in…');

  const callbackUrl = useMemo(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return `${window.location.origin}/auth-callback`;
    }
    return 'smilers://auth-callback';
  }, []);

  const signInUrl = useMemo(() => buildSignInUrl(callbackUrl), [callbackUrl]);

  const handleBridgeUrl = useCallback(
    async (url: string) => {
      const params = getAllParamsFromUrl(url);
      if (params.error) {
        const message = params.error_description || params.error;
        setAuthError(message);
        setStatusText(message);
        return true;
      }

      const idToken = params.id_token || params.idToken;
      if (idToken) {
        setStatusText('Finishing sign-in…');
        await acceptTokens({
          idToken,
          accessToken: params.access_token,
          refreshToken: params.refresh_token,
          expiresIn: params.expires_in ? Number(params.expires_in) : 3600,
        });
        router.replace('/(tabs)/chats');
        return true;
      }

      const code = params.code;
      if (code) {
        const nextUrl = `/auth-callback?code=${encodeURIComponent(code)}${params.state ? `&state=${encodeURIComponent(params.state)}` : ''}`;
        router.replace(nextUrl as any);
        return true;
      }

      return false;
    },
    [acceptTokens, router, setAuthError]
  );

  const openExternal = useCallback(async () => {
    await WebBrowser.openBrowserAsync(signInUrl);
  }, [signInUrl]);

  if (Platform.OS === 'web') {
    return (
      <SafeAreaView style={styles.container} edges={['top']} testID="auth-webview-screen">
        <Header title="Sign In" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.webWrap}>
          <View style={styles.webCard} testID="auth-webview-web-card">
            <Ionicons name="globe-outline" size={38} color={Colors.primary} />
            <Text style={styles.title}>Smilers Web Sign-In Bridge</Text>
            <Text style={styles.subtitle}>
              Native builds open your live Smilers web sign-in and return to the app after Hercules login completes.
            </Text>
            <TouchableOpacity style={styles.primaryButton} onPress={openExternal} testID="auth-webview-open-web-button">
              <Text style={styles.primaryButtonText}>Open Smilers Sign In</Text>
            </TouchableOpacity>
            <Text style={styles.helperText} testID="auth-webview-helper-text">
              This opens smilers.online with secure mobile callback parameters for the native app.
            </Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="auth-webview-screen">
      <Header title="Sign In" showBack onBack={() => router.back()} variant="dark" />
      <View style={styles.statusBar} testID="auth-webview-status-bar">
        <ActivityIndicator color={Colors.primary} size="small" />
        <Text style={styles.statusText}>{statusText}</Text>
      </View>
      <WebView
        source={{ uri: signInUrl }}
        style={styles.webview}
        onLoadStart={() => {
          setIsLoadingPage(true);
          setStatusText('Opening Smilers sign-in…');
        }}
        onLoadEnd={() => {
          setIsLoadingPage(false);
          setStatusText('Complete sign-in to return to Smilers.');
        }}
        onShouldStartLoadWithRequest={(request) => {
          const url = request.url || '';
          const isAppCallback =
            url.startsWith('smilers://auth-callback') ||
            url.includes('/auth/mobile-callback') ||
            url.includes('/auth-callback');
          if (isAppCallback) {
            void handleBridgeUrl(url);
            return false;
          }
          return true;
        }}
        onNavigationStateChange={(navState) => {
          const url = navState.url || '';
          const isAppCallback =
            url.startsWith('smilers://auth-callback') ||
            url.includes('/auth/mobile-callback') ||
            url.includes('/auth-callback');
          if (isAppCallback) {
            void handleBridgeUrl(url);
          }
        }}
        startInLoadingState
        testID="auth-webview"
      />
      {isLoadingPage ? (
        <View style={styles.loadingOverlay} pointerEvents="none" testID="auth-webview-loading-overlay">
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  webview: { flex: 1, backgroundColor: Colors.background },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    margin: Spacing.base,
    padding: 12,
    backgroundColor: Colors.primaryLight,
    borderRadius: Radius.md,
  },
  statusText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    top: 112,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,239,224,0.25)',
  },
  webWrap: { flex: 1, padding: Spacing.base, justifyContent: 'center' },
  webCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: 12,
    ...Shadow.md,
  },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center' },
  subtitle: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  primaryButton: {
    minHeight: 48,
    alignSelf: 'stretch',
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.base,
  },
  primaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  helperText: { fontSize: FontSize.xs, color: Colors.textMuted, textAlign: 'center', lineHeight: 18, paddingHorizontal: Spacing.sm },
});