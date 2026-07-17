# 🗂️ Backend TODO — Convex changes pending for the mobile app

Single checklist of Convex backend work the **mobile app** is waiting on, from
the current work session. Each item links to a detailed spec with exact code.
The mobile side is already built and (where risky) **feature-flagged OFF**, so
deploying these is safe and unlocks the features with a flag flip + rebuild.

> Backend lives in the shared Convex project (`aware-newt-456`), same one the
> web app uses. No mobile code changes are needed after you deploy — just flip
> the noted env flag and rebuild.

---

## ✅ / ⏳ Checklist

| # | Item | Priority | Status | Spec | Mobile flag to flip after deploy |
|---|------|----------|--------|------|----------------------------------|
| 1 | `messages.markUnread({ conversationId })` | 🟡 Medium | ⏳ Pending | `CONVEX_BACKEND_ADD_MARK_UNREAD.md` | `EXPO_PUBLIC_MARK_UNREAD_ENABLED=true` |
| 2 | `typing.getTypingForConversations({ conversationIds })` | 🟢 Low (perf) | ⏳ Pending | `CONVEX_BACKEND_ADD_BATCH_TYPING.md` | `EXPO_PUBLIC_BATCH_TYPING_ENABLED=true` |
| 3 | Invite-link chief-admin permission | — | ✅ No action needed | `CONVEX_BACKEND_FIX_INVITE_LINK_CHIEF_ADMIN.md` | — |

---

## 1. `messages.markUnread` — enables swipe-to-read **Undo**
- **What:** Add a `markUnread` mutation mirroring `markRead` (mark a conversation
  unread for the calling user only, so `getUnreadCounts` returns ≥ 1).
- **Why the app needs it:** The Chats & Groups lists have swipe-to-read with an
  **Undo** snackbar. Undo calls `messages.markUnread`. Until deployed, Undo is
  hidden (flag off) — mark-read itself works fully.
- **After deploy:** set `frontend/.env` → `EXPO_PUBLIC_MARK_UNREAD_ENABLED=true`,
  rebuild. Undo appears on both lists.
- **Full spec + code:** `CONVEX_BACKEND_ADD_MARK_UNREAD.md`

## 2. `typing.getTypingForConversations` — batch typing (perf)
- **What:** Batched version of `typing.getTypingUsers` returning
  `{ [conversationId]: [{ userId, name }] }` for a list of conversation ids.
- **Why the app needs it:** Chats/Groups currently open **one typing
  subscription per visible row**. This batch query collapses that to one
  subscription per list and powers the group-row "…is typing" indicator.
- **After deploy:** set `frontend/.env` →
  `EXPO_PUBLIC_BATCH_TYPING_ENABLED=true`, rebuild. Both lists switch to the
  single query; group rows show typing.
- **Full spec + code:** `CONVEX_BACKEND_ADD_BATCH_TYPING.md`

## 3. Invite-link chief-admin — ✅ resolved, no change required
- Investigated after the "Chief Admin can't create invite link" report. The
  backend guard was already correct (chief/creator counts as admin); the real
  cause was a **mobile UI** issue (the button was clipped by the gesture bar),
  now fixed. **No backend change needed** — this file can be ignored/deleted.
- Ref: `CONVEX_BACKEND_FIX_INVITE_LINK_CHIEF_ADMIN.md`

---

### Notes
- Older `CONVEX_BACKEND_INSTRUCTIONS_*.md` files are from **previous sessions**
  and are assumed already applied — they are **not** part of this checklist.
- All items are additive/backward-compatible; deploying them will not affect the
  web app.
