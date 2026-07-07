# Smilers — changes to merge into Ashwini's native build (2026-07-08, rev 5)

These are the fixes made in the Emergent codebase that the current APK is missing.
Split into two groups so you do NOT accidentally overwrite your newer native
call/notification work.

Baseline for all diffs: commit 21cc30a3 (2026-07-03 23:11 UTC).

> rev 2 (2026-07-06): added the Ad-Clicks Mobile Money flow and wired its
> entry point into the Ads "Buy clicks" modal. `MobileMoneyAdmin.tsx` was
> REMOVED (superseded — see below).
> rev 3 (2026-07-06): FAQ/support updates, "Mobile Money top-ups" card on My
> Ads, corrected support email, and HID the two diagnostic rows in Settings
> for the Play Store launch.
> rev 4 (2026-07-07): "Resume where you left off" — per-conversation composer
> drafts + reopen-last-chat on cold start; restored the always-visible Premium
> "Redeem code" button. Re-generate/re-apply the patch.
> rev 5 (2026-07-08): **Group A** — group message sender name no longer shows
> "Member" (enriched from `getGroupMembers`), in `app/chat/[conversationId].tsx`.
> Re-generated `smilers-app-logic-changes.patch`. **Group B (call layer)** — 3
> new call-screen changes documented in `CALL_SELFVIEW_DRAG_FOR_ASHWINI.md`:
> (A) call-waiting foreground video routing fix (audio-only bug), (B) persist
> self-view PiP position, (C) double-tap PiP to swap feeds. Touches
> `app/call/[conversationId].tsx` + new `src/lib/call/selfViewPosition.ts` +
> `src/lib/call/useSecondaryCall.ts` (now returns `localStreamURL`).

---

## GROUP A — App-logic fixes (SAFE to take as-is)
These do NOT touch the call/notification/WebRTC layer. Apply the patch
`smilers-app-logic-changes.patch` (git apply), or copy these files verbatim.

NEW files:
- src/components/chat/EditPermissionModals.tsx
- src/lib/friendlyError.ts
- src/lib/mobileMoney.ts                       (now also exports AD_CLICK_PRICE_EUR + estimateAdClicksAmount)
- app/mobile-money.tsx                         (Premium mobile-money request screen)
- app/ad-clicks-payment.tsx                    (NEW rev2 — Ad-clicks mobile-money request screen, €0.04/click)
- src/components/admin/PaymentRequestsPanel.tsx (NEW rev2 — generic admin panel: premium OR ad-clicks)
- src/components/admin/PaymentsAdmin.tsx        (NEW rev2 — admin "Payments" tab, Premium/Ad-Clicks segments)
- src/lib/chatDrafts.ts                         (NEW rev4 — per-conversation composer draft save/load/clear)
- src/lib/lastRoute.ts                          (NEW rev4 — remember last chat for cold-start resume)
- src/components/ResumeLastRoute.tsx            (NEW rev4 — one-shot reopen-last-chat; mounted in app/_layout.tsx)

REMOVED files:
- src/components/admin/MobileMoneyAdmin.tsx    (⚠️ rev2 — DELETE this if you took rev1. It is superseded by
  PaymentsAdmin + PaymentRequestsPanel and is no longer imported anywhere.)

MODIFIED files:
- app/chat/[conversationId].tsx      (group post edit approval Phase 2; group pinned-post banner + admin gate; group sender-name display; + CRASH FIX: added `Modal, Pressable` to the react-native import)
- src/components/chat/MessageActionSheet.tsx  (Suggest edit / Pin-Unpin / edit-mode rows)
- src/components/chat/MessageBubble.tsx
- src/components/MediaBubble.tsx      (senderDisplayName prop → group sender name header)
- app/user/[userId].tsx              (Groups-in-common now uses api.conversations.listGroups; friendly errors)
- src/components/user-profile/GroupInCommonRow.tsx  (robust member id/phone matching, nested shapes)
- app/(tabs)/contacts.tsx            (friendly error on open-chat)
- app/(tabs)/ads.tsx                 (rev2 — "Pay with Mobile Money" button in the Buy Clicks modal → /ad-clicks-payment; + a "Mobile Money top-ups" status card on the My Ads tab reading api.adClickRequests.getMyRequests)
- app/(tabs)/chats.tsx               (rev4 — "Draft:" preview on chat rows for conversations with an unsent composer draft; refreshed on focus via loadAllChatDrafts)
- app/find-by-phone.tsx              (friendly error on start-chat)
- app/diagnostic-logs.tsx            (group-detection diagnostics: listGroups authoritative)
- src/lib/referralAttribution.ts     (referral once-per-user lock)
- app/index.tsx                      (Sign-in: hide referral entry once redeemed)
- app/premium.tsx                    ("Pay with Mobile Money" button + "Your requests" entry)
- app/admin.tsx                      (new "Payments" tab renders <PaymentsAdmin/> + pending badge = mobileMoneyRequests + adClickRequests)
- src/lib/faqs.ts                    (rev3 — NEW "Premium & payments" FAQ category incl. Mobile Money for Premium + ad clicks; + recent-feature FAQs: add-participant calls, call waiting, pinned posts, group edit approvals, group sender names)
- app/help.tsx                       (rev3 — footer support email fixed to support.smilers@gmail.com)
- app/settings.tsx                   (rev3 — HID the "Diagnostic Logs" & "Call Diagnostics" rows for the Play Store launch; routes/screens still exist, just unlinked)
- app/chat/[conversationId].tsx      (rev4 — ALSO: composer DRAFT persistence — hydration + debounced save of text/replyTo/pendingImages/editingMessageId/formatting per conversation; + rememberChatRoute() on open)
- app/_layout.tsx                    (rev4 — mounts <ResumeLastRoute/> globally to reopen the last chat on cold start. ⚠️ CALL/PUSH-adjacent file — merge with care; the only change is the added import + one <ResumeLastRoute/> line next to <ShareIntentRouter/>)
- app/premium.tsx                    (rev4 — ALSO: "Have a code? Redeem here" button restored to ALWAYS visible (was hidden when Premium already active))

To apply the patch inside your repo:
    git apply --3way smilers-app-logic-changes.patch
(or `patch -p1 < smilers-app-logic-changes.patch`)

If you previously applied rev1, also run:
    git rm src/components/admin/MobileMoneyAdmin.tsx   # superseded, no longer imported

## Smilers AI (external — Hercules web app)
The in-app AI Assistant runs on the Hercules backend (`api.ai.chat.generateResponse`),
NOT in this repo. See **SMILERS_AI_KNOWLEDGE_FOR_HERCULES.md** for the knowledge /
system-prompt additions the Hercules team should apply so the AI can answer the new
Premium / Mobile Money and group/call questions consistently with the in-app FAQ.

---

## GROUP B — Call / notification / Diary files that ALSO changed here (MERGE WITH CARE)
These changed in the Emergent repo (mostly the prior Call-Waiting + Diary work).
Your native call/notification layer may be NEWER than these — DO NOT blindly
overwrite. Diff each against your version and take only what you don't already have.

- app/call/[conversationId].tsx      ⚠️ contains one important CRASH FIX from us: `MaterialCommunityIcons` was USED but not imported (the Call-Waiting hold/swap indicator would crash). Ensure your import line includes it:
      import { Feather, Ionicons, MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
  (The rest of this file is Call-Waiting Phase 2 — you likely already have equivalent/newer.)
  ⭐ rev5 (2026-07-07): the SELF-VIEW is now DRAGGABLE during a video call. Because this is your file, the change is given as focused edits (not a full-file diff) in **CALL_SELFVIEW_DRAG_FOR_ASHWINI.md** — apply those 3 edits to your version.
- src/components/call/CallWaitingOverlay.tsx
- src/lib/call/useSecondaryCall.ts
- src/lib/call/activeCallRegistry.ts
- src/lib/webrtc/inCallManager.ts
- src/push/useIncomingCallListener.ts
- app/diary.tsx  /  src/components/diary/DiaryAudioBubble.tsx
- app/status-view/[userId].tsx  /  app/privacy.tsx

---

## Notes
- No new native modules were added by Group A (pure RN/Expo + Convex hooks), so no
  native config changes are required for these.
- Mobile Money and group pinned-post/edit-approval depend on Convex functions that
  must be deployed on the Hercules web-app side (mobileMoneyRequests.*, messages.*,
  conversations.pinMessage/getPinnedMessage). The native wiring conforms to the
  agreed contracts.
