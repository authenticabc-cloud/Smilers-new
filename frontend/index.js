// TEMP JS-boot beacons. The iOS app reaches native `startReactNative` fine and
// the JS bundle is embedded, yet no JS boot heartbeat ever arrives — so JS
// evaluation is halting somewhere in this entry file (iOS only; Android boots
// fine). These fire-and-forget beacons report progress after each startup step
// directly to the backend so we can see the exact line where JS stops. Reuses
// the existing /api/diagnostic-logs endpoint, tagged platform "ios-js".
function __jsBoot(stage) {
  try {
    if (typeof fetch !== 'function') return;
    fetch('https://app-migration-75.emergent.host/api/diagnostic-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'ios-js',
        appVersion: 'entry',
        events: [{ ts: Date.now(), tag: 'JSBOOT', message: stage, source: 'index.js' }],
      }),
    }).catch(function () {});
  } catch (_e) {
    /* ignore */
  }
}

__jsBoot('entry-start');

// TEMP global error trap. index.js runs fully (all beacons fire) but the
// app/_layout route tree never evaluates its boot heartbeat — meaning an
// uncaught error is thrown while expo-router renders the root routes on iOS.
// Capture it here (ErrorUtils fires for uncaught JS/render errors) and beacon
// the message + stack so we can see the exact failing module.
try {
  const __EU = global.ErrorUtils;
  if (__EU && typeof __EU.setGlobalHandler === 'function') {
    const __prev =
      typeof __EU.getGlobalHandler === 'function' ? __EU.getGlobalHandler() : null;
    __EU.setGlobalHandler(function (err, isFatal) {
      try {
        const msg = err && err.message ? String(err.message) : String(err);
        const stack = err && err.stack ? String(err.stack).slice(0, 1200) : 'none';
        __jsBoot('GLOBAL-ERROR fatal=' + isFatal + ' msg=' + msg + ' :: ' + stack);
      } catch (_e2) {
        /* ignore */
      }
      if (typeof __prev === 'function') {
        try {
          __prev(err, isFatal);
        } catch (_e3) {
          /* ignore */
        }
      }
    });
  }
} catch (_e) {
  /* ignore */
}

// MUST be first — registers the background notification task handler and
// Notifee call event handlers at module scope so they run in ALL contexts,
// including the headless JS process that Expo spawns when a FCM data message
// arrives while the app is killed (React components do not mount in that
// context, so anything registered only inside a hook would never execute).
require('./src/push/backgroundTaskSetup');
__jsBoot('after-backgroundTaskSetup');

// Registers the headless JS task that sends replies typed into the Android
// notification's inline "Reply" box (RemoteInput) — works even when killed.
require('./src/push/messageReplyTask');
__jsBoot('after-messageReplyTask');

// Task 4 — register the Stream iOS CallKit/VoIP push config BEFORE the app
// component registers, so incoming Stream calls ring via native CallKit even
// when the app is killed. No-op on Android/web (guarded internally).
const __streamIosPush = require('./src/push/streamIosPushConfig');
__streamIosPush.setupStreamIosPush();
__jsBoot('after-streamIosPush');
// Hand off to Expo Router for the normal app launch.
require('expo-router/entry');
__jsBoot('after-router-entry');
