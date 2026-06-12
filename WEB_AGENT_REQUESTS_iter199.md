# REQUESTS FOR THE WEB/BACKEND (CONVEX) AGENT — from the Smilers mobile agent

> Date: 2026-06-12 (iter-199). The user will relay this. Please answer with
> CANONICAL function names + argument schemas, or apply the fixes directly.
> Convex deployment: the one behind smilers.online / aware-newt-456.

## CONTEXT — what mobile verified today
- Convex DOES trigger pushes → POST {MOBILE_BACKEND_URL}/api/send-push-internal
  (seen on the DEPLOYED FastAPI backend, e.g. "Incoming voice call" at
  21:24:11 UTC, recipients = OIDC subs — correct!). Keep it pointed at
  https://app-migration-75.emergent.host.
- Mobile ALSO fires sender-side pushes via POST /api/notify-event (recipients =
  Convex user ids). The FastAPI backend dedupes both paths (per-recipient
  25 s call-push window + idempotency keys). No action needed from you here.

## 1. Screen sharing — sendSignal rejects the offer (P0)
Mobile's WebRTC OFFER for a screen-share session is rejected by
`screenSharing.sendSignal` (mobile retries every 2.5 s forever):
`[CONVEX M(screenSharing:sendSignal)] Server Error` (see screenshot evidence;
full repro + suggested fix already documented in
`/app/WEB_AGENT_SCREEN_SHARE_SENDSIGNAL_FIX.md`).
QUESTIONS:
a. Must the recipient call `screenSharing.acceptScreenShare` BEFORE
   sendSignal accepts an offer? If yes, confirm the exact session-status
   value(s) that allow signals.
b. What is the exact args validator for sendSignal (field names/types)?

## 2. Saving language preferences fails (P0)
Mobile calls `users.updateProfile` with each of these payloads (all rejected
with Server Error):
- { skipTranslationLanguages: string[] }
- { languages: string[] }
- { spokenLanguages: string[] }
(`languages.update`, `users.updateLanguages`, `users.setLanguages` are
FunctionPathNotFound.)
QUESTION: what is the CANONICAL mutation + argument names for saving
(a) the user's default language and (b) the "do not translate these
languages" list, as used by the web app's Languages settings?

## 3. Scheduled messages show recipient "Unknown" (P1)
`scheduledMessages.listMine` returns entries whose `recipient` field is the
literal string "Unknown" (web app shows "Angela Yeboah" for the same entry).
REQUEST: make listMine return the resolved recipient display name (or add
`recipientName` / `recipientUserId` so mobile can resolve it).

## 4. Referral code missing for this account (P1)
The user's invite shares contain NO referral code. Mobile reads
`earnings.getMyProfile().referralCode` and falls back to mutation
`earnings.getOrCreateReferralCode({})`.
QUESTIONS:
a. Does getOrCreateReferralCode exist and work for every account? (Web
   Settings shows a code for this user?)
b. If the canonical path differs, what is it?

## 5. (FYI, no action) Push pipeline status
- Production FastAPI backend now: dead-token pruning, real delivery stats,
  trigger log at GET /api/push-debug?triggers=20, cross-source dedupe.
- Recipients for /api/send-push-internal must remain OIDC subs (confirmed
  working).
