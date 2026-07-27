package com.smilers.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import com.facebook.react.HeadlessJsTaskService

/**
 * MessageReplyReceiver
 *
 * Handles the inline "Reply" (RemoteInput) action on a native chat-message
 * notification. Extracts the typed text, echoes it into the MessagingStyle
 * thread immediately (optimistic UI), then hands off to the headless JS task
 * (MessageReplyHeadlessService → "SmilersMessageReply") which performs the
 * authenticated Convex send even when the app is killed.
 */
class MessageReplyReceiver : BroadcastReceiver() {
    private val tag = "SmilersCall"

    override fun onReceive(context: Context, intent: Intent) {
        try {
            val convId = intent.getStringExtra("conversationId") ?: ""
            val reply = RemoteInput.getResultsFromIntent(intent)
                ?.getCharSequence(MessageThreadStore.REPLY_KEY)
                ?.toString()
                ?.trim()
                .orEmpty()

            if (convId.isEmpty() || reply.isEmpty()) {
                Log.w(tag, "MessageReplyReceiver: empty conv/reply — ignoring")
                return
            }

            // Optimistic UI: show the sent line in the thread right away, muted.
            MessageThreadStore.recordOutgoing(convId, reply)
            MessageThreadStore.post(context, convId, alertOnce = true)

            // Hand off the actual send to the headless JS task.
            val svc = Intent(context, MessageReplyHeadlessService::class.java).apply {
                putExtra("conversationId", convId)
                putExtra("text", reply)
            }
            HeadlessJsTaskService.acquireWakeLockNow(context)
            context.startService(svc)
            Log.d(tag, "MessageReplyReceiver: queued reply conv=$convId len=${reply.length}")
        } catch (e: Exception) {
            Log.e(tag, "MessageReplyReceiver failed: ${e.message}", e)
        }
    }
}
