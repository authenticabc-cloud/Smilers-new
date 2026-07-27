package com.smilers.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import java.util.concurrent.ConcurrentHashMap

/**
 * MessageThreadStore
 *
 * Shared, process-lifetime store + renderer for native chat-message
 * notifications. Keeps a short per-conversation history so incoming messages
 * and inline "Reply" text stack as a WhatsApp-style MessagingStyle thread.
 *
 * Used by:
 *  - SmilersCallNotificationService.handleMessageNotification (incoming pushes)
 *  - MessageReplyReceiver (echoes the user's typed reply into the same thread)
 *
 * Dedicated FRESH channel ids so Android creates them with the correct Smilers
 * message/group tones (a channel's sound is immutable once created, so we avoid
 * colliding with any JS-created messages-v*/groups-v* channel an older build may
 * have registered with the wrong/default sound).
 */
internal object MessageThreadStore {
    private const val TAG = "SmilersCall"
    const val MSG_CHANNEL_ID = "messages-native-v1-message_notification"
    const val GROUP_MSG_CHANNEL_ID = "groups-native-v1-group_notification"
    private const val MSG_NOTIFICATION_ID_BASE = 0x53204C
    const val REPLY_KEY = "smilers_reply_text"
    private const val MAX_LINES = 8

    data class Line(val person: String, val text: String, val ts: Long, val fromMe: Boolean)
    data class Meta(
        val convId: String,
        val channelId: String,
        val soundRes: String,
        val notifId: Int,
        val isGroup: Boolean,
        val groupTitle: String,
    )

    private val threads = ConcurrentHashMap<String, MutableList<Line>>()
    private val metas = ConcurrentHashMap<String, Meta>()

    fun notifIdFor(convId: String, fallback: String): Int {
        val key = convId.ifEmpty { fallback }
        return MSG_NOTIFICATION_ID_BASE + (key.hashCode() and 0x0FFF)
    }

    fun recordIncoming(convId: String, person: String, text: String, meta: Meta) {
        metas[convId] = meta
        val list = threads.getOrPut(convId) { mutableListOf() }
        synchronized(list) {
            list.add(Line(person, text, System.currentTimeMillis(), false))
            while (list.size > MAX_LINES) list.removeAt(0)
        }
    }

    fun recordOutgoing(convId: String, text: String) {
        val list = threads.getOrPut(convId) { mutableListOf() }
        synchronized(list) {
            list.add(Line("You", text, System.currentTimeMillis(), true))
            while (list.size > MAX_LINES) list.removeAt(0)
        }
    }

    fun getMeta(convId: String): Meta? = metas[convId]

    private fun ensureChannel(ctx: Context, channelId: String, name: String, soundRes: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(channelId) != null) return
        try {
            val soundUri = Uri.parse("android.resource://${ctx.packageName}/raw/$soundRes")
            val attrs = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build()
            val ch = NotificationChannel(channelId, name, NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Smilers message notifications"
                setSound(soundUri, attrs)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 250, 250, 250)
            }
            mgr.createNotificationChannel(ch)
            Log.d(TAG, "MessageThreadStore.ensureChannel: created $channelId sound=$soundRes")
        } catch (e: Exception) { Log.e(TAG, "ensureChannel FAILED: ${e.message}", e) }
    }

    /**
     * (Re)builds and posts the MessagingStyle thread for [convId].
     * @param alertOnce when true, suppresses sound/vibration (used for the
     *   optimistic re-post right after the user sends an inline reply).
     */
    fun post(ctx: Context, convId: String, alertOnce: Boolean) {
        val meta = metas[convId] ?: return
        val list = threads[convId] ?: return
        ensureChannel(ctx, meta.channelId, if (meta.isGroup) "Group messages" else "Messages", meta.soundRes)

        val you = Person.Builder().setName("You").build()
        val style = NotificationCompat.MessagingStyle(you)
        if (meta.isGroup) {
            style.conversationTitle = meta.groupTitle
            style.isGroupConversation = true
        }
        val snapshot = synchronized(list) { list.toList() }
        for (ln in snapshot) {
            val sender = if (ln.fromMe) null else Person.Builder().setName(ln.person).build()
            style.addMessage(ln.text, ln.ts, sender)
        }

        val tapUrl = if (convId.isNotEmpty()) "smilers://chat/$convId" else "smilers://home"
        val tapIntent = Intent(ctx, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(Uri.parse(tapUrl))
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val tapPi = PendingIntent.getActivity(
            ctx, meta.notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Inline reply (RemoteInput). MUTABLE PendingIntent is required so the
        // system can attach the typed text on Android 12+.
        val remoteInput = RemoteInput.Builder(REPLY_KEY).setLabel("Reply").build()
        val replyIntent = Intent(ctx, MessageReplyReceiver::class.java).apply {
            action = "com.smilers.app.ACTION_MESSAGE_REPLY"
            setData(Uri.parse("smilers-reply://$convId"))
            putExtra("conversationId", convId)
            putExtra("notifId", meta.notifId)
        }
        val mutableFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_MUTABLE else 0
        val replyPi = PendingIntent.getBroadcast(
            ctx, meta.notifId, replyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or mutableFlag
        )
        val replyAction = NotificationCompat.Action.Builder(
            android.R.drawable.ic_menu_send, "Reply", replyPi
        )
            .addRemoteInput(remoteInput)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .build()

        val soundUri = Uri.parse("android.resource://${ctx.packageName}/raw/${meta.soundRes}")
        val builder = NotificationCompat.Builder(ctx, meta.channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setStyle(style)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(tapPi)
            .setAutoCancel(true)
            .setOnlyAlertOnce(alertOnce)
            .setSound(soundUri) // pre-O devices; O+ uses the channel sound
            .addAction(replyAction)

        try {
            NotificationManagerCompat.from(ctx).notify(meta.notifId, builder.build())
            Log.d(TAG, "MessageThreadStore.post: id=${meta.notifId} lines=${snapshot.size} group=${meta.isGroup} alertOnce=$alertOnce")
        } catch (e: SecurityException) {
            Log.e(TAG, "post FAILED (no POST_NOTIFICATIONS?): ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "post FAILED: ${e.message}", e)
        }
    }
}
