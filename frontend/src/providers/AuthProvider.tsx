import React, { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sentry } from '../lib/sentry';
import { setDiagnosticUser } from '../lib/diagnostics';
import { callDebug } from '../lib/callDebugLog';

// Deferred/lazy access: expo-secure-store's own binding file calls
// requireNativeModule('ExpoSecureStore') at ITS module scope, which can
// throw if the native module registry hasn't finished registering yet on
// an iOS cold start (observed intermittently in production — see the
// module-inventory boot diagnostics). A Proxy defers the actual require()
// until the first real property access (well after this file itself is
// imported at _layout.tsx module scope), instead of at import time.
const SecureStore: typeof import('expo-secure-store') = new Proxy({} as any, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-secure-store')[prop];
  },
});

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

// ────────────────────────────────────────────────────────────────────────────
// Storage abstraction — SecureStore on native, localStorage fallback on web
// ────────────────────────────────────────────────────────────────────────────
//
// iter-316 CRITICAL AUTH FIX — "Your sign-in session expired or couldn't be
// refreshed" (terminal logout only fixed by reinstall).
//
// ROOT CAUSE: Android's SecureStore (EncryptedSharedPreferences) rejects values
// larger than ~2048 bytes. Rotated OIDC refresh tokens (and rich id_tokens)
// routinely exceed that. The OLD `setItem` swallowed the write error with
// `catch {}`, so the freshly-rotated refresh token was SILENTLY dropped while
// the server had already retired the previous one. On the next launch we
// refreshed against the now-dead token → `invalid_grant` → sessionExpired →
// the user was kicked out until they reinstalled the app.
//
// FIX (per Hercules OIDC storage playbook): CHUNK large values across multiple
// <2KB SecureStore entries, fall back to AsyncStorage if SecureStore still
// fails, and NEVER swallow write failures silently — every failure is logged
// to the in-app diagnostics so a stored token is never lost unnoticed.
// Existing single-key (legacy) values are still read transparently and are
// re-written in the new format on the next save (one-time migration).
const SECURE_CHUNK_SIZE = 1800; // chars; conservative margin under the ~2KB limit
const META_SUFFIX = '__meta';
const CHUNK_SUFFIX = '__chunk_';

const isWeb = Platform.OS === 'web';

function webGet(key: string): string | null {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage.getItem(key);
  return null;
}
function webSet(key: string, value: string): void {
  if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, value);
}
function webRemove(key: string): void {
  if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(key);
}

// Write `value` to SecureStore, chunking if it exceeds the size limit. Throws on
// failure (after cleaning up any partial chunks) so the caller can fall back.
async function secureWriteChunked(key: string, value: string): Promise<void> {
  if (value.length <= SECURE_CHUNK_SIZE) {
    await SecureStore.setItemAsync(key, value);
    await SecureStore.setItemAsync(key + META_SUFFIX, JSON.stringify({ strategy: 'single' }));
    return;
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += SECURE_CHUNK_SIZE) {
    chunks.push(value.slice(offset, offset + SECURE_CHUNK_SIZE));
  }
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      await SecureStore.setItemAsync(`${key}${CHUNK_SUFFIX}${i}`, chunks[i]);
    }
    await SecureStore.setItemAsync(key + META_SUFFIX, JSON.stringify({ strategy: 'chunks', count: chunks.length }));
  } catch (err) {
    // Roll back partial writes so a later read never reconstructs a corrupt value.
    for (let i = 0; i < chunks.length; i += 1) {
      await SecureStore.deleteItemAsync(`${key}${CHUNK_SUFFIX}${i}`).catch(() => {});
    }
    await SecureStore.deleteItemAsync(key + META_SUFFIX).catch(() => {});
    throw err;
  }
}

async function secureReadChunked(key: string): Promise<string | null> {
  const metaRaw = await SecureStore.getItemAsync(key + META_SUFFIX);
  if (!metaRaw) {
    // No metadata → legacy single-key value (or nothing).
    return SecureStore.getItemAsync(key);
  }
  let meta: { strategy?: string; count?: number };
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    return SecureStore.getItemAsync(key);
  }
  if (meta.strategy === 'single') return SecureStore.getItemAsync(key);
  if (meta.strategy === 'chunks' && typeof meta.count === 'number') {
    const parts: string[] = [];
    for (let i = 0; i < meta.count; i += 1) {
      const part = await SecureStore.getItemAsync(`${key}${CHUNK_SUFFIX}${i}`);
      if (part == null) return null; // incomplete → treat as missing, don't reconstruct garbage
      parts.push(part);
    }
    return parts.join('');
  }
  return null;
}

async function secureRemoveChunked(key: string): Promise<void> {
  const metaRaw = await SecureStore.getItemAsync(key + META_SUFFIX);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as { strategy?: string; count?: number };
      if (meta.strategy === 'chunks' && typeof meta.count === 'number') {
        for (let i = 0; i < meta.count; i += 1) {
          await SecureStore.deleteItemAsync(`${key}${CHUNK_SUFFIX}${i}`).catch(() => {});
        }
      }
    } catch {
      /* fall through */
    }
    await SecureStore.deleteItemAsync(key + META_SUFFIX).catch(() => {});
  }
  await SecureStore.deleteItemAsync(key).catch(() => {});
}

// iter-316: describe HOW a value is currently persisted (which backend, size,
// chunk count) — powers the on-device "Session health" card so the user can
// confirm token persistence on their real device without pulling logs.
export interface StoredValueInfo {
  backend:
    | 'securestore'
    | 'securestore-chunked'
    | 'securestore-legacy'
    | 'asyncstorage-fallback'
    | 'localStorage'
    | 'none';
  chars: number;
  chunks?: number;
}

async function describeStoredValue(key: string): Promise<StoredValueInfo> {
  if (isWeb) {
    const v = webGet(key);
    return { backend: v != null ? 'localStorage' : 'none', chars: v?.length ?? 0 };
  }
  const metaRaw = await SecureStore.getItemAsync(key + META_SUFFIX).catch(() => null);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as { strategy?: string; count?: number };
      if (meta.strategy === 'single') {
        const v = await SecureStore.getItemAsync(key).catch(() => null);
        return { backend: 'securestore', chars: v?.length ?? 0 };
      }
      if (meta.strategy === 'chunks') {
        const full = await secureReadChunked(key).catch(() => null);
        return { backend: 'securestore-chunked', chars: full?.length ?? 0, chunks: meta.count };
      }
    } catch {
      /* fall through */
    }
  }
  const legacy = await SecureStore.getItemAsync(key).catch(() => null);
  if (legacy != null) return { backend: 'securestore-legacy', chars: legacy.length };
  const asyncVal = await AsyncStorage.getItem(key).catch(() => null);
  if (asyncVal != null) return { backend: 'asyncstorage-fallback', chars: asyncVal.length };
  return { backend: 'none', chars: 0 };
}

export interface SessionHealth {
  authenticated: boolean;
  sessionExpired: boolean;
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
  refreshTokenDead: boolean;
  tokenExpiry: number | null;
  refreshToken: StoredValueInfo;
  idToken: StoredValueInfo;
  accessToken: StoredValueInfo;
}

const storage = {
  async getItem(key: string): Promise<string | null> {
    if (isWeb) return webGet(key);
    try {
      const secureValue = await secureReadChunked(key);
      if (secureValue != null) return secureValue;
    } catch (err) {
      callDebug.push('ERR', `AUTH storage.getItem(${key}) SecureStore read failed: ${String(err).slice(0, 120)}`);
    }
    // AsyncStorage fallback (values written when SecureStore rejected them).
    try {
      const asyncValue = await AsyncStorage.getItem(key);
      if (asyncValue != null) return asyncValue;
    } catch {
      /* ignore */
    }
    return null;
  },
  async setItem(key: string, value: string): Promise<void> {
    if (isWeb) {
      webSet(key, value);
      return;
    }
    try {
      await secureWriteChunked(key, value);
      // Success via SecureStore → drop any stale AsyncStorage fallback copy.
      await AsyncStorage.removeItem(key).catch(() => {});
      return;
    } catch (secureErr) {
      // SecureStore still failed (e.g. oversized even chunked, or keystore
      // issue). Fall back to AsyncStorage so the ROTATED token is NEVER lost —
      // losing it is what silently logs the user out. Log loudly; never swallow.
      callDebug.push(
        'ERR',
        `AUTH storage.setItem(${key}) SecureStore FAILED (${String(secureErr).slice(0, 100)}) → AsyncStorage fallback`,
      );
      try {
        await AsyncStorage.setItem(key, value);
        // Clear any partial SecureStore state so reads prefer the fallback.
        await secureRemoveChunked(key).catch(() => {});
      } catch (asyncErr) {
        callDebug.push('ERR', `AUTH storage.setItem(${key}) AsyncStorage fallback ALSO FAILED: ${String(asyncErr).slice(0, 100)}`);
      }
    }
  },
  async removeItem(key: string): Promise<void> {
    if (isWeb) {
      webRemove(key);
      return;
    }
    await secureRemoveChunked(key).catch(() => {});
    await AsyncStorage.removeItem(key).catch(() => {});
  },
};

interface AuthContextValue {
  isLoading: boolean;
  isSignInReady: boolean;
  isAuthenticated: boolean;
  // iter-295: true when the refresh token is terminally rejected
  // (invalid_grant etc.) — the session can't be silently renewed and the user
  // must re-authenticate. Lets the UI surface recovery instantly.
  sessionExpired: boolean;
  authMode: 'direct' | 'webview';
  idToken: string | null;
  lastError: string | null;
  userInfo: { email?: string; name?: string; picture?: string; sub?: string } | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getFreshIdToken: (force?: boolean) => Promise<string | null>;
  trySilentReauth: () => Promise<boolean>;
  acceptTokens: (tokens: {
    idToken: string;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  }) => Promise<void>;
  setAuthError: (msg: string | null) => void;
  // iter-316: on-device session/token-persistence snapshot for the
  // "Session health" diagnostics card.
  getSessionHealth: () => Promise<SessionHealth>;
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
  // iter-295: remember the LAST refresh failure reason so we can (a) surface it
  // in diagnostics and (b) distinguish a TERMINAL revocation (invalid_grant)
  // from a transient/network blip. A terminal failure means the refresh token
  // is dead (rotated-token reuse, revoked, or absolute-expiry) → the user must
  // re-auth; a transient failure should keep the cached session and retry.
  const lastRefreshErrorRef = useRef<string | null>(null);
  const refreshTokenDeadRef = useRef<boolean>(false);
  // State mirror of refreshTokenDeadRef so the UI re-renders and can surface
  // the recovery screen the instant a terminal refresh failure happens.
  const [sessionExpired, setSessionExpired] = useState(false);
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
      } else {
        // iter-296 CRITICAL: a fresh login that does NOT carry a new refresh
        // token must DISCARD any refresh token left over from a previous
        // session. Otherwise getFreshIdToken later refreshes against that
        // stale token whose server session is gone → `invalid_grant: session
        // not found` → we mark the session dead and bounce the user even
        // though they JUST signed in (the "chats flash for 2s then spin
        // forever" bug). With no refresh token we simply use the freshly
        // issued id_token until it genuinely expires.
        await storage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
      }
      await storage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, expiryTime.toString());

      // Fresh login → clear any terminal-failure state from a prior session.
      refreshTokenDeadRef.current = false;
      lastRefreshErrorRef.current = null;
      setSessionExpired(false);

      setIdToken(tokens.idToken);
      setUserInfo(parseJwt(tokens.idToken));
      setLastError(null);
    },
    []
  );

  const setAuthError = useCallback((msg: string | null) => setLastError(msg), []);

  // iter-316: snapshot of the current session + how each token is persisted.
  const getSessionHealth = useCallback(async (): Promise<SessionHealth> => {
    const [refreshInfo, idInfo, accessInfo] = await Promise.all([
      describeStoredValue(STORAGE_KEYS.REFRESH_TOKEN),
      describeStoredValue(STORAGE_KEYS.ID_TOKEN),
      describeStoredValue(STORAGE_KEYS.ACCESS_TOKEN),
    ]);
    const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
    const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
    return {
      authenticated: !!idToken,
      sessionExpired,
      lastRefreshAt: lastRefreshAtRef.current || null,
      lastRefreshError: lastRefreshErrorRef.current,
      refreshTokenDead: refreshTokenDeadRef.current,
      tokenExpiry: expiry || null,
      refreshToken: refreshInfo,
      idToken: idInfo,
      accessToken: accessInfo,
    };
  }, [idToken, sessionExpired]);

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
      // Perform ONE refresh round-trip with the given token, persisting the
      // rotated tokens on success. Throws the provider error on failure.
      const attempt = async (token: string): Promise<string | null> => {
        const tokenResult = await AuthSession.refreshAsync(
          { clientId: OIDC_CLIENT_ID, refreshToken: token },
          disco
        );
        await storeTokens(tokenResult);
        lastRefreshAtRef.current = Date.now();
        refreshTokenDeadRef.current = false;
        lastRefreshErrorRef.current = null;
        const anyResult = tokenResult as any;
        return (anyResult.idToken || anyResult.id_token || null) as string | null;
      };

      const classify = (errorValue: any) => {
        const code = String(errorValue?.code || errorValue?.error || '').toLowerCase();
        const desc =
          errorValue?.description || errorValue?.error_description || errorValue?.message || String(errorValue);
        // OAuth terminal errors: the refresh token is no longer usable
        // (revoked, expired, or a rotated-token reuse was detected).
        const isTerminal =
          code === 'invalid_grant' ||
          code === 'invalid_token' ||
          code === 'unauthorized_client' ||
          code === 'invalid_client';
        return { code, desc, isTerminal };
      };

      const promise = (async () => {
        try {
          // iter-312 RACE FIX: re-read the FRESHEST refresh token from storage
          // INSIDE the single-flight critical section. On resume-from-idle
          // (overnight) several subsystems ask for a token at once; the caller
          // may have read `refreshToken` moments before a concurrent refresh
          // rotated it. Submitting that stale token → `invalid_grant` → we used
          // to mark the session terminally dead → "No chats yet" until manual
          // sign-out/in. Always submit the latest stored token instead.
          const latest = (await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN)) || refreshToken;
          try {
            return await attempt(latest);
          } catch (firstErr: any) {
            const first = classify(firstErr);
            lastRefreshErrorRef.current = first.code || first.desc;
            if (first.isTerminal) {
              // A concurrent refresher may have rotated the token between our
              // read and submit. Re-read; if it changed, this was a rotation
              // RACE (not a real revocation) → retry ONCE with the new token
              // before declaring the session dead.
              const newer = await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
              if (newer && newer !== latest) {
                try {
                  const recovered = await attempt(newer);
                  callDebug.push('AUTH', 'refresh recovered via rotated token (race resolved)');
                  return recovered;
                } catch (retryErr: any) {
                  const second = classify(retryErr);
                  lastRefreshErrorRef.current = second.code || second.desc;
                  if (second.isTerminal) {
                    refreshTokenDeadRef.current = true;
                    setSessionExpired(true);
                    try {
                      await storage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
                    } catch {
                      /* ignore */
                    }
                  }
                  callDebug.push(
                    'ERR',
                    `AUTH refresh retry failed: code=${second.code || '?'} terminal=${second.isTerminal}`,
                  );
                  return null;
                }
              }
              // No newer token in storage → genuine terminal revocation/expiry.
              // Purge the dead token so we stop retrying and surface re-auth.
              refreshTokenDeadRef.current = true;
              setSessionExpired(true);
              try {
                await storage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
              } catch {
                /* ignore */
              }
            }
            // Non-terminal (network blip etc.) → KEEP the cached session alive;
            // Convex may 401 briefly until a later refresh succeeds, but the
            // user is never kicked out.
            callDebug.push(
              'ERR',
              `AUTH refreshAsync threw: code=${first.code || '?'} terminal=${first.isTerminal} msg=${String(first.desc).slice(0, 140)}`,
            );
            console.warn('Refresh failed (keeping cached session alive):', first.code || first.desc);
            return null;
          }
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
    refreshTokenDeadRef.current = false;
    setSessionExpired(false);
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

  // WhatsApp-style silent recovery. When the refresh token is terminally dead
  // (invalid_grant / rotation-reuse revoked) but the Hercules SSO browser
  // session is still alive, an OIDC `prompt=none` authorize call mints a fresh
  // token set WITHOUT showing the sign-in portal. Returns true if the session
  // was seamlessly restored (acceptTokens clears sessionExpired). On native the
  // system browser shares cookies with the Hercules SSO session, so this is
  // usually invisible; if the SSO session is also gone it fails fast with
  // login_required and the caller falls back to the interactive sign-in wall.
  const trySilentReauth = useCallback(async (): Promise<boolean> => {
    const disco = discovery || cachedDiscoveryRef.current;
    if (!disco) return false;
    try {
      const req = new AuthSession.AuthRequest({
        clientId: OIDC_CLIENT_ID,
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        redirectUri: directRedirectUri,
        responseType: AuthSession.ResponseType.Code,
        usePKCE: true,
        extraParams: { prompt: 'none' },
      });
      await req.makeAuthUrlAsync(disco);
      const result = await req.promptAsync(disco);
      if (result.type !== 'success' || !result.params?.code) {
        callDebug.push(
          'AUTH',
          `silent reauth: no code (type=${result.type}, err=${(result as any)?.params?.error || '-'})`,
        );
        return false;
      }
      const tokenResult = await AuthSession.exchangeCodeAsync(
        {
          clientId: OIDC_CLIENT_ID,
          code: result.params.code,
          redirectUri: directRedirectUri,
          extraParams: req.codeVerifier ? { code_verifier: req.codeVerifier } : undefined,
        },
        disco,
      );
      const anyResult = tokenResult as AuthSession.TokenResponse & {
        idToken?: string;
        id_token?: string;
      };
      const idv = anyResult.idToken || anyResult.id_token;
      if (!idv) return false;
      await acceptTokens({
        idToken: idv,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        expiresIn: tokenResult.expiresIn || 3600,
      });
      callDebug.push('AUTH', 'silent reauth: SUCCESS → session restored without sign-in wall');
      return true;
    } catch (e: any) {
      callDebug.push('ERR', `silent reauth failed: ${String(e?.message || e).slice(0, 140)}`);
      return false;
    }
  }, [discovery, directRedirectUri, acceptTokens]);

  // Always call the LATEST refreshTokens (its closure captures `discovery`,
  // which is null on the very first calls after a cold start).
  const refreshTokensRef = useRef(refreshTokens);
  useEffect(() => {
    refreshTokensRef.current = refreshTokens;
  }, [refreshTokens]);

  const getFreshIdToken = useCallback(async (force = false): Promise<string | null> => {
    const expiryStr = await storage.getItem(STORAGE_KEYS.TOKEN_EXPIRY);
    const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
    const refreshToken = await storage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    const idToken = await storage.getItem(STORAGE_KEYS.ID_TOKEN);

    const nearExpiry = Date.now() > expiry - 60000;
    // iter-306: honor Convex's `forceRefreshToken`. When Convex is handed our
    // id_token and the server REJECTS it, Convex re-requests a token with
    // force=true — i.e. "that one was bad, give me a genuinely fresh one".
    // Previously we ignored force and only refreshed on near-expiry, then on
    // any failure returned the SAME stale id_token. Result: Convex stayed
    // permanently unauthenticated on that device (getCurrentUser → null, so
    // name shows only from cache, no photo loads, chats resolve empty →
    // "No chats yet" / "feels offline"), recoverable ONLY by a manual
    // sign-out/in. Honoring force lets the session self-heal by actually
    // rotating the token. We skip when the refresh token is already known
    // dead (terminal) so we don't hammer the endpoint — that path routes to
    // the re-auth screen instead.
    if ((force || nearExpiry) && refreshToken && !refreshTokenDeadRef.current) {
      // iter-191: on a cold start Convex asks for a token within ~100ms,
      // long before `useAutoDiscovery` has fetched the OIDC endpoints.
      // Wait up to 5s for discovery (live or cached) so the refresh can
      // actually happen instead of returning an expired id_token.
      if (!discoveryReadyRef.current && !cachedDiscoveryRef.current) {
        callDebug.push('AUTH', `getFreshIdToken: refresh needed (force=${force}), waiting for discovery…`);
        for (let i = 0; i < 20; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (discoveryReadyRef.current || cachedDiscoveryRef.current) break;
        }
      }
      const haveDisco = discoveryReadyRef.current || !!cachedDiscoveryRef.current;
      const refreshed = await refreshTokensRef.current(refreshToken);
      if (refreshed) {
        callDebug.push('AUTH', `getFreshIdToken: refresh OK (disco=${haveDisco}, force=${force})`);
        return refreshed;
      }
      // Refresh failed (network blip etc) — fall through and return the
      // cached id_token. Convex may 401 a few times until our background
      // retry succeeds; the user stays signed in.
      callDebug.push('ERR', `AUTH getFreshIdToken: refresh FAILED (force=${force}, disco=${haveDisco}, hasRefresh=${!!refreshToken}, reason=${lastRefreshErrorRef.current || '?'}, terminal=${refreshTokenDeadRef.current}) → returning ${idToken ? 'STALE id_token' : 'null'}`);
      // iter-315 TOKEN-LIMBO FIX: when Convex EXPLICITLY rejected the current
      // token (force=true) and the refresh could not mint a new one, returning
      // the SAME stale/expired id_token just loops forever (Convex rejects →
      // asks again with force=true → we hand back the rejected token → …).
      // That loop is the "logged-in but Convex-unauthenticated / No chats yet"
      // limbo the user hits after an overnight background. Return null so
      // Convex settles as unauthenticated and retries cleanly once a refresh
      // finally succeeds (or the terminal path routes to recovery), instead of
      // spinning on a token the server already refused.
      if (force) return null;
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
        sessionExpired,
        authMode: AUTH_MODE,
        idToken,
        lastError,
        userInfo,
        signIn,
        signOut,
        getFreshIdToken,
        trySilentReauth,
        acceptTokens,
        setAuthError,
        getSessionHealth,
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
