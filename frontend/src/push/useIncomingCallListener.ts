import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { isTwilioEnabled } from '../lib/twilio/twilioApi';

/**
 * Real-time incoming-call listener — when foregrounded, Convex's reactive
 * query pushes us the new call instantly via WebSocket. We then deep-link
 * the user to the active call screen so they can answer/decline in-app
 * (push notifications cover the backgrounded/locked case).
 */
export function useIncomingCallListener() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const incomingCall = useQuery(
    api.calls.getIncomingCall,
    isAuthenticated ? {} : 'skip'
  );
  const handledCallId = useRef<string | null>(null);

  useEffect(() => {
    if (!incomingCall || !incomingCall._id) return;
    if (incomingCall.status !== 'ringing') return;
    if (handledCallId.current === incomingCall._id) return;

    // Suppress auto-route + ringtone when the incoming call is actually a
    // screen-share request. The IncomingScreenShareModal handles those
    // silently with a system overlay (no audible ring). The backend may
    // tag screen-share calls under several possible field names, so we
    // check every one we've seen.
    const incomingType = String(
      incomingCall?.type ||
      incomingCall?.callType ||
      incomingCall?.kind ||
      incomingCall?.mediaType ||
      '',
    ).toLowerCase();
    const isScreenShare =
      incomingType === 'screen' ||
      incomingType === 'screenshare' ||
      incomingType === 'screen-share' ||
      incomingType === 'screen_share' ||
      incomingType === 'sharing' ||
      !!incomingCall?.screenShareSessionId ||
      !!incomingCall?.screenSharing ||
      !!incomingCall?.isScreenShare;
    if (isScreenShare) {
      handledCallId.current = incomingCall._id;
      return;
    }

    handledCallId.current = incomingCall._id;

    const conversationId = incomingCall.conversationId;
    const displayName = String(
      incomingCall?.callerName ||
      incomingCall?.caller?.displayName ||
      incomingCall?.caller?.name ||
      incomingCall?.caller?.fullName ||
      ''
    ).trim();
    if (!conversationId) return;

    // iter-240: respect the runtime engine flag (EXPO_PUBLIC_USE_TWILIO).
    // When Twilio is DISABLED the app's outgoing calls use the legacy WebRTC
    // stack, which NEVER creates a Twilio room. Previously this foreground
    // listener always synthesized a room name and routed to /twilio-call —
    // so a WebRTC caller's callee landed on the Twilio screen and spun on
    // "Connecting" forever (the exact mismatch support flagged). Route the
    // foreground answer to the legacy /call/<id> screen when Twilio is off.
    if (!isTwilioEnabled()) {
      router.push(
        displayName
          ? (`/call/${conversationId}?displayName=${encodeURIComponent(displayName)}` as any)
          : (`/call/${conversationId}` as any),
      );
      return;
    }

    // iter-243: FOREGROUND incoming-call ring. The FCM push pipeline owns
    // backgrounded/locked/killed delivery; this Convex live query owns the
    // FOREGROUND case (app open). Only ring when the app is actually active so
    // we never double-ring with the push-driven Notifee notification.
    if (AppState.currentState !== 'active') return;

    const room =
      String(
        incomingCall?.twilioRoomName ||
        incomingCall?.twilioRoom ||
        incomingCall?.twilio_room_name ||
        incomingCall?.roomName ||
        '',
      ).trim() || `smilers_conv_${conversationId}`;
    const callerIdentity = String(
      incomingCall?.callerId ||
      incomingCall?.callerIdentity ||
      incomingCall?.twilioCallerIdentity ||
      incomingCall?.caller?._id ||
      '',
    ).trim();
    // The callee must join with a unique, non-empty identity (same derivation
    // as the push handler). Fall back to a conversation-scoped id if the
    // caller identity isn't on the record.
    const calleeIdentity = callerIdentity
      ? `${callerIdentity}_callee`
      : `conv_${conversationId}_callee`;
    const isVideo =
      incomingCall?.isVideo === true ||
      incomingType === 'video' ||
      String(incomingCall?.callType || '').toLowerCase() === 'video';

    const callUrl =
      `/twilio-call?room=${encodeURIComponent(room)}` +
      `&identity=${encodeURIComponent(calleeIdentity)}` +
      `&isCaller=0&isVideo=${isVideo ? '1' : '0'}` +
      (displayName ? `&title=${encodeURIComponent(displayName)}` : '');

    // iter-243: on Android present the full-screen Notifee Answer/Decline ring
    // (WhatsApp-style) — using a STABLE conversation-scoped callId so it
    // de-dupes with any push-driven ring for the same call. On iOS (no Notifee
    // full-screen wake) fall back to deep-linking the call screen.
    if (Platform.OS === 'android') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { presentIncomingCallNotifeeWake } = require('./notifeeCallWake');
        void presentIncomingCallNotifeeWake({
          callId: `smilers_conv_${conversationId}`,
          callerId: callerIdentity || `conv_${conversationId}`,
          callerIdentity,
          callerName: displayName || 'Smilers user',
          callType: isVideo ? 'video' : 'voice',
          conversationId: String(conversationId),
          twilioRoom: room,
          isVideo,
        });
        return;
      } catch {
        /* notifee unavailable — fall through to deep-link */
      }
    }
    router.push(callUrl as any);
  }, [incomingCall, router]);
}
