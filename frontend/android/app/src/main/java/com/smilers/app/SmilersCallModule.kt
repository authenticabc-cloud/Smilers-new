package com.smilers.app

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule


/**
 * Native module bridge: JS → Kotlin ring cancellation.
 *
 * When the Convex WebSocket detects that the caller cancelled (ringing → gone),
 * JS calls handleCallerCancelled() here instead of waiting for the 35s timeout.
 * This module:
 *   1. Cancels the ring-timeout runnable (prevents duplicate missed-call at 36s)
 *   2. Dismisses the active "incoming-call-native-v1" system notification
 *   3. Posts a "Missed call" notification via SmilersCallNotificationService
 */
@ReactModule(name = SmilersCallModule.NAME)
class SmilersCallModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "SmilersCallModule"
    }

    override fun getName(): String = NAME

    /** Cancels the ring-timeout runnable and dismisses the active ring notification, if any. */
    private fun cancelTimeoutAndDismissRing(callId: String, conversationId: String) {
        // Step 1 — cancel the 36s ring-timeout runnable so it doesn't fire later
        if (callId.isNotEmpty()) SmilersCallNotificationService.cancelMissedCallTimeout(callId)
        if (conversationId.isNotEmpty()) SmilersCallNotificationService.cancelMissedCallTimeout(conversationId)

        // Step 2 — dismiss the active Kotlin ring notification
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            nm?.activeNotifications?.forEach { sbn ->
                if (sbn.packageName != reactContext.packageName) return@forEach
                val isRingNotif = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    try { sbn.notification.channelId == "incoming-call-native-v1" } catch (e: Exception) { false }
                } else {
                    // Pre-O: match by computed ID
                    callId.isNotEmpty() && sbn.id == (0x53004C + (callId.hashCode() and 0x0FFF))
                }
                if (isRingNotif) {
                    NotificationManagerCompat.from(reactContext).cancel(sbn.tag, sbn.id)
                }
            }
        } else if (callId.isNotEmpty()) {
            // Pre-M: cancel directly by computed ID
            NotificationManagerCompat.from(reactContext).cancel(0x53004C + (callId.hashCode() and 0x0FFF))
        }
    }

    @ReactMethod
    fun handleCallerCancelled(
        callId: String,
        conversationId: String,
        callerName: String,
        promise: Promise,
    ) {
        try {
            cancelTimeoutAndDismissRing(callId, conversationId)
            // Step 3 — post the missed-call notification via Kotlin companion
            SmilersCallNotificationService.postMissedCallFromJs(reactContext, callId, conversationId, callerName)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CANCEL_RING_FAILED", e.message ?: "unknown", e)
        }
    }

    /**
     * sml-013: called by useIncomingCallListener.ts the moment its OWN foreground
     * Convex-live-query path decides to show the in-app incoming-call UI for a call
     * that the native FCM handler has ALSO already posted a heads-up ring notification
     * for (the two delivery paths — push and live-query — are independent and don't
     * know about each other). Without this, the user sees both the system notification
     * banner (with its own Answer/Decline buttons) AND our in-app full-screen incoming
     * call UI at the same time. Unlike handleCallerCancelled, this does NOT post a
     * missed-call notification — the call is still ringing, just now handled entirely
     * by the in-app UI instead of the notification.
     *
     * sml-015: dismissing here only helps if the notification was ALREADY posted by
     * the time this fires. In practice the Convex live-query update (near-instant,
     * already-open WebSocket) almost always beats the FCM push (round-trips through
     * Firebase) that triggers the notification — so this call frequently runs before
     * there's anything to dismiss, and the notification appears moments later anyway.
     * markForegroundHandled() closes that gap by also suppressing the notification
     * at post-time if the FCM arrives after this call.
     */
    @ReactMethod
    fun dismissRingNotification(callId: String, conversationId: String, promise: Promise) {
        try {
            cancelTimeoutAndDismissRing(callId, conversationId)
            SmilersCallNotificationService.markForegroundHandled(callId, conversationId)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("DISMISS_RING_FAILED", e.message ?: "unknown", e)
        }
    }

    /**
     * sml-010: called by app/silent-decline.tsx once the in-app declineCall mutation
     * confirms — cancels the bounded native fallback (CallActionReceiver's old
     * notify-event/raw-Convex-mutation path) scheduled for the same call, since it's
     * no longer needed. Safe to call even if the fallback already fired or was never
     * scheduled — just returns false in that case.
     */
    @ReactMethod
    fun cancelDeclineFallback(callId: String, conversationId: String, promise: Promise) {
        try {
            var cancelled = false
            if (callId.isNotEmpty() && SmilersCallNotificationService.cancelDeclineFallback(callId)) {
                cancelled = true
            }
            if (conversationId.isNotEmpty() && SmilersCallNotificationService.cancelDeclineFallback(conversationId)) {
                cancelled = true
            }
            promise.resolve(cancelled)
        } catch (e: Exception) {
            promise.reject("CANCEL_DECLINE_FALLBACK_FAILED", e.message ?: "unknown", e)
        }
    }
}
