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
  calleeIdentities: string[];
  isVideo?: boolean;
  conversationId?: string | null;
  roomName?: string | null;
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
      callee_identities: args.calleeIdentities,
      is_video: args.isVideo !== false,
      conversation_id: args.conversationId ?? null,
      room_name: args.roomName ?? null,
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
 * Feature flag. Reads `EXPO_PUBLIC_USE_TWILIO` at build time. The legacy
 * `react-native-webrtc` stack continues to handle calls when this
 * returns false — Twilio is opt-in until Phase A.3 fully validates.
 */
export function isTwilioEnabled(): boolean {
  const raw = (process.env.EXPO_PUBLIC_USE_TWILIO || '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}
