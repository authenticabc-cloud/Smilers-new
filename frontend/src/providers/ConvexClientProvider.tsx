import React, { ReactNode, useMemo } from 'react';
import { ConvexReactClient, ConvexProviderWithAuth } from 'convex/react';
import { useAuth } from './AuthProvider';
import { useConvexAutoReconnect } from './useConvexAutoReconnect';

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, {
  unsavedChangesWarning: false,
});

function useAuthForConvex() {
  const { isLoading, isAuthenticated, getFreshIdToken } = useAuth();

  return useMemo(
    () => ({
      isLoading,
      isAuthenticated,
      fetchAccessToken: async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
        // iter-306: pass Convex's force flag through. When Convex rejects our
        // id_token it re-asks with forceRefreshToken=true; we MUST rotate the
        // token then (not return the same stale one), otherwise the session is
        // stuck unauthenticated → empty chats / "No chats yet" until a manual
        // sign-out/in.
        const token = await getFreshIdToken(forceRefreshToken);
        return token;
      },
    }),
    // iter-316 REVERT of iter-315: `idToken` was added here to notify Convex of
    // token rotation, but it created an INFINITE LOOP → "disco" flicker:
    //   setAuth → fetchAccessToken(force=true) → getFreshIdToken rotates the
    //   id_token → idToken state changes → this memo changes → setAuth again → …
    // (device log showed AUTH "refresh OK force=true" + CONVEX hardReconnect
    // firing every 1-2s). Convex re-fetches the token on its OWN reconnect, so
    // this memo MUST stay stable across token rotations. Do NOT add idToken.
    [isLoading, isAuthenticated, getFreshIdToken]
  );
}

/**
 * Wraps the auto-reconnect side-effect so it runs inside the React tree
 * (i.e. with the same lifecycle as the rest of the app). React Native
 * silently kills WebSockets on background/network flap; this hook
 * detects the stall and forces a Convex socket restart so chat queries,
 * voice-note transcription and call pills don't get stuck.
 */
function ConvexAutoReconnectBridge({ children }: { children: ReactNode }) {
  useConvexAutoReconnect(convex);
  return <>{children}</>;
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useAuthForConvex}>
      <ConvexAutoReconnectBridge>{children}</ConvexAutoReconnectBridge>
    </ConvexProviderWithAuth>
  );
}
