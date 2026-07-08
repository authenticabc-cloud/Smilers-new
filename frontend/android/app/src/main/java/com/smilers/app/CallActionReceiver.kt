package com.smilers.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            "com.smilers.app.ACTION_ANSWER_CALL" -> {
                val callId = intent.getStringExtra("callId") ?: ""
                val targetUrl = intent.getStringExtra("targetUrl") ?: ""
                val notifId = intent.getIntExtra("notifId", 0)
                Log.d("SmilersCall", "CallActionReceiver: ANSWER callId=$callId")
                // Cancel the ring-timeout so no spurious "Missed call" appears after answer.
                SmilersCallNotificationService.cancelMissedCallTimeout(callId)
                // Dismiss the ring notification from the shade.
                NotificationManagerCompat.from(context).cancel(notifId)
                // Navigate to the in-app call screen.
                if (targetUrl.isNotEmpty()) {
                    context.startActivity(Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse(targetUrl)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    })
                }
            }
            "com.smilers.app.ACTION_DECLINE_CALL" -> {
                val callId = intent.getStringExtra("callId") ?: ""
                val conversationId = intent.getStringExtra("conversationId") ?: callId
                val notifId = intent.getIntExtra("notifId", 0)
                val convId = conversationId.ifEmpty { callId }

                // Read extras baked into the PendingIntent at notification-post time.
                // These come from the LAST handleCallMessage() call — whichever of the two
                // FCMs (relay or direct) ran second. If the relay FCM ran second it will
                // have overwritten the direct FCM's backendUrl/callerUserId with empty strings.
                var callerUserId = intent.getStringExtra("callerUserId") ?: ""
                var backendUrl   = intent.getStringExtra("backendUrl") ?: ""

                Log.d("SmilersCall", "CallActionReceiver: DECLINE tap — callId=$callId convId=$convId extras: backendUrl='$backendUrl' callerUserId='$callerUserId'")

                // Cancel ring-timeout and notification synchronously (no network needed).
                SmilersCallNotificationService.cancelMissedCallTimeout(callId)
                if (conversationId.isNotEmpty() && conversationId != callId) {
                    SmilersCallNotificationService.cancelMissedCallTimeout(conversationId)
                }
                NotificationManagerCompat.from(context).cancel(notifId)

                // Resolve the best callId we have right now. The relay FCM carries the real
                // Convex _id as callId; if the relay FCM ran second it may have replaced callId
                // with conversationId. getRelayCallId() returns the saved relay callId.
                val resolvedCallId = if (callId == conversationId || callId.isEmpty()) {
                    SmilersCallNotificationService.getRelayCallId(callId, conversationId) ?: callId
                } else callId

                val pendingResult = goAsync()
                Thread {
                    try {
                        // ── PHASE 1: Wait up to 2 s for the direct FCM cache ──────────────────
                        // Root-cause of the 50 % failure: the relay FCM posts the notification
                        // before the direct FCM (which carries backendUrl + callerUserId) is
                        // processed. The user can tap Decline in that 0–2 s window. By polling
                        // the cache for 2 s we convert most race-condition failures into successes
                        // without any perceivable delay (notification is already gone).
                        var attempts = 0
                        while ((backendUrl.isEmpty() || callerUserId.isEmpty()) && attempts < 4) {
                            Thread.sleep(500)
                            attempts++
                            val cached = SmilersCallNotificationService.getDirectFcmCache(callId, convId)
                            if (backendUrl.isEmpty())   backendUrl   = cached["backendUrl"] ?: ""
                            if (callerUserId.isEmpty()) callerUserId = cached["callerId"] ?: cached["callerIdentity"] ?: ""
                        }
                        Log.d("SmilersCall", "CallActionReceiver: after cache-wait (${attempts * 500} ms) — backendUrl='$backendUrl' callerUserId='$callerUserId'")

                        // ── PHASE 2: Primary path — notify-event via Python backend ───────────
                        // This is the path that definitely works: the Python backend sends FCM
                        // directly to the caller. Caller's foreground app receives it, logs appear,
                        // call screen closes. Use this whenever the direct FCM data is available.
                        var primarySuccess = false
                        if (callerUserId.isNotEmpty() && backendUrl.isNotEmpty()) {
                            try {
                                val url = URL("${backendUrl.trimEnd('/')}/api/notify-event")
                                val conn = url.openConnection() as HttpURLConnection
                                conn.requestMethod = "POST"
                                conn.setRequestProperty("Content-Type", "application/json")
                                conn.doOutput = true
                                conn.connectTimeout = 6_000
                                conn.readTimeout   = 6_000
                                val body = """{"recipients":["$callerUserId"],"event":"call-declined","title":"Call declined","message":"Call was declined","call_id":"$resolvedCallId","conversation_id":"$convId"}"""
                                OutputStreamWriter(conn.outputStream).use { it.write(body) }
                                val code = conn.responseCode
                                Log.d("SmilersCall", "CallActionReceiver: PRIMARY notify-event → HTTP $code")
                                conn.disconnect()
                                if (code in 200..299) primarySuccess = true
                            } catch (e: Exception) {
                                Log.w("SmilersCall", "CallActionReceiver: PRIMARY notify-event failed: ${e.message}")
                            }
                        }

                        // ── PHASE 3: Fallback — Convex declineCall mutation ────────────────────
                        // Only runs when the primary path had no data or failed.
                        // Caller is in foreground → Convex WebSocket is live → mutation update
                        // reaches the caller's reactive subscription immediately.
                        if (!primarySuccess) {
                            Log.d("SmilersCall", "CallActionReceiver: FALLBACK — Convex declineCall (resolvedCallId=$resolvedCallId)")

                            // Read auth token; retry twice in case of transient Keystore delay.
                            var idToken: String? = null
                            repeat(3) { attempt ->
                                if (idToken == null) {
                                    idToken = readExpoSecureStoreToken(context, "smilers_id_token")
                                    if (idToken == null) {
                                        Log.w("SmilersCall", "CallActionReceiver: token read attempt ${attempt + 1} returned null")
                                        if (attempt < 2) Thread.sleep(400)
                                    }
                                }
                            }

                            if (idToken != null) {
                                // Step A: query Convex for the verified call _id in case resolvedCallId
                                // is still the conversationId (relay cache miss). One attempt with a
                                // generous timeout — if it fails, proceed with resolvedCallId anyway.
                                var callIdToUse = resolvedCallId
                                if (callIdToUse == convId || callIdToUse.isEmpty()) {
                                    try {
                                        val qConn = (URL("https://aware-newt-456.convex.cloud/api/query")
                                            .openConnection() as HttpURLConnection).apply {
                                            requestMethod = "POST"
                                            setRequestProperty("Content-Type", "application/json")
                                            setRequestProperty("Authorization", "Convex $idToken")
                                            doOutput = true
                                            connectTimeout = 3_000
                                            readTimeout    = 3_000
                                        }
                                        OutputStreamWriter(qConn.outputStream).use {
                                            it.write("""{"path":"calls:getActiveCall","args":{"conversationId":"$convId"},"format":"json"}""")
                                        }
                                        val raw = try { qConn.inputStream } catch (_: Exception) { qConn.errorStream }
                                            ?.bufferedReader()?.readText() ?: ""
                                        qConn.disconnect()
                                        val docId = JSONObject(raw)
                                            .takeIf { it.optString("status") == "success" }
                                            ?.optJSONObject("value")?.optString("_id", "") ?: ""
                                        if (docId.isNotEmpty()) {
                                            callIdToUse = docId
                                            Log.d("SmilersCall", "CallActionReceiver: Step A OK → callId=$callIdToUse")
                                        } else {
                                            Log.w("SmilersCall", "CallActionReceiver: Step A — no doc, using resolvedCallId=$resolvedCallId")
                                        }
                                    } catch (e: Exception) {
                                        Log.w("SmilersCall", "CallActionReceiver: Step A query failed: ${e.message} — using resolvedCallId=$resolvedCallId")
                                    }
                                }

                                // Step B: call declineCall mutation. Retry once on failure.
                                var mutationSuccess = false
                                repeat(2) { attempt ->
                                    if (!mutationSuccess) {
                                        try {
                                            val mConn = (URL("https://aware-newt-456.convex.cloud/api/mutation")
                                                .openConnection() as HttpURLConnection).apply {
                                                requestMethod = "POST"
                                                setRequestProperty("Content-Type", "application/json")
                                                setRequestProperty("Authorization", "Convex $idToken")
                                                doOutput = true
                                                connectTimeout = 4_000
                                                readTimeout    = 4_000
                                            }
                                            OutputStreamWriter(mConn.outputStream).use {
                                                it.write("""{"path":"calls:declineCall","args":{"callId":"$callIdToUse"},"format":"json"}""")
                                            }
                                            val code = mConn.responseCode
                                            mConn.disconnect()
                                            Log.d("SmilersCall", "CallActionReceiver: Step B declineCall attempt ${attempt + 1} → HTTP $code callId=$callIdToUse")
                                            if (code in 200..299) mutationSuccess = true
                                            else if (attempt == 0) Thread.sleep(800)
                                        } catch (e: Exception) {
                                            Log.w("SmilersCall", "CallActionReceiver: Step B attempt ${attempt + 1} failed: ${e.message}")
                                            if (attempt == 0) Thread.sleep(800)
                                        }
                                    }
                                }

                                // Step C: belt-and-suspenders — if direct FCM arrived during Steps A+B,
                                // also fire notify-event so the caller gets an FCM in addition to the
                                // Convex subscription update.
                                val late    = SmilersCallNotificationService.getDirectFcmCache(callId, convId)
                                val lateUrl = (late["backendUrl"] ?: "").trimEnd('/')
                                val lateUid = late["callerId"] ?: late["callerIdentity"] ?: ""
                                if (lateUrl.isNotEmpty() && lateUid.isNotEmpty()) {
                                    Log.d("SmilersCall", "CallActionReceiver: Step C — direct FCM arrived, firing belt-and-suspenders notify-event")
                                    try {
                                        val nConn = (URL("$lateUrl/api/notify-event")
                                            .openConnection() as HttpURLConnection).apply {
                                            requestMethod = "POST"
                                            setRequestProperty("Content-Type", "application/json")
                                            doOutput = true
                                            connectTimeout = 5_000
                                            readTimeout    = 5_000
                                        }
                                        OutputStreamWriter(nConn.outputStream).use {
                                            it.write("""{"recipients":["$lateUid"],"event":"call-declined","title":"Call declined","message":"Call was declined","call_id":"$callIdToUse","conversation_id":"$convId"}""")
                                        }
                                        val nCode = nConn.responseCode
                                        nConn.disconnect()
                                        Log.d("SmilersCall", "CallActionReceiver: Step C notify-event → HTTP $nCode")
                                    } catch (e: Exception) {
                                        Log.w("SmilersCall", "CallActionReceiver: Step C notify-event failed: ${e.message}")
                                    }
                                } else {
                                    Log.d("SmilersCall", "CallActionReceiver: Step C — direct FCM still absent; Convex subscription is sole signal to caller (mutationSuccess=$mutationSuccess)")
                                }
                            } else {
                                Log.w("SmilersCall", "CallActionReceiver: auth token unavailable after retries — cannot call Convex")
                            }
                        } // end if (!primarySuccess)
                    } catch (e: Exception) {
                        Log.w("SmilersCall", "CallActionReceiver: decline thread unexpected error: ${e.message}")
                    } finally {
                        pendingResult.finish()
                    }
                }.start()
            }
            else -> {
                // Legacy fallback: cancel by notification ID.
                val notificationId = intent.getIntExtra("notificationId", 0)
                if (notificationId != 0) NotificationManagerCompat.from(context).cancel(notificationId)
            }
        }
    }

    /**
     * Decrypts a value stored by expo-secure-store (v15) from Android SharedPreferences.
     *
     * expo-secure-store stores values as AES-256-GCM encrypted JSON in a plain SharedPreferences
     * file named "SecureStore", with the AES key held in Android Keystore under the alias
     * "AES/GCM/NoPadding:key_v1:keystoreUnauthenticated" (default, no biometric required).
     * The SharedPreferences key is "$keychainService-$userKey" → "key_v1-$userKey".
     *
     * Returns null if the key is absent, the Keystore entry is missing (e.g. after a full
     * app reinstall), or any decryption step fails — the caller falls back gracefully.
     */
    private fun readExpoSecureStoreToken(context: Context, key: String): String? {
        return try {
            val prefs = context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
            // Current format uses keychainService prefix; fall back to bare key for older saves.
            val encryptedJson = prefs.getString("key_v1-$key", null) ?: prefs.getString(key, null)
                ?: return null

            val item = JSONObject(encryptedJson)
            if (item.optString("scheme") != "aes") {
                Log.w("SmilersCall", "readExpoSecureStoreToken: unknown scheme for $key")
                return null
            }

            val keyStore = KeyStore.getInstance("AndroidKeyStore")
            keyStore.load(null)
            // Alias built by AESEncryptor.getExtendedKeyStoreAlias() with default SecureStoreOptions:
            //   keychainService = "key_v1", requireAuthentication = false
            val alias = "AES/GCM/NoPadding:key_v1:keystoreUnauthenticated"
            val secretEntry = keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry
            if (secretEntry == null) {
                Log.w("SmilersCall", "readExpoSecureStoreToken: Keystore alias not found — app may have been reinstalled")
                return null
            }

            val ciphertext = Base64.decode(item.getString("ct"), Base64.DEFAULT)
            val iv = Base64.decode(item.getString("iv"), Base64.DEFAULT)
            val tlen = item.getInt("tlen")

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretEntry.secretKey, GCMParameterSpec(tlen, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w("SmilersCall", "readExpoSecureStoreToken: failed for $key — ${e.message}")
            null
        }
    }
}
