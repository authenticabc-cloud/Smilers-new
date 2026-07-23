import { useEffect, useRef } from 'react';
import { AppState, NativeModules, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';
import { isTwilioEnabled } from '../lib/twilio/twilioApi';
import { hasOtherActiveCall } from '../lib/call/activeCallRegistry';

// sml-013: the native FCM handler posts a heads-up ring notification for EVERY
// incoming call regardless of app state — it has no way to know this listener's
// own Convex live-query path is about to show the in-app incoming-call UI for
// the exact same call. Called right before navigating so the user sees only
// ONE incoming-call UI (ours) instead of the system notification banner AND
// our full-screen UI stacked on top of each other.
function dismissNativeRingNotification(callId: string, conversationId: string) {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.SmilersCallModule?.dismissRingNotification?.(
      callId || '',
      conversationId || '',
    )?.catch?.(() => {});
  } catch {}
}

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
  // Debounce timer for caller-cancel detection (see below).
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect caller-cancel: tracks ringing→gone transition and triggers an
  // immediate missed-call notification (instead of waiting 35s for the timeout).
  // Only fires when app is backgrounded — foreground is handled by the call screen.
  useEffect(() => {
    const prev = prevCallRef.current;
    if (incomingCall && incomingCall.status === 'ringing') {
      // A ringing call is present — cancel any pending caller-cancel debounce.
      // This is what recovers from a TRANSIENT reactive-query null while the app
      // is backgrounded (Convex WS drop): the ring reappears within a second, so
      // it must NOT be mistaken for a real caller-cancel (that false positive was
      // silently killing every incoming ring + showing a bogus missed call).
      if (cancelTimerRef.current) {
        clearTimeout(cancelTimerRef.current);
        cancelTimerRef.current = null;
      }
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
      if (stillSameCall) return;
      if (userAnsweredRef.current) {
        // User answered — just clear the ref, no missed call.
        prevCallRef.current = null;
        if (cancelTimerRef.current) {
          clearTimeout(cancelTimerRef.current);
          cancelTimerRef.current = null;
        }
        return;
      }
      // The call is no longer ringing. This is EITHER a genuine caller-cancel OR
      // a transient null from the Convex reactive query (WebSocket drop while the
      // app is backgrounded). Debounce: only declare "caller cancelled" if the
      // call stays gone for ~5s. If a ringing call reappears in the meantime the
      // timer is cleared above. RING_TIMEOUT is 35s, so a 5s delay is invisible.
      if (!cancelTimerRef.current) {
        const snapshot = prev;
        cancelTimerRef.current = setTimeout(() => {
          cancelTimerRef.current = null;
          if (userAnsweredRef.current) return;
          const cur = prevCallRef.current;
          // A different ringing call took over → don't fire for the stale one.
          if (cur && cur._id !== snapshot._id) return;
          prevCallRef.current = null;
          if (AppState.currentState !== 'active') {
            // Background: trigger missed-call via Notifee (Kotlin owns the
            // ring notification and will also cancel it via the backend FCM).
            import('./notifeeCallWake')
              .then(({ cancelRingAndShowMissedCall }) => {
                cancelRingAndShowMissedCall({
                  callId: snapshot._id,
                  callerName: snapshot.callerName,
                  conversationId: snapshot.conversationId,
                  isVideo: snapshot.isVideo,
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
                  snapshot._id || '',
                  snapshot.conversationId || '',
                  snapshot.callerName || 'Smilers user',
                ).catch(() => {});
              }
            } catch {}
          }
        }, 5000);
      }
    }
  }, [incomingCall, router]);

  // Clear the debounce timer on unmount.
  useEffect(
    () => () => {
      if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
    },
    [],
  );
  // iter-342: reachability ack. As SOON as this device's reactive query sees
  // the incoming ringing call, tell the backend the call reached us so the
  // CALLER shows a definitive "Ringing…". This fires whenever JS is alive
  // (foreground OR backgrounded-but-not-killed) — so a collapsed heads-up
  // notification no longer makes the caller flip to "Not Ringing", and it also
  // acks in the call-waiting case (user already on another call). Fully-killed
  // apps still need the native FCM handler to ack (Ashwini).
  const markCalleeRinging = useMutation((api as any).calls.markCalleeRinging);
  const ackedCallId = useRef<string | null>(null);

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

    // iter-342: it's a genuine incoming ringing call for me → ack reachability
    // NOW (idempotent backend-side), before any of the navigation/call-waiting
    // guards below, so the caller sees "Ringing…" the instant it reaches us.
    if (ackedCallId.current !== incomingCall._id) {
      ackedCallId.current = incomingCall._id;
      void markCalleeRinging({ callId: String(incomingCall._id) }).catch(() => {
        ackedCallId.current = null; // allow a retry on the next tick
      });
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

    // Check global decline flag: if THIS SPECIFIC call was just declined from
    // the notification tray, don't push the call screen (prevents the race
    // where the decline deeplink navigates home but useIncomingCallListener
    // re-routes for the same still-'ringing' record before the mutation
    // commits). Keyed by callId, NOT conversationId — a fresh call on the
    // same conversation gets its own _id and must ring normally even if it
    // arrives seconds after the previous one was declined.
    try {
      const declinedMap = (globalThis as any).__smilersDeclinedByConv as Map<string, number> | undefined;
      if (declinedMap) {
        const thisCallId = String(incomingCall._id || '');
        const declinedAt = (thisCallId && declinedMap.get(`callId:${thisCallId}`)) || 0;
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
        const confIsVideo =
          (incomingCall as any)?.isVideo === true ||
          String((incomingCall as any)?.callType || '').toLowerCase() === 'video';
        dismissNativeRingNotification(String(incomingCall._id), conversationId);
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
      userAnsweredRef.current = true;
      dismissNativeRingNotification(String(incomingCall._id), conversationId);
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
    dismissNativeRingNotification(String(incomingCall._id), conversationId);
    router.push(incUrl as any);
  }, [incomingCall, router, me, markCalleeRinging]);
}
