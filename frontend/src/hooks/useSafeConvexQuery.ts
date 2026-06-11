import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConvex } from 'convex/react';

export function useSafeConvexQuery<T>(
  queryRef: any,
  args: Record<string, unknown>,
  fallback: T,
  enabled = true
) {
  const convex = useConvex();
  const convexRef = useRef(convex);
  const fallbackRef = useRef(fallback);
  const queryRefRef = useRef(queryRef);
  const argsKey = JSON.stringify(args ?? {});
  const stableArgs = useMemo(() => args ?? {}, [argsKey]);
  const argsRef = useRef(stableArgs);
  const queryPath = queryRef?.udfPath || 'unknown';
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(enabled);
  // iter-141: only enter the "loading" state on the FIRST fetch.
  // Subsequent re-fetches (e.g. triggered by transient `enabled=false`
  // → `true` cycles when `me` reloads) just refresh data silently in
  // the background. This stops the spinner from blinking on/off on
  // Admin Reports / Ads tabs where the empty state would otherwise
  // flash a spinner every few seconds.
  const hasLoadedOnce = useRef(false);

  useEffect(() => {
    convexRef.current = convex;
  }, [convex]);

  useEffect(() => {
    queryRefRef.current = queryRef;
  }, [queryRef]);

  useEffect(() => {
    argsRef.current = stableArgs;
  }, [stableArgs]);

  const refetch = useCallback(async () => {
    if (!enabled) {
      // iter-138: preserve the most recently fetched data when `enabled`
      // momentarily flips to false (common cause: `me` query reloading
      // → `isAdmin` briefly null → enabled goes false → enabled goes
      // true again). Resetting to fallback here caused a "data appears
      // / vanishes / re-appears" blink on Admin Users + similar tabs.
      // Only stop the spinner; leave whatever data we have on screen.
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const result = await convexRef.current.query(queryRefRef.current, argsRef.current);
      setData((result ?? fallbackRef.current) as T);
    } catch (errorValue) {
      console.warn('Convex query failed:', queryPath, errorValue);
      setData(fallbackRef.current);
    } finally {
      setLoading(false);
    }
  }, [enabled, queryPath]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!enabled) {
        // iter-138: same as above — do NOT clear data on a transient
        // `enabled=false` transition (e.g., admin role briefly null
        // while `me` query is reloading). This kept causing list
        // contents to flicker on/off, especially on Admin Users.
        setLoading(false);
        return;
      }

      // iter-141: only show the spinner on the FIRST fetch. Subsequent
      // re-fetches happen silently in the background so the empty
      // state doesn't blink between "loading" and "empty" forever.
      if (!hasLoadedOnce.current) {
        setLoading(true);
      }
      try {
        const result = await convexRef.current.query(queryRefRef.current, argsRef.current);
        if (!cancelled) {
          setData((result ?? fallbackRef.current) as T);
          hasLoadedOnce.current = true;
        }
      } catch (errorValue) {
        console.warn('Convex query failed:', queryPath, errorValue);
        if (!cancelled) {
          setData(fallbackRef.current);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [enabled, argsKey, queryPath]);

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