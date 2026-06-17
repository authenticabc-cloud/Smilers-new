# Smilers Native — Changelog

## iter-222 (Feb 2026): Screen wake-up for calls (final pre-build item)
**Problem:** incoming calls rang but the screen did not turn on over the lock screen.
**Root cause:** the correct config plugin `plugins/withCallWakeScreen.js` (injects
`android:showWhenLocked="true"` + `android:turnScreenOn="true"` on `.MainActivity`,
ensures `USE_FULL_SCREEN_INTENT`) already existed but was **never registered** in
`app.json` → it was inert at build time.
**Fix:**
- Registered `"./plugins/withCallWakeScreen.js"` in `app.json` `expo.plugins`.
  Verified with `npx expo config --type introspect --json`: `.MainActivity` now carries
  `android:showWhenLocked=true` + `android:turnScreenOn=true`. Combined with the existing
  notifee `fullScreenAction`, this turns the screen ON for incoming calls over the lock
  screen. (Effective on the next EAS build — config plugins are build-time.)
- Added `useKeepAwake()` (expo-keep-awake, already installed) to `app/twilio-call.tsx` so
  the screen never dims/sleeps during an active call.
**Verification:** app.json valid JSON; expo introspect applies the flags; eslint 0 errors
on twilio-call.tsx. Real wake behaviour is build-time/native → confirm on the EAS build.
