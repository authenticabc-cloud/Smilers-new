import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useGlobalSearchParams, useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import * as AuthSession from 'expo-auth-session';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

// Deferred/lazy access — see src/providers/AuthProvider.tsx for why:
// expo-secure-store's own binding calls requireNativeModule('ExpoSecureStore')
// at module scope, which can throw if native module registration hasn't
// finished yet on an iOS cold start. Proxy defers the actual require() to
// first real use.
const SecureStore: typeof import('expo-secure-store') = new Proxy({} as any, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-secure-store')[prop];
  },
});

const OIDC_AUTHORITY = process.env.EXPO_PUBLIC_OIDC_AUTHORITY!;
const OIDC_CLIENT_ID = process.env.EXPO_PUBLIC_OIDC_CLIENT_ID!;
const REDIRECT_URI = 'smilers://auth-callback';

export default function NotFoundScreen() {
  const router = useRouter();
  const localParams = useLocalSearchParams();
  const globalParams = useGlobalSearchParams();
  const liveUrl = Linking.useURL();
  const { acceptTokens, isAuthenticated, setAuthError } = useAuth();
  const discovery = AuthSession.useAutoDiscovery(OIDC_AUTHORITY);

  const [phase, setPhase] = useState<'detecting' | 'exchanging' | 'success' | 'error' | 'not-auth'>(
    'detecting'
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const handledRef = useRef(false);

  const addLog = (msg: string) => {
    console.log('[notfound]', msg);
    setLogs((cur) => [...cur, `${new Date().toISOString().slice(11, 19)}  ${msg}`]);
  };

  useEffect(() => {
    if (isAuthenticated) {
      addLog('already authenticated → /chats');
      router.replace('/(tabs)/chats');
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    if (handledRef.current || isAuthenticated) return;

    const tryPickOne = (val: unknown): string | undefined => {
      if (typeof val === 'string') return val;
      if (Array.isArray(val)) return typeof val[0] === 'string' ? val[0] : undefined;
      return undefined;
    };

    (async () => {
      const initialUrl = await Linking.getInitialURL().catch(() => null);
      addLog(`mounted. liveUrl=${liveUrl || '<null>'}`);
      addLog(`initialUrl=${initialUrl || '<null>'}`);
      addLog(`localParams keys: ${Object.keys(localParams).join(',')}`);
      addLog(`globalParams keys: ${Object.keys(globalParams).join(',')}`);

      const candidates = [liveUrl, initialUrl].filter(Boolean) as string[];

      let code = tryPickOne(localParams.code) || tryPickOne(globalParams.code);
      let state = tryPickOne(localParams.state) || tryPickOne(globalParams.state);
      let error = tryPickOne(localParams.error) || tryPickOne(globalParams.error);
      let errorDescription =
        tryPickOne(localParams.error_description) || tryPickOne(globalParams.error_description);
      let idToken = tryPickOne(localParams.id_token) || tryPickOne(globalParams.id_token) || tryPickOne(localParams.idToken) || tryPickOne(globalParams.idToken);
      let accessToken = tryPickOne(localParams.access_token) || tryPickOne(globalParams.access_token);
      let refreshToken = tryPickOne(localParams.refresh_token) || tryPickOne(globalParams.refresh_token);
      let expiresIn = tryPickOne(localParams.expires_in) || tryPickOne(globalParams.expires_in);

      if ((!code || !state) && candidates.length) {
        for (const url of candidates) {
          try {
            const queryIndex = url.indexOf('?');
            if (queryIndex < 0) continue;
            const params = new URLSearchParams(url.substring(queryIndex + 1));
            if (!code) code = params.get('code') || undefined;
            if (!state) state = params.get('state') || undefined;
            if (!error) error = params.get('error') || undefined;
            if (!errorDescription) errorDescription = params.get('error_description') || undefined;
            if (!idToken) idToken = params.get('id_token') || params.get('idToken') || undefined;
            if (!accessToken) accessToken = params.get('access_token') || undefined;
            if (!refreshToken) refreshToken = params.get('refresh_token') || undefined;
            if (!expiresIn) expiresIn = params.get('expires_in') || undefined;
            if (code || error || idToken) break;
          } catch {}
        }
      }

      addLog(`parsed code=${code ? `${code.slice(0, 8)}…` : '<none>'}`);
      addLog(`parsed state=${state ? `${state.slice(0, 6)}…` : '<none>'}`);

      if (error) {
        handledRef.current = true;
        const message = errorDescription || error;
        setErrMsg(message);
        setAuthError(message);
        setPhase('error');
        return;
      }

      if (idToken) {
        handledRef.current = true;
        setPhase('exchanging');
        addLog('received bridge tokens from web sign-in');
        try {
          await acceptTokens({
            idToken,
            accessToken: accessToken || undefined,
            refreshToken: refreshToken || undefined,
            expiresIn: expiresIn ? Number(expiresIn) : 3600,
          });
          addLog('bridge token sign-in complete — routing to /chats');
          setPhase('success');
          setTimeout(() => {
            router.replace('/(tabs)/chats');
          }, 80);
        } catch (errorValue: any) {
          const message = errorValue?.message || 'Bridge sign-in failed';
          addLog(`ERROR: ${message}`);
          setErrMsg(message);
          setAuthError(message);
          setPhase('error');
        }
        return;
      }

      if (!code) {
        setPhase('not-auth');
        return;
      }

      if (!discovery) {
        addLog('waiting for OIDC discovery…');
        return;
      }

      handledRef.current = true;
      setPhase('exchanging');
      addLog(`exchanging at ${discovery.tokenEndpoint}`);

      try {
        const safeGet = async (key: string) => {
          try {
            return await SecureStore.getItemAsync(key);
          } catch {
            return null;
          }
        };

        const codeVerifier = await safeGet('smilers_pkce_verifier');
        const storedState = await safeGet('smilers_pkce_state');
        addLog(
          `pkce verifier: ${codeVerifier ? 'present' : 'MISSING'}, stored state: ${storedState ? 'present' : 'MISSING'}`
        );

        if (storedState && state && storedState !== state) {
          throw new Error('State mismatch — possible CSRF.');
        }

        const tokenResult = await AuthSession.exchangeCodeAsync(
          {
            clientId: OIDC_CLIENT_ID,
            code,
            redirectUri: REDIRECT_URI,
            extraParams: codeVerifier ? { code_verifier: codeVerifier } : undefined,
          },
          discovery
        );

        SecureStore.deleteItemAsync('smilers_pkce_verifier').catch(() => {});
        SecureStore.deleteItemAsync('smilers_pkce_state').catch(() => {});

        const anyResult = tokenResult as AuthSession.TokenResponse & {
          idToken?: string;
          id_token?: string;
        };
        const idToken = anyResult.idToken || anyResult.id_token;

        if (!idToken) {
          throw new Error('Token endpoint returned no id_token.');
        }

        addLog('tokens received — storing');
        await acceptTokens({
          idToken,
          accessToken: tokenResult.accessToken,
          refreshToken: tokenResult.refreshToken,
          expiresIn: tokenResult.expiresIn ?? 3600,
        });
        addLog('done — routing to /chats');
        setPhase('success');
        setTimeout(() => {
          try {
            router.replace('/(tabs)/chats');
          } catch (errorValue) {
            addLog(`router.replace failed: ${String(errorValue)}`);
          }
        }, 80);
      } catch (errorValue: any) {
        const message = errorValue?.message || 'Sign-in failed';
        addLog(`ERROR: ${message}`);
        setErrMsg(message);
        setAuthError(message);
        setPhase('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discovery, isAuthenticated]);

  return (
    <SafeAreaView
      style={styles.container}
      edges={['top', 'bottom']}
      testID="oidc-callback-screen"
    >
      <View style={styles.card} testID="oidc-callback-card">
        {phase === 'detecting' && (
          <>
            <ActivityIndicator color={Colors.primary} size="large" />
            <Text style={styles.title} testID="oidc-callback-title">
              Returning to Smilers…
            </Text>
            <Text style={styles.subtitle} testID="oidc-callback-subtitle">
              Reading callback parameters.
            </Text>
          </>
        )}
        {phase === 'exchanging' && (
          <>
            <ActivityIndicator color={Colors.primary} size="large" />
            <Text style={styles.title} testID="oidc-callback-title">
              Signing you in…
            </Text>
            <Text style={styles.subtitle} testID="oidc-callback-subtitle">
              Exchanging authorization code for tokens.
            </Text>
          </>
        )}
        {phase === 'success' && (
          <>
            <Ionicons name="checkmark-circle" size={56} color="#16a34a" />
            <Text style={styles.title} testID="oidc-callback-title">
              Signed in
            </Text>
            <Text style={styles.subtitle} testID="oidc-callback-subtitle">
              Loading your chats…
            </Text>
          </>
        )}
        {phase === 'error' && (
          <>
            <Ionicons name="alert-circle" size={56} color="#B91C1C" />
            <Text style={styles.title} testID="oidc-callback-title">
              Sign-in failed
            </Text>
            <Text style={styles.subtitle} testID="oidc-callback-subtitle">
              {errMsg}
            </Text>
            <TouchableOpacity
              style={styles.btn}
              onPress={() => router.replace('/')}
              testID="oidc-callback-retry-button"
            >
              <Text style={styles.btnText}>Try again</Text>
            </TouchableOpacity>
          </>
        )}
        {phase === 'not-auth' && (
          <>
            <Ionicons name="help-circle" size={56} color={Colors.textSecondary} />
            <Text style={styles.title} testID="oidc-callback-title">
              Page not found
            </Text>
            <Text style={styles.subtitle} testID="oidc-callback-subtitle">
              The link you followed isn't valid.
            </Text>
            <TouchableOpacity
              style={styles.btn}
              onPress={() => router.replace('/')}
              testID="oidc-callback-home-button"
            >
              <Text style={styles.btnText}>Go home</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      <ScrollView style={styles.logsBox} contentContainerStyle={styles.logsContent} testID="oidc-callback-logs">
        <Text style={styles.logsTitle} testID="oidc-callback-logs-title">
          Debug log · v2.0.12
        </Text>
        {logs.map((line, index) => (
          <Text key={index} style={styles.logLine} testID={`oidc-callback-log-${index}`}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    padding: Spacing.lg,
  },
  card: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: Spacing.xl,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginTop: 4,
  },
  subtitle: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.base,
  },
  btn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: Radius.pill,
    marginTop: Spacing.base,
    minHeight: 44,
    justifyContent: 'center',
  },
  btnText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },
  logsBox: {
    flex: 1,
    backgroundColor: '#00000010',
    marginTop: Spacing.base,
    borderRadius: Radius.md,
    paddingHorizontal: 10,
  },
  logsContent: {
    paddingVertical: 8,
  },
  logsTitle: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    marginTop: 4,
    marginBottom: 4,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  logLine: {
    fontSize: 11,
    color: Colors.textPrimary,
    fontFamily: 'monospace',
    paddingVertical: 1,
  },
});