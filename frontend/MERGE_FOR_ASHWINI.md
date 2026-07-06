# Smilers — changes to merge into Ashwini's native build (2026-07-06)

These are the fixes made in the Emergent codebase that the current APK is missing.
Split into two groups so you do NOT accidentally overwrite your newer native
call/notification work.

Baseline for all diffs: commit 21cc30a3 (2026-07-03 23:11 UTC).

---

## GROUP A — App-logic fixes (SAFE to take as-is)
These do NOT touch the call/notification/WebRTC layer. Apply the patch
`smilers-app-logic-changes.patch` (git apply), or copy these files verbatim.

NEW files:
- src/components/chat/EditPermissionModals.tsx
- src/lib/friendlyError.ts
- src/lib/mobileMoney.ts
- app/mobile-money.tsx
- src/components/admin/MobileMoneyAdmin.tsx

MODIFIED files:
- app/chat/[conversationId].tsx      (group post edit approval Phase 2; group pinned-post banner + admin gate; group sender-name display; + CRASH FIX: added `Modal, Pressable` to the react-native import)
- src/components/chat/MessageActionSheet.tsx  (Suggest edit / Pin-Unpin / edit-mode rows)
- src/components/chat/MessageBubble.tsx
- src/components/MediaBubble.tsx      (senderDisplayName prop → group sender name header)
- app/user/[userId].tsx              (Groups-in-common now uses api.conversations.listGroups; friendly errors)
- src/components/user-profile/GroupInCommonRow.tsx  (robust member id/phone matching, nested shapes)
- app/(tabs)/contacts.tsx            (friendly error on open-chat)
- app/find-by-phone.tsx              (friendly error on start-chat)
- app/diagnostic-logs.tsx            (group-detection diagnostics: listGroups authoritative)
- src/lib/referralAttribution.ts     (referral once-per-user lock)
- app/index.tsx                      (Sign-in: hide referral entry once redeemed)
- app/premium.tsx                    ("Pay with Mobile Money" button + "Your requests" entry)
- app/admin.tsx                      (new "Payments" tab + pending badge)

To apply the patch inside your repo:
    git apply --3way smilers-app-logic-changes.patch
(or `patch -p1 < smilers-app-logic-changes.patch`)

---

## GROUP B — Call / notification / Diary files that ALSO changed here (MERGE WITH CARE)
These changed in the Emergent repo (mostly the prior Call-Waiting + Diary work).
Your native call/notification layer may be NEWER than these — DO NOT blindly
overwrite. Diff each against your version and take only what you don't already have.

- app/call/[conversationId].tsx      ⚠️ contains one important CRASH FIX from us: `MaterialCommunityIcons` was USED but not imported (the Call-Waiting hold/swap indicator would crash). Ensure your import line includes it:
      import { Feather, Ionicons, MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
  (The rest of this file is Call-Waiting Phase 2 — you likely already have equivalent/newer.)
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
