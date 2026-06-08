/**
 * useFirstSuccessfulConvexQuery — iter-135 alignment helper.
 *
 * Tries a list of Convex query paths in order and returns the data from
 * the FIRST one that succeeds AND returns a non-empty result. Useful
 * when the mobile and web were built independently and we're not sure
 * which exact path name the backend uses (e.g. `faceId.listMyFaces`
 * vs `faceId.list` vs `users.getFaces`).
 *
 * Each candidate is invoked once on mount (with the same `args`). The
 * hook logs which candidate matched so we can fold the winning name
 * into a constant later.
 *
 * Returns `{ data, loading, source }` where `source` is the candidate
 * label that yielded the data (or `null` if none did).
 */

import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';

export interface QueryCandidate {
  /** Human-readable label for diagnostics (e.g. "faceId.listMyFaces"). */
  label: string;
  /** Convex query reference (e.g. `api.faceId.listMyFaces`). */
  ref: any;
  /** Optional. Returns true if the response is considered "useful". */
  accept?: (result: any) => boolean;
}

const defaultAccept = (result: any) => {
  if (Array.isArray(result)) return result.length > 0;
  if (result == null) return false;
  if (typeof result === 'object') return Object.keys(result).length > 0;
  return true;
};

export function useFirstSuccessfulConvexQuery<T>(
  candidates: QueryCandidate<T>[],
  args: Record<string, unknown>,
  fallback: T,
  enabled: boolean = true,
) {
  const convex = useConvex();
  const [data, setData] = useState<T>(fallback);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const candidatesRef = useRef(candidates);
  const argsKey = JSON.stringify(args ?? {});

  // Keep latest candidates available without re-running on every render.
  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);

  useEffect(() => {
    if (!enabled) {
      setData(fallback);
      setSource(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      for (const candidate of candidatesRef.current) {
        if (cancelled) return;
        if (!candidate?.ref) continue;
        const accept = candidate.accept || defaultAccept;
        try {
          const result = await convex.query(candidate.ref, args ?? {});
          if (cancelled) return;
          if (accept(result)) {
            setData(result as T);
            setSource(candidate.label);
            setLoading(false);
            return;
          }
        } catch (errorValue) {
          // Expected for paths that don't exist on the backend. Suppress
          // noise — only the final "nothing matched" path warrants a log.
          // eslint-disable-next-line no-console
          console.warn(
            `[useFirstSuccessfulConvexQuery] ${candidate.label} failed`,
            (errorValue as any)?.message?.slice(0, 160) || errorValue,
          );
        }
      }
      if (!cancelled) {
        setData(fallback);
        setSource(null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, argsKey, convex]);

  return { data, loading, source };
}
