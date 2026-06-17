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

### iter-222b: Keyguard dismiss on answer + EAS source zip
- Extended `plugins/withCallWakeScreen.js` with a `withMainActivity` mod injecting, into
  `MainActivity.onCreate` (API 27+): `setShowWhenLocked(true)`, `setTurnScreenOn(true)`,
  `KeyguardManager.requestDismissKeyguard(this, null)` — so answering a call from the lock
  screen goes straight in without a second unlock. Idempotent; no-ops if the onCreate
  signature isn't found (manifest attributes still apply). Validated: plugin loads,
  `withMainActivity` resolves, regex injects correctly on a sample MainActivity.kt, manifest
  mod still applies after refactor.
- Generated `/app/smilers-frontend-eas.zip` (24 MB, 286 files, integrity OK) for the user to
  build via EAS CLI — excludes node_modules/.expo/.metro-cache; includes app.json, eas.json,
  google-services.json, yarn.lock, plugins, sound assets, .env, src, app, assets.
  ⚠️ The bundled `.env` has THIS container's PREVIEW values — `EXPO_PUBLIC_BACKEND_URL`
  (= preview tunnel) MUST be set to the production backend before a store build; verify
  `EXPO_PUBLIC_CONVEX_URL` / `EXPO_PUBLIC_OIDC_AUTHORITY` are the production Hercules ones.
