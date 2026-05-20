import { useEffect, useState } from 'react';
import type { ConvexReactClient } from 'convex/react';

/**
 * Safely resolves a Convex storage URL without throwing during render.
 *
 * The standard `useQuery(api.files.getUrl, ...)` hook propagates any backend
 * error to the rendering component (which crashes the message list). The
 * Smilers Convex deployment has been observed to throw "Server Error" for
 * specific storageIds left over from previous botched uploads, so we resolve
 * the URL imperatively via `convex.query(...)` inside a useEffect with a
 * try/catch and surface the result as plain React state. The component
 * receives `null` while loading or on error, and the bubble can render a
 * sensible fallback instead of crashing.
 */
export function useResolvedStorageUrl(
  convex: ConvexReactClient,
  storageId: string | null | undefined,
  filesGetUrl: any,
  directUrl?: string | null
): string | null {
  const [url, setUrl] = useState<string | null>(directUrl || null);

  useEffect(() => {
    if (directUrl) {
      setUrl(directUrl);
      return;
    }
    if (!storageId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const next = await convex.query(filesGetUrl, { storageId });
        if (!cancelled) {
          setUrl(typeof next === 'string' ? next : null);
        }
      } catch (errorValue: any) {
        if (!cancelled) {
          console.warn(
            '[useResolvedStorageUrl] files.getUrl failed for',
            String(storageId).slice(0, 8) + '…',
            errorValue?.message || errorValue
          );
          setUrl(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, directUrl, filesGetUrl, storageId]);

  return url;
}
