import React, { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConvexReactClient, ConvexProviderWithAuth } from 'convex/react';
import { useAuth } from './AuthProvider';
import { useConvexAutoReconnect } from './useConvexAutoReconnect';
import { callDebug } from '../lib/callDebugLog';

function makeConvexClient() {
  return new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, {
    unsavedChangesWarning: false,
  });
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
    [isLoading, isAuthenticated, getFreshIdToken]
  );
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
