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

    @ReactMethod
    fun handleCallerCancelled(
        callId: String,
        conversationId: String,
        callerName: String,
        promise: Promise,
    ) {
        try {
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

            // Step 3 — post the missed-call notification via Kotlin companion
            SmilersCallNotificationService.postMissedCallFromJs(reactContext, callId, conversationId, callerName)

            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CANCEL_RING_FAILED", e.message ?: "unknown", e)
        }
    }
}
