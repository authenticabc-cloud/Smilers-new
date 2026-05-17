# Smilers Mobile App — PRD

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
