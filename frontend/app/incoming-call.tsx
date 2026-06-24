/**
 * /app/incoming-call.tsx — in-app incoming-call screen (WhatsApp-style).
 *
 * This screen is the SINGLE accept/decline gate for an inbound Twilio call.
 * Every answer path routes HERE first instead of dropping the user straight
 * into the room:
 *   - Foreground Convex live query (useIncomingCallListener) → here.
 *   - Tapping a call push banner (usePushNotifications) → here.
 *   - The Notifee wake "Answer" action → here with autoAnswer=1 (explicit
 *     accept, so we skip the buttons and join immediately).
 *
 * Why this exists:
 *   1. The receiver MUST be able to ACCEPT or DECLINE before entering the
 *      room (previously the call connected with no consent).
 *   2. The callee must join Twilio with their REAL Convex user id (me._id) so
 *      the caller can resolve their name — otherwise the tile showed a raw
 *      `twilio-<room>` code. We resolve me._id here and pass it on.
 *   3. It plays the user's configured ringtone (not the message tone).
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQuery, useMutation } from 'convex/react';

import { api } from '../src/convexApi';
import CallBackground from '../src/components/CallBackground';
import { useRingtonePlayer } from '../src/lib/ringtone/useRingtonePlayer';
import { endTwilioCall } from '../src/lib/twilio/twilioApi';
import { recordDiagnostic } from '../src/lib/diagnostics';
import { Colors, FontWeight } from '../src/theme';

// Auto-dismiss as "missed" if nobody acts within the ring window (matches
// the Notifee RING_TIMEOUT so the in-app ring and the push ring agree).
const RING_TIMEOUT_MS = 35000;

export default function IncomingCallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    room?: string;
    callerId?: string;
    callerName?: string;
    callerAvatar?: string;
    isVideo?: string;
    conversationId?: string;
    callId?: string;
    convexCallId?: string;
    autoAnswer?: string;
  }>();

  const room = String(params.room || '');
  const callerName = String(params.callerName || 'Smilers user');
  const callerAvatar = String(params.callerAvatar || '');
  const isVideo = String(params.isVideo || '0') === '1';
  const conversationId = String(params.conversationId || '');
  // Only a REAL Convex call _id (foreground live-query path) is used to
  // answer/decline the Convex call record. The push path passes callId =
  // Twilio room SID, which is NOT a Convex id — that path relies on
  // endTwilioCall(room) for decline, so we keep it separate.
  const convexCallId = String(params.convexCallId || '');
  const notifeeCallId = String(params.callId || '');
  const autoAnswer = String(params.autoAnswer || '0') === '1';

  // The callee's OWN identity — what they join Twilio with. Using the real
  // Convex user id is what lets the caller resolve a friendly name.
  const me = useQuery(api.users.getCurrentUser, {}) as any;
  const myId = me?._id ? String(me._id) : '';

  const answerCall = useMutation((api as any).calls.answerCall);
  const declineCall = useMutation((api as any).calls.declineCall);

  const handledRef = useRef(false);

  // Ring + vibrate while the user decides. Skipped for autoAnswer (the user
  // already tapped "Answer" on the notification — no need to ring again).
  useRingtonePlayer(!autoAnswer && !handledRef.current);

  const cancelNotifee = useCallback(() => {
    if (Platform.OS !== 'android') return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { cancelIncomingCallNotifeeWake } = require('../src/push/notifeeCallWake');
      // The foreground listener rings under a conv-scoped id; the push path
      // rings under the Twilio room SID (callId). Cancel both to be safe.
      void cancelIncomingCallNotifeeWake(`smilers_conv_${conversationId}`);
      if (notifeeCallId) void cancelIncomingCallNotifeeWake(notifeeCallId);
    } catch {}
  }, [conversationId, notifeeCallId]);

  useEffect(() => {
    cancelNotifee();
  }, [cancelNotifee]);

  const goToCall = useCallback(() => {
    if (handledRef.current) return;
    if (!room) return;
    // Wait until we know our own user id so we join with a resolvable
    // identity (and so the caller sees our name, not a code).
    if (!myId) return;
    handledRef.current = true;
    cancelNotifee();
    if (convexCallId) {
      try {
        void answerCall({ callId: convexCallId });
      } catch {}
    }
    recordDiagnostic({
      tag: 'TWILIO-CALL',
      source: 'incoming-screen',
      message: `answer room=${room} identity=${myId} video=${isVideo}`,
    });
    const url =
      `/twilio-call?room=${encodeURIComponent(room)}` +
      `&identity=${encodeURIComponent(myId)}` +
      `&isCaller=0&isVideo=${isVideo ? '1' : '0'}` +
      `&title=${encodeURIComponent(callerName)}`;
    router.replace(url as any);
  }, [room, myId, convexCallId, answerCall, isVideo, callerName, router, cancelNotifee]);

  const handleDecline = useCallback(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    cancelNotifee();
    // Completing the Twilio room is what stops the caller ringing even if
    // we never joined; the Convex decline is supplementary.
    if (room) endTwilioCall(room).catch(() => {});
    if (convexCallId) {
      try {
        void declineCall({ callId: convexCallId });
      } catch {}
    }
    recordDiagnostic({
      tag: 'TWILIO-CALL',
      source: 'incoming-screen',
      message: `decline room=${room}`,
    });
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [room, convexCallId, declineCall, router, cancelNotifee]);

  // Explicit accept from the notification → join the moment we know our id.
  useEffect(() => {
    if (autoAnswer && myId && !handledRef.current) goToCall();
  }, [autoAnswer, myId, goToCall]);

  // Missed-call safety net: auto-dismiss after the ring window.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!handledRef.current) handleDecline();
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [handleDecline]);

  // autoAnswer: render a minimal "Connecting…" state (no buttons / ring).
  if (autoAnswer) {
    return (
      <View style={[styles.container, styles.center]}>
        <CallBackground variant="incoming" />
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.connectingText}>Connecting…</Text>
      </View>
    );
  }

  const initial = callerName.trim().charAt(0).toUpperCase() || '?';

  return (
    <View style={[styles.container, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40 }]}>
      <CallBackground variant="incoming" />
      <View style={styles.topArea}>
        <Text style={styles.incomingLabel}>
          {isVideo ? 'Incoming video call' : 'Incoming call'}
        </Text>
        {callerAvatar ? (
          <Image source={{ uri: callerAvatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
        )}
        <Text style={styles.callerName} numberOfLines={2}>
          {callerName}
        </Text>
        <Text style={styles.subText}>Smilers {isVideo ? 'video' : 'voice'} call…</Text>
      </View>

      <View style={styles.actions}>
        <View style={styles.actionCol}>
          <Pressable style={[styles.actionBtn, styles.declineBtn]} onPress={handleDecline} hitSlop={10}>
            <Feather name="phone-off" size={28} color="#fff" />
          </Pressable>
          <Text style={styles.actionLabel}>Decline</Text>
        </View>
        <View style={styles.actionCol}>
          <Pressable
            style={[styles.actionBtn, styles.answerBtn, !myId && styles.actionBtnDisabled]}
            onPress={goToCall}
            disabled={!myId}
            hitSlop={10}
          >
            <Feather name={isVideo ? 'video' : 'phone'} size={28} color="#fff" />
          </Pressable>
          <Text style={styles.actionLabel}>{myId ? 'Answer' : 'Loading…'}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101010', justifyContent: 'space-between', alignItems: 'center' },
  center: { justifyContent: 'center', gap: 16 },
  connectingText: { color: '#ccc', fontSize: 16 },
  topArea: { alignItems: 'center', gap: 14, paddingHorizontal: 24, marginTop: 24 },
  incomingLabel: { color: '#9a9a9a', fontSize: 15, letterSpacing: 0.5, textTransform: 'uppercase' },
  avatar: { width: 132, height: 132, borderRadius: 66, backgroundColor: '#333', marginTop: 12 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary },
  avatarText: { color: '#fff', fontSize: 54, fontWeight: FontWeight.bold },
  callerName: { color: '#fff', fontSize: 30, fontWeight: FontWeight.bold, textAlign: 'center', marginTop: 8 },
  subText: { color: '#bdbdbd', fontSize: 15 },
  actions: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', width: '100%', paddingHorizontal: 48 },
  actionCol: { alignItems: 'center', gap: 10 },
  actionBtn: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center' },
  actionBtnDisabled: { opacity: 0.5 },
  declineBtn: { backgroundColor: '#e63946' },
  answerBtn: { backgroundColor: '#2ecc71' },
  actionLabel: { color: '#fff', fontSize: 14 },
});
