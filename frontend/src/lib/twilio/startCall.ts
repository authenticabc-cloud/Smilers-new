/**
 * Unified call-initiation helper (Phase A.6 — final cutover).
 *
 * Single entry point used by every "Call" / "Video call" button in
 * the app (chat header, calls list, voice command launcher). Decides
 * which engine handles the call:
 *
 *   - Twilio path  (EXPO_PUBLIC_USE_TWILIO=1): mints a room +
 *     caller JWT via /api/twilio/initiate-call, then navigates to
 *     /twilio-call?room=...&isCaller=1&token=... — Twilio's SFU +
 *     global TURN handles the connection. Callees ring via the
 *     existing FCM push pipeline (set up in A.4).
 *
 *   - Legacy path (EXPO_PUBLIC_USE_TWILIO=0 or anything else):
 *     navigates to /call/<conversationId> — the existing
 *     react-native-webrtc + Convex signaling stack handles
 *     everything. This was the only path before A.6.
 *
 * Both paths show the same user-facing UI; the engine difference is
 * invisible. Twilio failure DOES NOT silently fall back to legacy —
 * the user sees an error and can retry, because a silent fallback
 * would confuse debugging when the legacy stack also has issues.
 */

import { Alert } from 'react-native';
import type { Router } from 'expo-router';

import { initiateTwilioCall, isTwilioEnabled, ringWebrtcCall, groupRing } from './twilioApi';
import { recordDiagnostic } from '../diagnostics';
import { api } from '../../convexApi';
import { getActiveConvexClient } from '../../providers/useConvexAutoReconnect';

export interface StartCallArgs {
  router: Router;
  /** Caller's stable user ID (typically `me._id` from Convex). */
  callerIdentity: string;
  /** Caller's display name shown in the callee's incoming-call notification. */
  callerDisplayName?: string;
  /** Caller's own phone (E.164) so the callee can resolve their saved contact name. */
  callerPhone?: string;
  /** Callee user IDs. 1 for 1-on-1, multiple for group calls. */
  calleeIdentities: string[];
  /** Convex conversation _id — used for room naming + legacy route. */
  conversationId: string;
  isVideo: boolean;
  /** Title shown in the call screen header. */
  displayName: string;
  /** Pass true to enable cloud recording (default: false). */
  record?: boolean;
  /** Screen-share session: auto-start screen broadcast once connected. */
  autoShare?: boolean;
  /** Start with the microphone muted (used for screen-share without narration). */
  startMuted?: boolean;
  /** Group call: ring ALL these members into one shared Stream room. */
  isGroup?: boolean;
  groupMembers?: { identity: string; displayName?: string; phone?: string }[];
  /** Group name shown in the ring + in-call header. */
  conversationName?: string;
}

// #2 FIX: the caller placing two calls ~10ms apart (double-tap / double render
// of the call handler) was cancelling the callee's first ring and then the
// rapid re-dials never reached the callee ("subsequent calls didn't go
// through"). Dedup starts for the same conversation within a short window.
const recentStartByConv: Record<string, number> = {};
const START_DEDUP_MS = 3000;

export async function startCall(args: StartCallArgs): Promise<void> {
  const { router, conversationId, isVideo, displayName } = args;

  const nowTs = Date.now();
  const lastStart = recentStartByConv[conversationId] || 0;
  if (nowTs - lastStart < START_DEDUP_MS) {
    recordDiagnostic({
      tag: 'CALL',
      source: 'startCall',
      message: `deduped duplicate start conv=${conversationId} dtMs=${nowTs - lastStart}`,
    });
    return;
  }
  recentStartByConv[conversationId] = nowTs;

  // ── Group call: ring ALL members into one shared Stream room and open the
  // call screen in group mode (tap-to-join/decline roster). Bypasses the 1:1
  // twilio/legacy engine selection. See /api/calls/group-ring.
  if (args.isGroup) {
    const room = `grp_${conversationId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    recordDiagnostic({
      tag: 'CALL',
      source: 'startCall',
      message: `route=group conv=${conversationId} video=${isVideo} members=${args.groupMembers?.length || 0} room=${room}`,
    });
    if (args.callerIdentity && (args.groupMembers?.length || 0) > 0) {
      void groupRing({
        streamRoom: room,
        conversationId,
        callerIdentity: args.callerIdentity,
        callerDisplayName: args.callerDisplayName,
        callerPhone: args.callerPhone,
        conversationName: args.conversationName,
        members: args.groupMembers || [],
        isVideo,
      });
    }
    // answer=1 → the caller auto-joins the room they created; group=1 flags
    // the call screen into group-orchestration mode.
    router.push(
      `/call/${conversationId}?type=${isVideo ? 'video' : 'voice'}` +
        `&streamRoom=${encodeURIComponent(room)}&group=1&answer=1` +
        `&displayName=${encodeURIComponent(args.conversationName || displayName)}` as any,
    );
    return;
  }

  // Legacy fallback when Twilio is disabled OR when the caller
  // identity isn't ready yet (e.g., auth race condition).
  if (!isTwilioEnabled() || !args.callerIdentity || args.calleeIdentities.length === 0) {
    recordDiagnostic({
      tag: 'CALL',
      source: 'startCall',
      message:
        `route=legacy reason=${
          !isTwilioEnabled()
            ? 'twilio-flag-off'
            : !args.callerIdentity
            ? 'no-identity'
            : 'no-callees'
        } conv=${conversationId} video=${isVideo}`,
    });
    // iter-254: in WebRTC mode the caller no longer hits /twilio/initiate-call,
    // so nothing was sending the FCM wake-push — which broke ringing when the
    // callee app was killed/backgrounded. Fire the call push here (best-effort,
    // deduped by conversationId with any Convex-sent push).
    if (args.callerIdentity && args.calleeIdentities.length > 0) {
      void ringWebrtcCall({
        calleeIdentities: args.calleeIdentities,
        callerIdentity: args.callerIdentity,
        callerDisplayName: args.callerDisplayName,
        callerPhone: args.callerPhone,
        conversationId,
        isVideo,
      });
    }
    router.push(
      `/call/${conversationId}?type=${isVideo ? 'video' : 'voice'}&displayName=${encodeURIComponent(displayName)}` as any,
    );
    return;
  }

  // Twilio path.
  recordDiagnostic({
    tag: 'CALL',
    source: 'startCall',
    message: `route=twilio conv=${conversationId} video=${isVideo} callees=${args.calleeIdentities.length}`,
  });
  try {
    const result = await initiateTwilioCall({
      callerIdentity: args.callerIdentity,
      callerDisplayName: args.callerDisplayName,
      calleeIdentities: args.calleeIdentities,
      isVideo,
      conversationId,
      record: args.record ?? false,
      isScreenShare: args.autoShare === true,
    });
    router.push({
      pathname: '/twilio-call',
      params: {
        room: result.roomName,
        identity: args.callerIdentity,
        isVideo: isVideo ? '1' : '0',
        isCaller: '1',
        token: result.token,
        title: displayName,
        autoShare: args.autoShare ? '1' : '0',
        startMuted: args.startMuted ? '1' : '0',
        // iter-243: 1-on-1 callee id so the caller screen can show
        // "Ringing…" (callee online) vs "Calling…" (callee offline).
        calleeId: args.calleeIdentities.length === 1 ? args.calleeIdentities[0] : '',
      },
    } as any);

    // iter-243: create a Convex "ringing" call record so the callee's
    // FOREGROUND `useIncomingCallListener` (a Convex live query) fires and
    // shows the in-app ring. The backend FCM push already covers the
    // backgrounded/locked/killed case. Skip for screen-share (silent) calls.
    // Fire-and-forget — a Convex hiccup must never block the caller's UI.
    if (!args.autoShare) {
      try {
        const convex = getActiveConvexClient();
        await convex?.mutation(api.calls.initiateCall, {
          conversationId,
          callType: isVideo ? 'video' : 'voice',
        });
      } catch (e: any) {
        recordDiagnostic({
          tag: 'CALL',
          source: 'startCall',
          message: `convex-initiateCall-failed (non-fatal) err=${e?.message || e}`,
        });
      }
    }
  } catch (err: any) {
    recordDiagnostic({
      tag: 'CALL',
      source: 'startCall',
      message: `twilio-fail err=${err?.message || err}`,
    });
    Alert.alert(
      'Could not start call',
      err?.message || 'Twilio call could not be started. Please try again.',
    );
  }
}
