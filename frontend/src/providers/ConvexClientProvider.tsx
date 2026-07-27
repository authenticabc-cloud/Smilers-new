import React, { ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { ConvexReactClient, ConvexProviderWithAuth, useConvexAuth } from 'convex/react';
import { useAuth } from './AuthProvider';
import { useConvexAutoReconnect } from './useConvexAutoReconnect';
import { callDebug } from '../lib/callDebugLog';

function makeConvexClient() {
  return new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, {
    unsavedChangesWarning: false,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// sml-auth-epoch — force ConvexProviderWithAuth to re-run `setAuth` (re-fetch a
// fresh OIDC id_token) on demand, WITHOUT keying the auth memo on the raw token
// string (which iter-316 proved causes an infinite re-auth loop, because
// Hercules rotates the token on every refresh).
//
// The pattern (validated against Convex custom-auth docs): keep a monotonic
// epoch that we bump ONLY when we detect the "logged-in locally but Convex
// unauthenticated" limbo — this changes the memoised `fetchAccessToken`
// identity exactly once per recovery, so Convex re-authenticates but does not
// loop. This is the fix for the overnight/slow-network case where the id_token
// expired, the cold-start token refresh lost the discovery race, and Convex
// settled unauthenticated forever (empty chats, "?" avatar, no contacts) until
// a full app restart.
// ────────────────────────────────────────────────────────────────────────────
let authEpoch = 0;
const epochListeners = new Set<() => void>();
let lastReauthAt = 0;
const REAUTH_COOLDOWN_MS = 5_000;

function subscribeEpoch(cb: () => void): () => void {
  epochListeners.add(cb);
  return () => {
    epochListeners.delete(cb);
  };
}
function getEpochSnapshot(): number {
  return authEpoch;
}

/**
 * Ask Convex to re-authenticate with a genuinely fresh token. Rate-limited so a
 * flapping mismatch can't storm the OIDC endpoint. Returns true if a bump fired.
 */
export function requestConvexReauth(reason: string = 'manual'): boolean {
  const now = Date.now();
  if (now - lastReauthAt < REAUTH_COOLDOWN_MS) return false;
  lastReauthAt = now;
  authEpoch += 1;
  try {
    callDebug.push('CONVEX', `reauth epoch → ${authEpoch} (${reason})`);
  } catch {}
  epochListeners.forEach((l) => {
    try {
      l();
    } catch {}
  });
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// iter-383 — SELF-HEAL for the FATAL Convex desync.
//
// Device logs proved the recurring "nothing shows / Reconnecting… forever"
// (only fixable by clearing storage or reinstalling) is caused by:
//   [CONVEX FATAL ERROR] Base version 1 passed up doesn't match the current
//   version 0
// This is UNRECOVERABLE on the client instance — once it fires, the
// ConvexReactClient stops syncing for the entire process. A process restart
// works only because it constructs a NEW client. So the fix is to DETECT the
// fatal error and swap in a brand-new client (which re-authenticates with the
// still-valid token and re-subscribes every query) — a process-restart-grade
// recovery WITHOUT the user clearing storage.
//
// Convex surfaces the fatal via `console.error`, so we patch console.error once
// (globally) to watch for the marker and trigger a recreate. Debounced so a
// burst of the same error can't loop-recreate.
// ────────────────────────────────────────────────────────────────────────────
let requestClientRecreate: (() => void) | null = null;
let fatalWatcherInstalled = false;
let lastRecreateAt = 0;

function isConvexFatal(msg: string): boolean {
  if (!msg) return false;
  return (
    msg.includes('[CONVEX FATAL ERROR]') ||
    (msg.includes('Base version') && msg.includes("doesn't match"))
  );
}

function installFatalErrorWatcher() {
  if (fatalWatcherInstalled) return;
  fatalWatcherInstalled = true;
  const origError = console.error.bind(console);
  console.error = (...args: any[]) => {
    try {
      const msg = args
        .map((a) => (typeof a === 'string' ? a : a?.message || a?.toString?.() || ''))
        .join(' ');
      if (isConvexFatal(msg)) {
        const now = Date.now();
        // Debounce: at most one recreate per 5s so a repeated log can't storm.
        if (now - lastRecreateAt > 5_000) {
          lastRecreateAt = now;
          try {
            callDebug.push('CONVEX', 'FATAL desync detected → recreating Convex client (self-heal)');
          } catch {}
          try {
            requestClientRecreate?.();
          } catch {}
        }
      }
    } catch {
      /* never let the watcher throw */
    }
    return origError(...args);
  };
}

function useAuthForConvex() {
  const { isLoading, isAuthenticated, getFreshIdToken } = useAuth();
  // Subscribe to the reauth epoch. When it bumps we return a NEW memo identity
  // so ConvexProviderWithAuth re-runs setAuth and re-fetches a fresh token.
  const epoch = useSyncExternalStore(subscribeEpoch, getEpochSnapshot, getEpochSnapshot);

  return useMemo(
    () => ({
      isLoading,
      isAuthenticated,
      fetchAccessToken: async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
        // iter-306: pass Convex's force flag through. When Convex rejects our
        // id_token it re-asks with forceRefreshToken=true; we MUST rotate the
        // token then (not return the same stale one), otherwise the session is
        // stuck unauthenticated → empty chats / "No chats yet" until a manual
        // sign-out/in.
        const token = await getFreshIdToken(forceRefreshToken);
        return token;
      },
    }),
    // iter-316 REVERT of iter-315: `idToken` was added here to notify Convex of
    // token rotation, but it created an INFINITE LOOP → "disco" flicker:
    //   setAuth → fetchAccessToken(force=true) → getFreshIdToken rotates the
    //   id_token → idToken state changes → this memo changes → setAuth again → …
    // (device log showed AUTH "refresh OK force=true" + CONVEX hardReconnect
    // firing every 1-2s). Convex re-fetches the token on its OWN reconnect, so
    // this memo MUST stay stable across token rotations. Do NOT add idToken.
    // `epoch` is safe (unlike idToken) because it bumps ONLY on explicit
    // recovery (requestConvexReauth), never on every token rotation.
    [isLoading, isAuthenticated, getFreshIdToken, epoch]
  );
}

// ────────────────────────────────────────────────────────────────────────────
// sml-auth-watchdog — self-heal the "logged-in locally but Convex
// unauthenticated" limbo. Mounted INSIDE ConvexProviderWithAuth so useConvexAuth()
// reports Convex's real auth state. When we hold a valid local session
// (idToken present, not terminally expired) but Convex is settled
// unauthenticated, escalate:
//   1) after MISMATCH_REAUTH_MS  → requestConvexReauth() (fresh token, cheap)
//   2) after MISMATCH_RECREATE_MS → recreate the client (re-subscribe + re-auth)
// Timers reset the instant Convex authenticates. Rate-limited recreate so a
// genuinely-dead refresh token (which routes to the sign-in wall via
// sessionExpired) can't loop-recreate.
// ────────────────────────────────────────────────────────────────────────────
const MISMATCH_REAUTH_MS = 4_000;
const MISMATCH_RECREATE_MS = 12_000;
const RECREATE_COOLDOWN_MS = 60_000;

function ConvexAuthWatchdog({ onRecreate }: { onRecreate: () => void }) {
  const { isAuthenticated: localAuthed, sessionExpired } = useAuth();
  const { isLoading: convexAuthLoading, isAuthenticated: convexAuthed } = useConvexAuth();
  const lastRecreateAtRef = useRef(0);

  // True when we have a usable local session but Convex is NOT authenticated.
  const mismatch = !!localAuthed && !sessionExpired && !convexAuthLoading && !convexAuthed;

  useEffect(() => {
    if (!mismatch) return undefined;
    callDebug.push('CONVEX', 'auth-watchdog: local session OK but Convex UNAUTHENTICATED — scheduling recovery');
    const reauthTimer = setTimeout(() => {
      const fired = requestConvexReauth('auth-watchdog-mismatch');
      callDebug.push('CONVEX', `auth-watchdog: stage1 reauth ${fired ? 'fired' : 'rate-limited'}`);
    }, MISMATCH_REAUTH_MS);
    const recreateTimer = setTimeout(() => {
      const now = Date.now();
      if (now - lastRecreateAtRef.current < RECREATE_COOLDOWN_MS) {
        callDebug.push('CONVEX', 'auth-watchdog: stage2 recreate skipped (cooldown)');
        return;
      }
      lastRecreateAtRef.current = now;
      callDebug.push('CONVEX', 'auth-watchdog: stage2 recreating Convex client (still unauthenticated)');
      onRecreate();
    }, MISMATCH_RECREATE_MS);
    return () => {
      clearTimeout(reauthTimer);
      clearTimeout(recreateTimer);
    };
  }, [mismatch, onRecreate]);

  // Re-evaluate promptly on foreground: if we resume into a mismatch, kick a
  // reauth immediately (rate-limited) rather than waiting for the timer.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (localAuthed && !sessionExpired && !convexAuthLoading && !convexAuthed) {
        requestConvexReauth('auth-watchdog-foreground');
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {}
    };
  }, [localAuthed, sessionExpired, convexAuthLoading, convexAuthed]);

  return null;
}

/**
 * Wraps the auto-reconnect side-effect so it runs inside the React tree
 * (i.e. with the same lifecycle as the rest of the app). React Native
 * silently kills WebSockets on background/network flap; this hook
 * detects the stall and forces a Convex socket restart so chat queries,
 * voice-note transcription and call pills don't get stuck.
 */
function ConvexAutoReconnectBridge({
  client,
  children,
}: {
  client: ConvexReactClient;
  children: ReactNode;
}) {
  useConvexAutoReconnect(client);
  return <>{children}</>;
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<ConvexReactClient>(() => makeConvexClient());
  // Bump on every recreate so the ConvexProviderWithAuth subtree fully
  // remounts with the fresh client (clean re-subscribe of every query).
  const [generation, setGeneration] = useState(0);
  const clientRef = useRef(client);
  clientRef.current = client;

  const recreate = useCallback(() => {
    const old = clientRef.current;
    const next = makeConvexClient();
    setClient(next);
    setGeneration((g) => g + 1);
    // Close the dead client shortly after the new one is live so any in-flight
    // teardown doesn't race the fresh socket's handshake.
    setTimeout(() => {
      try {
        (old as any)?.close?.();
      } catch {
        /* ignore */
      }
    }, 2000);
  }, []);

  useEffect(() => {
    requestClientRecreate = recreate;
    installFatalErrorWatcher();
    return () => {
      if (requestClientRecreate === recreate) requestClientRecreate = null;
    };
  }, [recreate]);

  return (
    <ConvexProviderWithAuth key={generation} client={client} useAuth={useAuthForConvex}>
      <ConvexAuthWatchdog onRecreate={recreate} />
      <ConvexAutoReconnectBridge client={client}>{children}</ConvexAutoReconnectBridge>
    </ConvexProviderWithAuth>
  );
}

// iter-383: manual last-resort recovery for a fatally-desynced client — used by
// the "Reconnecting…" banner's Retry when soft/hard reconnect can't recover
// (a dead client only recovers by being replaced). Safe no-op before mount.
export function recreateConvexClient(): void {
  try {
    requestClientRecreate?.();
  } catch {
    /* ignore */
  }
}
