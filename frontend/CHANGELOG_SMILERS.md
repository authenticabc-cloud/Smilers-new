# Smilers — running changelog (app-logic / UI changes)

Newest first. All changes are captured in `smilers-app-logic-changes.patch`
(baseline commit 21cc30a3) and summarised for the native dev in
`MERGE_FOR_ASHWINI.md`.

## 2026-07-08
- **In-app "Update available" banner:** on launch the app calls
  `GET /api/app-version` (FastAPI) and, if the bundled `expo.version` is older
  than the published `latestVersion`, shows a dismissible top banner linking to
  the Play Store (Android) / App Store (iOS). "Later" hides it for the session
  (returns next launch); a `forceUpdate`/below-`minSupportedVersion` release
  hides "Later". NEW files: `src/lib/appVersion.ts`,
  `src/components/UpdateBanner.tsx`; mounted in `app/_layout.tsx`. BACKEND: new
  `GET /api/app-version` endpoint in `backend/server.py` (env-overridable via
  `SMILERS_LATEST_VERSION` / `SMILERS_ANDROID_URL` / `SMILERS_IOS_URL` /
  `SMILERS_MIN_VERSION` / `SMILERS_FORCE_UPDATE` / `SMILERS_RELEASE_NOTES`).
- **Status "Seen by" polish:** viewer time no longer shows "NaN d ago"
  (`timeAgo` now coerces ISO-string / seconds-epoch timestamps, falling back to
  "just now"); viewer name resolution broadened (more backend aliases + saved
  contact / device name) so it only shows "User" when the viewer is truly
  unknown. File: `app/status-view/[userId].tsx`.
- **Status views not counting (FIXED):** the viewer screen's `markViewed` effect
  was keyed only on `[idx, isMine]`, so when the stories array finished loading
  AFTER the first render (async Convex fetch) the effect never re-ran and the
  first/only status was never marked viewed. Now also keyed on the current
  status id (per-id `viewedRef` guard still prevents echo re-fires). File:
  `app/status-view/[userId].tsx`.
- **Group message sender name fix:** in group chats a sender's name no longer
  falls back to the generic "Member" label. `resolveSenderName` now enriches the
  sender from `api.conversations.getGroupMembers` (real Smilers/Google account
  name + phone), with the viewer's device-contact name still taking priority.
  File: `app/chat/[conversationId].tsx`.
- **Call-waiting video fix (audio-only bug):** after "Hold current & Accept
  incoming", the accepted (secondary) call now correctly owns the full-screen
  video — remote feed, self-view, and the `showVideo` gate all route through the
  FOREGROUND call (primary vs. secondary) instead of the held primary. Fixes the
  "I can hear/speak but see no video" report. `useSecondaryCall` now also exposes
  `localStreamURL`. Native-only (RTCView). Files: `app/call/[conversationId].tsx`,
  `src/lib/call/useSecondaryCall.ts`. Handoff: `CALL_SELFVIEW_DRAG_FOR_ASHWINI.md`.
- **Self-view PiP: persist position + double-tap to swap:** the dragged PiP spot
  is now saved to AsyncStorage and restored on the next call; double-tapping the
  PiP swaps the local/remote feeds (local goes full-screen, remote shrinks into
  the PiP). Native-only. Files: `app/call/[conversationId].tsx`,
  `src/lib/call/selfViewPosition.ts`.

## 2026-07-07
- **Draggable video-call self-view:** the local camera preview (PiP) can now be
  dragged anywhere on screen during a video call and snaps to stay fully
  visible (session-only position). Native-only (RTCView). File:
  `app/call/[conversationId].tsx`. Handoff: `CALL_SELFVIEW_DRAG_FOR_ASHWINI.md`.
- **Chats list draft-bump ordering:** conversations with an unsent draft now
  float to the top of the Chats list (yields to Voice-Task pin order when
  that's enabled). File: `app/(tabs)/chats.tsx`.
- **Chats list "Draft:" indicator:** conversation rows now show a red
  "Draft:" preview (text, or "📷 Photo" for image-only drafts) when there's an
  unsent composer draft — WhatsApp-style. Refreshes when the list regains focus.
  Files: `src/lib/chatDrafts.ts` (loadAllChatDrafts), `app/(tabs)/chats.tsx`.
- **Resume where you left off (chat drafts):** the composer now saves per
  conversation — unsent text, staged photos/files (not yet sent), the message
  you're replying to, an in-progress edit, and text formatting. Leaving the
  chat (to another chat or out of the app) and returning restores it exactly.
  Draft clears automatically once the message is sent.
  Files: `src/lib/chatDrafts.ts`, `app/chat/[conversationId].tsx`.
- **Resume where you left off (cold start):** if the app is fully closed while
  you were in a chat, reopening the app lands you back in that conversation
  (on top of the Chats list). One-shot, only on the post-login landing, so it
  never hijacks incoming-call / share cold starts.
  Files: `src/lib/lastRoute.ts`, `src/components/ResumeLastRoute.tsx`,
  `app/_layout.tsx`, `app/chat/[conversationId].tsx`.
- **Premium "Redeem code" restored:** the "Have a code? Redeem here" button is
  always visible again (it had been hidden for accounts that already had
  Premium). File: `app/premium.tsx`.

## 2026-07-06
- **Ad-Clicks Mobile Money:** buy ad clicks (€0.04/click) via manual Mobile
  Money — "Pay with Mobile Money" in the Buy Clicks modal → `/ad-clicks-payment`;
  admin review in the unified Payments tab; "Mobile Money top-ups" status card
  on My Ads.
- **FAQ/support refresh:** new "Premium & payments" FAQ category (Mobile Money
  for Premium + ads) + recent-feature FAQs; fixed Help support email to
  support.smilers@gmail.com.
- **Diagnostics hidden:** removed the "Diagnostic Logs" & "Call Diagnostics"
  rows from Settings for the Play Store launch (screens/routes kept, unlinked).
- **Smilers AI:** knowledge update prepared for the Hercules team in
  `SMILERS_AI_KNOWLEDGE_FOR_HERCULES.md` (the AI runs on their backend).
