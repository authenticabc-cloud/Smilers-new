import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { isTwilioEnabled } from '../lib/twilio/twilioApi';
import { hasOtherActiveCall } from '../lib/call/activeCallRegistry';

/**
 * Real-time incoming-call listener — when foregrounded, Convex's reactive
 * query pushes us the new call instantly via WebSocket. We then deep-link
 * the user to the active call screen so they can answer/decline in-app
 * (push notifications cover the backgrounded/locked case).
 */
export function useIncomingCallListener() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const incomingCall = useQuery(
    api.calls.getIncomingCall,
    isAuthenticated ? {} : 'skip'
  );
  const handledCallId = useRef<string | null>(null);

  useEffect(() => {
    if (!incomingCall || !incomingCall._id) return;
    if (incomingCall.status !== 'ringing') return;
    if (handledCallId.current === incomingCall._id) return;

    // iter-246 (CRITICAL crash fix): NEVER ring myself for my OWN outgoing
    // call. startCall now creates a Convex "ringing" record so the *callee's*
    // foreground listener fires — but this hook is global, so the CALLER's own
    // query also returns that record. Without this guard the caller tried to
    // present a full-screen incoming-call notification to themselves the moment
    // they tapped "Call", hard-crashing on Android before the call screen even
    // mounted (diagnostics showed no TWILIO-CALL events). Skip when the call's
    // caller is me.
    const myId = me && (me as any)._id ? String((me as any)._id) : '';
    const recordCallerId = String(
      incomingCall?.callerId ||
      incomingCall?.callerIdentity ||
      incomingCall?.caller?._id ||
      '',
    );
    if (myId && recordCallerId && myId === recordCallerId) {
      handledCallId.current = incomingCall._id;
      return;
    }

    // iter-325 CALL WAITING: if the user is ALREADY on an active call, do NOT
    // hijack it by navigating to this new (second) call. The active call screen
    // subscribes to the same incoming-call query and renders an in-call "Call
    // Waiting" overlay so the user can accept/decline WITHOUT losing the
    // ongoing call. We mark it handled so we don't re-trigger, and bail here.
    if (hasOtherActiveCall(incomingCall._id, incomingCall.conversationId)) {
      handledCallId.current = incomingCall._id;
      return;
    }

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
      // Group (conference) call → join the dedicated mesh room with the shared
      // callId (the calls doc id). 1:1 calls keep the legacy /call screen.
      const isConferenceCall =
        (incomingCall as any)?.isConference === true ||
        String((incomingCall as any)?.isConference ?? '') === '1' ||
        String((incomingCall as any)?.callType || '').toLowerCase() === 'conference';
      if (isConferenceCall) {
        const confIsVideo =
          (incomingCall as any)?.isVideo === true ||
          String((incomingCall as any)?.callType || '').toLowerCase() === 'video';
        router.push(
          `/group-call/${conversationId}?callId=${encodeURIComponent(String(incomingCall._id))}&video=${confIsVideo ? '1' : '0'}&adhoc=1` as any,
        );
        return;
      }
      const callIsVideo =
        incomingCall?.isVideo === true ||
        incomingType === 'video' ||
        String(incomingCall?.callType || '').toLowerCase() === 'video';
      const typeQs = `type=${callIsVideo ? 'video' : 'voice'}`;
      router.push(
        displayName
          ? (`/call/${conversationId}?${typeQs}&displayName=${encodeURIComponent(displayName)}` as any)
          : (`/call/${conversationId}?${typeQs}` as any),
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
    const isVideo =
      incomingCall?.isVideo === true ||
      incomingType === 'video' ||
      String(incomingCall?.callType || '').toLowerCase() === 'video';

    // iter-251: route to the in-app INCOMING-CALL screen (Answer/Decline)
    // instead of presenting a notification or dropping straight into the room.
    // The screen resolves the callee's REAL user id (me._id) and only joins
    // the Twilio room on Answer — so the callee always gets to accept/decline
    // and the caller sees the callee's name (not a `twilio-<room>` code).
    const incUrl =
      `/incoming-call?room=${encodeURIComponent(room)}` +
      `&callerId=${encodeURIComponent(callerIdentity)}` +
      `&callerName=${encodeURIComponent(displayName || 'Smilers user')}` +
      `&isVideo=${isVideo ? '1' : '0'}` +
      `&conversationId=${encodeURIComponent(String(conversationId))}` +
      `&convexCallId=${encodeURIComponent(String(incomingCall._id))}`;
    router.push(incUrl as any);
  }, [incomingCall, router, me]);
}
