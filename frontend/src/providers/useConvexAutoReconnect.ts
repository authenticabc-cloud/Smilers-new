/**
 * useConvexAutoReconnect
 * ------------------------------------------------------------------
 * React Native does not fire a `window.online` event, so Convex's
 * built-in network-recovery listener never triggers. Combined with
 * the fact that mobile OSes silently kill long-lived WebSockets when
 * the app is backgrounded (or the network flaps), this leaves the
 * Convex client in a "ghost connected" state:
 *
 *   - `isWebSocketConnected === true`  (we still hold the socket handle)
 *   - No new server messages arrive
 *   - Live queries (chats, messages, voice-note transcription) stall
 *
 * iter-209 SAFETY REVISION: the original implementation called
 * `webSocketManager.stop()+tryRestart()` aggressively. That can race
 * with Convex's internal backoff reconnect and (per user report)
 * appears correlated with random crashes. We now use a tiered escalation:
 *
 *   - Foreground / disconnected sockets → use `tryReconnectImmediately()`
 *     (idempotent, only acts when the socket is in `disconnected` state,
 *     and is what Convex itself uses for `window.online` events on web).
 *   - Confirmed stall (inflight req > 30s old, still "ready") → only
 *     then do we fall back to `stop()+tryRestart()`.
 *   - Long backoff (60s) so a flapping network can't trigger a restart
 *     storm.
 *
 * Everything is wrapped in try/catch so the SDK shape changing in a
 * future Convex release can never crash the app.
 */

import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import type { ConvexReactClient } from 'convex/react';
import { sentry } from '../lib/sentry';
import { callDebug } from '../lib/callDebugLog';

// How often we poll the connection state while foregrounded.
// iter-213: tightened 30s → 15s so chat-screen stalls clear faster.
const HEARTBEAT_INTERVAL_MS = 15_000;

// A request older than this means the server has gone silent while we
// still hold a "ready" socket — clearest signal of a ghost connection.
// iter-213: tightened 30s → 12s. The user reported chat headers stuck
// on "Loading…" even after the data arrived server-side, i.e. the
// React subscription never resolved. 12s is a sweet spot — long enough
// to ignore a genuinely slow query, short enough that the user only
// stares at the spinner briefly before we recover.
const STALE_INFLIGHT_THRESHOLD_MS = 12_000;

// Don't run the HEAVY restart path more often than this.
// iter-213: relaxed 60s → 30s so a flapping network recovers faster.
const MIN_HARD_RESTART_INTERVAL_MS = 30_000;

// iter-213: explicit module-level pointer to the current Convex client
// so manual "Tap to reconnect" callers (chat header, diagnostic logs)
// can force a reconnect WITHOUT having to thread the client through
// every component. Set by `useConvexAutoReconnect` on mount.
let activeClient: ConvexReactClient | null = null;

type ConvexConnectionState = {
  isWebSocketConnected: boolean;
  hasEverConnected: boolean;
  hasInflightRequests: boolean;
  timeOfOldestInflightRequest: Date | number | null;
  connectionCount: number;
  connectionRetries: number;
};

/**
 * SAFE path: ask Convex to attempt an immediate reconnect IF the
 * socket is in "disconnected" state (waiting for backoff). This is
 * the exact mechanism Convex uses for `window.online` on web — and
 * it's a no-op if the socket isn't waiting.
 */
function softReconnect(client: ConvexReactClient): boolean {
  try {
    const sync: any = (client as any).cachedSync;
    if (!sync) return false;
    const wsm: any = sync.webSocketManager;
    if (!wsm || typeof wsm.tryReconnectImmediately !== 'function') return false;
    wsm.tryReconnectImmediately();
    return true;
  } catch (err) {
    try {
      sentry.captureException(err, { tags: { module: 'convex-auto-reconnect', path: 'soft' } });
    } catch {}
    return false;
  }
}

/**
 * HEAVY path: ask Convex to restart its session via the SDK's OWN
 * coordinated reconnect (`closeAndReconnect`) — the exact method Convex
 * uses internally for InactiveServer / FailedToSend recovery. Used only
 * when we have firm evidence of a ghost connection (stale inflight request
 * on a "ready" socket).
 *
 * iter-277 — FATAL FIX: the previous implementation called
 * `wsm.stop()+tryRestart()` directly. `stop()` parks the socket in the
 * "stopped" state and `tryRestart()` then opens a brand-new socket OUTSIDE
 * Convex's normal reconnect lifecycle. When this raced the auth re-handshake
 * on boot, the client resumed the session with a stale base version while the
 * server had reset to version 0 → `[CONVEX FATAL ERROR] Base version 1 passed
 * up doesn't match the current version 0`. That error is FATAL: the client
 * stops syncing for the rest of the process → empty chats + "?" avatar until
 * the app is killed/reinstalled. `closeAndReconnect` goes through the SDK's
 * standard `close()` → `scheduleReconnect()` path, which resumes correctly.
 */
async function hardReconnect(client: ConvexReactClient): Promise<boolean> {
  try {
    const sync: any = (client as any).cachedSync;
    if (!sync) return false;
    const wsm: any = sync.webSocketManager;
    if (!wsm) return false;
    if (typeof wsm.closeAndReconnect === 'function') {
      wsm.closeAndReconnect('client');
      callDebug.push('CONVEX', 'hardReconnect via closeAndReconnect(client)');
      return true;
    }
    // Fallback only if the SDK shape changes in a future release.
    if (typeof wsm.stop === 'function' && typeof wsm.tryRestart === 'function') {
      await wsm.stop();
      wsm.tryRestart();
      callDebug.push('CONVEX', 'hardReconnect via stop()+tryRestart() (fallback)');
      return true;
    }
    return false;
  } catch (err) {
    try {
      sentry.captureException(err, { tags: { module: 'convex-auto-reconnect', path: 'hard' } });
    } catch {}
    return false;
  }
}

function getInflightAgeMs(state: ConvexConnectionState): number | null {
  if (!state.hasInflightRequests || state.timeOfOldestInflightRequest == null) return null;
  const t =
    state.timeOfOldestInflightRequest instanceof Date
      ? state.timeOfOldestInflightRequest.getTime()
      : Number(state.timeOfOldestInflightRequest);
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

export function useConvexAutoReconnect(client: ConvexReactClient) {
  const lastHardRestartAtRef = useRef<number>(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  // iter-277: timestamp of mount. For the first few seconds the Convex client
  // is doing its initial connect + auth handshake (and our AuthProvider may be
  // refreshing the OIDC token, which re-auths the socket). Firing ANY manual
  // reconnect during that window races the SDK's own connect/auth and was the
  // trigger for `[CONVEX FATAL ERROR] Base version … doesn't match …`, which
  // permanently kills sync (empty chats + "?" avatar). We stay hands-off until
  // the socket has had time to settle.
  const mountedAtRef = useRef<number>(Date.now());
  const SETTLE_WINDOW_MS = 12_000;

  useEffect(() => {
    let cancelled = false;
    activeClient = client; // iter-213: register for manual reconnect callers.
    mountedAtRef.current = Date.now();

    const withinSettleWindow = () => Date.now() - mountedAtRef.current < SETTLE_WINDOW_MS;

    const safeConnectionState = (): ConvexConnectionState | null => {
      try {
        return client.connectionState() as unknown as ConvexConnectionState;
      } catch {
        return null;
      }
    };

    const evaluateAndAct = (trigger: string) => {
      try {
        // iter-277: never intervene during the boot/auth-handshake settle
        // window — let the SDK establish + authenticate the socket itself.
        if (withinSettleWindow()) return;
        const state = safeConnectionState();
        if (!state) return;

        // 1. Socket disconnected → SOFT reconnect (idempotent).
        //    Convex's own backoff will also try, this just shortens the wait.
        if (state.hasEverConnected && !state.isWebSocketConnected) {
          const ok = softReconnect(client);
          try {
            sentry.addBreadcrumb({
              category: 'convex',
              type: 'info',
              level: 'info',
              message: 'convex-auto-reconnect:soft',
              data: {
                trigger,
                ok,
                connectionRetries: state.connectionRetries,
              },
            });
          } catch {}
          // eslint-disable-next-line no-console
          console.log(`[convex-auto-reconnect] soft trigger=${trigger} ok=${ok}`);
          return;
        }

        // 2. Socket "ready" but stale inflight → HARD reconnect (rate-limited).
        //    iter-216 SAFETY: the heartbeat path now ONLY does soft
        //    reconnects (above) — the heavy `stop()+tryRestart()` path runs
        //    only when triggered by:
        //      - AppState foreground transition (user just brought app back)
        //      - Explicit user action (Reconnect button / chat retry)
        //      - The chat screen's own 5/12/20s timers
        //    This avoids the v2.1.80 idle-crash mode where the heartbeat
        //    would race with Convex's internal backoff and tear down a
        //    socket that was in the middle of reconnecting itself. We
        //    still detect the stale state below — it just yields to the
        //    foreground/manual path instead of forcing it.
        const age = getInflightAgeMs(state);
        if (age !== null && age > STALE_INFLIGHT_THRESHOLD_MS) {
          if (trigger === 'heartbeat') {
            // Heartbeat sees stale state — log it for diagnostics but DON'T
            // force a hard restart; we wait for foreground/manual.
            try {
              sentry.addBreadcrumb({
                category: 'convex',
                type: 'info',
                level: 'info',
                message: 'convex-auto-reconnect:stale-noted',
                data: { trigger, ageSeconds: Math.round(age / 1000) },
              });
            } catch {}
            // Soft kick — cheap, idempotent, and on the off chance Convex
            // happens to be in the disconnected backoff state this fires
            // an immediate reconnect.
            softReconnect(client);
            return;
          }
          const now = Date.now();
          if (now - lastHardRestartAtRef.current < MIN_HARD_RESTART_INTERVAL_MS) {
            return;
          }
          lastHardRestartAtRef.current = now;
          void hardReconnect(client).then((ok) => {
            try {
              sentry.addBreadcrumb({
                category: 'convex',
                type: 'info',
                level: 'warning',
                message: 'convex-auto-reconnect:hard',
                data: {
                  trigger,
                  ok,
                  ageSeconds: Math.round(age / 1000),
                },
              });
            } catch {}
            // eslint-disable-next-line no-console
            console.log(
              `[convex-auto-reconnect] hard trigger=${trigger} ageSeconds=${Math.round(
                age / 1000,
              )} ok=${ok}`,
            );
          });
        }
      } catch (errorValue: any) {
        // Belt-and-braces — never let a heartbeat tick crash the app.
        try {
          sentry.captureException(errorValue, {
            tags: { module: 'convex-auto-reconnect', path: 'evaluateAndAct' },
          });
        } catch {}
      }
    };

    // ---------------------------------------------------------------
    // 1. AppState foreground listener
    // ---------------------------------------------------------------
    const appStateSub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'active' && prev !== 'active') {
        // Give the OS a moment to actually restore network access
        // before evaluating — iOS in particular is async about
        // WiFi resume.
        setTimeout(() => {
          if (!cancelled) evaluateAndAct('app-foreground');
        }, 500);
      }
    });

    // ---------------------------------------------------------------
    // 2. Heartbeat
    // ---------------------------------------------------------------
    const heartbeat = setInterval(() => {
      if (cancelled) return;
      if (appStateRef.current !== 'active') return;
      evaluateAndAct('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);

    // ---------------------------------------------------------------
    // 3. Connection-state subscription — diagnostics + soft restart
    // ---------------------------------------------------------------
    let unsubConn: (() => void) | undefined;
    try {
      unsubConn = client.subscribeToConnectionState((rawState: any) => {
        try {
          const state = rawState as ConvexConnectionState;
          sentry.addBreadcrumb({
            category: 'convex',
            type: 'info',
            level: 'debug',
            message: 'convex-connection-state',
            data: {
              isWebSocketConnected: state.isWebSocketConnected,
              hasInflightRequests: state.hasInflightRequests,
              connectionRetries: state.connectionRetries,
              connectionCount: state.connectionCount,
            },
          });
          // If Convex itself notices a disconnect and we're foregrounded,
          // SOFT-kick a reconnect rather than waiting for the next heartbeat.
          // iter-277: but NOT during the boot/auth-handshake settle window —
          // kicking a reconnect mid-handshake races the SDK and triggered the
          // fatal "Base version" desync. Convex's own backoff covers this
          // window; we only assist once things have settled.
          if (
            appStateRef.current === 'active' &&
            state.hasEverConnected &&
            !state.isWebSocketConnected &&
            !withinSettleWindow()
          ) {
            softReconnect(client);
          }
        } catch {
          /* Never let a breadcrumb subscriber crash the app. */
        }
      });
    } catch {
      // subscribeToConnectionState is marked unstable in Convex docs;
      // tolerate its absence.
    }

    return () => {
      cancelled = true;
      if (activeClient === client) {
        activeClient = null; // iter-213: clear pointer on unmount.
      }
      try {
        appStateSub.remove();
      } catch {}
      clearInterval(heartbeat);
      try {
        unsubConn?.();
      } catch {}
    };
  }, [client]);
}

/**
 * iter-213: Manual escape hatch. Called by the chat header "Loading…"
 * tap, the diagnostic logs "Force reconnect" button, and pull-to-
 * refresh inside chat lists. Triggers a SOFT reconnect first (idempotent
 * and safe); if the socket is "ready" but stale, immediately follows
 * up with a HARD reconnect (stop + tryRestart). Returns true if a
 * reconnect attempt was made.
 */
export async function forceConvexReconnect(reason: string = 'manual'): Promise<boolean> {
  const client = activeClient;
  if (!client) {
    try {
      // eslint-disable-next-line no-console
      console.log(`[convex-auto-reconnect] manual reconnect skipped — no active client (${reason})`);
    } catch {}
    return false;
  }
  try {
    sentry.addBreadcrumb({
      category: 'convex',
      type: 'info',
      level: 'info',
      message: 'convex-auto-reconnect:manual',
      data: { reason },
    });
  } catch {}
  // eslint-disable-next-line no-console
  console.log(`[convex-auto-reconnect] manual reconnect reason=${reason}`);
  const soft = softReconnect(client);
  // Always also attempt a hard reconnect — the user already waited
  // long enough to tap a button; we should not let them keep waiting.
  const hard = await hardReconnect(client);
  return soft || hard;
}

export default useConvexAutoReconnect;

// iter-243: expose the active Convex client so non-React modules (e.g.
// startCall) can fire imperative mutations without threading the client
// through every call site.
export function getActiveConvexClient(): ConvexReactClient | null {
  return activeClient;
}
