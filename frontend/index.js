// ── GLOBAL NULL-SAFE NativeEventEmitter SHIM (must run FIRST) ────────────────
// Defensive guard: if any library constructs `new NativeEventEmitter(mod)` with
// a null native module, degrade to an inert emitter (the feature no-ops)
// instead of throwing a FATAL Invariant Violation that would hang the app on
// the splash screen. Patched once, before any other module is required.
// Harmless when every module is present.
(function installNullSafeNativeEventEmitter() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require('react-native');
    const Orig = RN && RN.NativeEventEmitter;
    if (typeof Orig === 'function' && !Orig.__nullSafe) {
      const STUB = { addListener: function () {}, removeListeners: function () {} };
      function NullSafeNativeEventEmitter(nativeModule) {
        const mod = nativeModule || STUB;
        return Reflect.construct(
          Orig,
          [mod],
          new.target || NullSafeNativeEventEmitter,
        );
      }
      NullSafeNativeEventEmitter.prototype = Orig.prototype;
      NullSafeNativeEventEmitter.__nullSafe = true;
      try {
        RN.NativeEventEmitter = NullSafeNativeEventEmitter;
      } catch (_e) {
        // property may be read-only under some bundler configs — best effort
      }
    }
  } catch (_e) {
    /* ignore */
  }
})();

// MUST be first — registers the background notification task handler and
// Notifee call event handlers at module scope so they run in ALL contexts,
// including the headless JS process that Expo spawns when a FCM data message
// arrives while the app is killed (React components do not mount in that
// context, so anything registered only inside a hook would never execute).
require('./src/push/backgroundTaskSetup');

// Registers the headless JS task that sends replies typed into the Android
// notification's inline "Reply" box (RemoteInput) — works even when killed.
require('./src/push/messageReplyTask');

// Task 4 — register the Stream iOS CallKit/VoIP push config BEFORE the app
// component registers, so incoming Stream calls ring via native CallKit even
// when the app is killed. No-op on Android/web (guarded internally).
const __streamIosPush = require('./src/push/streamIosPushConfig');
__streamIosPush.setupStreamIosPush();
// Hand off to Expo Router for the normal app launch.
require('expo-router/entry');
