/**
 * Twilio Programmable Video — backend API client (Phase A.2).
 *
 * Thin wrappers around the FastAPI endpoints added in Phase A.1:
 *   POST /api/twilio/video-token   — mint a short-lived JWT for a room
 *   POST /api/twilio/initiate-call — create a room + mint caller token
 *
 * The mobile client NEVER sees Twilio API Key SID/Secret. It only ever
 * holds a short-lived JWT scoped to one room and one identity.
 *
 * All errors throw with `[twilio-api]` prefixed messages so they're
 * grep-able in the diagnostic log stream.
 */

import { recordDiagnostic } from '../diagnostics';

const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

/**
 * POST /api/calls/ring — send the FCM wake-push for a WebRTC call.
 *
 * In WebRTC mode the mobile caller doesn't hit /twilio/initiate-call, so this
 * is what wakes a backgrounded/killed callee device and rings it. Fire-and-
 * forget: a failure here must never block the caller's own call UI.
 */
export async function ringWebrtcCall(args: {
  calleeIdentities: string[];
  callerIdentity: string;
  callerDisplayName?: string;
  conversationId: string;
  isVideo: boolean;
}): Promise<void> {
  if (!BACKEND_URL || !args.conversationId || args.calleeIdentities.length === 0) return;
  try {
    await fetch(`${BACKEND_URL}/api/calls/ring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callee_identities: args.calleeIdentities,
        caller_identity: args.callerIdentity,
        caller_display_name: args.callerDisplayName,
        conversation_id: args.conversationId,
        is_video: args.isVideo,
        call_id: args.conversationId,
        // The device-reachable public backend URL, injected into the ring FCM
        // so the callee's native CallActionReceiver knows where to POST the
        // `call-declined` event. (Backend can't reliably derive its own public
        // host behind the ingress.)
        backend_url: BACKEND_URL,
      }),
    });
    recordDiagnostic({ tag: 'CALL', source: 'ringWebrtcCall', message: `ok conv=${args.conversationId} video=${args.isVideo}` });
  } catch (e: any) {
    recordDiagnostic({ tag: 'CALL', source: 'ringWebrtcCall', message: `fail ${e?.message || e}` });
  }
}

export interface TwilioToken {
  token: string;
  identity: string;
  roomName: string;
  ttlSeconds: number;
  region: string;
}

export interface TwilioInitiateCallResult extends TwilioToken {
  roomSid: string;
  roomStatus: string;
  mediaRegion: string | null;
  calleeIdentities: string[];
}

/** POST /api/twilio/video-token — mint JWT for an existing room. */
export async function fetchTwilioToken(
  identity: string,
  roomName: string,
  signal?: AbortSignal,
): Promise<TwilioToken> {
  if (!BACKEND_URL) {
    throw new Error('[twilio-api] EXPO_PUBLIC_BACKEND_URL is empty in this build');
  }
  const url = `${BACKEND_URL}/api/twilio/video-token`;
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, room_name: roomName }),
    signal,
  });
  const ms = Date.now() - t0;
  if (!resp.ok) {
    let body = '';
    try {
      body = (await resp.text()).slice(0, 200);
    } catch {}
    recordDiagnostic({
      tag: 'TWILIO',
      source: 'fetchTwilioToken',
      message: `HTTP_${resp.status} ${ms}ms body=${body}`,
    });
    throw new Error(`[twilio-api] video-token HTTP ${resp.status}`);
  }
  const json = await resp.json();
  recordDiagnostic({
    tag: 'TWILIO',
    source: 'fetchTwilioToken',
    message: `ok ${ms}ms room=${json.room_name} ttl=${json.ttl_seconds}`,
  });
  return {
    token: json.token,
    identity: json.identity,
    roomName: json.room_name,
    ttlSeconds: json.ttl_seconds,
    region: json.region,
  };
}

/**
 * POST /api/twilio/initiate-call — create a room AND mint the caller's
 * JWT in one round-trip. Caller uses the returned token; callees fetch
 * their own via {@link fetchTwilioToken} after accepting the push.
 */
export async function initiateTwilioCall(args: {
  callerIdentity: string;
  callerDisplayName?: string;
  calleeIdentities: string[];
  isVideo?: boolean;
  conversationId?: string | null;
  roomName?: string | null;
  isScreenShare?: boolean;
  signal?: AbortSignal;
}): Promise<TwilioInitiateCallResult> {
  if (!BACKEND_URL) {
    throw new Error('[twilio-api] EXPO_PUBLIC_BACKEND_URL is empty in this build');
  }
  const url = `${BACKEND_URL}/api/twilio/initiate-call`;
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      caller_identity: args.callerIdentity,
      caller_display_name: args.callerDisplayName || null,
      callee_identities: args.calleeIdentities,
      is_video: args.isVideo !== false,
      conversation_id: args.conversationId ?? null,
      room_name: args.roomName ?? null,
      is_screen_share: args.isScreenShare === true,
    }),
    signal: args.signal,
  });
  const ms = Date.now() - t0;
  if (!resp.ok) {
    let body = '';
    try {
      body = (await resp.text()).slice(0, 200);
    } catch {}
    recordDiagnostic({
      tag: 'TWILIO',
      source: 'initiateTwilioCall',
      message: `HTTP_${resp.status} ${ms}ms body=${body}`,
    });
    throw new Error(`[twilio-api] initiate-call HTTP ${resp.status}`);
  }
  const json = await resp.json();
  recordDiagnostic({
    tag: 'TWILIO',
    source: 'initiateTwilioCall',
    message:
      `ok ${ms}ms room_sid=${json.room_sid} room=${json.room_name} ` +
      `status=${json.room_status} region=${json.media_region}`,
  });
  return {
    token: json.caller_token,
    identity: json.caller_identity,
    roomName: json.room_name,
    ttlSeconds: 600,
    region: json.media_region || 'ie1',
    roomSid: json.room_sid,
    roomStatus: json.room_status,
    mediaRegion: json.media_region,
    calleeIdentities: json.callee_identities,
  };
}

/**
 * POST /api/twilio/end-call — force-complete a Twilio room so the call
 * ends for EVERYONE. Twilio does not auto-disconnect the remaining
 * participant when one side leaves, so the other phone would keep
 * ringing / stay connected without this. Fire-and-forget + idempotent
 * (both sides may call it on a hangup race) — never throws.
 */
export async function endTwilioCall(roomName: string, roomSid?: string | null): Promise<void> {
  if (!BACKEND_URL || !roomName) {
    // sml-007: this used to return silently. A missing roomName here (e.g.
    // the relay-FCM race leaving the caller's decline handler with an
    // unresolved room) meant the Twilio room was never told to complete,
    // with zero trace in the diagnostics — logging it so this no-op is
    // visible instead of looking like the call quietly worked.
    recordDiagnostic({
      tag: 'TWILIO-CALL',
      source: 'endTwilioCall',
      message: `skipped — missing ${!BACKEND_URL ? 'BACKEND_URL' : 'roomName'} (roomName=${roomName || '(empty)'})`,
    });
    return;
  }
  const t0 = Date.now();
  try {
    const resp = await fetch(`${BACKEND_URL}/api/twilio/end-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_name: roomName, room_sid: roomSid ?? null }),
    });
    recordDiagnostic({
      tag: 'TWILIO-CALL',
      source: 'endTwilioCall',
      message: `room=${roomName} http=${resp.status} ${Date.now() - t0}ms`,
    });
  } catch (errorValue: any) {
    recordDiagnostic({
      tag: 'TWILIO-CALL',
      source: 'endTwilioCall',
      message: `error room=${roomName} ${errorValue?.message || errorValue}`,
    });
  }
}

/**
 * Feature flag. Twilio is now the DEFAULT call engine — it is used unless
 * `EXPO_PUBLIC_USE_TWILIO` is explicitly set to a falsy value ("0"/"false"/
 * "no"). This guards against the env var being absent in a production build
 * (which previously made calls silently fall back to the legacy WebRTC
 * stack). The legacy stack only runs when Twilio is explicitly disabled.
 */
export function isTwilioEnabled(): boolean {
  const raw = (process.env.EXPO_PUBLIC_USE_TWILIO ?? '').toLowerCase().trim();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}

export interface CallRosterEntry {
  identity: string;
  displayName: string | null;
  /** null when hidden from this viewer by the adder's privacy choice. */
  phoneNumber: string | null;
  hideNumber: boolean;
  addedBy: string | null;
}

/**
 * POST /api/twilio/add-participant — ring an additional person into the
 * SAME live room (Twilio Group Rooms mix everyone server-side). The
 * `hideNumber` flag records the adder's choice on whether the new
 * participant's phone number is visible to the OTHER participants.
 */
export async function addTwilioParticipant(args: {
  roomName: string;
  adderIdentity: string;
  adderDisplayName?: string;
  calleeIdentity: string;
  calleeDisplayName?: string;
  calleePhone?: string;
  hideNumber: boolean;
  isVideo: boolean;
  conversationId?: string | null;
}): Promise<void> {
  if (!BACKEND_URL) throw new Error('[twilio-api] EXPO_PUBLIC_BACKEND_URL is empty in this build');
  const resp = await fetch(`${BACKEND_URL}/api/twilio/add-participant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_name: args.roomName,
      adder_identity: args.adderIdentity,
      adder_display_name: args.adderDisplayName ?? null,
      callee_identity: args.calleeIdentity,
      callee_display_name: args.calleeDisplayName ?? null,
      callee_phone: args.calleePhone ?? null,
      hide_number: args.hideNumber,
      is_video: args.isVideo,
      conversation_id: args.conversationId ?? null,
    }),
  });
  if (!resp.ok) {
    let body = '';
    try {
      body = (await resp.text()).slice(0, 200);
    } catch {}
    recordDiagnostic({ tag: 'TWILIO-CALL', source: 'addParticipant', message: `HTTP_${resp.status} body=${body}` });
    throw new Error(`[twilio-api] add-participant HTTP ${resp.status}`);
  }
}

/**
 * POST /api/twilio/remove-participant — host action: server-enforced
 * disconnect of a participant from the live room (via Twilio REST).
 */
export async function removeTwilioParticipant(args: {
  roomName: string;
  identity: string;
  requesterIdentity?: string;
}): Promise<void> {
  if (!BACKEND_URL) throw new Error('[twilio-api] EXPO_PUBLIC_BACKEND_URL is empty in this build');
  const resp = await fetch(`${BACKEND_URL}/api/twilio/remove-participant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_name: args.roomName,
      identity: args.identity,
      requester_identity: args.requesterIdentity ?? null,
    }),
  });
  if (!resp.ok) {
    recordDiagnostic({ tag: 'TWILIO-CALL', source: 'removeParticipant', message: `HTTP_${resp.status}` });
    throw new Error(`[twilio-api] remove-participant HTTP ${resp.status}`);
  }
}

/**
 * GET /api/twilio/call-participants — privacy-aware roster for a room.
 * The viewer's identity decides which phone numbers are revealed.
 */
export async function fetchCallParticipants(roomName: string, viewer: string): Promise<CallRosterEntry[]> {
  if (!BACKEND_URL || !roomName) return [];
  try {
    const url = `${BACKEND_URL}/api/twilio/call-participants?room_name=${encodeURIComponent(roomName)}&viewer=${encodeURIComponent(viewer)}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const json = await resp.json();
    return (json.participants || []).map((p: any) => ({
      identity: p.identity,
      displayName: p.display_name ?? null,
      phoneNumber: p.phone_number ?? null,
      hideNumber: !!p.hide_number,
      addedBy: p.added_by ?? null,
    }));
  } catch {
    return [];
  }
}
