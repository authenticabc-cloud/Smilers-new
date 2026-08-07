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

// ── LEGACY UNIMODULE PROXY TOUCH (must run before expo-router) ─────────────
// In RN 0.81 bridgeless, legacy Expo bridge modules are instantiated LAZILY.
// EXNativeModulesProxy (exported as "NativeUnimoduleProxy") is the one whose
// `setBridge:` calls `legacyProxyDidSetBridge:`, which sets
// `appContext.legacyModuleRegistry` AND registers every Expo module — with
// `appContext.permissions` available, so each module's OnCreate can register its
// permission requester and Fabric views.
//
// Until something touches it, NO Expo module is registered. That caused BOTH
// known failures:
//   * expo-router's requireNativeModule('ExpoLinking') threw -> splash hang
//   * every requester failed "Unrecognized requester: ..." (gallery, camera,
//     contacts, location, notifications) and expo-video's VideoView rendered as
//     "Unimplemented component: ViewManagerAdapter_ExpoVideo_VideoView"
//
// This touch used to live in app/_layout.tsx, which loads AFTER
// `expo-router/entry` — too late for the router itself. Doing it here, at the
// top of the entry module, fixes the ordering for both.
//
// It MUST stay in JS bundle scope. Do NOT move this into expo-modules-core's
// `installModules` (RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD): that runs on the JS
// thread, and EXNativeModulesProxy is +requiresMainQueueSetup=YES, so RCT would
// dispatch_sync to a main thread that is itself waiting on JS — deadlock.
(function touchLegacyUnimoduleProxy() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require('react-native');
    if (RN && RN.Platform && RN.Platform.OS !== 'web') {
      // Reading a property forces the bridgeless interop to fully realize the
      // module (getModule -> setBridge -> legacyProxyDidSetBridge).
      const legacyProxy = RN.NativeModules && RN.NativeModules.NativeUnimoduleProxy;
      void (legacyProxy ? typeof legacyProxy.callMethod : 'no-proxy');
    }
  } catch (_e) {
    // Never let this break boot; _layout.tsx still records a diagnostic later.
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
