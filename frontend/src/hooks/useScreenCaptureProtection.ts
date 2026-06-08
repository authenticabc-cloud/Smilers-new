/**
 * useScreenCaptureProtection — iter-134 security hardening.
 *
 * Calls `preventScreenCaptureAsync()` when a screen mounts and restores
 * capture on unmount (or when the user navigates away). Used on screens
 * that expose sensitive content:
 *   - OTP codes (phone-verify, change-phone-number)
 *   - Chat conversations (private messages, attachments, voice notes)
 *   - Status compose (drafts before posting)
 *
 * Effects per platform:
 *   - Android: sets `FLAG_SECURE` on the current Activity window. Blocks
 *     screenshots AND prevents the screen from showing in recents/task
 *     switcher previews.
 *   - iOS: prevents screenshots (and displays an opaque overlay during
 *     screen recording in supported OS versions). Does NOT hide the app
 *     in the multitasker — Apple does not allow blocking that.
 *
 * Safe to call on web — the underlying module is a no-op there.
 *
 * Optional tag parameter is for diagnostics in case multiple screens
 * stack their protection and we need to debug the lifecycle.
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';
import {
  allowScreenCaptureAsync,
  preventScreenCaptureAsync,
} from 'expo-screen-capture';

let active = 0;

export function useScreenCaptureProtection(tag: string = 'screen') {
  useEffect(() => {
    // expo-screen-capture is a no-op on web; bail early to avoid the
    // unnecessary Promise allocations during web bundling.
    if (Platform.OS === 'web') return;
    let cancelled = false;
    active += 1;
    (async () => {
      try {
        await preventScreenCaptureAsync(tag);
      } catch (errorValue) {
        // Defensive — never crash the screen because a security guard
        // failed to install. Log for diagnostics so we notice in
        // production via Sentry breadcrumbs.
        console.warn(`[security] preventScreenCapture(${tag}) failed`, errorValue);
      }
    })();
    return () => {
      cancelled = true;
      void cancelled;
      active = Math.max(0, active - 1);
      (async () => {
        try {
          await allowScreenCaptureAsync(tag);
        } catch (errorValue) {
          console.warn(`[security] allowScreenCapture(${tag}) failed`, errorValue);
        }
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
