import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

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
  const [isLoading, setIsLoading] = useState(false);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<AuthContextValue['userInfo']>(null);

  const discovery = AuthSession.useAutoDiscovery(OIDC_AUTHORITY);

  const directRedirectUri =
    Platform.OS === 'web'
      ? AuthSession.makeRedirectUri({ scheme: 'smilers', path: 'auth-callback' })
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

  // Restore session on mount (runs once)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const storedIdToken = await storage.getItem(STORAGE_KEYS.ID_TOKEN);
        const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
        if (!cancelled && storedIdToken) {
          const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
          // Use stored token if valid, will refresh later if needed
          if (Date.now() < expiry - 30000 || expiry === 0) {
            setIdToken(storedIdToken);
            setUserInfo(parseJwt(storedIdToken));
          }
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
      if (!discovery) return null;
      try {
        const tokenResult = await AuthSession.refreshAsync(
          { clientId: OIDC_CLIENT_ID, refreshToken },
          discovery
        );
        await storeTokens(tokenResult);
        const anyResult = tokenResult as any;
        return anyResult.idToken || anyResult.id_token || null;
      } catch (e) {
        console.error('Refresh failed:', e);
        await clearTokens();
        return null;
      }
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

  const getFreshIdToken = useCallback(async (): Promise<string | null> => {
    const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
    const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
    const refreshToken = await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    const idToken = await storage.getItem(STORAGE_KEYS.ID_TOKEN);

    if (Date.now() > expiry - 60000 && refreshToken) {
      return await refreshTokens(refreshToken);
    }
    // IMPORTANT: Convex validates the ID token (JWT) for user identity.
    // The access token does not contain the OIDC claims Convex needs (iss/sub),
    // so returning it here causes ctx.auth.getUserIdentity() to be null inside
    // queries/mutations/actions. Always return the ID token.
    return idToken;
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
