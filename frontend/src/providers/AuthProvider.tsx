import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const OIDC_AUTHORITY = process.env.EXPO_PUBLIC_OIDC_AUTHORITY!;
const OIDC_CLIENT_ID = process.env.EXPO_PUBLIC_OIDC_CLIENT_ID!;

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
  isAuthenticated: boolean;
  idToken: string | null;
  userInfo: { email?: string; name?: string; picture?: string; sub?: string } | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getFreshIdToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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
  const [userInfo, setUserInfo] = useState<AuthContextValue['userInfo']>(null);

  const discovery = AuthSession.useAutoDiscovery(OIDC_AUTHORITY);

  const redirectUri = AuthSession.makeRedirectUri({
    scheme: 'smilers',
    path: 'auth-callback',
  });

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: OIDC_CLIENT_ID,
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      redirectUri,
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
              redirectUri,
              extraParams: request.codeVerifier
                ? { code_verifier: request.codeVerifier }
                : undefined,
            },
            discovery
          );
          await storeTokens(tokenResult);
        } catch (e) {
          console.error('Token exchange failed:', e);
        } finally {
          setIsLoading(false);
        }
      })();
    } else if (response?.type === 'error') {
      console.error('Auth error:', response.params);
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response, discovery]);

  const storeTokens = async (tokenResult: AuthSession.TokenResponse) => {
    const anyResult = tokenResult as any;
    const idTokenValue: string = anyResult.idToken || anyResult.id_token || '';
    const refreshTokenValue: string | undefined = tokenResult.refreshToken;
    const expiresIn: number = tokenResult.expiresIn || 3600;

    const expiryTime = Date.now() + expiresIn * 1000;

    if (idTokenValue) {
      await storage.setItem(STORAGE_KEYS.ID_TOKEN, idTokenValue);
      setIdToken(idTokenValue);
      setUserInfo(parseJwt(idTokenValue));
    }
    if (tokenResult.accessToken) {
      await storage.setItem(STORAGE_KEYS.ACCESS_TOKEN, tokenResult.accessToken);
    }
    if (refreshTokenValue) {
      await storage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshTokenValue);
    }
    await storage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, expiryTime.toString());
  };

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
    ]);
    setIdToken(null);
    setUserInfo(null);
  };

  const signIn = useCallback(async () => {
    if (!request) {
      console.warn('Auth request not ready yet');
      return;
    }
    await promptAsync();
  }, [request, promptAsync]);

  const signOut = useCallback(async () => {
    await clearTokens();
  }, []);

  const getFreshIdToken = useCallback(async (): Promise<string | null> => {
    const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
    const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
    const refreshToken = await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN);

    if (Date.now() > expiry - 60000 && refreshToken) {
      return await refreshTokens(refreshToken);
    }
    return await storage.getItem(STORAGE_KEYS.ID_TOKEN);
  }, [refreshTokens]);

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        isAuthenticated: !!idToken,
        idToken,
        userInfo,
        signIn,
        signOut,
        getFreshIdToken,
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
