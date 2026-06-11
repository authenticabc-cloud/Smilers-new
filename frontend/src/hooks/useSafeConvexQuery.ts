import { useCallback, useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';

export function useSafeConvexQuery<T>(
  queryRef: any,
  args: Record<string, unknown>,
  fallback: T,
  enabled = true
) {
  const convex = useConvex();
  const fallbackRef = useRef(fallback);
  const queryRefRef = useRef(queryRef);
  const argsKey = JSON.stringify(args ?? {});
  const queryPath = queryRef?.udfPath || 'unknown';
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(enabled);
  // iter-141: only enter the "loading" state on the FIRST fetch so empty
  // states don't blink between "loading" and "empty" on re-fetches.
  const hasLoadedOnce = useRef(false);
  // Bumping this re-subscribes (refetch support).
  const [subscriptionNonce, setSubscriptionNonce] = useState(0);

  useEffect(() => {
    queryRefRef.current = queryRef;
  }, [queryRef]);

  // iter-183 REWRITE: this hook previously awaited a ONE-SHOT
  // `convex.query()`. When that call raced the Convex auth handshake the
  // client could queue it FOREVER — never resolving, never rejecting —
  // leaving `loading: true` for eternity (the "Trustees keeps on
  // turning" bug; same failure froze the Languages save). It also meant
  // results were stale until the screen remounted.
  //
  // Now we use a `watchQuery` SUBSCRIPTION (the same primitive Convex's
  // own `useQuery` uses): it re-evaluates automatically once auth
  // completes, live-updates on every server write, and a 12s safety
  // timer guarantees the spinner can never spin forever. Errors (e.g.
  // function not deployed) still degrade gracefully to `fallback`.
  useEffect(() => {
    if (!enabled) {
      // iter-138: do NOT clear data on transient `enabled=false`
      // transitions (e.g. admin role briefly null while `me` reloads) —
      // that caused list contents to flicker on/off. Only stop the spinner.
      setLoading(false);
      return;
    }
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }

    const safetyTimer = setTimeout(() => {
      hasLoadedOnce.current = true;
      setLoading(false);
    }, 12_000);

    let unsubscribe: (() => void) | undefined;
    const settle = () => {
      hasLoadedOnce.current = true;
      setLoading(false);
    };
    try {
      const watch = (convex as any).watchQuery(queryRefRef.current, JSON.parse(argsKey));
      const read = () => {
        try {
          const result = watch.localQueryResult();
          if (result === undefined) return; // no server result yet — keep waiting
          setData((result ?? fallbackRef.current) as T);
          settle();
        } catch (errorValue) {
          console.warn('Convex query failed:', queryPath, errorValue);
          setData(fallbackRef.current);
          settle();
        }
      };
      unsubscribe = watch.onUpdate(read);
      read();
    } catch (errorValue) {
      console.warn('Convex query failed:', queryPath, errorValue);
      setData(fallbackRef.current);
      settle();
    }

    return () => {
      clearTimeout(safetyTimer);
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
    };
  }, [convex, argsKey, enabled, queryPath, subscriptionNonce]);

  const refetch = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    // Subscriptions already deliver fresh data automatically; a manual
    // refetch simply re-subscribes (covers function-redeploy edge cases).
    setSubscriptionNonce((n) => n + 1);
  }, [enabled]);

  return { data, loading, refetch };
}

/**
 * Reactive variant of useSafeConvexQuery (iter-180, call-log pills fix).
 *
 * `useSafeConvexQuery` runs ONE `convex.query()` on mount. That races the
 * Convex auth handshake on cold launch (query lands unauthenticated →
 * backend returns []/throws → fallback cached forever) and never refreshes
 * when server data changes (a call ended while the chat is open never
 * appears). This hook uses a real `watchQuery` SUBSCRIPTION — the same
 * primitive `useQuery` uses — so results re-evaluate automatically when
 * auth completes and live-update on every backend write, while still
 * degrading gracefully to `fallback` if the function is missing/throws
 * (never crashes the screen like a raw `useQuery` would).
 */
export function useSafeConvexSubscription<T>(
  queryRef: any,
  args: Record<string, unknown>,
  fallback: T,
  enabled = true
) {
  const convex = useConvex();
  const fallbackRef = useRef(fallback);
  const queryRefRef = useRef(queryRef);
  const argsKey = JSON.stringify(args ?? {});
  const [data, setData] = useState<T>(fallback);

  useEffect(() => {
    queryRefRef.current = queryRef;
  }, [queryRef]);

  useEffect(() => {
    if (!enabled) return;
    let unsubscribe: (() => void) | undefined;
    try {
      const watch = (convex as any).watchQuery(queryRefRef.current, JSON.parse(argsKey));
      const read = () => {
        try {
          const result = watch.localQueryResult();
          if (result !== undefined) {
            setData((result ?? fallbackRef.current) as T);
          }
        } catch (errorValue) {
          // Server-side error for this subscription — keep showing fallback.
          console.warn('Convex subscription failed:', queryRefRef.current?.udfPath || 'unknown', errorValue);
          setData(fallbackRef.current);
        }
      };
      unsubscribe = watch.onUpdate(read);
      read();
    } catch (errorValue) {
      console.warn('Convex watchQuery setup failed:', errorValue);
      setData(fallbackRef.current);
    }
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
    };
  }, [convex, argsKey, enabled]);

  return { data };
}