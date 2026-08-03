/**
 * useInAppUpdates — Google Play native in-app updates (Android).
 *
 * WHY: The legacy <UpdateBanner/> only fires when the FastAPI backend's
 * `/api/app-version` → `latestVersion` is MANUALLY bumped past the installed
 * build. In practice that value lagged behind Play Store releases, so users
 * were never prompted after an update shipped. Google Play's native in-app
 * update API knows the latest published version automatically — no manual
 * backend bump required — so it is the robust source of truth on Android.
 *
 * Behaviour:
 *  - Android only (iOS keeps the existing store-check banner).
 *  - Skips __DEV__ (in-app updates only work for Play-installed builds).
 *  - On launch AND whenever the app returns to the foreground it checks for an
 *    update and starts a FLEXIBLE update (downloads in the background, then the
 *    native module auto-completes the install once ready). High-priority
 *    server updates are escalated to an IMMEDIATE (blocking) update.
 *  - Fully silent on failure — never blocks or crashes the app.
 */
import { useEffect, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

// Play "in-app update priority" (0–5) at/above which we force an IMMEDIATE,
// blocking update instead of a dismissible flexible one.
const IMMEDIATE_PRIORITY_THRESHOLD = 4;

export function useInAppUpdates(): void {
  const checkingRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'android' || __DEV__) return;

    // Deliberately required here, not statically imported above: this native
    // module (expo-in-app-updates) calls requireNativeModule("ExpoInAppUpdates")
    // at ITS OWN module scope, which throws synchronously since that module
    // doesn't exist on iOS (Android/Play Store-only API). A static top-level
    // import runs at bundle-load time regardless of the Platform.OS guard
    // above, which fatally crashed the JS thread on every iOS launch before
    // _layout.tsx ever finished rendering (app stuck on splash forever).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const InAppUpdates = require('expo-in-app-updates');

    const runCheck = async () => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const info = await InAppUpdates.checkForUpdate();
        if (!info?.updateAvailable) return;

        const highPriority =
          (typeof info.serverPriority === 'number' &&
            info.serverPriority >= IMMEDIATE_PRIORITY_THRESHOLD) ||
          info.serverUpdateType === 'IMMEDIATE';

        const useImmediate = highPriority && !!info.immediateAllowed;
        await InAppUpdates.startUpdate(useImmediate);
      } catch (err) {
        // Silent: offline, non-Play install, or user declined.
        if (__DEV__) console.log('[in-app-updates] check failed', err);
      } finally {
        checkingRef.current = false;
      }
    };

    // Initial launch check.
    void runCheck();

    // Re-check when the app returns to the foreground so a resumed/stalled
    // update (or a version published while backgrounded) is picked up.
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') void runCheck();
    };
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => sub.remove();
  }, []);
}

export default useInAppUpdates;
