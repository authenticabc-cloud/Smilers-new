import React, { ReactNode, useMemo } from 'react';
import { ConvexReactClient, ConvexProviderWithAuth } from 'convex/react';
import { useAuth } from './AuthProvider';

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

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useAuthForConvex}>
      {children}
    </ConvexProviderWithAuth>
  );
}
