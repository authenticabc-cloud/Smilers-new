/**
 * shareIntentContext — single source of truth for the OS share intent.
 *
 * WHY THIS EXISTS (iter-177, the "Nothing shared yet" root cause):
 * `useShareIntent()` from expo-share-intent keeps its parsed payload in
 * LOCAL React state inside each hook instance, and the native module's
 * pending intent is consumed exactly ONCE (`getShareIntent` clears the
 * Android singleton after emitting `onChange`).
 *
 * The app previously called the hook in TWO places:
 *   1. ShareIntentRouter in app/_layout.tsx (always mounted) — its
 *      instance received the payload and navigated to /share-receiver.
 *   2. app/share-receiver.tsx — mounted AFTER navigation, so its own
 *      hook instance subscribed too late and called `getShareIntent`
 *      against an already-cleared native singleton. Its state stayed
 *      empty forever → the screen rendered "Nothing shared yet" even
 *      though the share payload had arrived correctly.
 *
 * The library's documented fix is to mount ONE `ShareIntentProvider`
 * at the root and have every consumer read the SAME state via
 * `useShareIntentContext()`. This module wraps that pattern with the
 * codebase's platform-gating convention (the native module doesn't
 * exist on web preview / Expo Go, where requiring it throws).
 *
 * NOTE: `Platform.OS` is constant for the lifetime of the process, so
 * the early-return-on-web before calling hooks is render-stable (same
 * pattern used by ShareReceiverScreen and ShareIntentRouter before).
 */
import React from 'react';
import { Platform } from 'react-native';

export interface AppShareIntent {
  isReady: boolean;
  hasShareIntent: boolean;
  shareIntent: any;
  resetShareIntent: (clearNative?: boolean) => void;
  error: string | null;
}

const WEB_INERT: AppShareIntent = {
  isReady: true,
  hasShareIntent: false,
  shareIntent: { files: null, text: null, webUrl: null, type: null },
  resetShareIntent: () => {},
  error: null,
};

/** Root-level provider. Renders children directly on web (no native module). */
export function AppShareIntentProvider({ children }: { children: React.ReactNode }) {
  if (Platform.OS === 'web') {
    return <>{children}</>;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ShareIntentProvider } = require('expo-share-intent');
  return (
    <ShareIntentProvider options={{ debug: false, resetOnBackground: true }}>
      {children}
    </ShareIntentProvider>
  );
}

/** Shared share-intent state. Inert on web. */
export function useAppShareIntent(): AppShareIntent {
  if (Platform.OS === 'web') {
    return WEB_INERT;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useShareIntentContext } = require('expo-share-intent');
  // Platform.OS is process-constant, so this is render-stable.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useShareIntentContext();
}
