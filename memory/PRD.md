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
- ✅ Tabs layout now uses web-safe auth redirects, and Expo push-notification calls are guarded on web so `/chats` no longer red-screens in preview
- ✅ Phase 2A.1 chat actions added: long-press action sheet, quick reactions, reply preview, quoted replies, copy, forward, star/unstar, delete placeholder, and haptic feedback
- ✅ Chat route is now hardened for invalid/unauthorized conversation IDs with a safe fallback state instead of a Convex error screen
- ✅ Phase 2A.2a media groundwork added: attachment sheet, image upload helper, gallery/camera send flow, image bubble rendering, upload progress bar, and full-screen image viewer
- ✅ Phase 2A.2b voice notes patched in: record/send flow in chat composer plus playback UI in media bubbles
- ✅ Ads module MVP added: Ads tab wiring, Browse/My Ads view, Create Ad form, Admin Review screen, country selector modal, and standard 195-country list filtering
- ✅ Fixed React 19 TypeScript incompatibility from `react-native-country-codes-picker` so the preview/build loads cleanly again
- ✅ Fixed invalid chat-route update loop by stabilizing query fallback handling and chat fallbacks; `/chat/test-conversation` now renders the unavailable state without `Maximum update depth exceeded`
- ✅ Added `/app/auth_testing.md` and `/app/auth-testing.md` to document current manual auth verification expectations for future testing runs
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
- Full end-to-end authenticated voice-note verification is still pending because browser automation cannot deterministically complete the third-party Google/Hercules sign-in flow with the current test setup.

## Files
- `/app/frontend/app/_layout.tsx` — Root with AuthProvider + ConvexProvider
- `/app/frontend/app/index.tsx` — Sign-in screen + v2.0.12 build badge
- `/app/frontend/app/+not-found.tsx` — OIDC deep-link catch-all + token exchange fallback
- `/app/frontend/app/{emergency,ai-chat,blocked,notifications,earnings}.tsx` — Fully wired Phase 1 utility screens
- `/app/frontend/app/{privacy,app-lock,face-id,chat-appearance,templates,scheduled,chat-once}.tsx` — Phase 1 polished placeholders
- `/app/frontend/src/components/ComingSoon.tsx` — Shared placeholder screen component
- `/app/frontend/src/hooks/useSafeConvexQuery.ts` — Safe query helper for optional Convex endpoints
- `/app/frontend/app/chat/[conversationId].tsx` — Phase 2A.1 message actions and safe fallback handling
- `/app/auth_testing.md` and `/app/auth-testing.md` — Auth testing notes for manual/automation handoff
- `/app/frontend/src/lib/uploadFile.ts` — Convex file upload helper
- `/app/frontend/src/components/{AttachmentSheet,MediaBubble}.tsx` — Attachment picker and media-aware message bubble renderer
- `/app/frontend/app/(tabs)/ads.tsx` — Ads Browse/My Ads home
- `/app/frontend/app/ads/{create,review}.tsx` — Ad creation and admin review flows
- `/app/frontend/src/{constants/countries.ts,components/CountrySelectorModal.tsx,hooks/useDebouncedValue.ts}` — Ads filtering/support utilities
- `/app/frontend/app/(tabs)/_layout.tsx` — Tab bar
- `/app/frontend/app/(tabs)/{chats,contacts,groups,status,profile}.tsx`
- `/app/frontend/app/chat/[conversationId].tsx` — Chat detail
- `/app/frontend/app/settings.tsx` — Settings list
- `/app/frontend/src/providers/AuthProvider.tsx` — Hercules OIDC + token mgmt
- `/app/frontend/src/providers/ConvexClientProvider.tsx` — Convex client + auth glue
- `/app/frontend/src/components/{Header,Avatar,FabStack,SosButton}.tsx`
- `/app/frontend/src/theme.ts` — Design tokens
- `/app/frontend/src/convexApi.ts` — Untyped api references via `anyApi`
