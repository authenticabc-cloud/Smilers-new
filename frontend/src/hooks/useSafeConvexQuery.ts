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

      setLoading(true);
      try {
        const result = await convexRef.current.query(queryRefRef.current, argsRef.current);
        if (!cancelled) {
          setData((result ?? fallbackRef.current) as T);
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