/**
 * usePresenceHeartbeat — iter-169 WEB_PARITY_POLISH_CONTRACT.
 *
 * Web parity rule: `getUserById` returns `isOnline:false` if `lastSeen`
 * is more than 2 minutes old. The backend has no cron to refresh
 * presence — the only path to keep a user "online" is for the client
 * to keep calling `setOnlineStatus({ isOnline: true })`.
 *
 * This hook:
 *   • Fires one `setOnlineStatus(true)` on mount
 *   • Then every 60 s while the app is foregrounded
 *   • Pauses when AppState goes to `background` / `inactive`
 *   • Resumes immediately when the app returns to `active`
 *   • On unmount, sends a final `setOnlineStatus(false)` so the avatar
 *     dot flips to grey within the next render cycle
 *
 * The 60 s cadence is half of the backend's 120 s "stale" threshold,
 * which gives us a 1-tick safety margin against jittery networks.
 *
 * Mounted ONCE near the top of the authenticated tree (PresenceProvider).
 * Calling it multiple times is safe but wastes mutations.
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';

const PING_INTERVAL_MS = 60_000;

export function usePresenceHeartbeat() {
  const { isAuthenticated } = useAuth();
  // Use `as any` because the function might not exist on older Convex
  // deployments — `useMutation` will throw at call-time, which we catch.
  const setOnlineStatus = useMutation((api as any).users?.setOnlineStatus);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPingRef = useRef<number>(0);

  useEffect(() => {
    if (!isAuthenticated || !setOnlineStatus) return;

    const ping = (online: boolean) => {
      // Throttle: never ping twice in <5 s. Prevents an AppState
      // active/background/active rapid cycle from spamming the server.
      const now = Date.now();
      if (online && now - lastPingRef.current < 5_000) return;
      lastPingRef.current = now;
      try {
        // Convex mutation returns a Promise — fire and forget. Swallow
        // network errors silently; the next tick will retry.
        (setOnlineStatus as any)({ isOnline: online }).catch(() => {});
      } catch {
        /* swallow */
      }
    };

    // Fire immediately so the avatar dot turns green within seconds of
    // logging in, not after the first 60 s tick.
    ping(true);

    const startTimer = () => {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(() => ping(true), PING_INTERVAL_MS);
    };

    const stopTimer = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    startTimer();

    const handleAppState = (state: AppStateStatus) => {
      if (state === 'active') {
        ping(true);
        startTimer();
      } else {
        // Backgrounded — stop the timer. Don't flip to offline here;
        // the 2-min stale rule will do it naturally and we'd thrash
        // the avatar on quick task-switches otherwise.
        stopTimer();
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);

    return () => {
      stopTimer();
      sub.remove();
      // Final offline ping on logout / unmount. Best-effort.
      try {
        (setOnlineStatus as any)({ isOnline: false }).catch(() => {});
      } catch {
        /* swallow */
      }
    };
  }, [isAuthenticated, setOnlineStatus]);
}
