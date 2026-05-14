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
      setData((current) => (Object.is(current, fallbackRef.current) ? current : fallbackRef.current));
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
        setData((current) => (Object.is(current, fallbackRef.current) ? current : fallbackRef.current));
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