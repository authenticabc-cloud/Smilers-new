import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConvex } from 'convex/react';

export function useSafeConvexQuery<T>(
  queryRef: any,
  args: Record<string, unknown>,
  fallback: T,
  enabled = true
) {
  const convex = useConvex();
  const fallbackRef = useRef(fallback);
  const argsKey = JSON.stringify(args ?? {});
  const stableArgs = useMemo(() => args ?? {}, [argsKey]);
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    fallbackRef.current = fallback;
  }, [fallback]);

  const refetch = useCallback(async () => {
    if (!enabled) {
      setData(fallbackRef.current);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const result = await convex.query(queryRef, stableArgs);
      setData((result ?? fallbackRef.current) as T);
    } catch (errorValue) {
      console.warn('Convex query failed:', queryRef?.udfPath || 'unknown', errorValue);
      setData(fallbackRef.current);
    } finally {
      setLoading(false);
    }
  }, [convex, enabled, queryRef, stableArgs]);

  useEffect(() => {
    if (!enabled) {
      setData(fallbackRef.current);
      setLoading(false);
      return;
    }

    void refetch();
  }, [enabled, refetch]);

  return { data, loading, refetch };
}