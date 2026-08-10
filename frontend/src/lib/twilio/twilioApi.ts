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
  callerPhone?: string;
  conversationId: string;
  isVideo: boolean;
  /**
   * Unique per-attempt call id. MUST be distinct for every call attempt so the
   * backend + native dedupe (both keyed by callId) never swallow a genuine
   * re-call to the same conversation. Falls back to a fresh random id when
   * omitted. NOTE: this is intentionally NOT the conversationId — using the
   * (stable) conversationId here is exactly what made every 2nd/3rd call to the
   * same person get deduped as a "duplicate ring" and never ring.
   */
  callId?: string;
}): Promise<void> {
  if (!BACKEND_URL || !args.conversationId || args.calleeIdentities.length === 0) return;
  const callId =
    args.callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    const resp = await fetch(`${BACKEND_URL}/api/calls/ring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callee_identities: args.calleeIdentities,
        caller_identity: args.callerIdentity,
        caller_display_name: args.callerDisplayName,
        // Caller's own phone (E.164) so the callee's native notification can
        // resolve the name THEY saved for this number (device address book),
        // instead of falling back to the caller's account/Google name.
        caller_phone: args.callerPhone || '',
        conversation_id: args.conversationId,
        is_video: args.isVideo,
        call_id: callId,
        // The device-reachable public backend URL, injected into the ring FCM
        // so the callee's native CallActionReceiver knows where to POST the
        // `call-declined` event. (Backend can't reliably derive its own public
        // host behind the ingress.)
        backend_url: BACKEND_URL,
      }),
    });
    // iter-385: record whether the doorbell reached the callee's device so the
    // caller screen can show "Reached their phone ✓" (curbs frustrated re-dials).
    try {
      const json = await resp.json();
      const { setRingDelivery } = require('../call/ringDelivery');
      setRingDelivery(args.conversationId, {
        delivered: !!json?.delivered,
        tokenCount: Number(json?.token_count || 0),
      });
    } catch {}
    recordDiagnostic({ tag: 'CALL', source: 'ringWebrtcCall', message: `ok conv=${args.conversationId} callId=${callId} video=${args.isVideo}` });
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
  /** Raw backend roster status. 'left'/'missed' are set once a participant
   *  leaves or their ring goes unanswered. */
  status: 'joined' | 'pending' | 'declined' | 'left' | 'missed';
  /** 'member' for original group members, 'added' for people added mid-call. */
  callRole: 'member' | 'added';
  /** ISO timestamp of the most recent ring — used to derive a "Missed" tag
   *  when a 'pending' entry goes unanswered past the ring timeout. */
  rangAt: string | null;
}

// ── Group call orchestration (Phase 2) ──────────────────────────────────────

/** POST /api/calls/group-ring — ring ALL group members into one Stream room. */
export async function groupRing(args: {
  streamRoom: string;
  conversationId: string;
  callerIdentity: string;
  callerDisplayName?: string;
  callerPhone?: string;
  conversationName?: string;
  members: { identity: string; displayName?: string; phone?: string }[];
  isVideo: boolean;
}): Promise<{ rang: number; delivered: number; tokenCount: number } | null> {
  if (!BACKEND_URL || !args.streamRoom) return null;
  try {
    const resp = await fetch(`${BACKEND_URL}/api/calls/group-ring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream_room: args.streamRoom,
        conversation_id: args.conversationId,
        caller_identity: args.callerIdentity,
        caller_display_name: args.callerDisplayName ?? null,
        caller_phone: args.callerPhone ?? null,
        conversation_name: args.conversationName ?? null,
        members: args.members.map((m) => ({
          identity: m.identity,
          display_name: m.displayName ?? null,
          phone: m.phone ?? null,
        })),
        is_video: args.isVideo,
        backend_url: BACKEND_URL,
      }),
    });
    const json = await resp.json().catch(() => ({}));
    recordDiagnostic({ tag: 'CALL', source: 'groupRing', message: `room=${args.streamRoom} rang=${json?.rang}` });
    return { rang: Number(json?.rang || 0), delivered: Number(json?.delivered || 0), tokenCount: Number(json?.token_count || 0) };
  } catch (e: any) {
    recordDiagnostic({ tag: 'CALL', source: 'groupRing', message: `fail ${e?.message || e}` });
    return null;
  }
}

/** POST /api/calls/group-again — re-ring ONLY pending/declined members. */
export async function groupCallAgain(args: {
  streamRoom: string;
  conversationId: string;
  callerIdentity: string;
  callerDisplayName?: string;
  callerPhone?: string;
  conversationName?: string;
  isVideo: boolean;
}): Promise<number> {
  if (!BACKEND_URL || !args.streamRoom) return 0;
  try {
    const resp = await fetch(`${BACKEND_URL}/api/calls/group-again`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream_room: args.streamRoom,
        conversation_id: args.conversationId,
        caller_identity: args.callerIdentity,
        caller_display_name: args.callerDisplayName ?? null,
        caller_phone: args.callerPhone ?? null,
        conversation_name: args.conversationName ?? null,
        is_video: args.isVideo,
        backend_url: BACKEND_URL,
      }),
    });
    const json = await resp.json().catch(() => ({}));
    return Number(json?.rerang || 0);
  } catch {
    return 0;
  }
}

/** POST /api/calls/participant-status — report MY own join/decline status. */
export async function reportParticipantStatus(args: {
  streamRoom: string;
  identity: string;
  status: 'joined' | 'declined' | 'pending' | 'left' | 'missed';
  displayName?: string;
}): Promise<void> {
  if (!BACKEND_URL || !args.streamRoom || !args.identity) return;
  try {
    await fetch(`${BACKEND_URL}/api/calls/participant-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream_room: args.streamRoom,
        identity: args.identity,
        status: args.status,
        display_name: args.displayName ?? null,
      }),
    });
  } catch {
    /* best-effort */
  }
}

/** POST /api/calls/reset-roster — wipe the room's participant roster so a NEW
 *  call starts fresh (no stale added/left/missed people from a previous call in
 *  the same conversation). Best-effort; the caller fires it once at call start. */
export async function resetCallRoster(streamRoom: string): Promise<void> {
  if (!BACKEND_URL || !streamRoom) return;
  try {
    await fetch(`${BACKEND_URL}/api/calls/reset-roster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream_room: streamRoom }),
    });
  } catch {
    /* best-effort */
  }
}


/** POST /api/calls/request-add — non-admin asks admins to approve adding X. */
export async function requestAddParticipant(args: {
  streamRoom: string;
  conversationId: string;
  requesterIdentity: string;
  requesterName?: string;
  targetIdentity: string;
  targetName?: string;
  targetPhone?: string;
  adminIdentities: string[];
  isVideo: boolean;
  addPermanently: boolean;
}): Promise<boolean> {
  if (!BACKEND_URL) return false;
  try {
    const resp = await fetch(`${BACKEND_URL}/api/calls/request-add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream_room: args.streamRoom,
        conversation_id: args.conversationId,
        requester_identity: args.requesterIdentity,
        requester_name: args.requesterName ?? null,
        target_identity: args.targetIdentity,
        target_name: args.targetName ?? null,
        target_phone: args.targetPhone ?? null,
        admin_identities: args.adminIdentities,
        is_video: args.isVideo,
        add_permanently: args.addPermanently,
        backend_url: BACKEND_URL,
      }),
    });
    const json = await resp.json().catch(() => ({}));
    return !!json?.ok;
  } catch {
    return false;
  }
}

/** POST /api/calls/request-add-declined — tell requester an admin declined. */
export async function declineAddRequest(args: {
  requesterIdentity: string;
  targetName?: string;
  adminName?: string;
}): Promise<void> {
  if (!BACKEND_URL) return;
  try {
    await fetch(`${BACKEND_URL}/api/calls/request-add-declined`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester_identity: args.requesterIdentity,
        target_name: args.targetName ?? null,
        admin_name: args.adminName ?? null,
      }),
    });
  } catch {
    /* best-effort */
  }
}

/** POST /api/calls/admin-kick — admin removes a member from the group call. */
export async function adminKickParticipant(args: {
  streamRoom: string;
  identity: string;
  requesterIdentity: string;
}): Promise<void> {
  if (!BACKEND_URL) throw new Error('[twilio-api] EXPO_PUBLIC_BACKEND_URL is empty in this build');
  const resp = await fetch(`${BACKEND_URL}/api/calls/admin-kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream_room: args.streamRoom,
      identity: args.identity,
      requester_identity: args.requesterIdentity,
      backend_url: BACKEND_URL,
    }),
  });
  if (!resp.ok) throw new Error(`[twilio-api] admin-kick HTTP ${resp.status}`);
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
 * POST /api/calls/add-participant — Stream-native "add participant". Rings the
 * new person (FCM doorbell) into the SAME live Stream room (`streamRoom`) so
 * Stream's SFU mixes everyone, and persists the adder's number-visibility
 * choice into the same roster the /twilio/call-participants GET reads from.
 */
export async function addStreamParticipant(args: {
  streamRoom: string;
  adderIdentity: string;
  adderDisplayName?: string;
  adderPhone?: string;
  calleeIdentity: string;
  calleeDisplayName?: string;
  calleePhone?: string;
  hideNumber: boolean;
  isVideo: boolean;
  conversationId: string;
}): Promise<void> {
  if (!BACKEND_URL) throw new Error('[twilio-api] EXPO_PUBLIC_BACKEND_URL is empty in this build');
  const resp = await fetch(`${BACKEND_URL}/api/calls/add-participant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream_room: args.streamRoom,
      adder_identity: args.adderIdentity,
      adder_display_name: args.adderDisplayName ?? null,
      adder_phone: args.adderPhone ?? null,
      callee_identity: args.calleeIdentity,
      callee_display_name: args.calleeDisplayName ?? null,
      callee_phone: args.calleePhone ?? null,
      hide_number: args.hideNumber,
      is_video: args.isVideo,
      conversation_id: args.conversationId,
      backend_url: BACKEND_URL,
    }),
  });
  if (!resp.ok) {
    let body = '';
    try {
      body = (await resp.text()).slice(0, 200);
    } catch {}
    recordDiagnostic({ tag: 'CALL', source: 'addStreamParticipant', message: `HTTP_${resp.status} body=${body}` });
    throw new Error(`[twilio-api] calls/add-participant HTTP ${resp.status}`);
  }
  recordDiagnostic({
    tag: 'CALL',
    source: 'addStreamParticipant',
    message: `ok room=${args.streamRoom} callee=${args.calleeIdentity} hide=${args.hideNumber}`,
  });
}

/**
 * POST /api/calls/remove-participant — Stream-native removal. Only the person
 * who ADDED the target (roster `added_by`) may remove them; the backend
 * enforces this and 403s otherwise. Signals the removed device to leave.
 */
export async function removeStreamParticipant(args: {
  streamRoom: string;
  identity: string;
  requesterIdentity: string;
}): Promise<void> {
  if (!BACKEND_URL) throw new Error('[twilio-api] EXPO_PUBLIC_BACKEND_URL is empty in this build');
  const resp = await fetch(`${BACKEND_URL}/api/calls/remove-participant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream_room: args.streamRoom,
      identity: args.identity,
      requester_identity: args.requesterIdentity,
      backend_url: BACKEND_URL,
    }),
  });
  if (!resp.ok) {
    if (resp.status === 403) throw new Error('Only the person who added them can remove them.');
    recordDiagnostic({ tag: 'CALL', source: 'removeStreamParticipant', message: `HTTP_${resp.status}` });
    throw new Error(`[twilio-api] calls/remove-participant HTTP ${resp.status}`);
  }
  recordDiagnostic({
    tag: 'CALL',
    source: 'removeStreamParticipant',
    message: `ok room=${args.streamRoom} identity=${args.identity}`,
  });
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
      status: (p.status as CallRosterEntry['status']) || 'joined',
      callRole: (p.call_role as 'member' | 'added') || 'added',
      rangAt: p.rang_at ?? null,
    }));
  } catch {
    return [];
  }
}
