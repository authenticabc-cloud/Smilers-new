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

import { initiateTwilioCall, isTwilioEnabled } from './twilioApi';
import { recordDiagnostic } from '../diagnostics';

export interface StartCallArgs {
  router: Router;
  /** Caller's stable user ID (typically `me._id` from Convex). */
  callerIdentity: string;
  /** Caller's display name shown in the callee's incoming-call notification. */
  callerDisplayName?: string;
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
}

export async function startCall(args: StartCallArgs): Promise<void> {
  const { router, conversationId, isVideo, displayName } = args;

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
      calleeIdentities: args.calleeIdentities,
      isVideo,
      conversationId,
      record: args.record ?? false,
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
      },
    } as any);
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
