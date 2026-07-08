import { useEffect, useRef } from 'react';
import { AppState, NativeModules } from 'react-native';
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
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const incomingCall = useQuery(
    api.calls.getIncomingCall,
    isAuthenticated ? {} : 'skip'
  );
  const handledCallId = useRef<string | null>(null);
  const prevCallRef = useRef<{
    _id: string;
    callerName: string;
    conversationId: string;
    isVideo: boolean;
  } | null>(null);
  const userAnsweredRef = useRef(false);

  // Detect caller-cancel: tracks ringing→gone transition and triggers an
  // immediate missed-call notification (instead of waiting 35s for the timeout).
  // Only fires when app is backgrounded — foreground is handled by the call screen.
  useEffect(() => {
    const prev = prevCallRef.current;
    if (incomingCall && incomingCall.status === 'ringing') {
      prevCallRef.current = {
        _id: String(incomingCall._id),
        callerName: String(
          (incomingCall as any)?.callerName ||
          (incomingCall as any)?.caller?.displayName ||
          (incomingCall as any)?.caller?.name ||
          '',
        ),
        conversationId: String((incomingCall as any)?.conversationId || ''),
        isVideo:
          (incomingCall as any)?.isVideo === true ||
          String((incomingCall as any)?.callType || '').toLowerCase() === 'video',
      };
      userAnsweredRef.current = false;
    } else if (prev) {
      const stillSameCall =
        incomingCall &&
        String(incomingCall._id) === prev._id &&
        incomingCall.status === 'ringing';
      if (!stillSameCall && !userAnsweredRef.current) {
        // Caller cancelled — dismiss the call UI and show missed call.
        prevCallRef.current = null;
        if (AppState.currentState !== 'active') {
          // Background: trigger missed-call via Notifee (Kotlin owns the
          // ring notification and will also cancel it via the backend FCM).
          import('./notifeeCallWake')
            .then(({ cancelRingAndShowMissedCall }) => {
              cancelRingAndShowMissedCall({
                callId: prev._id,
                callerName: prev.callerName,
                conversationId: prev.conversationId,
                isVideo: prev.isVideo,
              }).catch(() => {});
            })
            .catch(() => {});
        } else {
          // Foreground (in-app incoming-call screen visible): navigate home
          // immediately so the user isn't stuck on the ringing screen after
          // the caller hangs up. Also cancel the Kotlin ring notification
          // in the shade + post missed-call via native module bridge.
          try { router.replace('/' as any); } catch {}
          try {
            const mod = NativeModules.SmilersCallModule;
            if (mod?.handleCallerCancelled) {
              mod.handleCallerCancelled(
                prev._id || '',
                prev.conversationId || '',
                prev.callerName || 'Smilers user',
              ).catch(() => {});
            }
          } catch {}
        }
      } else if (!stillSameCall) {
        // User answered — just clear the ref, no missed call.
        prevCallRef.current = null;
      }
    }
  }, [incomingCall]);

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

    // Check global decline flag: if this conversation was recently declined from
    // the notification, don't push the call screen (prevents the race where the
    // decline deeplink navigates home but useIncomingCallListener re-routes).
    try {
      const declinedMap = (globalThis as any).__smilersDeclinedByConv as Map<string, number> | undefined;
      if (declinedMap) {
        const convId = String((incomingCall as any)?.conversationId || conversationId || '');
        const declinedAt = (convId && declinedMap.get(convId)) || 0;
        if (declinedAt && Date.now() - declinedAt < 15000) {
          handledCallId.current = incomingCall._id;
          return;
        }
      }
    } catch {}

    // iter-240: respect the runtime engine flag (EXPO_PUBLIC_USE_TWILIO).
    // When Twilio is DISABLED the app's outgoing calls use the legacy WebRTC
    // stack, which NEVER creates a Twilio room. Previously this foreground
    // listener always synthesized a room name and routed to /twilio-call —
    // so a WebRTC caller's callee landed on the Twilio screen and spun on
    // "Connecting" forever (the exact mismatch support flagged). Route the
    // foreground answer to the legacy /call/<id> screen when Twilio is off.
    if (!isTwilioEnabled()) {
      // Only ring when the app is actually active — same guard as the Twilio
      // path below. Without this, useIncomingCallListener pushed /call/<id>
      // while the app was backgrounded, creating a stale call screen that the
      // notification decline deeplink then had to navigate through.
      if (AppState.currentState !== 'active') return;

      // Group (conference) call → join the dedicated mesh room with the shared
      // callId (the calls doc id). 1:1 calls keep the legacy /call screen.
      const isConferenceCall =
        (incomingCall as any)?.isConference === true ||
        String((incomingCall as any)?.isConference ?? '') === '1' ||
        String((incomingCall as any)?.callType || '').toLowerCase() === 'conference';
      if (isConferenceCall) {
        userAnsweredRef.current = true;
        router.push(`/group-call/${conversationId}?callId=${encodeURIComponent(String(incomingCall._id))}` as any);
        return;
      }
      const callIsVideo =
        incomingCall?.isVideo === true ||
        incomingType === 'video' ||
        String(incomingCall?.callType || '').toLowerCase() === 'video';
      const typeQs = `type=${callIsVideo ? 'video' : 'voice'}`;
      userAnsweredRef.current = true;
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
    userAnsweredRef.current = true;
    router.push(incUrl as any);
  }, [incomingCall, router, me]);
}
