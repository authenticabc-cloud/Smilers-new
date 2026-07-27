package com.smilers.app

import android.content.Intent
import android.os.Bundle
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * MessageReplyHeadlessService
 *
 * Spins up the React Native JS runtime (even from a killed process) to run the
 * "SmilersMessageReply" headless task registered in src/push/messageReplyTask.ts,
 * which sends the inline-reply text through Convex (the backend performs the
 * E2EE encryption on messages.send) and fires the recipient push.
 */
class MessageReplyHeadlessService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val extras: Bundle = intent?.extras ?: return null
        return HeadlessJsTaskConfig(
            "SmilersMessageReply",
            Arguments.fromBundle(extras),
            30000, // 30s timeout
            true   // allowed to run while app is in the foreground
        )
    }
}
