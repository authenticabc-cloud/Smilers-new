# Smilers — running changelog (app-logic / UI changes)

Newest first. All changes are captured in `smilers-app-logic-changes.patch`
(baseline commit 21cc30a3) and summarised for the native dev in
`MERGE_FOR_ASHWINI.md`.

## 2026-07-07
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
