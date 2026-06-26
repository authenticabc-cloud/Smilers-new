import React, { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { sentry } from '../lib/sentry';
import { setDiagnosticUser } from '../lib/diagnostics';
import { callDebug } from '../lib/callDebugLog';

WebBrowser.maybeCompleteAuthSession();

const OIDC_AUTHORITY = process.env.EXPO_PUBLIC_OIDC_AUTHORITY!;
const OIDC_CLIENT_ID = process.env.EXPO_PUBLIC_OIDC_CLIENT_ID!;
const WEB_APP_URL = process.env.EXPO_PUBLIC_WEB_APP_URL || process.env.EXPO_PUBLIC_BACKEND_URL!;

const STORAGE_KEYS = {
  ID_TOKEN: 'smilers_id_token',
  ACCESS_TOKEN: 'smilers_access_token',
  REFRESH_TOKEN: 'smilers_refresh_token',
  TOKEN_EXPIRY: 'smilers_token_expiry',
};

// Storage abstraction — SecureStore on native, localStorage fallback on web
const storage = {
  async getItem(key: string): Promise<string | null> {
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.localStorage) {
          return window.localStorage.getItem(key);
        }
        return null;
      }
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(key, value);
        }
        return;
      }
      await SecureStore.setItemAsync(key, value);
    } catch {}
  },
  async removeItem(key: string): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.removeItem(key);
        }
        return;
      }
      await SecureStore.deleteItemAsync(key);
    } catch {}
  },
};

interface AuthContextValue {
  isLoading: boolean;
  isSignInReady: boolean;
  isAuthenticated: boolean;
  authMode: 'direct' | 'webview';
  idToken: string | null;
  lastError: string | null;
  userInfo: { email?: string; name?: string; picture?: string; sub?: string } | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getFreshIdToken: () => Promise<string | null>;
  acceptTokens: (tokens: {
    idToken: string;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  }) => Promise<void>;
  setAuthError: (msg: string | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const AUTH_MODE = process.env.EXPO_PUBLIC_AUTH_MODE === 'direct'
  ? 'direct'
  : WEB_APP_URL
    ? 'webview'
    : process.env.EXPO_PUBLIC_AUTH_MODE === 'webview'
      ? 'webview'
      : 'direct';

function parseJwt(token: string): any {
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json =
      typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<AuthContextValue['userInfo']>(null);

  // Keep the diagnostics module's currentUserId in sync with the OIDC
  // subject so any crash log POSTed via `flushDiagnostics()` is tied to
  // the user that experienced it. Strictly best-effort; never throws.
  // Also tag the Sentry user for native-crash attribution.
  useEffect(() => {
    try {
      setDiagnosticUser(userInfo?.sub ?? null);
    } catch {}
    try {
      if (userInfo?.sub) {
        sentry.setUser({
          id: String(userInfo.sub),
          email: userInfo?.email,
          username: userInfo?.name || undefined,
        });
      } else {
        sentry.setUser(null);
      }
    } catch {}
  }, [userInfo?.sub, userInfo?.email, userInfo?.name]);
  // Tracks the timestamp of the last successful refresh. Used to throttle
  // background refresh attempts so we don't hammer the OIDC endpoint.
  const lastRefreshAtRef = useRef<number>(0);
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discoveryReadyRef = useRef(false);
  // iter-191: persisted copy of the OIDC discovery document. On a cold start
  // (especially when Android launches us straight into the share sheet flow)
  // `useAutoDiscovery` needs a network round-trip — and `refreshTokens`
  // used to return null until it landed, handing Convex an EXPIRED id_token.
  // Convex then silently ran UNAUTHENTICATED (null user, empty contacts /
  // conversations) while the UI showed the user as signed in. The cached
  // endpoints let us refresh immediately on every launch after the first.
  const cachedDiscoveryRef = useRef<any>(null);

  const discovery = AuthSession.useAutoDiscovery(OIDC_AUTHORITY);

  useEffect(() => {
    (async () => {
      try {
        const raw = await storage.getItem('smilers_oidc_discovery');
        if (raw) cachedDiscoveryRef.current = JSON.parse(raw);
      } catch {}
    })();
  }, []);
  useEffect(() => {
    if (discovery?.tokenEndpoint) {
      cachedDiscoveryRef.current = discovery;
      storage
        .setItem(
          'smilers_oidc_discovery',
          JSON.stringify({
            tokenEndpoint: discovery.tokenEndpoint,
            authorizationEndpoint: discovery.authorizationEndpoint,
            revocationEndpoint: (discovery as any).revocationEndpoint,
            userInfoEndpoint: (discovery as any).userInfoEndpoint,
            endSessionEndpoint: (discovery as any).endSessionEndpoint,
          }),
        )
        .catch(() => {});
    }
  }, [discovery]);

  const directRedirectUri =
    Platform.OS === 'web'
      ? // iter-152 deployment fix: AuthSession.makeRedirectUri on web can return
        // the preview/sandbox host even after deploy. Anchor to the live
        // window.location.origin so OAuth callbacks land on whatever
        // domain the build is actually served from (preview, production,
        // custom domains).
        (typeof window !== 'undefined' && window.location?.origin
          ? `${window.location.origin}/auth-callback`
          : AuthSession.makeRedirectUri({ scheme: 'smilers', path: 'auth-callback' }))
      : AuthSession.makeRedirectUri({
          scheme: 'smilers',
          path: 'auth-callback',
          native: 'smilers://auth-callback',
        });

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: OIDC_CLIENT_ID,
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      redirectUri: directRedirectUri,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
    },
    discovery
  );

  // ────────────────────────────────────────────────────────────────────────────
  // Persistent session — Once a user signs in, they stay signed in.
  // ────────────────────────────────────────────────────────────────────────────
  //
  // Behaviour goals (per product spec, June 2025):
  //   1. The OIDC sign-in screen MUST appear at most once per device install.
  //   2. The only re-entry gate after the first sign-in is the App Lock
  //      (PIN / biometric) that the user themselves configured.
  //   3. Network blips MUST NOT log the user out.
  //   4. Tokens are refreshed silently in the background — never visible to UX.
  //
  // Implementation:
  //   • On mount we OPTIMISTICALLY restore the cached id_token regardless of
  //     its expiry — the user is treated as authenticated immediately, so
  //     the gate-keeper (`_layout.tsx`) doesn't bounce them to /index.
  //   • In the background we kick off a refresh whenever we have a stored
  //     refresh_token; failures are swallowed (we keep the cached session
  //     alive locally so the user can still use the app offline).
  //   • While the app is open we schedule a refresh ~5 min before expiry.
  //   • When the app returns to foreground (AppState 'active') we attempt
  //     a refresh if the token is past its expiry.
  //   • The user only loses their session via `signOut()` — explicit user
  //     intent.
  //
  // Refresh tokens are stored in SecureStore (hardware-backed Keychain on
  // iOS / EncryptedSharedPreferences on Android), so retaining them long-
  // term is safe.

  // Restore session on mount (runs once)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const storedIdToken = await storage.getItem(STORAGE_KEYS.ID_TOKEN);
        if (!cancelled && storedIdToken) {
          // OPTIMISTIC: trust the cached token regardless of expiry. If the
          // backend rejects it, our background-refresh will recover; if the
          // refresh ultimately fails the user can still use the app offline.
          // We do NOT bounce them to /index here.
          setIdToken(storedIdToken);
          setUserInfo(parseJwt(storedIdToken));
          callDebug.push('AUTH', 'restore: cached id_token found → optimistic session');
        } else if (!cancelled) {
          callDebug.push('AUTH', 'restore: NO cached id_token → signed out');
        }
      } catch (e) {
        console.warn('Restore session error:', e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Handle OIDC callback
  useEffect(() => {
    if (response?.type === 'success' && response.params.code && discovery && request) {
      (async () => {
        try {
          setIsLoading(true);
          const tokenResult = await AuthSession.exchangeCodeAsync(
            {
              clientId: OIDC_CLIENT_ID,
              code: response.params.code,
              redirectUri: directRedirectUri,
              extraParams: request.codeVerifier
                ? { code_verifier: request.codeVerifier }
                : undefined,
            },
            discovery
          );
          const anyResult = tokenResult as AuthSession.TokenResponse & {
            idToken?: string;
            id_token?: string;
          };
          const idTokenValue = anyResult.idToken || anyResult.id_token;
          if (!idTokenValue) {
            throw new Error('Token endpoint returned no id_token.');
          }
          await acceptTokens({
            idToken: idTokenValue,
            accessToken: tokenResult.accessToken,
            refreshToken: tokenResult.refreshToken,
            expiresIn: tokenResult.expiresIn || 3600,
          });
          setLastError(null);
        } catch (e) {
          console.error('Token exchange failed:', e);
          setLastError(e instanceof Error ? e.message : 'Token exchange failed');
        } finally {
          setIsLoading(false);
        }
      })();
    } else if (response?.type === 'error') {
      console.error('Auth error:', response.params);
      setLastError(response.params.error_description || response.params.error || 'Authentication failed');
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response, discovery]);

  const acceptTokens = useCallback(
    async (tokens: {
      idToken: string;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
    }) => {
      const expiresIn = tokens.expiresIn ?? 3600;
      const expiryTime = Date.now() + expiresIn * 1000;

      await storage.setItem(STORAGE_KEYS.ID_TOKEN, tokens.idToken);
      if (tokens.accessToken) {
        await storage.setItem(STORAGE_KEYS.ACCESS_TOKEN, tokens.accessToken);
      }
      if (tokens.refreshToken) {
        await storage.setItem(STORAGE_KEYS.REFRESH_TOKEN, tokens.refreshToken);
      }
      await storage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, expiryTime.toString());

      setIdToken(tokens.idToken);
      setUserInfo(parseJwt(tokens.idToken));
      setLastError(null);
    },
    []
  );

  const setAuthError = useCallback((msg: string | null) => setLastError(msg), []);

  const storeTokens = useCallback(
    async (tokenResult: AuthSession.TokenResponse) => {
      const anyResult = tokenResult as AuthSession.TokenResponse & {
        idToken?: string;
        id_token?: string;
      };
      const idTokenValue = anyResult.idToken || anyResult.id_token;

      if (!idTokenValue) {
        throw new Error('Token endpoint returned no id_token.');
      }

      await acceptTokens({
        idToken: idTokenValue,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        expiresIn: tokenResult.expiresIn || 3600,
      });
    },
    [acceptTokens]
  );

  const refreshTokens = useCallback(
    async (refreshToken: string): Promise<string | null> => {
      // iter-191: fall back to the persisted discovery document so token
      // refresh works even while (or if) the live discovery fetch is slow
      // or failing on a flaky connection.
      const disco = discovery || cachedDiscoveryRef.current;
      if (!disco) return null;
      // Deduplicate concurrent refresh attempts so multiple Convex callers
      // hitting `getFreshIdToken` at once all share the same network round-trip.
      if (refreshInFlightRef.current) {
        return refreshInFlightRef.current;
      }
      const promise = (async () => {
        try {
          const tokenResult = await AuthSession.refreshAsync(
            { clientId: OIDC_CLIENT_ID, refreshToken },
            disco
          );
          await storeTokens(tokenResult);
          lastRefreshAtRef.current = Date.now();
          const anyResult = tokenResult as any;
          return (anyResult.idToken || anyResult.id_token || null) as string | null;
        } catch (errorValue: any) {
          // IMPORTANT — historical bug: this used to call `clearTokens()` and
          // log the user out on the first transient failure (e.g. flaky wifi,
          // VPN flap, server hiccup). That meant a single bad ping forced the
          // user back through OIDC sign-in.
          //
          // New behaviour: swallow the error and KEEP the cached session
          // alive locally. Convex will continue to use the cached id_token;
          // if that's truly expired, individual queries may temporarily 401
          // until the next refresh succeeds, but the user is NEVER kicked
          // out of the app. They can keep navigating, viewing cached data,
          // queueing messages, etc.
          const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
          console.warn('Refresh failed (keeping cached session alive):', message);
          return null;
        } finally {
          refreshInFlightRef.current = null;
        }
      })();
      refreshInFlightRef.current = promise;
      return promise;
    },
    [discovery]
  );

  const clearTokens = async () => {
    await Promise.all([
      storage.removeItem(STORAGE_KEYS.ID_TOKEN),
      storage.removeItem(STORAGE_KEYS.ACCESS_TOKEN),
      storage.removeItem(STORAGE_KEYS.REFRESH_TOKEN),
      storage.removeItem(STORAGE_KEYS.TOKEN_EXPIRY),
      storage.removeItem('smilers_pkce_verifier'),
      storage.removeItem('smilers_pkce_state'),
    ]);
    setIdToken(null);
    setUserInfo(null);
    setLastError(null);
  };

  const signIn = useCallback(async () => {
    if (!request || !discovery) {
      console.warn('Auth request not ready yet');
      setLastError('Sign-in is still preparing. Please wait a moment and try again.');
      return;
    }
    try {
      if (request.codeVerifier) {
        await storage.setItem('smilers_pkce_verifier', request.codeVerifier);
      }
      if (request.state) {
        await storage.setItem('smilers_pkce_state', request.state);
      }
    } catch (e) {
      console.warn('Failed to stash PKCE state:', e);
    }
    setLastError(null);
    setIsLoading(true);
    try {
      const result = await promptAsync();
      if (result.type === 'dismiss' || result.type === 'cancel') {
        setIsLoading(false);
      }
    } catch (errorValue) {
      setIsLoading(false);
      setLastError(errorValue instanceof Error ? errorValue.message : 'Sign-in failed to start.');
    }
  }, [discovery, promptAsync, request]);

  const signOut = useCallback(async () => {
    await clearTokens();
  }, []);

  // Always call the LATEST refreshTokens (its closure captures `discovery`,
  // which is null on the very first calls after a cold start).
  const refreshTokensRef = useRef(refreshTokens);
  useEffect(() => {
    refreshTokensRef.current = refreshTokens;
  }, [refreshTokens]);

  const getFreshIdToken = useCallback(async (): Promise<string | null> => {
    const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
    const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
    const refreshToken = await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    const idToken = await storage.getItem(STORAGE_KEYS.ID_TOKEN);

    if (Date.now() > expiry - 60000 && refreshToken) {
      // iter-191: on a cold start Convex asks for a token within ~100ms,
      // long before `useAutoDiscovery` has fetched the OIDC endpoints.
      // Returning the EXPIRED cached id_token here made Convex run
      // unauthenticated for the whole session (empty contacts/chats in the
      // share sheet). Wait up to 5s for discovery (live or cached) so the
      // refresh can actually happen.
      if (!discoveryReadyRef.current && !cachedDiscoveryRef.current) {
        callDebug.push('AUTH', `getFreshIdToken: token expired, waiting for discovery…`);
        for (let i = 0; i < 20; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (discoveryReadyRef.current || cachedDiscoveryRef.current) break;
        }
      }
      const haveDisco = discoveryReadyRef.current || !!cachedDiscoveryRef.current;
      const refreshed = await refreshTokensRef.current(refreshToken);
      if (refreshed) {
        callDebug.push('AUTH', `getFreshIdToken: refresh OK (disco=${haveDisco})`);
        return refreshed;
      }
      // Refresh failed (network blip etc) — fall through and return the
      // cached id_token. Convex may 401 a few times until our background
      // retry succeeds; the user stays signed in.
      callDebug.push('ERR', `AUTH getFreshIdToken: refresh FAILED (disco=${haveDisco}, hasRefresh=${!!refreshToken}) → returning ${idToken ? 'STALE id_token' : 'null'}`);
    }
    // IMPORTANT: Convex validates the ID token (JWT) for user identity.
    // The access token does not contain the OIDC claims Convex needs (iss/sub),
    // so returning it here causes ctx.auth.getUserIdentity() to be null inside
    // queries/mutations/actions. Always return the ID token.
    if (!idToken) callDebug.push('ERR', 'AUTH getFreshIdToken: NO id_token in storage → unauthenticated');
    return idToken;
  }, [refreshTokens]);

  // ────────────────────────────────────────────────────────────────────────────
  // Background refresh — keeps the session alive silently.
  // ────────────────────────────────────────────────────────────────────────────

  // Track discovery readiness via a ref so we can read it inside callbacks
  // without re-running them every render.
  useEffect(() => {
    discoveryReadyRef.current = !!discovery;
  }, [discovery]);

  // 1) Kick off a refresh as soon as discovery is ready AND we have a session.
  useEffect(() => {
    if (!discovery || !idToken) return;
    let cancelled = false;
    (async () => {
      try {
        const refreshToken = await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
        if (!refreshToken || cancelled) return;
        const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
        const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
        const isExpiringSoon = Date.now() > expiry - 5 * 60 * 1000; // 5 min skew
        if (isExpiringSoon) {
          await refreshTokens(refreshToken);
        }
      } catch (e) {
        // Never crash the app over a background refresh.
        console.warn('Background refresh on mount failed (non-fatal):', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discovery, idToken, refreshTokens]);

  // 2) Schedule a refresh ~5 minutes before the current token expires.
  useEffect(() => {
    if (!discovery || !idToken) return;
    let cancelled = false;
    const schedule = async () => {
      const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
      const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
      // Default to refreshing in ~50 minutes if we have no expiry info.
      const fallbackDelay = 50 * 60 * 1000;
      const targetDelay = expiry
        ? Math.max(60 * 1000, expiry - Date.now() - 5 * 60 * 1000)
        : fallbackDelay;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = setTimeout(async () => {
        if (cancelled) return;
        try {
          const refreshToken = await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
          if (refreshToken) await refreshTokens(refreshToken);
        } catch (e) {
          console.warn('Scheduled refresh failed (non-fatal):', e);
        } finally {
          if (!cancelled) void schedule(); // Re-schedule next cycle.
        }
      }, targetDelay);
    };
    void schedule();
    return () => {
      cancelled = true;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [discovery, idToken, refreshTokens]);

  // 3) When the app comes back to foreground after being backgrounded,
  // refresh tokens if they're past their expiry. This handles the common
  // case where the user locks the phone for hours / overnight and reopens
  // the app — without this they'd silently lose their Convex auth until
  // the next user-triggered action.
  useEffect(() => {
    if (Platform.OS === 'web') return; // AppState only meaningful on native
    const handleAppStateChange = async (next: AppStateStatus) => {
      if (next !== 'active') return;
      if (!discoveryReadyRef.current) return;
      try {
        const refreshToken = await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
        const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
        const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
        // Refresh if we have a refresh token and either the token is
        // expired/expiring or we haven't refreshed in the last 30 minutes.
        const shouldRefresh =
          !!refreshToken &&
          (Date.now() > expiry - 60 * 1000 ||
            Date.now() - lastRefreshAtRef.current > 30 * 60 * 1000);
        if (shouldRefresh && refreshToken) {
          await refreshTokens(refreshToken);
        }
      } catch (e) {
        console.warn('Foreground refresh failed (non-fatal):', e);
      }
    };
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      sub.remove();
    };
  }, [refreshTokens]);

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        isSignInReady: !!request && !!discovery,
        isAuthenticated: !!idToken,
        authMode: AUTH_MODE,
        idToken,
        lastError,
        userInfo,
        signIn,
        signOut,
        getFreshIdToken,
        acceptTokens,
        setAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
