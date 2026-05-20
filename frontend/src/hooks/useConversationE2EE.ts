import { useConvex } from 'convex/react';
import { useEffect, useState } from 'react';
import { api } from '../convexApi';

export interface E2EEStatus {
  enabled: boolean;
  salt: string | null;
  passphrase: string | null;
}

/**
 * Fetches a conversation's E2EE status (passphrase + salt) once and caches
 * it. The web app stores it under `localStorage.e2ee_key_{conversationId}`;
 * we keep an in-memory cache plus an imperative fetch (so a backend hiccup
 * never throws during render, unlike `useQuery`).
 */

const inMemoryCache = new Map<string, E2EEStatus>();

export function useConversationE2EE(conversationId: string | null | undefined): E2EEStatus {
  const convex = useConvex();
  const [status, setStatus] = useState<E2EEStatus>(() => {
    if (conversationId && inMemoryCache.has(conversationId)) {
      return inMemoryCache.get(conversationId)!;
    }
    return { enabled: false, salt: null, passphrase: null };
  });

  useEffect(() => {
    if (!conversationId) {
      setStatus({ enabled: false, salt: null, passphrase: null });
      return;
    }
    // Use cached entry immediately if we have one
    const cached = inMemoryCache.get(conversationId);
    if (cached) {
      setStatus(cached);
    }
    let cancelled = false;
    (async () => {
      try {
        const result: any = await convex.query(api.e2ee.getE2EEStatus as any, {
          conversationId,
        });
        if (cancelled) return;
        const next: E2EEStatus = {
          enabled: !!(result && result.enabled),
          salt: result?.salt || null,
          passphrase: result?.passphrase || null,
        };
        inMemoryCache.set(conversationId, next);
        setStatus(next);
      } catch (errorValue: any) {
        if (!cancelled) {
          console.warn(
            '[useConversationE2EE] getE2EEStatus failed:',
            errorValue?.data?.message || errorValue?.message || errorValue
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, conversationId]);

  return status;
}

/** Clear the in-memory E2EE cache (e.g. on sign-out). */
export function clearE2EECache() {
  inMemoryCache.clear();
}
