# Smilers Mobile App — PRD

## iter-413 (Jun 2026): Decrypted-cache size cap (LRU eviction)
- Added `pruneDecryptedCache()` in `useDecryptedMediaUrl.ts`: scans the on-disk decrypted cache (`Paths.cache/smilers-e2ee`) and, when total > 200 MB, evicts the OLDEST files (by `modificationTime`) down to 150 MB (headroom). Also drops matching in-memory `decryptedCache` entries so an evicted file is re-materialized rather than returning a dead URI.
- Runs opportunistically after each file-backed decrypt (throttled internally to at most once / 5 min), best-effort (never throws). Keeps the instant-reopen cache from bloating device storage.


## iter-412 (Jun 2026): Persistent decrypted-file cache + "Save to Files" shortcut
- **Instant re-open:** `useDecryptedMediaUrl` now checks the on-disk decrypted cache (`Paths.cache/smilers-e2ee/<msgId>.<ext>`, via `existingDecryptedCacheUri`) BEFORE downloading/decrypting — so re-opening a large file (even after an app restart / in-memory cache clear) skips both the download and the AES-GCM decrypt. Images (data URIs) are skipped.
- **Save to Files:** `FileMessage` now shows a "Save to Files" shortcut under the document row. It reuses the decrypt-then-act flow (`trigger('save')`) and opens the OS share sheet with a "Save to Files" title (the platform-correct save entry point). For lazy large files it decrypts first (with progress) then presents the sheet.
- Refactored the file open/save into a single `runAction(uri, mode)` + `pendingActionRef` so both the row tap and the Save button share the lazy-decrypt path. Lint clean; app bundles. Device-only to fully validate.


## iter-411 (Jun 2026): Download progress bar for large encrypted files
- Enhancement on iter-410's lazy large-file decrypt. `useDecryptedMediaUrl` now downloads big ciphertext via legacy `createDownloadResumable` (byte-level progress callback) → reads bytes with the new `File(uri).bytes()`. Falls back to `File.downloadFileAsync` (no progress) then `fetch`.
- Exposes throttled `progress {received,total}` (updates only every ≥2%). `FileMessage` shows "Downloading… X.X / Y.Y MB" + a thin progress bar during the download phase, then "Decrypting…" during the JS AES-GCM step. Device-only (native streaming) — validate after APK rebuild.


## iter-410 (Jun 2026): Fixed large (13 MB) E2EE document failing to open ("failed to download or decrypt")
- **Reported:** a 13 MB web-sent encrypted `.txt` shows the red lock icon and "Couldn't open file"; user confirmed SMALL docs open fine, only the big one fails, and it was sent from the WEB app (so it's E2EE — the bubble's "PLAIN" is just the `text/plain` MIME).
- **Root cause:** `useDecryptedMediaUrl` (a) eagerly fetch+decrypts EVERY encrypted message on render, and (b) downloaded ciphertext via `fetch(url).arrayBuffer()`. RN's fetch routes large bodies through a blob→base64→decode path that ~TRIPLES peak memory, so a 13 MB blob OOM'd/threw during the on-render decrypt (also a source of the "chat list freezes" symptom). Small files fit, so they worked.
- **Fix (`src/hooks/useDecryptedMediaUrl.ts` + `src/components/MediaBubble.tsx`):**
  1. Memory-safe download on native — `File.downloadFileAsync` streams ciphertext straight to disk, then `file.bytes()` reads it natively (no base64 tripling, ~1x peak). Falls back to the old `fetch` path on any FS error and on web.
  2. LAZY decryption for large files (`type file/video` & `fileSize ≥ 3 MB`): they are NOT decrypted on render — the bubble shows a "download/tap-to-open" affordance; the first tap arms decryption (spinner + "Decrypting…"), and it auto-opens when ready. Prevents the on-render JS-thread block/OOM and chat-list freeze.
  3. The error alert now surfaces the real underlying reason (HTTP vs decrypt) for future diagnosis.
- Small/media files unchanged (still eager, still work). `useAutoDownloadMedia` already no-ops while `src` is null, so deferred files aren't eagerly fetched.
- ⚠️ The 13 MB decrypt is device-only (native streaming path) — validate after APK rebuild: the big file should now show a download icon, and tapping shows "Decrypting…" then opens. If the pure-JS AES-GCM decrypt itself proves too slow/heavy at very large sizes, next step is a native crypto module.


## iter-409 (Jun 2026): Message notifications upgraded — WhatsApp-style MessagingStyle thread + inline REPLY (RemoteInput)
- Builds on iter-408's native message rendering. New shared `MessageThreadStore.kt` keeps a short per-conversation history and posts each message as a `NotificationCompat.MessagingStyle` thread (sender Persons, group `conversationTitle`, "You" for own lines) with the Smilers message/group tone on channels `messages-native-v1`/`groups-native-v1`.
- Added an inline **Reply** action (`RemoteInput`, `SEMANTIC_ACTION_REPLY`, MUTABLE PendingIntent) so users reply straight from the notification shade without opening the app.
- Reply flow: `MessageReplyReceiver` (BroadcastReceiver) extracts the typed text → echoes it into the thread immediately (optimistic, `alertOnce`) → `acquireWakeLockNow` + starts `MessageReplyHeadlessService` (`HeadlessJsTaskService`) → runs the JS headless task `SmilersMessageReply` (`src/push/messageReplyTask.ts`, registered from `index.js`).
- JS task: reads `smilers_id_token` from SecureStore (same pattern as the working `emergencyForegroundService`), builds an authed `ConvexHttpClient`, calls `anyApi.messages.send({conversationId,type:'text',text})` — the **Smilers backend performs E2EE encryption server-side** on send (the app always sends plain text), so no client crypto is needed — then fires a best-effort recipient push via `POST /api/notify-event` (queries `users.getCurrentUser` + `conversations.getConversation` for sender/recipients).
- Manifest: registered `MessageReplyReceiver` + `MessageReplyHeadlessService`. Removed the now-duplicated inline builder/consts from the service (centralised in `MessageThreadStore`).
- ⚠️ NATIVE + HEADLESS-only — CANNOT run on web/Expo Go. User MUST rebuild the APK. Validation items after rebuild: (1) message notif shows a chat-style thread with saved contact/group name + Smilers tone; (2) typing in the shade "Reply" box sends the message (check it appears in-app on both devices) even when the app is killed; watch logcat tag `SmilersCall` (`MessageReplyReceiver: queued reply`) and JS `[reply] sent`. If background service-start is blocked on Android 12+, the wakelock+notification-action exemption should cover it — flag if not.


## iter-408 (Jun 2026): P0 message-notification ROOT CAUSE FIXED — native Kotlin rendering (no more "Smilers" name + universal tone)
- **Root cause (from the current-build ADB log `20260727-MSGDIAG`, `full-message-log.txt`):** the message FCM is ALREADY correct — DATA-ONLY (`hasNotifBlock=false`), carrying `senderPhone`, `conversationType`, `message`, etc. The bug is that `SmilersCallNotificationService` classified `type=message` as "not a call" and **delegated to Expo** (`super.onMessageReceived`/`super.handleIntent`). expo-notifications then AUTO-DISPLAYED the data message on the generic `expo_notifications_fallback_notification_channel` (log: `NotificationModel showNotification … channel = expo_notifications_fallback_notification_channel`) using the raw `data.title="Smilers"` and the default/universal tone — bypassing the app's device-contact-name + custom Smilers-tone rendering. The prior iter-401b hypothesis (Convex sends a notification block) was WRONG; the push is data-only.
- **Fix (`android/.../SmilersCallNotificationService.kt`):** render message/group pushes NATIVELY (like calls) and STOP delegating them to Expo. New `handleMessageNotification(data)` — wired into `handleIntent` (Path BM, returns before `super.handleIntent`), the `firebaseMessagingDelegate.onMessageReceived`, and the direct `onMessageReceived` override. It:
  - resolves the saved DEVICE-CONTACT name from `senderPhone` via the existing `lookupContactNameByPhone` (ContactsContract) — never shows the generic "Smilers" account label as the title;
  - posts on dedicated FRESH channels `messages-native-v1-message_notification` / `groups-native-v1-group_notification` with the correct `message_notification` / `group_notification` raw sounds (fresh ids avoid Android channel-sound immutability collisions);
  - groups → title = group name (`conversationName`), body = "Sender: message"; direct → title = contact name, body = message text;
  - honours device-local prefs read straight from RN AsyncStorage SQLite (both legacy `RKStorage/catalystLocalStorage` and new Room `AsyncStorage/Storage` backends): per-conversation MUTE (`smilers_muted_conversations_v1`) and "Hide message content" (`smilers_ringtone_prefs.hideMessagePreview`);
  - suppresses the banner when the app is in the FOREGROUND (parity with the JS bg task — the in-app realtime path surfaces it), and dedups repeat/relay delivery via `checkAndMarkHandled("msg:<idempotency_key>")`.
- Backend already sends the correct data-only payload (`senderPhone/senderId/conversationType/conversationName` threaded through `send_push`/`notify_event`) — NO backend change needed. Per-type toggle suppression stays enforced server-side (iter-385).
- ⚠️ NATIVE-only — CANNOT be validated on web/Expo Go. User MUST rebuild the APK. Expected: message/group notifications now show the saved contact/group name with the custom Smilers message/group tone; muted chats stay silent; content hides when the privacy toggle is on.


## iter-407 (Jun 2026): Automatic audio-only fallback on weak networks (potential improvement)
- Added an adaptive bandwidth monitor to the 1:1 WebRTC call (`src/lib/webrtc/CallSession.ts`): while a video call is `connected`, polls `getStats()` every 3s for `availableOutgoingBitrate` + video `fractionLost`. On sustained LOW (<80kbps or >15% loss, 2 samples) it PAUSES the outgoing camera (`encodings.active=false` + `track.enabled=false`) so the data budget keeps VOICE clear; on sustained recovery (>250kbps & <5% loss) it RESUMES the camera and re-applies the low-bandwidth cap. Hysteresis prevents flapping; all guarded in try/catch; started/stopped via connectionstatechange + `close()`; never runs for screen-share/audio-only.
- New opt `onLowBandwidthVideo(paused)`; the call screen (`app/call/[conversationId].tsx`) shows a subtle "Video paused · weak network" pill (`weakNetPill`/`weakNetText` in `callScreenStyles.ts`) during fallback and clears it on recovery.
- Lint clean; app boots. Native-only → validate after APK rebuild (simulate poor data mid video call → video auto-pauses with the note, voice stays clear, restores when network recovers).


## iter-406 (Jun 2026): P1 low-bandwidth call tuning + P4 offline resilience (verified existing)
- **P1 (2a) — DONE:** added `applyCameraEncodingParameters()` to `src/lib/webrtc/CallSession.ts` — caps the CAMERA video sender to ~0.5 Mbps / 24fps / `degradationPreference: maintain-framerate` / gentle `scaleResolutionDownBy` so 1:1 video calls connect fast and stay smooth on expensive/scarce mobile data. Applied after createOffer AND createAnswer (both peers). Guarded by `!screenShareActive` + `callType==='video'` and wrapped in try/catch so it can NEVER break a call; screen-share keeps its own higher caps (legibility). Audio already Opus (~24-40kbps).
- **P4 (4a) — ALREADY IMPLEMENTED (verified, not rebuilt):** `app/chat/[conversationId].tsx` already has a persistent AsyncStorage outbox (`src/lib/outbox.ts`): text messages that fail while offline queue with a RED dot and auto-flush on reconnect (NetInfo) + app-foreground (AppState); `src/lib/offlineCache.ts` caches content with a "showing saved messages" banner. Known limitation (by design): E2EE/media messages aren't queued (need live keys/upload). Left as-is.
- Lint clean; app boots. Native-only → validate after APK rebuild.


## iter-405 (Jun 2026): Low-data/call-quality — P0 "connecting forever" fix (user approved 1a,2a,4a)
- **P0 (1a) — DONE:** the active 1:1 call screen (`app/call/[conversationId].tsx`) is WebRTC-based (CallSession + Convex signaling) and had NO caller-side ring timeout → "connecting for eternity" (the embarrassing incident vs WhatsApp). Added a surgical, additive watchdog: `slowConnect` (after 10s → "Still ringing…"/"Connecting… weak network") and `callFailed` (after 45s → "No answer" then auto-`handleHangup` after 2.5s). Reuses existing hangup; skips incoming/active calls; resets on status change. Fails fast + gives live feedback instead of an infinite spinner.
- **Investigated TURN (relevant to the incident):** `src/lib/webrtc/iceServers.ts` already fetches ephemeral Twilio TURN creds from Convex `/turn-credentials` (+ metered.ca static fallback, Google STUN) — solid. So the incident was primarily (a) no timeout/feedback (now fixed) and (b) potential relay/codec tuning (P1 next).
- **Deferred by design (protecting the user's imminent redeploy/rebuild test):**
  - P1 (2a) low-bandwidth call tuning: cap the CAMERA video sender maxBitrate (~500kbps) + Opus DTX, WITHOUT touching screen-share (needs high bitrate for legibility). Requires a camera-vs-screen-safe insertion in `CallSession` — focused next round. Plus Stream dashboard: confirm TURN region coverage for Africa + adaptive bitrate.
  - P4 (4a) offline resilience: message outbox that auto-sends on reconnect + cached content — standalone next round.
  - #3 media auto-download: user wants it to REMAIN a user choice ("auto-download on WiFi only"); most African users have no WiFi → leave the existing setting as-is (no forced data-saver).
- Lint clean; app boots. P0 is native-only → validate after APK rebuild.


## iter-404 (Jun 2026): Muted-bell indicator on chat list (potential improvement)
- `ConversationRow` now shows a `bell-off` icon (right column, next to the unread pill) when a conversation is muted. New `muted` prop; imported `Feather`; new `rowRightBadges`/`mutedBell` styles.
- `app/(tabs)/chats.tsx`: added `mutedIds` state loaded via `getMutedConversations()` on focus (so it reflects mutes toggled from a chat screen), passed `muted={mutedIds.has(item._id)}` to each row. Lint clean.
- Complements iter-403 per-conversation mute.


## iter-403 (Jun 2026): Per-conversation MUTE — made the stub real (potential improvement)
- The chat "Mute notifications" option existed but was a no-op stub (local `useState`, not persisted, didn't suppress anything). Made it fully functional & device-local:
  - New `src/lib/mutedConversations.ts` (AsyncStorage set: `getMutedConversations`/`isConversationMuted`/`setConversationMuted`).
  - `app/chat/[conversationId].tsx`: loads persisted mute on mount; the `mute` action now persists via `setConversationMuted` (works for direct AND group chats since a group is a conversation).
  - Renderers suppress muted convos: `backgroundTaskSetup.ts` (bg/killed) checks `isConversationMuted(conversationId)` right after group detection → returns early (logs `MSG-PUSH muted ... suppressed`); `usePushNotifications.ts` (foreground) checks before display. Complements the existing global per-type toggles (`isNotificationTypeEnabled`).
- Device-local by design (instant/offline; future: sync via Convex). Lint clean. Native-only → validate after APK rebuild.


## iter-402 (Jun 2026): Message/group notification TONE fix (channel-immutability) + "Hide message content" privacy toggle
- **Diagnosis (with Convex dev's contract):** the push flow is Convex → FastAPI relay (`server.py`) → FCM. The relay ALREADY sends messages data-only (`is_message_push`) and the native JS renderer (`notifeeMessageDisplay.ts`) ALREADY picks the group channel + group tone via `conversationType==='group'`. So the code was correct — the wrong tone was **Android channel immutability**: an earlier build created the `-v5-` message/group channels with the wrong/default sound, and Android keeps a channel's sound forever (an app UPDATE can't change it). The wrong NAME + missing MSG-PUSH/MSG-NAME logs indicate the user's installed APK also predates the current name-resolution/logging — a rebuild is required.
- **Fix #2 (tone):** bumped message/group channel ids `-v5- → -v6-` everywhere so the rebuilt app creates FRESH channels with the correct Smilers `message_notification`/`group_notification` sounds: `notificationChannels.ts` (message id + added a `groups-v6-group_notification` fallback created at startup), `backgroundTaskSetup.ts`, `usePushNotifications.ts`, `notifeeMessageDisplay.ts`, and relay `server.py` (`channelId` for group msgs → v6). Group detection stays version-agnostic (`conversationType` / `startsWith('groups-')`), so Convex's v4 string still works. NAME correctness comes automatically once they rebuild with current code.
- **Fix #1 (potential improvement — lock-screen privacy):** added "Hide message content" toggle in `app/ringtones.tsx` (Privacy section) → persisted in the ringtone prefs blob. New `readHideMessagePreview()` in `notificationChannels.ts`; all 3 message renderers show "New message" (keeping the contact name + tone) when enabled.
- Lint clean; backend loads. Native-only → validate after APK rebuild.


## iter-401b (Jun 2026): Message notification NAME+TONE — ROOT CAUSE CONFIRMED (Convex sends notification-block pushes)
- Device evidence: NO `MSG-PUSH`/`MSG-NAME` logs ever fire for message pushes + exactly ONE banner + backgrounded. Conclusion: the app's data-only background renderer never runs → the message push arrives as an FCM **notification message** and Android auto-displays it (FCM title = sender Google name; default channel/tone), bypassing the app's device-contact-name + custom-channel renderer. This single cause explains BOTH the wrong name AND the wrong tone, for direct + group.
- Source is the external **Convex** backend (FastAPI relay already sends `is_message_push` data-only). Fix is Convex-side: send chat/group message pushes DATA-ONLY (no `notification` block), Android `priority:high`, iOS `content-available:1`, with `data.{type:"message", conversationId, conversationType, title, body, senderId, senderPhone}`. App is already wired to render it correctly (device-contact name + Smilers message/group tone) — no mobile rebuild needed.
- Wrote full spec: `/app/CONVEX_MESSAGE_PUSH_CONTRACT.md` for the user's web/Convex team.


## iter-401 (Jun 2026): Study Room "Share invite" button + notification-tone/name investigation
- **#1 Share invite (potential improvement):** `app/study/rooms/[roomId].tsx` code card now has a "Share invite" button → system share sheet with room name + join code + how-to. New `shareCode` (RN `Share`), restructured codeCard (codeCardMain + codeShareBtn/Text styles).
- **#2 Message/group notification wrong NAME (Google account, not device contact) + wrong TONE (default, not custom Smilers):** investigated the render path. Backend `send_push` already sends `type=="message"` DATA-ONLY (`is_message_push`, iter-199) so the OS shouldn't auto-display; the bg task (`backgroundTaskSetup.ts`) renders on custom channels `messages-v5-message_notification`/`groups-v5-group_notification` (sounds `message_notification`/`group_notification`) and resolves device-contact names. Both symptoms (Google name + default tone) point to the SAME root cause: **a notification-BLOCK push being OS-auto-displayed** (bypasses the app's channel + name resolution). Most likely the CHAT message push originates from the external CONVEX backend (not the FastAPI relay), which still sends a notification block. The app already logs this: in-app **Diagnostic Logs screen** (`app/diagnostic-logs.tsx`) tags `MSG-PUSH` (`hasNotifBlock`, type, title, name) and `MSG-NAME` (convId, cachedConvName, senderPhone, account). AWAITING user capture (in-app diag or `adb logcat`) of 1 direct + 1 group message to confirm `hasNotifBlock` and pick the fix layer (Convex data-only vs contact-sync).


## iter-400 (Jun 2026): Study Rooms native — ROOT CAUSE FIXED (wrapped-vs-flat shape)
- User's web team shared the exact deployed contract: `getRoom` → `{ room: Doc, myRole, members: [{userId,role,displayName,joinedAt}] }`; `listMyRooms` → `[{ room: Doc, role, joinedAt }]`; `createRoom` → `{ roomId, joinCode }` (adds creator as admin, generates `joinCode` — NOT `inviteCode`; members live in a separate `studyRoomMembers` table, NOT on the room doc).
- **Root cause:** native screens read a FLAT room, but the backend returns a WRAPPED object. The list navigated with `item._id` which is `undefined` (real id is `item.room._id`) → `getRoom({roomId: undefined})` → null → "You're not a member". Also `name/joinCode/memberCount` read off the wrapper → missing (hence "Study room · 0 members").
- **Fix (native, `src/lib/study/useRooms.ts`):** added `flattenRoomListItem` ({...item.room, role, myRole, joinedAt}) applied in `useMyRooms`, and `flattenRoomDetail` ({...raw.room, myRole, role, members}) applied in `useRoom`. Screens now get flat rooms so `r._id`=room._id (correct navigation), `name/joinCode/memberCount/role/members` all resolve. Removed the temporary `[STUDYROOM]` diagnostic. Also flattened `previewRoomByCode` result and added `res.room._id` fallback for join/create nav in `index.tsx`. Members tab already reads `displayName`/`userId` (matches contract). Settings screen uses `useRoom` so it's fixed too.
- ⚠️ External-backend + auth-gated → validate on device after APK rebuild: create a room → it opens with code + you listed as admin member; list shows real name + member count.


## iter-399 (Jun 2026): Diary Export + Study Room native mismatch diagnosis
- **#1 Diary Export (potential improvement):** `app/diary.tsx` header menu now has "Export my Diary" → builds a readable `.txt` (newest-first, timestamps + forward source) to cache and opens the OS share sheet via `expo-sharing` (clipboard fallback if unavailable). Gives users an off-device backup so notes are never lost even if the cloud hiccups. New `handleExport`/`exporting` state; uses already-imported `LegacyFileSystem` + `Clipboard`.
- **#2 Study Rooms broken on native (works on web) — DIAGNOSED, partial fix + diagnostic:** user screenshots prove web shows "Family · 1 member · INVITE CODE NMBHC6" while native shows "Study room · 0 members · admin" and (on open) "not a member" + no code. Native `EXPO_PUBLIC_CONVEX_URL=aware-newt-456` == documented backend, so SAME deployment. This is the KNOWN backend contract issue from `CONVEX_BACKEND_REQUIREMENTS.md` items #2/#3 (creator not in members[], code field). The web app was fixed/uses field `inviteCode` (web label literally "INVITE CODE"); native read only `joinCode`/`code`.
  - Applied tolerant field mapping in `app/study/rooms/[roomId].tsx` + `index.tsx`: code now reads `joinCode|code|inviteCode`; role `role|myRole|memberRole` (+`chief`); members `members|memberList|participants|memberRecords`; name `name|roomName|title`. Helps once getRoom returns the room.
  - Core blocker: `getRoom({roomId})` returns NULL for the native creator (→ "not a member") while web's succeeds — cannot be fixed by field mapping. Added a one-shot DIAGNOSTIC in `useRooms.ts::useRoom` that raw-calls getRoom and logs `[STUDYROOM] getRoom(id) -> NULL/keys/THREW` (useSafeConvexQuery swallows the error). Need the exact deployed contract (getRoom/listMyRooms/createRoom args + return field names, invite-code field name, whether createRoom adds creator to members[]) from the web team, OR a `adb logcat | grep STUDYROOM` to pinpoint.
- Lint clean. Study rooms are external-backend; validate after contract alignment + logcat.


## iter-398 (Jun 2026): Diary data-loss fix + saved-contact badge + document-open fix
- **#1 Saved-contact badge (enhancement):** `app/user/[userId].tsx` header now shows "In your contacts" (green, user-check) / "Not in your contacts" (muted, user-x) when a group-member profile is open, driven by `memberProfile.phoneSavedOnDevice` — so the viewer instantly understands WHY the number is/ isn't visible. New styles savedBadge/On/Off/Text.
- **#2 Diary missing-entries ROOT CAUSE + fix (recurring P0):** the local→cloud flush in `app/diary.tsx` DELETED each local entry (`deleteDiaryEntry`) right after `appendEntry` resolved. If that cloud append didn't durably persist (older build/schema), the note was lost forever — matches user's case (entries created on-device, flushed, gone; it was an app UPDATE so AsyncStorage was intact, ruling out install-wipe; NEW entries persist fine now). Fix (non-destructive):
  - `diaryStore.ts`: added `_flushedToCloud?: boolean` to `DiaryEntry` + `markDiaryEntryFlushed()` (keeps the marked local copy instead of deleting).
  - `diary.tsx`: flush now selects orphans by `!_flushedToCloud` (was comparing local vs cloud _id — different id namespaces, so every entry always looked orphaned) and marks (not deletes) on success. New `mergeEntries` de-dupes local vs cloud by a CONTENT signature (`kind|text|attachment key|forward src`) so a synced note isn't shown twice, while any local note NOT represented on the cloud stays visible → notes can never silently vanish from the device again.
  - ⚠️ Entries ALREADY lost by the previous destructive flush (deleted locally + never persisted server-side) are NOT recoverable from the app; this fix prevents recurrence going forward.
- **#3 Chat document won't open / red icon:** `MediaBubble.tsx` `FileMessage.onOpen` — Android blocks handing a raw `file://` URI to another app (FileUriExposed), so decrypted/cached documents (esp. large .txt) failed to open. Now opens `file://` docs via `expo-sharing.shareAsync` (content:// via FileProvider), falling back to `Linking.openURL`; http(s) URLs still open directly. Tapping a failed (srcError) file now shows a clear "Couldn't open file" alert + retry instead of doing nothing (`disabled={!src && !srcError}`).
- Lint clean. Native/external-backend paths → validate on device after backend redeploy + APK rebuild.


## iter-397 (Jun 2026): Group member profiles + phone-number privacy gate (NATIVE wiring; backend is EXTERNAL Convex)
- **Feature:** any group member can open another member's profile (account/saved name, photo, about, role, groups in common), but the PHONE NUMBER is private. It's shown+copyable ONLY if the viewer is self, already has the member saved as a device contact, OR the owner approved a view request. Otherwise it's masked (••••) with an eye button → "Request to view" → owner Approve/Decline → reveal. Unlimited retries.
- **Consumes EXTERNAL Convex fns (user's web-app deploys these — see the two contract JSONs the user provided):** `api.groupMemberProfile.getMemberProfile({conversationId,userId})` (reactive; returns `phone|null`, `phoneVisible`, `phoneRequestStatus`, `phoneSavedOnDevice`, fail-closed), and `api.phoneViewRequests.{request({ownerId}), getIncoming({}), respond({requestId,accept}), getOutgoingStatus({ownerId})}`.
- **Frontend changes (all app-side, degrade gracefully to nothing until backend deploys — uses `(api as any).x?.y` + `useSafeConvexQuery`):**
  - `app/group/[id].tsx`: member rows (avatar+body) now a `TouchableOpacity` → `/user/<mid>?conversationId=<groupId>` (new `memberTap` style). Admin action buttons untouched.
  - `app/user/[userId].tsx`: added the gate. When opened with a conversationId and not self (`memberProfileEnabled`), drives the phone row entirely from `getMemberProfile` (never shows the raw `getUserById` number for a gated member). Masked row + eye button with states from `phoneRequestStatus` (none→"Request to view", pending→"Requested…" disabled, declined→"Declined — retry", approved→number). `request` mutation on tap; reactive status flips reveal live + one-time "Approved" alert. `copyPhone(val?)` generalized. New styles: phoneMasked/eyeBtn/eyeBtnDisabled/eyeText/phoneHint.
  - New `src/components/PhoneViewRequestBanner.tsx` (exact mirror of PhotoSaveRequestBanner) → owner-side Approve/Decline banner via `getIncoming`+`respond`; mounted in `app/(tabs)/chats.tsx` beside the photo banner.
- **NOT changed:** avatar/photo-save gating stays on the existing `photoSaveRequests` flow (contract confirms getMemberProfile's avatar is still save-gated); `api.users.getUserById` untouched (ungated, used elsewhere).
- Lint clean (4 files); web boots to Sign In. ⚠️ End-to-end requires the user's Convex functions deployed + a signed-in session with a group; validate on device/after their backend deploy.


## iter-396 (Jun 2026): P0 ROOT CAUSE — subsequent incoming calls silently suppressed (from `smilers-call-log.txt`)
- **Definitive root cause (found in the device log the user uploaded):** the FCM ring payload carried `callId == conversationId` (STABLE) even though `webrtc_ring` generates a UNIQUE per-attempt `call_id` (which only survived in `idempotency_key=twilio-call:call_<ts>_<rand>`). Log proof: Call 1 rang (`handleCallMessage → Posting notification`), Call 2 (+21s) and Call 3 (+30s) both logged `handleIntent: dedup — jd7be0r3dnc4… suppressed`. The native Android dedup `checkAndMarkHandled(callId)` (5-min `DEDUP_WINDOW_MS`) keys on `callId`, so a stable conversationId made every 2nd/3rd call to the same person within 5 min get dropped before ringing.
- **Why callId was stable:** `backend/server.py` `_derive_push_routing()` parsed `action_url=/call/<conversationId>` and did `out["callId"] = parts[1]`, which `fcm_data.update(routing)` applied — CLOBBERING the unique callId set by `webrtc_ring`. The subsequent copy-loop skips it (`"callId" not in fcm_data` is false).
- **Fix #1 (backend, server.py `_derive_push_routing`):** only fall back to conversationId for `callId` when the caller sent NO explicit callId (`if not str(data.get("callId") or "").strip(): out["callId"] = parts[1]`). Now the unique per-attempt callId flows through the copy-loop into the FCM payload → repeat calls get DISTINCT callIds → native dedup no longer suppresses them. Verified with an isolated unit test of the real function + the send_push merge semantics (unique callId reaches FCM; fallback preserved; two calls to same conv now have distinct callIds). **Backend-only → validate by Publish/REDEPLOY, NO APK rebuild needed.** Native side is safe: the ring notification's stable slot is keyed on conversationId (`effectiveNotifKey`, L920), and `cancelledConvIds`/`foregroundHandledIds` checks also test conversationId, so direct+relay FCM still collapse into one notification.
- **Fix #2 (native Kotlin `SmilersCallNotificationService.postMissedCallFromJs`):** missed-call notification showed the caller's account name ("Smilers") instead of the saved contact name ("ABC Albania"). The JS bridge only knows the account displayName; the ring FCM already resolved+cached the device-contact name in `callIdToCallerName` (keyed by callId AND conversationId via `lookupContactNameByPhone`). Now prefers that cached resolved name, falling back to the JS-passed name. **Native → needs APK rebuild to validate.**
- ⚠️ Both are native/relay paths — cannot be tested on web/Expo Go. Fix #1 validates after backend Publish; Fix #2 after the next APK rebuild.


## iter-394 (Jun 2026): Future Tasks 3 (FCM token purge) + 4 (iOS CallKit/VoIP scaffold) + Task 1 audit
- **Task 3 — stale FCM push-token purge (DONE, backend-tested):** reactive dead-token pruning already existed (`_prune_dead_token`). Added a PROACTIVE time-based sweep in `server.py`: `_purge_stale_push_tokens(days)` deletes `push_tokens` rows whose `updated_at` (fallback `created_at`) is older than `PUSH_TOKEN_STALE_DAYS` (default **90d**) — a live device re-registers every cold start, so an untouched row is definitively stale. `_push_token_purge_loop()` runs once at startup then daily (started in the `startup` event). New endpoint `POST /api/maintenance/purge-stale-tokens {days?}` → `{removed, days, tokens_before, tokens_after}`. Verified via curl: 55 tokens, none >90d, removed=0 (safe); loop log confirms "purge loop started (stale threshold = 90d)".
- **Task 4 — iOS CallKit + VoIP (PushKit) ringing (SCAFFOLD DONE; needs creds + device build):** per the Stream integration playbook.
  - **Build-blocker already clear:** `ios/Smilers/Smilers.entitlements` has NO stale PushKit entitlement (only `aps-environment` + app-groups) — the original "PushKit entitlement" build error is resolved. Info.plist already has `UIBackgroundModes=voip`.
  - `ios/Smilers/AppDelegate.swift`: `import stream_io_video_react_native` + `StreamVideoReactNative.voipRegistration()` at launch (before super), so Stream owns the PushKit→CallKit bridge.
  - `src/push/streamIosPushConfig.ts` (new) + wired into `index.js` BEFORE `expo-router/entry`: iOS-only `StreamVideoRN.setPushConfig({ ios:{ pushProviderName, supportsVideo, callsHistory }, shouldRejectCallWhenBusy, createStreamVideoClient })`. Guarded (`Platform.OS==='ios'` + lazy SDK import) → no-op on Android (keeps custom FCM doorbell) & web. Provider name overridable via `EXPO_PUBLIC_STREAM_IOS_PUSH_PROVIDER`.
  - **⚠️ USER MUST PROVIDE (device-build only):** Apple APNs `.p8` + Key ID + Team ID + Bundle ID → configure a Stream Dashboard APN **VoIP** provider whose name matches `pushProviderName`; and iOS-bound calls must be created with Stream ringing so the VoIP push fires (follow-up once the provider is live). Lint clean; web boots.
- **Task 1 — Stream migration AUDIT:** group calls (Phase 2 via `StreamCallInner`) and **screen-share** (`useScreenShareButton`) are ALREADY Stream-native. The ONLY remaining legacy-mesh piece is **Conference Rooms** (`app/conference/[conferenceId]/room.tsx` → `useConferenceMesh` → `MeshController`/`MeshPeer` on the OLD `react-native-webrtc`), tightly coupled to the external Convex `api.conference.*`/`api.signaling.*` mesh model. Migrating it is a large native rewrite that CANNOT be validated in web/Expo Go and risks breaking a working feature — flagged to user for a go/no-go + the Convex conference↔Stream-call-id mapping decision.

## iter-395 (Jun 2026): Task 1 — Conference Rooms migrated mesh → Stream SFU (user chose 1b)
- **What changed:** replaced ONLY the media transport in `app/conference/[conferenceId]/room.tsx`; ALL Convex orchestration (roles, lobby/admit, motions, polls, breakout rooms, minutes, speaker timer, chat, reactions, admin action sheet) is UNTOUCHED.
- **New `src/lib/call/useConferenceStream.tsx`:** `ConferenceStreamProvider` joins ONE Stream call `default:conf_<conferenceId>` (all conf members → same SFU room; O(n) not O(n²) mesh). `MediaBridge` (rendered inside `<StreamCall>`) reads `useParticipants()` and exposes via React context: `byUserId` (Stream participant keyed by Convex user id), `speaking` (+`__local`), `setMic/setCam`, and Stream's `ParticipantView`. Web-safe: SDK is `await import()`-ed only on native; on web (or pre-join) it renders children with an EMPTY media context (avatar tiles) — mirrors how the old mesh degraded.
- **`room.tsx` rewire:** split into outer `ConferenceRoomScreen` (parses params, wraps in `ConferenceStreamProvider`) + `ConferenceRoomInner` (the full existing screen, now consuming `useConferenceStreamMedia()`). Dropped `useConferenceMesh` + `RTCViewWrapper`; local mic/cam toggles now drive `media.setMic/setCam`; `ParticipantTile` renders Stream's `ParticipantView` (video track present) else avatar. Legacy mesh files kept (still used by the separate `app/group-call/[conversationId].tsx`).
- **Verified:** both new/edited files lint clean; web bundles & boots to Sign In (no metro resolution error → the dynamic-import guard keeps the Stream RN SDK out of the web bundle). Self-view flicker (P1) should also improve since conference video now flows through the Stream SFU. **⚠️ NATIVE-only — validate the actual conference call (grid video, mic/cam, participant list) on the user's APK/IPA rebuild after Publish.**


## iter-393 (Jun 2026): Group Call Orchestration (Phase 2) — VERIFIED & CLOSED; Stream call-waiting mirrors WebRTC
- **User clarification:** they wanted the legacy **WebRTC group-call invite/waiting strip** (`app/group-call/[conversationId].tsx` → `INVITE_STATUS_META` + `inviteStrip`: Ringing…/Joined/Declined/No-answer chips) mirrored into the **Stream** call system, plus full group orchestration. User confirmed their external Convex backend is READY and to close Phase 2 (1a).
- **Verification done this iter (no code changes needed — the last agent's implementation was complete & correct):**
  - `StreamCallInner.tsx` renders `GROUP_STATUS_META` (pending→"Ringing…"#E4B53B / joined→green / declined→red) in a live horizontal **waiting strip** (`styles.waitStrip`, testID `group-call-waiting-strip`) showing members not-yet-joined, each chip with a status dot + name + label + (admin-only) kick ⊗, plus a **"Call again"** chip (`groupCallAgain` → re-rings only pending/declined). This is a faithful mirror of the WebRTC invite strip.
  - Roster modal shows every member with per-status pill + "Call again (N)"; non-admin sees "Request to add someone".
  - Admin approval banner (`group-call-add-request`) for non-admin add-requests; `callAddRequestStore.ts` (Zustand) holds the pending request; `usePushNotifications.ts` handles silent `call-add-request` / `call-removed` pushes.
  - Backend endpoints ALL live (curl → 422 on empty body, not 404): `/api/calls/group-ring`, `/group-again`, `/participant-status`, `/request-add`, `/request-add-declined`, `/admin-kick`; roster via GET `/api/twilio/call-participants`. Frontend paths in `twilioApi.ts` match exactly.
  - Lint clean on all 5 changed files (only pre-existing require()/unused warnings); `server.py` compiles; web boots to Sign In (smoke screenshot OK).
- **⚠️ NATIVE-ONLY:** the Stream call UI (waiting strip, admin banner, roster) can only render on a device build — validate on the user's APK rebuild after Publish. Web/Expo Go shows nothing for the Stream tree.


## iter-392 (Jun 2026): Diary "my notes disappeared" — false empty-state during cloud sync (P0)
- **Root cause:** Diary is cloud-backed (`api.diary.listEntries/appendEntry`) with a local AsyncStorage fallback. On first load the screen's own `loading` flag flips to `false` right after the FAST local read (`app/diary.tsx` initial-load effect) WITHOUT waiting for the cloud `listEntries` query. Since local entries are DELETED once they flush to the cloud (`localFlushedRef` block), a returning user's local store is empty, so while the cloud query is still in flight — routinely several seconds, worse right after the documented Convex reconnect/desync on cold start — the render hit `rows.length === 0` and showed the definitive **"Your Diary is empty"**. The notes were never lost; they were on the server, just not fetched yet.
- **Fix (`app/diary.tsx`):** added `cloudSyncing = !!myUserId && !cloudReady && cloudEntriesQuery.loading` and a new render branch BEFORE the empty state: while cloud is still loading and there are no rows yet, show a **"Syncing your notes…"** state (spinner + reassuring copy + a **Retry** button that calls `cloudEntriesQuery.refetch()`), never the "empty" message. Once `listEntries` resolves the reactive subscription populates the list; if it genuinely returns empty (or after the hook's 12s safety timeout) the real empty state shows. Notes are never implied to be deleted mid-sync.
- **Enhancement — "Last synced ✓" header badge:** the existing header subtitle badge now reflects three states via `formatSyncedRelative`: **"Syncing your notes…"** (cloud-sync icon) while loading, **"Synced just now / Xm ago / Xh ago"** (cloud-check) once delivered (tracked via a `lastSyncedAt` state set when `cloudReady`/`cloudEntries` update, refreshed on a 30s tick), and **"Saved on this device"** (cloud-off) when no cloud backend. Reassures the user their notes are backed up. Lint clean (only pre-existing warnings); web boots. ⚠️ Validate on the APK rebuild + a signed-in session.


- **#1 Profile shared media now opens & swipes (P0):** wired the iter-390 `MediaGalleryModal` into the User Profile "Shared Media" section in **controlled mode** (driven by props, NOT the chat screen's global store — the profile is pushed on top of the still-mounted chat, so the store would double-open). `app/user/[userId].tsx`: added `useConversationE2EE(conversationId)`, a `galleryItems` memo built from the active tab (photos→image / videos→video), `galleryOpenId` state, and a `handleMediaPreview` handler. Tapping a photo/video opens the full-screen swipe gallery (proper per-page E2EE decrypt via `useDecryptedMediaUrl`, Save/Share, counter). Removed the old broken static-`previewUri` modal (it showed a raw `mediaUrl` that is null for E2EE media → nothing opened). Files tab is now tappable too (2b) → `shareMessage` opens the OS share sheet for the document. `MediaGrid.tsx` `onPreview` signature changed `(uri)`→`(item)` and file rows wrapped in a TouchableOpacity. Fixed `MediaGalleryModal` controlled mode to call `doClose` (props `onRequestClose`) instead of the store's `closeGallery` on the X button + hardware back. Lint clean (3 files); web boots to Sign In. ⚠️ Native (expo-video + decryption) — validate on the APK rebuild.
- **#2 Convex backend requirements** compiled & handed to the user for their external web-app Convex team (see BELOW / delivered in chat). All are functions living OUTSIDE this repo (`study/rooms:*`, `messages:addReaction`, `messages.list` group perf) — the mobile app only consumes them.


## iter-390 (Jun 2026): P0 regression fix (link crash) + swipe media gallery (#4)
- **P0 REGRESSION FIX** (`ReferenceError: Property 'onLongPress' doesn't exist`): my iter-389 #2 fix passed `onLongPress` to `LinkPreviewMessage` from inside `BubbleBodyInner`, which didn't receive it → every link message crashed its bubble ("Message couldn't load"). Threaded `onLongPress` through `MediaBubble → BubbleBody → BubbleBodyInner → LinkPreviewMessage`. Link long-press menu now works AND link messages render again.
- **#4 swipe media gallery:** new `src/lib/chat/mediaGalleryStore.ts` (singleton open/close + host-mounted flag) and `src/components/chat/MediaGalleryModal.tsx` (full-screen horizontal paging FlatList of all image/video messages, lazy per-page decrypt via `useDecryptedMediaUrl`, Save/Share toolbar, counter, videos pause when off-screen). Chat screen derives ordered `galleryMedia` from `decryptedMessages` and mounts one `<MediaGalleryModal>`. MediaBubble image tap + video fullscreen now `openGalleryFor(msg._id)` when a host is mounted (falls back to the local viewer elsewhere, e.g. search). Docs unchanged (not in swipe set). Lint clean; web boots. ⚠️ Native swipe — validate on APK rebuild.

### #3 subsequent calls don't reach callee (native, NOT fixed here)
Callee log shows a subsequent ring `notifeeCallWake cancelled` / `native-cancel-ring` while backgrounded (first call connected fine). This is the backgrounded-doorbell native reliability issue (FCM high-priority + notifee full-screen intent being cancelled) — needs full `adb logcat` from a single subsequent call, and likely Kotlin-side work. Caller's "Reached their phone ✓" is technically correct (FCM accepted the token) but the native ring is cancelled before display. Deferred.

, #3 NC auto-on reliability, #4 faster call-end (Convex items ON HOLD)
User asked to HOLD all Convex-backend items → #1 reaction (`messages:addReaction` Server Error) + #3 study-room deferred to a batch the user will assemble. Frontend fixes done:
- **#2 link long-press:** link/partly-link messages render via `MediaBubble → LinkPreviewMessage`, whose inner `TouchableOpacity` had only `onPress` (open URL) and swallowed the bubble's long-press. Threaded `onLongPress` into `LinkPreviewMessage` (and passed it from MediaBubble) → tap opens the link, long-press opens the reply/forward/share/copy menu.
- **#3 NC auto-on state:** the auto-enable gate required `deviceSupportsAdvancedAudioProcessing`, false on some devices where `setEnabled` still works (manual toggle proved it) → NC never auto-engaged and the "Noise" button stayed grey at call start. Rewrote `NoiseCancellationAutoEnable` to try as soon as the NC controller exists and RETRY (~5×/900ms) until `isEnabled` sticks, then stop (respects a later user OFF). Button should now be yellow from call start.
- **#4 faster call-end:** plain remote-participant-drop debounce cut 10s → 3s (deliberate-hangup fast path stays 400ms) so the other side drops in ~3s instead of >10s.
Lint clean; web boots. ⚠️ Native — validate on APK rebuild.

 — "Call ended unexpectedly: Property 'connected' doesn't exist"
REGRESSION I introduced in iter-384 (#5 ringback): `isOutgoingRinging` referenced `connected`, but that expression lives in the OUTER `StreamCallInner` component where `connected` doesn't exist (it's a `CallUI`-only local). During render the dep evaluation threw a `ReferenceError` → the call screen crashed with "Call ended unexpectedly / Property 'connected' doesn't exist" on the caller (ring still fired on the callee because `ringWebrtcCall` runs in `startCall` before the screen mounts). Fixed by using the in-scope `accepted` flag: `isOutgoingRinging = activeCallReady && iAmCaller && !accepted && convStatus === 'ringing'`. Lint clean; web boots. ⚠️ Rebuild APK to confirm calls connect on the caller again.

Also from the same logs (NOT regressions):
- ✅ Callee FATAL Convex desync at cold start STILL occurs but the iter-383 SELF-HEAL fired (`FATAL desync detected → recreating Convex client`) and recovered in ~1.6s — no blank screen. Working as designed.
- "register failed: Aborted" / "notifyPush fail: Aborted" — network request timeouts (AbortController), not code bugs; intermittent connectivity to the backend.
- #3 study-room "not a member / no code" persists — confirmed EXTERNAL Convex (`study/rooms:*`, only `_generated` here); the web-app backend must fix create-room/membership/join-code.

 (reliable) + user toggle
User request: NC on by default, user can turn it off mid-call. The pieces existed (Krisp `NoiseCancellationProvider`, a "Noise" toggle button, auto-enable-on-join) but the auto-enable ran as a single-shot `[nc]` effect that fired BEFORE Krisp's async capability detection resolved, so NC silently never turned on for some devices. Fixed `NoiseCancellationAutoEnable` to read `deviceSupportsAdvancedAudioProcessing`/`isSupported` as primitives and auto-enable EXACTLY ONCE as soon as support resolves (`didAutoEnableRef` guard) — so it reliably turns on, and never re-enables after the user deliberately taps the "Noise" control OFF during the call. Lint clean; web boots. ⚠️ Krisp is native-only — validate on APK rebuild.

 in call
`StreamCallInner.tsx`: when the (weaker-of-both) `connQuality` sits at POOR for >3s while connected, show a "Weak connection — audio may drop" toast (rate-limited once/20s, cleared on recovery) so users know a glitch isn't an app bug. Builds on the iter-382 ConnQualityBars signal. Also converted the ring-delivery wiring to a static import (removed require() lint warnings). Lint clean; web boots.

 + caller "Reached their phone ✓"
**#1 Notification toggle-OFF still showed (Google names) — ROOT CAUSE + robust fix:**
The message displayed with the sender's Google/account name = an OS-rendered `notification`-block push, which Android auto-displays BEFORE the app's background JS runs, so the JS-only suppression in `backgroundTaskSetup` was bypassed. The FCM v1 path already sends messages data-only, but suppression still depended on an OS-display race (and a backend redeploy). Fix = make suppression AUTHORITATIVE server-side:
- Frontend syncs the device's per-type toggles to the backend on register (`useEmergentPush` → `notification_prefs` in `/api/register-push` body) and re-registers immediately when a toggle changes (`app/notifications.tsx` → `reregisterPushDevice`).
- Backend `register_push` persists `notification_prefs` on the `push_tokens` doc; `send_push` now DROPS any recipient token whose `messages`/`groups` toggle is OFF (group vs 1:1 detected via `conversationType`/`channelId`). Tracks `native_token_count` (pre-suppression) so the Emergent-relay-skip gate still fires → a suppressed native recipient gets NOTHING (no data push, no relay banner). Verified end-to-end: 1:1 with messages=OFF → 0 tokens kept; group with groups=ON → delivered.

**Enhancement — caller "Reached their phone ✓":** `/api/calls/ring` now awaits `send_push` and returns `{delivered, token_count}` (callee ring at same instant; only the HTTP response — which the caller doesn't block on — waits). `ringWebrtcCall` records it into a new `src/lib/call/ringDelivery.ts` store (keyed by conversationId); `StreamCallInner` subscribes and shows "Ringing • Reached their phone ✓" while the caller waits — telling them the doorbell landed, curbing the frustrated re-dialing behind #2.
Lint clean; backend syntax OK; ring endpoint returns new fields; web boots. ⚠️ Native — validate on APK rebuild (and REDEPLOY the backend so the prefs/ring changes are live).

 — ✅ blank screen gone (no FATAL in logs), 1:1 chats instant
User rebuilt & tested; the P0 blank/`[CONVEX FATAL ERROR]` did NOT recur and 1:1 chats now open instantly. Fixed this round:
- **#4b Study-room settings "can't type" (frontend, `app/study/rooms/settings/[roomId].tsx`):** the `useEffect` re-seeded `name`/`description`/`aiCanRead` from the LIVE `room` query on every reactive tick, overwriting each keystroke/toggle → inputs felt frozen. Now seeds local state ONCE per room (keyed on room id) and never clobbers in-progress edits.
- **#5 caller hears no ringing (frontend, `StreamCallInner.tsx`):** the Stream call screen never wired the existing native ringback (`InCallAudio.startRingback()` → bundled Smilers theme on the VOICE-CALL stream). Added an effect that plays it while `isOutgoingRinging` (caller + not connected + convStatus==='ringing') and stops on connect/end.
- **#6b other party stuck ~30s on "connecting" after remote ends (frontend, `StreamCallInner.tsx`):** the remote-left teardown used a flat 10s ICE-grace debounce. Now if the remote left AND the call record shows ended/declined/cancelled/missed (= deliberate hangup), it ends in 400ms; a plain participant drop with no ended-status keeps the 10s grace. Remote-present guard still prevents a ring-TTL from killing a live call.

- **#2 caller double-fire (frontend, `src/lib/twilio/startCall.ts`):** the caller placed two calls ~10ms apart (double-tap/double-render), and the receiver log showed the first ring `notifeeCallWake cancelled` right when the 2nd dial started, with subsequent dials never reaching the callee. Added a 3s per-conversation start dedup. (The deeper "backgrounded app doesn't ring / no missed-call" FCM-doorbell reliability still needs paired backend+device logs.)

**Deferred / not fixable here:**
- **#4a/#4c/#4d Study-room Server Errors** (`submitRoomQuizAttempt`, "not a member", join-code not generated, `removeMember`) — these are EXTERNAL Convex functions (`study/rooms:*`; only `_generated` exists in this repo). The user's web-app Convex backend must fix them.
- **#6a self/remote video mutually exclusive** — two simultaneous video tracks don't render on the WebRTC-legacy fork; needs the Future Task-1 Stream-SDK-native migration (or a Stream support ticket). iter-382 already fixed the background-black self-view.
- **#3 group conversations spin** — 1:1 is instant (iter-381 FlatList fix); groups are slow because the external `api.messages.list` group query is heavier server-side. Frontend gate is not group-specific; can't profile Convex from here.
- **#1 notification toggle-OFF still shows (with Google names)** — strongly implies the OS/native FCM path auto-displays a `notification`-block push before JS suppression runs; needs backend payload (data-only) or native-service investigation.

 — `[CONVEX FATAL ERROR] Base version … doesn't match version 0`
A fresh device log finally captured the actual cause of "nothing shows / Reconnecting… forever" (only fixable by clear-storage/reinstall): the Convex client logs a FATAL `Base version 1 passed up doesn't match the current version 0` ~1.3s into cold start, after which the singleton `ConvexReactClient` **stops syncing for the whole process** (cached feature rows show, but conversations never load). It's triggered by a `closeAndReconnect` (hardReconnect) racing the initial boot auth-handshake — and `chats.tsx`'s `chats-empty-with-cache` recovery fires exactly that within ~1s of boot. A process restart "fixes" it only because it builds a new client.
**Fixes:**
1. **SELF-HEAL (the game-changer) — `ConvexClientProvider.tsx` rewritten:** the client now lives in state; a global `console.error` watcher detects the FATAL marker and swaps in a brand-new `ConvexReactClient` (bumping a `key` to fully remount + re-subscribe), which re-authenticates with the still-valid token. This turns an uninstall-level bug into a ~1s automatic recovery. Debounced (max 1 recreate / 5s) so it can't loop. Exposes `recreateConvexClient()`.
2. **STOP THE TRIGGER — `useConvexAutoReconnect.ts`:** `forceConvexReconnect` now refuses the hard `closeAndReconnect` for the first 8s after a client is (re)created (`FORCE_HARD_BOOT_GUARD_MS`), so the early auto-callers (chats-empty-with-cache etc.) can't race the handshake. Soft reconnect still runs.
3. **`(tabs)/_layout.tsx`:** me-stall watchdog moved 6s/14s → 9s/16s so its hard reconnect fires *past* the 8s boot guard and actually recovers a stale-token stall.
4. **`ConnectionStatusBanner.tsx`:** "Retry" now escalates to `recreateConvexClient()` if still disconnected 3.5s after a manual retry (belt-and-braces for any fatal the auto-watcher missed).
Lint clean; web boots. ⚠️ Native/session — validate on the APK rebuild; a fresh log should now show `FATAL desync detected → recreating Convex client (self-heal)` instead of a permanent blank.

 + in-call connection-quality indicator
Both in `src/components/stream/StreamCallInner.tsx` (NATIVE-only → validate on APK rebuild):
- **#4 (self-view appears then disappears):** the local camera track is released by WebRTC on app background (worsened by the AppState churn from iter-380) and can drop during the SFU renegotiation right after join, leaving the self-view black/gone until the user toggled camera off+on. Added two idempotent re-assertions of `call.camera.enable()`: (a) ~0/600ms after `connected` while `videoMode && camOn`, and (b) on every AppState `active` transition while video is wanted (re-acquires the camera released while backgrounded). Added `AppState` to the RN import.
- **Enhancement — connection-quality indicator:** new `ConnQualityBars` (3 signal bars + Poor/Good/Excellent label, colour-coded) rendered top-left whenever `connected && !inPiP`. Reads Stream's per-participant `connectionQuality` (1 poor/2 good/3 excellent) and shows the WEAKER of remote/local so the user gets an honest WhatsApp-style signal. Non-overlapping with the centered top bar.
Lint clean; web boots (Stream tree is native-only, so the indicator/self-view only appear on a device build).

 + unresponsive back button (JS-thread freeze on mount)
Root cause: the chat message list (`app/chat/[conversationId].tsx`) is a **non-inverted `FlatList` that `scrollToEnd`s on mount** with NO virtualization limits (`getItemLayout`/`windowSize`/`initialNumToRender` all unset). To reach the bottom on open it rendered every row synchronously, blocking the JS thread for seconds → "doesn't load instantly" + back button/controls unresponsive right after opening. Messages are paginated to 50 and `ChatMessageRow` is already `React.memo`, so the fix is bounding the render window. Added `initialNumToRender={12}`, `maxToRenderPerBatch={10}`, `updateCellsBatchingPeriod={50}`, `windowSize={11}`, `removeClippedSubviews` (Android). Lint clean. ⚠️ Native perf — validate on the APK rebuild.

## iter-380 (Jun 2026): P0 — "Nothing shows" / blank-screen reconnect storm (root cause from device logs)
Two device diagnostic sessions pinpointed the recurring blank-screen bug:
- **Session 1 (permanent blank):** the app flapped `AppState active↔background` every 1-2s. `app/(tabs)/chats.tsx` fired `forceConvexReconnect` (→ `closeAndReconnect`) on EVERY `active` with no cooldown → the Convex socket was torn down faster than it could re-auth/load → `me`/conversations NEVER resolved → permanent blank until storage cleared. The same churn perpetually re-armed the 12s `SETTLE_WINDOW` in `useConvexAutoReconnect`, so the heartbeat auto-recovery never ran either.
- **Session 2 (cold-start ~33s blank):** with a stale cached id_token, Convex authenticated with the expired token → queries returned empty; the token only rotated when a reconnect finally forced `fetchAccessToken(force)` at ~33s (`getFreshIdToken force=true refresh OK` right before `me` resolved). AuthProvider refreshes silently but the Convex auth memo is (intentionally) stable across rotations, so Convex is never told about the fresh token.
**Fixes (all app-side, native-validated):**
1. `chats.tsx` foreground reconnect now only fires on a GENUINE resume (backgrounded ≥ 3s) and is rate-limited (20s cooldown) — spurious sub-3s flaps are ignored, killing the reconnect storm.
2. `useConvexAutoReconnect` only re-arms the settle window on a genuine resume (bg ≥ 3s), so the heartbeat recovery can run during any residual churn.
3. `app/(tabs)/_layout.tsx` cold-start watchdog: if `me` hasn't resolved 6s/14s after auth, fire one `forceConvexReconnect('tabs-me-stall')` — cuts the stale-token blank window from ~33s to seconds.
Lint clean; web boots to Sign In. ⚠️ Native/session behaviour — requires the user's APK rebuild + a fresh device log to confirm the blank state is gone. Did NOT touch the OIDC flow or the Convex auth memo (both fragile — prior loops documented in iter-315/316).



## iter-374 (Jun 2026): Study Materials — Bible & Quran reader (Phase 1)
First half of the big feature (per user: freely-licensable content now, ESV/NIV/NKJV later with a licensed key; scroll-sync over the Stream call data channel). Read-alone works everywhere; "read with all" sync is NATIVE-only (needs a live Stream call).
- **Backend proxy** (`server.py`): `GET /api/bible/chapter?translation&book&chapter` (getbible.net v2, public-domain), `GET /api/quran/surahs` + `GET /api/quran/surah?number&edition&with_arabic` (alquran.cloud). 24h in-memory cache. Added top-level `import time`. Verified via curl (KJV John 3, 114 surahs, Al-Faatiha Arabic+translation).
- **Versions/languages:** Bible — English KJV, French Louis Segond, Spanish Reina-Valera, Italian Riveduta, German Schlachter, Portuguese Almeida; **Asante Twi shown but disabled ("not available yet")** since no reliable public-domain source. Quran — en.sahih/fr.hamidullah/es.cortes/it.piccardo/de.aburida/pt.elhayek, paired with Arabic (quran-uthmani). ESV/NIV/NKJV deferred (need API.Bible key).
- **Client:** `src/lib/scripture/api.ts` (config + fetch + static 66-book list), `src/lib/scripture/sync.ts` (`useScriptureSync` — leader broadcasts `{material,translation/edition,book/chapter/surah,scrollPct}` via the active Stream call's `sendCustomEvent`; followers apply + scrollTo), `app/study/scripture.tsx` (mode chooser Read alone / Read with all → version/book/chapter or surah pickers → verse/ayah reader, throttled scroll broadcast). Route registered in `_layout.tsx`.
- **Entry point:** a "Materials" (book) button in the Study Room header (`app/study/rooms/[roomId].tsx`) → Bible/Quran chooser.
- **Verified on web:** Bible (John 3, KJV) and Quran (Al-Faatiha, Arabic+English) both render via the mode chooser. Lint clean.
NEXT (Phase 2, user choice "a then b"): Group-call orchestration (#2 a–e) — needs the user's EXTERNAL Convex contract (they will confirm admins + add-member mutation); I'll define the exact Convex mutations/queries/fields and build mobile UI + FastAPI relay against it.



## iter-373 (Jun 2026): Voice Typing — local-language commands + "Send to…" per note
- **#2 Local-language voice commands:** expanded the prompt keyword matcher (`app/study/voice-typing.tsx`) with Akan/Twi (awie, kɔ so, aane, daabi…), French (fini, continuer, oui, non), Hausa (an gama, ci gaba, a'a), and Ewe/Ga terms, alongside English. Refined finish-vs-continue disambiguation using a "strong finish" set to avoid overlap with shared yes/no tokens.
- **#3 "Send to…" per saved note:** each history note now has a **Send** action → Alert menu with "Ask Study AI" (routes to `/study/session?q=…`), "Save to Diary" (routes to `/diary?prefill=…`), and "Share…" (OS share sheet). Wired the receivers: `study/session.tsx` now seeds its input from a `q` param; `diary.tsx` seeds its composer draft from a `prefill` param.
Lint clean (only pre-existing warnings); web bundle builds; screen renders. Still NATIVE-only for the actual dictation.



## iter-372 (Jun 2026): New feature — Voice Typing (Study AI)
Added a "Voice Typing" card in the Study AI grid **right after Study Rooms** (`app/study/index.tsx`, free), route `app/study/voice-typing.tsx` (registered in `_layout.tsx`). NATIVE-only (on-device speech recognition + TTS) → validate on the APK rebuild.
- **Live word-by-word dictation** via `expo-speech-recognition@56.0.1` (installed; AndroidManifest already had RECORD_AUDIO + the `com.google.android.googlequicksearchbox` speech `<queries>`, iOS Info.plist already had NSMicrophone/NSSpeechRecognition usage strings — so no native edits needed; module autolinks at build time). `continuous:true, interimResults:true, addsPunctuation:true`, auto language-detection on Android (no forced `lang`).
- **10s-pause flow:** a watchdog tracks last-speech time; after 10s of silence it stops dictation and a **device-TTS** prompt (`expo-speech`) asks "Finished or continue?" → **Finished** speaks "Copy to clipboard?" then either copies (`expo-clipboard`) + saves, or just saves; **Continue** puts the session ON HOLD (transcript kept) until the user taps Resume, and the 10s cycle repeats. Responses work via **buttons AND voice** (keyword match on a short one-shot recognition during each prompt).
- **History:** every finalized note is persisted on-device (`src/lib/voiceTyping/historyStore.ts`, AsyncStorage `voice_typing_history_v1`) and is always copyable (per-note Copy + delete). User choices honored: both/live/device-TTS/auto-detect+notify-if-unavailable/persist.
- **Reliable-language handling:** `error` event `language-not-supported` → in-screen notice "This language isn't available for voice typing"; also handles not-allowed/network. Permission flow follows the contextual contract (check → request → Open Settings on permanent denial).
Lint clean; web bundle builds; the screen renders (shows "Needs a device build" on web since recognition is native-only).



## iter-371 (Jun 2026): App Lock interrupting calls + app-wide keyboard-covers-input fix
Two pre-build bug fixes (both need the APK rebuild to validate — App Lock is native-call-only; keyboard-controller is a native module):
- **#1 "Lock when leaving" interrupted calls:** `AppLockGate` already suppresses the re-lock while `callActivity.isActive()`, but with the new Stream architecture the `/call/[conversationId]` route is just a SHIM that immediately pops itself (`call-shim pop → back()` seen in logs) — so its `callActivity.enter()` disposer fired while the real call kept running in the root-level `CallHost`, dropping the guard. Fix: register `callActivity.enter()` inside **`CallHost.tsx`** (keyed on an active call, `!!params || mounted`), which stays mounted for the ENTIRE call for both Stream and legacy paths. `callActivity` is ref-counted so this composes safely.
- **#2 Keyboard covered TextInputs across the app:** root cause was the SDK 54 edge-to-edge + newArch combo — every screen used RN's `KeyboardAvoidingView` with `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`, i.e. **behavior `undefined` on Android → no-op**, and `adjustResize` alone doesn't inset under edge-to-edge. Fix per the `expo-keyboard-experience` skill:
  - Installed `react-native-keyboard-controller@1.18.5` and wrapped the root (`app/_layout.tsx`) in `<KeyboardProvider>` (inside GestureHandlerRootView, above SafeAreaProvider).
  - Swept **26 screens** (diary, study/*, ai-chat, devotionals/compose, status-compose, chat-once, templates, scheduled, conference-create, phone-verify, change-phone-number, find-by-phone, languages, help, app-lock, index, status-view, (tabs)/ads|contacts|profile, GiphyPicker, AppLockGate) to import `KeyboardAvoidingView` from `react-native-keyboard-controller` and use `behavior="padding"` (works cross-platform, incl. Android edge-to-edge).
Lint clean (only pre-existing warnings; the GiphyPicker:287 unescaped-quote is pre-existing and Metro/Babel doesn't run ESLint). Web bundle builds & boots to Sign In.



## iter-370 (Jun 2026): Fixes from device logs — join latency, voice-camera, group tone, #9 diagnostics
Diagnostic logs proved `call.join()` itself was taking **34–57s** (`join=57672ms` / `34444ms`; client-ready was <1.5s). Root cause = Stream's SDK retrying join **3× with exponential backoff** on a flaky edge. All NATIVE-only → validate on APK rebuild.
- **Latency (New #1 + #3 delay):** rewrote the join in `StreamCallInner.tsx` to `join({ ..., maxJoinRetries: 1 })` wrapped in a **14s watchdog**; on timeout/fail it retries ONCE with a fresh call object (new edge often connects instantly). Worst case ~28s instead of 57s, and the End button is no longer starved by the 3-retry native storm. Added `attempt=` to the timing diagnostic.
- **New #2 (voice call shows own video):** device state is now pre-set BEFORE `join()` — `microphone.enable()` + `camera.disable()` for voice (Stream's 'default' call type otherwise publishes video on join). Also helps #5 by enabling the camera pre-join for video calls.
- **#8 (group tone still universal):** likely an immutable stale Android channel. Bumped the notifee group channel `groups-v4 → groups-v5-group_notification` (fresh channel with `group_notification` sound) in `notifeeMessageDisplay.ts` + backend `channelId`. Also made the expo-notifications FALLBACK path in `backgroundTaskSetup.ts` use the group channel/sound for group messages (previously hardcoded the message channel → message tone whenever the notifee grouped path wasn't taken).
- **#9 (toggle doesn't suppress):** confirmed the active renderer is `backgroundTaskSetup.presentBackgroundLocalNotification` (the `usePushNotifications.ts` copy is dead/unused; native forwards messages to it via `super.handleIntent`). Suppression logic is correct and placed before both render paths; added explicit diagnostics (`pref messages=ON/OFF group=… `) so the next device log shows whether the toggle read fires. Foreground bails for non-call, so only background/killed messages are suppressible (expected).
- **#2 resolved, #6/#7 resolved** (confirmed by user). **#4 interpreter** still blocked on the user's external Convex.
Lint clean; backend loads; web boots.



## iter-369 (Jun 2026): Live in-call roster-change toasts
`StreamCallInner.tsx` now surfaces transient toasts to EVERY participant when the call roster changes (NATIVE-only → validate on APK rebuild):
- The 5s roster poll diffs successive snapshots (`prevRosterRef`): a new identity → "{name} joined the call"; a vanished identity → "{name} left the call". Because the diff is driven by the shared backend roster, all participants see the change without extra signalling.
- The acting user also gets an immediate optimistic toast: "You added {name}" (on add) and "You removed {name}" (on remove).
- Toast renders as a top-centered pill (auto-dismiss 3.5s, `zIndex 60`), hidden in PiP/mini. Lint clean; web boots.



## iter-368 (Jun 2026): Stream call — "Remove participant" (adder-only)
Added removal to the in-call roster with the rule **only the person who added a participant can remove them** (NATIVE-only → validate on APK rebuild):
- **Backend `POST /api/calls/remove-participant`** (`server.py`): loads the target's `twilio_call_participants` roster entry, **403s unless `requester_identity == entry.added_by`**, deletes the roster entry, then fires a silent `type='call-removed'` control push (with `stream_room`) to the removed device. Added `call-removed` to `send_push`'s `is_silent_control` set so it's data-only (no banner). Verified via curl: non-adder → 403, adder → 200, participant dropped from roster.
- **Client `removeStreamParticipant()`** in `twilioApi.ts` (surfaces a friendly message on 403).
- **`StreamCallInner.tsx`:** the roster modal now shows a red remove (⊖) button on a row **only when `entry.addedBy === myId`**; tapping confirms then calls the endpoint and refreshes the roster. `RosterRow` extended with an optional `onRemove`.
- **On-device kick handling (`usePushNotifications.ts`):** both the background handler and the foreground receiver now consume `type='call-removed'` — if the current `callHost` room matches `stream_room` (or no room set), they call `callHost.end()` so the removed user leaves immediately. Silent (no banner).
Lint clean (only pre-existing warnings); backend loads; web boots to Sign In.



## iter-367 (Jun 2026): Call + notification bug batch (7 fixed, 2 flagged)
All call/push behaviour is NATIVE-only → the user must rebuild the APK to validate end-to-end. Fixed this round:
- **#2 Wrong caller name on receiver (Google/account name):** the incoming AND connecting screens in `StreamCallInner.tsx` rendered the raw push `displayName` instead of `resolvedPeerName` (device-contact name). Both now use `resolvedPeerName` (caller side still falls back to the dial-time name).
- **#3 Ghost call — caller ends during ringing but callee keeps ringing & connects:** added an effect in `StreamCallInner` that closes the callee's incoming UI (`callHost.end()`) when `convStatus` flips to ended/declined/missed/cancelled *before* accept, so they can't answer a dead call. (Only explicit status closes it — transient WS null does not, to avoid false closes.)
- **#5 Self-view not visible unless remote video off + make draggable:** self-view now has `zIndex:55, elevation:14` so it renders above the remote native video surface (Android z-orders surface views above plain views otherwise), and is draggable via `PanResponder` + spring snap-to-screen-bounds.
- **#6 "Turn off video" pill overlapped the translation panel:** moved `videoPill` from `top:100` → `top:156` (clears the interpreter banner).
- **#7 No in-app ringtone when receiver is on the app:** `StreamCallInner` now calls `useRingtonePlayer(isIncomingPending, {vibrate})` — the foreground Stream incoming UI was silent (Accept/Decline shown, no tone).
- **#8 Group notifications showed the sender's name (not the group) + used the 1:1 tone:** the chat screen always sent `title = senderName`. Now for groups it sends `title = groupName`, `body = "Sender: message"`, `conversationType:'group'`, and new `conversationName`. `notifyPush.ts` + backend `NotifyEventBody` carry `conversation_name`; backend already routes groups to the `groups-v4-group_notification` channel (own tone). Verified via curl.
- **#9 Notification toggle didn't suppress:** `backgroundTaskSetup.presentBackgroundLocalNotification` now consults `isNotificationTypeEnabled('messages'|'groups')` and returns early (suppresses the banner) when the user turned that type off.

**Still open (need native investigation / external, flagged to user):**
- **#1 Backgrounded (alive) app shows only a missed-call, doesn't ring** — killed-app rings fine. This is native FCM data-message handling in the Kotlin service when the process is backgrounded-but-alive; needs device logs + native inspection. NOT fixed this round.
- **#4 Live interpreter still failing** — depends on the user's external Convex `callInterpreter.*` functions (blocked on their backend), not fixable in this repo.

Lint clean (only pre-existing warnings); backend loads; web boots to Sign In.



## iter-366 (Jun 2026): Stream call — FIX crash (TDZ) + "Add Participants" (hide/show number) + latency pre-warm
Three things this session (all NATIVE-only for calls → validate on the user's APK rebuild):
- **P0 CRASH FIX (`StreamCallInner.tsx`):** `showVideo` (near the top of `CallUI`) read `callVideoHidden` which was declared ~120 lines LOWER via `useState` → a temporal-dead-zone `ReferenceError` that crashed EVERY Stream call the instant `CallUI` rendered (never surfaced on web since Stream is native-only). Moved the `callVideoHidden` state declaration up beside the other `useState`s. This likely contributed to the "calls spin until missed / don't connect" reports.
- **P0 ADD PARTICIPANTS (1:1 → conference on Stream SFU):** replaced the old `handleAdd` "next milestone" stub with the full flow mirrored from the legacy Twilio screen:
  - Contact picker modal (searches `api.contacts.getContacts`, excludes people already in the call) → **hide/show-number privacy step** → confirm.
  - New backend endpoint **`POST /api/calls/add-participant`** (`server.py`): persists the privacy-aware roster into the SAME `twilio_call_participants` collection (keyed by the STREAM room id) and fires the FCM doorbell ring pointed at `/call/<conv>?streamRoom=<R>&answer=1` so the added person JOINS THE SAME Stream room (Stream's SFU mixes everyone). Whitelisted `stream_room` in the FCM data forwarding.
  - Client helper `addStreamParticipant()` in `twilioApi.ts`; on confirm the adder resolves a valid direct conversation for the callee via `conversations.getOrCreateDirect({otherUserId})` for correct deep-link routing.
  - **Privacy-aware roster** rendered in-call: a "N people" pill → roster modal showing masked/visible numbers via the existing `GET /api/twilio/call-participants` (backend masks per-viewer: only the adder/self see a hidden number). Verified via curl — viewer=adder sees the number, other viewers get `phone_number:null`.
  - `usePushNotifications` call-tap handler now routes a push carrying `stream_room` into `/call/<conv>?streamRoom=…&answer=1`. `StreamCallInner` prefers `params.streamRoom` as the room to join (added participants have no Convex ring record for the adder↔them conversation).
- **P1 LATENCY (safe pre-warm):** `StreamCallInner` now kicks off `createStreamVideoClient()` on MOUNT (cached in a ref) in parallel with the Convex ring round-trip that resolves the room id, so `join()` no longer pays the client-create cost after accept. Existing ring→connect telemetry retained.
Lint clean on all changed files (only pre-existing warnings); backend loads; web boots to Sign In. ⚠️ Add-participant ring/join + the crash fix are native-only → require the user's APK rebuild to validate end-to-end.



## iter-364/365 (Jun 2026): "Archived" restyled as a colorful gradient borderline (+ slim divider fallback)
User wanted the Archived row to be colorful/stylish and act as the visual borderline between the feature rows (Smilers AI, Diary, Devotion, Chat Once) and the conversations. `app/(tabs)/chats.tsx`:
- Replaced the plain grey Archived row with a floating `LinearGradient` banner (diagonal `#A855F7→#6366F1→#3B82F6→#14B8A6`, matching the feature-icon accents): frosted translucent archive icon, bold white "Archived" title, "N chats tucked away" subtitle, a translucent count pill, chevron; rounded 18px, side margins, `Shadow.md`. Shown only when `archivedCount > 0` (unchanged behavior). New styles: `archivedBanner/archivedIconWrap/archivedMiddle/archivedTitle/archivedSubtitle/archivedCountPill/archivedCountText`.
- iter-365: when `archivedCount === 0` (banner hidden), a slim 3px gradient line (`featureDivider`) still marks the borderline so the boundary always exists.
Uses `expo-linear-gradient` (already installed). Lint: only pre-existing warnings, no errors. Pure JS/UI — no native rebuild needed; visible after redeploy / via Expo Go once signed in.


## iter-363 (Jun 2026): Notification toggles can't save (`users:updateProfile` Server Error) → moved to LOCAL device storage
Toggling any notification type failed with `Couldn't save "<key>": [CONVEX M(users:updateProfile)] Server Error`. Root: the screen saved `updateProfile({ notifications: {...} })`, but the external Convex `users` schema/mutation doesn't accept/persist a `notifications` field → bare Server Error (same external-schema block noted in iter-353; NOT fixable in the app, and NOT the right place anyway).
**Fix (app-side, no backend needed):** these are PER-DEVICE prefs ("...on this device"), so they now persist in local AsyncStorage.
- New `src/push/notificationPrefs.ts`: `loadNotificationPrefs()`, `saveNotificationPref(key,value)`, `isNotificationTypeEnabled(key)` (defaults all ON), key `smilers_notification_prefs_v1`.
- `app/notifications.tsx`: removed the `updateProfile`/`getCurrentUser`/`safeMutation` Convex path; toggles now load from + save to local storage (optimistic, can't throw a Convex error). `canEdit` no longer requires sign-in; helper text → "Loading your preferences…".
Lint clean. ⚠️ Rebuild to validate on device.
FOLLOW-UP (offered, not yet done): have the push-display layer consult `isNotificationTypeEnabled()` to actually SUPPRESS a type when toggled off (messages/groups/reactions/mentions/statuses — deliberately NOT calls, to avoid ever suppressing rings).


## iter-362 (Jun 2026): RETENTION P0 — WhatsApp-style entry (kill sign-in gates) + fix "No chats yet"
User: >90% of registrants never return; blockers are (1) the "Opening Smilers…" spinner + "Couldn't verify your session" wall forcing re-sign-in (sometimes only fixable by reinstall), and (2) "No chats yet" empty chat/profile as if offline (calls still worked). Root: fragile OIDC (Hercules) session/Convex-auth lifecycle. Backend team confirmed Hercules token lifetimes are NOT configurable; active users (open ≤ every 30 days) stay signed in via silent refresh, so the recurring deaths are a CLIENT bug/UX, and the OIDC authority/client/callback flow must NOT be changed. User decisions: (1a) always open straight in with saved session, remove PIN/biometric App Lock entirely; (2b) fix app-side; (3a) keep one-time first sign-up only.
Changes (all app-side, native-validated):
- **App Lock KEPT (correction):** App Lock stays fully functional — if the user enables PIN/biometric in Settings, it locks as before. It is the ONLY thing allowed to gate tap-and-enter. (An earlier edit wrongly disabled it globally; reverted `loadAppLockState()` to read the stored settings.)
- **Enter instantly (no "Opening Smilers…" gate for returning users):** `app/(tabs)/_layout.tsx` `everReady` latch now flips as soon as `isAuthenticated && hasVerifiedInstall` (a fast LOCAL storage marker) — it NO LONGER waits for the `me` Convex query. Screens tolerate null `me` and fill in reactively.
- **"Couldn't verify your session" WALL DELETED:** removed all three `sessionExpired → AuthRecoveryOrSilent` gate returns and the `AuthRecoveryOrSilent`/`AuthRecovery` components. On `sessionExpired` the app now stays rendered and a background effect silently re-runs `trySilentReauth()` (prompt=none) with backoff (4 attempts). On success `sessionExpired` clears and Convex re-auths → "No chats yet" self-heals.
- **Last-resort reconnect only for TRUE 30-day expiry:** if silent reauth exhausts all attempts AND `me` is still null, show a friendly one-tap `ReconnectPrompt` ("Reconnect to Smilers", re-runs interactive sign-in) instead of trapping the user on an empty screen. This is the only remaining gate and is unavoidable per Hercules' 30-day model.
- **Did NOT touch** the OIDC flow or the refresh internals (already hardened: SecureStore chunking + AsyncStorage fallback for rotated tokens, single-flight refresh dedup, rotation-reuse retry, terminal invalid_grant detection).
Lint: only pre-existing `require()`/array-type/dead-path warnings, no errors. App boots to sign-in on web (no session). ⚠️ Native/session behaviour — requires the user's APK rebuild to validate the returning-user tap-and-enter + "No chats yet" self-heal.
Possible follow-up: make the chat-list empty state distinguish "reconnecting" from "genuinely empty" so a transient Convex WS drop never flashes "No chats yet".


## iter-361 (Jun 2026): Message-notification wiring — trust backend `data.title` (contact name)
Backend agent confirmed message push is now DATA-ONLY (no `notification` block) so the OS no longer auto-displays an account-name banner; the native app must build the message notification itself from `data.title` (backend-resolved device-contact name).
- **Verified the app is ALREADY largely compliant:** `src/push/backgroundTaskSetup.ts` → `presentBackgroundLocalNotification` builds the message notification from the data payload via `notifeeMessageDisplay.displayGroupedMessageNotification` (single stable-id notification per conversation, taps route to `/chat/<conversationId>` via the notifee handlers). The custom Kotlin FCM service forwards non-call/data-only messages to `super.handleIntent`, which triggers the expo-notifications background task that runs this builder in all app states. `getCachedConversationName` returns the DEVICE-contact name (not the account name).
- **Refinement made:** the 1:1 title logic used to ALWAYS override `payload.title` with the local device-cache name. Now it TRUSTS the backend's resolved `data.title` when it's a real name, and only falls back to the local cache when `data.title` is missing/`'New message'`/equal to the account name — so a stale local cache can't override the good contact name, exactly per the backend's "use data.title" contract.
- **No backend change needed** (confirmed by backend agent — nothing to publish).
Lint: only pre-existing `require()` warnings (intentional headless lazy-loads), no errors. ⚠️ Requires a build that RECEIVES the data-only backend push to validate.
NOTE/CONCERN: user reported the previous round's fixes (#3 callee name, #4 video toggle, reactions rename) "did not manifest" — strongly suggests the tested APK did not include the latest agent code. For agent changes to appear in a device build, the app must be REDEPLOYED/published FIRST, then a NEW build generated.


## iter-360 (Jun 2026): Fixed wrong Convex function name for reactions (`toggleReaction`→`addReaction`); interpreter now published
User investigated their external Convex backend and confirmed: (a) the interpreter functions were BUILT BUT NEVER PUBLISHED — now published/live, so #5 translation should work once the user toggles the interpreter ON in-call with a non-`original` voice mode + two languages; (b) the app was calling function names that DON'T EXIST on the backend, which returns a generic "Server Error".
- **FIXED (app-side):** `app/chat/[conversationId].tsx` called `api.messages.toggleReaction` — the real backend function is `messages:addReaction`. This is why message reactions returned a generic Convex "Server Error" for a long time (iter-320 tried varying the ARGS but never the NAME). Renamed the mutation + all call sites to `addReaction` (kept the conversationId + minimal-args retry fallback).
- **No change needed:** `updateProfile` — the app already correctly uses `api.users.updateProfile` (ringtones, photo-privacy, notifications). Its earlier "Server Error" was purely the unpublished-backend issue; now published → notification toggles / ringtone prefs should persist.
- **No change needed (verified):** interpreter paths in the app (`callInterpreter.addUtterance/getForCall/getSubtitles/setForCall`, `callInterpreterAction.speakTranslation`) all match the published module names.
Lint clean; app boots. ⚠️ Reaction fix needs the user's APK rebuild; interpreter + updateProfile should work on the CURRENT build now that the backend is published (no rebuild needed for those two).


## iter-359 (Jun 2026): Device-test round 2 — #3 callee name, #4 video toggle, #1/#2 telemetry, #5 external-Convex
User rebuilt & tested. 5 items reported:
- **#3 (FIXED) callee shows caller's Google/account name instead of device-contact name:** `StreamCallInner` used the launch-param `displayName` for the peer on BOTH sides; on the callee that param wasn't the device-contact name. Added `useDeviceContactIndex()` + `resolveDeviceContactNameFromUser()` — on the CALLEE only, query `api.users.getUserById(callerId)` and resolve the name THIS user saved for the caller in their address book; fall back to the param. Caller side unchanged (already correct). Passed as `resolvedPeerName` to `CallUI`.
- **#4 (FIXED) "Turn off video" now hides the OTHER party's video locally:** previously `toggleCallVideo` broadcast a shared `video-hidden-toggle` custom event so BOTH sides hid video. Per spec (A taps → A's own video stays on, B's video hidden for A until A taps again), made it LOCAL-only: just toggles `callVideoHidden` (which gates the remote `ParticipantView` → avatar) without sending/handling the shared event. Self-view is unaffected. Removed the remote `video-hidden-toggle` handler.
- **#1/#2 (DIAGNOSTIC ADDED) subsequent-call inconsistency + long "Connecting…" spinner that sometimes ends as a missed call even when answered:** hypothesis = caller & callee not landing in the SAME Stream room (room = Convex `getActiveCall._id`; earlier logs showed `join-done` but never `connected`). Added a `streamTiming` STALL telemetry that logs ONCE at 12s if joined-but-not-connected with `role`, `callingState`, remote-count and `room` id, so comparing BOTH devices' logs will confirm a room mismatch. NOT yet fixed — needs the next build's paired logs. (Earlier `join()` latency was 5–9s per logs.)
- **#5 (BLOCKED — external Convex) live translation not working / users hear original language:** the interpreter pipeline runs ENTIRELY on the user's external Convex backend — `api.callInterpreter.addUtterance/getSubtitles`, `api.callInterpreterAction.speakTranslation` (managed AI action), and `setForCall` persistence. It also requires the user to ENABLE the interpreter (default `enabled=false`) and pick a non-`original` voiceMode + speaking/listening languages. Given other external Convex mutations are erroring in the same logs (`updateProfile`, `messages:toggleReaction`), the interpreter Convex functions are the likely failure point — outside this mobile codebase.
Lint clean; app boots. ⚠️ All call/native — requires the user's APK rebuild to validate #3/#4 and to collect #1/#2 STALL logs.


## iter-358 (Jun 2026): Photo/video status "Failed to post status" — expo-image-picker "unregistered ActivityResultLauncher"
**User report (mislabelled as a Convex error):** posting a PHOTO/VIDEO status showed `Failed to post status → Call to function 'ExponentImagePicker.launchImageLibraryAsync' has been rejected → java.lang.IllegalStateException: Attempting to launch an unregistered ActivityResultLauncher`.
**Root cause (NOT Convex):** in `app/(tabs)/updates.tsx`, `pickAndUpload` called `closeSheet()` (hides the `<Modal>` "add status" sheet, L165) and then IMMEDIATELY launched `pickImageLibrary`. On Android an RN `Modal` is a separate window; launching expo-image-picker while that window is still tearing down means the picker's `ActivityResultLauncher` (bound to the Activity, which the Modal window currently overlays/steals focus from) isn't registered yet → the launch is rejected. (App churns background↔active heavily per the log, which makes the focus race easy to hit.) MainActivity is `launchMode="singleTask"` which makes the Activity/launcher lifecycle more fragile here.
**Fix:** after `closeSheet()`, await ~450 ms (past the Modal's fade animation) BEFORE requesting media-library permission + launching the picker, so the Activity regains focus and the launcher is valid. Minimal, targeted; other picker call sites not launched from a closing Modal are unaffected. Lint clean. ⚠️ Native picker — requires the user's APK rebuild to validate.


## iter-357 (Jun 2026): Receiver-side false "caller cancelled" — every incoming ring instantly killed (debounce)
**Receiver diagnostic log (backgrounded device) evidence:** 5 incoming calls (Convex ids `js7…`) each logged `[WAKE] cancelled` + `native-cancel-ring` within the SAME second they arrived, followed later by a `hardReconnect via closeAndReconnect(client)`. `cancelRingAndShowMissedCall` is called ONLY from `useIncomingCallListener`'s background caller-cancel path.
**Root cause:** `src/push/useIncomingCallListener.ts` treated ANY disappearance of the `api.calls.getIncomingCall` reactive result as "caller cancelled" (`stillSameCall === false`). On a backgrounded Android app the Convex WebSocket drops/throttles, so the reactive query transiently returns `undefined`/null — which was misread as a real cancel, immediately cancelling the ring and posting a bogus missed call. This is a SECOND, independent cause of "subsequent calls don't ring" (alongside iter-356's native 60s block).
**Fix:** debounced the caller-cancel detection. When the ringing call goes away it now starts a 5s timer instead of firing instantly; a reappearing ring (WS recovery) clears the timer, and a different ringing call taking over aborts the stale fire. Only a SUSTAINED (~5s) disappearance (genuine caller hang-up) posts the missed call. RING_TIMEOUT is 35s so the 5s delay is invisible. Added an unmount cleanup for the timer. Lint clean; app boots. ⚠️ Native/background behaviour — requires the user's APK rebuild to validate.


## iter-356 (Jun 2026): Call fixes from device test — (a) subsequent calls, (b) wrong middle name, (c) video toggle
Device diagnostics (build with iter-354/355) confirmed: caller now sends a UNIQUE ring callId per attempt and joins a fresh Stream room each call, BUT calls 2 & 3 reached `join-done` and never `connected` (callee never joined). Connect latency ~6–9s (Stream `join()` is the slow part; client pre-warm confirmed fast at ~0.4–0.6s).
- **(a) TRUE root cause — native `cancelledConvIds` 60s block (`android/.../SmilersCallNotificationService.kt`):** when a call ends, `handleCallCancelledMessage` added the **conversationId** to `cancelledConvIds` for **60 s**; `handleCallMessage` (L848) suppresses any ring whose convId/callId is in that set. So every re-call to the same person within 60 s of the previous one ending was silently dropped (matches the log: calls 2 & 3 were ~20 s and ~50 s after call 1 ended). Fix: shortened the window 60 s → **8 s** (out-of-order FCM delivery races resolve in ~2–3 s, so 8 s still catches a late ring while letting a genuine re-call ring almost immediately; unique per-attempt callIds prevent cross-call collisions).
- **(b) wrong name in the middle ("Smilers" = Google/account name):** `StreamCallInner.tsx` rendered `<ParticipantView>` whenever `showVideo` was true even with NO real remote video track, so Stream's built-in ParticipantLabel/VideoFallback drew the Stream ACCOUNT name. Fix: only render `ParticipantView` when `remoteHasVideo` is truly present, pass `ParticipantLabel={null}` + `ParticipantVideoFallback={null}`, and otherwise show our own avatar + `peerName` (the device-contact name, e.g. "ABC Albania"). Same guard applied to the topBar.
- **(c) "Turn off video" visible but not functioning:** the pill showed on voice calls (gated on `videoMode||remoteHasVideo`) where there's no video to hide → looked broken. Re-gated to `remoteHasVideo || (videoMode && camOn)` so it only appears when real video is present; toggling now actually swaps the remote video ↔ avatar via `showVideo`/`callVideoHidden`.
Lint clean; app boots. ⚠️ ALL native — requires the user's APK rebuild to validate. Deferred: Stream `join()` connect latency (~6–9s) is a separate optimization (call-type/region tuning).


## iter-355 (Jun 2026): Stream connect-latency telemetry + fixed always-on audio-menu overlay
**Telemetry (user request):** instrument `src/components/stream/StreamCallInner.tsx` to measure the ring→connect timeline via `recordDiagnostic` (tag `CALL`, source `streamTiming`, viewable in Settings → Diagnostic Logs / Call Diagnostics). T0 = the moment the call is accepted/initiated (`accepted` flips true, captured in `acceptedAtRef`). Milestones logged: `client-ready t+Xms` (createStreamVideoClient resolves — measures pre-warm effectiveness), `join-done t+Xms (join=Yms)` (Stream `join()` completes), `connected role=… t+connect=Xms` (CallingState.JOINED + remote participant present = media flowing, logged once from `CallUI`), and `join-fail …` on error. Lets us prove/pinpoint whether the pre-ring spin or the post-answer connect is the slow part on the user's next build.
**Bug fixed (latent):** the audio-output-menu overlay (`styles.audioMenuOverlay`, a full-screen `absoluteFill` TouchableOpacity) was rendered UNCONDITIONALLY — a dangling `) : null}` with no matching `? (` (present in HEAD too). It parsed loosely in Metro but ESLint flagged it, and the always-mounted absoluteFill overlay would intercept touches. Wrapped it in `{audioMenuVisible ? ( … ) : null}` so it only shows when the audio-route button is tapped. Lint clean; app boots to Sign In. ⚠️ Timing values only appear on a native build (Stream is native-only).


## iter-354 (Jun 2026): P0 — subsequent calls to the same person don't ring (TRUE root cause + fix)
**Symptom:** calling the same conversation a 2nd/3rd time (esp. within a session) doesn't ring the callee until the app process restarts.
**Prior misdiagnosis:** a "10-minute backend dedup on `twilio-call:{conversation_id}`". That 600s window lives in `_is_duplicate_push`, which is ONLY used by `/api/send-push-internal` + `/api/notify-event` — NOT by the active ring path. The current call engine is Stream UI + a legacy FCM wake-push (`EXPO_PUBLIC_USE_TWILIO=0`), so the ring goes `startCall` → `ringWebrtcCall` → `POST /api/calls/ring` → `send_push` (which does not call `_is_duplicate_push` at all).
**TRUE root cause:** the frontend sent **`call_id = conversationId`** (a STABLE id) on every ring. Both the backend semantic call-dedup (`_recent_call_push_to_user`, keyed by `callpush:<user>:<callId>`) AND the native Android `SmilersCallNotificationService.kt` / `backgroundTaskSetup.ts` (both keyed by `callId`) therefore treat every repeat call to the same conversation as a duplicate of the first ring and swallow it (native dedup map only resets on process death → "only works again after restart"). This matches the intent already written in `streamCallActions.ts`: "Random, per-attempt call id so every call attempt is distinct".
**Fix (small, 2 lines of logic):**
- `src/lib/twilio/twilioApi.ts` `ringWebrtcCall`: now generates a UNIQUE per-attempt `call_id` (`call_<ts>_<rand>`) instead of hardcoding `args.conversationId`. `conversationId` is still sent (routing/join unchanged) so answering the call still keys off it.
- `backend/server.py` `webrtc_ring`: `idempotency_key` now uses the unique `call_id` (`twilio-call:{call_id}`) instead of `twilio-call:{conversation_id}`.
**Verified:** two consecutive `/api/calls/ring` to the SAME conversation with distinct `call_id`s both return `scheduled:true` and both dispatch independently in backend logs (no "all call tokens deduped"); frontend lint clean. ⚠️ Full ring behaviour (native FCM + ConnectionService "Ashwini's doorbell") requires the user's Android APK rebuild to validate on device.


## iter-353 (Jun 2026): Notification toggles snap back — optimistic UI + surface the real error
User reported every toggle on the Notifications screen reverts to ON when switched off. `app/notifications.tsx`: the toggle wrote to Convex `api.users.updateProfile({ notifications })` then refetched, but silently swallowed any error and had no optimistic state, so a rejected/ignored write made the `Switch` snap back. Changes: (1) optimistic local `overrides` so the switch holds its chosen position during the round-trip; (2) on failure, revert precisely AND show a yellow inline error banner with the real server message (previously only `console.warn`). ROOT CAUSE is server-side: `updateProfile`/`getCurrentUser` are Convex functions in the SEPARATE web-app repo (this app uses `anyApi`), so the mobile app can't change whether the `notifications` field is accepted/persisted/returned — the new error banner will confirm whether the write is rejected (error shown) or silently dropped (snaps back with no error → server not storing/returning the field). Lint clean; bundle builds. Needs rebuild to observe the banner.


User request: turn OFF Asante Twi voice/video transcription + translation (unreliable) until a better Twi speech engine is found; keep all other languages and keep Twi TEXT translation. `backend/server.py`: added `ASANTE_TWI_AUDIO_ENABLED = False` flag + `_twi_disabled_transcription()` helper. Both `/api/transcribe` and `/api/transcribe/upload` now, when the source language hint is Akan/Twi (`_hint_is_akan_twi`), return an EMPTY transcript instead of routing to the Gemini Twi path — so no unreliable Twi text/translation is produced and the voice note just sends as plain audio. The Gemini Twi code is left fully intact; flip the flag back to `True` to reactivate. Verified: `language_hint=ak` → `{"text":"","language":"ak","segments":[]}`; `language_hint=en` → still routes to Whisper. Backend-only change → user must REPUBLISH the backend (no app rebuild needed for this).


User goal: reliable, feature-complete calling at scale. Committed to Stream (SFU/global edge = the scalable choice; P2P WebRTC can't scale). Work in `src/components/stream/StreamCallInner.tsx`:
- **Fixed the ~1-minute drop (root cause):** the screen hung up whenever the Convex ring record flipped to `ended` — a ring-TTL (~60s) was killing CONNECTED calls. Now Convex `ended/declined` only ends the call DURING the ring phase; once media is connected the Stream session is authoritative. The "remote left" hangup is debounced 10s so a transient ICE reconnect (remote momentarily 0 participants) no longer drops the call.
- **Mirrored the full WebRTC control set** into a labeled grid (reusing legacy `ControlBtn` + `AudioOutputMenu`): **Mute, Noise (NC toggle), Audio route** (earpiece/speaker/bluetooth via `InCallAudio` — Stream RN doesn't manage RN audio routing itself), **Screen** share, **Add** (shows "group calling is next milestone"), **Video** = voice→video upgrade mid-call (`call.camera.enable()`; peer sees our track via SFU) / camera+flip when already video, **Minimize** (mini window), **Pop out** (system PiP `enterPiPAndroid`), big red **End**. Plus the already-added Interpreter layer + Call-waiting banner.
- Voice→video and peer-initiated video are both detected (`showVideo = videoMode || remoteHasVideo`).
- Reliability levers already in place: Stream client PRE-WARM at sign-in (connectUser + WS) and single round-trip `join({create:true})` to cut the connect spin.
- **Only "Add participant" (1:1→group/conference) is deferred** — it's the legacy mesh/conference system and is the roadmap's next milestone (migrate group/conference to Stream SDK).
Lint clean; web bundle builds (2695 modules). ⚠️ Native-only — requires the user's rebuild to validate the drop fix + all controls.


`app/share-receiver.tsx`: added a **Chats | Groups** tab bar to the "Share to Smilers" screen so users can share files/text into groups too. Chats tab = Diary + recent DMs + contacts (frequently-shared pins) — groups now excluded here; Groups tab = every group the viewer belongs to via the authoritative `api.conversations.listGroups` (merged with any group rows from recents as a fallback), searchable, with member-count subtitles. Send/upload path is unchanged (groups already have a conversationId). Lint clean, web bundle builds. Native-only screen (real OS share intent) → verify on the next build.


Regression from iter-348 call-waiting: `useMemo` was used in `StreamCallInner.tsx` (waitingCall) but missing from the React import, so every call immediately hit "Call ended unexpectedly / Property 'useMemo' doesn't exist". Added `useMemo` to the import. Lint clean, web bundle rebuilds. ⚠️ Needs a rebuild to confirm calls now proceed on device.


All in `src/components/stream/StreamCallInner.tsx` (native-only; validate on a real build):
- **(a) Screen-share:** `useScreenShareButton(ref, …, { type: 'inApp' })` (Android uses the system MediaProjection dialog — FG service already wired via withWebRTCScreenshare; iOS in-app, no broadcast-extension target needed). Added a screen-share toggle button (tv/stop icon) to the controls row (now `flexWrap`), and full-screen rendering of the shared track via `<ParticipantView trackType="screenShareTrack" objectFit="contain">` using `useHasOngoingScreenShare()` + the sharing participant from `useParticipants()`. Top bar shows "You/<peer> are sharing".
- **(b) Live interpreter:** reused the existing self-contained `<InterpreterLayer>` (Convex-backed banner + live subtitles + AI menu). Passed the shared Convex `callId` down to `CallUI` so both sides' subtitles sync; `micMuted` from mic state; `onDuckRemote` best-effort (`remote.setVolume`), degrades to layered audio. Hidden during screen-share and PiP.
- **(c) Call-waiting (WhatsApp-style):** subscribes to `api.calls.getIncomingCall` only while connected; filters out own/current/screen-share calls; plays a one-shot double-beep (`InCallAudio.playCallWaitingTone`) + double warning haptic per new call; shows a top banner with the caller name + **End & Accept** / **Decline**. Accept = `endCall(current)` + `call.leave()` + `callHost.start({conversationId, type, displayName, answer:'1'})` (switches host, auto-answers). Decline = `declineCall`. (True concurrent hold deferred — WhatsApp also ends-to-switch.)
- **(d) System PiP (Android):** manifest already has `supportsPictureInPicture` + `resizeableActivity`; added `useAutoEnterPiPEffect(false)` (auto-enters PiP when the app backgrounds mid-call) + `useIsInPiPMode()` → in PiP we render ONLY the remote video/screen-share, hiding the top bar, self-view, controls, interpreter and waiting banner.
Also (this session): NC toggle button surfaced in-call; Stream client pre-warm at sign-in + single round-trip join (latency); message push now threads senderPhone/senderId/conversationType (group name/tone). Lint clean; web bundle builds (2695 modules). ⚠️ ALL of Task 2 is native-only → requires the user's rebuild to validate; core 1:1 Stream stability still pending device confirmation.


## iter-347 (Jun 2026): Message-notification device-name fix (senderPhone through sender-side push) + group tone
**Evidence:** user's sender-device log showed our own `notifyPush event=message` path firing (Convex triggers absent), for both a 1:1 (`jd7be0…`) and a group (`…zzjm`). Message pushes are already data-only (action_url `/chat/` → type message), so 1:1 names resolve via the cached conversation name — but GROUP messages had no way to resolve the SENDER's device-contact name (cache holds the group name, and `senderPhone`/`senderId` were never sent) → they showed the sender's Google/account name.
**Fix (all in our code — no Convex dependency):**
- `src/lib/notifyPush.ts`: `NotifyPushOpts` + `/api/notify-event` body now carry `sender_phone`, `sender_id`, `conversation_type`.
- `app/chat/[conversationId].tsx`: `pushNotifyCtxRef` now captures the sender's phone (`me.phoneE164/phone`), Convex id, and group/direct type; `sendMessage` forwards them to `notifyEventPush`.
- `backend/server.py`: `NotifyEventBody` accepts the 3 new fields; the MESSAGE branch now sets explicit `type:'message'`, `conversationId`, `senderPhone`, `senderId`, `conversationType`, and for groups `channelId:'groups-v4-group_notification'` (distinct group tone). Added `senderId` to the FCM data whitelist. Verified `/api/notify-event` accepts the fields (202) and server parses clean.
- Receiver already resolves `senderPhone` → device-contact name via the healthy device index (1787 entries), so group + 1:1 message notifications now show the saved contact name and groups get their own tone. ⚠️ Requires REBUILD + republish of the backend to validate on device.


## iter-346 (Jun 2026): Stream call connect latency (pre-warm) + visible NC toggle + clear-format confirmed
**Context (user device test on build 2.3.21):** bold/color OK; long "Calling…/Connecting…" spin (seconds before ring, ~1 min to connect after answer); couldn't see call layers/NC; message notifs still Google-name + default tone (but the exported diagnostic session had NO MSG-PUSH/MSG-NAME lines — it was a call-only session, so item 3 is still unconfirmed).
**Fixes:**
- **Call latency (P0, item 4):** the Stream client was created COLD at call time. (a) `app/_layout.tsx` now PRE-WARMS `createStreamVideoClient()` (connectUser + WS + token) as soon as the user is signed in (native only), so the first call skips the cold connect. (b) `StreamCallInner` join reduced from `getOrCreate()` + `join()` (two sequential round-trips) to a single `join({ create: true, ring: false, notify: false })`. Singleton client is reused. Should cut both the pre-ring spin and the post-answer connect time substantially.
- **Visible noise/echo control (item 2):** added a visible NC toggle button (sparkles icon) to the in-call controls, shown only when `deviceSupportsAdvancedAudioProcessing && isSupported`; still auto-enables on join. Confirms Krisp NC is active on a real build.
- **Clear-format (item 1):** confirmed working alongside bold/color.
**Item 3 (message name/tone) — still OPEN, root-cause hypothesis:** device contact index is healthy (1787 e164 entries, matches working). Backend classifies a push as a message (→ data-only, JS renders with device name + custom channel) ONLY when it carries `type:'message'` OR `action_url:'/chat/<id>'`. If Convex message pushes carry NEITHER, the relay sends a NOTIFICATION BLOCK on the default `messages-v4` channel → OS renders the sender's Google/account title + default tone (exactly the symptom). Need the actual message push payload to confirm — asked user to receive a message while BACKGROUNDED, then Settings → Diagnostic Logs → copy the `MSG-PUSH` (hasNotifBlock=?) and `MSG-NAME` lines. Fix is then either Convex adding `type:'message'`/`action_url` (web team) or a targeted relay reclassification (only if safe vs emergency/login/broadcast pushes). No blind backend change made.
⚠️ All native — requires the user's next build to validate.


## iter-345 (Jun 2026): Formatting "clear" button + Stream Krisp noise/echo cancellation
**1) Clear-formatting (enhancement):** new `clearInlineFormat(text, selection)` in `chatRichText.ts` strips all rich-text tags from the selected range (or whole message when nothing is selected). Added a `format-clear` (eraser) button to the floating selection bubble in `app/chat/[conversationId].tsx`. Verified via unit test (CLEAR-ALL + CLEAR-RANGE); lint clean.
**2) Noise + echo cancellation (Stream Krisp):** per the Stream RN noise-cancellation playbook —
  - Installed `@stream-io/noise-cancellation-react-native@0.9.3` (autolinked; pulls `StreamVideoNoiseCancellation`).
  - `app.json`: `@stream-io/video-react-native-sdk` plugin now `{ "addNoiseCancellation": true }`.
  - Native processor registration (we NEVER prebuild, so edited committed native directly): `android/.../MainApplication.kt` → `NoiseCancellationReactNative.registerProcessor(applicationContext)` in `onCreate` (try/catch); `ios/Smilers/AppDelegate.swift` → `import stream_io_noise_cancellation_react_native` + `NoiseCancellationManager.sharedInstance.registerProcessor()` in `didFinishLaunchingWithOptions`.
  - `src/components/stream/StreamCallInner.tsx`: wrapped the in-call tree in `<NoiseCancellationProvider>` + a `NoiseCancellationAutoEnable` component that calls `setEnabled(true)` when `deviceSupportsAdvancedAudioProcessing && isSupported` (works for voice + video; degrades silently on unsupported devices).
  - ⚠️ Requires the user to REBUILD (native). If NC does not toggle, the Stream Dashboard call-type "default" noise-cancellation mode must be `available`/`auto-on` (not `disabled`). Web bundle builds; lint clean.
**3) Message-notification google-name + universal-tone (OPEN — needs device diagnostics):** calls now resolve device-contact names because the NATIVE Kotlin call service does the contact lookup from `callerPhone`; messages are rendered by JS (`backgroundTaskSetup.presentBackgroundLocalNotification`) and depend on (a) the push carrying `senderPhone` and (b) the `smilers_device_contact_index_v1` AsyncStorage snapshot. Backend already sends messages DATA-ONLY on `messages-v5-message_notification`. Root cause not yet confirmed — requested the user export the built-in `MSG-PUSH` (hasNotifBlock) + `MSG-NAME` (senderPhone / cachedConvName / account) diagnostic logs to pinpoint whether Convex omits `senderPhone`, a notification block still arrives, or the channel sound isn't applied. No blind changes made (would risk regressing the working call path).
**4) Background (not killed) incoming call not ringing until missed-call at end (OPEN):** user is deferring full verification until all call layers are built; acknowledged, not yet root-caused. Likely a Stream-vs-custom-FCM push interaction or OS Doze delivery of the data-only ring push to a backgrounded-alive process — to investigate with device logs after the next build.


## iter-344 (Jun 2026): Per-selection inline chat text formatting (B / I / U / colour) + live preview
**User request:** highlight part of a composer message and style just that part (bold/italic/underline/colour), with a live preview and a full colour picker; keep the existing global B/colour bar; grid-of-swatches picker; if nothing is selected, apply to the whole message.
**Changes:**
- `src/lib/chatRichText.ts` (rewritten): parser now supports `[i]`/`[u]` (italic/underline) and hex colours (`[color=#RRGGBB]`) alongside legacy `[b]`/named `[color=red]`. New `applyInlineFormat(text, selection, kind)` + `applyInlineColor(text, selection, hex)` wrap the selected range (or whole message when the selection is empty) and return the new caret selection. New `PRESET_TEXT_COLORS` swatch grid (20 hex). Segments now carry `italic`/`underline`. `stripRichTextTags` covers all tags. Backwards-compatible with old whole-message tags.
- `src/components/MediaBubble.tsx`: `RichMessageText` applies `richTextItalic` (fontStyle) + `richTextUnderline` (textDecorationLine) per segment.
- `app/chat/[conversationId].tsx`: composer tracks live `composerSelection` (state) via `onSelectionChange`; new inline-format row (B/I/U + palette toggle) that is selection-aware (falls back to whole message), a grid swatch picker (`showInlineSwatches`), and a live formatted **Preview** block above the input (only shown when the draft contains rich-text tags). Existing global B/colour/list bar kept intact per user.
- `src/components/chat/chatScreenStyles.ts`: added preview + swatch-grid + inline-format styles.
**Verified:** parser/helper unit test passed (nesting, hex + legacy named colour, strip, whole-message fallback); lint clean on all files; web bundle builds; app boots to Sign In. ⚠️ The composer UI itself is OIDC-gated → in-app visual/interaction verification pending the user's signed-in device.


## iter-343 (Jun 2026): CONSOLIDATION — pulled full GitHub `main` (incl. native android/) into this Emergent workspace
Context: GitHub `authenticabc-cloud/Smilers-new@main` became the complete source of truth (my JS features + Ashwini's merged native call code). Emergent Mobile Agent has NO in-project "Pull from GitHub" (push-only), so to let the user keep developing WITH this agent (instead of a fresh imported project), I manually synced the workspace up to `main` via the branch tarball (`codeload.../main.tar.gz`).
- Brought in: `frontend/android/` (69 files incl. 37 binaries — icons/ringtones/keystore/gradle-wrapper.jar, preserved via tarball extract), 2 missing config plugins (`withNativeCallService.js`, `withNotifeeLocalMaven.js`), `index.js` entry (imports `src/push/backgroundTaskSetup` then expo-router), and synced 24 differing/missing source files (`silent-decline.tsx`, convex/_generated/*, push handlers `backgroundTaskSetup/notifeeCallWake/useEmergentPush/useIncomingCallListener/usePushNotifications`, `call/[conversationId].tsx`, `chats.tsx`, `_layout.tsx`, `incoming-call.tsx`, `twilio-call.tsx`, libs, `app.json`, `package.json`).
- `package.json`: only new dep vs local was `expo-dev-client ~6.0.21`; `main` field now `index.js`. `app.json`: adopted main's native config (version 2.2.18, versionCode 2295, newArchEnabled=false, +REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, +2 plugins, +notification sounds). Protected `.env` (EXPO_PACKAGER_*) NOT touched.
- `yarn install` OK (ran Ashwini's postinstall patch scripts: patch-notifee/webrtc/share-intent). Web preview boots to Sign In cleanly.
- RESULT: workspace == main → future work continues in THIS Emergent project, and "Save/Push to GitHub → main" from here is now SAFE (won't clobber native code). My earlier features (receive-once, city/time, personal link, iter-342 ringing ack, search privacy) all present (already in main).
⚠️ Native AAB build correctness can only be verified via an actual Emergent build/deploy (can't run a native Android build from chat); the current code already produced Ashwini's working AAB, so a faithful mirror should build equivalently.


## iter-342 (Jun 2026): Ringing / Not Ringing reachability — stop false "Not Ringing"
**Issue (user):** Caller flips to "Not Ringing" whenever the callee's incoming-call heads-up notification collapses (even though the phone keeps ringing), then back to "Ringing" when the callee opens the app. User wants "Not Ringing" ONLY for true unreachability (airplane / device off / no internet); once the call reaches the receiver it must show "Ringing".
**Root cause:** the callee's reachability ack (`calls.markCalleeRinging` → `calls.calleeRingingAt`) only fired when the full `call/[conversationId]` JS screen mounted. A background heads-up (screen not open) never acked, so after a 7s grace the caller concluded "Not Ringing".
**Fix:**
- `src/push/useIncomingCallListener.ts`: fire `markCalleeRinging({callId})` the moment the GLOBAL Convex reactive query first sees the incoming ringing call (idempotent, once per call), BEFORE the navigation/call-waiting guards. This acks whenever JS is alive (foreground OR backgrounded-not-killed) and also in the call-waiting case → the ack latches `calleeRingingAt`, so a collapsing notification no longer flips the caller.
- `app/call/[conversationId].tsx`: `callerNotRinging` no longer uses the 7s timeout. Now `isOutgoingRinging && !calleeRingingAcked && calleeKnownOffline` — "Not Ringing" shows ONLY when the callee hasn't acked AND presence positively says offline (heartbeat stopped = no connectivity), matching the 3 unreachability cases. All other states stay optimistically "Ringing…"; ack latches it on.
- Removed the now-unused `ringGraceElapsed` state/effect. Lint clean; app boots.
⚠️ Remaining gap (Ashwini/native): a FULLY-KILLED app (swiped away) runs no JS, so the JS listener can't ack — the native FCM/Notifee handler must call `markCalleeRinging` on push receipt for that case. Needs two-device validation.


## iter-323 (Jun 2026): "Receive once" 🔂 — native wiring (dedupe duplicate files per receiver)
Web-team backend contract wired into the Expo app. A receiver never gets the same file twice (across all 1:1 + groups); the duplicate copy shows a tappable footprint; the sender always keeps the file.
- **New helper `src/lib/fileHash.ts`** — `computeFileHashFromUri(uri)` = SHA-256 (lowercase hex) of the file's PLAINTEXT bytes, streamed in 512KB chunks (no OOM on large docs/APKs); web uses fetch→arrayBuffer. Verified against canonical SHA-256("abc").
- **Sending** (`app/chat/[conversationId].tsx`): computes `fileHash` before upload and passes it to `messages.send` for **image**, **video** (gallery + camera), and **file/document**. Voice notes & text are intentionally skipped (backend ignores them). Forwarding already carries the hash server-side.
- **Rendering** (`src/components/MediaBubble.tsx`): when `msg.receiveOnceHidden === true`, an early-return renders a faded, TAPPABLE footprint "file deleted for multiple receipt" (🔁 icon) instead of media (mediaUrl omitted by server).
- **Footprint tap** (`handleReceiveOnceTombstone`): Alert → "View original" (`messages.getReceiveOnceOrigin({fileHash})` → `jumpToMessage` if same convo else `router.push('/chat/<convId>?mid=<msgId>')`), "Allow receipt" (`messages.allowReceipt({messageId})` → refetch → file becomes viewable), Cancel.
- Lint clean (pre-existing MediaBubble rules-of-hooks warning at L270 untouched); app boots. ⚠️ End-to-end (send same file twice → 2nd hidden → reveal/jump) needs signed-in device validation.


## iter-320 (Jun 2026): PRIVACY — People search no longer exposes the whole Smilers directory
**Issue (user, native app):** Searching a name in global Search → "People" tab listed ALL matching Smilers users with a Message button (privacy leak). 
**Fix (`app/search.tsx`, client-side filter on `api.users.searchUsers` results):** the People tab now only shows users the searcher already has a relationship with:
  - (a) someone they've had a **direct conversation** with (`conversationPeerIds` from `listConversations` — direct `otherUser*` only; group membership excluded), OR
  - (b) someone saved in their **device address book**, resolved to Smilers userIds via the canonical `lookupUsersByPhones(convex, myContactPhones)` (same mechanism the Contacts tab trusts — derived from the viewer's OWN contacts, so it works even though `searchUsers` returns only name/email, not phone). Plus a phone-match fallback (`resolveDeviceContactNameFromUser`) if a result ever carries a phone.
  - Self is always excluded. Empty-state copy updated to explain the restriction.
`find-by-phone.tsx` (targeted phone lookup) is intentionally unchanged — you must already know the number. Lint clean; search screen boots. ⚠️ Filtering behaviour needs signed-in device validation (needs real contacts + conversations). NOTE: this is a client-side guard — recommend the web team ALSO restrict `searchUsers` server-side (return only contacts/conversation peers) for defense-in-depth, since the raw query still returns all users.


## iter-319 (Jun 2026): Peer city + local time in the 1:1 chat header
Shows the OTHER user's city and 24h local time between the name and last-seen (e.g. "Rome 14:54 local time"). Web-team contract: new optional `users.timezone` (IANA); `setOnlineStatus` accepts optional `timezone`; `getUserById` returns `timezone`.
- **Send tz:** `src/hooks/usePresenceHeartbeat.ts` now sends `Intl.DateTimeFormat().resolvedOptions().timeZone` with every online heartbeat.
- **Read + render:** `app/chat/[conversationId].tsx` reads the peer timezone (from `getUserById` via `useSafeConvexQuery`, falling back to embedded `otherUser.timezone`), derives label via new `src/lib/localTime.ts` (`cityFromTimezone` = last IANA segment, underscores→spaces, shortened >16 chars; `localTimeInTimezone` = en-GB 24h), ticks every 30s. New header line `chatHeaderCityTime` between title and subtitle. DM-only (broadcast/group excluded; groups have no single peer so tz is null).
- Verified helper output matches spec (Rome 14:54 / Accra 12:54); invalid tz → no label. Lint clean; app boots. ⚠️ Live header only visible signed-in on device; a peer's city/time appears only after they've run this build once (heartbeat populates their `users.timezone`).


## iter-318 (Jun 2026): Personal chat link — `/u/<userId>` + `smilers://chat-with/<userId>`
Every user now has a shareable link that opens a direct chat with them (web-team contract; backend `api.users.getPublicChatLinkPreview` + existing `getOrCreateDirect`).
- **Resolver** `app/u/[userId].tsx`: fetches the safe PUBLIC preview via `useSafeConvexQuery(api.users.getPublicChatLinkPreview)` (error-safe → invalid/unknown/system ids show "User not available" instead of a red-screen), shows avatar/name/about + a "Message" button → `getOrCreateDirect({otherUserId})` → `router.replace('/chat/<id>')`. Blocks self-links; handles `?auto=1` for post-sign-in auto-open.
- **Deep link** `app/chat-with/[userId].tsx` redirects `smilers://chat-with/<id>` → `/u/<id>`.
- **Signed-out flow:** tapping Message stashes the target (`src/lib/pendingChatLink.ts`) → sign-in → `ResumeLastRoute` resumes to `/u/<id>?auto=1` (priority over last-chat resume).
- **Share entry point:** Profile → "Share my chat link" (RN `Share`, `src/lib/personalChatLink.ts`, base `https://smilers.online/u/<id>`).
- **Native config:** added App Links `pathPrefix: "/u/"` for `smilers.online` in `app.json` intentFilters (same verified domain as auth-callback). Routes registered in `_layout.tsx`.
Lint clean; public resolver verified on web (invalid id → graceful empty state). ⚠️ Authenticated open-chat, deep-link handoff, and App Links need the user's signed-in device / native EAS build. Ashwini's native manifest must include the `/u/` intent-filter if he builds outside Emergent.


## iter-317 (Jun 2026): Admin broadcast batching (fix 233-user "Could not send broadcast") + admin-DM-vs-broadcast name spec
**#2 Broadcast to many users failed (FIXED, app-side).** `admin/messaging:messageUsers` returned a Convex Server Error when broadcasting to all/many users (233) but worked for a few. Cause: sending ALL recipients in ONE mutation blows past Convex per-call limits and one bad record aborts the whole batch. Fix (`app/broadcast-create.tsx handleSend`): deliver in sequential **batches of 25**, tally `sent`, continue past a failing batch, show live "Sending X of Y…" progress, and report partial delivery (retry keeps the composer). Lint clean; app boots. ⚠️ Full e2e needs the user's logged-in admin device (screen is admin/OIDC-gated).
**#1 Admin personal 1:1 messages show as "Smilers" (BACKEND — spec written).** Broadcasts flag/reuse the admin↔user DIRECT conversation as `isBroadcast:true`, so the admin's later personal 1:1 messages render as read-only "Smilers". A single per-conversation flag can't separate the two. Correct fix requires Convex: broadcasts must target a dedicated **system "Smilers" account** conversation per recipient (the only place `isBroadcast:true` is allowed), while personal DMs stay on the normal `getOrCreateDirect(admin,user)` thread showing the admin's real name + one-time migration to un-flag corrupted threads. Full spec: `/app/frontend/ADMIN_BROADCAST_VS_DM_BACKEND_SPEC.md` (handed to web team).


## iter-316 (Jun 2026): P0 — Auth Session Expiry / terminal logout ("only reinstall fixes it") ROOT CAUSE + fix
**Symptom (user + many users):** "Your sign-in session expired or couldn't be refreshed" recovery screen; only uninstall+reinstall (or sometimes swipe-away-reopen) fixes it.
**ROOT CAUSE:** Android SecureStore (EncryptedSharedPreferences) rejects values >~2048 bytes. Rotated OIDC refresh tokens / rich id_tokens exceed that. The OLD `storage.setItem` in `src/providers/AuthProvider.tsx` swallowed the write error with `catch {}` → the freshly-ROTATED refresh token was silently dropped while the server retired the previous one → next launch refreshed against the dead token → `invalid_grant` → `setSessionExpired(true)` → terminal logout until reinstall (reinstall clears the poisoned store).
**FIX (per Hercules OIDC storage playbook):** Rewrote the `storage` abstraction to (a) CHUNK values >1800 chars across multiple `<key>__chunk_N` SecureStore entries with a `<key>__meta` descriptor, (b) fall back to AsyncStorage if SecureStore still fails so the rotated token is NEVER lost, (c) stop swallowing errors — every failure is logged to in-app diagnostics (`callDebug`). Reads transparently support legacy single-key values (existing signed-in users keep their session; auto-migrated to the new format on the next save). Public API (getItem/setItem/removeItem) unchanged → rest of AuthProvider untouched. Directly satisfies the user rule "once signed in, only sign out on intentional request or reinstall".
**Status:** JS-only (ships via Emergent build, no native/Ashwini sync needed). Lint clean (only 2 pre-existing dep warnings); web boots to Sign In. ⚠️ The 2KB SecureStore limit is Android-native-only (web uses localStorage, no limit) → the actual fix must be validated on the user's next EAS Android build.


## iter-277 (Jun 2026): "No chats / ? avatar" ROOT CAUSE = Convex FATAL sync desync + photo-save gating
**THE no-chats bug is NOT auth.** Device diagnostics showed `[AUTH] getFreshIdToken: refresh OK` immediately followed by `[CONSOLE] [CONVEX FATAL ERROR] Base version 1 passed up doesn't match the current version 0`. That Convex error is FATAL — the client permanently stops syncing → empty chats + "?" header avatar until the app is killed/reinstalled (explains why reinstall "fixes" it and in-place update triggers it). Root cause: `src/providers/useConvexAutoReconnect.ts` fired manual socket reconnects during the boot/auth-handshake window, racing the SDK's own connect/auth and corrupting the session resume version. Fixes:
  - `hardReconnect` now uses the SDK's intended `webSocketManager.closeAndReconnect('client')` (the same coordinated path Convex uses for InactiveServer/FailedToSend) instead of the low-level `stop()+tryRestart()` (which restarted the socket OUTSIDE the SDK lifecycle → version desync). Legacy fallback retained if API shape changes.
  - Added a 12s **settle window** after mount: `evaluateAndAct` and the connection-state-subscription soft-reconnect both no-op during boot, letting the SDK establish + authenticate the socket itself (Convex's own backoff covers that window).
  - Added `AUTH` diagnostics in `AuthProvider.getFreshIdToken`/restore + `CONVEX` diagnostics in reconnect paths to correlate any future FATAL.
  ⚠️ NEEDS NATIVE BUILD to validate. If the FATAL ever recurs, the client is still dead until app restart (no in-session recovery yet — candidate next step: recreate ConvexReactClient on FATAL).
**Photo-save gating fix.** Non-trustees could still save because backend `canSavePhoto` returned true via the legacy `photoSavePolicy === 'everyone'` (my earlier spec wrongly kept that). Mobile (`app/user/[userId].tsx`) now NEVER auto-allows: `canSavePhoto = isSelf || (server boolean === true)`; absent/false → "Request to save". Corrected `/app/PHOTO_SAVE_REQUEST_BACKEND_SPEC.md` to require `canSavePhoto` be **trustee-gated only** (ignore photoSavePolicy). Web team must redeploy that rule.


## iter-276 (Jun 2026): Device-B auto-switch sync fix + profile-photo save-approval + screenshot block
**#1 Device B auto-switch FIXED (synchronous overlay dismiss).** B's diagnostic logs showed `FIRING → triggerMeshUpgrade → router.replace → group-call` all firing, but the iter-275 `callHost.end()` was deferred via `setTimeout(…,60)` and that timer NEVER ran on B (`callHost.end() done` log absent) — Android throttled the timer during the nav transition while the overlay (zIndex 9000) kept covering group-call. Fix (`app/call/[conversationId].tsx` `triggerMeshUpgrade.navigate`): call `callHost.end()` **synchronously** right after `router.replace` (no timer). Works for both A (fromModal, after the 350ms modal-dismiss) and B (rAF path).
**#2 Profile-photo save-by-approval (Convex-synced) — mobile UI shipped.** User rule: trustees save freely; everyone else taps "Request to save" → owner gets an Approve/Decline banner; can only save once approved; owner offline → "Awaiting approval" (no auto-save).
  - Requester (`app/user/[userId].tsx` photo viewer): when server `canSavePhoto` is true → direct Save (existing). When false → "Request to save" → `api.photoSaveRequests.request({ownerId})` → "Awaiting … approval" state. Graceful "Not available yet" if backend fn missing.
  - Owner (`src/components/PhotoSaveRequestBanner.tsx`, mounted in Chats tab): subscribes `api.photoSaveRequests.getIncoming`, Approve/Decline → `api.photoSaveRequests.respond({requestId, accept})`. Renders nothing until backend deploys.
  - **Backend spec for web team:** `/app/PHOTO_SAVE_REQUEST_BACKEND_SPEC.md` (extend per-viewer `canSavePhoto` to include trustees + one-time approval grant; new `photoSaveRequests.request/getIncoming/respond`).
**#3 Profile photo screenshot block.** `app/user/[userId].tsx` toggles `preventScreenCaptureAsync('profile-photo')` while the enlarged photo viewer is open, `allowScreenCaptureAsync` on close (native-only; no-op web).
**#4 Photo upload (iter-275) confirmed WORKING by user.**
⚠️ NATIVE BUILD required to validate auto-switch + screenshot block. Lint clean on all changed files; web bundle builds; app boots.


## iter-275 (Jun 2026): P0 — 1:1→Mesh auto-switch ROOT CAUSE + photo-upload silent-hang fix
**#1 Auto-switch (1:1 → Mesh) — TRUE ROOT CAUSE found.** User confirmed BOTH parties stay on the 1:1 screen until they tap End, which then drops them into the conference. The diagnostic logs already showed `[adhoc-upgrade] router.replace → group-call` firing — so navigation *ran* but had no visible effect. Cause: the call UI is NOT a real route — since iter-261 it's rendered by the root-mounted `<CallHost/>` overlay driven by the `callHost` store. `router.replace('/group-call/...')` only swaps the UNDERLYING expo-router screen; the 1:1 overlay stays mounted ON TOP (store still holds params), so users keep seeing the 1:1 screen until `callHost.end()` runs (which only happened on tapping End). **Fix** (`app/call/[conversationId].tsx` `triggerMeshUpgrade.navigate`): after `router.replace(dest)`, defer ~60ms then call `callHost.end()` to dismiss the overlay and reveal the group-call screen underneath. The live PC/streams are already `detachForHandoff()`-stashed before navigating, so ending the overlay does NOT drop the call (close() is a no-op on the detached pc); the group-call screen adopts the handoff. Applies to BOTH initiator (fromModal) and receiver paths.
**#2 Photo upload "stuck in composer, no alert" — silent-hang hardening.** No error alert + photo stuck = `uploadFile`'s one-shot `convex.mutation(messages.generateUploadUrl)` hanging forever on the auth-handshake race (same failure class as trustees/languages/call-pills). **Fixes:** (a) `src/lib/uploadFile.ts` now races the upload-URL mutation against a 25s timeout → a stalled handshake throws a clear error instead of hanging. (b) `sendImageFromUri` (`app/chat/[conversationId].tsx`) now logs each step (`IMG send start / upload OK / meta / messages.send OK`) to the in-app Diagnostic Logs export and surfaces `errorValue.data.message` verbatim in the alert; the previously-silent `!isConversationAvailable` early-return now shows an alert too. Next device test + log export will pinpoint the exact failing step if it persists.
**⚠️ NATIVE BUILD REQUIRED to validate both** (WebRTC + native upload don't run on web/Expo Go). Lint clean on all 3 files; web bundle builds; app boots to Sign In.


## iter-274 (Jun 2026): Conference — poll voting + timer/minutes/reactions read displays
In `app/conference/[conferenceId]/room.tsx`:
- **Poll voting wired:** polls now render each option as a tappable button → `api.conferencePolls.vote({pollId, optionId})` (shows vote count if present; disabled when poll closed).
- **Read subscriptions added** (confirmed web queries): `conferenceMinutes.getMinutes` → minutes list in Minutes panel; `conferenceSpeakerTimer.getActiveTimer` → active-timer block (remaining secs from `endsAt`/`durationSec`) in Timer panel; `conferenceReactions.getRecentReactions` → drives the floating reactions overlay (was reading stale `state.recentReactions`).
- Lint clean; web bundle builds (web:200); app boots. NATIVE BUILD required to validate.
- ⚠️ Still unconfirmed: timer **start/end** namespace (left `conferences.startTimer/endTimer`); option/field shapes for polls/minutes/timer/reactions read defensively (multiple key fallbacks) — adjust if web shapes differ. Conference feature now: voice+video mesh, mic/cam toggles, roster/roles, speaking indicator, breakout peer-scoping + join, motion voting, poll voting, minutes/timer/reactions displays, chat. (Hand-raise intentionally absent — not supported by formal-conference backend.)


## iter-273 (Jun 2026): Conference meeting-tools wired to confirmed backend + breakout mesh scoping
Web team confirmed exact signatures. Changes in `app/conference/[conferenceId]/room.tsx`:
- **Breakout-room peer scoping (option a):** mesh now connects ONLY participants in the SAME breakout (`peerUserIds` filtered by `conferenceRoles.breakoutRoomId` from getRoomState; null=main). Added **Join** button per breakout room → `api.breakoutRooms.joinRoom({conferenceId, roomId})`.
- **Hand-raise REMOVED** from formal conference (web confirmed it does NOT exist there — only group calls have it; `conferenceRoles` has no handRaised field). Removed the button/handler/mutation added in iter-272. (Speaking indicator from iter-272 stays — it's client-side getStats.)
- **Namespace fixes:** `muteAll`→`api.chairControls.muteAll`; minutes append→`api.conferenceMinutes.addEntry`.
- **Motion voting added:** For/Against/Abstain per motion → `api.conferenceMotions.castVote({motionId, vote})`.
- ⚠️ **Poll voting NOT wired yet** (`api.conferencePolls.vote({pollId, optionId})` declared, eslint-disabled) — polls render doesn't list options; needs option rendering. FOLLOW-UP. Also not yet wired: reads for active timer (`conferenceSpeakerTimer.getActiveTimer`), minutes log (`conferenceMinutes.getMinutes`), reactions (`conferenceReactions.getRecentReactions`); and timer start/end namespace unconfirmed (left as `conferences.*`).
Lint clean; web bundle builds (web:200); app boots. NATIVE BUILD required to validate media/votes. Full contract: web repo `docs/CONFERENCE_MEETING_TOOLS_NATIVE_CONTRACT.md`; my verify doc `/app/docs/WEB_TEAM_VERIFY_conference_tools_signatures.md`.


## iter-272 (Jun 2026): Conference — speaking indicator + hand-raise UI
- **Speaking indicator:** `MeshPeer` now reads WebRTC `getStats()` audio levels (`getInboundAudioLevel` from inbound-rtp, `getLocalAudioLevel` from media-source). `MeshController` polls every 700ms and emits `onSpeakingChange({ [peerUserId]:bool, __local:bool })` (threshold 0.02; local gated by mic-enabled). `useConferenceMesh` exposes `speaking`. Conference `ParticipantTile` shows a green ring (`tileSpeaking`) on the active talker.
- **Hand-raise:** added `api.conferenceRoom.toggleHandRaise({conferenceId, handRaised})` mutation + a "Raise/Lower hand" control in the room's bottom bar (extended `SelfControl` with an `mci` flag for the MaterialCommunityIcons `hand-back-right` icon). Tile already renders the hand-raised badge from `participant.handRaised`.
- ⚠️ **ASSUMED** `api.conferenceRoom.toggleHandRaise` arg shape (parallel to toggleMute/toggleVideo) — web team to confirm; calls degrade gracefully via `safeMutate` if wrong. Lint clean; web bundle builds; app boots. NATIVE BUILD required to validate speaking levels (getStats audioLevel support is native-only).


## iter-271 (Jun 2026): Conference = voice AND video (mesh) + confirmed signaling
- Web team confirmed all `api.conferenceSignaling.*` shapes are EXACT 1:1 matches with my native impl (send `{conferenceId,toUserId,type:'offer'|'answer'|'ice-candidate',payload}`; poll `{conferenceId}`→`[{_id,fromUserId,toUserId,type,payload,consumed}]`; markConsumed `{messageIds}`; plus `cleanupMine({conferenceId})` on leave). No signaling changes needed.
- **Conference is voice+video** (unlike group calls which are voice-first). Extended `MeshController` with `video` option + `setVideoEnabled`/`getLocalStream` (getUserMedia now requests camera for video confs; MeshPeer already exchanges all tracks). `useConferenceMesh` now accepts `videoEnabled`/`cameraOn`, exposes `remoteStreams`+`localStream`, and calls `conferenceSignaling.cleanupMine` on unmount.
- **room.tsx**: detects `conference.type==='video'`, runs the video mesh, lazy-loads web-safe `RTCViewWrapper` → renders each participant's live `RTCView` (self mirrored) in the existing `ParticipantTile` video area (falls back to avatar when no stream). Mic + camera buttons now control the real tracks instantly (optimistic local mirrors synced from server `isMuted`/`videoEnabled`). Lint clean; web bundle builds; app boots.
- **NATIVE BUILD required** to validate (no WebRTC on web/Expo Go). Follow-ups: speaking indicator + hand-raise UI; breakout-room peer scoping (mesh currently connects all active participants).


## iter-270 (Jun 2026): Conference room — LIVE voice mesh wired (web-interop)
Web team confirmed the conference room IS fully built on web with real mesh audio, keyed by **`conferenceId`** (NOT a callId; no `initiateCall`): roster/join/leave/mute via `api.conferenceRoom.*`, signaling via **`api.conferenceSignaling.*`** (separate from `api.signaling.*`), mesh connects to `peerUserIds` (other active participants, breakout-scoped). Built native conference audio reusing the transport-agnostic `MeshController`/`MeshPeer` (same perfect-negotiation politeness as group calls) via new hook `src/lib/call/mesh/useConferenceMesh.ts`. Wired into `app/conference/[conferenceId]/room.tsx`: computes `peerUserIds` from active roster, runs the mesh, mute button now cuts the real mic instantly (local `localMicOn` mirror synced from `myMuted`, incl. admin force-mute via 3s `getRoomState` refetch). Voice only (video grid is follow-up). Lint clean; web bundle builds; app boots.
**⚠️ ASSUMED `api.conferenceSignaling.*` arg shapes (parallel to `api.signaling.*`) — web team to CONFIRM:** `send({ conferenceId, toUserId, type:'offer'|'answer'|'ice-candidate', payload:string })`; `poll({ conferenceId })` → `[{ _id, fromUserId, toUserId, type, payload }]`; `markConsumed({ messageIds })`. If real names differ, conference audio won't connect until aligned. NATIVE BUILD required to validate.


## iter-269 (Jun 2026): Incoming group-call ring → group room + Groups-tab call-leak guard
- **Incoming group-call routing:** Foreground `src/push/useIncomingCallListener.ts` now routes calls where `incomingCall.isConference===true` (or `callType==='conference'`) to `/group-call/<conversationId>?callId=<call._id>` instead of the 1:1 `/call`. Push-tap handler in `src/push/usePushNotifications.ts` (`type==='call'`) routes `payload.isConference|callType==='conference'` to `/group-call/<conv>?callId=`. FastAPI relay `server.py` now forwards `isConference` in the call push data block so the flag reaches the device. ⚠️ **Web dependency:** Convex `initiateCall` must include `isConference:true` in the push it posts to `/api/send-push-internal` for the killed/background ring to route correctly (foreground works without it).
- **Groups tab call-leak (user bug):** 1:1 calls with "add participant" create real `type:"group"` conversations via `createGroup` (web-confirmed: NO marker field on conversations). Mobile already stopped creating these (add-participant is an alert; `/group-call` uses `initiateCall` which makes no conversation). Added defensive `isRealGroup()` filter in `app/(tabs)/groups.tsx` (drops `isConference`/`groupType:'call'`/`isCallGroup`/`isAdHoc`/call-meta-without-group). Existing junk groups are indistinguishable client-side → handed full fix spec to web team: `/app/docs/WEB_TEAM_SPEC_stop_call_group_creation_and_cleanup.md` (stop createGroup on escalation OR add `originType:'call'` + exclude from listGroups + one-time backfill).


## iter-268 (Jun 2026): Group voice calling — native WebRTC mesh (Phase 2, voice only)
Web team shipped web mesh → built native mesh to interop. New `src/lib/call/mesh/MeshPeer.ts` (perfect-negotiation peer) + `MeshController.ts` (owns mic, one peer per roster participant, routes signals by `fromUserId`, exposes remote streams) + screen `app/group-call/[conversationId].tsx` (roster grid, mute, leave; voice only). Entry = "Group voice call" ActionRow on `app/group/[id].tsx` → `/group-call/<conversationId>`. Uses confirmed contracts: `api.calls.initiateCall({conversationId,callType:'voice'})` to start/ring, `?callId=` to join; `api.conference.{joinConference,leaveConference,getParticipants,toggleSelfMute}({callId})`; `api.signaling.{send,poll,markConsumed}` (poll filtered to `toUserId===me`, routed by `fromUserId`); dynamic TURN via Phase-1 `getPeerConnectionConfig()`. **Glare rule (must match web):** `polite = String(myUserId) > String(peerUserId)`; rollback-free subset — IMPOLITE peer is sole offerer, POLITE only answers, impolite ignores colliding offers (interops with web's full perfect negotiation). Lint clean; web bundle builds; route registered. **TODO follow-ups:** incoming group-call ring still routes to 1:1 `/call` (callee joins via group screen for now); speaking/hand-raise/admin-mute UI; group video. **NATIVE BUILD REQUIRED to validate** (no WebRTC on web/Expo Go). Full plan: `/app/docs/GROUP_CALLING_PHASE_PLAN.md`.


## iter-267 (Jun 2026): Group calling decision (NO LiveKit) + dynamic TURN (Phase 1)
- **Decision:** Group voice calling will NOT use LiveKit/SFU. Web team confirmed the entire stack is WebRTC peer connections + Convex signaling (`api.signaling.*` scoped by shared `callId`, addressed via `toUserId`/`fromUserId`); group roster = `api.conference.*` (singular, keyed by callId); start/ring = `api.calls.initiateCall({conversationId, callType})`. `api.conferenceRoom.*` does NOT exist (the scheduled-conference `room.tsx` is a separate `api.conferences.*` plural events feature). Full contracts + Phase 2 mesh plan in `/app/docs/GROUP_CALLING_PHASE_PLAN.md`.
- **Phase 1 DONE — dynamic TURN (web parity, helps existing 1:1 calls too):** `src/lib/webrtc/iceServers.ts` adds `fetchTurnServers()` + `getPeerConnectionConfig()` — fetches ephemeral Twilio relay creds from `GET {CONVEX_SITE_URL}/turn-credentials` (derived from `EXPO_PUBLIC_CONVEX_URL` `.cloud`→`.site`), 8s timeout, ~50min cache, falls back to the static metered.ca list on any error. `CallSession.createPeerConnection()` now awaits it (static fallback on error). Endpoint verified live via curl (returns Twilio STUN+TURN). Lint clean; web bundle builds. Native-validate on build.
- **CRITICAL caveat:** media is still 1:1 on BOTH web and mobile today — true mesh fan-out (every peer↔peer) is Phase 2, to ship alongside the web team's mesh (user confirmed web mesh is coming soon). Existing `CallSession` is already single-remote-peer with `callId`+`toUserId` in its signal shape → mesh = one CallSession per participant via a `MeshCallController` (see doc).


## iter-266 (Jun 2026): Presence polish — chat header + user profile
- **Chat header** (`chat/[conversationId].tsx`): added a green online dot to the header avatar (wrapped it so the dot isn't clipped by the avatar's `overflow:hidden`). `headerOnline` is DM-only (no group/broadcast), derived from `mergedPresenceSource` (`isOnline`/`online` flag or `lastSeen` within 2 min). Presence subtitle text was already present.
- **User profile** (`user/[userId].tsx`): added an online dot on the avatar ring + the last-seen line now shows "Online" (green) when the user is online (`profileOnline`); falls back to the existing `formatLastSeenLabel`.
Both read the same Convex `users` presence as the web app. Lint clean, web bundle builds (2514 modules). Native-validate on build. (Continues iter-265 which added presence to Admin list, chat list, contacts.)


## iter-265 (Jun 2026): Online dot + last-seen parity (Admin, chat list, contacts)
**Goal:** match the web app, which shows presence everywhere the native app didn't.
- **Avatar** (`src/components/Avatar.tsx`): added reusable `online?: boolean` prop → renders a green presence dot at bottom-right (outside the clipped circle, scales with size). Used everywhere.
- **Admin Users** (`admin.tsx`): each row now shows the online dot on the avatar + a "Last seen …"/"Online now" line (`formatAdminLastSeen` from contract `isOnline`/`lastSeen`; getAllUsers already forces offline after 2 min).
- **Chat list** (`(tabs)/chats.tsx`): `ConversationRow` Avatar gets `online={peerIsOnline(item)}` — DM-only (no dot on groups), online if `isOnline`/`online` flag OR `lastSeen` within 2 min.
- **Contacts** (`(tabs)/contacts.tsx`): already had the dot via `ContactAvatar`; added subtitle = "Online" / "Last seen …" (`formatContactLastSeen`) falling back to the about line.
All read the same Convex `users` presence the web app uses. Lint clean, web bundle builds. Native-validate on build.


## iter-264 (Jun 2026): Screen-share = request/accept (no call) + #1 killed-ring conclusion
**#3 Screen-share FIXED (sharer entry):** Web team confirmed the full `api.screenSharing.*` contract exists (request/accept/decline/signaling) and the native viewer side ALREADY worked (`IncomingScreenShareModal` polls `listIncoming`; call screen has full screen-only mode wired to `screenSharing.sendSignal/pollSignals/markSignalsConsumed`). Only the SHARER entry was wrong — `app/screen-share.tsx handleStart` used Twilio `startCall(autoShare)` (rang like a call). Rewrote it to: `getOrCreateDirect({otherUserId})` → `screenSharing.requestScreenShare({conversationId})` → `router.replace('/call/<sessionId>?type=screen&screenOnly=1&audio=<0|1>&role=sharer&convId=<conv>&peerUserId=<viewer>')`. No call doc, no ringtone; recipient gets the accept/decline request (modal + the new web-side push) and on accept opens the same screen-only view as `role=receiver`. Web team also added `internal.emergentPush.notifyScreenShareRequest` (banner channel `messages-v4-message_notification`, action `/screen-share?conversationId=`) so requests reach backgrounded/killed apps. Removed the now-unused Twilio `startCall` import.
**#1 Killed-app ring — native side verified CORRECT, remaining fix is web/native-build:** Web team confirmed Convex calls THIS backend's `/api/send-push-internal` with `channel_id: calls-v4-smilers_never_cry`, `data.type:'call'`, recipients = Convex `users._id`. Native app DOES register `convex_user_id` (iter-203) and the relay matches on it; `defineTask` is at module scope. So the canonical data-only ring push reaches the device. The killed-app MESSAGE TONE comes from (a) competing pipelines the web team fires in parallel — Hercules web push, Expo legacy (`mobilePushAction.sendExpoPushToUser`), and the missed-call push (`messages-v4-message_notification`) — landing a notification-block on a non-calls channel, and/or (b) Android not waking JS for data-only FCM on force-stopped apps. NATIVE can't override an OS-rendered notification or run JS while force-stopped. RESOLUTION PATH: web team should ensure ONLY the calls-v4 data-only push fires for ringing (and that the Expo-legacy/missed pushes specify the calls channel or are suppressed), AND/OR implement native CallKeep/foreground-service (P2, native freelancer) for guaranteed wake-on-lock.


## iter-263 (Jun 2026): Pop-out clickability, admin per-user message, + screen-share/killed-ring scoping
**#2 Pop-out not clickable (FIXED):** iter-261 added a 4th "Minimize" button to `controlsSecondaryRow`, overflowing the fixed single-line row so "Pop out" was pushed off the right edge (untappable). Made the row `flexWrap:'wrap'` with `columnGap/rowGap` so all controls stay on-screen and tappable.
**#4 Admin per-user message (DONE):** Added "Message as “Smilers”" to the per-user RowMenu (next to Make/Remove admin + Suspend) in `admin.tsx`; it routes to `/broadcast-create?preselect=<userId>` (new `preselect` param pre-selects that single recipient in the broadcast composer). Quick way to message one user as Smilers.
**#1 Killed-app ring still just vibrates (OPEN, needs Convex/prod logs):** User confirms prior build still plays a short buzz/message-tone when killed → the call push is still arriving as a message-channel notification (JS not running). iter-262 relay hardening + `[PUSH][classify]`/`[PUSH][channels]`/`data_only` logs are now in to diagnose, BUT only help if the incoming-call push flows through THIS backend's `/api/send-push-internal`. User suspects prod should be wired to the web app's Convex backend. NEED: the Convex function/payload the WEB app uses to push incoming calls to mobile (to confirm call signals / path).
**#3 Screen-share starts a call (OPEN, needs Convex contract):** `/app/frontend/app/screen-share.tsx` `handleStart` currently calls the Twilio `startCall(... autoShare:true)`, which RINGS the recipient like a call. User wants: tapping chat-menu "Share screen" sends an ACCEPT/DECLINE request (no call); on accept it renders screen-only. Only the IN-CALL screen-share button should run during a call. This needs the Convex screen-share request/accept contract (functions + payload + receiver notify + accept→render signaling). Referenced doc: /app/CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE.md.


## iter-262 (Jun 2026): Killed-app call-tone root cause + relay hardening + return-to-call banner
**Diagnosis (user-confirmed):** killed app plays the MESSAGE tone for incoming calls. A message tone on a killed app means JS never ran → the OS rendered a notification-block push on `messages-v4-message_notification`, i.e. the relay MISCLASSIFIED the call as a message. So the iter-260 Notifee v3 vibration fix only helps when Notifee actually renders (foreground / backgrounded-alive), NOT the killed case.
**Fix 1 — relay classifier hardening** (`backend/server.py` `_resolve_android_channel`): now also treats the PRESENCE of call-metadata fields (`callId`/`callType`/`callerId`/`twilio_room_name`/`twilio_room_sid`/`twilio_caller_identity`) as a definitive call signal → such pushes go data-only → wake background task → render the Notifee full-screen ring instead of a message banner. Dependency: only works if (a) prod routes calls through this backend's `/api/send-push-internal` (Convex does today) AND (b) Convex's call push carries at least one call signal (type:'call' | action_url:/call/ | a call-metadata field). If Convex sends ZERO call signals, the fix must be on Convex.
**Fix 2 — relay classification log** (`send_push`): one-line `[PUSH][classify] -> CALL|MESSAGE channel=… recipients=… type=… action_url=… has_callId=… title=…` so production push routing is debuggable from deployed backend logs.
**Feature — return-to-call banner** (`src/components/call/CallReturnBanner.tsx`, mounted in `_layout.tsx` after CallHost): WhatsApp-style slim green bar pinned to the top of every screen while a call is MINIMIZED; tap → `callHost.maximize()`. Companion to the draggable floating window. Web returns null.
**Still pending native validation on Emergent Android build.** Hard limit unchanged: force-killed apps on aggressive OEMs may not wake JS even with a correct data-only push → needs native CallKeep/foreground service (deferred P2).


## iter-261 (Jun 2026): In-app "Minimize" floating call window (global CallHost refactor)
**Goal:** let users minimize a live WebRTC call into a small draggable window and keep browsing Smilers without dropping the call.
**Architecture (P1):** The call no longer lives inside the `/call/[conversationId]` route. New external store `src/lib/call/callHost.ts` (`start/end/minimize/maximize`, `useCallHost` via useSyncExternalStore) drives a root-mounted `src/components/call/CallHost.tsx` that renders `CallScreenInner` ONCE.
- `CallScreenInner` is now `export`ed from the route file and reads its params from `useCallHost()` (not `useLocalSearchParams`). The route default export is now a thin SHIM that forwards route params → `callHost.start()` → pops itself (so every entry point — push wake, startCall, deep links — keeps pushing `/call/<id>` unchanged).
- CallHost keeps the SAME `<CallScreenInner/>` element mounted across full↔mini (only swaps wrapper STYLE + PanResponder handlers) — critical so React never unmounts it and tears down the peer connection. `pointerEvents="box-none"` in mini lets the app behind stay interactive.
- Added a "Minimize" control (both video & voice control rows) → `callHost.minimize()`; mini window shows remote video/avatar + duration + expand/end, tap-to-expand, draggable.
- All call-ending paths now call `callHost.end()` (was `router.back()`); conference escalation uses `callHost.start(newParams)` in place of `router.replace`.
- Mounted `<CallHost/>` at app root in `_layout.tsx`. Web returns null (no react-native-webrtc on web).
**Gotcha logged:** Metro runs in CI mode (no file-watch) — NEW files (callHost.ts, CallHost.tsx) are only picked up after `supervisorctl restart expo`. Bundle confirmed clean after restart; app boots to Sign In.
**MUST validate on native Emergent Android build** (WebRTC/PiP can't run in web/Expo Go): verify minimize keeps the call connected, drag works, expand restores, end works, and conference/screen-share modes still function via the new shim.


## iter-260 (Jun 2026): Admin features (broadcast/user insights/leaderboard) + P0 killed-app call vibration
**Admin contract wired (verified against backend by user):**
- **Admin User List** (`app/admin.tsx` UsersTab): each row now shows a Level pill + `<N> pts · <N> refs` from `api.admin.queries.getAllUsers` ({} args; added `level`/`totalEngagements`/`referralCount` to UserItem). Added a "Send broadcast as Smilers" CTA at top of the Users tab.
- **Admin Broadcasts** (`app/broadcast-create.tsx`, fully rewritten): admin-gated screen fetching `api.admin.queries.getAllUsers`, per-row checkboxes + select-all, a 1–5000 char message composer, then ONE `api.admin.messaging.messageUsers({ userIds, text })` call; surfaces returned `{ sent }`. FAB broadcast button (`FabStack`/chats) now only renders for `me.role === 'admin'`.
- **Broadcast read-only enforcement** (`app/chat/[conversationId].tsx`): when `conversation.isBroadcast === true` → title forced to "Smilers", subtitle "Announcement · read-only", call/video header buttons hidden, composer replaced with a read-only banner, and reactions/long-press/swipe-to-reply disabled (new `isBroadcastReadOnly` flag mirroring the existing `viewerSuspension` spectator path).
- **Leaderboard** (`app/earnings.tsx` Top tab): `getLeaderboard` now called with `{}` (was `{ limit: 20 }` → would fail strict arg validation). TopEarnersList reads contract fields verbatim (`userId`/`name`/`avatar`/`level`/`totalEngagements`); server anonymizes to "User #N" for non-admins — no client-side de-anonymization.
**P0 — killed/backgrounded incoming-call vibration too short (recurring):** Notifee call wake channel (`src/push/notifeeCallWake.ts`) played a ~2.4s vibration pattern ONCE (`loopSound` loops audio, not vibration) → felt like a message buzz. Fixed by baking a LONG repeating buzz pattern (≈ RING_TIMEOUT_MS, 700ms on / 600ms off) into the channel; channels are immutable on Android O+ so bumped id `incoming-call-wake-v2-*` → `v3`. NOTE: this FastAPI backend already sends call pushes data-only (correct); IF production points at the separate Hercules/Convex backend and that sends a notification-block on a message channel, killed-app vibration must also be fixed there. **All native-only (Notifee/push/WebRTC) — requires user's Emergent Android build to validate.**


## iter-221 (Feb 2026): Profile screen — match web app (phone section + card styling)
User compared native vs web Profile (screenshots). Changes in `app/(tabs)/profile.tsx`:
- **Added PHONE NUMBER section** above YOUR NAME (web parity): phone icon + "PHONE NUMBER" label, the number (`me.phoneE164 ?? me.phone`) + green **Verified** pill (`me.phoneVerified`, shield-check) + edit pencil (→ `/phone-verify`), and helper text "Your phone number is how friends find and recognize you on Smilers." Shown only when a phone exists.
- **Restyled cards to the web's soft look** (native previously used deep solid yellow): Premium = pale gold fill `#FBF1CD` + gold border `#EAD68C` + gold crown/text (`primaryDark`), chevron removed; Starred Messages + Settings & Privacy = near-white `#FAF7EC` fill + hairline border `#ECE7D8` + gold icon + dark semibold text.
- Verified: eslint 0 errors (only a pre-existing unused-`useEffect` warning), bundles clean. Visual check is OIDC-gated → **device/authed retest**. Note: phone fields are `phoneE164`/`phone` + `phoneVerified` on `getCurrentUser`; if they're named differently on the live Convex backend the number/Verified pill won't show until matched.


## iter-220 (Feb 2026): In-conversation search — highlight + ▲/▼ navigation (web parity)
User wants: search a word → results in Chats & Messages → tap → enter conversation with ALL matches highlighted + up/down buttons that jump match-to-match (skip non-matches, wrap-around, scroll-to-centre). Screenshots showed the web design ("Results for 'Thanks' · 1 of 9" bar + yellow highlight; Search screen Chats/Messages tabs).
**Part 1 — in-conversation highlight + nav (CORE, self-contained, done):**
- `app/chat/[conversationId].tsx`: reads `?q=<term>&mid=<messageId>` params; STOPPED the old iter-109 filter behaviour (full list stays visible). Computes `searchMatchPositions` = timeline indices of non-deleted text messages containing the term (case-insensitive), oldest→newest. New highlight+nav bar (search icon, editable term input, "<n> of <total>", ▲ ▼ ✕) replacing the old filter bar. ▲/▼ wrap-around; active match scrolled to centre via `scrollToIndex(viewPosition:0.5)` + `onScrollToIndexFailed` fallback; `onContentSizeChange` auto-scroll-to-end guarded off during search. Initial focus = `mid` match (else most recent), once per term.
- `src/components/MediaBubble.tsx`: new props `searchTerm` + `isActiveSearchMatch`; `RichMessageText` + `splitByTerm` highlight every occurrence (yellow `#FDE68A`, active brighter `#FACC15`); active bubble gets an amber outline.
**Part 2 — global Search "Messages" tab (done, pending field confirmation):**
- `app/search.tsx`: added `Messages` tab (now Chats/Messages/People) using `api.search.searchMessages` ({ query }); new `MessageResultRow` with highlighted snippet; tapping a message → `/chat/<cid>?q=<term>&mid=<mid>`; conversation taps now carry `?q=<term>`. Defensive field reads (conversationId/_id/messageId, text/snippet, conversationName/...).
**Verification:** tsc (whole project) + eslint clean on all 3 files (only PRE-EXISTING errors remain: MediaBubble VideoPlayer.seekTo, chat L624 'code', and a pre-existing conditional-useMemo hook warning in MediaBubble — NOT mine). Web+iOS bundles built; Search screen renders 3 tabs. Full E2E (highlight/jump, message search results) is OIDC+data gated → device/authed retest.
**OPEN for user/web team** (see `/app/IN_CONVERSATION_SEARCH_NATIVE_WIRING_iter220.md`): confirm `api.search.searchMessages` arg is `query` and result fields (`conversationId`, `_id`, `text`, `conversationName`); and whether to drop the 3rd "People" tab for strict 2-tab web parity.


## iter-218c (Feb 2026): On-device "Call Diagnostics" screen (enhancement)
New `app/call-diagnostics.tsx` (route `/call-diagnostics`, linked from Settings under "Diagnostic Logs"). Reads the local AsyncStorage diagnostic ring buffer via new exports `getStoredDiagnostics()` / `clearStoredDiagnostics()` in `src/lib/diagnostics.ts`. Shows recent call/push events newest-first with tag pills, source, timestamp; filter chips Calls / Push / All; Refresh, Copy-to-clipboard (expo-clipboard), and Clear. Lets the user/support pinpoint ring / answer-decline / auto-drop (`[TWILIO-CALL]`, `[WAKE]`) issues during the next device test without server-log digging. Verified on web: lint+tsc clean, list renders (6 boot/health events), filter switching + copy work. NOTE: Metro runs in CI mode (reloads disabled) — adding a NEW route file requires `sudo supervisorctl restart expo` for expo-router to register it.


## iter-218 (Feb 2026): Device-test fixes — Twilio auto-drop, missed-call lingering, killed-app ringtone
User device-tested iter-217 and reported 3 issues. Fixes:
- **Issue 3 (Twilio call doesn't auto-drop on the other side)** — ROOT CAUSE: Twilio does not disconnect the remaining participant when one leaves, and there was no caller-side ring timeout, so the local room stayed `connected` (alone) and the screen never closed. FIX in `app/twilio-call.tsx`: (a) remote-left auto-end — once a remote participant joined and then all leave, tear down our side (leave + `/api/twilio/end-call` + close); (b) caller no-answer ring-timeout (~35s) → auto-end instead of stranding the caller on "Waiting for others to join…". Client-side, lint-clean.
- **Issue 2 (incoming-call notification lingers beside the missed-call notification)** — ROOT CAUSE: the wake notification was `ongoing: true`, and Android's `timeoutAfter` does not remove an ongoing notification, so it persisted next to the scheduled missed-call. FIX in `src/push/notifeeCallWake.ts`: set `ongoing: false` (still rings full-screen via fullScreenAction + loopSound + MAX heads-up, but the OS auto-dismisses it at timeout; Answer/Decline handlers still cancel explicitly).
- **Issue 1 (killed app plays message tone instead of custom ringtone)** — ROOT CAUSE: a force-killed app can't run JS, so the data-only call push never rendered the Notifee ring; Android played the default/message tone. User chose option 1a (custom ringtones for calls AND messages when killed). FIX: backend `server.py` send_push now sends calls with a NOTIFICATION block on the device's custom calls channel (`android_data_only=False`; channel already resolves to `call_channel_id`) so a killed phone rings with the chosen ringtone via the OS; `usePushNotifications.ts` background task now SKIPS its own Notifee ring when the OS already displayed a notification (prevents double-ring). 11/11 push pytest pass.
  - **IMPORTANT**: User confirmed the PRODUCTION app points at a SEPARATE backend (the Hercules/Convex web app), not this Emergent FastAPI backend (device logs show `register-push HTTP 404` here + legacy Convex `notifyPush` call path). So the authoritative Issue-1 fix must be made in the Hercules/Convex push sender. Wrote `/app/HERCULES_BACKEND_PUSH_CONTRACT_iter218.md` — exact FCM v1 payload contract (per-type `channel_id` = stored `call_channel_id`/`message_channel_id`, notification+data blocks, dedupe) for the user to hand to the Hercules team. Convex `registerMobileDevice` likely must also persist `call_channel_id`/`message_channel_id`.
- **Status:** all code lint/tsc/pytest clean; killed-app push + Twilio call flows are DEVICE-ONLY testable → pending user's next build + device retest. Issue 1 also requires the Hercules backend change to land.


## Latest feature (Feb 2026 — iter-214): Live-location request receiver confirmation flow
**User request:** "When someone requests a live position and it arrives in my chat, when I click on it, it should open a confirmation to send it which when confirmed, my live location should be sent." Match the web app's confirmation flow. Scope chosen by user: **receiver/confirmation flow ONLY** (no continuous 10s live-tracking yet); show incoming request as a tappable banner in **both** the Chats tab (global) and inside the chat screen (scoped to that conversation).
**Implementation:** New `src/components/LiveLocationRequestBanner.tsx`. Subscribes to web-canonical Convex query `api.locationRequests.getIncomingRequests` (via `anyApi`, degrades gracefully through `useSafeConvexQuery`). Renders amber banner ("Live location requested — tap to share") with a quick X to decline (`respondToRequest({ requestId, accept:false })`). Tapping opens a confirmation modal ("Share your live location?") with a 15/30/60-min selector; "Send my live location" captures `Location.getCurrentPositionAsync()` and calls `api.locationRequests.respondToRequest({ requestId, accept:true, latitude, longitude, durationMinutes })`. Mounted in `app/(tabs)/chats.tsx` (global, below LoginApprovalBanner) and `app/chat/[conversationId].tsx` (scoped, top of KeyboardAvoidingView).
**Status:** lint + tsc clean (only pre-existing unrelated TS errors), web smoke test PASS (Sign-In renders, no bundle crash). Full flow requires OIDC login + a real incoming request from web → **user to verify on device**. Sender-side request creation intentionally out of scope per user.

### iter-214b: "Sharing live location · X min left" status pill + one-tap Stop
**User approved** the suggested enhancement. New `src/components/LiveLocationSharingPill.tsx` subscribes to web-canonical `api.locationRequests.getActiveShares`, shows a green pill ("Sharing live location · 28 min left", ticks every 30s, computes remaining from `expiresAt` or `startedAt`+`durationMinutes`) with a "Stop" button that calls `api.locationRequests.stopSharing`. Mounted scoped-to-conversation in `app/chat/[conversationId].tsx` directly under the request banner. NOTE: exact `stopSharing` arg key wasn't in the contract, so Stop tries likely shapes in order (`{shareId}`→`{requestId}`→`{id}`→`{conversationId}`); Convex validates args before running the handler so wrong shapes are harmless no-ops. Confirm the canonical signature on device and simplify. lint + tsc clean; web smoke PASS.


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

---

## iter-214 — Call-notification trio (#1 ringtone, #3 missed-call, #4 persistence) ROOT-CAUSE (no code change)

Full end-to-end trace done. Findings:
- Channel-routing code is CORRECT by inspection: Twilio call push has
  `type:"call"` → `_resolve_android_channel` returns the device's versioned
  call channel (`calls-v4-<sound>`, default `smilers_never_cry`) → passed to
  `fcm_send_v1` as `android_channel_id`. Call channels carry a RING sound, not
  the message tone.
- The call FCM carries a `notification` block (title/body) AND data. On a
  KILLED app, Android AUTO-DISPLAYS the notification itself → the rich
  `notifeeCallWake` path (ringtone loop + Answer/Decline + ongoing + missed-call
  transform) NEVER runs (matches previous agent's "no [FCM]/WAKE events on
  receiver"). So #1/#3/#4 share ONE cause: the OS renders the call, not notifee.
- Proper fix = send call pushes DATA-ONLY + render via a reliable killed-app
  background handler (notifee/@react-native-firebase). That is the EXACT path
  that catastrophically regressed in iter-202 (all push died). It cannot be
  verified in the cloud env (killed-app FCM needs a real device build).
- The residual "message tone" is runtime/data (which channel actually rendered /
  what `call_channel_id` the device registered) — needs ONE device diagnostic to
  pin; not statically visible.

DECISION: do NOT blind-edit the fragile push delivery path (regression risk =
exactly what burned us in iter-202). Trio deferred to a device-in-hand session
where each change is immediately testable against the WAKE/[FCM] diagnostic
stream. Items #5 (recordings), #6 (photo download), #2 (call-end) already fixed.

---

## iter-215 — Multi-photo album send with per-image captions (chat composer)

Extended the staged image-preview (iter-212) to N photos:
- `pickPhoto` now uses `allowsMultipleSelection` (limit 10); picks stage into
  `pendingImages[]` (each `{uri, mimeType, caption}`); first inherits any typed text.
- Preview shows a horizontal **thumbnail strip** (active highlighted, per-thumb
  remove ×, blue dot = has caption). Tap a thumb to select; the composer input
  edits THAT image's caption (`setActiveCaption`); placeholder → "Add a caption…".
- `handleSend` uploads each image with its own caption sequentially; failures are
  restored to the strip for retry. Single-photo behaviour is unchanged (length 1).
- `sendImageFromUri` gained an optional `captionOverride`. Added `ScrollView` import.
- Verified: babel-transform clean, app bundles + renders Sign-In (smoke). Needs
  device verification (authenticated chat behind OIDC). No backend changes.

---

## iter-216 — Post-test fixes: receiver call-screen, archived UX, schedule edit

1. **Call lingered on receiver screen** (`app/twilio-call.tsx`): the receiver was
   never navigated away when the room ended remotely. Added a guarded auto-close
   effect — once the session reaches a terminal state ('disconnected'/'failed')
   AFTER having been active, the screen pops. `handleHangup` now uses the same
   guarded `closeScreen` (no double-nav).
2. **Archived UX** (`app/(tabs)/chats.tsx`, `app/archived.tsx`):
   - Full left-swipe now AUTO-archives (web parity) via `onSwipeableOpen` — no
     tap needed (the action button was also hidden behind the right-edge floating
     quick-action buttons).
   - Archived rows showed "Chat" instead of the contact name. New `ArchivedRow`
     component resolves the name the same way the main list does (device address
     book → saved contact → Smilers name) + avatar photo.
3. **Schedule edit missing Yearly** (`app/scheduled.tsx`): extended `Repeat` to
   include `hourly` + `yearly` (parity with the create sheet's frequencies);
   updated REPEAT_LABEL/REPEAT_OPTIONS and the draft→repeat passthrough. Also
   fixes blank labels for existing hourly/yearly schedules in the list.

Verified: all four touched files babel-transform clean; app bundles + renders
Sign-In (smoke). Needs device verification (authenticated flows behind OIDC).
Backend `repeat: 'yearly'/'hourly'` assumed supported by Convex (web edit already
offers Yearly → shared backend).

---

## iter-233 — 4-colour delivery dots (real component) + Offline Outbox

**Problem found:** the prior fork edited `src/components/chat/MessageBubble.tsx`,
but that `MessageBubble` is DEAD CODE — the chat timeline renders
`src/components/MediaBubble.tsx`. MediaBubble still had the old 3-colour mapping
(Blue/Yellow/Green, no RED, and GREEN/YELLOW swapped vs the web contract).

**Fixes:**
1. **MediaBubble.tsx** — status dot now evaluated top-down per the web
   `native-message-delivery-status-contract`: RED (`__outbox`/`__failed`) →
   BLUE (`readBy.length>0` excl. sender) → GREEN (`deliveredTo.length>0` excl.
   sender) → YELLOW (on server, no delivery yet). Group chats use ANY-recipient
   `.length>0`.
2. **NEW `src/lib/outbox.ts`** — AsyncStorage per-conversation queue
   (`smilers:outbox:v1:<id>`): load/enqueue/remove/markFailed for plain-text only.
3. **`app/chat/[conversationId].tsx`**:
   - Fresh text send that FAILS (offline/Convex unreachable) is queued to the
     outbox and rendered immediately in the timeline with a RED dot (no Alert).
     Edits and media keep the old "not sent" alert (not queued).
   - `flushOutbox()` auto-sends the queue on NetInfo reconnect + AppState
     'active' + on mount. Tap / long-press a RED message also retries.
   - Outbox entries merged into the `timeline` memo; swipe-to-reply disabled for
     them (no server id yet).
   - Installed `@react-native-community/netinfo` (11.4.1).

Verified: lint clean on changed files; bundle compiles; app renders Sign-In
(smoke). End-to-end offline behaviour needs device/build verification (auth is
Google OIDC + requires real network toggling — not exercisable in web preview).

---

## iter-234 — Offline read access to old messages (BUG FIX)

**Reported:** previous agent claimed offline message access worked; it never did.

**Root cause (`app/chat/[conversationId].tsx`):** the render gate was
`{conversationLoading || messagesLoading ? <spinner> : ...}`. When offline the
Convex `messages.list` query stays `undefined` forever → `messagesLoading`
stayed `true` → the screen showed "Taking longer than usual"/spinner and NEVER
rendered the FlatList, even though `cachedMessages` (iter-164 AsyncStorage cache)
were available. The conversation object + `me` were also `undefined` offline, so
the header showed "Loading…" and `isConversationAvailable` was false (composer
disabled, outbox couldn't trigger).

**Fix:**
- Cache the conversation object per-id (`chat-conversation` scope) when it
  resolves; read it back offline. Read cached `me` (`me`/`self` scope, already
  written by the Chats tab). Added `effectiveConversation = conversation ??
  cachedConversation` and `effectiveMe = me ?? cachedMe`.
- `hydratedConversation`, `isConversationAvailable`, header title, and the
  message `isMine`/`myUserId` now use the effective (cache-fallback) values.
- Render gate now bypasses the loading spinner when `hasCachedTimeline` (cached
  messages exist) → the FlatList renders cached history offline.

Result: opening a previously-synced chat while offline shows the full cached
timeline, correct sender alignment, and the contact name in the header. (Only
in-flight/undelivered incoming server messages aren't shown until reconnect, as
expected.) Lint clean; bundle compiles; Sign-In renders (smoke). Needs device
verification with real airplane-mode toggling.

---

## iter-235 — Post-test fixes (3 user-reported items)

1. **Call auto-switch to conference (Issue 1).** Root cause: the other party's
   `triggerMeshUpgrade` deferred navigation with
   `InteractionManager.runAfterInteractions(...)`. The call screen runs
   continuous animations (CallBackground orbs / ringing pulse) which keep an
   interaction handle open, so the queued `router.replace` never fired until
   the user tapped something (e.g. End). Fix (`app/call/[conversationId].tsx`):
   `triggerMeshUpgrade({ fromModal })` — initiator closes the picker <Modal>
   then `setTimeout(replace, 350)`; the other party navigates immediately via
   `setTimeout(replace, 0)` with NO InteractionManager. Removed the now-unused
   InteractionManager import.

2. **Green "delivered" dot never showed (Issue 2).** Root cause: `markDelivered`
   and `markRead` both fired only when the recipient OPENED the chat → jumped
   straight to BLUE; GREEN was never observable. Fix (`app/(tabs)/chats.tsx`):
   from the chats list, call `api.messages.markDelivered({conversationId})` for
   each conversation whenever its `lastMessageTime` changes (live/online only,
   deduped via a ref). Now the sender sees GREEN once the recipient's app syncs
   the list, then BLUE when they open the chat. (markDelivered excludes the
   sender, so own-conversation calls are no-ops.)

3. **Offline message vanished instead of showing as not-sent (Issue 3).** Root
   cause: Convex mutations DON'T reject when offline — `await sendMessage(...)`
   just hangs until reconnect, so the try/catch outbox-enqueue never ran and the
   message disappeared from the UI until reconnect. Fix
   (`app/chat/[conversationId].tsx`): in `handleSend`, when `isOffline`, enqueue
   to the outbox immediately (RED dot, WhatsApp-style pending) and skip the
   hanging mutation; auto-sends on reconnect. (Avoids duplicates since the
   mutation is never queued by Convex.)

Lint clean on all changed files; bundle compiles; Sign-In renders (smoke).
Needs two-device verification with airplane-mode toggling.

---

## iter-236 — Two remaining post-test issues (delivered dot + auto-switch)

**Issue 2 — green "delivered" still not showing.** The iter-235 chats-list
markDelivered only ran while the Chats tab was mounted; if the recipient was on
another screen (or the tab unmounted) delivered was never set, so yellow kept
"double duty". The push received-listener only fires in the FOREGROUND and the
background task can't run a Convex mutation. Fix: NEW global hook
`src/hooks/useDeliveryReceipts.ts`, mounted in `app/_layout.tsx`
(PresenceHeartbeat — inside Convex+Auth, runs on EVERY authenticated screen,
mirrors the web client's always-on subscription). It watches
`listConversations` and calls `messages.markDelivered({conversationId})` when a
conversation's lastMessageTime advances. Removed the chats-tab duplicate.

**Issue 1 — conference auto-switch still required tapping End.** Removing
InteractionManager (iter-235) wasn't enough — the receiver's trigger
(`activeCall.isConference` / `getCallInvites`) wasn't firing reliably
(getCallInvites likely filters to invites addressed to the current user, and
isConference may not echo promptly). Added a RELIABLE cross-device trigger in
`app/call/[conversationId].tsx`: subscribe to
`conference.getParticipants({callId})` — the initiator calls `joinConference`
the instant they enter the mesh host, so the roster becomes non-empty on the
other party's device. The upgrade watcher now fires on isConference OR invite OR
roster>0. Navigation: initiator `setTimeout(350)` after closing the modal; the
other party uses `requestAnimationFrame → setTimeout(0)`. Added `__DEV__`
console.logs at the watcher + triggerMeshUpgrade entry + router.replace for
field diagnosis.

Lint clean on changed files (pre-existing require/import warnings only); bundle
compiles; Sign-In renders. Needs two-device verification.

---

## iter-237 — Match web delivery dots + remove risky global hook + triage regressions

USER feedback: web app itself shows GREEN for both sent & delivered and never
shows yellow; also reported NEW regressions: photo attach stuck, delete-for-
everyone not propagating to receiver / not corrupting.

1. **Delivery dots → match web exactly** (`MediaBubble.tsx`): RED (outbox) →
   BLUE (readBy>0, excl sender) → GREEN (on server). Removed YELLOW and the
   delivered/read distinction entirely (green now appears as soon as the
   message is on the server, exactly like web).
2. **Removed `useDeliveryReceipts` global hook** (+ deleted the file, unmounted
   from `_layout.tsx`). It is no longer needed (green = on-server) and it was
   firing `markDelivered` mutations for EVERY conversation on every list update
   — a plausible source of Convex client backpressure / the new instability.
   Also removed the chats-tab variant earlier.
3. **Regression triage (NOT changed — backend/shared-Convex coupled):**
   - Photo attach: send path (`sendImageFromUri`/`uploadFile`) is untouched and
     uses the same Convex storage that working text uses. Suspect stale bundle
     or the removed global hook interfering. Needs clean reload + device logs.
   - Delete-for-everyone: `performDelete` already silently FALLS BACK to
     `deleteMessage({messageId})` (= delete-for-me) when `{mode:'everyone'}`
     throws (iter-97). The cross-device delete propagation + "corrupt on
     receiver" are BACKEND (shared Convex `messages.deleteMessage`) features —
     if the web team changed that schema, mobile's `mode:'everyone'` may now be
     rejected → silent delete-for-me. Requires backend/web-team confirmation.

Bundle compiles; Sign-In renders. Asked user to do a CLEAN reload and re-test
photo + delete; the removed global hook may have been the destabiliser.

---

## iter-238 — Delete-for-everyone/receiver: probe correct backend signature

USER: delete-for-everyone/receiver work on WEB (tombstone "This message was
deleted" shown) but NOT on mobile. Root cause: mobile sent
`deleteMessage({messageId, mode:'everyone'})`; the shared Convex backend (which
the web app uses successfully) validates args strictly and rejects that shape,
so the old code silently fell back to `deleteMessage({messageId})` = delete-for-
ME only → message gone for sender, still on receiver.

Fix (`performDelete` in chat): probe the realistic Convex signatures and use
whichever the backend ACCEPTS (strict validation makes wrong shapes throw
safely, so no accidental wrong-delete):
  everyone → tries forEveryone:true, deleteFor:'everyone', scope, deleteType,
             mode, then deleteMessageForEveryone()/deleteForEveryone().
  receiver → tries deleteFor/scope/deleteType/mode:'receiver'.
  me       → deleteFor:'me' / mode:'me' / deleteForMe() / bare {messageId}.
CRUCIALLY removed the silent bare-{messageId} fallback for everyone/receiver
(that was the delete-for-me masking). `__DEV__` logs which signature succeeded.

NOTE: exact web signature unknown (Convex backend lives in web repo; mobile uses
anyApi). If the probe still misses, need the web team's `messages.deleteMessage`
arg schema to lock it in. File-corruption-on-receiver is a separate backend
feature.

Lint clean; bundle compiles.

---

## iter-239 — Root-caused 3 issues from the WEB BUNDLE (definitive)

Inspected the deployed web bundle (smilers-app.onhercules.app/assets/index-*.js)
to get EXACT signatures instead of guessing.

1. **Delete for everyone/receiver** — web uses:
   `messages.deleteMessage({ messageId, forEveryone: true })` (everyone),
   `messages.deleteMessage({ messageId, forReceiver: true })` (receiver),
   `messages.deleteMessage({ messageId, forEveryone: false })` (me),
   `messages.requestDeletion({ messageId })` (request).
   Mobile was sending `{mode:'everyone'}` → strict-validation reject → silent
   delete-for-me. Rewrote `performDelete` + the media auto-purge to the exact
   web args. Removed the silent fallback.

2. **Delivery dots** — web logic (chat/page.tsx:3205-3208) is:
   read→`bg-blue-500`, else delivered→`bg-green-500`, else→`bg-yellow-500`.
   So my iter-237 "green=sent, no yellow" was WRONG. Restored proper 4-state in
   MediaBubble: RED(outbox)→BLUE(read)→GREEN(delivered)→YELLOW(sent).
   Re-added the global delivery hook as an EXACT port of the web's `Ure()`
   component: subscribe `messages.getUnreadCounts`, and call
   `markDelivered({conversationId})` whenever a conversation's unread count
   INCREASES. Mounted in _layout (PresenceHeartbeat). This populates
   `deliveredTo` so the sender actually sees green (was stuck on yellow).

3. **Photo attach stuck** — web image send includes `mimeType` (+fileName,
   fileSize); the mobile VIDEO send already sends `mimeType` (works) but the
   IMAGE send omitted it. Backend `messages.send` requires `mimeType` for media
   → image send rejected → "Upload failed" / photo stayed in composer. Added
   `mimeType` to `sendImageFromUri`'s send (matches web + the working video path).

Lint clean on changed files (pre-existing MediaBubble rules-of-hooks + _layout
require-style warnings only); bundle compiles; Sign-In renders.

---

## iter-240 — Media metadata, deletion-request prompt, delivered fix, conf logs

Verified all contracts against the deployed web bundle (smilers-app.onhercules.app).

1. **Photo attach stuck + video sends bad metadata** — web `messages.send`
   includes fileName + fileSize + mimeType for ALL media. Mobile image send
   omitted fileName/fileSize (and previously mimeType); video sends omitted
   fileName/fileSize. Added a `getMediaMeta(uri,mime,base)` helper
   (expo-file-system getInfoAsync) and now send fileName+fileSize+mimeType on
   image + both video paths. This is why photos stayed stuck in the composer
   and the deleted video left a broken frame (bad metadata → couldn't render).

2. **"Ask sender to delete" prompt (NEW feature)** — web uses
   `getPendingDeletionRequests({})` + `respondToDeletionRequest({requestId:_id,
   accept})`. Added a red in-chat banner (Decline / Delete) shown to the
   message owner, scoped to the conversation when the request carries
   conversationId.

3. **Green delivered dot** — removed the in-chat markDelivered (it fired with
   markRead on open → yellow skipped straight to blue). Delivery is now marked
   only by the global useDeliveryReceipts hook (getUnreadCounts increase),
   exactly like web's Ure() component.

4. **Conference auto-switch diagnostics (Step 1)** — the watcher now reads and
   logs `error` from getCallInvites + getParticipants safe-queries so a real
   device build's Metro logs show whether those backend fns error
   (CouldNotFindFunction) vs return empty. NOTE: mesh/group-call is native-only
   and won't populate the roster in Expo Go — must test on an EAS build.

Lint clean; bundle compiles; Sign-In renders. Most of these need a real device
build (Expo Go can't run mesh; push is dead in Expo Go).

## iter-241 — "No chats yet" lockout + per-user delete tombstone (isDeleted)

1. **"No chats yet" lockout (only reinstall fixed it)** — `chats.tsx` did
   `list = liveList ?? cachedList ?? []`, so when `listConversations` resolved
   to an EMPTY array (transient during Convex re-auth / stale SecureStore
   identity) the UI showed empty AND `writeCache` overwrote the good cache with
   `[]` — persisting the lockout (APK update kept storage; only reinstall
   cleared it). Fixes: prefer live ONLY when it has rows, else fall back to
   cached; guard writeCache to never clobber a non-empty cache with `[]`; and
   when live==empty but cache has rows, force ONE Convex reconnect to recover.
   (Root cause is a backend/auth session glitch returning empty — this makes
   the app self-heal instead of requiring reinstall.)

2. **Delete tombstone for me/receiver + video** — the web uses a unified
   `isDeleted` boolean (set per-viewer for forReceiver:true / forEveryone:false,
   globally for forEveryone:true). Mobile only checked `deletedAt`, so per-user
   deletes (and some media deletes) never showed "This message was deleted".
   MediaBubble now renders the tombstone for `deletedAt || isDeleted===true`.

Lint clean (pre-existing MediaBubble rules-of-hooks + chats dup-import warnings
only); bundle compiles; Sign-In renders.

## iter-242 — WebRTC signaling race fixes (from device call log)

CallSession.ts (native 1:1 engine):
1. **"handle answer failed: Called in wrong state: stable"** — two answers
   arrived back-to-back; the first connected (→stable), the second tried
   setRemoteDescription(answer) in stable state and threw. Fix: handleRemoteAnswer
   now skips any answer when signalingState is not 'have-local-offer'/
   'have-remote-pranswer', and marks lastAppliedAnswerPayload BEFORE the await so
   a concurrent identical answer is caught by the dup guard.
2. **"handleRemoteOffer: pc is null" / "Peer connection not initialized"** — on
   answering, the offer raced ahead of pc construction and was thrown away. Fix:
   handleRemoteOffer now stashes the early offer (pendingOfferPayload) instead of
   throwing; the pc-creation path replays it the moment the pc exists.

Lint clean (pre-existing RTCSessionDescription unused-type warning only); bundle
compiles; Sign-In renders. Native-only — verify on EAS device build.

## iter-243 — text tombstone, gallery-video metadata, receiver media purge
- MessageBubble.tsx: tombstone now fires on deletedAt || isDeleted (text per-viewer delete).
- pickVideo (gallery) now sends fileName+fileSize via getMediaMeta (was missed; only recordVideo had it).
- MediaBubble receiver purge now triggers on isDeleted too (local file corruption on delete-for-everyone).
- Backend Server Errors noted (NOT mobile): conference:toggleSelfMute, messages:setTranscription — web-team Convex fns.

## Group Pinned Post (Admin-gated) — iter-336
- Groups: only admins (chief admin / any admin / creator, via `groupAdmin.getGroupAdminInfo.isAdmin`) can pin/unpin; regular members don't see pin controls. Direct 1:1: either party can pin.
- One pinned post per chat — pinning replaces the previous; unpinning clears it. Banner (`getPinnedMessage`) shows at top of chat, visible to all members; admins get an unpin (✕) affordance.
- Canonical contract: `conversations.pinMessage({ conversationId, messageId })` pin/replace; `conversations.pinMessage({ conversationId })` unpin; `conversations.getPinnedMessage({ conversationId })` read banner.
- Files: `app/chat/[conversationId].tsx` (queries, onPin/onUnpinBanner, banner), `src/components/chat/MessageActionSheet.tsx` (canPin/isPinned → Pin/Unpin row).

## Mobile Money Payment Requests — iter-339
- Users: Premium screen → "Pay with Mobile Money" → app/mobile-money.tsx: pick plan (Monthly/6-Months/Yearly), pick country (17 African countries, default KE), optional pay-from phone, ≈ estimate, confirm → mobileMoneyRequests.createRequest (action) → success screen w/ authoritative amount+currency. getMyRequests lists own requests w/ status.
- Admin: app/admin.tsx new "Payments" tab (badge = countPendingRequests) → src/components/admin/MobileMoneyAdmin.tsx: Pending/History toggle; per-request Message (admin.messaging.messageUsers) / Complete (completeRequest → auto-activates plan) / Decline (declineRequest). Completed/declined move to History.
- Shared constants mirrored verbatim from web convex/lib/mobileMoney.ts in src/lib/mobileMoney.ts (MOBILE_MONEY_COUNTRIES, FALLBACK_EUR_RATES, roundLocalAmount, PREMIUM_PLANS). country=ISO alpha-2; phone omitted (undefined) when blank.
- Files: src/lib/mobileMoney.ts, app/mobile-money.tsx, src/components/admin/MobileMoneyAdmin.tsx, app/premium.tsx, app/admin.tsx. Backend Convex funcs assumed deployed on web side.


---

## Session addendum (fork continuation)

### Asante Twi transcription (DONE)
- Backend `/api/transcribe` + `/api/transcribe/upload` route Akan/Twi audio to **Gemini 2.5-flash** (Twi-tuned prompt); other languages stay on Whisper. Frontend passes sender's spoken language(s) as `language_hint`. Verified via curl.

### Voice-note translation → receiver's language (DONE, device build needed to verify)
- New backend `POST /api/tts` (OpenAI `tts-1`, multilingual, Emergent key). Reuses `/api/translate`.
- Frontend `src/lib/voiceTranslation.ts` + `VoiceTranslationPill` in `MediaBubble`: auto-translates RECEIVED voice notes to the receiver's preferred language (text + "Play in <lang>" TTS), honouring the receiver's skip/spoken languages. Cached on-device.

### Unread badge not clearing (DONE, device build needed)
- On-device read overlay `src/lib/localReadState.ts` + `useLocalReadMap`: opening a chat / swipe-read / mark-all-read clears the list badge instantly (backend `getUnreadCounts` was lagging); badge re-shows only when a newer message arrives. Wired into chats, groups, tab badges, app-icon badge.

### Silent mobile voice-note recordings (FIX SHIPPED, awaiting device confirmation)
- Root cause hypothesis: `RecordingPresets.HIGH_QUALITY` records STEREO; mono-mic phones produce a valid-but-silent .m4a.
- Fix: `src/lib/audioRecording.ts` `VOICE_RECORDING_OPTIONS` = mono + metering enabled; applied to chat + voice-command recorders. Record bar now shows a **live mic-level meter** (diagnostic). Also added post-call `setAudioModeAsync` reset in `app/call/[conversationId].tsx` + settle delay before recording.

### Drive Mode (DONE, device build needed to verify — mic/speech/calls)
- `src/lib/driveMode.ts` (global on/off store, not persisted), `DriveModeToggle` (pill above SOS on chats+profile, auto-dims, reveals on touch), `DriveModeController` (global, in `_layout.tsx`).
- When ON: single continuous `expo-speech-recognition` session (paused on active-call routes). Commands: **answer/pick up/accept** → route via `/incoming-call?autoAnswer=1` (or `answerInvite` for inviteId); **decline** → `declineCall`/`declineInvite` + `messages.send("I'm driving and will call you back.")`; **reject** → decline silently; **listen** → `getLatestIncomingMedia(voice)` + play; **watch** → `getLatestIncomingMedia(video)` + full-screen player. Backend fns confirmed live on Convex `aware-newt-456`.
- Known limitation: answering a NEW call WHILE already in an active call isn't triggered on native (recognizer paused during active-call routes due to mic contention).


## Smilers Study AI — Phase 1 (implemented, pending native QA)
Premium-gated AI homework tutor. Backend = web/Convex (`api.study.*`); mobile builds the client.
- Dashboard `app/study/index.tsx`: 6 subject cards (Scan Homework, Ask, Mathematics, Science, Language*, Revision* — *later phases). Premium gate via `usePremiumAccess`.
- Session `app/study/session.tsx`: text + camera/gallery/PDF (images upload to Convex File Storage via `uploadFile`), 6 response modes (Hint/Guide/Explain/Check-work/Verify/Similar-practice), reactive reply via `getSession`, save-to-Diary via `setSessionSaved`.
- `api.study.ai.ask` (action, gated: throws ConvexError code PREMIUM_REQUIRED), `api.study.sessions.*`.
- LaTeX via KaTeX-in-WebView (`src/components/study/LatexView.tsx`); tolerant structured-answer renderer (`StudyAnswer.tsx`).
- Entry point: "Study" button in `app/ai-chat.tsx` header → `/study`.
- Next phases: Study Rooms (group integrations).
- NOTE: getSession message field shapes rendered defensively (camelCase + snake_case) — reconcile against `native-study-ai-contract.json` once verified on a premium account.

## Smilers Study AI — Phase 2: Language Coach (implemented, native QA pending)
- `app/study/session.tsx` with `subject=language`: target-language chips (English/Italian/French/Spanish/German/Portuguese/Arabic) replace response-mode chips; `ask` receives `language` instead of `mode`.
- "Read aloud" button on each AI answer bubble → `api.study.languageAi.speak({ text, language })` returns `{ audioBase64, mimeType }`, played locally via expo-audio (`useStudySpeak`). Audio needs a native build to verify.

## Smilers Study AI — Phase 3: Revision Studio (implemented, native QA pending)
Fully Convex-backed (`native-study-ai-revision-contract`). Client bindings in `src/lib/study/useRevision.ts`.
- Hub `app/study/revision.tsx`: streak/saved stats header, tabs (Quizzes/Flashcards/Notes), Create sheet (Premium-gated generation from topic/subject/pasted notes).
- Generation actions (gated): `api.study.revisionAi.{generateQuiz→{quizId}, generateFlashcards→{deckId}, generateSummary→{noteId}, generateStudyPlan→{noteId}}` (accept `sourceSessionId?`/`sourceText?`/`subject?`/`topic?`).
- Quiz runner `app/study/quiz/[quizId].tsx`: server-side grading only (`submitQuizAttempt({quizId, answers:[{number,given}]})` → render `graded[]`), MCQ + free-text, save/delete via `setQuizSaved`/`deleteQuiz`.
- Flashcards `app/study/deck/[deckId].tsx`: Leitner flip/review (`getDueCards`, `reviewFlashcard({cardId, rating:'again'|'good'|'easy'})`), boxes 0..5 intervals [0,1,2,4,7,15]d.
- Notes/plans `app/study/note/[noteId].tsx`: renders `kind:'summary'|'study_plan'` (day-by-day plan or sectioned summary), defensive field shapes.
- Ungated: `api.study.revision.{listQuizzes,getQuiz,listDecks,getDeck,listNotes,getNote,set*Saved,delete*}`; folders `api.study.folders.*`; progress `api.study.progress.{getProgress,getRecentActivity,logLessonStudied}`.
- New material starts `isSaved=false`. LaTeX (`promptLatex`/`finalAnswerLatex`) renders via LatexView without `$`.

## Smilers Study AI — Phase 4: Study Rooms (implemented, native QA pending)
Standalone social layer (NOT tied to Smilers group chat; AI never reads chat messages). Convex-backed (`native-study-ai-social-contract`). Client bindings in `src/lib/study/useRooms.ts`. Entry: "Study Rooms" card on the Study dashboard (FREE — not premium-gated; only AI quiz generation is Premium).
- Rooms list `app/study/rooms/index.tsx`: my rooms, Create room, Join by 6-char uppercase code (`previewRoomByCode` → confirm → `joinRoom`).
- Room detail `app/study/rooms/[roomId].tsx`: join-code card (tap to copy), tabs Quizzes/Decks/Members. `getRoom` returns null for non-members → "not a member" state. Admins see a settings gear.
- Group quizzes: `api.study.rooms.{listRoomQuizzes,getRoomQuiz,shareQuizToRoom,submitRoomQuizAttempt,deleteRoomQuiz}` + `api.study.roomsAi.generateRoomQuiz` (ONLY premium-gated call; `useRoomContent=true` while AI-access off → FORBIDDEN handled). Quiz runner `rooms/quiz/[roomQuizId].tsx` with Quiz + Leaderboard tabs (server-graded, best attempt per member).
- Collaborative decks: `api.study.rooms.{listRoomDecks,getRoomDeck,createRoomDeck,addRoomCard,deleteRoomCard,deleteRoomDeck}`. `rooms/deck/[roomDeckId].tsx`: any member adds cards; flip-through Study mode.
- Admin settings `rooms/settings/[roomId].tsx`: rename/describe (`updateRoom`), "Let Study AI use this room's shared material" toggle (`aiCanReadRoomContent`, off by default), regenerate join code, member management (`setMemberRole`/`removeMember`), delete room (owner) / leave room.
- Limits: 100 members/room, 500 cards/deck, 20 questions/quiz.

## Push: duplicate message notification fix (iter-fork, native QA pending)
- Root cause: backend now sends message pushes as notification-type FCM (visible, server-rendered per-recipient device-contact title). Android auto-displays it, but the JS background task (`src/push/backgroundTaskSetup.ts` `presentBackgroundLocalNotification`) ALSO scheduled its own local banner — which in the headless context fell back to the sender's Google/account name. Result: two notifications per message.
- Fix: in the MESSAGE path of `backgroundTaskSetup.ts`, re-added the `shouldScheduleLocalNotification(taskObject)` guard so the JS local banner is suppressed whenever the FCM already carried a title/body (notification block). Only genuinely data-only message pushes fall through to schedule locally. Needs native APK verification.
- Calls: `data.callerPhone` (E.164) is confirmed sent by backend when the caller has a phone; native Kotlin `lookupContactNameByPhone` resolves the device-contact name. Google-name fallback only when caller has no stored phone.

## Emergency Alert VIEWER screen (iter-fork, native QA + Convex publish pending)
- Route: `app/emergency/[alertId].tsx` (registered in `app/_layout.tsx`). Emergency push `action_url = "/emergency/<alertId>"` deep-links here.
- Reactive Convex queries (via `useSafeConvexQuery`): `api.emergencyAlerts.getAlertForViewer({alertId})`, `api.emergencyRecordings.getRecordingsForAlert({alertId})`, `api.emergencyCaptures.getCapturesForAlert({alertId})`.
- UI: alerter card (avatar/name/status active|resolved/quick-call), LIVE MAP (Leaflet+OpenStreetMap in react-native-webview; marker repositions via injectJavaScript on lat/lng change; "Open in Maps" fallback), audio recordings list (expo-audio per-item player), camera captures grid (expo-video VideoView for video, Image for photo). Graceful "Alert unavailable" state when null/unauthorized.
- BLOCKER: `getAlertForViewer` + `updateAlertLocation` are built on the user's Convex backend but NOT published yet — user must click Publish. Full functionality (map/audio/video/deep-link) is native-build only.

## Emergency alerter auto-broadcast (iter-fork, native QA + Convex publish pending)
- New hook `src/lib/emergency/useEmergencyBroadcaster.ts`, wired into `app/emergency.tsx` (called with `activeAlert`). While the user has an ACTIVE (non-resolved) alert, the device auto-broadcasts:
  1. LIVE LOCATION — `Location.watchPositionAsync` (High accuracy, ~12s throttle) → `api.emergencyAlerts.updateAlertLocation({latitude,longitude})`; viewer map pin glides live.
  2. AUDIO — rolling ~30s clips via `useAudioRecorder(VOICE_RECORDING_OPTIONS)` → `uploadFile(..., api.emergencyRecordings.generateUploadUrl)` → `api.emergencyRecordings.saveRecording({alertId,storageId,durationSeconds})`.
- Graceful degradation: all calls try/catch; mic-denied keeps location broadcasting (never dead-ends SOS); `updateAlertLocation` failures swallowed (unpublished-safe). Foreground-only MVP; loop stops on resolve/unmount. Mic + location permissions already declared in app.json.
- Camera photo/video auto-capture NOT included (needs a mounted camera view / native module) — future.

## Duplicate message notification — SERVER-SIDE FIX (iter-fork)
- Root cause (confirmed w/ Emergent Support): message pushes carried a `notification` block, so Android auto-displayed the SERVER title (sender's Google/account name) the instant the FCM arrived, WHILE the app's background JS task rendered a SECOND notification using the recipient's saved DEVICE-CONTACT name → two notifications per message.
- Fix (backend relay `/app/backend/server.py`, in `send_push`): message pushes are now sent DATA-ONLY (`is_message_push = routing.get("type")=="message"` added to `android_data_only`). The OS no longer auto-displays anything; only the app's background task renders the single, device-contact-named notification — same reliable high-priority data-only path calls use. Emergency/login-approval/broadcast are NOT typed "message" so they keep their notification block (stay OS-displayed).
- iOS unaffected: APNSConfig always sets aps.alert regardless of android_data_only.
- DEPLOYMENT: this is SERVER-SIDE only — the existing APK already renders the device-name notification, so NO new APK is needed. User must RE-PUBLISH the backend to deploy.
- Minor tradeoffs: (1) no OS heads-up banner for messages while app is in FOREGROUND (bg task returns early when active); (2) force-stopped apps won't render (accepted Android limit, same as calls).
- Also reverted my earlier `backgroundTaskSetup.ts` message-path guard (it's a no-op now since data-only means no OS dup to guard against; JS always renders once).
- Call wake-screen: user confirms screen now wakes; minor delivery inconsistency accepted for now.

## In-app foreground message banner (iter-fork)
- New component `src/components/InAppMessageBanner.tsx`, mounted in `app/_layout.tsx` after UpdateBanner (overlay, zIndex 9999, inside Auth/Convex/DeviceContact providers).
- Shows a heads-up banner sliding from the top when a NEW message arrives while the app is FOREGROUND (replaces the OS heads-up that's gone now that messages are data-only). Driven by the Convex `listConversations` realtime subscription (deduped with the sound hook's query).
- Skips: web, backgrounded app, first snapshot, own messages, and the currently-open chat. Shows the same DEVICE-CONTACT name as the chats list via `getResolvedConversationDisplayName` + device contact index.
- Interactions: tap → opens `/chat/<id>`; swipe up or tap × → dismiss; auto-dismiss after 4s.
- Frontend-only → REQUIRES a new APK build to test on device (unlike the data-only dedup fix which is server-side).

## In-app banner — unread badge + haptic (iter-fork)
- `InAppMessageBanner.tsx`: added a red unread-count pill on the avatar corner, sourced live from `api.messages.getUnreadCounts` (shows 99+ cap); and a light `expo-haptics` impact when the banner slides in, so it lands together with the message tone (both are driven by the same reactive listConversations update). Frontend-only → needs new APK to test on device.

## In-app banner — group message titles (iter-fork)
- `InAppMessageBanner.tsx`: group conversations now titled "Sender in GroupName" when a sender field is available on the conversation row (read defensively: lastMessageSenderName/lastSenderName/lastMessageSender.name/lastMessageAuthorName/lastMessageSenderDisplayName), else falls back to just the group name. Group detection: isGroup || type==='group' || participants>2. 1:1 unchanged (device-contact name). NOTE: listConversations does not currently expose a last-message sender name in frontend-accessed fields, so the "Sender in ..." prefix only appears if the backend includes one — otherwise group name shows.

## Duplicate notif REAL root cause + emergency media capture (iter-fork)
- DUPLICATE ROOT CAUSE (the data-only change alone didn't fix it): `send_push` fires BOTH FCM v1 AND the Emergent relay (/api/v1/push/trigger) "in parallel". Calls already skip the relay; MESSAGES did not — the relay posts a plain banner titled with the SERVER (sender Google) name = the 2nd notification. FIX (server.py): added `is_message_push_global`; messages now skip the Emergent relay when FCM v1 already delivered (>=1 token). Relay still used as fallback if FCM reached no token. SERVER-SIDE → re-Publish backend (no APK).
- EMERGENCY MEDIA: video was never captured on the alerter side, and a standalone audio recorder + camera video fight over the mic. Refactor: `useEmergencyBroadcaster` is now LOCATION-ONLY; new `src/components/EmergencyMediaCapture.tsx` (mounted hidden in app/emergency.tsx) runs a SEQUENTIAL loop: ~12s VIDEO clip (camera+mic) -> emergencyCaptures(type video); then ~10s AUDIO clip (mic) -> emergencyRecordings. Requests camera+mic perms on active alert; degrades gracefully (no capture if denied, location unaffected). Foreground-only; needs NEW APK. Errors now logged (console.warn) instead of silently swallowed.

## Always-on emergency capture via foreground service (iter-fork)
- NEW global `src/components/EmergencyCaptureService.tsx` mounted in app/_layout.tsx (after CallWakeBootstrap). Watches api.emergencyAlerts.getActiveAlert; while active, broadcasts regardless of screen: live location (updateAlertLocation), audio clips (emergencyRecordings), video clips (emergencyCaptures). Sequential video->audio loop (shared mic). Removed the old screen-scoped useEmergencyBroadcaster + EmergencyMediaCapture (files deleted; imports/mounts removed from emergency.tsx).
- NEW `src/lib/emergency/emergencyForegroundService.ts`: starts a notifee FOREGROUND SERVICE (types microphone|location, only the permission-granted subset — never an undeclared/ungranted type, which would throw the uncatchable MissingForegroundServiceTypeException) with an ongoing "Emergency active" notification. Keeps AUDIO + LOCATION alive when backgrounded/screen-locked. Stops on resolve/unmount.
- Config plugin `plugins/withNotifeeForegroundServiceType.js`: FGS_TYPE changed 'mediaPlayback' -> 'mediaPlayback|microphone|location' so the emergency FGS types are declared in the merged manifest.
- VIDEO is FOREGROUND-ONLY (Android blocks background camera): the hidden CameraView only mounts when appActive; on background the loop skips video, keeps audio+location. camera-ready reset on background.
- Requires a NEW APK (native manifest/plugin + camera/FGS). Cannot validate in Expo Go/preview. Graceful degradation on any denied permission.

## Emergency "Stop sharing" notification action (iter-fork)
- The ongoing "Emergency active" foreground-service notification now has a "Stop sharing" action (pressAction id `emergency-stop`), with alertId carried in the notification data.
- `emergencyForegroundService.ts`: added `stopEmergencySharing(alertId?)` — resolves the alert server-side via an authed ConvexHttpClient (anyApi.emergencyAlerts.resolveAlert, token from SecureStore 'smilers_id_token') then tears down the FGS. Works headlessly (no React).
- Wired into the central notifee handlers in `notifeeCallWake.ts` (both onBackgroundEvent and onForegroundEvent) alongside the existing stop-playback routing. Resolving flips getActiveAlert→null → EmergencyCaptureService.shouldRun false → capture + FGS stop reactively (double-stop is guarded). Needs new APK.

## Emergency "Sharing live" persistent banner (iter-fork)
- NEW `src/components/EmergencyActiveBanner.tsx`, mounted globally in app/_layout.tsx. Slim red top strip with a pulsing dot + "Sharing live · tap to view" shown whenever the current user has an active alert (getActiveAlert). Tap → /emergency. Hidden on web, when no active alert, and while already on the emergency screen. Frontend-only → needs new APK to see on device.

## Duplicate notif — relay skip hardened (iter-fork)
- Confirmed native app has NO service worker/web push (only LaTeX + auth WebViews) — on device both notifications arrive via FCM.
- The "Smilers"(default-label) copy = the Emergent relay (/api/v1/push/trigger) notification-block push firing next to the FCM v1 data-only push the app renders as the contact name ("ABC Albania").
- Prior skip used success_count>0, so a STALE-token FCM failure (0 successes) still let the relay leak the duplicate. NOW gated on stats.token_count>0 (any native recipient with registered FCM tokens) → relay skipped regardless of delivery success. Web-only recipients (token_count 0) still get the relay.
- ALL fixes are in the Emergent/FastAPI backend (server.py). REQUIRES BACKEND RE-PUBLISH/DEPLOY to take effect — repeated "still duplicates" strongly implies the deployed relay was not refreshed.

## Diagnostic tool restored + MSG-PUSH instrumentation (iter-fork)
- Re-added 'Diagnostic Logs' row to app/settings.tsx (route /diagnostic-logs; was hidden since iter-176 for Play Store). Screen already had Copy/Share.
- Instrumented backgroundTaskSetup.ts message path: recordDiagnostic tag 'MSG-PUSH' logs `hasNotifBlock` (=!shouldScheduleLocalNotification) + title + resolved name + key for every incoming message FCM. hasNotifBlock=true ⇒ deployed relay STILL sending notification-type (data-only fix not live on the relay the APK actually uses) ⇒ likely MOBILE_BACKEND_URL points to a backend NOT running this server.py, OR backend not redeployed. hasNotifBlock=false ⇒ data-only live; duplicate source is elsewhere.
- Frontend change → needs NEW APK. User then: send a duplicating message → Settings → Diagnostic Logs → copy MSG-PUSH rows → paste to support.
- OPEN QUESTION for user: does Convex MOBILE_BACKEND_URL point to THIS Emergent app backend's deployed URL? If not, none of the server.py relay fixes reach the APK.

## DEPLOYMENT PROOF — deployed relay is STALE (iter-fork)
- Added a `push_pipeline` marker to GET /api/health {build:'iter-fork-msg-dataonly-v2', message_data_only, message_skips_emergent_relay_for_native}.
- curl https://app-migration-75.emergent.host/api/health (the confirmed MOBILE_BACKEND_URL) → NO push_pipeline field, version 2.2.17 → DEPLOYED BACKEND HAS OLD CODE. None of the message-notif fixes are live. This is why duplicates persist despite "always publishing".
- Local /api/health returns push_pipeline correctly (fix present & correct).
- ACTION: user must RE-PUBLISH so backend redeploys. VERIFY by curling deployed /api/health for push_pipeline.build. If it still doesn't appear after publish → Publish isn't redeploying the backend → route to support_agent (platform/deploy issue). No APK needed for the duplicate fix.
