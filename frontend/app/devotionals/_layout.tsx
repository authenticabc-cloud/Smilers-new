/**
 * Devotionals stack layout — keeps the 3 screens (Feed / Compose /
 * Preferences) under a shared stack so back-navigation feels native.
 *
 * The whole stack is wrapped in a DevotionalsErrorBoundary so that any
 * render-time crash inside the Devotionals screens shows a friendly
 * fallback instead of taking down the whole app. The error is also
 * persisted to AsyncStorage and POSTed to /api/diagnostic-logs on the
 * next launch so the main agent can SEE the actual failure even on
 * production builds where console.log is invisible.
 */
import { Stack, useRouter } from 'expo-router';
import React from 'react';
import DevotionalsErrorBoundary from '../../src/components/DevotionalsErrorBoundary';

export default function DevotionalsLayout() {
  const router = useRouter();

  const handleClose = React.useCallback(() => {
    try {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/(tabs)/chats' as any);
      }
    } catch {
      /* swallow — best-effort */
    }
  }, [router]);

  return (
    <DevotionalsErrorBoundary source="devotionals-stack" onClose={handleClose}>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="compose" />
        <Stack.Screen name="preferences" />
      </Stack>
    </DevotionalsErrorBoundary>
  );
}
