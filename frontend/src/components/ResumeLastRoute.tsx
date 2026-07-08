import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { useAuth } from '../providers/AuthProvider';
import { consumeResumableChatRoute } from '../lib/lastRoute';

// Module-scoped so it only ever runs ONCE per app launch (cold start). A warm
// foreground resume keeps the navigation stack in memory, so there's nothing
// to restore then.
let resumeAttempted = false;

/**
 * On a cold start, if the user was last inside a chat conversation, reopen it
 * on top of the Chats list so they land back where they paused. Fires exactly
 * once, only when we're on the post-login landing screen (`/chats`), so it
 * never hijacks share-intent / incoming-call / deep-link cold starts (which
 * route elsewhere).
 */
export default function ResumeLastRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (resumeAttempted) return;
    if (isLoading || !isAuthenticated) return;
    // Only the default post-login landing qualifies as "just cold-started".
    if (pathname !== '/chats') return;

    resumeAttempted = true;
    (async () => {
      const route = await consumeResumableChatRoute();
      if (!route) return;
      // Let the tabs settle, then confirm the user hasn't navigated away in the
      // meantime (e.g. a share-intent/call push landed first).
      timerRef.current = setTimeout(() => {
        try {
          router.push(route as any);
        } catch {
          /* ignore */
        }
      }, 350);
    })();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isAuthenticated, isLoading, pathname, router]);

  return null;
}
