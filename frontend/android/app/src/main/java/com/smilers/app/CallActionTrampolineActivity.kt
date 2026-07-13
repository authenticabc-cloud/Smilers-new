package com.smilers.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log

/**
 * sml-011: invisible trampoline launched DIRECTLY by the Answer/Decline
 * notification action buttons via PendingIntent.getActivity(), replacing the
 * previous PendingIntent.getBroadcast() → CallActionReceiver → startActivity()
 * chain.
 *
 * Root cause this fixes: on Android 10+, a BroadcastReceiver calling
 * context.startActivity() to launch an app from a fully killed process is
 * subject to background-activity-launch (BAL) restrictions. AOSP grants a
 * short exemption window for a notification-triggered broadcast, but
 * Samsung/Motorola's stricter OEM policies were denying it outright once the
 * process was truly dead — the notification dismissed but the app never
 * opened. A PendingIntent.getActivity() fired by the system in direct
 * response to a notification tap is unconditionally exempt from BAL, so
 * launching THIS activity always succeeds; once it is genuinely running as a
 * (invisible) foreground activity, its own startActivity() call to hand off
 * to MainActivity is itself an activity-to-activity launch, which is never
 * subject to BAL either.
 *
 * Uses Theme.CallActionTrampoline (android:Theme.NoDisplay) — it must call
 * finish() before onResume() runs, which it does synchronously in onCreate.
 */
class CallActionTrampolineActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            when (intent?.action) {
                "com.smilers.app.ACTION_ANSWER_CALL" -> CallActionReceiver.handleAnswer(this, intent)
                "com.smilers.app.ACTION_DECLINE_CALL" -> CallActionReceiver.handleDecline(this, intent)
                else -> Log.w("SmilersCall", "CallActionTrampolineActivity: unrecognized action=${intent?.action}")
            }
        } catch (e: Exception) {
            Log.w("SmilersCall", "CallActionTrampolineActivity: unexpected error: ${e.message}")
        }
        finish()
    }
}
