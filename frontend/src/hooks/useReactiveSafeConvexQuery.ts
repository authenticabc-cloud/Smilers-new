import { useEffect, useMemo, useState } from 'react';
import { useQuery_experimental } from 'convex/react';
import { errorToMessage, safeString } from '../lib/safeString';

/**
 * useReactiveSafeConvexQuery — like `useQuery` from convex/react but:
 *
 *   • Reactive (re-emits whenever the server result changes — perfect for
 *     incoming-call / incoming-screen-share style live data).
 *   • Doesn't crash the host React tree if the query function isn't
 *     deployed yet on the backend ("CouldNotFindFunction…"). Errors are
 *     surfaced as `error` and the consumer keeps the supplied `fallback`.
 *   • Supports an `enabled` flag — passes `'skip'` to Convex so the
 *     subscription is fully detached when not needed.
 *
 * Use this for any *optional* / *defensive* live data. For data the app
 * cannot function without, keep using the plain `useQuery`.
 */
export function useReactiveSafeConvexQuery<T>(
  queryRef: any,
  args: Record<string, unknown> | undefined,
  fallback: T,
  enabled = true,
): { data: T; loading: boolean; error: Error | null } {
  // Memoise args so its object identity is stable when nothing changed —
  // useQuery_experimental treats new object identity as a new subscription.
  const argsKey = JSON.stringify(args ?? {});
  const stableArgs = useMemo<Record<string, unknown> | 'skip'>(
    () => (enabled ? (args ?? {}) : 'skip'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [argsKey, enabled],
  );

  // `useQuery_experimental` returns:
  //   { status: 'pending' }                 — first load
  //   { status: 'success', data: T }        — happy path
  //   { status: 'error', error }            — function missing / server threw
  //
  // We never set `throwOnError: true` so a backend that hasn't shipped
  // the query yet does NOT crash the host component.
  const result = useQuery_experimental({
    query: queryRef,
    args: stableArgs as any,
    throwOnError: false,
  }) as
    | { status: 'pending' }
    | { status: 'success'; data: T }
    | { status: 'error'; error: Error };

  // Log "CouldNotFindFunction…" / not-found errors once per session so we
  // don't spam the console on every re-render.
  //
  // iter-105 Hermes-safety: use `safeString` / `errorToMessage` from
  // src/lib/safeString.ts INSTEAD of bare String(...). Hermes throws
  // `TypeError: Cannot determine default value of object` when String()
  // is called on a Convex error object or an anyApi proxy — that's the
  // crash that prevented the Devotionals feed from loading on the user's
  // device. The safe helpers prefer typed `.message` / `.udfPath` string
  // fields and fall back to JSON.stringify / a constant, never throwing.
  const [loggedError, setLoggedError] = useState<string | null>(null);
  useEffect(() => {
    if (result.status === 'error') {
      const message = errorToMessage(result.error);
      if (message && message !== loggedError) {
        const path = safeString((queryRef as any)?.udfPath, 'unknown') || 'unknown';
        const isMissing =
          message.includes('CouldNotFindFunction') ||
          message.toLowerCase().includes('not found') ||
          message.toLowerCase().includes('no function');
        if (isMissing) {
          // Silent — the backend just hasn't shipped this endpoint yet.
          // eslint-disable-next-line no-console
          console.info(`[useReactiveSafeConvexQuery] ${path} not deployed yet`);
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[useReactiveSafeConvexQuery] ${path} failed:`, message);
        }
        setLoggedError(message);
      }
    } else if (result.status === 'success' && loggedError) {
      setLoggedError(null);
    }
  }, [result, loggedError, queryRef]);

  if (result.status === 'success') {
    return { data: result.data, loading: false, error: null };
  }
  if (result.status === 'error') {
    return { data: fallback, loading: false, error: result.error };
  }
  return { data: fallback, loading: true, error: null };
}
