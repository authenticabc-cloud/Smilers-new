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
        const token = await getFreshIdToken();
        return token;
      },
    }),
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
