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
        // sml-authdiag: log EXACTLY what we hand Convex so a captured log
        // reveals WHY Convex rejects it (the "No chats yet" limbo). We only log
        // non-sensitive JWT claims (iss/aud/exp/sub-prefix) — never the token.
        try {
          if (!token) {
            callDebug.push('AUTH', `fetchAccessToken(force=${forceRefreshToken}) → NULL token`);
          } else {
            const parts = String(token).split('.');
            if (parts.length === 3) {
              const pad = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);
              const b64 = (s: string) => pad(s.replace(/-/g, '+').replace(/_/g, '/'));
              const claims = JSON.parse(
                typeof atob === 'function'
                  ? atob(b64(parts[1]))
                  : Buffer.from(b64(parts[1]), 'base64').toString('utf8'),
              );
              const exp = typeof claims.exp === 'number' ? claims.exp : 0;
              const secsLeft = exp ? Math.round(exp - Date.now() / 1000) : 0;
              callDebug.push(
                'AUTH',
                `token→Convex iss=${claims.iss || '(none)'} aud=${JSON.stringify(claims.aud) || '(none)'} ` +
                  `sub=${String(claims.sub || '').slice(0, 10)} expIn=${secsLeft}s force=${forceRefreshToken}`,
              );
            } else {
              callDebug.push('AUTH', `token→Convex NON-JWT (parts=${parts.length}) force=${forceRefreshToken}`);
            }
          }
        } catch (e: any) {
          callDebug.push('AUTH', `token decode failed: ${String(e?.message || e).slice(0, 60)}`);
        }
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
const RECREATE_COOLDOWN_MS = 30_000;
// After this many consecutive recreates that DON'T restore auth, stop the
// recreate loop for a long window. A recreate remounts this whole subtree
// (so a per-component ref can't govern it) AND if Convex is rejecting the
// token server-side (e.g. OIDC aud/iss mismatch after a backend migration) no
// amount of recreating helps — it just burns battery + spams push register.
const MAX_CONSECUTIVE_RECREATES = 3;
const RECREATE_HALT_MS = 5 * 60_000;

// Module-scoped governor so it SURVIVES the client-recreate remount.
const recreateGov = { lastAt: 0, consecutive: 0, haltedUntil: 0 };

function ConvexAuthWatchdog({ onRecreate }: { onRecreate: () => void }) {
  const { isAuthenticated: localAuthed, sessionExpired } = useAuth();
  const { isLoading: convexAuthLoading, isAuthenticated: convexAuthed } = useConvexAuth();

  // True when we have a usable local session but Convex is NOT authenticated.
  const mismatch = !!localAuthed && !sessionExpired && !convexAuthLoading && !convexAuthed;

  // Reset the recreate governor the moment Convex authenticates — recovery
  // worked, so future blips get the full retry budget again.
  useEffect(() => {
    if (convexAuthed) {
      recreateGov.consecutive = 0;
      recreateGov.haltedUntil = 0;
    }
  }, [convexAuthed]);

  useEffect(() => {
    if (!mismatch) return undefined;
    callDebug.push('CONVEX', 'auth-watchdog: local session OK but Convex UNAUTHENTICATED — scheduling recovery');
    const reauthTimer = setTimeout(() => {
      const fired = requestConvexReauth('auth-watchdog-mismatch');
      callDebug.push('CONVEX', `auth-watchdog: stage1 reauth ${fired ? 'fired' : 'rate-limited'}`);
    }, MISMATCH_REAUTH_MS);
    const recreateTimer = setTimeout(() => {
      const now = Date.now();
      if (now < recreateGov.haltedUntil) {
        callDebug.push('CONVEX', 'auth-watchdog: stage2 recreate HALTED (backoff — token likely rejected server-side)');
        return;
      }
      if (now - recreateGov.lastAt < RECREATE_COOLDOWN_MS) {
        callDebug.push('CONVEX', 'auth-watchdog: stage2 recreate skipped (cooldown)');
        return;
      }
      recreateGov.lastAt = now;
      recreateGov.consecutive += 1;
      if (recreateGov.consecutive >= MAX_CONSECUTIVE_RECREATES) {
        recreateGov.haltedUntil = now + RECREATE_HALT_MS;
        callDebug.push(
          'CONVEX',
          `auth-watchdog: recreate loop HALTED after ${recreateGov.consecutive} failed attempts — Convex is rejecting the token (check OIDC aud/iss vs Convex auth.config). Will retry on next foreground.`,
        );
      }
      callDebug.push('CONVEX', `auth-watchdog: stage2 recreating Convex client (attempt ${recreateGov.consecutive})`);
      onRecreate();
    }, MISMATCH_RECREATE_MS);
    return () => {
      clearTimeout(reauthTimer);
      clearTimeout(recreateTimer);
    };
  }, [mismatch, onRecreate]);

  // Re-evaluate promptly on foreground: if we resume into a mismatch, clear any
  // recreate halt (fresh user attention) and kick a reauth immediately.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (localAuthed && !sessionExpired && !convexAuthLoading && !convexAuthed) {
        recreateGov.haltedUntil = 0;
        recreateGov.consecutive = 0;
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
