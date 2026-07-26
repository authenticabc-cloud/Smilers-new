/**
 * Task 4 — iOS CallKit + VoIP (PushKit) ringing via Stream Video.
 *
 * Registers the Stream push config at app STARTUP (before AppRegistry) so an
 * incoming Stream call rings through the native iOS CallKit UI even when the
 * app is backgrounded, locked, or killed. Stream's SDK owns the PushKit →
 * CallKit bridge internally once `AppDelegate.voipRegistration()` has run and
 * this config is set — we do NOT hand-roll a PKPushRegistry handler (that would
 * double-handle the push).
 *
 * NATIVE iOS ONLY:
 *   • Android keeps the existing custom FCM "doorbell" (Ashwini) — untouched.
 *   • Web has no CallKit/VoIP layer — no-op.
 *
 * PREREQUISITES the user must configure (device-build only — cannot be
 * validated in Expo Go / web):
 *   1. Apple APNs auth key (.p8) + Key ID + Team ID + Bundle ID.
 *   2. A Stream Dashboard → Push Notifications → APN (VoIP) provider whose
 *      NAME matches `pushProviderName` below (override via
 *      EXPO_PUBLIC_STREAM_IOS_PUSH_PROVIDER).
 *   3. Calls destined for an iOS callee must be created with Stream ringing so
 *      Stream emits the VoIP push (follow-up once the provider is live).
 */
import { Platform } from 'react-native';

import { createStreamVideoClient } from '../lib/stream/streamClient';

export function setupStreamIosPush() {
  if (Platform.OS !== 'ios') return;
  (async () => {
    try {
      // Lazy import — the Stream SDK is native-only and must never be bundled
      // on web / pulled in on Android startup.
      // @ts-expect-error native-only SDK, resolved in the iOS build
      const { StreamVideoRN } = await import('@stream-io/video-react-native-sdk');
      if (!StreamVideoRN?.setPushConfig) return;
      const provider =
        process.env.EXPO_PUBLIC_STREAM_IOS_PUSH_PROVIDER ||
        (__DEV__ ? 'apn-video-staging' : 'apn-video-production');
      StreamVideoRN.setPushConfig({
        ios: {
          pushProviderName: provider,
          // We ring both voice and video calls through CallKit.
          supportsVideo: true,
          callsHistory: true,
        },
        // Mirror the client option (rejectCallWhenBusy) so a 2nd call while busy
        // is auto-declined at the OS level.
        shouldRejectCallWhenBusy: true,
        // Reuse the app's singleton client bootstrapper (works in the headless
        // push context via the cached Stream identity).
        createStreamVideoClient,
      });
    } catch {
      // Non-fatal: SDK absent (web/android) or misconfigured provider. Ringing
      // simply falls back to the in-app / FCM paths.
    }
  })();
}
