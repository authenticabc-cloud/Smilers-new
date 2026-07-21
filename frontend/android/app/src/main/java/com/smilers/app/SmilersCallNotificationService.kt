package com.smilers.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.interfaces.FirebaseMessagingDelegate as FirebaseMessagingDelegateInterface

class SmilersCallNotificationService : ExpoFirebaseMessagingService() {

    companion object {
        private const val TAG = "SmilersCall"
        private const val CALL_CHANNEL_ID = "incoming-call-native-v1"
        private const val MISSED_CALL_CHANNEL_ID = "missed-call-native-v1"
        private const val NOTIFICATION_ID_BASE = 0x53004C
        private const val MISSED_NOTIFICATION_ID_BASE = 0x53104C
        private const val RING_TIMEOUT_MS = 35_000L
        // 5-minute window: backend sends direct + relay missed-call FCMs up to 2 min apart,
        // and FCMs can arrive 7+ min after the call ends (backend delay). Both must be caught
        // by dedup so only one native notification is shown. Process death resets the map but
        // the first FCM that wakes the service populates it before the second FCM arrives.
        private const val DEDUP_WINDOW_MS = 300_000L

        // Plain map + explicit lock so check-then-mark is atomic (Fix 2).
        private val recentlyHandled = mutableMapOf<String, Long>()
        private val dedupLock = Any()

        // Tracks convIds/callIds that have been explicitly cancelled by the caller.
        // When the relay ring FCM arrives AFTER the call-cancelled FCM (FCM delivery is
        // unordered), we use this set to suppress the late ring instead of ringing for 35s.
        // Entries expire after 60 s (see handler.postDelayed in handleCallCancelledMessage).
        private val cancelledConvIds = mutableSetOf<String>()

        // sml-015: ids the foreground JS listener (useIncomingCallListener.ts) has already
        // taken over for — it pushed its own in-app incoming-call UI. The Convex live-query
        // update that drives that decision is near-instant over an already-open WebSocket,
        // while the FCM push that triggers THIS notification has to round-trip through
        // Firebase — so the JS "dismiss the notification" call very often runs BEFORE the
        // notification has even been posted yet. Marking the id here (checked in
        // handleCallMessage, mirroring cancelledConvIds above) suppresses the notification
        // for an FCM that's still in flight, not just one already showing. Self-expires
        // after 30 s — comfortably longer than any realistic FCM delivery delay.
        private val foregroundHandledIds = mutableSetOf<String>()

        // Ring-timeout: posts missed-call immediately 1s after the 35s ring expires, without
        // waiting for the backend FCM (which can arrive 7-9 minutes late).
        // The timeout is cancelled when the user answers/declines (via CallActionReceiver) or
        // when the backend FCM arrives early (via handleMissedCallMessage).
        private val handler by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }
        private val pendingTimeouts = mutableMapOf<String, Runnable>()  // callId → runnable
        // Stores callerName keyed by callId/conversationId when ring FCM arrives.
        // Used by call-cancelled FCM handler to show the correct name in missed-call.
        private val callIdToCallerName = mutableMapOf<String, String>()

        // Caches key fields from the direct-path ring FCM (type=call), keyed by both callId
        // and conversationId. The relay-path FCM body only contains conversationId/callId/type —
        // it never carries backendUrl or callerId. We populate this cache BEFORE the dedup check
        // so that even if the direct FCM is suppressed, the relay FCM can look up these values
        // and build a Decline button that actually reaches the caller.
        private val directFcmCache = mutableMapOf<String, Map<String, String>>()
        private val DIRECT_FCM_FIELDS = setOf(
            "backendUrl", "callerId", "callerIdentity",
            "callerName", "displayName",
            "twilio_room_name", "twilio_caller_identity", "twilio_is_video", "callType"
        )

        // Caches the relay FCM's callId (the actual Convex call document ID) keyed by conversationId.
        // The relay callId differs from the direct FCM's callId (which equals conversationId).
        // After fix U the ring notification uses conversationId as its stable ID, so both FCMs
        // update the same notification slot. But if the direct FCM's handleCallMessage runs LAST
        // (rare cold-start race), it overwrites the Decline PendingIntent with callId=conversationId.
        // CallActionReceiver reads this cache at tap-time to always pass the correct Convex call ID.
        private val relayCallIdByConvId = mutableMapOf<String, String>()

        // Returns cached fields from the direct-path ring FCM for the given callId/convId.
        // Used by CallActionReceiver to recover backendUrl/callerId when the relay FCM built
        // the notification before the direct FCM cache was populated (first-call race condition).
        fun getDirectFcmCache(callId: String, convId: String): Map<String, String> =
            synchronized(dedupLock) { directFcmCache[callId] ?: directFcmCache[convId] ?: emptyMap() }

        // Returns the relay FCM's callId (actual Convex call document ID) for the conversation.
        // Falls back to null when the relay FCM hasn't been processed yet.
        fun getRelayCallId(callId: String, convId: String): String? =
            synchronized(dedupLock) { relayCallIdByConvId[convId] ?: relayCallIdByConvId[callId] }

        // sml-010: cancellable delayed backstop for the in-app silent-decline flow.
        // CallActionReceiver launches the app straight to a headless screen that
        // declines over the live authenticated Convex session; this map holds the
        // OLD native-only decline path (direct notify-event / raw Convex mutation)
        // as a bounded fallback in case the in-app path doesn't confirm in time
        // (auth not ready, network blip). Mirrors pendingTimeouts exactly.
        private val pendingDeclineFallbacks = mutableMapOf<String, Runnable>()

        /** Schedule the native decline backstop. Reuses the existing main-thread Handler. */
        fun scheduleDeclineFallback(key: String, runnable: Runnable, delayMs: Long) {
            if (key.isEmpty()) return
            synchronized(dedupLock) {
                pendingDeclineFallbacks[key]?.let { handler.removeCallbacks(it) }
                pendingDeclineFallbacks[key] = runnable
            }
            handler.postDelayed(runnable, delayMs)
            Log.d(TAG, "scheduleDeclineFallback: scheduled for key=$key in ${delayMs}ms")
        }

        /**
         * sml-015: called by SmilersCallModule.dismissRingNotification — marks this call as
         * already handled by the foreground in-app UI so handleCallMessage suppresses the
         * ring notification whether the FCM that would post it already arrived (nothing to
         * do beyond the caller's own dismiss-if-showing step) or hasn't arrived yet (this is
         * what actually prevents it from ever appearing in that ordering).
         */
        fun markForegroundHandled(callId: String, conversationId: String) {
            synchronized(dedupLock) {
                if (callId.isNotEmpty()) foregroundHandledIds.add(callId)
                if (conversationId.isNotEmpty()) foregroundHandledIds.add(conversationId)
            }
            handler.postDelayed({
                synchronized(dedupLock) {
                    foregroundHandledIds.remove(callId)
                    foregroundHandledIds.remove(conversationId)
                }
            }, 30_000L)
        }

        /** Called by SmilersCallModule once the in-app decline confirms — cancels the backstop. */
        fun cancelDeclineFallback(key: String): Boolean {
            if (key.isEmpty()) return false
            val r = synchronized(dedupLock) { pendingDeclineFallbacks.remove(key) }
            if (r != null) {
                handler.removeCallbacks(r)
                Log.d(TAG, "cancelDeclineFallback: cancelled for key=$key")
                return true
            }
            return false
        }

        fun cancelMissedCallTimeout(callId: String) {
            val r = synchronized(dedupLock) { pendingTimeouts.remove(callId) }
            if (r != null) {
                handler.removeCallbacks(r)
                // Remove any convId-keyed entry pointing to the same runnable (stored in build L).
                synchronized(dedupLock) {
                    pendingTimeouts.filter { it.value === r }.keys.toList().forEach { pendingTimeouts.remove(it) }
                }
                Log.d(TAG, "cancelMissedCallTimeout: cancelled for callId=$callId")
            }
        }

        // Returns true if `key` was already handled within the dedup window (caller must skip).
        // Returns false on first call for this key (caller may proceed — key is now marked).
        private fun checkAndMarkHandled(key: String): Boolean {
            synchronized(dedupLock) {
                val now = System.currentTimeMillis()
                val t = recentlyHandled[key]
                if (t != null && now - t < DEDUP_WINDOW_MS) return true
                recentlyHandled[key] = now
                val expired = recentlyHandled.filter { now - it.value > DEDUP_WINDOW_MS * 2 }.keys.toList()
                expired.forEach { recentlyHandled.remove(it) }
                return false
            }
        }

        /**
         * Called from SmilersCallModule (JS → Kotlin bridge) when Convex's WebSocket detects
         * that the caller cancelled before the ring timeout. Posts a missed-call notification
         * using the same channel and ID scheme as the ring-timeout runnable, and marks the
         * dedup key so the 36s timeout runnable won't also post if it somehow still fires.
         */
        fun postMissedCallFromJs(ctx: Context, callId: String, conversationId: String, callerName: String) {
            val notifKey = callId.ifEmpty { conversationId }
            if (notifKey.isEmpty()) return
            // Mark handled so the ring-timeout runnable skips if it still fires
            checkAndMarkHandled("missed:$notifKey")
            val appCtx = ctx.applicationContext
            val displayName = callerName.ifBlank { "Smilers user" }
            // Ensure missed-call channel exists
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val mgr = appCtx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (mgr.getNotificationChannel(MISSED_CALL_CHANNEL_ID) == null) {
                    mgr.createNotificationChannel(NotificationChannel(MISSED_CALL_CHANNEL_ID, "Missed Calls",
                        NotificationManager.IMPORTANCE_DEFAULT).apply { enableVibration(false) })
                }
            }
            val missedId = MISSED_NOTIFICATION_ID_BASE + (notifKey.hashCode() and 0x0FFF)
            val tapUrl = if (conversationId.isNotEmpty()) "smilers://chat/$conversationId" else "smilers://home"
            val tapIntent = Intent(appCtx, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                data = Uri.parse(tapUrl)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val tapPi = PendingIntent.getActivity(appCtx, missedId, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            NotificationManagerCompat.from(appCtx).notify(missedId,
                NotificationCompat.Builder(appCtx, MISSED_CALL_CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("Missed call")
                    .setContentText("$displayName called")
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setContentIntent(tapPi).setAutoCancel(true).build())
            Log.d(TAG, "postMissedCallFromJs: posted missedId=$missedId callerName=$displayName notifKey=$notifKey")
        }
    }

    init { Log.d(TAG, "INSTANTIATED — build 20260706-C") }

    override fun onCreate() {
        super.onCreate()
        // Suppress the legacy FCM notification channel as early as possible — before any FCM
        // can be auto-displayed on it. This runs once when the service process starts.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                suppressLegacyCallsChannel(getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            } catch (e: Exception) { Log.w(TAG, "onCreate suppress: ${e.message}") }
        }
    }

    // ─── Layer 0: handleIntent — fires for ALL FCM delivery paths (startService + binder) ───
    override fun handleIntent(intent: Intent) {
        Log.d(TAG, "handleIntent: action=${intent.action}")
        val extras = intent.extras
        // Set to true for call-declined FCMs (direct or relay) that intentionally fall through
        // to super.handleIntent. Used below to guard the auto-cancel logic so message and other
        // non-call FCMs are NOT accidentally stripped of their OS-displayed notification.
        var isCallRelatedFcm = false
        if (extras != null) {
            val data = bundleSafeToDataMap(extras)
            val type = data["type"]

            // Path A: direct incoming call
            if (type == "call") {
                val callId = data["callId"] ?: ""
                if (callId.isNotEmpty()) {
                    val convId = data["conversationId"] ?: ""
                    // Log and cache BEFORE dedup — relay FCM body lacks backendUrl/callerId.
                    // The relay always arrives after this and builds its own notification via
                    // buildRelayCallData; without the cache it would have empty backendUrl.
                    Log.d(TAG, "handleIntent (direct call): callId=$callId convId=$convId")
                    Log.d(TAG, "handleIntent (direct call) FULL DATA: $data")
                    val snapshot = data.filter { it.key in DIRECT_FCM_FIELDS }
                    if (snapshot.isNotEmpty()) {
                        synchronized(dedupLock) {
                            directFcmCache[callId] = snapshot
                            if (convId.isNotEmpty() && convId != callId) directFcmCache[convId] = snapshot
                        }
                        Log.d(TAG, "handleIntent: cached direct FCM fields backendUrl='${snapshot["backendUrl"]}' callerId='${snapshot["callerId"]}'")
                    }
                    if (checkAndMarkHandled(callId)) {
                        Log.d(TAG, "handleIntent: dedup — $callId suppressed"); return
                    }
                    try { handleCallMessage(data) } catch (e: Exception) {
                        Log.e(TAG, "handleIntent direct call failed: ${e.message}", e)
                    }
                    return
                }
            }

            // Path B: direct missed call — cancel the ringing notification, post once natively (Fix 1 + 4)
            // Backend may omit callId in the missed-call FCM; fall back to conversationId for dedup.
            if (type == "missed-call") {
                val callId = data["callId"] ?: ""
                val convId = data["conversationId"] ?: ""
                val dedupeId = callId.ifEmpty { convId }
                if (dedupeId.isNotEmpty()) {
                    Log.d(TAG, "handleIntent (direct missed-call): callId=$callId convId=$convId")
                    if (checkAndMarkHandled("missed:$dedupeId")) {
                        // Still cancel Firebase's auto-displayed notification even on dedup —
                        // the relay and direct FCMs each have their own auto-display that must be removed.
                        cancelFcmAutoNotification((data["google.message_id"] ?: data["gcm.message_id"] ?: "").trim())
                        Log.d(TAG, "handleIntent: dedup — missed:$dedupeId suppressed"); return
                    }
                    if (callId.isNotEmpty()) cancelIncomingCallNotification(callId)
                    try { handleMissedCallMessage(data) } catch (e: Exception) {
                        Log.e(TAG, "handleIntent direct missed-call failed: ${e.message}", e)
                    }
                    return
                }
            }

            // Path B2: call-cancelled — caller hung up; cancel ring + post missed-call immediately.
            if (type == "call-cancelled") {
                val callId = data["callId"] ?: ""
                val convId = data["conversationId"] ?: ""
                Log.d(TAG, "handleIntent (call-cancelled): callId=$callId convId=$convId")
                if (callId.isNotEmpty() || convId.isNotEmpty()) {
                    try { handleCallCancelledMessage(data) } catch (e: Exception) {
                        Log.e(TAG, "handleIntent call-cancelled failed: ${e.message}", e)
                    }
                    return
                }
            }

            // Path B3: call-declined — callee declined; Device A (caller) should end its call screen.
            // Kotlin logs it and brings the caller's app to the foreground so the Convex reactive
            // query can update immediately. The JS background task also calls declineCall via
            // ConvexHttpClient (see backgroundTaskSetup.ts) — belt-and-suspenders for background/killed.
            if (type == "call-declined") {
                isCallRelatedFcm = true
                val callId = data["callId"] ?: ""
                val convId = data["conversationId"] ?: ""
                Log.d(TAG, "handleIntent (call-declined): callId=$callId convId=$convId — waking caller app")
                // Cancel any stale ring notification (edge case: callee declined before ring showed on Device A).
                if (callId.isNotEmpty()) cancelIncomingCallNotification(callId)
                if (convId.isNotEmpty() && convId != callId) cancelIncomingCallNotification(convId)
                // Bring the caller's app to the foreground so its Convex reactive query updates.
                // Using SINGLE_TOP so we don't create a new activity if one is already running.
                // sml-017: this is an AUTO-WAKE (no user tap involved) — landing on the specific
                // chat screen was reported as unexpected navigation when reopening the app after
                // a call. Always target Home instead; the Convex client reconnects and the call
                // state updates regardless of which screen is in the foreground.
                val targetUrl = "smilers://home"
                try {
                    startActivity(Intent(this, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        setData(Uri.parse(targetUrl))
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    })
                    Log.d(TAG, "handleIntent (call-declined): startActivity fired → $targetUrl")
                } catch (e: Exception) {
                    Log.w(TAG, "handleIntent (call-declined): startActivity failed: ${e.message}")
                }
                // Do NOT return — fall through to super.handleIntent so Expo's background
                // task fires and calls declineCall via ConvexHttpClient.
            }

            // Path C: relay FCM — type is inside the 'body' JSON string
            val body = data["body"]
            if (!body.isNullOrEmpty()) {
                try {
                    val bodyObj = org.json.JSONObject(body)
                    val bodyType = bodyObj.optString("type")

                    if (bodyType == "call") {
                        val callId = bodyObj.optString("callId")
                        if (callId.isNotEmpty()) {
                            val relayConvId = bodyObj.optString("conversationId").ifEmpty { data["conversationId"] ?: "" }
                            Log.d(TAG, "handleIntent (relay call): callId=$callId convId=$relayConvId")
                            if (relayConvId.isNotEmpty()) {
                                synchronized(dedupLock) { relayCallIdByConvId[relayConvId] = callId }
                            }
                            if (checkAndMarkHandled(callId)) {
                                Log.d(TAG, "handleIntent: dedup — $callId suppressed"); return
                            }
                            val merged = buildRelayCallData(data, bodyObj)
                            try { handleCallMessage(merged) } catch (e: Exception) {
                                Log.e(TAG, "handleIntent relay call failed: ${e.message}", e)
                            }
                            return
                        }
                    }

                    if (bodyType == "missed-call") {
                        val callId = bodyObj.optString("callId")
                        val convId = bodyObj.optString("conversationId").ifEmpty { data["conversationId"] ?: "" }
                        val dedupeId = callId.ifEmpty { convId }
                        if (dedupeId.isNotEmpty()) {
                            Log.d(TAG, "handleIntent (relay missed-call): callId=$callId convId=$convId")
                            if (checkAndMarkHandled("missed:$dedupeId")) {
                                cancelFcmAutoNotification((data["google.message_id"] ?: data["gcm.message_id"] ?: "").trim())
                                Log.d(TAG, "handleIntent: dedup — missed:$dedupeId suppressed"); return
                            }
                            if (callId.isNotEmpty()) cancelIncomingCallNotification(callId)
                            val merged = mutableMapOf<String, String>()
                            val iter = bodyObj.keys()
                            while (iter.hasNext()) { val k = iter.next(); merged[k] = bodyObj.optString(k) }
                            data["title"]?.let { merged["title"] = it }
                            data["message"]?.let { merged["message"] = it }
                            data["conversationId"]?.let { merged["conversationId"] = it }
                            // Forward FCM message ID so handleMissedCallMessage can cancel
                            // the Firebase auto-displayed notification (FCM-Notification:xxx).
                            data["google.message_id"]?.let { merged["google.message_id"] = it }
                            data["gcm.message_id"]?.let { merged["gcm.message_id"] = it }
                            try { handleMissedCallMessage(merged) } catch (e: Exception) {
                                Log.e(TAG, "handleIntent relay missed-call failed: ${e.message}", e)
                            }
                            return
                        }
                    }

                    if (bodyType == "call-cancelled") {
                        val callId = bodyObj.optString("callId")
                        val convId = bodyObj.optString("conversationId").ifEmpty { data["conversationId"] ?: "" }
                        Log.d(TAG, "handleIntent (relay call-cancelled): callId=$callId convId=$convId")
                        if (callId.isNotEmpty() || convId.isNotEmpty()) {
                            val merged = mutableMapOf<String, String>()
                            val iter2 = bodyObj.keys()
                            while (iter2.hasNext()) { val k = iter2.next(); merged[k] = bodyObj.optString(k) }
                            data["conversationId"]?.let { merged["conversationId"] = it }
                            data["title"]?.let { merged["title"] = it }
                            try { handleCallCancelledMessage(merged) } catch (e: Exception) {
                                Log.e(TAG, "handleIntent relay call-cancelled failed: ${e.message}", e)
                            }
                            return
                        }
                    }
                    if (bodyType == "call-declined") {
                        isCallRelatedFcm = true
                        val callId = bodyObj.optString("callId")
                        val convId = bodyObj.optString("conversationId").ifEmpty { data["conversationId"] ?: "" }
                        Log.d(TAG, "handleIntent (relay call-declined): callId=$callId convId=$convId — waking caller app")
                        if (callId.isNotEmpty() || convId.isNotEmpty()) {
                            // sml-017: auto-wake, same reasoning as the direct call-declined path above.
                            val targetUrl = "smilers://home"
                            try {
                                startActivity(Intent(this, MainActivity::class.java).apply {
                                    action = Intent.ACTION_VIEW
                                    setData(Uri.parse(targetUrl))
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                                })
                            } catch (e: Exception) {
                                Log.w(TAG, "handleIntent (relay call-declined): startActivity failed: ${e.message}")
                            }
                            // Do NOT return — let super.handleIntent fire Expo background task.
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "handleIntent body parse failed: ${e.message}")
                }
            }
            // No SmilersCall type field matched. Check if this is a backend missed-call FCM that
            // arrives as type=message. The backend sends it with a notification payload whose title
            // contains "missed" — we detect it here so we can cancel the ring and post the missed-call
            // notification immediately, instead of letting it auto-display via Expo at 35s.
            val notifTitle = data["gcm.notification.title"] ?: ""
            val notifBody  = data["gcm.notification.body"]  ?: ""
            val convId     = data["conversationId"] ?: ""
            val fcmMsgId   = (data["google.message_id"] ?: data["gcm.message_id"] ?: "").trim()
            val isMissedCallFcm = notifTitle.contains("missed", ignoreCase = true) ||
                notifBody.contains("missed", ignoreCase = true) ||
                notifBody.contains("voice call", ignoreCase = true)

            if (isMissedCallFcm) {
                val dedupeId = convId.ifEmpty { fcmMsgId }
                Log.d(TAG, "handleIntent FALLTHROUGH: detected missed-call FCM " +
                    "title='$notifTitle' convId=$convId dedupeId=$dedupeId")
                if (dedupeId.isNotEmpty()) {
                    if (checkAndMarkHandled("missed:$dedupeId")) {
                        cancelFcmAutoNotification(fcmMsgId)
                        Log.d(TAG, "handleIntent FALLTHROUGH: missed-call dedup — missed:$dedupeId suppressed")
                    } else {
                        val missedData = mutableMapOf<String, String>()
                        data.forEach { (k, v) -> missedData[k] = v }
                        // Promote notification payload fields so handleMissedCallMessage picks them up.
                        if (notifTitle.isNotBlank()) missedData["title"]   = notifTitle
                        if (notifBody.isNotBlank())  missedData["message"] = notifBody
                        try { handleMissedCallMessage(missedData) } catch (e: Exception) {
                            Log.e(TAG, "handleIntent FALLTHROUGH: handleMissedCallMessage failed: ${e.message}", e)
                        }
                    }
                    return  // Handled natively — do NOT call super.handleIntent
                }
            }

            // Not a Smilers-owned FCM — dump key fields for debugging, then let Expo handle it.
            Log.w(TAG, "handleIntent FALLTHROUGH: type=${data["type"]} " +
                "callId=${data["callId"]} convId=$convId " +
                "hasBody=${!data["body"].isNullOrEmpty()} " +
                "notifTitle=$notifTitle " +
                "notifBody=${notifBody.take(80)} " +
                "bodySnippet=${data["body"]?.take(120)}")
        }
        // super.handleIntent posts any FCM notification payload to the channel specified by
        // android_channel_id (calls-v4-smilers_never_cry). For call-declined FCMs we cancel
        // it immediately after so the user only sees our own properly-formatted notification.
        //
        // DUPLICATE-NOTIFICATION FIX (native): some MESSAGE pushes arrive with an FCM
        // notification block (gcm.notification.title/body). super.handleIntent auto-displays
        // that block (titled with the app label "Smilers" / server sender name) WHILE the
        // Expo background task ALSO renders the app's own notifee notification built from the
        // data payload with the recipient's saved DEVICE-CONTACT name. Same body, two titles →
        // Android stops merging → the duplicate the user reported. We now cancel the OS
        // auto-display for message pushes that carry a notification block too, exactly like the
        // call path, so ONLY the app-rendered (contact-name) notification survives. The Expo
        // background task still fires (via super.handleIntent) and renders it, so the user is
        // never left without a notification.
        val hasMsgNotifBlock = !isCallRelatedFcm && (
            !intent.extras?.getString("gcm.notification.title").isNullOrEmpty() ||
            !intent.extras?.getString("gcm.notification.body").isNullOrEmpty()
        )
        val fcmAutoTag: String? = if (isCallRelatedFcm || hasMsgNotifBlock) {
            val msgId = (intent.extras?.getString("google.message_id")
                ?: intent.extras?.getString("gcm.message_id") ?: "").trim()
            if (msgId.isNotEmpty()) "FCM-Notification:$msgId" else null
        } else null
        if (hasMsgNotifBlock) {
            Log.d(TAG, "handleIntent: message push carries a notification block " +
                "(title='${intent.extras?.getString("gcm.notification.title")}') — " +
                "cancelling OS auto-display to avoid duplicate; app renders its own")
        }
        super.handleIntent(intent)
        cancelLegacyAutoDisplay()
        if (fcmAutoTag != null) {
            handler.postDelayed({
                NotificationManagerCompat.from(this).cancel(fcmAutoTag, 0)
                Log.d(TAG, "cancelAutoNotif (delayed): cancelled tag=$fcmAutoTag")
            }, 400L)
        }
    }

    // ─── Layer 1: delegate override — catches messages routed via ExpoFirebaseMessagingService ───
    override val firebaseMessagingDelegate: FirebaseMessagingDelegateInterface by lazy {
        object : expo.modules.notifications.service.delegates.FirebaseMessagingDelegate(this@SmilersCallNotificationService) {
            override fun onMessageReceived(remoteMessage: RemoteMessage) {
                Log.d(TAG, "Delegate.onMessageReceived: data=${remoteMessage.data}")
                val handled = tryHandleCallMessage(remoteMessage)
                if (!handled) {
                    Log.d(TAG, "Delegate: not a call, forwarding to Expo")
                    super.onMessageReceived(remoteMessage)
                }
            }
        }
    }

    // ─── Layer 2: direct onMessageReceived override ───
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        Log.e(TAG, "=== onMessageReceived ENTRY === data=${remoteMessage.data}")
        val handled = tryHandleCallMessage(remoteMessage)
        if (!handled) {
            Log.d(TAG, "onMessageReceived: not a call, delegating to Expo")
            super.onMessageReceived(remoteMessage)
        }
    }

    // ─── Shared helpers ───

    private fun bundleSafeToDataMap(extras: Bundle): Map<String, String> {
        val map = mutableMapOf<String, String>()
        try {
            extras.keySet()?.forEach { key ->
                if (extras.get(key) is String) {
                    (extras.getString(key))?.let { map[key] = it }
                }
            }
        } catch (e: Exception) { Log.w(TAG, "bundleSafeToDataMap error: ${e.message}") }
        return map
    }

    private fun tryHandleCallMessage(remoteMessage: RemoteMessage): Boolean {
        val data = remoteMessage.data

        if (data["type"] == "call") {
            val callId = data["callId"] ?: ""
            val convId = data["conversationId"] ?: ""
            Log.d(TAG, "CALL (direct): callId=$callId")
            Log.d(TAG, "CALL (direct) FULL FCM DATA: $data")
            if (callId.isEmpty()) return false
            // Cache BEFORE dedup — relay FCM lacks backendUrl/callerId (see buildRelayCallData)
            val snapshot = data.filter { it.key in DIRECT_FCM_FIELDS }
            if (snapshot.isNotEmpty()) {
                synchronized(dedupLock) {
                    directFcmCache[callId] = snapshot
                    if (convId.isNotEmpty() && convId != callId) directFcmCache[convId] = snapshot
                }
            }
            if (checkAndMarkHandled(callId)) { Log.d(TAG, "dedup: $callId already handled"); return true }
            return try { handleCallMessage(data); true } catch (e: Exception) {
                Log.e(TAG, "handleCallMessage failed (direct): ${e.message}", e); false
            }
        }

        // Intercept missed-call FCMs so Expo's super.onMessageReceived never fires for
        // them — without this, a second system notification appeared alongside the native
        // Kotlin one (different namespace/ID so Android showed both).
        if (data["type"] == "missed-call") {
            val callId = data["callId"] ?: ""
            val convId = data["conversationId"] ?: ""
            val dedupeId = callId.ifEmpty { convId }
            Log.d(TAG, "MISSED-CALL (direct via onMessageReceived): callId=$callId convId=$convId")
            if (dedupeId.isEmpty()) return false
            if (checkAndMarkHandled("missed:$dedupeId")) {
                // Cancel Firebase auto-display even on dedup (each FCM has its own auto-notification).
                remoteMessage.messageId?.let { cancelFcmAutoNotification(it) } ?: cancelFcmAutoNotification("")
                Log.d(TAG, "dedup: missed:$dedupeId already handled"); return true
            }
            if (callId.isNotEmpty()) cancelIncomingCallNotification(callId)
            // Attach FCM message ID so handleMissedCallMessage can cancel the Firebase
            // auto-displayed notification (tag: "FCM-Notification:<messageId>").
            val enriched = data.toMutableMap()
            remoteMessage.messageId?.let { enriched["google.message_id"] = it }
            return try { handleMissedCallMessage(enriched); true } catch (e: Exception) {
                Log.e(TAG, "handleMissedCallMessage failed (direct): ${e.message}", e); false
            }
        }

        if (data["type"] == "call-cancelled") {
            val callId = data["callId"] ?: ""
            val convId = data["conversationId"] ?: ""
            Log.d(TAG, "CALL-CANCELLED (direct): callId=$callId convId=$convId")
            if (callId.isEmpty() && convId.isEmpty()) return false
            return try { handleCallCancelledMessage(data); true } catch (e: Exception) {
                Log.e(TAG, "handleCallCancelledMessage failed (direct): ${e.message}", e); false
            }
        }

        if (data["type"] == "call-declined") {
            val callId = data["callId"] ?: ""
            val convId = data["conversationId"] ?: ""
            Log.d(TAG, "CALL-DECLINED (direct via onMessageReceived): callId=$callId convId=$convId — " +
                "returning false so Expo background task calls declineCall")
            // Return false → super.onMessageReceived fires → Expo processes FCM →
            // background task calls declineCall via ConvexHttpClient (backgroundTaskSetup.ts).
            return false
        }

        val bodyJson = data["body"]
        if (!bodyJson.isNullOrEmpty()) {
            try {
                val bodyObj = org.json.JSONObject(bodyJson)
                val bodyType = bodyObj.optString("type")
                Log.d(TAG, "Relay body: type=$bodyType")
                if (bodyType == "call") {
                    val callId = bodyObj.optString("callId")
                    Log.d(TAG, "CALL (relay): callId=$callId")
                    if (callId.isEmpty()) return false
                    val relayConvId = bodyObj.optString("conversationId").ifEmpty { data["conversationId"] ?: "" }
                    if (relayConvId.isNotEmpty()) {
                        synchronized(dedupLock) { relayCallIdByConvId[relayConvId] = callId }
                    }
                    if (checkAndMarkHandled(callId)) { Log.d(TAG, "dedup: $callId already handled"); return true }
                    val merged = buildRelayCallData(data, bodyObj)
                    return try { handleCallMessage(merged); true } catch (e: Exception) {
                        Log.e(TAG, "handleCallMessage failed (relay): ${e.message}", e); false
                    }
                }
                if (bodyType == "missed-call") {
                    val callId = bodyObj.optString("callId")
                    val convId = bodyObj.optString("conversationId").ifEmpty { data["conversationId"] ?: "" }
                    val dedupeId = callId.ifEmpty { convId }
                    Log.d(TAG, "MISSED-CALL (relay via onMessageReceived): callId=$callId convId=$convId")
                    if (dedupeId.isEmpty()) return false
                    if (checkAndMarkHandled("missed:$dedupeId")) {
                        remoteMessage.messageId?.let { cancelFcmAutoNotification(it) } ?: cancelFcmAutoNotification("")
                        Log.d(TAG, "dedup: missed:$dedupeId already handled"); return true
                    }
                    if (callId.isNotEmpty()) cancelIncomingCallNotification(callId)
                    val merged = mutableMapOf<String, String>()
                    val iter = bodyObj.keys(); while (iter.hasNext()) { val k = iter.next(); merged[k] = bodyObj.optString(k) }
                    data["title"]?.let { merged["title"] = it }
                    data["message"]?.let { merged["message"] = it }
                    data["conversationId"]?.let { merged["conversationId"] = it }
                    remoteMessage.messageId?.let { merged["google.message_id"] = it }
                    return try { handleMissedCallMessage(merged); true } catch (e: Exception) {
                        Log.e(TAG, "handleMissedCallMessage failed (relay): ${e.message}", e); false
                    }
                }
                if (bodyType == "call-cancelled") {
                    val callId = bodyObj.optString("callId")
                    val convId = bodyObj.optString("conversationId").ifEmpty { data["conversationId"] ?: "" }
                    Log.d(TAG, "CALL-CANCELLED (relay): callId=$callId convId=$convId")
                    if (callId.isEmpty() && convId.isEmpty()) return false
                    val merged = mutableMapOf<String, String>()
                    val iter2 = bodyObj.keys(); while (iter2.hasNext()) { val k = iter2.next(); merged[k] = bodyObj.optString(k) }
                    data["conversationId"]?.let { merged["conversationId"] = it }
                    data["title"]?.let { merged["title"] = it }
                    return try { handleCallCancelledMessage(merged); true } catch (e: Exception) {
                        Log.e(TAG, "handleCallCancelledMessage failed (relay): ${e.message}", e); false
                    }
                }
                if (bodyType == "call-declined") {
                    val callId = bodyObj.optString("callId")
                    val convId = bodyObj.optString("conversationId").ifEmpty { data["conversationId"] ?: "" }
                    Log.d(TAG, "CALL-DECLINED (relay via onMessageReceived): callId=$callId convId=$convId — " +
                        "returning false so Expo background task calls declineCall")
                    return false
                }
            } catch (e: Exception) { Log.e(TAG, "body JSON parse failed: ${e.message}") }
        }
        return false
    }

    private fun buildRelayCallData(top: Map<String, String>, body: org.json.JSONObject): Map<String, String> {
        Log.d(TAG, "buildRelayCallData: TOP FULL=$top")
        Log.d(TAG, "buildRelayCallData: BODY=$body")
        val merged = mutableMapOf<String, String>()
        val iter = body.keys(); while (iter.hasNext()) { val k = iter.next(); merged[k] = body.optString(k) }
        listOf("callerName", "callerDisplayName", "displayName", "senderName",
               "twilio_room_name", "twilio_caller_identity", "twilio_is_video", "callType",
               "backendUrl", "callerId", "callerIdentity")
            .forEach { key -> top[key]?.let { merged[key] = it } }
        if (merged["callerName"].isNullOrBlank()) {
            val msg = top["message"] ?: ""
            val derived = msg.substringBefore(" is calling", "").trim()
            if (derived.isNotEmpty()) merged["callerName"] = derived
        }
        if (merged["twilio_is_video"].isNullOrBlank()) {
            val title = top["title"] ?: ""
            if (title.contains("video", ignoreCase = true)) merged["twilio_is_video"] = "1"
        }
        // Enrich from the direct FCM cache — the relay body never carries backendUrl/callerId.
        // The direct FCM is cached (even when suppressed by dedup) before buildRelayCallData runs.
        // Look up by relay callId first, then conversationId (== direct FCM's callId on server).
        val relayCallId = merged["callId"] ?: ""
        val relayConvId = merged["conversationId"] ?: ""
        val cached = synchronized(dedupLock) {
            directFcmCache[relayCallId] ?: directFcmCache[relayConvId]
        }
        if (cached != null) {
            cached.forEach { (k, v) -> if (merged[k].isNullOrEmpty()) merged[k] = v }
            Log.d(TAG, "buildRelayCallData: enriched from direct-FCM cache: backendUrl='${merged["backendUrl"]}' callerId='${merged["callerId"]}'")
        } else {
            Log.w(TAG, "buildRelayCallData: no direct-FCM cache entry for callId=$relayCallId convId=$relayConvId")
        }
        Log.d(TAG, "buildRelayCallData: MERGED=$merged")
        return merged
    }

    // Handles type=call-cancelled FCM: the caller hung up during ringing.
    // Cancels the ring-timeout runnable, dismisses the ring notification by channel,
    // then posts a missed-call notification immediately — no 35s wait needed.
    private fun handleCallCancelledMessage(data: Map<String, String>) {
        val callId = data["callId"] ?: ""
        val convId = data["conversationId"] ?: ""
        Log.d(TAG, "handleCallCancelledMessage: callId=$callId convId=$convId")

        // 1. Cancel the ring-timeout runnable so it doesn't also post a missed-call later.
        if (callId.isNotEmpty()) cancelMissedCallTimeout(callId)
        if (convId.isNotEmpty()) cancelMissedCallTimeout(convId)

        // Mark this convId/callId as cancelled so any relay ring FCM that arrives late
        // is rejected inside handleCallMessage instead of posting a new ring notification.
        // The entry self-clears after 60 s (well past the 36 s ring-timeout window).
        synchronized(dedupLock) {
            if (convId.isNotEmpty()) cancelledConvIds.add(convId)
            if (callId.isNotEmpty() && callId != convId) cancelledConvIds.add(callId)
        }
        handler.postDelayed({
            synchronized(dedupLock) { cancelledConvIds.remove(convId); cancelledConvIds.remove(callId) }
        }, 60_000L)

        // 2. Dismiss the ring notification. Try by computed ID first, then scan by channel
        //    (the cancel FCM's callId may be the conversationId while the ring notification
        //    was keyed differently — channel scan is always reliable).
        if (callId.isNotEmpty()) cancelIncomingCallNotification(callId)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.activeNotifications.forEach { sbn ->
                    if (sbn.packageName != packageName) return@forEach
                    val chanId = try { sbn.notification.channelId } catch (e: Exception) { null }
                    if (chanId == CALL_CHANNEL_ID) {
                        NotificationManagerCompat.from(this).cancel(sbn.tag, sbn.id)
                        Log.d(TAG, "handleCallCancelledMessage: cleared ring notif id=${sbn.id}")
                    }
                }
            } catch (e: Exception) { Log.w(TAG, "handleCallCancelledMessage ring scan: ${e.message}") }
        }

        // 3. Post missed-call notification. checkAndMarkHandled prevents the ring-timeout
        //    or a duplicate FCM from posting a second notification.
        val dedupeId = callId.ifEmpty { convId }
        if (checkAndMarkHandled("missed:$dedupeId")) {
            Log.d(TAG, "handleCallCancelledMessage: missed:$dedupeId already handled — skip")
            return
        }
        val storedName = synchronized(dedupLock) {
            callIdToCallerName[callId] ?: callIdToCallerName[convId]
        }
        val callerName = storedName
            ?: data["callerName"]
            ?: data["displayName"]
            ?: data["title"]
            ?: "Smilers user"
        Log.d(TAG, "handleCallCancelledMessage: posting missed-call callerName=$callerName")
        postMissedCallFromJs(applicationContext, callId, convId, callerName)
    }

    // Cancels the in-progress ringing notification so it doesn't linger after the call ends (Fix 4).
    private fun cancelIncomingCallNotification(callId: String) {
        val notifId = NOTIFICATION_ID_BASE + (callId.hashCode() and 0x0FFF)
        NotificationManagerCompat.from(this).cancel(notifId)
        Log.d(TAG, "Cancelled incoming-call notification id=$notifId for callId=$callId")
    }

    // #2 fix: resolve the display name the CALLEE saved for a phone number in
    // their own device address book (ContactsContract.PhoneLookup). Requires
    // READ_CONTACTS (already granted for the app). Returns null when the number
    // is blank, permission is missing, or no contact matches — callers then
    // fall back to the pushed account name.
    private fun lookupContactNameByPhone(phone: String?): String? {
        val number = phone?.trim().orEmpty()
        if (number.isEmpty()) return null
        try {
            if (androidx.core.content.ContextCompat.checkSelfPermission(
                    applicationContext, android.Manifest.permission.READ_CONTACTS,
                ) != android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                return null
            }
            val uri = android.net.Uri.withAppendedPath(
                android.provider.ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                android.net.Uri.encode(number),
            )
            applicationContext.contentResolver.query(
                uri,
                arrayOf(android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME),
                null, null, null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val name = cursor.getString(0)?.trim()
                    if (!name.isNullOrEmpty()) return name
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "lookupContactNameByPhone failed: ${e.message}")
        }
        return null
    }

    private fun handleCallMessage(data: Map<String, String>) {
        val callId = data["callId"] ?: return
        val pushedName = listOf(
            data["callerName"], data["callerDisplayName"],
            data["displayName"], data["senderName"],
        ).firstOrNull { !it.isNullOrBlank() } ?: "Smilers user"

        // #2 fix: prefer the name THIS device (the callee) has saved for the caller
        // in its own address book. The call push is data-only and carries the
        // caller's E.164 number in data.callerPhone, so we look it up directly in
        // ContactsContract — always fresh, no server round-trip. Falls back to the
        // pushed account name when the caller isn't saved / has no number.
        val deviceName = lookupContactNameByPhone(data["callerPhone"])
        val callerName = deviceName ?: pushedName

        val isVideo = data["twilio_is_video"] == "1" || data["callType"] == "video"
        val room = data["twilio_room_name"] ?: ""
        val callerIdentity = data["twilio_caller_identity"] ?: ""
        val conversationId = data["conversationId"] ?: ""

        Log.d(TAG, "handleCallMessage: callId=$callId callerName=$callerName isVideo=$isVideo")
        Log.d(TAG, "handleCallMessage: backendUrl='${data["backendUrl"]}' callerId='${data["callerId"]}' callerIdentity='${data["callerIdentity"]}'")

        // Suppress ring if a call-cancelled FCM for this conversation arrived before this ring FCM.
        // This is the relay-race fix: FCM delivery order is not guaranteed, so call-cancelled can
        // arrive first. Without this guard, the late relay ring would show for the full 35 seconds.
        synchronized(dedupLock) {
            if (cancelledConvIds.contains(callId) || cancelledConvIds.contains(conversationId)) {
                Log.d(TAG, "handleCallMessage: callId=$callId convId=$conversationId already cancelled — suppressing late ring")
                return
            }
            // sml-015: the foreground JS listener already took over this call (its own
            // in-app incoming-call UI is showing) — don't ALSO post the system notification,
            // regardless of whether this FCM arrived before or after that decision.
            if (foregroundHandledIds.contains(callId) || foregroundHandledIds.contains(conversationId)) {
                Log.d(TAG, "handleCallMessage: callId=$callId convId=$conversationId already handled by foreground UI — suppressing ring notification")
                return
            }
        }

        // A new ring for this conversation means the caller is attempting again. Clear any stale
        // missed-call dedup entry older than 60 s so the new attempt can post its own missed-call.
        // The 60 s floor still covers the 36 s ring-timeout window (prevents the relay timeout
        // from the CURRENT call from double-posting), but allows a repeat call after ~1 minute.
        if (conversationId.isNotEmpty()) {
            synchronized(dedupLock) {
                val key = "missed:$conversationId"
                val t = recentlyHandled[key]
                if (t != null && System.currentTimeMillis() - t > 60_000L) {
                    recentlyHandled.remove(key)
                    Log.d(TAG, "handleCallMessage: cleared stale missed-call dedup for convId=$conversationId")
                }
            }
        }

        // Store callerName keyed by callId and conversationId so the call-cancelled FCM
        // handler can show the correct name even if callerName is absent from that FCM.
        synchronized(dedupLock) {
            if (callId.isNotEmpty()) callIdToCallerName[callId] = callerName
            if (conversationId.isNotEmpty()) callIdToCallerName[conversationId] = callerName
        }

        val notifEnabled = NotificationManagerCompat.from(this).areNotificationsEnabled()
        Log.d(TAG, "areNotificationsEnabled=$notifEnabled")
        if (!notifEnabled) { Log.w(TAG, "Notifications disabled — suppressed"); return }

        ensureCallChannel()

        // Cancel any stale missed-call notification from a previous call so the new
        // incoming ring doesn't appear alongside an old missed-call in the shade (Issue 2).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.activeNotifications.forEach { sbn ->
                    if (sbn.packageName != packageName) return@forEach
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        val chanId = try { sbn.notification.channelId } catch (e: Exception) { null }
                        if (chanId == MISSED_CALL_CHANNEL_ID) {
                            NotificationManagerCompat.from(this).cancel(sbn.tag, sbn.id)
                            Log.d(TAG, "handleCallMessage: cleared stale missed-call notif id=${sbn.id}")
                        }
                    }
                }
            } catch (e: Exception) { Log.w(TAG, "handleCallMessage stale-missed scan: ${e.message}") }
        }

        // Use conversationId as the stable notification key so both the direct FCM
        // (callId == conversationId) and the relay FCM (callId == unique Convex call ID)
        // write to the same Android notification slot. Android's notify(sameId) updates the
        // notification in-place; setOnlyAlertOnce(true) prevents sound/full-screen from firing
        // twice. Without this, each FCM creates a separate notification and Android logs
        // "Muting recently noisy" for the second one — suppressing the full-screen call UI
        // and causing the call to appear as a silent banner for roughly half of all calls.
        val effectiveNotifKey = conversationId.ifEmpty { callId }
        val notifId = NOTIFICATION_ID_BASE + (effectiveNotifKey.hashCode() and 0x0FFF)

        val answerUrl = buildString {
            append("smilers://incoming-call")
            append("?room=${Uri.encode(room)}")
            append("&callerId=${Uri.encode(callerIdentity)}")
            append("&callerName=${Uri.encode(callerName)}")
            append("&isVideo=${if (isVideo) "1" else "0"}")
            append("&conversationId=${Uri.encode(conversationId)}")
            append("&callId=${Uri.encode(callId)}")
            append("&autoAnswer=1")
        }

        // sml-016: dedicated target for the notification's explicit "Answer" ACTION
        // BUTTON only (content intent / full-screen intent above are untouched and
        // still go to /incoming-call, which is correct — those should still let the
        // user choose Answer/Decline). Client-reported bug: tapping the Answer
        // button from background/killed landed on /incoming-call, which — for this
        // legacy/WebRTC build — can never auto-join (no Twilio room exists), so the
        // user saw the ringing Accept/Decline screen again instead of connecting.
        // /call/<conversationId>?answer=1 already auto-answers on mount (built for
        // the call-waiting "End & Accept" flow, frontend/app/call/[conversationId].tsx)
        // so pointing the Answer button there directly connects the call, matching
        // exactly what tapping Answer is supposed to do. Falls back to answerUrl if
        // conversationId is ever missing (can't build a valid /call/<id> route).
        val answerActionUrl = if (conversationId.isNotEmpty()) {
            buildString {
                append("smilers://call/${Uri.encode(conversationId)}")
                append("?type=${if (isVideo) "video" else "voice"}")
                append("&answer=1")
                if (callerName.isNotBlank()) append("&displayName=${Uri.encode(callerName)}")
            }
        } else answerUrl

        val answerIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            this.data = Uri.parse(answerUrl)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        // Content intent and full-screen intent use direct activity PendingIntents (reliable on all API levels).
        val answerPi = PendingIntent.getActivity(this, notifId, answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val declineUrl = buildString {
            append("smilers://incoming-call")
            append("?callId=${Uri.encode(callId)}")
            append("&action=decline")
            append("&room=${Uri.encode(room)}")
            append("&conversationId=${Uri.encode(conversationId)}")
        }

        // sml-011: Answer/Decline action buttons launch CallActionTrampolineActivity
        // directly via PendingIntent.getActivity() instead of PendingIntent.getBroadcast()
        // to CallActionReceiver. A broadcast-triggered context.startActivity() call is
        // subject to Android's background-activity-launch restrictions and was being
        // blocked outright on Samsung/Motorola once the process was fully killed — the
        // notification dismissed but the app never opened. PendingIntent.getActivity() is
        // unconditionally exempt from that restriction because the system launches it
        // directly in response to the notification tap. The trampoline activity runs the
        // exact same handleAnswer/handleDecline logic (see CallActionReceiver.kt) and then
        // hands off to MainActivity itself — an activity-to-activity launch, also exempt.
        val answerActionPi = PendingIntent.getActivity(this, notifId + 3,
            Intent(this, CallActionTrampolineActivity::class.java).apply {
                action = "com.smilers.app.ACTION_ANSWER_CALL"
                putExtra("callId", callId)
                putExtra("targetUrl", answerActionUrl)
                putExtra("notifId", notifId)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val backendUrl = data["backendUrl"] ?: ""
        val callerUserId = data["callerId"] ?: data["callerIdentity"] ?: ""
        val declinePi = PendingIntent.getActivity(this, notifId + 4,
            Intent(this, CallActionTrampolineActivity::class.java).apply {
                action = "com.smilers.app.ACTION_DECLINE_CALL"
                putExtra("callId", callId)
                putExtra("conversationId", conversationId)
                putExtra("callerUserId", callerUserId)
                putExtra("backendUrl", backendUrl)
                putExtra("notifId", notifId)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val fullScreenPi = PendingIntent.getActivity(this, notifId + 2, answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val title = if (isVideo) "Incoming video call" else "Incoming call"
        val notification = NotificationCompat.Builder(this, CALL_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText("$callerName is calling…")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreenPi, true)
            .setContentIntent(answerPi)
            .setAutoCancel(true)
            .setOngoing(false)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(RING_TIMEOUT_MS)
            .addAction(android.R.drawable.ic_menu_call, "Answer", answerActionPi)
            .addAction(android.R.drawable.ic_delete, "Decline", declinePi)
            .build()

        Log.d(TAG, "Posting notification id=$notifId title=$title")
        NotificationManagerCompat.from(this).notify(notifId, notification)
        Log.d(TAG, "Notification posted successfully")

        // Cancel any earlier ring-timeout posted for this conversation (direct FCM schedules one,
        // relay FCM calls handleCallMessage again for the same convId 12ms later and would
        // schedule a second). Without this, both fire and produce duplicate missed-call posts.
        if (conversationId.isNotEmpty()) cancelMissedCallTimeout(conversationId)

        // Schedule a missed-call notification to fire 1s after the ring auto-cancels (35s + 1s).
        // This ensures the user sees "Missed call" immediately after the ring ends — without
        // waiting for the backend FCM, which can arrive 7-9 minutes late.
        val appCtx = applicationContext
        val timeoutDedupeKey = "missed:${callId.ifEmpty { conversationId }}"
        val timeoutRunnable = Runnable {
            synchronized(dedupLock) {
                pendingTimeouts.remove(callId)
                if (conversationId.isNotEmpty()) pendingTimeouts.remove(conversationId)
            }
            // If backend FCM or CallActionReceiver already handled this call, skip.
            if (checkAndMarkHandled(timeoutDedupeKey)) {
                Log.d(TAG, "ring-timeout: $timeoutDedupeKey already handled — skipping"); return@Runnable
            }
            // If the app is foreground the user answered in-app (full-screen intent path) — skip.
            try {
                val am = appCtx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
                val fg = am.runningAppProcesses?.any {
                    it.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND &&
                    it.pkgList?.contains(appCtx.packageName) == true
                } ?: false
                if (fg) { Log.d(TAG, "ring-timeout: app foreground — skipping missed-call"); return@Runnable }
            } catch (e: Exception) { Log.w(TAG, "ring-timeout fg-check: ${e.message}") }
            Log.d(TAG, "ring-timeout: posting immediate missed-call for callId=$callId")
            // Cancel any lingering Firebase auto-display on the legacy calls channel.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    val nm = appCtx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.activeNotifications.forEach { sbn ->
                        if (sbn.packageName != appCtx.packageName) return@forEach
                        val t = sbn.tag
                        if (t != null && t.startsWith("FCM-Notification:")) NotificationManagerCompat.from(appCtx).cancel(t, sbn.id)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            val chanId = try { sbn.notification.channelId } catch (e: Exception) { null }
                            if (chanId == "calls-v4-smilers_never_cry") NotificationManagerCompat.from(appCtx).cancel(sbn.tag, sbn.id)
                        }
                    }
                } catch (e: Exception) { Log.w(TAG, "ring-timeout fcm-scan: ${e.message}") }
            }
            // Ensure missed-call channel exists.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val mgr = appCtx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (mgr.getNotificationChannel(MISSED_CALL_CHANNEL_ID) == null) {
                    mgr.createNotificationChannel(NotificationChannel(MISSED_CALL_CHANNEL_ID, "Missed Calls",
                        NotificationManager.IMPORTANCE_DEFAULT).apply { enableVibration(false) })
                }
            }
            val missedId = MISSED_NOTIFICATION_ID_BASE + (callId.ifEmpty { conversationId }.hashCode() and 0x0FFF)
            val tapUrl = if (conversationId.isNotEmpty()) "smilers://chat/$conversationId" else "smilers://home"
            val tapIntent = Intent(appCtx, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW; this.data = Uri.parse(tapUrl)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val tapPi = PendingIntent.getActivity(appCtx, missedId, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            NotificationManagerCompat.from(appCtx).notify(missedId,
                NotificationCompat.Builder(appCtx, MISSED_CALL_CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("Missed call")
                    .setContentText("$callerName called")
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setContentIntent(tapPi).setAutoCancel(true).build())
            Log.d(TAG, "ring-timeout: missed-call posted id=$missedId")
        }
        synchronized(dedupLock) {
            pendingTimeouts[callId] = timeoutRunnable
            // Also index by conversationId so FALLTHROUGH missed-call detection (which may only
            // have convId from the backend FCM) can cancel this timeout without knowing callId.
            if (conversationId.isNotEmpty()) pendingTimeouts[conversationId] = timeoutRunnable
        }
        handler.postDelayed(timeoutRunnable, RING_TIMEOUT_MS + 1000L)
        Log.d(TAG, "handleCallMessage: ring-timeout scheduled at +${RING_TIMEOUT_MS + 1000L}ms")
    }

    // Posts a single native missed-call notification (Fix 1). Caller must already have cancelled the
    // incoming-call notification via cancelIncomingCallNotification() before calling this (Fix 4).
    // callId may be absent for FCMs from /notify-event; conversationId is used as a fallback key.
    private fun handleMissedCallMessage(data: Map<String, String>) {
        val callId = data["callId"] ?: ""
        val convId = data["conversationId"] ?: ""
        val notifKey = callId.ifEmpty { convId }
        if (notifKey.isEmpty()) return
        val callerName = lookupContactNameByPhone(data["callerPhone"])
            ?: listOf(data["callerName"], data["callerDisplayName"],
            data["displayName"], data["senderName"]).firstOrNull { !it.isNullOrBlank() } ?: "Smilers user"
        // Use the FCM notification payload body/title when available — it contains the
        // full backend-formatted text ("You missed a voice call from X"). Firebase puts
        // notification payload fields in FCM data extras under the gcm.notification.* prefix.
        val title = listOf(data["title"], data["gcm.notification.title"])
            .firstOrNull { !it.isNullOrBlank() } ?: "Missed call"
        val message = listOf(data["message"], data["gcm.notification.body"])
            .firstOrNull { !it.isNullOrBlank() } ?: "$callerName called"
        val conversationId = convId

        Log.d(TAG, "handleMissedCallMessage: notifKey=$notifKey callerName=$callerName")

        // Backend FCM arrived — cancel the ring-timeout so it doesn't also post a missed-call.
        // Try callId first, then convId (FALLTHROUGH path may only populate convId).
        val pendingTimeout = synchronized(dedupLock) {
            pendingTimeouts.remove(callId) ?: pendingTimeouts.remove(convId)
        }
        pendingTimeout?.let { handler.removeCallbacks(it); Log.d(TAG, "handleMissedCallMessage: cancelled ring-timeout") }

        val notifEnabled = NotificationManagerCompat.from(this).areNotificationsEnabled()
        if (!notifEnabled) { Log.w(TAG, "Notifications disabled — suppressed"); return }

        ensureMissedCallChannel()

        // Cancel the Firebase auto-displayed notification that fires when an FCM has both a
        // notification payload AND data payload and the app is backgrounded. Without this,
        // Android shows "FCM-Notification:<msgId>" in addition to our native notification.
        val fcmMsgId = (data["google.message_id"] ?: data["gcm.message_id"] ?: "").trim()
        Log.d(TAG, "handleMissedCallMessage: fcmMsgId=$fcmMsgId")
        cancelFcmAutoNotification(fcmMsgId)

        // Also cancel any still-showing incoming-call ring, identified by channel.
        // Needed when callId is absent (backend /notify-event omits it), so we
        // couldn't call cancelIncomingCallNotification(callId) up in the call stack.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.activeNotifications.forEach { sbn ->
                    if (sbn.notification.channelId == CALL_CHANNEL_ID && sbn.packageName == packageName) {
                        NotificationManagerCompat.from(this).cancel(sbn.tag, sbn.id)
                        Log.d(TAG, "handleMissedCallMessage: cleared incoming-call notif id=${sbn.id}")
                    }
                }
            } catch (e: Exception) { Log.w(TAG, "handleMissedCallMessage incoming-call scan: ${e.message}") }
        }

        val missedNotifId = MISSED_NOTIFICATION_ID_BASE + (notifKey.hashCode() and 0x0FFF)

        val tapUrl = if (conversationId.isNotEmpty()) "smilers://chat/$conversationId" else "smilers://home"
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            this.data = Uri.parse(tapUrl)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val tapPi = PendingIntent.getActivity(this, missedNotifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val notification = NotificationCompat.Builder(this, MISSED_CALL_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(tapPi)
            .setAutoCancel(true)
            .build()

        Log.d(TAG, "Posting missed-call notification id=$missedNotifId")
        NotificationManagerCompat.from(this).notify(missedNotifId, notification)
        Log.d(TAG, "Missed-call notification posted")
    }

    // Cancels the Firebase-auto-displayed notification (tag "FCM-Notification:<msgId>", id=0).
    // Firebase shows this automatically when the FCM payload contains a notification object
    // and the app is backgrounded — we cancel it so only our native notification remains.
    //
    // We ALWAYS scan active notifications in addition to the direct-tag cancel because the
    // google.message_id in the FCM data payload uses a different format than what Firebase
    // puts in the auto-display tag (e.g. data has "0:124056271%abc" but tag uses "124056271"),
    // so the direct cancel often misses it. The scan catches any FCM-Notification:* tag
    // from our package regardless of format.
    private fun cancelFcmAutoNotification(fcmMsgId: String) {
        if (fcmMsgId.isNotBlank()) {
            val tag = "FCM-Notification:$fcmMsgId"
            NotificationManagerCompat.from(this).cancel(tag, 0)
            Log.d(TAG, "cancelFcmAutoNotification: direct cancel tag=$tag")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.activeNotifications.forEach { sbn ->
                    if (sbn.packageName != packageName) return@forEach
                    // Cancel by FCM-Notification tag (most reliable path)
                    val t = sbn.tag
                    if (t != null && t.startsWith("FCM-Notification:")) {
                        NotificationManagerCompat.from(this).cancel(t, sbn.id)
                        Log.d(TAG, "cancelFcmAutoNotification (tag-scan): cancelled tag=$t id=${sbn.id}")
                    }
                    // Also cancel by legacy channel — the backend specifies
                    // "calls-v4-smilers_never_cry" as android_channel_id in FCM notification
                    // payloads. Any notification still on this channel is a Firebase auto-display
                    // that our native notification will replace.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        val chanId = try { sbn.notification.channelId } catch (e: Exception) { null }
                        if (chanId == "calls-v4-smilers_never_cry") {
                            NotificationManagerCompat.from(this).cancel(sbn.tag, sbn.id)
                            Log.d(TAG, "cancelFcmAutoNotification (ch-scan): cancelled channel=$chanId tag=${sbn.tag} id=${sbn.id}")
                        }
                    }
                }
            } catch (e: Exception) { Log.w(TAG, "cancelFcmAutoNotification scan: ${e.message}") }
        }
    }

    private fun ensureCallChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // Suppress the legacy channel that the backend specifies in FCM notification payloads.
        // Firebase auto-displays any FCM with a notification payload on the named channel before
        // our service can run — setting IMPORTANCE_NONE makes Android silently drop those
        // auto-displays so the user never sees the yellow-icon duplicate notification.
        suppressLegacyCallsChannel(mgr)

        val existing = mgr.getNotificationChannel(CALL_CHANNEL_ID)
        if (existing != null) {
            Log.d(TAG, "Channel $CALL_CHANNEL_ID exists — importance=${existing.importance}")
            return
        }
        try {
            val soundUri = Uri.parse("android.resource://$packageName/raw/smilers_never_cry")
            val audioAttrs = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build()
            val channel = NotificationChannel(CALL_CHANNEL_ID, "Incoming Calls",
                NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Incoming Smilers call notifications"
                setSound(soundUri, audioAttrs)
                enableVibration(true)
                vibrationPattern = longArrayOf(700, 600, 700, 600, 700, 600, 700, 600)
                setBypassDnd(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            mgr.createNotificationChannel(channel)
            Log.d(TAG, "Channel $CALL_CHANNEL_ID created")
        } catch (e: Exception) { Log.e(TAG, "createNotificationChannel FAILED: ${e.message}", e) }
    }

    // Cancels any notification auto-displayed by Firebase on the legacy call channel.
    // Called immediately after super.handleIntent() so duplicate call notifications are removed.
    // IMPORTANT: only cancels by channel ID, never by FCM-Notification:* tag — scanning by
    // tag would cancel message notifications shown by the OS, preventing users from seeing them.
    private fun cancelLegacyAutoDisplay() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.activeNotifications.forEach { sbn ->
                if (sbn.packageName != packageName) return@forEach
                val chanId = try { sbn.notification.channelId } catch (e: Exception) { null }
                if (chanId == "calls-v4-smilers_never_cry") {
                    NotificationManagerCompat.from(this).cancel(sbn.tag, sbn.id)
                    Log.d(TAG, "cancelLegacyAutoDisplay: cancelled legacy-channel tag=${sbn.tag} id=${sbn.id}")
                }
            }
        } catch (e: Exception) { Log.w(TAG, "cancelLegacyAutoDisplay: ${e.message}") }
    }

    private fun suppressLegacyCallsChannel(mgr: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val ch = mgr.getNotificationChannel("calls-v4-smilers_never_cry")
            if (ch != null && ch.importance != NotificationManager.IMPORTANCE_NONE) {
                // Delete then recreate at IMPORTANCE_NONE. Android resets the importance on
                // channel delete, so the recreated channel stays at NONE even if the old one
                // had been set higher by the user or by Notifee.
                mgr.deleteNotificationChannel("calls-v4-smilers_never_cry")
                Log.d(TAG, "suppressLegacyCallsChannel: deleted old channel (importance=${ch.importance})")
            }
            if (mgr.getNotificationChannel("calls-v4-smilers_never_cry") == null) {
                mgr.createNotificationChannel(
                    NotificationChannel("calls-v4-smilers_never_cry", "Legacy (disabled)",
                        NotificationManager.IMPORTANCE_NONE).apply {
                        description = "Legacy channel — notifications suppressed"
                    }
                )
                Log.d(TAG, "suppressLegacyCallsChannel: recreated as IMPORTANCE_NONE")
            }
        } catch (e: Exception) { Log.w(TAG, "suppressLegacyCallsChannel: ${e.message}") }
    }

    private fun ensureMissedCallChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(MISSED_CALL_CHANNEL_ID) != null) return
        try {
            val channel = NotificationChannel(MISSED_CALL_CHANNEL_ID, "Missed Calls",
                NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Missed Smilers call notifications"
                enableVibration(false)
            }
            mgr.createNotificationChannel(channel)
            Log.d(TAG, "Channel $MISSED_CALL_CHANNEL_ID created")
        } catch (e: Exception) { Log.e(TAG, "createMissedCallChannel FAILED: ${e.message}", e) }
    }
}
