# Smilers Native — Changelog

## iter-306 (Jul 2026): "No chats yet / feels offline on one device" — auth-token limbo fix
**Symptom (one device only):** name shows (from cache) but no profile photo, "feels
offline", Chats shows "No chats yet"; pull-to-refresh doesn't help; only a full
sign-out/in restores it. Backend diag from the device: `auth=false`, gate stuck, Convex
`hardReconnect` looping.
**Root cause:** `ConvexClientProvider.fetchAccessToken({forceRefreshToken})` IGNORED the
`forceRefreshToken` flag — it just called `getFreshIdToken()`, which only refreshes on
near-expiry and, on any failure, returns the SAME stale id_token. So when Convex rejected
our token and re-asked with force=true ("give me a genuinely fresh one"), we handed back
the identical stale token → Convex stayed permanently unauthenticated on that device →
`getCurrentUser` null → empty chats. Manual sign-out/in was the only recovery.
**Fix:**
1. `getFreshIdToken(force?: boolean)` now honors `force`: when true it rotates the token
   via the refresh token even if not near expiry (skipped only when the refresh token is
   already terminally dead, to avoid hammering + route to re-auth).
2. `ConvexClientProvider` passes Convex's `forceRefreshToken` through to
   `getFreshIdToken(forceRefreshToken)`.
Net: a rejected token now self-heals (Convex forces a refresh → fresh id_token → chats
load) without a manual sign-out/in. Consulted the OIDC refresh-rotation playbook; the
existing single-flight guard (`refreshInFlightRef`) already prevents concurrent-refresh
collisions, so no extra lock was needed.


## iter-300 (Jun 2026): "Chats flash then Opening Smilers forever" fix + Referral QR
**Problem (P0, build-only regression):** On app launch the Chats list rendered for
~2-3s, then the full-screen "Opening Smilers…" spinner took over permanently. Did NOT
happen on web.
**Root cause:** `AuthProvider`'s background token refresh fires shortly after boot →
`setIdToken(newToken)` → `ConvexProviderWithAuth` re-authenticates the socket → the live
`api.users.getCurrentUser` query transiently resets to `undefined` → the `meLoading` gate
in `app/(tabs)/_layout.tsx` re-showed the "Opening Smilers…" spinner, and if the re-auth
handshake stalled (the known "Base version" desync) it spun to eternity.
**Fix:** added an `everReady` latch in `app/(tabs)/_layout.tsx`. Once `me` resolves with
the install verified, the full-screen spinner gate (and the meGate-timeout recovery gate)
are permanently disabled — a transient `me=undefined` after the first successful boot just
keeps the already-rendered tabs on screen (Convex retains cached data; per-screen queries
tolerate null). Terminal `sessionExpired` still routes to the actionable recovery screen.
Note: timing-sensitive — true validation is on the next real EAS build.
**Also:** finished the Referral screen (`app/earnings.tsx`): fixed a missing
`buildInviteUrl` import (was a ReferenceError crash risk), added a green "✓ Copied" toast,
and added a scannable QR code (`react-native-qrcode-svg`) encoding the Play Store invite
URL so friends can install with the referral code baked in.


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

- iter-224: (1) Profile photo tap → full-screen viewer + "Save to gallery" download (profile.tsx). (2) Phone-identity asymmetry diagnosed as backend data (self-exclusion + un-backfilled phoneLast10/verification). Mobile now special-cases OWN number → "This is your own Smilers number" (usePhoneMessageActions). See PHONE_IDENTITY_ASYMMETRY_iter224.md.

- iter-225: (1) Photo/video status create fails with CONVEX statuses:create Server Error — diagnosed as BACKEND uncaught exception (mobile sends documented shape; text works). Report: STATUS_CREATE_MEDIA_SERVER_ERROR_iter225.md. (2) Removed the yellow web-parity mute FAB from user/[userId].tsx (kept native voice mic).

- iter-226: (1) Status media stuck loading — viewer relied on broken api.files.getUrl. Now reads backend-resolved mediaUrl/fileUrl/url/imageUrl/videoUrl first, files.getUrl only as last resort (status-view/[userId].tsx). (2) Call/push logs: calls:endCall Server Error = BACKEND bug; emergentPush register Aborted; signals skipped (session not ready). KEY: device on v2.1.93 — iter-221 ringtone/wake changes need a fresh build. See CALL_PUSH_PIPELINE_iter226.md.

- iter-226b: Other-user profile photo viewer (tap to enlarge + policy-gated Save) in user/[userId].tsx; shared savePhotoToGallery helper; new photo-privacy settings screen + row; PHOTO_SAVE_POLICY_BACKEND_SPEC.md. Bumped notifee call channel to MAX importance (versioned id v2) for better screen-wake/full-screen-intent.

- iter-227: Backend shipped photoSavePolicy + server-computed canSavePhoto. Viewer now prefers user.canSavePhoto (boolean) when present, client logic as fallback.

- iter-228: Screen-share remote tile fix. (a) Native hook useTwilioCallSession.native.ts was MISSING renderLocalView/renderParticipantView/renderScreenShareView/screenShareState in its return — implemented + returned them (TwilioVideoParticipantView trackIdentifier={videoTrackSid}, scaleType fit). (b) twilio-call.tsx now renders the remote tile whenever p.videoTrackSid exists (not gated on isVideo) so a shared screen shows even on voice calls.
