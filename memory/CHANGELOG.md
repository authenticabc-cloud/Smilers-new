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

## iter-221 — Killed/background-app incoming-call ring fixed (Issues 6/7/8)
Root cause: iter-218 sent call pushes WITH an Android notification block
(`android_data_only=False`). The OS then showed a plain, button-less banner AND
the JS background task bailed (`shouldScheduleLocalNotification` saw a title), so
the rich notifee Answer/Decline ring NEVER fired and a wrong/message tone played.
Fixes:
  1. backend/server.py `send_push`: calls are DATA-ONLY again
     (`android_data_only=is_call_push`). Messages keep their notification block.
  2. usePushNotifications.ts call branch: removed the `shouldScheduleLocalNotification`
     guard — calls are now always rendered by notifee (idempotent via stable
     `call-wake-<callId>` id + backgroundNotificationKeys dedupe).
  3. notifeeCallWake.ts: the wake-screen ring channel is now VERSIONED by the
     user's selected ringtone (`incoming-call-wake-<sound>`) instead of hardcoded
     'ringtone', so the chosen tone actually plays.
Tradeoff (user-approved): apps FORCE-STOPPED from Settings can't run JS so won't
ring — Android platform limit. Swiped-away/backgrounded apps ring fine.
⚠️ Verifiable ONLY on a real Android device build (not Expo Go / cloud).

## iter-222 — Share-contact picker + clickable phone numbers
1. ShareContactsDialog: (a) import no longer AUTO-SELECTS 20 device contacts
   (caused "Next · 20" + "Limit reached" when picking the searched contact);
   starts with none selected. (b) Search box now filters the DEVICE list too
   (previously only Smilers contacts), and device+Smilers are merged into ONE
   virtualized FlatList (was thousands of un-virtualized header rows).
2. Phone numbers in message text are now tappable (MediaBubble RichMessageText
   + new src/lib/usePhoneMessageActions.ts): tap → if on Smilers, offer
   "Message" (opens/creates direct chat via getOrCreateDirect); else offer
   "Invite" via native share sheet pre-filled with the user's referral code
   (buildInviteMessage). Regex ignores timestamps/short numbers (>=7 digits).
⚠️ Behind Google OIDC login — verify on device/build (testing agent can't auth).

## iter-223 — Media auto-download, device names everywhere, phone-identity (mobile side)
1. Media Auto-Download: new Settings screen (app/media-auto-download.tsx) with
   per-type toggles (Photos/Videos/Audio/Documents, all OFF by default), backed
   by src/lib/mediaAutoDownload.ts (AsyncStorage prefs + saved-id dedupe). The
   useAutoDownloadMedia hook is wired into Image/Video/Voice/File bubbles to
   silently save INCOMING media (gallery for media, SmilersDownloads/ for docs).
2. Device names: ShareContactsDialog now resolves the device address-book name
   (lookupDeviceContactName) instead of the Google display name.
3. Phone-identity (mobile): usePhoneMessageActions checks the user's OWN Smilers
   contacts (api.contacts.getContacts) by last-10-digits BEFORE the backend
   users.getByPhone, so known contacts show "Message" not "Invite".
   ⚠️ Global case (numbers on Smilers but not your contact) + Device-Contacts tab
   classification need backend work — see /app/PHONE_IDENTITY_BACKEND_SPEC.md.

- iter-223b: Batch getByPhones wiring added (feature-detected, dormant until backend ships). phoneLookup.lookupUsersByPhones + Device-Contacts tab classifies registered numbers → "Message" vs "Invite".

- iter-223c: Reconciled mobile wiring to the REAL deployed backend API. lookupUsersByPhones now calls api.users.lookupByPhones({phones}) parsing {input,onSmilers,userId,...}, keyed by last-10 digits. Device-Contacts tab + chat number-tap fallback both use it (last-10 match, more accurate than exact getByPhone). Spec doc marked RESOLVED.

- iter-223d: Added "X of your contacts are already on Smilers" nudge banner atop Device-Contacts tab (onSmilersCount from batch lookup; shown only when >0).

- iter-223e: Nudge banner is now tappable — toggles the Device list to show ONLY on-Smilers contacts (deviceListData filter), with active styling, dynamic label (ON SMILERS vs INVITE TO SMILERS), and auto-reset when count hits 0.
