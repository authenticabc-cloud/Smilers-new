import { useConvex } from 'convex/react';
import { useEffect, useState } from 'react';
import { api } from '../convexApi';
import { deriveKeyAsync, hasDerivedKey } from '../lib/e2eeCrypto';

export interface E2EEStatus {
  enabled: boolean;
  salt: string | null;
  passphrase: string | null;
  /**
   * True when the derived AES key is cached and ready for synchronous
   * decryption. While false (enabled convos only), callers must NOT decrypt —
   * doing so would trigger a blocking PBKDF2 on the JS thread. The key derives
   * asynchronously in the background; this flips to true when it's ready.
   */
  keyReady: boolean;
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
    return { enabled: false, salt: null, passphrase: null, keyReady: true };
  });

  useEffect(() => {
    if (!conversationId) {
      setStatus({ enabled: false, salt: null, passphrase: null, keyReady: true });
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
        const enabled = !!(result && result.enabled);
        const salt = result?.salt || null;
        const passphrase = result?.passphrase || null;
        const needsKey = enabled && !!passphrase && !!salt;
        // keyReady is true immediately when no decryption is needed OR the key
        // is already cached from an earlier open this session. Otherwise it's
        // false until the async PBKDF2 finishes (never blocks the UI).
        const ready = needsKey ? hasDerivedKey(passphrase, salt) : true;
        const next: E2EEStatus = { enabled, salt, passphrase, keyReady: ready };
        inMemoryCache.set(conversationId, next);
        setStatus(next);
        if (needsKey && !ready) {
          deriveKeyAsync(passphrase, salt)
            .then(() => {
              if (cancelled) return;
              const done: E2EEStatus = { ...next, keyReady: true };
              inMemoryCache.set(conversationId, done);
              setStatus(done);
            })
            .catch((errorValue: any) => {
              if (!cancelled) {
                console.warn(
                  '[useConversationE2EE] key derivation failed:',
                  errorValue?.message || errorValue
                );
              }
            });
        }
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
