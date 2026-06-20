import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';

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

    // iter-237: route the FOREGROUND answer path to the Twilio call screen
    // (was deep-linking the legacy WebRTC screen `/call/${conversationId}`,
    // which cannot join a Twilio room → the caller spins on "Connecting"
    // forever). This is the most-used path (app already open). Mirror the
    // push-tap handler in usePushNotifications.ts so all three answer paths
    // (push tap, Notifee wake, foreground listener) land on /twilio-call.
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

    router.push(
      (`/twilio-call?room=${encodeURIComponent(room)}` +
        `&identity=${encodeURIComponent(calleeIdentity)}` +
        `&isCaller=0&isVideo=${isVideo ? '1' : '0'}` +
        (displayName ? `&title=${encodeURIComponent(displayName)}` : '')) as any,
    );
  }, [incomingCall, router]);
}
