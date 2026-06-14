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
 * The user-visible symptom is the "No Internet" feeling reported in
 * the handoff: chats stuck on "Loading...", voice notes stuck on
 * "Transcribing...", call pills not updating.
 *
 * This hook adds three layers of resilience:
 *
 *   1. AppState foreground listener — on every transition into the
 *      foreground we check `connectionState()`. If the socket is
 *      unhealthy (disconnected, or has stale inflight requests) we
 *      force a restart.
 *
 *   2. Heartbeat — every 20s while foregrounded we poll
 *      `connectionState()`. If `hasInflightRequests` is true and the
 *      oldest request is >15s old (i.e. the server has gone silent
 *      while we still think we're "connected") we force a restart.
 *
 *   3. ConnectionState subscription — we add a diagnostic breadcrumb
 *      every time the connection state changes so we can correlate
 *      future issues in Sentry.
 *
 * "Force restart" reaches into Convex's WebSocketManager and calls
 * `stop()` + `tryRestart()`. These are not part of the public
 * `ConvexReactClient` API surface but they are stable and well-tested
 * (they're the same primitives used internally for auth restarts).
 */

import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import type { ConvexReactClient } from 'convex/react';
import { sentry } from '../lib/sentry';

// How often we poll the connection state while foregrounded.
const HEARTBEAT_INTERVAL_MS = 20_000;

// If we have an inflight request older than this, we consider the
// socket dead and force a restart.
const STALE_INFLIGHT_THRESHOLD_MS = 15_000;

// Backoff so we don't force-restart in a tight loop if the network
// is genuinely down.
const MIN_RESTART_INTERVAL_MS = 5_000;

type ConvexConnectionState = {
  isWebSocketConnected: boolean;
  hasEverConnected: boolean;
  hasInflightRequests: boolean;
  timeOfOldestInflightRequest: Date | number | null;
  connectionCount: number;
  connectionRetries: number;
};

/**
 * Reach into the internal Convex sync client to force-restart the
 * WebSocket. Falls back to a no-op if the internal shape changes
 * (so an SDK upgrade can never crash the app).
 */
async function forceReconnectInternal(client: ConvexReactClient): Promise<boolean> {
  try {
    // `cachedSync` is the lazily-instantiated BaseConvexClient. If
    // it's not set yet the client has never connected, and there's
    // nothing useful to restart.
    const sync: any = (client as any).cachedSync;
    if (!sync) return false;

    const wsm: any = sync.webSocketManager;
    if (!wsm || typeof wsm.stop !== 'function' || typeof wsm.tryRestart !== 'function') {
      return false;
    }

    // Stop puts the socket into "stopped" state; tryRestart only
    // works from that state. We await stop() to make sure the close
    // handshake completes before we open a new socket.
    await wsm.stop();
    wsm.tryRestart();
    return true;
  } catch (err) {
    // Never let a reconnect helper crash the app.
    try {
      sentry.captureException(err, { tags: { module: 'convex-auto-reconnect' } });
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

function isUnhealthy(state: ConvexConnectionState): { unhealthy: boolean; reason: string } {
  if (state.hasEverConnected && !state.isWebSocketConnected) {
    return { unhealthy: true, reason: 'socket-disconnected' };
  }
  const age = getInflightAgeMs(state);
  if (age !== null && age > STALE_INFLIGHT_THRESHOLD_MS) {
    return { unhealthy: true, reason: `stale-inflight-${Math.round(age / 1000)}s` };
  }
  return { unhealthy: false, reason: '' };
}

export function useConvexAutoReconnect(client: ConvexReactClient) {
  const lastRestartAtRef = useRef<number>(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    let cancelled = false;

    const maybeRestart = async (trigger: string) => {
      try {
        const now = Date.now();
        if (now - lastRestartAtRef.current < MIN_RESTART_INTERVAL_MS) {
          return; // Backoff so we don't restart in a tight loop.
        }

        const state = client.connectionState() as unknown as ConvexConnectionState;
        const { unhealthy, reason } = isUnhealthy(state);
        if (!unhealthy) return;

        lastRestartAtRef.current = now;
        const ok = await forceReconnectInternal(client);

        try {
          sentry.addBreadcrumb({
            category: 'convex',
            type: 'info',
            level: 'info',
            message: 'convex-auto-reconnect:restart',
            data: {
              trigger,
              reason,
              restarted: ok,
              connectionCount: state.connectionCount,
              connectionRetries: state.connectionRetries,
            },
          });
        } catch {}

        // eslint-disable-next-line no-console
        console.log(
          `[convex-auto-reconnect] restart trigger=${trigger} reason=${reason} ok=${ok}`,
        );
      } catch {
        // Never crash the app from a reconnect heuristic.
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
        // (iOS in particular is async about WiFi resume).
        setTimeout(() => {
          if (!cancelled) {
            void maybeRestart('app-foreground');
          }
        }, 300);
      }
    });

    // ---------------------------------------------------------------
    // 2. Heartbeat
    // ---------------------------------------------------------------
    const heartbeat = setInterval(() => {
      if (cancelled) return;
      if (appStateRef.current !== 'active') return; // Don't heartbeat in background.
      void maybeRestart('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);

    // ---------------------------------------------------------------
    // 3. Connection-state subscription (diagnostics + reactive restart)
    // ---------------------------------------------------------------
    let unsubConn: (() => void) | undefined;
    try {
      unsubConn = client.subscribeToConnectionState((rawState: any) => {
        const state = rawState as ConvexConnectionState;
        try {
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
        } catch {}
        // If the SDK *itself* notices the socket is disconnected and
        // we're foregrounded, kick a restart now rather than waiting
        // for the next heartbeat.
        if (
          appStateRef.current === 'active' &&
          state.hasEverConnected &&
          !state.isWebSocketConnected
        ) {
          void maybeRestart('connection-state-change');
        }
      });
    } catch {
      // subscribeToConnectionState is marked unstable in Convex docs;
      // tolerate its absence.
    }

    return () => {
      cancelled = true;
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

export default useConvexAutoReconnect;
