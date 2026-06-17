# Smilers Mobile App — PRD

## Latest fix (Feb 2026 — iter-177): OS Share Sheet "Nothing shared yet" ROOT CAUSE
**Recurring bug finally root-caused.** The app called `useShareIntent()` in TWO places (global `ShareIntentRouter` in `_layout.tsx` + `share-receiver.tsx`). Each hook instance has private state and the native payload is one-shot: the router consumed it, navigated, and the screen's late-mounted instance was always empty.
**Fix:** Single `ShareIntentProvider` mounted at app root (`src/lib/shareIntentContext.tsx` — platform-safe wrapper `AppShareIntentProvider` / `useAppShareIntent`). Both router and screen now read the SAME shared state. Screen also snapshots the first non-empty payload so background/reset can't wipe it mid-flow. Pure JS fix — ships in any new Emergent Android build (no native change needed). Earlier Kotlin/JS library patches (`scripts/patch-expo-share-intent.js`) remain in place and are still required.
**Status:** lint + tsc + web smoke test PASS. Android device verification by user CONFIRMED WORKING (share sheet → recipient picker now appears).

### Follow-up (same day): device-contact names in share picker
Share screen recipient list was showing Smilers/Google account names instead of device-saved contact names. Fixed by wiring `useDeviceContactIndex` + `getResolvedDisplayName` / `getResolvedConversationDisplayName` (same iter-176 override used in Chats/Contacts) into the share-receiver recipient builder (DM rows + contact rows; groups untouched). Verification on device pending — requires new Android build.

### iter-178: "Frequently shared" pins in share picker
New `src/lib/recentShareTargets.ts` (AsyncStorage, per-user, stable ids `u:<userId>` / `c:<convId>`, capped 8). After each successful share, targets are recorded; on next share up to 3 most-used recipients are pinned below My Diary with a "Frequently shared" subtitle. Local-only, best-effort, never blocks send.

### iter-179: APK sharing allowed + clear "blocked" reporting
The "Sent to 0 chats / 1 send(s) failed" report was the iter-164 security scanner silently blocking an .apk share — not a real failure. Fixes: (1) `SendOutcome.blocked` flag replaces fragile regex tally; share-complete alert now states the block reason explicitly. (2) Per user decision (option b, WhatsApp-style), `.apk` removed from DANGEROUS_EXTENSIONS in BOTH `messageSecurityScanner.ts` (send boundary) and `securityScanner.ts` (incoming render/auto-delete). `.exe/.bat/.ipa/etc.` remain blocked. Verified via tsx unit run: apk allowed, exe/bat/ipa blocked, jpg safe — ALL PASS.
(3) Caution banner: received .apk file messages show an amber "App install file — only install if you trust the sender" strip under the file bubble (`FileMessage` in `src/components/MediaBubble.tsx`, testID `apk-caution-<msgId>`). Sender's own bubble stays clean.

### iter-180: Call-log pills missing in chat — fetch layer fix
Call pills (CallPill, `__kind:'call'` merge, `api.calls.listCallLogsForConversation`) all existed since iter-156, but the data was fetched with one-shot `useSafeConvexQuery` which (a) raced the Convex auth handshake on cold launch → unauthenticated result `[]` cached for the whole visit, and (b) never refreshed after a call ended while chat was open. Fix: new `useSafeConvexSubscription` (reactive `watchQuery`+`onUpdate`, error-safe fallback) in `src/hooks/useSafeConvexQuery.ts`; chat screen now subscribes live. Also fixed `Number(ISO startedAt)`→NaN timestamp parsing (toMillis handles numeric + ISO). NOTE for next agent: if pills STILL don't appear on device after this, the Convex backend (web codebase, not ours) is likely not writing call-log rows for mobile-initiated calls — would need a CONVEX_BACKEND_INSTRUCTIONS doc for the web team.

### iter-181: Settings green Earnings + Scheduled repeat fix + Trustees picker fix
1. **Earnings row** in Settings now renders green (#16A34A icon/title, #DCFCE7 chip) via new `success` flag — mirrors the red `danger` styling on Emergency/Blocked.
2. **Scheduled messages**: (a) local-draft sync was hardcoding `repeat:'once'` — now maps recurring frequency properly; (b) chat composer recipient label now uses device-contact-resolved names (fixes "Unknown" recipients); (c) the DAILY-CLONE-AS-ONCE row duplication is a BACKEND defect — wrote `/app/CONVEX_BACKEND_INSTRUCTIONS_SCHEDULED_REPEAT.md` for the web team (fire → update same row date in place, keep repeat, no clones, cleanup migration).
3. **Trustees picker** "No Smilers contacts available": picker now merges DM conversation peers (guaranteed registered users) with contacts rows, accepts row `_id` as user reference (same as Contacts tab's getContactUserId), still excludes pending invites, and shows device-saved names.

### iter-182: Six-issue batch (call ringing regression, tones, tabs, save photo, languages, chat perf)
1. **Call ringing root cause (backend `server.py`)**: incoming-call FCM pushes landed on the default "messages-v3" channel (one short beep + short vibration — exact user symptom) because Convex doesn't reliably send `channel_id`. Added `_resolve_android_channel()`: per-token channel override → explicit channel_id → type-derived ('calls' for call payloads, detected via type/action_url(/call)/title regex). 9 pytest tests in `/app/backend/tests/test_push_channels.py` (all pass; full suite 28 pass).
2. **Tone customization (issue 6)**: Android channels are IMMUTABLE → introduced tone-versioned channel ids (`calls-v4-<sound>` MAX importance + bypassDnd, `messages-v4-<sound>` HIGH) in new `src/push/notificationChannels.ts`. App registers its current channel ids with `/api/register-push` (new optional fields `call_channel_id`/`message_channel_id`, stored per token); `ringtones.tsx` persist() now applies versioned channels + immediate `reregisterPushDevice()` (exported from useEmergentPush). Old fixed ids still created for back-compat. Verified registration+storage via curl/mongosh.
3. **Tabs covered by OS nav bar**: tab bar uses safe-area bottom inset ((tabs)/_layout.tsx).
4. **Save photo error**: `messageMedia.ts` now guarantees a media extension (mime→url→type default .jpg/.mp4/.m4a); extension-less/.bin files caused "Primary directory DCIM not allowed".
5. **Language save spinner forever**: 10s timeout race around Convex mutations in languages.tsx (both onSave and saveLanguage) — hung queued mutations no longer freeze the UI; local save + clear alert instead.
6. **Chat slow initial load / call buttons (issue 2)**: investigated — buttons are wired directly; sluggishness = JS-thread saturation from the 4600-line screen's initial render. FlatList initialNumToRender tuning was tried and REVERTED (blank-bottom regression risk with scrollToEnd). Proper fix = chat screen refactor (backlog).
HONEST LIMIT: full screen-wake on locked phones still requires the CallKeep/full-screen-intent native layer which is BLOCKED by the build pipeline (expo config crash). The MAX-importance call channel gives heads-up + screen light-up on most devices.

### iter-183: Trustees infinite spinner — ROOT CAUSE + global fix
Backend verified FINE via direct Convex probes: `trustees:getMyTrustees` ✓, `trustees:addTrustee` ✓, `trustees:removeTrustee` ✓, `contacts:getContacts` ✓, `conversations:listConversations` ✓ all exist on deployment (no Convex/web changes needed — communicated to user).
Root cause was mobile-side: `useSafeConvexQuery` awaited a ONE-SHOT `convex.query()` that the client can queue FOREVER when racing the auth handshake → `loading:true` for eternity (same failure class as the languages-save hang and call-pills emptiness). REWROTE the hook internals to a `watchQuery` SUBSCRIPTION (same public API `{data, loading, refetch}`): auto-recovers when auth completes, live-updates on server writes, 12s safety timer guarantees no infinite spinner, still degrades to fallback on errors. Benefits ALL consumer screens (trustees, contacts pickers, admin tabs, recordings, share picker...). Preserved iter-138 (no flicker on enabled toggles) and iter-141 (spinner only on first load) behaviors.

### iter-184: Chat screen refactor — Phase 1 (structure, zero behavior change)
`app/chat/[conversationId].tsx` reduced 4,626 → 3,853 lines by extracting verbatim into focused modules:
- `src/lib/chatFormat.ts` — formatChatDayChip, isSameCalendarDay, isGifAsset, formatCallDuration
- `src/components/chat/MessageBubble.tsx` — ActionRow (used by action sheet) + MessageBubble (NOTE: MessageBubble was ALREADY dead code in the timeline — MediaBubble renders everything; kept exported for future use)
- `src/components/chat/CallPill.tsx`, `src/components/chat/RecordingPlayback.tsx`, `src/components/chat/ChatOptionsMenu.tsx`
31 bubble/action style keys moved out of the main StyleSheet (verified exclusive via usage scan; only flexOne shared → copied). All code moved VERBATIM; tsc/eslint clean; boot smoke pass.
**Phase 2 candidates (next):** extract the three in-JSX modals (action sheet ~line 2700, disappearing sheet, template picker), then split composer + header into components, then hook-extraction for the ~90 hooks at top of ChatScreen.

### iter-185: Reply-to-message send failure FIXED
Replying on mobile always failed (message stayed unsent; web worked). Root cause: mobile sent BOTH `replyToId` AND `replyToMessageId` on every reply payload (iter-101 dual-compat) — the deployed `messages.send` strict validator rejects the unknown extra field → mutation throws → composer restored silently. Web sends only `replyToId` → works. Fix: ALL 8 send sites in chat screen now send ONLY `replyToId` (text, edit-fallback, image, file, GIF, voice, video, poll/location paths). Renderer still reads both names on rows. Also: send failure now restores the reply banner AND shows a "Message not sent" alert instead of failing silently. Contract doc section 5 updated.

### iter-186: Play Store invite links + languages save + scheduled sync doc
1. **Invite links → Play Store**: new `src/lib/inviteLink.ts` (PLAY_STORE_URL = play.google.com/store/apps/details?id=com.smilers.app). All invites (Contacts tab invite + Earnings "Share code") now link to the Play listing with the referral code in BOTH the Play `referrer` param (Install Referrer-ready) and the message text ("Use my referral code X") so earnings referrals keep counting.
2. **Languages save error**: probed deployment — ONLY `users.updateProfile` exists (updateLanguages/setLanguages/languages.update are FunctionPathNotFound). Reordered candidates so updateProfile variants go FIRST and raised the save timeout 10s→20s for slow/roaming networks.
3. **Scheduled messages Once/duplicates/not-on-web**: confirmed mobile uses deployed canonical fns (scheduling.scheduleMessageMobile, scheduledMessages.listMine/update/remove/setActive) — the duplication-as-once AND the web-sync gap are CONVEX BACKEND defects. Extended `/app/CONVEX_BACKEND_INSTRUCTIONS_SCHEDULED_REPEAT.md` with the one-canonical-store sync requirement. USER MUST APPLY THIS DOC IN THE WEB PROJECT — mobile cannot fix it.

### iter-187: Caller-side ringback silence — ROOT CAUSE + native fix
User insight confirmed: outgoing-call ringback (Smilers theme on the CALLER's phone) only played when permissions weren't granted yet. Mechanism: once permissions are granted, the call screen starts InCallManager (MODE_IN_COMMUNICATION) immediately during outgoing "ringing" — Android mutes the media stream where the expo-audio ringback played. Fix:
1. Bundled `assets/sounds/incallmanager_ringback.mp3` (copy of smilers_never_cry.mp3, the library's `_BUNDLE_` naming, verified in InCallManagerModule.java) + added to app.json sounds → lands in res/raw.
2. `InCallAudio.startRingback()/stopRingback()` wrappers in `src/lib/webrtc/inCallManager.ts` — ringback now plays on the VOICE-CALL stream (immune to communication mode) during outgoing ringing.
3. Callee-side: native session start now SUPPRESSED while incoming-ringing (suppressSessionStartRef) and started on answer — so the in-app ringtone (user's selected tone) stays audible; WebRTC callee setup begins at answer anyway.
4. useRingtonePlayer now incoming-only.
ALSO acknowledged to user: wake-screen + CallKeep still requires EAS CLI build (Emergent pipeline rejects the config plugin) — per earlier diagnosis; backend redeploy still needed for the push channel routing (iter-182).
NOTE: during editing, two search_replace ops mis-applied leaving duplicate trailing lines in call/[conversationId].tsx — repaired by truncation; file verified clean (tsc/eslint pass).

### iter-188: Mobile alignment with the NEW scheduled-messages backend
Web-side agent rewrote the Convex delivery worker (real timers, repeat recurrence, unified store, expectedSendKey stale-timer guard). Mobile alignment applied:
1. `recipient` label now prefers the SERVER-KNOWN Smilers profile name (device-contact name only as fallback) — the new worker resolves recipient→conversation BY NAME and can't match device-saved names.
2. Chat-composer schedule create now self-negotiates `conversationId`: tries `{...args, conversationId}` first (zero-ambiguity targeting), falls back to the confirmed iter-126 contract if the validator rejects the extra field. Works with both old and new deployed validators.
OPTIONAL backend follow-up (relay to web agent): accept optional `conversationId` in `scheduling.scheduleMessageMobile` + `scheduledMessages.create` validators and use it directly when present — mobile already sends it.

## Overview
Native iOS + Android port of **smilers.online** (a Convex-backed real-time messaging app). Connects directly to the existing Convex backend (`https://aware-newt-456.convex.cloud`) using the official Convex React Native SDK. Authenticates via Hercules Auth OIDC (same provider as web app). Web and mobile share the same database in real time.

## Stack
- **Frontend**: React Native + Expo SDK 54, expo-router, TypeScript
- **Backend**: Convex (existing, unmodified) — real-time WebSocket subscriptions
- **Auth**: Hercules Auth OIDC via expo-auth-session + PKCE
- **Storage**: Convex File Storage (binary upload via signed URLs)
- **Push**: Expo Push Notifications (works for both iOS APNs and Android FCM)
- **Permissions**: Camera, Photo Library, Microphone, Location, Contacts, Face ID

## Phase 2 Implementation (Push Notifications + Phone Verification)

### Push Notifications (Mobile-side complete; backend wiring needed via Hercules)
- Permission request, Expo push token registration on login
- Android channels: `calls` (MAX importance, custom Smilers ringtone) + `messages` (HIGH)
- iOS notification category with **Answer** / **Decline** action buttons
- Tap-to-deep-link: message push → `/chat/<id>`, call push → `/call/<id>`
- Decline button calls `api.calls.declineCall` directly without opening the app
- Real-time foreground call listener via Convex reactive query

### Phone Verification Gate (Mobile-side complete; backend wiring needed via Hercules)
- Hard-block on `/phone-verify` if `me.phone` missing OR `me.phoneVerified !== true`
- Country code picker with flag emojis (`react-native-country-codes-picker`)
- E.164 validation via `libphonenumber-js`
- Twilio Verify integration (sendOtp + verifyOtp actions on backend)
- 30-second resend cooldown
- "Use a different number" + "Sign out" escape hatches
- Duplicate phone detection (rejects if already verified by another user)
- Both new and existing users without verified phone are forced through this gate

### Backend specs (give to Hercules agent)
- `/app/CONVEX_BACKEND_INSTRUCTIONS.md` — Push notifications schema/mutations/Expo Push Service POSTing
- `/app/CONVEX_BACKEND_INSTRUCTIONS_PHONE.md` — Phone verification with Twilio Verify, schema additions, defense-in-depth checks

### Hercules dashboard config (user-side)
- Restrict OIDC login methods to Google + Apple ID only (disable Email OTP, LinkedIn, Microsoft, Phone OTP)

## Phase 1 Implementation (Complete)
- ✅ Sign-in screen with Hercules OIDC (PKCE flow, secure token storage on native, localStorage fallback on web)
- ✅ OIDC callback fix v2.0.12: expo-router `+not-found.tsx` now catches `smilers://auth-callback?code=...` deep links, restores PKCE state, exchanges tokens, and routes to chats with on-screen debug logs on failure
- ✅ Settings navigation now fully wired with real Phase 1 utility screens: Emergency, AI Assistant, Blocked Users, Notifications, Earnings & Rewards
- ✅ Added polished placeholder routes for Privacy, App Lock, Face ID, Chat Appearance, Quick Replies, Scheduled Messages, and Chat Once
- ✅ Added safe Convex query fallback layer so optional backend functions degrade to empty states instead of crashing the UI when unavailable
- ✅ Fixed the Contacts tab crash by refactoring `app/frontend/app/(tabs)/contacts.tsx` to use `useSafeConvexQuery` for contacts, pending requests, outgoing requests, and search results; missing Convex endpoints now fall back safely instead of crashing the app tree
- ✅ Audited all current `ComingSoon` screens so the next replacement work can be prioritized cleanly: `privacy`, `app-lock`, `face-id`, `scheduled`, `templates`, `chat-appearance`, `chat-once`, and `auth-webview`
- ✅ Replaced the `Privacy` placeholder with a real mobile settings screen for last seen, profile photo, about, status, groups, calls, read receipts, and typing indicators, persisted locally on device
- ✅ Replaced the `App Lock` placeholder with a real settings screen for PIN setup/change/remove, auto-lock timing, preview hiding, background lock, and biometric enablement on supported native devices
- ✅ Replaced the `Scheduled Messages` placeholder with a real management screen for creating, editing, pausing, resuming, and deleting scheduled message drafts, persisted locally on device
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_PRIVACY_SCHEDULED.md` and wired the Privacy + Scheduled screens to safe Convex endpoint names (`privacy.getSettings`, `privacy.updateSettings`, `scheduledMessages.listMine`, `create`, `update`, `remove`, `setActive`) with local fallback when those endpoints are unavailable
- ✅ Replaced the `Quick Replies` placeholder with a real templates screen for searching, creating, editing, favoriting, copying, and deleting saved reply snippets, plus starter suggestions
- ✅ Replaced the `Chat Appearance` placeholder with a real appearance screen for wallpaper, outgoing/incoming bubble colours, bubble style, and message size, with live preview and local persistence
- ✅ Wired chat personalization into the live chat UI: saved wallpaper now applies to the chat screen background and Quick Replies can be opened from the chat composer
- ✅ Tabs layout now uses web-safe auth redirects, and Expo push-notification calls are guarded on web so `/chats` no longer red-screens in preview
- ✅ Phase 2A.1 chat actions added: long-press action sheet, quick reactions, reply preview, quoted replies, copy, forward, star/unstar, delete placeholder, and haptic feedback
- ✅ Chat route is now hardened for invalid/unauthorized conversation IDs with a safe fallback state instead of a Convex error screen
- ✅ Phase 2A.2a media groundwork added: attachment sheet, image upload helper, gallery/camera send flow, image bubble rendering, upload progress bar, and full-screen image viewer
- ✅ Phase 2A.2b voice notes patched in: record/send flow in chat composer plus playback UI in media bubbles
- ✅ Phase 2A.2c chat parity added on the frontend: poll composer modal, poll message bubble voting UI, document picking/upload flow, and file message bubble open/download handling
- ✅ Phase 2B.1 frontend prerequisites added: redesigned sign-in screen, status composer route, and media status creation sheet on the Status tab
- ✅ Phase 2B.2 story viewer added on the frontend: full-screen viewer route, progress bars, tap navigation, pause/resume handling, reply input, and own-story viewers sheet
- ✅ Phase 2C contacts polish added on the frontend: rewritten Contacts tab, reject/cancel flows, sent/respond/contact pills, add-by-phone modal, and QR show/scan route
- ✅ Ads module addendum added on the frontend: My Ads credit balance/redeem card plus Admin > Ads > Ad Codes tab with generate/copy/revoke controls
- ✅ Search + Starred slice added on the frontend: global search screen, starred messages screen, chats/profile button wiring, and a basic user profile route for search results
- ✅ Wallet / Send Money slice added on the frontend: `Gold Wallet` screen, withdrawal methods/request UI, `Send Money` screen with send/request/pending tabs, and Earnings entry points into both routes
- ✅ Ads module MVP added: Ads tab wiring, Browse/My Ads view, Create Ad form, Admin Review screen, country selector modal, and standard 195-country list filtering
- ✅ Fixed React 19 TypeScript incompatibility from `react-native-country-codes-picker` so the preview/build loads cleanly again
- ✅ Fixed invalid chat-route update loop by stabilizing query fallback handling and chat fallbacks; `/chat/test-conversation` now renders the unavailable state without `Maximum update depth exceeded`
- ✅ Rebuilt `/chat-appearance` to closely match the latest user-provided screenshot reference with a dark brown header, wallpaper/bubble-theme tabs, large live preview, screenshot-style wallpaper cards, and preserved local appearance persistence
- ✅ Hardened Android production bundling for WebRTC calls by adding an npm `prepare` hook for the existing `patch-rn-webrtc.js` and forcing `react-native-webrtc` to resolve `event-target-shim@5.0.1`, preventing the EAS `Missing "./index" specifier in "event-target-shim" package` failure during the JavaScript bundle phase
- ✅ Removed a corrupt malformed filename from `/app/frontend` that was breaking EAS tarball upload with `ENOENT ... lstat '/workspace/source/frontend/��@@��9@8'`, and strengthened `.easignore` to exclude similar junk names plus Python cache artifacts
- ✅ Fixed the Groups tab crash risk by replacing raw Convex queries with `useSafeConvexQuery`, deferring the optional conferences query until needed, and hardening list item IDs / row navigation so missing identifiers do not crash the screen
- ✅ Fixed Groups/Conferences navigation and call-route stability: Groups `+` now opens a dedicated new-group screen, Conferences `+` opens a safe new-conference screen, Conferences now reuse existing group conversations as conference-ready entries, and the call screen no longer crashes from unguarded wake-lock usage or raw unauthenticated Convex queries
- ✅ Updated the Conferences screen toward the latest screenshot reference (gold header, back arrow, search, invite-code row, styled conference list, SOS button) and further hardened the native call flow by moving audio-session setup until after permissions succeed and adding iOS background-audio capability support in `app.json`
- ✅ Added Android-specific call-screen mounting guards: `CallSession` and `RTCViewWrapper` are now lazy-loaded after a short mount delay so `react-native-webrtc` native modules do not initialize too early and crash Android when the voice/video route opens
- ✅ Login and Sign Up were explicitly skipped by the user for now; rebuilt the Message Language screen to match the provided web screenshot, added Akan (Asante Twi) plus more recognized languages (including Kazakh), and changed the profile language row to display a human-readable language name instead of a raw code
- ✅ Applied the latest chat-screen references to `/chat/[conversationId]`: replaced the generic header with a screenshot-style brown header, added the end-to-end encryption banner, date chips, warmer composer controls, and richer link/file bubble styling while preserving the existing Chat Appearance wallpaper and bubble-theme system
- ✅ Added screenshot-driven chat extras and money flow updates: voice-note recording now exposes cancel / pause-resume / send controls, disappearing messages now use a top chat button with selectable options, and `/send-money` was rebuilt to a screenshot-style Send / Requests / History experience with transfer and contact-picker modals
- ✅ Refined the live chat typography and bubble styling again to better mirror the web app: title casing now matches the web header more closely, date/time chips use the web-style formatting, default chat text size is less oversized, and message bubbles use tighter radii/padding closer to the web screenshots
- ✅ Added richer chat-composer behavior toward the latest web screenshots: the composer now uses stronger keyboard avoidance on Android, exposes a bold toggle plus a five-color palette, and renders outgoing formatted text (bold / black / red / blue / green / gold) through a lightweight rich-text message parser
- ✅ Refreshed the bundled ringtone assets for `Smilers Never Cry · 2` and `Smilers Never Cry · 3` with the latest uploaded MP3s while keeping the existing ringtone catalog entries intact
- ✅ Updated the bundled message notification sound so received messages now use a two-part alert sequence: the existing beep followed by the newly uploaded follow-up sound, while preserving the same `message_notification.mp3` filename already used by foreground alerts and native push channels
- ✅ Re-investigated the Android production call crash and removed the remaining early `react-native-webrtc` native initialization: `CallSession.ts` now uses cached dynamic imports, `createPeerConnection()` is async, `call/[conversationId].tsx` awaits that initialization, and `RTCViewWrapper.ts` no longer imports `RTCView` at module load time
- ✅ Fixed the follow-up EAS Update export blocker by removing JSX from `src/lib/webrtc/RTCViewWrapper.ts` and switching to `React.createElement(...)`, which keeps the wrapper valid as a `.ts` file during OTA/export bundling
- ✅ Refined the native voice-call screen toward the web screenshots: smarter contact-name resolution, outlined avatar orb, web-style Mute / Audio / Screen / Add controls, and an in-call Audio Output chooser matching the provided reference more closely
- ✅ Added the in-call Add to call escalation flow to match the provided screenshots: tapping Add now opens a dedicated add-participant overlay with contact search, then shows the Privacy Settings choice sheet before creating a new group conversation and replacing into the conference call route
- ✅ Added shared safe display-name resolution across Contacts, Chats, Chat header, Call screen, add-to-call rows, and Avatar initials so saved contact names are preferred over the generic `Smilers` fallback and malformed name payloads no longer crash renders
- ✅ Hardened contact opening with safer contact-user-id lookup and guard rails around direct-chat creation so bad or incomplete contact records degrade gracefully instead of crashing the app
- ✅ Updated ringtone playback so the user's selected preferred ringtone is used during outgoing ringing as well as incoming ringing (with vibration still limited to incoming-call behavior)
- ✅ Tightened the chat composer box again toward the web screenshot with a denser beige shell, slimmer toolbar spacing, and a more web-like input shape
- ✅ Reworked the non-video call layout for compact screens: the avatar/name/status area is now centered and uses compact spacing/sizing so contact metadata no longer overlaps the action controls on short mobile heights
- ✅ Replaced the simple emoji modal with a fuller web-style emoji picker sheet: category icon row, many more emoji categories, and recent emojis support
- ✅ Reworked the attachment popup toward the web reference into a floating action card with Photo, Video from Gallery, Record Video, Document, and Location rows
- ✅ Restored chat keyboard avoidance for typing and switched voice-note recording to an explicit `prepareToRecordAsync` + `startAsync` flow for more reliable recording startup
- ✅ Expanded ringtone options with `Classic Ring` and `Smilers Notification`, and updated foreground message alerts to play a two-step beep + selected notification tone sequence
- ✅ Tuned the visible composer toolbar closer to the web screenshots by shifting primary actions into a dedicated bottom tool row (apps, GIF placeholder, templates, tools, mic, palette), simplifying the input row itself, and then tightening spacing/icon sizing/divider weight for a flatter web-like finish
- ✅ Fixed a critical chat crash path by removing the auto-translation render loop (translated-message state no longer retriggers the translation effect on every render)
- ✅ Split the two language flows correctly: `/message-language` is now the single preferred-language picker for auto-translation, while `/languages` is the multi-select skip-translation settings screen with grouped headings and checkbox rows
- ✅ Expanded the shared language catalog to 111 entries so both language flows can show a much fuller official-language list with distinct variants like Chinese Simplified/Traditional and Portuguese / Portuguese (Brazil)
- ✅ Simplified notification-sound choices to only `Smilers Notification` and `Silent`, synced the Android Messages notification channel to that choice, and made foreground translation faster by processing only recent untranslated messages in parallel
- ✅ Fixed an audio-mode conflict between foreground message sounds and voice-note recording, and reduced the attachment sheet footprint slightly again
- ✅ Added app-side Android notification hardening for native behavior: `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`, message/call channel syncing, and a missed-call local notification when an incoming call ends unanswered while the app is alive enough to observe it
- ✅ Fixed the repeated call-screen naming issue for caller-launched calls by passing the resolved saved contact name into the call route, and updated caller hangup during ringing to use `declineCall` so the remote side can stop ringing correctly
- ✅ Replaced the composer tools-button `requestAnimationFrame(...focus())` timing with an interaction-safe focus pattern to avoid the real-device backgrounding issue
- ✅ Improved live status handling by merging saved contact data with conversation presence data instead of letting saved contact records hide online/last-seen fields
- ✅ Added separate delivery acknowledgements for message ticks: the app now attempts `messages.markDelivered` when a message push is received while running, and the chat screen calls `markDelivered` before `markRead` so delivered vs read can diverge more like the web app
- ✅ Fixed tick rendering assumptions so `readBy.length > 0` is enough to show the read state, rather than incorrectly requiring more than one reader entry
- ✅ Deployment-facing package cleanup: removed mixed Yarn lock usage, switched `packageManager` to npm, generated a consistent `package-lock.json`, and moved `eslint` + `eslint-config-expo` into runtime dependencies so the build-time `expo install` / config checks can find them reliably
- ✅ Deployment-facing auth URL cleanup: added `EXPO_PUBLIC_WEB_APP_URL` to frontend env and removed the hardcoded `https://smilers.online` fallback in mobile auth screens/providers
- ✅ Push notification spec alignment pass: installed `expo-task-manager`, updated native push registration to send `{ expoPushToken, platform, deviceName, appVersion }` with backend fallback for `mobilePush` vs `pushNotifications`, refreshed Android `calls` / `messages` channels plus iOS `remote-notification` background mode, and added background notification-task scaffolding for headless/data-driven delivery handling
- ✅ Web-safe push import cleanup: added `usePushNotifications.web.ts` and converted remaining top-level `expo-notifications` imports in call/ringtone screens to native-only lazy requires so web preview no longer logs the push-token-listener warning
- ✅ Backend-aligned push lifecycle: moved native push registration out of the tabs layout into `app/_layout.tsx` so authenticated sessions register earlier, added best-effort `mobilePush.unregisterMobileDevice` handling on logout, and restored native token-refresh re-registration now that the web bundle is isolated from Expo notifications imports
- ✅ Deployment hardening for Emergent/EAS Android builds: moved `typescript` and `@babel/core` into production dependencies so Expo CLI checks still work when the builder omits devDependencies, and added `frontend/eas.json` with `cli.appVersionSource` + `app-bundle` profile so the pipeline stops generating that config dynamically. (Kept `packageManager` on Yarn locally because this workspace’s readonly supervisor still launches Expo with Yarn; the deployment log’s concrete blockers were missing build-time dependencies, not the packageManager field.)
- ✅ Fixed chat composer tools-button crash/minimize on Android: the sliders button had been calling a nonexistent `setShowComposerFormatting` setter at press time. Introduced real pinned formatting state in `app/chat/[conversationId].tsx`, so the button now safely opens/closes the formatting strip instead of throwing and minimizing the app
- ✅ Push registration race hardening: `src/push/usePushNotifications.ts` now waits for Convex auth readiness before device-token registration, retries failed registration attempts, and re-registers on app-active/token refresh so backend `mobilePushTokens` has a better chance of being populated reliably on native devices
- ✅ Privacy web-preview fallback: `app/privacy.tsx` no longer hits the cloud privacy query on web preview, preventing repeated `privacy:getSettings` console errors while keeping the native app path ready for authenticated mobile use
- ✅ Added a push diagnostics panel to `app/notifications.tsx` backed by `src/push/pushDiagnostics.ts`, exposing auth readiness, projectId detection, permission state, device token preview, last registration result/error, and a manual retry action to speed up Android/iOS notification debugging on real devices
- ✅ Added a `Copy diagnostics` action on the Notifications diagnostics card so the full push state can be copied and shared instantly during Android/iOS debugging
- ✅ Added staged Android push-token diagnostics: the app now separates native device-token fetch from Expo token fetch and times both out with clear actionable errors, instead of hanging forever at a generic `acquiring-token` state
- ✅ Wired Android Firebase/FCM config for native push: added `frontend/google-services.json` for Firebase project `smilers-a4e07` and connected it through `expo.android.googleServicesFile` so Android builds can acquire the native device push token
- ✅ Added notification self-test tools on `app/notifications.tsx`: a local notification test and a remote Expo self-push test, allowing real-device isolation of native rendering versus backend delivery
- ✅ Switched Expo/EAS linkage to the actual project chosen by the user: `slug=smilers`, `owner=abcsimplesend`, `projectId=smilers-chat-mobile`
- ✅ Fixed the chat GIF button so it is no longer a dead disabled control; it now launches a GIF-only picker and sends selected GIF files through the existing media upload/message flow
- ✅ Migrated chat voice-note recording from deprecated `expo-av` recorder APIs to `expo-audio`, including microphone permission request, audio mode handling, recorder lifecycle, and the `expo-audio` app config plugin
- ✅ Added `/app/auth_testing.md` and `/app/auth-testing.md` to document current manual auth verification expectations for future testing runs
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_POLLS_FILES.md` because the Convex backend source is not present in this repo; it documents the required schema, `messages.send`, and `votePoll` backend changes
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_STATUS_STORIES.md` because the Convex backend source is not present in this repo; it documents the required `statuses` endpoints, story views, DM reply support, and direct-conversation mutation
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_CONTACTS_POLISH.md` because the Convex backend source is not present in this repo; it documents the required contacts queries/mutations for outgoing requests, reject/cancel, phone invites, and QR flows
- ✅ Added `/app/CONVEX_BACKEND_INSTRUCTIONS_AD_CREDIT_CODES.md` because the Convex backend source is not present in this repo; it documents the required `adCreditCodes` table, code lifecycle, redeem flow, and `ads.recordClick` billing changes
- ✅ Applied the latest user handoff spec to replace both `/privacy` and `/scheduled` with the new mobile UI variants, including installing `@react-native-community/datetimepicker` for scheduled date/time picking
- ✅ Kept the user handoff UI but added the minimal required safety fix: both routes now use `useSafeConvexQuery` instead of raw `useQuery`, because the current Convex endpoints still return `Server Error` and raw queries caused red-screen crashes
- ✅ Reworked native sign-in to bridge through the already working web app at `https://smilers.online/`: Sign In now routes to `/auth-webview`, opens the live web sign-in flow, and supports callback handoff via either direct tokens or OIDC `code/state`
- ✅ Added `/app/HERCULES_MOBILE_SIGNIN_BRIDGE.md` for the Hercules/web agent with the exact query params and callback contract needed to return control to the native app after successful web login
- ✅ Added callback support in `+not-found.tsx` / `auth-callback` for `id_token`, `access_token`, `refresh_token`, and `expires_in` bridge params, while preserving the existing code-exchange path
- ✅ Updated native phone verification gating to stay mobile-only and install-aware: after auth, the app now requires phone verification when the backend user is unverified or when the current app install lacks the local verified-install marker (matching first install / reinstall behavior)
- ✅ Stored the verified-install marker locally after successful OTP verification so repeat sign-ins on the same install do not re-prompt unnecessarily
- ✅ Renamed the Status tab route file to `updates.tsx` to avoid Expo web’s reserved `/status` path conflict while keeping the tab label as **Status**
- ✅ Convex client with custom auth integration (passes ID token via `ConvexProviderWithAuth`)
- ✅ Bottom tab navigation (5 tabs: Chats, Contacts, Groups, Status, Profile) — matches web app's bottom nav
- ✅ Chat list with pinned **Smilers AI** (purple) and **Chat Once** (orange) rows + FAB stack (4 floating buttons) + persistent SOS button
- ✅ Direct & group chat view (text messages, send, ticks for sent/delivered/read, typing indicator, reactions, replies, media placeholders)
- ✅ Contacts tab (list, search, add by email, accept pending requests, tap to open chat)
- ✅ Groups tab (list user's groups)
- ✅ Status tab (status feed, "My Status" with plus badge)
- ✅ Profile tab (avatar with camera overlay, Your Name, About, Message Language, Email, Starred Messages, Settings & Privacy, Sign Out)
- ✅ Settings screen (Privacy, App Lock, Face ID, Notifications, Earnings, Blocked Users, Scheduled Messages, Quick Replies, Chat Appearance)
- ✅ Exact design match with web app: gold/yellow primary (#E4B53B), dark brown header (#3A2608), cream background (#F5EFE0)
- ✅ All native permissions declared in app.json for iOS + Android (camera, mic, location, contacts, biometric, etc.)

## Backend API Integration (existing functions called)
- `api.users.updateCurrentUser` — auto-sync on login
- `api.users.getCurrentUser`, `api.users.searchUsers`
- `api.conversations.listConversations`, `api.conversations.listGroups`, `api.conversations.getConversation`, `api.conversations.getOrCreateDirect`
- `api.messages.list`, `api.messages.send`, `api.messages.markRead`
- `api.contacts.getContacts`, `api.contacts.getPendingRequests`, `api.contacts.sendRequest`, `api.contacts.acceptRequest`
- `api.statuses.listStatusGroups`, `api.statuses.getMyStatuses`
- `api.typing.setTyping`

## Phase 2+ (Future Iterations)
- Voice/Video calls (WebRTC peer-to-peer with Convex signaling)
- Push notifications backend wiring (register device token via `api.pushNotifications.subscribe`)
- E2EE encryption (PBKDF2 key derivation + AES-GCM as per backend spec)
- Conferences with breakout rooms, motions, voting, minutes
- Money transfers, Gold wallet, Earnings/levels system
- AI chat via `api.ai.chat`
- Communities, Broadcasts, Polls, Templates
- Status / Stories (text/photo/video composer + viewer)
- Story reply + story viewer counts/viewers sheet
- Contacts QR + add-by-phone flow
- Ads credit codes / redeem flow
- Global search + starred messages
- Wallet / send-money flow
- Scheduled messages, Backup, Face ID app lock, Trustees/Emergency
- Voice notes (record + playback + Whisper transcription)
- Image/file sharing via Convex File Storage
- Auto-translation by recipient's preferred language
- Disappearing messages
- Status reactions & replies
- Screen sharing
- Admin dashboard

## Smart Business Enhancement
The Earnings/Engagement system is already built into the backend. The mobile app exposes the entry point in Settings → "Earnings" which can drive:
- **Daily activity nudges** via push notifications to maintain engagement levels
- **Referral codes** drive viral growth with 2 engagements per signup (compounds at higher levels)
- **Gold tier wallet activation** at high engagement creates retention loop tied to real-world payouts

## Out of Scope (current iteration)
- Final real-device login validation still depends on Hercules allowing the native redirect URI `smilers://auth-callback` for the mobile client.
- End-to-end authenticated sign-in through the live Smilers web app still needs one manual web/Hercules bridge completion test, because automation cannot perform the real callback/token return from the external live site.
- Manual authenticated verification is still required for three live cases: first mobile sign-up, reinstall on a previously verified account, and deleted/reactivated account flow.
- Full end-to-end authenticated voice-note verification is still pending because browser automation cannot deterministically complete the third-party Google/Hercules sign-in flow with the current test setup.
- Full end-to-end authenticated poll/document verification is still pending for the same auth-gated reason, and the live poll voting flow also depends on the user applying the backend changes from `/app/CONVEX_BACKEND_INSTRUCTIONS_POLLS_FILES.md`.
- Full end-to-end authenticated status/story verification is still pending for the same auth-gated reason, and story viewing/reply/view counts depend on the backend changes from `/app/CONVEX_BACKEND_INSTRUCTIONS_STATUS_STORIES.md`.
- Full end-to-end authenticated contacts-polish verification is still pending for the same auth-gated reason, and outgoing requests/reject/cancel/add-by-phone depend on the backend changes from `/app/CONVEX_BACKEND_INSTRUCTIONS_CONTACTS_POLISH.md`.
- Direct signed-in verification of the fixed Contacts tab is still pending because browser automation cannot complete the Hercules-authenticated mobile flow in this environment.
- The latest `/privacy` and `/scheduled` handoff screens are live and tested, but real cloud persistence is still blocked because `privacy:getSettings`, `privacy:updateSettings`, `scheduledMessages:listMine`, and `scheduledMessages:create` continue returning Convex `Server Error`.
- Iteration 12 frontend testing confirmed both routes now load without crash and remain interactive under backend failure conditions because of the safe-query guard.
- Quick Replies and Chat Appearance currently persist per device in the mobile client; no backend sync is wired for those routes yet.
- Full end-to-end authenticated ad-credit verification is still pending for the same auth-gated reason, and code generation/redeem/billing depend on the backend changes from `/app/CONVEX_BACKEND_INSTRUCTIONS_AD_CREDIT_CODES.md`.
- Full end-to-end authenticated search/starred verification is still pending because browser automation cannot complete the Hercules sign-in flow here, so in-app button navigation from Chats/Profile still needs one signed-in device pass.
- Full end-to-end authenticated wallet/send-money verification is still pending because browser automation cannot complete the Hercules sign-in flow here, and the exact mutation arg shapes for some `wallet.ts` / `transfers.ts` actions still need validation against the live backend.
- The latest real-data regression checks for the user-reported contact/call issues are still partially pending because automation could not authenticate into a live account with real contacts; manual signed-in validation is still needed for: the specific `Asare Ben Chris` crash case, saved contact-name parity in live chats/calls, and hearing the preferred ringtone during a real native outgoing call.
- The newest chat-polish items still need signed-in native-device validation for the real keyboard/composer-on-typing behavior, actual voice-note capture/send, and audible message/incoming-call sounds under real notification conditions.
- The biggest remaining gap is true killed-state incoming-call/message delivery. The app-side notification channels and permissions are now in place, but the external Convex backend must also be sending Expo mobile pushes to the registered native token (not only web/Chrome push) for ringing/notifications to work when the native app is killed.
- The current Android production build log still ends with a pure remote infrastructure failure in the EAS worker: Gradle wrapper download returns HTTP 502 while fetching `gradle-8.14.3-bin.zip`. That final blocker is outside app code; repo-side fixes now target the earlier package/env issues so any remaining failure is isolated to the remote Gradle download step.

## Files
- `/app/frontend/app/_layout.tsx` — Root with AuthProvider + ConvexProvider
- `/app/frontend/app/index.tsx` — Redesigned sign-in screen
- `/app/frontend/app/+not-found.tsx` — OIDC deep-link catch-all + token exchange fallback
- `/app/frontend/app/auth-webview.tsx` — Live Smilers web sign-in bridge screen for native auth handoff
- `/app/frontend/app/{emergency,ai-chat,blocked,notifications,earnings}.tsx` — Fully wired Phase 1 utility screens
- `/app/frontend/app/{privacy,app-lock,face-id,chat-appearance,templates,scheduled,chat-once}.tsx` — Phase 1 polished placeholders
- `/app/frontend/src/components/ComingSoon.tsx` — Shared placeholder screen component
- `/app/frontend/src/hooks/useSafeConvexQuery.ts` — Safe query helper for optional Convex endpoints
- `/app/frontend/app/chat/[conversationId].tsx` — Phase 2A.1 message actions and safe fallback handling
- `/app/auth_testing.md` and `/app/auth-testing.md` — Auth testing notes for manual/automation handoff
- `/app/frontend/src/lib/uploadFile.ts` — Convex file upload helper
- `/app/frontend/src/components/{AttachmentSheet,MediaBubble}.tsx` — Attachment picker and media-aware message bubble renderer
- `/app/frontend/src/components/PollComposer.tsx` — Poll creation bottom sheet
- `/app/frontend/app/status-compose.tsx` — Text status composer
- `/app/frontend/app/status-view/[userId].tsx` — Full-screen story viewer
- `/app/frontend/app/(tabs)/updates.tsx` — Status tab UI and media status creation sheet
- `/app/frontend/app/(tabs)/contacts.tsx` — Contacts tab with add sheet, reject/cancel flows, and relationship pills
- `/app/frontend/app/contact-qr.tsx` — Contact QR show/scan modal route
- `/app/frontend/app/(tabs)/ads.tsx` — Ads Browse/My Ads home
- `/app/frontend/app/ads/{create,review}.tsx` — Ad creation and admin review flows
- `/app/frontend/app/search.tsx` — Global search screen for chats and people
- `/app/frontend/app/starred.tsx` — Starred messages screen
- `/app/frontend/app/user/[userId].tsx` — Basic user profile route for search results
- `/app/frontend/app/wallet.tsx` — Gold Wallet screen with payout methods and withdrawal requests
- `/app/frontend/app/send-money.tsx` — Send/request money screen with pending requests and history
- `/app/frontend/src/lib/adCreditCodes.ts` — Ad credit code formatting/estimate helpers
- `/app/frontend/src/lib/{settingsStorage,chatAppearance}.ts` — Local settings persistence and chat appearance helpers
- `/app/frontend/src/{constants/countries.ts,components/CountrySelectorModal.tsx,hooks/useDebouncedValue.ts}` — Ads filtering/support utilities
- `/app/frontend/app/(tabs)/_layout.tsx` — Tab bar
- `/app/frontend/app/(tabs)/{chats,contacts,groups,updates,profile}.tsx`
- `/app/frontend/app/chat/[conversationId].tsx` — Chat detail
- `/app/frontend/app/settings.tsx` — Settings list
- `/app/frontend/src/providers/AuthProvider.tsx` — Hercules OIDC + token mgmt
- `/app/frontend/src/providers/ConvexClientProvider.tsx` — Convex client + auth glue
- `/app/frontend/src/components/{Header,Avatar,FabStack,SosButton}.tsx`
- `/app/frontend/src/theme.ts` — Design tokens
- `/app/frontend/src/convexApi.ts` — Untyped api references via `anyApi`
- `/app/CONVEX_BACKEND_INSTRUCTIONS_POLLS_FILES.md` — Required backend support for poll voting and file messages
- `/app/CONVEX_BACKEND_INSTRUCTIONS_STATUS_STORIES.md` — Required backend support for status/story composer, viewer, and story replies
- `/app/CONVEX_BACKEND_INSTRUCTIONS_CONTACTS_POLISH.md` — Required backend support for outgoing requests, reject/cancel, phone invites, and QR contacts
- `/app/CONVEX_BACKEND_INSTRUCTIONS_AD_CREDIT_CODES.md` — Required backend support for Ad Credit Codes, redeem flow, and per-click billing deductions
- `/app/HERCULES_MOBILE_SIGNIN_BRIDGE.md` — Exact web/Hercules-side instructions to redirect successful web sign-in back into the native app

## Session: Feb 2026 — Chat Refactor Phase 2 + Swipe-to-Reply
- **Swipe-to-Reply (NEW)**: WhatsApp-style swipe-right gesture on any message bubble opens the reply composer with haptic feedback. Implemented in `/app/frontend/src/components/chat/SwipeToReply.tsx` (react-native-gesture-handler Pan + reanimated v4). Native-only (disabled on web); disabled in multi-select mode, for suspended viewers, and on deleted messages. NEEDS DEVICE VERIFICATION (gesture is native-only).
- **Chat Screen Refactor Phase 2 (DONE)**: Extracted 5 more components from `chat/[conversationId].tsx` (3,882 → 3,411 lines):
  - `MessageActionSheet.tsx` — long-press sheet w/ quick reactions + action rows (owns QUICK_REACTIONS)
  - `DeleteMessageSheet.tsx` — tri-state delete sheet
  - `DisappearingSheet.tsx` — duration picker (owns canonical DISAPPEARING_OPTIONS, re-imported by chat screen)
  - `ForwardPickerSheet.tsx` — forward-to picker incl. pinned Diary tile (diary save logic stays in parent via onSaveToDiary)
  - `TemplatePickerSheet.tsx` — Quick Replies picker
- All testIDs preserved exactly. Removed ~470 lines of dead styles/JSX from the chat screen. ESLint + tsc clean; web bundle renders (smoke-tested).
- User confirmed fixed this session: small-phone tab spacing, Trustees contact list.

## Session: Feb 2026 — Desktop Login Approval (native side, iter-186)
Built per web team's DESKTOP_LOGIN_APPROVAL_NATIVE_CONTRACT.md (pasted in chat):
- `/app/frontend/app/approve-login.tsx` — approval screen: pending list (live `api.loginApprovals.listPendingForMe` subscription), per-request detail w/ 2-min countdown, Approve gated by device biometrics/PIN (expo-local-authentication, blocks if no screen lock), Deny without gate, in-app QR scanner (parses `?code=` URL or raw 8-char hex), success/error states mapped to contract error codes (BAD_REQUEST=expired, CONFLICT=handled, FORBIDDEN, NOT_FOUND, UNAUTHENTICATED).
- `/app/frontend/src/components/LoginApprovalBanner.tsx` — amber banner atop Chats tab when pending approvals exist (contract §5.5), live-updating.
- Push: `login-approvals-v1` channel (MAX importance heads-up) in notificationChannels.ts; `login-approval` notification category with Approve (opens app → biometric) / Deny (background mutation) action buttons; response handler + foreground receive listener route to /approve-login with code (usePushNotifications.ts).
- Settings row "Approve Desktop Login" (after Face ID).
- ⚠️ FOLLOW-UP FOR WEB AGENT: push must include `categoryId: "login-approval"` for the Approve/Deny buttons to render on the notification (tap-to-open works without it).
- Verified: eslint + tsc clean, web bundle renders. Device verification needed (push, biometrics, QR scan are native-only).

## Session: Feb 2026 — Screen Share fixes (iter-188)
User-reported bugs (with debug overlay screenshot):
1. **Screen share never connected ("from day one")** — ROOT CAUSE: `startPeerConnection skipped (ctor=false)`. The screen-only bootstrap in `app/call/[conversationId].tsx` claimed `initStartedRef` and called startPeerConnection immediately on mount, but on Android the WebRTC module (`CallSessionCtor`) is require()d ~350ms later (screenReady timer). The bail path never released the slot and nothing retried → no PC → no MediaProjection picker. FIXES: (a) bail path now releases `initStartedRef` when ctor/callId missing (keeps it for live-session idempotency), (b) screen-only Effect B + caller/callee kick-off effects now gate on `CallSessionCtor` and include it in deps so they re-fire when the module loads.
2. **Google-account names instead of device contact names** — Share Screen picker (`app/screen-share.tsx`) and incoming request modal (`IncomingScreenShareModal.tsx`) now resolve names via `resolveDeviceContactNameFromUser(useDeviceContactIndex())`, same as Chats list.
- Verified: eslint 0 errors, tsc no new errors (6 pre-existing in call screen), web bundle renders. NEEDS DEVICE VERIFICATION (WebRTC/MediaProjection native-only): expect the share-app/entire-screen picker to appear again after EAS build.

## Session: Feb 2026 — Screen Share signaling queue (iter-189)
After iter-188 fix, user's debug overlay showed the NEXT failure layer: `screenSharing.sendSignal` Server-Errors (offer + ICE dead after 3 fast retries in ~2s). Cause: sharer enters /call immediately after `requestScreenShare`, BEFORE recipient accepts — backend rejects signals for not-yet-active sessions. FIXES in `app/call/[conversationId].tsx`:
- Ordered screen-signal queue (`screenSignalQueueRef`) + `flushScreenSignalQueue`: retries head-of-queue every 2.5s for up to 2 min, preserving offer-before-ICE order; flushes everything the moment the recipient accepts. Full backend error text (300 chars) logged on give-up.
- `peerConnected` state from onConnectionStateChange → ScreenShareOverlay sharer copy now says "Waiting for the recipient to accept…" until WebRTC is actually connected.
- Queue cleared on unmount. eslint 0 errors, tsc no new errors. NEEDS DEVICE VERIFICATION (2 phones: request → accept → picker → stream).
- NOTE: frontend zip download endpoint `/api/download/frontend-zip` (added this session) — zip REGENERATED after this fix.

## Session: Feb 2026 — Share Sheet "contacts do not appear" fix (iter-190)
User screenshot: Share-to-Smilers picker showed "No matches" (no Diary row either) despite a full address book. ROOT CAUSE: `app/share-receiver.tsx` had no offline/cold-start resilience — its useSafeConvexQuery calls silently settle to [] when the Convex websocket is down (roaming/flaky network) or the auth handshake races; the Chats tab masks the same condition via its iter-160 AsyncStorage cache. FIXES:
- share-receiver now hydrates from the SAME offline cache (readCacheMeta 'conversations'/userKey) + a new 'contacts' scope, with write-through when live data arrives. Live data wins when non-empty.
- Loading-aware empty state: spinner + "Loading your chats and contacts…" while queries resolve; honest "couldn't load — check connection" copy otherwise (search-specific copy when filtering).
- eslint 0 errors, tsc 0 errors for the file. Zip at /api/download/frontend-zip REGENERATED (includes iter-188/189/190).

## Session: Feb 2026 — Share sheet REAL root cause: OIDC discovery race (iter-191)
iter-190 cache fix didn't help (user confirmed with new build). TRUE ROOT CAUSE found in AuthProvider.tsx:
- On share-sheet cold start, the stored id_token is expired. Convex requests a token within ~100ms, but `refreshTokens()` returned null whenever `useAutoDiscovery` hadn't loaded the OIDC discovery doc yet (network race lost every time). `getFreshIdToken` then handed Convex the EXPIRED token → Convex ran silently UNAUTHENTICATED for the session → getCurrentUser=null, getContacts=[], listConversations=[] (valid empty results, no errors). Chats tab masked it via cache; share-receiver showed "No matches". iter-190's cache fallback ALSO missed because with getCurrentUser=null the cache key fell back to 'anon' while data was cached under the real user id.
FIXES:
1. AuthProvider: OIDC discovery document persisted to storage (`smilers_oidc_discovery`); refreshTokens falls back to it — refresh works instantly on every launch after the first.
2. getFreshIdToken: waits up to 5s for discovery (live or cached) before attempting refresh, and calls refreshTokens via a ref (stale-closure fix: old closure captured discovery=null).
3. Cache-key fix: `me` persisted under fixed key ('me','self') by chats tab + share-receiver; share-receiver resolves user id from this cache when Convex is unauthenticated, so conversation/contact caches hit correctly.
- eslint 0 errors, no new tsc errors. Zip REGENERATED. User raised billing complaint → support_agent response delivered verbatim (support@emergent.sh with job ID).

## Session: Feb 2026 — Connection status pill on share screen (iter-192)
- New `/app/frontend/src/components/ConnectionStatusPill.tsx`: 🟢 Connected (socket + Convex auth), 🟡 Signing in… (socket up / auth handshake), ⚪ Offline — showing saved contacts. Uses `useConvexAuth` + `useConvexConnectionState` (convex ^1.37). Mounted under the header in share-receiver.tsx.
- eslint/tsc clean. Zip regenerated.

## Session: Feb 2026 — User device-test feedback round (iter-193)
CONFIRMED WORKING by user: desktop login approval ✓, swipe-to-reply ✓, share picker contacts ✓ (iter-191 auth fix verified), earpiece/speaker call audio ✓, MediaProjection picker now appears ✓ (iter-188 verified).
FIXES THIS ROUND:
1. APK sharing blocked → root cause was MAX_UPLOAD_BYTES.document=20MB (Smilers APK is 60+MB); raised to 100MB in dataFriendlyDefaults.ts. Scanner already allowed .apk.
2. Bluetooth call audio → BLUETOOTH_CONNECT runtime permission (Android 12+) was never requested in the call flow; setBluetoothOn() now requests it before SCO routing + extra route re-issue at 1.2s for slow headsets (inCallManager.ts).
3. Killed-app ringing (beep+short vibration) → TWO causes: (a) backend _resolve_android_channel only scanned the TITLE for "incoming call" but Convex sends WhatsApp-style pushes (title=caller name, body="Incoming voice call") → routed to messages channel; now scans title+message+subtext (kept (incoming|missed) guard to avoid false positives from chat texts like "let's video call"). (b) DEPLOYED backend (app-migration-75.emergent.host) is an OLD version without iter-182 per-token channel storage → USER MUST REDEPLOY the backend via Emergent Deploy. 30/30 pytest pass (2 new regression tests).
4. Screen share signaling: backend `screenSharing.sendSignal` Server-Errors EVEN AFTER acceptance → Convex backend bug; wrote /app/WEB_AGENT_SCREEN_SHARE_SENDSIGNAL_FIX.md for the user to hand to the web agent (likely wrong table id in ctx.db.get, status guard throw, or 'ice-candidate' literal mismatch).
Zip regenerated (24MB).

## Session: Feb 2026 — Bluetooth auto-switch (iter-194)
- New `addAudioDeviceChangedListener` in inCallManager.ts (Android `onAudioDeviceChanged` event from react-native-incall-manager; parses JSON availableAudioDeviceList; no-op on iOS).
- Call screen: auto-switches route to Bluetooth when a headset connects mid-call; falls back to earpiece (voice) / speaker (video) on disconnect. Works with the iter-193 BLUETOOTH_CONNECT permission request.
- Clarified to user: killed-app ringing fix requires BACKEND REDEPLOY via Emergent Deploy button (no zip/download involved — zip is frontend-only for EAS).
- eslint 0 errors, tsc baseline unchanged. Zip regenerated.

## Session: Feb 2026 — APK share crash fix (iter-195)
User: sharing a photo to Smilers works, but sharing a 185MB APK crashes the app on Send ("Smilers has stopped"). ROOT CAUSE: uploadFile did `fetch(uri) → blob() → POST`, loading the ENTIRE file into RAM → OOM kill on large files; plus the share path never ran a size check. FIXES:
1. uploadFile.ts: native uploads now STREAM from disk via `expo-file-system/legacy` `uploadAsync` (BINARY_CONTENT) — constant memory regardless of file size; blob path kept for web.
2. MAX_UPLOAD_BYTES.document raised 100MB → 250MB (user's APKs are ~185MB; safe now that uploads stream).
3. sendSharedPayload.ts: new `checkShareFileSize` (resolves size via fileSize or getInfoAsync) gates BEFORE upload in both the conversation and diary share branches — clear "too large (X MB — max Y MB)" outcome instead of crash/doomed upload.
- eslint + tsc clean. Zip REGENERATED (must rebuild via EAS to get the fix — crash was native-memory, requires new build).

## Session: Feb 2026 — PUSH NOTIFICATIONS ROOT CAUSE FOUND + FIXED (iter-197)
User reported pushes NEVER work (no banners when app open/backgrounded; total silence when killed; previous "fixes" were never device-verified). FULL-PIPELINE AUDIT findings (hard evidence):
1. DEPLOYED backend (app-migration-75.emergent.host): ALL 17 stored FCM tokens DEAD (UnregisteredError) — stale tokens from old builds; every push attempted there dies. Also runs pre-iter-182 code.
2. PREVIEW backend: live tokens (current build registers here, EXPO_PUBLIC_BACKEND_URL=preview) and FCM v1 send DELIVERED to BOTH user phones in live tests (call-style → 01KQVQFG… SM-A075F ✓, message-style → 01KQD0V5… ✓). Delivery infra (smilers-a4e07 project, admin SDK, channels) is HEALTHY.
3. Convex triggers: every historical send-push-internal showed matched=0; no real triggers logged since Jun 7 → whether Convex still POSTs (and to which URL) is THE remaining unknown — needs user test call + trigger-log check.
4. Tap-routing bug: backend FCM data lacked type/conversationId/callId and the app never read action_url → taps did nothing.
FIXES (backend, hot-reloaded on preview; REDEPLOY needed for production):
- _derive_push_routing(): fcm data now carries type/conversationId/callId/displayName parsed from action_url.
- 45s TTL on incoming-call pushes (no ghost rings).
- Dead-token auto-pruning on UnregisteredError.
- send-push-internal returns REAL per-token FCM stats; full recipient ids logged; persistent push_trigger_log (capped 300) exposed via GET /api/push-debug?triggers=N.
FIXES (frontend, in regenerated zip):
- handleResponse action_url deeplink fallback (contract §3: /chat, /call, /user, /notifications, https).
- share-receiver.tsx missing useRef import (left by iter-196) + uploadFile.ts null/undefined tsc fix — upload progress + cancel UI now compiles clean.
- BRANDING: official Smilers logo pulled from smilers.online → icon.png (1024), adaptive-icon.png (safe-zone composed), splash-image.png, favicon, NEW notification-icon.png (white bubble silhouette); app.json: notification icon + splash bg #FEF9F4; react template assets deleted.
TESTS: 36/36 pytest (new tests/test_push_routing.py), eslint 0 errors, tsc baseline clean for touched files. Zip REGENERATED (24MB).
DOC: /app/PUSH_PIPELINE_STATUS_iter197.md — Convex env checklist (MOBILE_BACKEND_URL must = preview URL for now; recipients = OIDC sub) + verification steps.
PENDING USER VERIFICATION: (1) test call+message between phones with receiver app killed → then check /api/push-debug?triggers=10 to confirm Convex triggers; (2) rebuild via EAS from new zip → verify Smilers icon, tap-routing, upload progress UI, Bluetooth auto-switch, large APK sharing.

## Session: Feb 2026 cont. (iter-198) — SENDER-SIDE PUSH TRIGGERS (Convex-independent)
User re-tested killed-app: still nothing → trigger log proved Convex NEVER POSTs send-push-internal for real messages/calls. Decision: make pushes independent of Convex triggers.
BACKEND (preview, live):
- POST /api/notify-event — client-fired push trigger (recipients = Convex user ids, event message|call|missed-call, validation caps, builds action_url, reuses send_push channels/TTL/routing).
- push_tokens now store convex_user_id (sent at registration); send_push matches $or(user_id, convex_user_id).
- Cross-trigger dedupe: _is_duplicate_push (idempotency_key 10min + content sha1 60s window, push_dedupe collection) applied to BOTH notify-event and send-push-internal → exactly one notification if Convex triggers ever return.
- send-push-internal logs full recipient ids (requested_ids/unmatched_ids).
LIVE E2E VERIFIED 18:02 UTC: message push delivered (1/1), duplicate suppressed, call push delivered (1/1, rings calls channel). 41/41 pytest (new dedupe/hash tests; pytest.ini loop scope session fix; uuid-unique test payloads).
FRONTEND (in zip, NEEDS REBUILD):
- src/lib/notifyPush.ts (fire-and-forget notifyEventPush + previewForMessageType).
- chat/[conversationId].tsx: sendMessage wrapped → fires message push to all other participants (Convex ids via pushNotifyCtxRef populated from hydratedConversation; works for groups). Preview: text or 📷/🎥/🎤/📎.
- call/[conversationId].tsx: after initiateCall success → fires call push (callerName, voice/video, callId as idempotency key).
- useEmergentPush: registers convex_user_id (api.users.getCurrentUser), throttle busts when convex id appears.
- scheduled.tsx: hides past one-time schedules (matches web; fixes duplicate stale Jun-11/12 entries complaint). NOTE: 'Unknown' recipient label is server-side data (web agent's listMine should return display names).
- contacts.tsx: referral code auto-create fallback (getOrCreateReferralCode) so invite links ALWAYS carry the referral code (user's invite went out without code because profile had none).
ZIP regenerated 18:05 (24MB) with all of the above + Smilers branding.
REMAINING after user rebuild: verify killed-app ring/messages e2e; production migration (redeploy backend + Convex MOBILE_BACKEND_URL + bake deployed URL — all three together); foreground suppression of banners for the actively-open chat (polish).

## Session: Feb 2026 cont. (iter-199) — PUSH SYSTEM CAME ALIVE AT 21:24; remaining items are Convex-side
Evidence from DEPLOYED backend trigger log (user redeployed backend tonight via Emergent build/deploy):
- Convex DOES trigger call pushes → POSTs send-push-internal to the DEPLOYED URL (recipients = OIDC subs, correct). At 21:24:11 a real "Incoming voice call" push was DELIVERED to phone 2 (matched + fcm_success=1) — ~10 min AFTER the user stopped testing (screenshots 21:09-21:12). Before 21:24 production had only dead tokens.
- The installed Emergent android build CONTAINS iter-198 (client trigger fired at 21:24:11.296 with Convex-id recipient; scheduled filter visible in screenshot). Build bakes the DEPLOYED backend URL.
- Self-test pushes via deployed backend delivered to BOTH phones.
- convex_user_id matching not confirmed yet (probe token_count=0; may be 3rd account or registration timing) — has_convex_id now exposed in push-debug tokens (next redeploy).
iter-199 changes (preview; USER MUST REDEPLOY BACKEND to ship): _recent_call_push_to_user() — semantic per-recipient 25s call-push dedupe collapsing Convex-trigger + caller-device doubles (different keys/urls so generic dedupe can't catch); push-debug tokens now show has_convex_id. 41/41 pytest. Live test confirmed pruning of dead preview tokens.
NEW DOC: /app/WEB_AGENT_REQUESTS_iter199.md — canonical-contract questions for web agent: (1) screenSharing.sendSignal offer rejection (P0), (2) users.updateProfile language fields Server Error (P0 — mobile tried skipTranslationLanguages/languages/spokenLanguages), (3) scheduledMessages.listMine recipient 'Unknown', (4) earnings.getOrCreateReferralCode existence (invite shared without code).
USER ACTIONS: (1) redeploy backend (no app rebuild needed), (2) RE-TEST pushes NOW with current build (killed app), (3) relay WEB_AGENT_REQUESTS_iter199.md to web agent.

## Session: Feb 2026 cont. (iter-200) — Canonical contracts wired + production-URL build zip
Web agent provided canonical answers (user relayed): screenSharing.sendSignal FIXED server-side (accepts offer/ice any casing — mobile just re-tests); languages = users.updateProfile({preferredLanguage, selectedLanguages}); scheduled names = scheduling.getAllMyScheduledMessages → conversationName; referral = earnings.getOrCreateReferralCode (lazy, idempotent).
Evidence from user's 22:27 re-test (deployed trigger log): Convex call trigger fired + FCM SUCCESS yet phone showed NOTHING → device-display layer issue (likely channel mismatch) + both fresh deployed tokens have has_convex_id=false (registration not carrying convex id).
MOBILE FIXES (in zip, need EAS CLI build):
- languages.tsx: single canonical updateProfile({selectedLanguages}) — removed dead fallback mutations.
- scheduled.tsx: useSafeConvexQuery(scheduling.getAllMyScheduledMessages) → conversationNameById map → displayRecipient() (fixes 'Unknown').
- contacts.tsx: unconditional getOrCreateReferralCode on mount (was gated on profile query resolving).
- notificationChannels.ts: creates ALL backend-target fallback channels (calls-v4-smilers_never_cry, legacy 'calls', messages-v4-message_notification, legacy 'messages-v3') — Android drops pushes aimed at non-existent channels.
- useEmergentPush.ts: reportConvexUserIdForPush() exported setter + effectiveConvexUserId (query OR reported); chat screen reports me._id → guarantees convex_user_id reaches backend.
BACKEND (preview; next redeploy ships): push-debug tokens now include call_channel_id/message_channel_id.
ZIP regenerated 22:45 WITH EXPO_PUBLIC_BACKEND_URL=https://app-migration-75.emergent.host (production) — CRITICAL: EAS build must target deployed backend because Convex posts there. Workspace .env stays preview for dev.
TESTS: 41/41 pytest; tsc/eslint clean on touched files.
ARCHITECTURE NOTE: production topology = APK (deployed URL) + Convex→deployed + deployed FastAPI w/ FCM. Preview pod = dev only.
NEXT: user EAS CLI build from zip → install both phones → test killed-app ring/messages, screen share (server fixed), languages save, scheduled names, referral in invite. If FCM success but still nothing visible: check Samsung Settings→Apps→Smilers→Notifications categories.


---

## iter-212 — Pre-Play-Store P0 bug fixes (4 surgical, no scope creep)

Fixed in this fork per user's explicit priority list:

1. **Chat photo "no send button"** (P0) — gallery picks no longer auto-send.
   They now stage into a preview bar above the composer (thumbnail + remove X +
   "Add a caption, then tap send"); the **Send** button appears even with empty
   text and drives the upload (caption = composer text). On failure the staged
   image is restored for retry. Camera capture keeps its own in-modal preview/send.
   Files: `app/chat/[conversationId].tsx` (`pendingImage` state, `pickPhoto`,
   `handleSend`, `sendImageFromUri` now returns boolean, composer preview UI).

2. **Twilio call doesn't end on the other side** — added backend
   `POST /api/twilio/end-call` → completes the room
   (`rest.video.v1.rooms(sid).update(status="completed")`), resolving unique_name
   → sid, idempotent on already-completed/404. Wired into `handleHangup`
   (twilio-call.tsx) AND the push **decline** branch (usePushNotifications.ts) so
   both "caller hangs up" and "callee declines" force-end the room.
   Curl-verified: 400 w/o room, 200 idempotent for nonexistent room.

3. **Image download "Couldn't open file"** — root cause: E2EE chats serve
   AES-GCM CIPHERTEXT at the storage URL; the download helper re-fetched that and
   saved unreadable bytes. Fix: `saveMessageMediaToGallery` now accepts a
   `localUri` (the renderer's already-decrypted `data:`/`file://` src) and saves
   THAT (data: → decoded to cache file). ImageViewer passes its decrypted `uri`.
   Files: `src/lib/messageMedia.ts`, `src/components/MediaBubble.tsx`.

4. **My Recordings missing download/delete** — added Download (video → gallery
   via MediaLibrary; audio → share sheet) + Delete (confirm dialog) icons per row.
   Delete probes likely Convex mutation names (see
   `WEB_AGENT_REQUESTS_iter212_recordings_delete.md`) with graceful fallback.
   File: `app/my-recordings.tsx`.

**Verification status:** #2 backend curl-verified. #1/#3/#4 compile clean
(babel-transform OK) but need a **native build + authenticated device** for full
2-phone / E2EE / gallery verification (OIDC Google login blocks automated e2e).
Deferred (per user): ringtone-as-message-tone + missing `[FCM]` diagnostic events
on receiver (needs separate investigation); screen-share remote tile + screen
wake (freelance native engineer).


---

## iter-213 — Recording delete pinned + Archived Chats sync (native ↔ web)

**Recording delete** pinned to the confirmed canonical mutation
`api.callRecording.deleteRecording({ recordingId })` (fallback probing removed) —
`app/my-recordings.tsx`.

**Archived Chats sync** against the shared Convex backend (`api.archives.*`,
confirmed by web team):
- Read: `archives.getArchivedIds({})` (id set, used to filter main list) +
  `archives.listArchived({})` (full rows for the Archived screen).
- Write: `archives.archiveConversation({ conversationId })` /
  `archives.unarchiveConversation({ conversationId })` — both void + idempotent.
- `app/(tabs)/chats.tsx`: filter archived out of the main list (listConversations
  does NOT exclude them — matches web client-side filtering); **swipe-left**
  reveals an Archive button (react-native-gesture-handler `Swipeable`); an
  **"Archived · N chats"** pinned row sits directly below Chat Once and is shown
  ONLY when count > 0 (matches web).
- `app/archived.tsx`: now uses the real `archives.listArchived`, adds a per-row
  **Unarchive** button (`archive-arrow-up-outline`), updated empty-state copy.
- Per-user scope; no auto-unarchive on new message (matches web). State syncs
  reactively across web/mobile via Convex.

Verified: all changed files babel-transform clean; app bundles + renders Sign In
(smoke). Authenticated archive flow needs a real device (OIDC Google blocks
automated e2e). Contract Q&A: `WEB_AGENT_REQUESTS_iter213_archived_chats_sync.md`.
