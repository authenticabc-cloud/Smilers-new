from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import asyncio
import re
import time
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
import httpx  # HTTP client for scripture/Quran proxy endpoints (module-level import)
import jwt  # PyJWT — signs Stream Video access tokens (HS256) with the Stream secret
from datetime import datetime, timezone, timedelta
from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType

# Twilio Programmable Video — Phase A.1
# Used to mint short-lived JWT access tokens server-side and to create
# rooms via REST. Credentials live in `.env` (TWILIO_*) and NEVER reach
# the client.
from twilio.jwt.access_token import AccessToken
from twilio.jwt.access_token.grants import VideoGrant
from twilio.rest import Client as TwilioRestClient
from twilio.base.exceptions import TwilioRestException


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Process start time — used by /api/health to report uptime.
_SERVER_STARTED_AT = datetime.now(timezone.utc)

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# ── Liveness (app-level, NO /api prefix, NO DB dependency) ───────────────────
# Kubernetes / Emergent readiness+liveness probes hit the backend directly on
# port 8001 at "/" and "/health". These MUST return 200 immediately without
# touching MongoDB/Atlas — otherwise a slow or momentarily-unreachable database
# during boot makes the probe fail and the pod is killed → CrashLoopBackOff
# (the symptom seen in the deploy logs: backend boots, "Application startup
# complete", then the whole container restarts seconds later, on repeat).
# The rich, DB-aware readiness report still lives at GET /api/health.
@app.get("/")
async def liveness_root():
    return {"status": "ok"}


@app.get("/health")
async def liveness_health():
    return {"status": "ok"}



# Define Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)

class StatusCheckCreate(BaseModel):
    client_name: str


class TranslationRequest(BaseModel):
    text: str
    target_language: str
    skip_languages: List[str] = Field(default_factory=list)


class TranslationResponse(BaseModel):
    translated_text: str


TRANSLATION_CACHE: dict[str, str] = {}

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}


@api_router.get("/__health")
async def health_check():
    """
    iter-D1: Forensic health probe used by the mobile client at boot
    to verify it is talking to the right backend AND that critical
    routes still exist.

    The mobile client logs the response (or 404/timeout) as a `[HEALTH]`
    diagnostic — so when a user reports "register-push 404", one grep on
    `[DIAG][HEALTH]` in supervisor logs tells us instantly whether the
    APK reached our backend at all and whether the routes it expects are
    present at the moment of failure.

    Intentionally lightweight: no DB call, no auth, sub-millisecond.
    Returns a list of critical route paths so a stale deployment (where
    a route was dropped) is detectable from the client side.
    """
    # Enumerate registered API routes so client can confirm criticals exist.
    critical = {
        "/api/register-push",
        "/api/notify-event",
        "/api/diagnostic-logs",
        "/api/safe-browsing/check",
        "/api/twilio/video-token",
        "/api/twilio/initiate-call",
        "/api/stream/token",
    }
    present = set()
    try:
        for r in app.routes:
            path = getattr(r, "path", None)
            if path in critical:
                present.add(path)
    except Exception:
        # Never let route introspection failure break the probe.
        pass
    return {
        "status": "ok",
        "service": "smilers-backend",
        # Reflect the version baked into the deployed pod for forensics.
        "version": os.environ.get("APP_VERSION", "unknown"),
        "critical_routes_present": sorted(present),
        "critical_routes_missing": sorted(critical - present),
        # Echo the server's own clock so client-side drift is visible.
        "server_time": datetime.now(timezone.utc).isoformat(),
    }


# ============================================================
# Twilio Programmable Video — Phase A.1
# ============================================================
# Replaces the legacy react-native-webrtc + Convex signaling stack
# with Twilio's managed SFU + global TURN/NTS. Clients receive a
# short-lived JWT (10 min) bound to their identity + room. Backend
# uses the API Key SID/Secret pair (NOT the master Auth Token) so
# the credentials can be rotated independently.
# ============================================================

_TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
_TWILIO_API_KEY_SID = os.environ.get("TWILIO_API_KEY_SID", "")
_TWILIO_API_KEY_SECRET = os.environ.get("TWILIO_API_KEY_SECRET", "")
# Media region only (where Twilio's SFU runs for this room). We
# deliberately do NOT use TWILIO_REGION env var because the Twilio
# Python SDK auto-prepends that to all REST URLs, which breaks the
# Video REST API (it has no regional subdomain).
_TWILIO_MEDIA_REGION = os.environ.get("TWILIO_MEDIA_REGION", "ie1")
_TWILIO_VIDEO_ROOM_TYPE = os.environ.get("TWILIO_VIDEO_ROOM_TYPE", "group")
# Token TTL — keep short so a stolen token expires fast.
_TWILIO_TOKEN_TTL_SECONDS = 600  # 10 minutes

# Lazy-init the REST client only when first needed so server boot does
# not depend on Twilio being reachable.
_twilio_rest: Optional["TwilioRestClient"] = None


def _get_twilio_rest() -> Optional["TwilioRestClient"]:
    global _twilio_rest
    if not (_TWILIO_ACCOUNT_SID and _TWILIO_API_KEY_SID and _TWILIO_API_KEY_SECRET):
        return None
    if _twilio_rest is None:
        # Authenticate REST calls with the API Key pair (not the master
        # Auth Token) — same credentials used to sign access tokens.
        _twilio_rest = TwilioRestClient(
            _TWILIO_API_KEY_SID, _TWILIO_API_KEY_SECRET, _TWILIO_ACCOUNT_SID
        )
    return _twilio_rest


class TwilioTokenRequest(BaseModel):
    """Client requests a JWT for a specific Twilio Video room."""
    identity: str = Field(..., min_length=1, max_length=120, description="Stable user ID (e.g., OIDC sub or Convex user _id)")
    room_name: str = Field(..., min_length=1, max_length=128, description="Twilio room name — typically created via initiate-call")


class TwilioTokenResponse(BaseModel):
    token: str
    identity: str
    room_name: str
    ttl_seconds: int
    region: str
    server_time: str


@api_router.post("/twilio/video-token", response_model=TwilioTokenResponse)
async def twilio_video_token(payload: TwilioTokenRequest):
    """
    Mint a short-lived (10 min) Twilio Programmable Video JWT bound to
    `identity` + `room_name`. The token is the ONLY credential the
    mobile client ever sees — `API_KEY_SECRET` stays server-side.

    Note: We deliberately do NOT verify Smilers-side auth here yet
    because the existing call signaling layer is Convex-based and the
    OIDC bearer flows through the mobile app's API helper. Add an
    auth dependency in Phase A.3 once `TwilioCallSession` is wired in
    and we know the auth shape.
    """
    if not (_TWILIO_ACCOUNT_SID and _TWILIO_API_KEY_SID and _TWILIO_API_KEY_SECRET):
        raise HTTPException(
            status_code=503,
            detail="Twilio not configured: TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET missing in backend env.",
        )

    try:
        token = AccessToken(
            _TWILIO_ACCOUNT_SID,
            _TWILIO_API_KEY_SID,
            _TWILIO_API_KEY_SECRET,
            identity=payload.identity,
            ttl=_TWILIO_TOKEN_TTL_SECONDS,
            region=_TWILIO_MEDIA_REGION,
        )
        # Scope the grant to ONE room — token is useless for other rooms.
        token.add_grant(VideoGrant(room=payload.room_name))
        jwt_str = token.to_jwt()
        # twilio>=8 returns str; older versions returned bytes. Normalise.
        if isinstance(jwt_str, (bytes, bytearray)):
            jwt_str = jwt_str.decode("utf-8")
    except Exception as exc:
        logger.exception("twilio-token mint failed")
        raise HTTPException(status_code=500, detail=f"Token mint failed: {exc}")

    return TwilioTokenResponse(
        token=jwt_str,
        identity=payload.identity,
        room_name=payload.room_name,
        ttl_seconds=_TWILIO_TOKEN_TTL_SECONDS,
        region=_TWILIO_MEDIA_REGION,
        server_time=datetime.now(timezone.utc).isoformat(),
    )


# ============================================================
# Stream Video — reliable native ringing (CallKit / ConnectionService)
# ============================================================
# Migrates 1:1 voice/video calling off the custom WebRTC + Convex-signaling
# stack (which relies on data-only FCM to wake a killed device and has no
# native call UI) onto GetStream's Video SDK. Stream provides CallKit (iOS)
# and full-screen ConnectionService ringing (Android) that fire even when the
# app is killed — the WhatsApp-grade behaviour the custom stack can't reach.
#
# The API SECRET stays server-side and signs short-lived per-user JWTs here;
# the client only ever receives the minted token. User id = the caller's
# stable Convex user _id (matches how calls address members).
_STREAM_API_KEY = os.environ.get("STREAM_API_KEY", "")
_STREAM_API_SECRET = os.environ.get("STREAM_API_SECRET", "")
_STREAM_TOKEN_TTL_SECONDS = 4 * 60 * 60  # 4h — SDK auto-refreshes via tokenProvider


class StreamTokenRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=120, description="Stable user id (Convex user _id)")
    user_name: str | None = Field(default=None, max_length=120)


class StreamTokenResponse(BaseModel):
    token: str
    api_key: str
    user_id: str
    ttl_seconds: int
    server_time: str


@api_router.post("/stream/token", response_model=StreamTokenResponse)
async def stream_video_token(payload: StreamTokenRequest):
    """
    Mint a short-lived Stream Video JWT for `user_id`. Signed HS256 with the
    Stream API SECRET (server-only). Mirrors the Twilio-token trust model: we
    do not yet verify Smilers-side auth here (the mobile client's OIDC flow is
    Convex-based) — harden with an auth dependency in a later phase.
    """
    if not (_STREAM_API_KEY and _STREAM_API_SECRET):
        raise HTTPException(
            status_code=503,
            detail="Stream not configured: STREAM_API_KEY / STREAM_API_SECRET missing in backend env.",
        )
    # Stream user ids must match [a-zA-Z0-9@_-]. Convex ids already comply, but
    # sanitise defensively so a stray char can't produce an unusable token.
    safe_uid = re.sub(r"[^a-zA-Z0-9@_-]", "_", payload.user_id.strip())
    if not safe_uid:
        raise HTTPException(status_code=400, detail="Invalid user_id")
    now = datetime.now(timezone.utc)
    try:
        token = jwt.encode(
            {
                "user_id": safe_uid,
                "iat": int(now.timestamp()),
                # small backdate to tolerate minor client/server clock skew
                "nbf": int(now.timestamp()) - 5,
                "exp": int(now.timestamp()) + _STREAM_TOKEN_TTL_SECONDS,
            },
            _STREAM_API_SECRET,
            algorithm="HS256",
        )
        if isinstance(token, (bytes, bytearray)):
            token = token.decode("utf-8")
    except Exception as exc:
        logger.exception("stream-token mint failed")
        raise HTTPException(status_code=500, detail=f"Token mint failed: {exc}")

    return StreamTokenResponse(
        token=token,
        api_key=_STREAM_API_KEY,
        user_id=safe_uid,
        ttl_seconds=_STREAM_TOKEN_TTL_SECONDS,
        server_time=now.isoformat(),
    )


class TwilioInitiateCallRequest(BaseModel):
    """Caller initiates a Twilio Video call to one or more callees."""
    caller_identity: str = Field(..., min_length=1, max_length=120)
    caller_display_name: Optional[str] = Field(None, max_length=120, description="Shown in the incoming-call notification")
    callee_identities: List[str] = Field(default_factory=list, description="Stable user IDs of all invitees")
    is_video: bool = True
    conversation_id: Optional[str] = Field(None, description="Convex conversation _id — used for room naming + push routing")
    room_name: Optional[str] = Field(None, description="Optional explicit room name; otherwise generated")
    record: bool = Field(False, description="If true, Twilio records all participants from connect")
    is_screen_share: bool = Field(False, description="If true, this is a screen-share request, not a regular call")


class TwilioInitiateCallResponse(BaseModel):
    room_name: str
    room_sid: str
    room_status: str
    media_region: Optional[str]
    caller_identity: str
    callee_identities: List[str]
    # Token for the caller — saves a round trip; callees fetch their own.
    caller_token: str
    # iter-A4: push delivery stats so we know if callees were rung.
    push_stats: dict
    server_time: str


def _derive_room_name(caller: str, callees: List[str], conversation_id: Optional[str]) -> str:
    """
    Deterministic room name:
      - If a conversation_id is provided, reuse it (1-on-1 / group chat tied to a Convex conversation).
      - Otherwise sort caller+callees and hash for a stable 1-on-1 name.
      - Multi-callee with no conversation_id → uuid (fresh group call).
    """
    if conversation_id:
        return f"smilers_conv_{conversation_id}"
    if len(callees) == 1:
        parts = sorted([caller, callees[0]])
        return f"smilers_{parts[0]}_{parts[1]}"
    return f"smilers_group_{uuid.uuid4().hex[:16]}"


@api_router.post("/twilio/initiate-call", response_model=TwilioInitiateCallResponse)
async def twilio_initiate_call(payload: TwilioInitiateCallRequest):
    """
    Create (or fetch) a Twilio Video room for this call + mint the
    caller's JWT in one shot. The mobile client will then POST a
    `call.invite` message via Convex (or via the existing push pipeline
    in Phase A.3) carrying `room_name` so callees can join.

    Phase A.1 scope: room creation + caller token only. FCM push to
    callees is wired in Phase A.3 alongside the `TwilioCallSession`
    rollout so we don't double-send notifications during migration.
    """
    rest = _get_twilio_rest()
    if rest is None:
        raise HTTPException(
            status_code=503,
            detail="Twilio not configured: missing TWILIO_* env vars.",
        )
    if not payload.callee_identities:
        raise HTTPException(status_code=400, detail="callee_identities must contain at least one identity.")

    room_name = payload.room_name or _derive_room_name(
        payload.caller_identity, payload.callee_identities, payload.conversation_id
    )

    # Idempotent room creation: if a room with this unique_name already
    # exists AND is still 'in-progress', reuse it. Otherwise create new.
    room = None
    try:
        # Twilio uniqueness is on (unique_name + in-progress) — a completed
        # room with the same unique_name does NOT block a new one.
        existing = rest.video.v1.rooms.list(unique_name=room_name, status="in-progress", limit=1)
        if existing:
            room = existing[0]
            logger.info(f"twilio-initiate-call reusing in-progress room sid={room.sid} name={room_name}")
        else:
            room = rest.video.v1.rooms.create(
                unique_name=room_name,
                type=_TWILIO_VIDEO_ROOM_TYPE,
                # iter-A4: caller can opt in to cloud recording. When
                # enabled, Twilio records each participant's audio + video
                # tracks. Compositions are fetched separately via
                # /api/twilio/recordings.
                record_participants_on_connect=payload.record,
                # Pin media region to keep RTT low for our target user base.
                media_region=_TWILIO_MEDIA_REGION,
            )
            logger.info(f"twilio-initiate-call created room sid={room.sid} name={room_name}")
    except TwilioRestException as exc:
        logger.exception("twilio-initiate-call REST failed")
        raise HTTPException(status_code=502, detail=f"Twilio room create failed: {exc.msg}")

    # Mint the caller's JWT immediately so the client can join without
    # an extra round-trip.
    try:
        caller_token_obj = AccessToken(
            _TWILIO_ACCOUNT_SID,
            _TWILIO_API_KEY_SID,
            _TWILIO_API_KEY_SECRET,
            identity=payload.caller_identity,
            ttl=_TWILIO_TOKEN_TTL_SECONDS,
            region=_TWILIO_MEDIA_REGION,
        )
        caller_token_obj.add_grant(VideoGrant(room=room_name))
        caller_jwt = caller_token_obj.to_jwt()
        if isinstance(caller_jwt, (bytes, bytearray)):
            caller_jwt = caller_jwt.decode("utf-8")
    except Exception as exc:
        logger.exception("twilio-initiate-call token mint failed")
        raise HTTPException(status_code=500, detail=f"Caller token mint failed: {exc}")

    # Persist the call record so we can correlate Twilio SIDs with our
    # own call history later. Best-effort — failures here don't block
    # the call from starting.
    try:
        await db.twilio_calls.insert_one(
            {
                "room_sid": room.sid,
                "room_name": room_name,
                "caller_identity": payload.caller_identity,
                "callee_identities": payload.callee_identities,
                "conversation_id": payload.conversation_id,
                "is_video": payload.is_video,
                "record": payload.record,
                "created_at": datetime.now(timezone.utc),
                "status": room.status,
            }
        )
    except Exception:
        logger.warning("twilio-initiate-call: persisting call record to MongoDB failed (non-fatal)")

    # iter-A4: ring the callees via the existing push pipeline. The
    # payload includes `twilio_room_name` so the mobile tap-handler
    # routes to /twilio-call instead of the legacy /call screen.
    push_stats: dict = {"token_count": 0, "success_count": 0, "error_count": 0, "errors": [], "pruned_count": 0}
    # iter-237: when the caller has no display name set, fall back to a
    # readable label instead of the raw Convex user id (which surfaced as a
    # "code" in the incoming-call notification).
    display_name = payload.caller_display_name or "Smilers User"
    try:
        push_data = {
            "title": display_name,
            "message": (
                "Screen share request"
                if payload.is_screen_share
                else ("Incoming video call" if payload.is_video else "Incoming call")
            ),
            "type": "call",
            "callId": room.sid,
            # iter-A4c: caller's id so the callee's answer-handler can derive a
            # unique Twilio identity to join with (without it the callee screen
            # spins on "connecting" forever).
            "callerId": payload.caller_identity,
            "callerName": display_name,
            # Mirrors the legacy /call/<id> deeplink shape so existing
            # taps in the absence of twilio_room_name fall back gracefully.
            "conversationId": payload.conversation_id or room_name,
            # The twilio_* fields below are how the mobile client knows
            # to use the new Twilio path instead of the legacy stack.
            "twilio_room_name": room_name,
            "twilio_room_sid": room.sid,
            "twilio_is_video": "1" if payload.is_video else "0",
            "twilio_caller_identity": payload.caller_identity,
            "displayName": display_name,
            # Deeplink fallback — note the path starts with `/call/`
            # so the backend channel classifier routes this through
            # the high-priority calls channel (long ringtone + bypass
            # DnD). The mobile tap-handler checks `twilio_room_name`
            # first so routing still lands on /twilio-call, not the
            # legacy call screen.
            "action_url": (
                f"/call/twilio-{room_name}?room={room_name}&isCaller=0&isVideo="
                f"{'1' if payload.is_video else '0'}&title={display_name}"
            ),
            # iter-A4b: extra hints so the classifier picks the call
            # channel even if `type` or `action_url` are stripped in
            # transit by an intermediate proxy.
            "subtext": "Screen share request" if payload.is_screen_share else "Incoming call",
        }
        push_stats = {"token_count": 0, "success_count": 0, "error_count": 0, "errors": [], "pruned_count": 0, "scheduled": True}

        # iter-241: dispatch the callee push in the BACKGROUND so the caller's
        # initiate-call response returns as soon as the room + token are ready.
        # Previously we awaited send_push() (FCM/relay round-trip) before
        # responding, which made tapping "Call" feel slow before the caller's
        # own call screen even opened. The ring latency on the callee side is
        # unaffected (the push still goes out immediately, just not blocking
        # the caller's HTTP response).
        async def _dispatch_call_push():
            try:
                stats = await send_push(
                    recipients=payload.callee_identities,
                    data=push_data,
                    idempotency_key=f"twilio-call:{room.sid}",
                )
                logger.info(
                    f"twilio-initiate-call pushed to {len(payload.callee_identities)} callees: "
                    f"tokens={stats.get('token_count')} ok={stats.get('success_count')} "
                    f"err={stats.get('error_count')}"
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception(f"twilio-initiate-call: background push to callees failed (non-fatal): {exc}")

        asyncio.create_task(_dispatch_call_push())
    except Exception as exc:
        logger.exception(f"twilio-initiate-call: push to callees failed (non-fatal): {exc}")

    return TwilioInitiateCallResponse(
        room_name=room_name,
        room_sid=room.sid,
        room_status=room.status,
        media_region=getattr(room, "media_region", None) or _TWILIO_MEDIA_REGION,
        caller_identity=payload.caller_identity,
        callee_identities=payload.callee_identities,
        caller_token=caller_jwt,
        push_stats=push_stats,
        server_time=datetime.now(timezone.utc).isoformat(),
    )


# ============================================================
# WebRTC call ring — wake a (possibly killed) callee device
# ============================================================
#
# When EXPO_PUBLIC_USE_TWILIO=0 the app connects calls over WebRTC + Convex
# signaling (interoperates with the web app). In that mode the mobile caller
# does NOT hit /twilio/initiate-call, so nothing was sending the FCM wake-push
# — which is why ringing stopped working when the callee app was killed. This
# endpoint sends ONLY the call push (no Twilio room), tagged as a call so the
# device delivers it data-only and the Notifee full-screen wake fires and
# routes to /call/<conversationId> (the WebRTC screen).
class WebRtcRingRequest(BaseModel):
    callee_identities: List[str] = Field(default_factory=list)
    caller_identity: str = ""
    caller_display_name: str | None = None
    caller_phone: str | None = None
    conversation_id: str = Field(..., min_length=1)
    is_video: bool = False
    call_id: str | None = None
    # Device-reachable public backend URL, sent by the mobile caller so the
    # callee's native receiver can POST call-declined back (see /calls/ring).
    backend_url: str | None = None


@api_router.post("/calls/ring")
async def webrtc_ring(payload: WebRtcRingRequest, request: Request):
    if not payload.callee_identities:
        return {"scheduled": False, "reason": "no-callees"}
    display_name = payload.caller_display_name or "Smilers User"
    call_id = payload.call_id or payload.conversation_id
    # Public base URL of THIS backend, so the callee's native CallActionReceiver
    # knows where to POST the `call-declined` event (it reads `backendUrl` from
    # the ring notification extras). Prefer the URL the mobile caller sends (it
    # knows the correct device-reachable public host); only fall back to the
    # request host (which behind the ingress may be an internal cluster domain).
    backend_url = (payload.backend_url or "").strip().rstrip("/")
    if not backend_url:
        backend_url = str(request.base_url).rstrip("/")
    if backend_url.startswith("http://"):
        backend_url = "https://" + backend_url[len("http://"):]
    push_data = {
        "title": display_name,
        "message": "Incoming video call" if payload.is_video else "Incoming call",
        "type": "call",
        "callId": call_id,
        "callerId": payload.caller_identity,
        "callerName": display_name,
        "displayName": display_name,
        # Caller's phone (E.164) → the callee's native notification resolves the
        # name THEY saved for this number (ContactsContract), instead of the
        # caller's account/Google name.
        "callerPhone": (payload.caller_phone or "").strip(),
        "conversationId": payload.conversation_id,
        "twilio_is_video": "1" if payload.is_video else "0",
        "twilio_caller_identity": payload.caller_identity,
        # Where the native receiver POSTs call-declined (it appends the API path).
        "backendUrl": backend_url,
        # NO twilio_room_name → the Notifee wake routes to /call/<conversationId>
        # (the WebRTC screen), not /twilio-call.
        "action_url": f"/call/{payload.conversation_id}",
        # Force the call ringtone channel (data-only → full-screen wake).
        "channel_id": "calls-v4-smilers_never_cry",
        "subtext": "Incoming call",
    }

    # iter-385: await the dispatch so we can return REAL delivery info to the
    # caller ("Reached their phone ✓"). The callee rings at the same instant
    # either way — awaiting only delays the HTTP RESPONSE (which the caller
    # doesn't block on), not the push itself.
    delivered = False
    token_count = 0
    try:
        stats = await send_push(
            recipients=payload.callee_identities,
            data=push_data,
            idempotency_key=f"twilio-call:{call_id}",
        )
        token_count = int(stats.get("token_count") or 0)
        delivered = int(stats.get("success_count") or 0) > 0
        logger.info(
            f"webrtc-ring pushed to {len(payload.callee_identities)} callees: "
            f"tokens={token_count} ok={stats.get('success_count')} "
            f"err={stats.get('error_count')} backendUrl={backend_url}"
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(f"webrtc-ring: push failed (non-fatal): {exc}")

    return {
        "scheduled": True,
        "conversation_id": payload.conversation_id,
        "call_id": call_id,
        "token_count": token_count,
        "delivered": delivered,
    }


# ============================================================
# Stream call — add participant (1:1 → conference on Stream SFU)
# ============================================================
#
# When EXPO_PUBLIC_USE_TWILIO=0 calls run on the Stream Video SDK. "Adding" a
# participant to a live Stream call = ringing the new person (FCM doorbell) and
# telling their device to JOIN THE SAME STREAM ROOM (`stream_room`) so Stream's
# SFU mixes everyone. Also persists the adder's number-visibility choice into
# the same `twilio_call_participants` collection the roster GET reads from, so
# the privacy-aware roster works identically to the legacy Twilio path.
class StreamAddParticipantRequest(BaseModel):
    stream_room: str = Field(..., min_length=1, max_length=160)
    adder_identity: str = Field(..., min_length=1, max_length=120)
    adder_display_name: Optional[str] = Field(None, max_length=120)
    adder_phone: Optional[str] = Field(None, max_length=40)
    callee_identity: str = Field(..., min_length=1, max_length=120)
    callee_display_name: Optional[str] = Field(None, max_length=120)
    callee_phone: Optional[str] = Field(None, max_length=40)
    hide_number: bool = Field(False, description="If true, other participants do NOT see the callee's phone number")
    is_video: bool = False
    # The DIRECT conversation between the adder and the callee — used to route
    # the callee's ring/answer deep-link (/call/<conversation_id>).
    conversation_id: str = Field(..., min_length=1, max_length=128)
    backend_url: Optional[str] = None


@api_router.post("/calls/add-participant")
async def stream_add_participant(payload: StreamAddParticipantRequest, request: Request):
    # 1) Persist the privacy-aware roster entry (keyed by the STREAM room id so
    #    the existing /twilio/call-participants GET returns it). Also record the
    #    ADDER once so their own number can be shown/hidden consistently.
    now = datetime.now(timezone.utc)
    try:
        await db.twilio_call_participants.update_one(
            {"room_name": payload.stream_room, "identity": payload.callee_identity},
            {
                "$set": {
                    "room_name": payload.stream_room,
                    "identity": payload.callee_identity,
                    "display_name": payload.callee_display_name,
                    "phone_number": payload.callee_phone,
                    "hide_number": bool(payload.hide_number),
                    "added_by": payload.adder_identity,
                    "call_role": "added",
                    # A freshly-(re)rung participant starts as 'pending'. Their
                    # device reports 'joined' once connected, or 'left' on
                    # hangup. `rang_at` restarts the callee's missed-call timer
                    # on every (re)dial so a redial clears a stale "Missed" tag.
                    "status": "pending",
                    "rang_at": now,
                    "updated_at": now,
                },
                "$setOnInsert": {"created_at": now},
            },
            upsert=True,
        )
        # Ensure the adder appears in the roster too (number visible to self).
        await db.twilio_call_participants.update_one(
            {"room_name": payload.stream_room, "identity": payload.adder_identity},
            {
                "$set": {
                    "room_name": payload.stream_room,
                    "identity": payload.adder_identity,
                    "display_name": payload.adder_display_name,
                    "phone_number": payload.adder_phone,
                    "hide_number": False,
                    "added_by": payload.adder_identity,
                    "status": "joined",
                    "updated_at": now,
                },
                "$setOnInsert": {"created_at": now},
            },
            upsert=True,
        )
    except Exception:
        logger.warning("stream-add-participant: persisting roster entry failed (non-fatal)")

    # 2) Ring the callee into the SAME Stream room via the FCM doorbell. The
    #    `stream_room` + a streamRoom query param on action_url tell the callee's
    #    device to join room R instead of creating a conversation-keyed room.
    backend_url = (payload.backend_url or "").strip().rstrip("/")
    if not backend_url:
        backend_url = str(request.base_url).rstrip("/")
    if backend_url.startswith("http://"):
        backend_url = "https://" + backend_url[len("http://"):]

    display_name = payload.adder_display_name or "Smilers User"
    call_id = f"add_{payload.stream_room}_{int(now.timestamp())}"
    push_data = {
        "title": display_name,
        "message": "Adding you to a video call" if payload.is_video else "Adding you to a call",
        "type": "call",
        "callId": call_id,
        "callerId": payload.adder_identity,
        "callerName": display_name,
        "displayName": display_name,
        "callerPhone": (payload.adder_phone or "").strip(),
        "conversationId": payload.conversation_id,
        "twilio_is_video": "1" if payload.is_video else "0",
        "twilio_caller_identity": payload.adder_identity,
        # Stream room to JOIN — read by the mobile call screen + push handler.
        "stream_room": payload.stream_room,
        "backendUrl": backend_url,
        # answer=1 → the added callee auto-joins room R on tap (they already
        # tapped the ring to accept). streamRoom threads the shared room through.
        "action_url": (
            f"/call/{payload.conversation_id}"
            f"?streamRoom={payload.stream_room}&answer=1"
            f"&type={'video' if payload.is_video else 'voice'}"
            f"&displayName={display_name}"
        ),
        "channel_id": "calls-v4-smilers_never_cry",
        "subtext": "Incoming call",
    }

    async def _dispatch():
        try:
            await send_push(
                recipients=[payload.callee_identity],
                data=push_data,
                idempotency_key=f"stream-add:{payload.stream_room}:{payload.callee_identity}",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"stream-add-participant: push failed (non-fatal): {exc}")

    asyncio.create_task(_dispatch())
    return {"ok": True, "stream_room": payload.stream_room, "call_id": call_id}




# ============================================================
# Twilio Multiparty — add participant + privacy-aware roster
# ============================================================

class TwilioAddParticipantRequest(BaseModel):
    """
    Invite an additional participant into an ONGOING Twilio room.

    Twilio Group Rooms mix all participants server-side, so "adding" is
    simply ringing the new person into the same room. The adder also
    decides — per a regulatory requirement — whether the new participant's
    phone number is visible to the OTHER participants (`hide_number`).
    """
    room_name: str = Field(..., min_length=1, max_length=128)
    adder_identity: str = Field(..., min_length=1, max_length=120)
    adder_display_name: Optional[str] = Field(None, max_length=120)
    callee_identity: str = Field(..., min_length=1, max_length=120)
    callee_display_name: Optional[str] = Field(None, max_length=120)
    callee_phone: Optional[str] = Field(None, max_length=40)
    hide_number: bool = Field(False, description="If true, other participants do NOT see the callee's phone number")
    is_video: bool = True
    conversation_id: Optional[str] = Field(None, max_length=128)


@api_router.post("/twilio/add-participant")
async def twilio_add_participant(payload: TwilioAddParticipantRequest):
    """
    Ring a new participant into an existing room + persist their roster
    entry (with the adder's number-visibility choice). The callee receives
    the same call push as a fresh invite, but pointed at the live room so
    Twilio's SFU connects them to everyone already in the call.
    """
    rest = _get_twilio_rest()
    if rest is None:
        raise HTTPException(status_code=503, detail="Twilio not configured")

    room_name = payload.room_name
    room_sid: Optional[str] = None
    try:
        existing = rest.video.v1.rooms.list(unique_name=room_name, status="in-progress", limit=1)
        if existing:
            room_sid = existing[0].sid
    except TwilioRestException:
        logger.warning("twilio-add-participant: room lookup failed (non-fatal)")

    # Persist roster entry (privacy-aware). Upsert so re-adding updates it.
    try:
        await db.twilio_call_participants.update_one(
            {"room_name": room_name, "identity": payload.callee_identity},
            {
                "$set": {
                    "room_name": room_name,
                    "identity": payload.callee_identity,
                    "display_name": payload.callee_display_name,
                    "phone_number": payload.callee_phone,
                    "hide_number": bool(payload.hide_number),
                    "added_by": payload.adder_identity,
                    "updated_at": datetime.now(timezone.utc),
                },
                "$setOnInsert": {"created_at": datetime.now(timezone.utc)},
            },
            upsert=True,
        )
    except Exception:
        logger.warning("twilio-add-participant: persisting roster entry failed (non-fatal)")

    # Ring the new participant into the live room.
    push_stats: dict = {"token_count": 0, "success_count": 0, "error_count": 0, "errors": [], "pruned_count": 0}
    display_name = payload.adder_display_name or payload.adder_identity
    try:
        push_data = {
            "title": display_name,
            "message": ("Adding you to a video call" if payload.is_video else "Adding you to a call"),
            "type": "call",
            "callId": room_sid or room_name,
            "conversationId": payload.conversation_id or room_name,
            "twilio_room_name": room_name,
            "twilio_room_sid": room_sid or "",
            "twilio_is_video": "1" if payload.is_video else "0",
            "twilio_caller_identity": payload.adder_identity,
            "displayName": display_name,
            "action_url": (
                f"/call/twilio-{room_name}?room={room_name}&isCaller=0&isVideo="
                f"{'1' if payload.is_video else '0'}&title={display_name}"
            ),
            "subtext": "Incoming call",
        }
        push_stats = await send_push(
            recipients=[payload.callee_identity],
            data=push_data,
            idempotency_key=f"twilio-add:{room_name}:{payload.callee_identity}",
        )
    except Exception as exc:
        logger.exception(f"twilio-add-participant: push failed (non-fatal): {exc}")

    return {
        "ok": True,
        "room_name": room_name,
        "room_sid": room_sid,
        "push_stats": push_stats,
        "server_time": datetime.now(timezone.utc).isoformat(),
    }


@api_router.get("/twilio/call-participants")
async def twilio_call_participants(room_name: str, viewer: str = ""):
    """
    Return the privacy-aware roster for a room. A participant's phone
    number is returned ONLY when either the participant did not opt to
    hide it, OR the viewer is the person who added them (or themselves).
    Other participants receive `phone_number: null` for hidden entries.
    """
    try:
        docs = await db.twilio_call_participants.find({"room_name": room_name}).to_list(500)
    except Exception:
        docs = []
    participants = []
    for d in docs:
        hide = bool(d.get("hide_number"))
        added_by = d.get("added_by")
        identity = d.get("identity")
        phone = d.get("phone_number")
        can_see_phone = (not hide) or (bool(viewer) and (viewer == added_by or viewer == identity))
        rang_at = d.get("rang_at") or d.get("updated_at")
        participants.append(
            {
                "identity": identity,
                "display_name": d.get("display_name"),
                "phone_number": phone if can_see_phone else None,
                "hide_number": hide,
                "added_by": added_by,
                "status": d.get("status") or "joined",
                "call_role": d.get("call_role") or "added",
                # ISO timestamp of the most recent ring — the client derives a
                # "Missed" tag from this when a 'pending' entry goes unanswered.
                "rang_at": rang_at.isoformat() if hasattr(rang_at, "isoformat") else rang_at,
            }
        )
    return {"participants": participants}


class TwilioRemoveParticipantRequest(BaseModel):
    """Host-only: forcibly disconnect a participant from the room."""
    room_name: str = Field(..., min_length=1, max_length=128)
    identity: str = Field(..., min_length=1, max_length=120)
    requester_identity: Optional[str] = Field(None, max_length=120)


@api_router.post("/twilio/remove-participant")
async def twilio_remove_participant(payload: TwilioRemoveParticipantRequest):
    """
    Disconnect a participant from the live Twilio room (server-enforced via
    the REST API) and drop their roster entry. Intended for the call host.
    """
    rest = _get_twilio_rest()
    if rest is None:
        raise HTTPException(status_code=503, detail="Twilio not configured")

    room_name = payload.room_name
    disconnected = False
    try:
        rooms = rest.video.v1.rooms.list(unique_name=room_name, status="in-progress", limit=1)
        if rooms:
            room_sid = rooms[0].sid
            participants = rest.video.v1.rooms(room_sid).participants.list(status="connected")
            for p in participants:
                if p.identity == payload.identity:
                    rest.video.v1.rooms(room_sid).participants(p.sid).update(status="disconnected")
                    disconnected = True
    except TwilioRestException as exc:
        logger.warning(f"twilio-remove-participant: REST error (non-fatal): {exc}")

    try:
        await db.twilio_call_participants.delete_one(
            {"room_name": room_name, "identity": payload.identity}
        )
    except Exception:
        logger.warning("twilio-remove-participant: roster delete failed (non-fatal)")

    return {"ok": True, "disconnected": disconnected}


class StreamRemoveParticipantRequest(BaseModel):
    """Remove a participant from a live Stream call. ONLY the person who ADDED
    that participant may remove them (enforced against the roster's `added_by`)."""
    stream_room: str = Field(..., min_length=1, max_length=160)
    identity: str = Field(..., min_length=1, max_length=120)
    requester_identity: str = Field(..., min_length=1, max_length=120)
    backend_url: Optional[str] = None


@api_router.post("/calls/remove-participant")
async def stream_remove_participant(payload: StreamRemoveParticipantRequest, request: Request):
    entry = await db.twilio_call_participants.find_one(
        {"room_name": payload.stream_room, "identity": payload.identity}
    )
    added_by = (entry or {}).get("added_by")
    # Authorization: only the adder can remove the person they added. (A user
    # can always be removed by whoever added them; nobody else can.)
    if not entry or added_by != payload.requester_identity:
        raise HTTPException(
            status_code=403,
            detail="Only the person who added this participant can remove them",
        )

    try:
        await db.twilio_call_participants.delete_one(
            {"room_name": payload.stream_room, "identity": payload.identity}
        )
    except Exception:
        logger.warning("stream-remove-participant: roster delete failed (non-fatal)")

    # Tell the removed participant's device to LEAVE the Stream room. Sent as a
    # silent control signal (type=call-removed) — no banner; the app ends the
    # matching active call.
    backend_url = (payload.backend_url or "").strip().rstrip("/")
    if not backend_url:
        backend_url = str(request.base_url).rstrip("/")
    if backend_url.startswith("http://"):
        backend_url = "https://" + backend_url[len("http://"):]

    push_data = {
        "title": "Call",
        "message": "You were removed from the call",
        "type": "call-removed",
        "stream_room": payload.stream_room,
        "backendUrl": backend_url,
    }

    async def _dispatch():
        try:
            await send_push(
                recipients=[payload.identity],
                data=push_data,
                idempotency_key=f"stream-remove:{payload.stream_room}:{payload.identity}",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"stream-remove-participant: push failed (non-fatal): {exc}")

    asyncio.create_task(_dispatch())
    return {"ok": True}


# ============================================================
# Group call orchestration (Phase 2)
# ============================================================
# A group call rings ALL current group members at once (tap-to-join/decline)
# and tracks each member's status (pending → joined/declined) in the SAME
# `twilio_call_participants` roster (keyed by the shared Stream room). The
# in-call roster UI reads status from the /twilio/call-participants GET.

def _normalize_backend_url(payload_url: Optional[str], request: Request) -> str:
    backend_url = (payload_url or "").strip().rstrip("/")
    if not backend_url:
        backend_url = str(request.base_url).rstrip("/")
    if backend_url.startswith("http://"):
        backend_url = "https://" + backend_url[len("http://"):]
    return backend_url


class GroupMemberRingItem(BaseModel):
    identity: str = Field(..., min_length=1, max_length=120)
    display_name: Optional[str] = Field(None, max_length=160)
    phone: Optional[str] = Field(None, max_length=40)


class GroupRingRequest(BaseModel):
    stream_room: str = Field(..., min_length=1, max_length=160)
    conversation_id: str = Field(..., min_length=1, max_length=128)
    caller_identity: str = Field(..., min_length=1, max_length=120)
    caller_display_name: Optional[str] = Field(None, max_length=160)
    caller_phone: Optional[str] = Field(None, max_length=40)
    conversation_name: Optional[str] = Field(None, max_length=160)
    members: List[GroupMemberRingItem] = Field(default_factory=list)
    is_video: bool = False
    backend_url: Optional[str] = None


async def _upsert_roster_entry(room: str, identity: str, **fields) -> None:
    now = datetime.now(timezone.utc)
    try:
        await db.twilio_call_participants.update_one(
            {"room_name": room, "identity": identity},
            {"$set": {"room_name": room, "identity": identity, "updated_at": now, **fields},
             "$setOnInsert": {"created_at": now}},
            upsert=True,
        )
    except Exception:
        logger.warning("group-call: roster upsert failed (non-fatal)")


def _group_ring_push(*, conversation_id: str, stream_room: str, display_name: str,
                     caller_identity: str, caller_phone: str, is_video: bool,
                     conversation_name: str, call_id: str, backend_url: str) -> dict:
    return {
        "title": conversation_name or display_name,
        "message": f"{display_name} is calling the group" if conversation_name else "Incoming group call",
        "type": "call",
        "callId": call_id,
        "callerId": caller_identity,
        "callerName": display_name,
        "displayName": conversation_name or display_name,
        "callerPhone": (caller_phone or "").strip(),
        "conversationId": conversation_id,
        "conversationType": "group",
        "conversationName": conversation_name or "",
        "twilio_is_video": "1" if is_video else "0",
        "twilio_caller_identity": caller_identity,
        # Everyone joins the SAME Stream room; no answer=1 → show the incoming
        # tap-to-join/decline UI (not auto-answer).
        "stream_room": stream_room,
        "backendUrl": backend_url,
        "action_url": (
            f"/call/{conversation_id}"
            f"?streamRoom={stream_room}"
            f"&type={'video' if is_video else 'voice'}"
            f"&group=1"
            f"&displayName={conversation_name or display_name}"
        ),
        "channel_id": "calls-v4-smilers_never_cry",
        "subtext": "Incoming group call",
    }


@api_router.post("/calls/group-ring")
async def group_ring(payload: GroupRingRequest, request: Request):
    now = datetime.now(timezone.utc)
    backend_url = _normalize_backend_url(payload.backend_url, request)
    # Fresh call = fresh roster. This room id is DETERMINISTIC per conversation
    # (smilers_conv_<id>), so a previous call's roster (added people, left/missed
    # entries) would otherwise leak into this new call and wrongly offer redial.
    # Wipe any stale roster for this room before seeding the current call.
    try:
        await db.twilio_call_participants.delete_many({"room_name": payload.stream_room})
    except Exception:
        logger.warning("group-ring: stale roster clear failed (non-fatal)")
    # Caller is already in → joined.
    await _upsert_roster_entry(
        payload.stream_room, payload.caller_identity,
        display_name=payload.caller_display_name, phone_number=payload.caller_phone,
        hide_number=False, added_by=payload.caller_identity,
        status="joined", call_role="member",
    )
    ring_targets: List[str] = []
    for m in payload.members:
        if not m.identity or m.identity == payload.caller_identity:
            continue
        await _upsert_roster_entry(
            payload.stream_room, m.identity,
            display_name=m.display_name, phone_number=m.phone,
            hide_number=False, added_by=payload.caller_identity,
            status="pending", call_role="member",
        )
        ring_targets.append(m.identity)

    display_name = payload.caller_display_name or "Smilers User"
    call_id = f"group_{payload.stream_room}_{int(now.timestamp())}"
    # Persist lightweight call metadata so the "ongoing group call" banner can be
    # driven from the SERVER (works even when the ring push arrives while the app
    # is foregrounded, which the local push-recorder misses).
    try:
        await db.group_call_meta.update_one(
            {"room_name": payload.stream_room},
            {"$set": {
                "room_name": payload.stream_room,
                "conversation_id": payload.conversation_id,
                "group_name": payload.conversation_name or "",
                "is_video": bool(payload.is_video),
                "call_id": call_id,
                "created_at": now,
            }},
            upsert=True,
        )
    except Exception:
        logger.warning("group-ring: meta upsert failed (non-fatal)")
    push_data = _group_ring_push(
        conversation_id=payload.conversation_id, stream_room=payload.stream_room,
        display_name=display_name, caller_identity=payload.caller_identity,
        caller_phone=payload.caller_phone or "", is_video=payload.is_video,
        conversation_name=payload.conversation_name or "", call_id=call_id,
        backend_url=backend_url,
    )
    delivered = 0
    token_count = 0
    if ring_targets:
        try:
            stats = await send_push(
                recipients=ring_targets, data=push_data,
                idempotency_key=f"group-call:{call_id}",
            )
            token_count = int(stats.get("token_count") or 0)
            delivered = int(stats.get("success_count") or 0)
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"group-ring: push failed (non-fatal): {exc}")
    return {"ok": True, "call_id": call_id, "rang": len(ring_targets),
            "token_count": token_count, "delivered": delivered}


class ResetRosterRequest(BaseModel):
    stream_room: str = Field(..., min_length=1, max_length=160)


@api_router.post("/calls/reset-roster")
async def reset_roster(payload: ResetRosterRequest):
    """Wipe the participant roster for a room so each NEW call starts fresh.

    The Stream room id is DETERMINISTIC per conversation (smilers_conv_<id>), so
    without this a previous call's roster (added people, left/missed entries)
    leaks into the next call in the same conversation and wrongly offers a
    "redial" for people who were never part of the new call. The caller invokes
    this the moment a fresh 1:1 call begins (group calls clear inside group-ring).
    Idempotent and safe: an empty room is the correct starting state."""
    try:
        res = await db.twilio_call_participants.delete_many({"room_name": payload.stream_room})
        return {"ok": True, "cleared": int(getattr(res, "deleted_count", 0) or 0)}
    except Exception:
        logger.warning("reset-roster: clear failed (non-fatal)")
        return {"ok": False, "cleared": 0}


@api_router.get("/calls/active-group-calls")
async def active_group_calls(identity: str):
    """Live group calls this user was rung into but hasn't joined yet.

    Drives the "Ongoing group call — tap to join" banner reliably from the
    server (independent of whether the ring push was recorded on-device). A call
    is 'live' while at least one participant is 'joined'; we surface it to a user
    whose own roster entry exists and is NOT joined/left (i.e. they missed or
    declined). Auto-limited to calls started in the last 2 hours."""
    identity = (identity or "").strip()
    if not identity:
        return {"calls": []}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    out: List[dict] = []
    try:
        metas = await db.group_call_meta.find({"created_at": {"$gte": cutoff}}).to_list(length=50)
        for meta in metas:
            room = meta.get("room_name")
            if not room:
                continue
            roster = await db.twilio_call_participants.find({"room_name": room}).to_list(length=100)
            anyone_joined = any((r.get("status") == "joined") for r in roster)
            mine = next((r for r in roster if r.get("identity") == identity), None)
            if not anyone_joined or not mine:
                continue
            # Show the banner whenever the user is NOT currently in the call.
            # This includes missed/declined/pending AND joined-then-left, so the
            # banner reappears if they drop out of a still-live call. Only a
            # client-side "Can't join" dismiss (or the call ending) hides it.
            if mine.get("status") == "joined":
                continue
            out.append({
                "callId": meta.get("call_id") or f"group_{room}",
                "room": room,
                "conversationId": meta.get("conversation_id") or "",
                "groupName": meta.get("group_name") or "",
                "isVideo": bool(meta.get("is_video")),
            })
    except Exception:
        logger.warning("active-group-calls: query failed (non-fatal)")
        return {"calls": []}
    return {"calls": out}




class GroupAgainRequest(BaseModel):
    stream_room: str = Field(..., min_length=1, max_length=160)
    conversation_id: str = Field(..., min_length=1, max_length=128)
    caller_identity: str = Field(..., min_length=1, max_length=120)
    caller_display_name: Optional[str] = Field(None, max_length=160)
    caller_phone: Optional[str] = Field(None, max_length=40)
    conversation_name: Optional[str] = Field(None, max_length=160)
    is_video: bool = False
    backend_url: Optional[str] = None


@api_router.post("/calls/group-again")
async def group_again(payload: GroupAgainRequest, request: Request):
    """Re-ring ONLY the members who haven't joined (pending or declined)."""
    now = datetime.now(timezone.utc)
    backend_url = _normalize_backend_url(payload.backend_url, request)
    try:
        docs = await db.twilio_call_participants.find(
            {"room_name": payload.stream_room, "status": {"$in": ["pending", "declined"]}}
        ).to_list(500)
    except Exception:
        docs = []
    targets: List[str] = []
    for d in docs:
        ident = d.get("identity")
        if not ident or ident == payload.caller_identity:
            continue
        await _upsert_roster_entry(payload.stream_room, ident, status="pending")
        targets.append(ident)
    if not targets:
        return {"ok": True, "rerang": 0}
    display_name = payload.caller_display_name or "Smilers User"
    call_id = f"groupagain_{payload.stream_room}_{int(now.timestamp())}"
    push_data = _group_ring_push(
        conversation_id=payload.conversation_id, stream_room=payload.stream_room,
        display_name=display_name, caller_identity=payload.caller_identity,
        caller_phone=payload.caller_phone or "", is_video=payload.is_video,
        conversation_name=payload.conversation_name or "", call_id=call_id,
        backend_url=backend_url,
    )
    try:
        await send_push(recipients=targets, data=push_data,
                        idempotency_key=f"group-again:{call_id}")
    except Exception as exc:  # noqa: BLE001
        logger.exception(f"group-again: push failed (non-fatal): {exc}")
    return {"ok": True, "rerang": len(targets)}


class ParticipantStatusRequest(BaseModel):
    stream_room: str = Field(..., min_length=1, max_length=160)
    identity: str = Field(..., min_length=1, max_length=120)
    status: str = Field(..., pattern="^(joined|declined|pending|left|missed)$")
    display_name: Optional[str] = Field(None, max_length=160)


@api_router.post("/calls/participant-status")
async def participant_status(payload: ParticipantStatusRequest):
    """A member's device reports its own status (joined/declined) so every
    participant's roster shows accurate Joined/Declined/Pending badges."""
    fields = {"status": payload.status}
    if payload.display_name:
        fields["display_name"] = payload.display_name
    await _upsert_roster_entry(payload.stream_room, payload.identity, **fields)
    return {"ok": True}


class CallAddRequestRequest(BaseModel):
    """Non-admin requests an admin's approval to add a non-member to the call."""
    stream_room: str = Field(..., min_length=1, max_length=160)
    conversation_id: str = Field(..., min_length=1, max_length=128)
    requester_identity: str = Field(..., min_length=1, max_length=120)
    requester_name: Optional[str] = Field(None, max_length=160)
    target_identity: str = Field(..., min_length=1, max_length=120)
    target_name: Optional[str] = Field(None, max_length=160)
    target_phone: Optional[str] = Field(None, max_length=40)
    admin_identities: List[str] = Field(default_factory=list)
    is_video: bool = False
    add_permanently: bool = False
    backend_url: Optional[str] = None


@api_router.post("/calls/request-add")
async def call_request_add(payload: CallAddRequestRequest, request: Request):
    """Silent control push to every admin: '{requester} wants to add {target}'.
    Admins approve in-call (→ /calls/add-participant) or decline."""
    if not payload.admin_identities:
        return {"ok": False, "reason": "no-admins"}
    backend_url = _normalize_backend_url(payload.backend_url, request)
    push_data = {
        "title": "Call request",
        "message": f"{payload.requester_name or 'A member'} wants to add someone",
        "type": "call-add-request",
        "stream_room": payload.stream_room,
        "conversationId": payload.conversation_id,
        "requester_identity": payload.requester_identity,
        "requester_name": payload.requester_name or "",
        "target_identity": payload.target_identity,
        "target_name": payload.target_name or "",
        "target_phone": payload.target_phone or "",
        "add_permanently": "1" if payload.add_permanently else "0",
        "twilio_is_video": "1" if payload.is_video else "0",
        "backendUrl": backend_url,
    }

    async def _dispatch():
        try:
            await send_push(
                recipients=payload.admin_identities, data=push_data,
                idempotency_key=f"call-add-req:{payload.stream_room}:{payload.target_identity}:{int(datetime.now(timezone.utc).timestamp())}",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"call-request-add: push failed (non-fatal): {exc}")

    asyncio.create_task(_dispatch())
    return {"ok": True, "notified_admins": len(payload.admin_identities)}


class CallAddDeclinedRequest(BaseModel):
    requester_identity: str = Field(..., min_length=1, max_length=120)
    target_name: Optional[str] = Field(None, max_length=160)
    admin_name: Optional[str] = Field(None, max_length=160)


@api_router.post("/calls/request-add-declined")
async def call_request_add_declined(payload: CallAddDeclinedRequest):
    """Notify the requester that an admin declined their add-request (silent)."""
    push_data = {
        "title": "Call request",
        "message": f"An admin declined adding {payload.target_name or 'that person'}",
        "type": "call-add-declined",
        "target_name": payload.target_name or "",
    }

    async def _dispatch():
        try:
            await send_push(
                recipients=[payload.requester_identity], data=push_data,
                idempotency_key=f"call-add-decl:{payload.requester_identity}:{int(datetime.now(timezone.utc).timestamp())}",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"call-request-add-declined: push failed (non-fatal): {exc}")

    asyncio.create_task(_dispatch())
    return {"ok": True}


class AdminKickRequest(BaseModel):
    """Admin removes a member from the live group call. The app asserts admin
    status (verified against the Convex group `admins` list before calling)."""
    stream_room: str = Field(..., min_length=1, max_length=160)
    identity: str = Field(..., min_length=1, max_length=120)
    requester_identity: str = Field(..., min_length=1, max_length=120)
    backend_url: Optional[str] = None


@api_router.post("/calls/admin-kick")
async def admin_kick(payload: AdminKickRequest, request: Request):
    """Admin-only kick from a group call. Drops the roster entry and signals the
    kicked device to leave (silent type=call-removed). Admin authority is
    established by the app (Convex `admins`) — this endpoint trusts that gate,
    mirroring how add-participant trusts the client's privacy choice."""
    backend_url = _normalize_backend_url(payload.backend_url, request)
    try:
        await db.twilio_call_participants.delete_one(
            {"room_name": payload.stream_room, "identity": payload.identity}
        )
    except Exception:
        logger.warning("admin-kick: roster delete failed (non-fatal)")
    push_data = {
        "title": "Call",
        "message": "You were removed from the call",
        "type": "call-removed",
        "stream_room": payload.stream_room,
        "backendUrl": backend_url,
    }

    async def _dispatch():
        try:
            await send_push(
                recipients=[payload.identity], data=push_data,
                idempotency_key=f"admin-kick:{payload.stream_room}:{payload.identity}",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"admin-kick: push failed (non-fatal): {exc}")

    asyncio.create_task(_dispatch())
    return {"ok": True}


# ============================================================
# Study Materials — Bible & Quran reader (free, public-domain sources)
# ============================================================
# Bible: getbible.net v2 (public-domain translations, no key).
# Quran: alquran.cloud v1 (no key).
# Thin caching proxy so the mobile app avoids CORS and upstream hiccups.
# Copyrighted versions (ESV/NIV/NKJV) are intentionally NOT here — they require
# a licensed key (API.Bible) and will be added later.

_SCRIPTURE_CACHE: dict[str, tuple[float, dict]] = {}
_SCRIPTURE_TTL = 60 * 60 * 24  # 24h — scripture text never changes


async def _scripture_get(url: str) -> dict:
    now = time.time()
    hit = _SCRIPTURE_CACHE.get(url)
    if hit and (now - hit[0]) < _SCRIPTURE_TTL:
        return hit[1]
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as http:
        resp = await http.get(url)
        resp.raise_for_status()
        data = resp.json()
    if len(_SCRIPTURE_CACHE) > 500:
        _SCRIPTURE_CACHE.pop(next(iter(_SCRIPTURE_CACHE)))
    _SCRIPTURE_CACHE[url] = (now, data)
    return data


@api_router.get("/bible/chapter")
async def bible_chapter(translation: str, book: int, chapter: int):
    """Return a normalized Bible chapter: {book_name, chapter, verses:[{verse,text}]}.
    `translation` is a getbible.net id (e.g. kjv, ls1910, valera, riveduta,
    schlachter, almeida). `book` is 1..66 (Genesis..Revelation)."""
    tr = "".join(ch for ch in translation.lower() if ch.isalnum())
    if not tr or not (1 <= book <= 66) or not (1 <= chapter <= 150):
        raise HTTPException(status_code=400, detail="invalid translation/book/chapter")
    try:
        data = await _scripture_get(f"https://api.getbible.net/v2/{tr}/{book}/{chapter}.json")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not load this passage. Try another version.")
    verses = [
        {"verse": int(v.get("verse", 0)), "text": str(v.get("text", "")).strip()}
        for v in (data.get("verses") or [])
    ]
    return {
        "book_name": data.get("book_name"),
        "chapter": chapter,
        "translation": tr,
        "verses": verses,
    }


@api_router.get("/quran/surahs")
async def quran_surahs():
    """List all 114 surahs (number, names, ayah count)."""
    try:
        data = await _scripture_get("https://api.alquran.cloud/v1/surah")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not load the surah list.")
    out = [
        {
            "number": s.get("number"),
            "name": s.get("name"),
            "englishName": s.get("englishName"),
            "englishNameTranslation": s.get("englishNameTranslation"),
            "numberOfAyahs": s.get("numberOfAyahs"),
        }
        for s in (data.get("data") or [])
    ]
    return {"surahs": out}


@api_router.get("/quran/surah")
async def quran_surah(number: int, edition: str = "en.sahih", with_arabic: bool = True):
    """Return a surah's ayahs in the requested translation edition, optionally
    paired with the Arabic (quran-uthmani). Editions: en.sahih, fr.hamidullah,
    es.cortes, it.piccardo, de.aburida, pt.elhayek, quran-uthmani."""
    ed = "".join(ch for ch in edition if ch.isalnum() or ch in ".-")
    if not (1 <= number <= 114) or not ed:
        raise HTTPException(status_code=400, detail="invalid surah/edition")
    editions = f"quran-uthmani,{ed}" if (with_arabic and ed != "quran-uthmani") else ed
    try:
        data = await _scripture_get(f"https://api.alquran.cloud/v1/surah/{number}/editions/{editions}")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not load this surah.")
    blocks = data.get("data") or []
    if isinstance(blocks, dict):
        blocks = [blocks]
    arabic_map: dict[int, str] = {}
    trans_block = None
    name = None
    for b in blocks:
        edid = (b.get("edition") or {}).get("identifier")
        name = name or b.get("englishName")
        if edid == "quran-uthmani":
            for a in b.get("ayahs") or []:
                arabic_map[a.get("numberInSurah")] = a.get("text", "")
        else:
            trans_block = b
    src = trans_block or (blocks[0] if blocks else None)
    ayahs = []
    if src:
        for a in src.get("ayahs") or []:
            n = a.get("numberInSurah")
            ayahs.append(
                {"numberInSurah": n, "text": a.get("text", ""), "arabic": arabic_map.get(n, "")}
            )
    return {
        "number": number,
        "name": name,
        "edition": ed,
        "ayahs": ayahs,
    }




# ============================================================
# Twilio Recording (Phase A.4)
# ============================================================

@api_router.get("/twilio/recordings")
async def twilio_list_recordings(room_sid: Optional[str] = None, limit: int = 50):
    """
    List Twilio recordings, optionally filtered by room SID. Used by the
    mobile "My Recordings" screen to enumerate post-call recordings.
    Recordings are produced automatically when a room was created with
    record=True in /api/twilio/initiate-call.
    """
    rest = _get_twilio_rest()
    if rest is None:
        raise HTTPException(status_code=503, detail="Twilio not configured")
    safe_limit = max(1, min(limit, 100))
    try:
        if room_sid:
            recs = rest.video.v1.recordings.list(grouping_sid=[room_sid], limit=safe_limit)
        else:
            recs = rest.video.v1.recordings.list(limit=safe_limit)
        items = [
            {
                "sid": r.sid,
                "room_sid": getattr(r, "grouping_sids", {}).get("room_sid"),
                "participant_sid": getattr(r, "grouping_sids", {}).get("participant_sid"),
                "type": r.type,  # audio / video / data
                "status": r.status,  # processing / completed / failed
                "duration": r.duration,
                "size": r.size,
                "container_format": r.container_format,
                "codec": r.codec,
                "date_created": r.date_created.isoformat() if r.date_created else None,
            }
            for r in recs
        ]
        return {"items": items, "count": len(items)}
    except TwilioRestException as exc:
        raise HTTPException(status_code=502, detail=f"Twilio list failed: {exc.msg}")


class TwilioEndCallRequest(BaseModel):
    """Force-complete a Twilio Video room so the call ends for everyone."""
    room_name: Optional[str] = Field(None, max_length=128)
    room_sid: Optional[str] = Field(None, max_length=64)


class TwilioEndCallResponse(BaseModel):
    room_sid: Optional[str]
    room_name: Optional[str]
    status: str
    already_completed: bool
    server_time: str


@api_router.post("/twilio/end-call", response_model=TwilioEndCallResponse)
async def twilio_end_call(payload: TwilioEndCallRequest):
    """
    Force-complete a Twilio Video room so the call ends for ALL
    participants. Twilio does NOT auto-disconnect remaining participants
    when one leaves — so without this, the other side keeps ringing or
    stays connected after the first party hangs up / declines.

    Idempotent: completing an already-completed (or non-existent) room is
    treated as success so the client never sees a spurious error on
    hangup races (both sides may call this near-simultaneously).
    """
    rest = _get_twilio_rest()
    if rest is None:
        raise HTTPException(status_code=503, detail="Twilio not configured")
    if not (payload.room_sid or payload.room_name):
        raise HTTPException(status_code=400, detail="room_sid or room_name required")

    now_iso = datetime.now(timezone.utc).isoformat()
    target_sid = payload.room_sid

    # Resolve unique_name → SID for the in-progress room when no SID given.
    if not target_sid and payload.room_name:
        try:
            existing = rest.video.v1.rooms.list(
                unique_name=payload.room_name, status="in-progress", limit=1
            )
            if existing:
                target_sid = existing[0].sid
        except TwilioRestException as exc:
            logger.warning(f"twilio-end-call lookup failed: {exc.msg}")

    if not target_sid:
        # No in-progress room to complete — already ended or never started.
        return TwilioEndCallResponse(
            room_sid=None,
            room_name=payload.room_name,
            status="completed",
            already_completed=True,
            server_time=now_iso,
        )

    try:
        room = rest.video.v1.rooms(target_sid).update(status="completed")
        new_status = room.status
    except TwilioRestException as exc:
        msg = (exc.msg or "").lower()
        # Already completed / not found → idempotent success.
        if "completed" in msg or getattr(exc, "status", None) == 404 or getattr(exc, "code", None) == 20404:
            return TwilioEndCallResponse(
                room_sid=target_sid,
                room_name=payload.room_name,
                status="completed",
                already_completed=True,
                server_time=now_iso,
            )
        logger.exception("twilio-end-call failed")
        raise HTTPException(status_code=502, detail=f"Twilio end-call failed: {exc.msg}")

    # Best-effort: mark our own call record completed.
    try:
        await db.twilio_calls.update_one(
            {"room_sid": target_sid},
            {"$set": {"status": "completed", "ended_at": datetime.now(timezone.utc)}},
        )
    except Exception:
        pass

    logger.info(f"twilio-end-call completed room_sid={target_sid} status={new_status}")
    return TwilioEndCallResponse(
        room_sid=target_sid,
        room_name=payload.room_name,
        status=new_status,
        already_completed=False,
        server_time=now_iso,
    )



@api_router.post("/twilio/status-callback")
async def twilio_status_callback(request: Request):
    """
    Webhook receiver for Twilio room/recording lifecycle events.
    Twilio sends form-urlencoded POSTs here when configured via the
    `status_callback` URL on the Room. Updates our twilio_calls record
    so call history reflects actual outcomes.
    """
    try:
        form = await request.form()
        data = {k: form.get(k) for k in form.keys()}
        event = data.get("StatusCallbackEvent") or data.get("RoomStatus") or "unknown"
        room_sid = data.get("RoomSid") or data.get("Sid")
        logger.info(f"twilio-status-callback event={event} room_sid={room_sid}")
        if room_sid:
            update: dict = {"last_event": event, "last_event_at": datetime.now(timezone.utc)}
            if event in ("room-ended", "completed"):
                update["status"] = "completed"
                update["ended_at"] = datetime.now(timezone.utc)
            try:
                await db.twilio_calls.update_one({"room_sid": room_sid}, {"$set": update})
            except Exception:
                pass
        return {"ok": True}
    except Exception as exc:
        logger.warning(f"twilio-status-callback parse failed: {exc}")
        return {"ok": False}


@api_router.get("/download/frontend-zip")
async def download_frontend_zip():
    """Serve the frontend source zip (created for the user's local EAS build
    when their network couldn't clone the full repository)."""
    from fastapi.responses import FileResponse
    zip_path = Path(__file__).parent / "downloads" / "smilers-frontend.zip"
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail="Zip not found")
    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename="smilers-frontend.zip",
    )


@api_router.get("/download/frontend-part/{idx}")
async def download_frontend_part(idx: str):
    """Serve a single ~4MB chunk of the frontend zip so a flaky connection can
    download (and retry) each part individually. Reassemble locally with:
        cat smilers-frontend.zip.part* > smilers-frontend.zip
    `idx` must be a two-digit part number, e.g. "00", "01", ... "05".
    """
    from fastapi.responses import FileResponse
    if not (len(idx) == 2 and idx.isdigit()):
        raise HTTPException(status_code=400, detail="Bad part index")
    name = f"smilers-frontend.zip.part{idx}"
    part_path = Path(__file__).parent / "downloads" / "parts" / name
    if not part_path.exists():
        raise HTTPException(status_code=404, detail="Part not found")
    return FileResponse(
        path=str(part_path),
        media_type="application/octet-stream",
        filename=name,
    )


@api_router.get("/download/anssi-dossier")
async def download_anssi_dossier():
    """Serve the ANSSI French encryption declaration technical dossier (Markdown)
    so the user can download it and attach it to their ANSSI filing."""
    from fastapi.responses import FileResponse
    doc_path = Path(__file__).parent / "downloads" / "ANSSI_ENCRYPTION_DECLARATION.md"
    if not doc_path.exists():
        raise HTTPException(status_code=404, detail="Dossier not found")
    return FileResponse(
        path=str(doc_path),
        media_type="text/markdown",
        filename="ANSSI_ENCRYPTION_DECLARATION.md",
    )


@api_router.get("/download/freelancer-handover")
async def download_freelancer_handover():
    """Serve the call-notifications handover document (Markdown) so it can be
    downloaded and attached/shared with the native freelancer."""
    from fastapi.responses import FileResponse
    doc_path = Path(__file__).parent / "downloads" / "Smilers-Call-Notifications-Handover.md"
    if not doc_path.exists():
        raise HTTPException(status_code=404, detail="Handover doc not found")
    return FileResponse(
        path=str(doc_path),
        media_type="text/markdown",
        filename="Smilers-Call-Notifications-Handover.md",
    )


@api_router.get("/download/server-py")
async def download_server_py():
    """Serve the CURRENT backend server.py so it can be downloaded and shared
    with the freelancer (reflects the live, deployed code — including the
    call-cancelled event)."""
    from fastapi.responses import FileResponse
    src_path = Path(__file__).resolve()
    if not src_path.exists():
        raise HTTPException(status_code=404, detail="server.py not found")
    return FileResponse(
        path=str(src_path),
        media_type="text/x-python",
        filename="server.py",
    )


# ── Generic per-IP rate limiting (in-process, best-effort per node) ───────
# Protects unauthenticated, cost-bearing endpoints (LLM translate/transcribe,
# Google Safe Browsing) from anonymous abuse. Not distributed — swap for a
# shared store (e.g. Redis) if the backend is scaled to multiple instances.
_RATE_STORES: dict[str, dict[str, list[float]]] = {}


def _client_ip_of(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit_ok(namespace: str, client_ip: str, max_hits: int, window_sec: int) -> tuple[bool, int]:
    """Returns (allowed, retry_after_seconds). retry_after is 0 when allowed."""
    import time, math
    now = time.time()
    cutoff = now - window_sec
    store = _RATE_STORES.setdefault(namespace, {})
    bucket = store.setdefault(client_ip, [])
    bucket[:] = [t for t in bucket if t > cutoff]  # prune old hits
    if len(bucket) >= max_hits:
        retry_after = max(1, int(math.ceil(bucket[0] + window_sec - now)))
        return False, retry_after
    bucket.append(now)
    if len(store) > 5000:  # opportunistic cleanup so the dict stays bounded
        for ip in list(store.keys()):
            hits = store.get(ip)
            if not hits or hits[-1] < cutoff:
                store.pop(ip, None)
    return True, 0


# Optional distributed backend: when REDIS_URL is set, rate limits are shared
# across all backend replicas (fixed-window counter). If Redis is unset or
# unreachable, we transparently fall back to the in-memory limiter above so a
# single node keeps working and a Redis blip never blocks traffic.
_REDIS_URL = os.environ.get("REDIS_URL", "").strip()
_redis_client = None
_redis_disabled = False


def _get_rate_redis():
    global _redis_client, _redis_disabled
    if not _REDIS_URL or _redis_disabled:
        return None
    if _redis_client is None:
        try:
            import redis.asyncio as aioredis
            _redis_client = aioredis.from_url(
                _REDIS_URL, socket_connect_timeout=2, socket_timeout=2
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"rate-limit: Redis init failed, using in-memory: {e}")
            _redis_disabled = True
            return None
    return _redis_client


async def _rate_limit_ok_async(namespace: str, client_ip: str, max_hits: int, window_sec: int) -> tuple[bool, int]:
    """Returns (allowed, retry_after_seconds). retry_after is 0 when allowed."""
    r = _get_rate_redis()
    if r is not None:
        try:
            import time
            window = int(time.time() // window_sec)
            key = f"rl:{namespace}:{client_ip}:{window}"
            pipe = r.pipeline()
            pipe.incr(key, 1)
            pipe.expire(key, window_sec)
            count, _ = await pipe.execute()
            if int(count) <= max_hits:
                return True, 0
            retry_after = window_sec - (int(time.time()) % window_sec)
            return False, max(1, retry_after)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"rate-limit: Redis error, falling back to in-memory: {e}")
            # fall through to in-memory below
    return _rate_limit_ok(namespace, client_ip, max_hits, window_sec)


@api_router.post("/translate", response_model=TranslationResponse)
async def translate_text(payload: TranslationRequest, request: Request):
    _ok, _retry = await _rate_limit_ok_async("translate", _client_ip_of(request), 60, 60)
    if not _ok:
        raise HTTPException(status_code=429, detail="Too many translation requests; please slow down.", headers={"Retry-After": str(_retry)})
    text = (payload.text or "").strip()
    target_language = (payload.target_language or "").strip()
    skip_languages = [item.strip() for item in payload.skip_languages if isinstance(item, str) and item.strip()]

    if not text or not target_language:
        return TranslationResponse(translated_text=text)

    api_key = os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Missing EMERGENT_LLM_KEY")

    cache_key = f"{target_language.lower()}::{','.join(sorted(skip_languages)).lower()}::{text}"
    cached = TRANSLATION_CACHE.get(cache_key)
    if cached:
        return TranslationResponse(translated_text=cached)

    system_message = (
        "You translate chat messages for a messaging app. Return only the final translated text. "
        "Preserve names, phone numbers, URLs, emojis, punctuation, and line breaks. "
        "If the message already appears to be in the target language, return it unchanged. "
        "If the message appears to be in any skip language, return it unchanged. "
        "Preserve lightweight rich-text tags like [b], [/b], [color=...], and [/color] exactly as written."
    )
    prompt = (
        f"Target language: {target_language}\n"
        f"Skip languages: {', '.join(skip_languages) or 'none'}\n"
        "Translate the following chat message:\n"
        f"{text}"
    )

    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=f"smilers-translate-{uuid.uuid4()}",
            system_message=system_message,
        ).with_model("gemini", "gemini-2.5-flash")
        translated = (await chat.send_message(UserMessage(text=prompt))).strip() or text
        TRANSLATION_CACHE[cache_key] = translated
        return TranslationResponse(translated_text=translated)
    except Exception as exc:
        logger.exception("translation failed")
        raise HTTPException(status_code=502, detail=f"Translation failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Text-to-Speech — speak translated voice-note transcripts in the receiver's
# language. Powered by OpenAI TTS (multilingual) via the Emergent key.
# ---------------------------------------------------------------------------

_TTS_VOICES = {"alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"}


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4096, description="Text to synthesize.")
    voice: str = Field(default="alloy", description="OpenAI TTS voice name.")
    speed: float = Field(default=1.0, ge=0.25, le=4.0)


class TTSResponse(BaseModel):
    audio_base64: str
    mime: str = "audio/mpeg"


@api_router.post("/tts", response_model=TTSResponse)
async def text_to_speech(payload: TTSRequest, request: Request) -> TTSResponse:
    """Synthesize `payload.text` to spoken mp3 audio (base64). Used to play a
    voice note's translated transcript aloud in the receiver's language."""
    _ok, _retry = await _rate_limit_ok_async("tts", _client_ip_of(request), 40, 60)
    if not _ok:
        raise HTTPException(status_code=429, detail="Too many speech requests; please slow down.", headers={"Retry-After": str(_retry)})

    api_key = os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Missing EMERGENT_LLM_KEY")

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text.")
    voice = payload.voice if payload.voice in _TTS_VOICES else "alloy"

    try:
        import base64 as _b64
        from emergentintegrations.llm.openai.text_to_speech import OpenAITextToSpeech

        tts = OpenAITextToSpeech(api_key=api_key)
        audio_bytes = await tts.generate_speech(
            text=text[:4096],
            model="tts-1",
            voice=voice,  # type: ignore[arg-type]
            speed=payload.speed,
            response_format="mp3",
        )
        return TTSResponse(audio_base64=_b64.b64encode(audio_bytes).decode("utf-8"), mime="audio/mpeg")
    except Exception as exc:
        logger.exception("tts failed")
        raise HTTPException(status_code=502, detail=f"Speech synthesis failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Tap AI — in-call assistant. Operates on the call TRANSCRIPT (built from the
# interpreter subtitles on the client) to summarise, take notes, extract
# action points, or pull out a calendar event. Powered by the Emergent LLM
# key (Gemini), same pattern as /translate.
# ---------------------------------------------------------------------------


class CallAiRequest(BaseModel):
    transcript: str = Field(..., min_length=1, max_length=20000)
    task: str = Field(..., description="summary | notes | action_points | calendar")
    target_language: str = Field(default="English")
    now_iso: Optional[str] = Field(default=None, description="Client local time for relative dates.")


class CallAiResponse(BaseModel):
    task: str
    text: str = ""
    event: Optional[dict] = None


_CALL_AI_TASKS = {"summary", "notes", "action_points", "calendar"}


@api_router.post("/call-ai", response_model=CallAiResponse)
async def call_ai(payload: CallAiRequest, request: Request) -> CallAiResponse:
    _ok, _retry = await _rate_limit_ok_async("call_ai", _client_ip_of(request), 30, 60)
    if not _ok:
        raise HTTPException(status_code=429, detail="Too many AI requests; please slow down.", headers={"Retry-After": str(_retry)})

    task = (payload.task or "").strip().lower()
    if task not in _CALL_AI_TASKS:
        raise HTTPException(status_code=400, detail="Unknown task.")
    transcript = (payload.transcript or "").strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="Empty transcript.")

    api_key = os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Missing EMERGENT_LLM_KEY")

    lang = (payload.target_language or "English").strip() or "English"
    now_iso = (payload.now_iso or "").strip() or datetime.now(timezone.utc).isoformat()

    if task == "summary":
        system_message = (
            f"You summarize call transcripts. Write a concise summary in {lang}, 3-6 short bullet points, "
            "capturing the key topics and decisions. Return only the summary, no preamble."
        )
        prompt = f"Transcript:\n{transcript}"
    elif task == "notes":
        system_message = (
            f"You take clean meeting notes from a call transcript. Write in {lang} with short sections/bullets "
            "(topics discussed, decisions, open questions). Return only the notes."
        )
        prompt = f"Transcript:\n{transcript}"
    elif task == "action_points":
        system_message = (
            f"You extract clear action items from a call transcript. Write in {lang} as a numbered list of "
            "actionable tasks, each starting with a verb and naming the owner if mentioned. If there are none, "
            "say so briefly. Return only the list."
        )
        prompt = f"Transcript:\n{transcript}"
    else:  # calendar
        system_message = (
            "You extract a single calendar event from a call transcript if one is clearly discussed "
            "(a meeting, appointment, call-back, or deadline with a time). "
            f"The user's current local time is {now_iso}; resolve relative dates like 'tomorrow at 5' against it. "
            f"Write the title and notes in {lang}. "
            "Respond with ONLY compact JSON, no markdown, of the form: "
            '{"found": <true|false>, "title": "<short title>", "start": "<ISO 8601 with timezone offset>", '
            '"end": "<ISO 8601 with timezone offset>", "notes": "<short notes>"}. '
            "If no event is clearly discussed, return {\"found\": false}."
        )
        prompt = f"Transcript:\n{transcript}"

    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=f"smilers-callai-{uuid.uuid4()}",
            system_message=system_message,
        ).with_model("gemini", "gemini-2.5-flash")
        raw = (await chat.send_message(UserMessage(text=prompt))).strip()
    except Exception as exc:
        logger.exception("call-ai failed")
        raise HTTPException(status_code=502, detail=f"AI request failed: {exc}") from exc

    if task != "calendar":
        return CallAiResponse(task=task, text=raw)

    # Parse calendar JSON defensively.
    import json as _json
    import re as _re

    event: Optional[dict] = None
    text = raw
    fence = _re.search(r"\{.*\}", raw, _re.DOTALL)
    if fence:
        try:
            data = _json.loads(fence.group(0))
            if data.get("found") and data.get("start"):
                event = {
                    "title": str(data.get("title") or "Follow-up").strip()[:200],
                    "start": str(data.get("start") or "").strip(),
                    "end": str(data.get("end") or "").strip(),
                    "notes": str(data.get("notes") or "").strip()[:1000],
                }
                text = event["title"]
            else:
                text = ""
        except Exception:  # noqa: BLE001
            event = None
            text = ""
    return CallAiResponse(task=task, text=text, event=event)


@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.dict()
    status_obj = StatusCheck(**status_dict)
    _ = await db.status_checks.insert_one(status_obj.dict())
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    # iter-118 (deployment hardening): bounded scan with projection so a
    # large status_checks collection in production can't time out the
    # request. We never need _id (Mongo internal) on the wire; surface
    # only the fields StatusCheck expects to hydrate.
    status_checks = await db.status_checks.find(
        {},
        {"_id": False, "id": True, "client_name": True, "timestamp": True},
    ).limit(100).to_list(100)
    return [StatusCheck(**status_check) for status_check in status_checks]


# ---------------------------------------------------------------------------
# Transcription — OpenAI Whisper for voice / video message speech-to-text.
# ---------------------------------------------------------------------------

class TranscriptionRequest(BaseModel):
    media_url: str = Field(..., description="HTTPS URL of the voice or video media to transcribe.")
    language_hint: str | None = Field(
        default=None,
        description="Optional ISO 639-1 language code hint to bias Whisper.",
    )


class TranscriptionSegment(BaseModel):
    start: float
    end: float
    text: str


class TranscriptionResponse(BaseModel):
    text: str
    language: str  # ISO 639-1 from Whisper response (or 'unknown')
    duration_sec: float | None = None
    segments: list[TranscriptionSegment] | None = None


@api_router.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_media(payload: TranscriptionRequest, request: Request) -> TranscriptionResponse:
    """Download the media at ``payload.media_url`` and transcribe it with
    OpenAI Whisper. Supports voice notes (.m4a/.mp3/.webm/.wav) and short
    videos (.mp4/.mov) — Whisper extracts the audio internally."""

    _ok, _retry = await _rate_limit_ok_async("transcribe", _client_ip_of(request), 30, 60)
    if not _ok:
        raise HTTPException(status_code=429, detail="Too many transcription requests; please slow down.", headers={"Retry-After": str(_retry)})

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Transcription unavailable: OPENAI_API_KEY missing on server.")

    import tempfile
    import httpx
    from openai import OpenAI

    # Limit single-call duration / size so a stuck request can't hold the
    # event loop forever; Whisper itself caps individual files at 25MB.
    max_bytes = 24 * 1024 * 1024

    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as http_client:
            response = await http_client.get(payload.media_url)
            if response.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Could not fetch media (HTTP {response.status_code}).")
            content = response.content
            if len(content) > max_bytes:
                raise HTTPException(status_code=413, detail="Media exceeds 24MB Whisper limit.")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("transcribe: failed to fetch media")
        raise HTTPException(status_code=502, detail=f"Could not fetch media: {exc}") from exc

    # Whisper requires a file with an extension to infer the codec. Use the
    # last path segment when present, fall back to .m4a for voice notes.
    suffix = ".m4a"
    lower_url = payload.media_url.lower().split("?")[0]
    for candidate in (".m4a", ".mp3", ".wav", ".webm", ".ogg", ".mp4", ".mov", ".aac"):
        if lower_url.endswith(candidate):
            suffix = candidate
            break

    # Route Asante Twi (Akan) to Gemini — Whisper handles it poorly. All other
    # languages stay on Whisper (also yields caption timestamps for video).
    if _hint_is_akan_twi(payload.language_hint):
        if not ASANTE_TWI_AUDIO_ENABLED:
            return _twi_disabled_transcription()
        return await _run_gemini_transcription(content, suffix)
    return await _run_whisper(content, suffix, payload.language_hint, api_key)


@api_router.post("/transcribe/upload", response_model=TranscriptionResponse)
async def transcribe_uploaded_media(
    file: UploadFile = File(...),
    language_hint: str | None = Form(default=None),
    request: Request = None,
) -> TranscriptionResponse:
    """Multipart-upload variant of /transcribe — used by the mobile client
    when the message is E2EE-encrypted (mediaUrl points at ciphertext, so
    fetching by URL is useless). The mobile sends the PLAINTEXT audio
    bytes directly here, before Convex upload + encryption."""

    if request is not None:
        _ok, _retry = await _rate_limit_ok_async("transcribe", _client_ip_of(request), 30, 60)
        if not _ok:
            raise HTTPException(status_code=429, detail="Too many transcription requests; please slow down.", headers={"Retry-After": str(_retry)})

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Transcription unavailable: OPENAI_API_KEY missing on server.")

    max_bytes = 24 * 1024 * 1024
    content = await file.read()
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail="Media exceeds 24MB Whisper limit.")
    if not content:
        raise HTTPException(status_code=400, detail="Empty upload.")

    # Use the uploaded filename's extension if present, otherwise default to m4a.
    suffix = ".m4a"
    name = (file.filename or "").lower()
    for candidate in (".m4a", ".mp3", ".wav", ".webm", ".ogg", ".mp4", ".mov", ".aac"):
        if name.endswith(candidate):
            suffix = candidate
            break

    if _hint_is_akan_twi(language_hint):
        if not ASANTE_TWI_AUDIO_ENABLED:
            return _twi_disabled_transcription()
        return await _run_gemini_transcription(content, suffix)
    return await _run_whisper(content, suffix, language_hint, api_key)


# Asante Twi (Akan) is a low-resource language OpenAI Whisper barely supports,
# so voice/video in Twi comes back garbled. Gemini (the same engine that powers
# our already-good translations) transcribes Akan far more accurately, following
# correct Twi orthography. We route Twi/Akan audio to Gemini and keep Whisper as
# the default for every other language (it also gives caption timestamps for video).
_AKAN_TWI_TOKENS = ("ak", "tw", "twi", "akan", "asante", "asanti", "fante", "fanti")

# TEMPORARILY DEACTIVATED (user request, Jun 2026): Asante Twi (Akan) AUDIO
# transcription + translation is turned off until a more reliable Twi speech
# engine is sourced. When a voice/video note's source language is Twi we now
# SKIP transcription (return an empty transcript) instead of routing to Gemini,
# so no unreliable Twi text/translation is produced. TEXT translation for Twi is
# unaffected. To REACTIVATE: flip this flag back to True — the Gemini Twi path
# below is left fully intact.
ASANTE_TWI_AUDIO_ENABLED = False


def _twi_disabled_transcription() -> "TranscriptionResponse":
    return TranscriptionResponse(text="", language="ak", segments=[])


def _hint_is_akan_twi(language_hint: str | None) -> bool:
    if not language_hint:
        return False
    tokens = {
        part.strip().lower()
        for chunk in language_hint.replace(";", ",").split(",")
        for part in chunk.split()
    }
    if tokens & {"ak", "tw", "twi", "akan"}:
        return True
    lowered = language_hint.lower()
    return any(word in lowered for word in ("twi", "akan", "asante", "fante"))


def _suffix_to_audio_mime(suffix: str) -> str:
    return {
        ".m4a": "audio/mp4",
        ".mp3": "audio/mp3",
        ".wav": "audio/wav",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
        ".aac": "audio/aac",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
    }.get(suffix.lower(), "audio/mp4")


async def _run_gemini_transcription(
    content: bytes,
    suffix: str,
) -> TranscriptionResponse:
    """Transcribe Asante Twi (Akan) audio with Gemini, which handles this
    low-resource language markedly better than Whisper. Returns the transcript
    as a single segment (Gemini does not emit per-word timestamps)."""

    emergent_key = os.getenv("EMERGENT_LLM_KEY")
    if not emergent_key:
        raise HTTPException(status_code=503, detail="Twi transcription unavailable: EMERGENT_LLM_KEY missing on server.")

    import tempfile

    mime = _suffix_to_audio_mime(suffix)
    system_message = (
        "You are an expert speech-to-text engine for Asante Twi (Akan), a Ghanaian language. "
        "Transcribe the spoken audio VERBATIM into written Asante Twi using correct Akan "
        "orthography, including the special letters ɛ and ɔ and proper tone/word boundaries. "
        "Do NOT translate to English. Do NOT add commentary, labels, timestamps, or quotation marks. "
        "Preserve names, numbers and any code-switched English words exactly as spoken. "
        "If the audio contains no intelligible speech, return an empty string."
    )
    prompt = "Transcribe this Asante Twi audio verbatim in Akan. Return only the transcript text."

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        chat = LlmChat(
            api_key=emergent_key,
            session_id=f"smilers-transcribe-tw-{uuid.uuid4()}",
            system_message=system_message,
        ).with_model("gemini", "gemini-2.5-flash")
        file_content = FileContentWithMimeType(mime, tmp_path)
        raw = await chat.send_message(UserMessage(text=prompt, file_contents=[file_content]))
        text = (raw or "").strip()

        return TranscriptionResponse(
            text=text,
            language="ak",
            duration_sec=None,
            segments=None,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("transcribe: Gemini (Twi) call failed")
        raise HTTPException(status_code=502, detail=f"Twi transcription failed: {exc}") from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


async def _run_whisper(
    content: bytes,
    suffix: str,
    language_hint: str | None,
    api_key: str,
) -> TranscriptionResponse:
    """Shared Whisper helper used by both the URL-based and multipart
    transcription endpoints."""

    import tempfile
    from openai import OpenAI

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        client_openai = OpenAI(api_key=api_key)
        with open(tmp_path, "rb") as audio_file:
            kwargs: dict = {
                "model": "whisper-1",
                "file": audio_file,
                "response_format": "verbose_json",
            }
            # Whisper only accepts ISO-639-1 codes. Pass the hint through only
            # when it looks like a plain 2-letter code so a free-text/Akan hint
            # (routed to Gemini elsewhere) can't 400 the Whisper request.
            if language_hint and len(language_hint.strip()) == 2 and language_hint.strip().isalpha():
                kwargs["language"] = language_hint.strip().lower()
            result = client_openai.audio.transcriptions.create(**kwargs)

        # Whisper verbose_json returns a list of segments with start/end times
        # so the mobile client can render time-synced captions over the video.
        raw_segments = getattr(result, "segments", None) or []
        segments: list[TranscriptionSegment] = []
        for seg in raw_segments:
            # OpenAI SDK returns objects with attribute access; fall back to
            # dict-style if a future SDK version switches to dicts.
            start = getattr(seg, "start", None)
            end = getattr(seg, "end", None)
            text = getattr(seg, "text", None)
            if start is None and isinstance(seg, dict):
                start = seg.get("start")
                end = seg.get("end")
                text = seg.get("text")
            if start is None or end is None or text is None:
                continue
            segments.append(TranscriptionSegment(
                start=float(start),
                end=float(end),
                text=str(text).strip(),
            ))

        return TranscriptionResponse(
            text=getattr(result, "text", "") or "",
            language=getattr(result, "language", None) or "unknown",
            duration_sec=getattr(result, "duration", None),
            segments=segments or None,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("transcribe: Whisper call failed")
        raise HTTPException(status_code=502, detail=f"Whisper failed: {exc}") from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ============================================================================
# Diagnostic Logs — capture mobile crashes / JS errors from production APKs
# ============================================================================
#
# The mobile app uses Emergent's release-build pipeline (no development
# profile available), so console.log / adb logcat are not visible. The
# frontend installs a global JS error handler + persistent ring buffer that
# survives an app crash via AsyncStorage. On the next app launch, any
# stored diagnostic events are flushed to this endpoint so the main agent
# can read them from supervisor logs in real time without round-trips
# through the user.

class DiagnosticEntry(BaseModel):
    ts: int                              # ms since epoch
    tag: str                             # e.g. 'ERR', 'CALL', 'PC', 'SIG'
    message: str
    stack: str | None = None
    source: str | None = None            # e.g. 'global', 'errorBoundary', 'callDebug'


class DiagnosticPayload(BaseModel):
    sessionId: str | None = None
    userId: str | None = None
    appVersion: str | None = None
    platform: str | None = None          # 'android' / 'ios' / 'web'
    platformVersion: str | None = None
    device: str | None = None
    events: List[DiagnosticEntry] = Field(default_factory=list)


@api_router.post("/diagnostic-logs")
async def diagnostic_logs(payload: DiagnosticPayload):
    """Receive a batch of diagnostic events from the mobile app.

    Logs each event with a distinctive prefix so the main agent can grep
    supervisor logs in real time. Also persists the raw payload to MongoDB
    so historical crashes are queryable.
    """
    header = (
        f"[DIAG] session={payload.sessionId or '-'} "
        f"user={payload.userId or '-'} "
        f"plat={payload.platform or '-'}/{payload.platformVersion or '-'} "
        f"app={payload.appVersion or '-'} "
        f"device={payload.device or '-'} "
        f"events={len(payload.events)}"
    )
    logger.warning(header)
    for ev in payload.events:
        logger.warning(
            "[DIAG][%s][%s] %s%s",
            ev.tag,
            ev.source or '-',
            ev.message,
            (f"\n  stack: {ev.stack}" if ev.stack else ''),
        )
    try:
        await db['diagnostic_logs'].insert_one({
            'sessionId': payload.sessionId,
            'userId': payload.userId,
            'appVersion': payload.appVersion,
            'platform': payload.platform,
            'platformVersion': payload.platformVersion,
            'device': payload.device,
            'events': [ev.dict() for ev in payload.events],
            'receivedAt': datetime.utcnow(),
        })
    except Exception:  # noqa: BLE001
        logger.exception("[DIAG] failed to persist payload to mongo")
    return {"ok": True, "received": len(payload.events)}


@api_router.get("/diagnostic-logs/recent")
async def diagnostic_logs_recent(limit: int = 50):
    """Return the most recent crash payloads — used by the main agent."""
    safe_limit = max(1, min(limit, 200))
    cursor = db['diagnostic_logs'].find({}, {'_id': False}).sort('receivedAt', -1).limit(safe_limit)
    items = []
    async for doc in cursor:
        if isinstance(doc.get('receivedAt'), datetime):
            doc['receivedAt'] = doc['receivedAt'].isoformat()
        items.append(doc)
    return {"items": items, "count": len(items)}


# ─────────────────────────────────────────────────────────────────────────────
# Emergent-managed Push Notifications relay + FCM v1 direct fallback
# ─────────────────────────────────────────────────────────────────────────────
#
# Architecture (iter-129):
#   1. Mobile app → POST /api/register-push  → relays to Emergent push
#      AND records the native FCM/APNs token in MongoDB so we can also
#      send directly via FCM v1 / APNs without going through Emergent.
#
#   2. Convex backend → POST /api/send-push-internal (with shared secret)
#      → tries FCM v1 (Firebase Admin SDK) FIRST for stored Android tokens
#         — this works as long as the Firebase service account is present.
#         FCM v1 is the most reliable path because we control everything.
#      → ALSO calls send_push() → Emergent push /trigger as a backup so
#         once the deployer injects the real EMERGENT_PUSH_KEY it just
#         starts working alongside FCM. Both paths idempotent (single
#         notification per recipient: the OS dedupes by content/tag).
#
# The "shared secret" between Convex and FastAPI is INTERNAL_PUSH_TOKEN,
# auto-provisioned in the backend .env so Convex can authenticate when
# triggering pushes for messages/missed calls/mentions.
#
# NOTE: EMERGENT_PUSH_KEY = "placeholder" in dev/.env — it is REPLACED at
# deploy time by the Emergent deployer with the real key. DO NOT edit
# the .env value yourself.

from fastapi import Header

PUSH_BASE_URL = "https://integrations.emergentagent.com"
PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
INTERNAL_PUSH_TOKEN = os.environ.get("INTERNAL_PUSH_TOKEN", "")
FIREBASE_ADMIN_SDK_PATH = os.environ.get(
    "FIREBASE_ADMIN_SDK_PATH",
    str(ROOT_DIR / "firebase-admin-sdk.json"),
)

_push_client = httpx.AsyncClient(
    base_url=PUSH_BASE_URL,
    headers={"X-Push-Key": PUSH_KEY},
    timeout=10.0,
)

# Firebase Admin SDK lazy-init — guards against missing service account
# file in dev (e.g. fresh clones without the secret). If init fails,
# fcm_send_v1() becomes a no-op and we degrade to Emergent-relay-only.
_firebase_app = None
_firebase_init_error: str | None = None


def _ensure_firebase_initialized() -> bool:
    global _firebase_app, _firebase_init_error
    if _firebase_app is not None:
        return True
    if _firebase_init_error is not None:
        # Don't keep retrying — log once and stay silent.
        return False
    try:
        import firebase_admin
        from firebase_admin import credentials
        if not os.path.exists(FIREBASE_ADMIN_SDK_PATH):
            _firebase_init_error = f"service account file not found at {FIREBASE_ADMIN_SDK_PATH}"
            logger.warning(f"FCM v1 disabled: {_firebase_init_error}")
            return False
        cred = credentials.Certificate(FIREBASE_ADMIN_SDK_PATH)
        _firebase_app = firebase_admin.initialize_app(cred, name="smilers-push")
        logger.info(f"FCM v1 initialized with project from {FIREBASE_ADMIN_SDK_PATH}")
        return True
    except Exception as e:
        _firebase_init_error = str(e)
        logger.warning(f"FCM v1 init failed: {e}")
        return False


async def fcm_send_v1(
    device_token: str,
    title: str,
    message: str,
    data: dict[str, str] | None = None,
    android_channel_id: str = "default",
    ttl_seconds: int | None = None,
    android_data_only: bool = False,
    include_ios_alert: bool = True,
) -> tuple[bool, str | None]:
    """
    Send a push notification directly via Firebase Cloud Messaging v1 API
    using the Admin SDK. Returns (success, error_message).

    Runs the synchronous firebase_admin call in a worker thread so it
    doesn't block the FastAPI event loop. Idempotent via FCM's own
    server-side dedup (use collapse_key or message_id for stricter
    idempotency if needed).
    """
    if not _ensure_firebase_initialized():
        return False, "FCM v1 not initialized"
    if not device_token:
        return False, "empty device token"
    try:
        from firebase_admin import messaging as fcm_messaging
        # Coerce data values to strings (FCM v1 requires str→str dict)
        safe_data: dict[str, str] = {}
        for k, v in (data or {}).items():
            if v is None:
                continue
            safe_data[str(k)] = str(v)
        msg = fcm_messaging.Message(
            token=device_token,
            # iter-217: CALL pushes are sent DATA-ONLY on Android (no
            # top-level `notification`, no AndroidNotification) so Android
            # does NOT auto-display a system notification. Instead the
            # device's background task renders the rich notifee full-screen
            # incoming-call UI (looping ringtone + Answer/Decline + ongoing
            # + missed-call). Messages keep the notification block so they
            # display normally even when the JS app isn't running. iOS keeps
            # its APNS alert in both cases.
            notification=(
                None if android_data_only else fcm_messaging.Notification(title=title, body=message)
            ),
            data=safe_data,
            android=fcm_messaging.AndroidConfig(
                priority="high",
                # iter-197: call pushes carry a short TTL so a missed
                # delivery window doesn't produce a ghost ring minutes
                # later when the device comes back online.
                **({"ttl": timedelta(seconds=ttl_seconds)} if ttl_seconds else {}),
                notification=(
                    None
                    if android_data_only
                    else fcm_messaging.AndroidNotification(
                        channel_id=android_channel_id,
                        sound="default",
                        default_vibrate_timings=True,
                        default_light_settings=True,
                        visibility="public",
                        priority="high",
                    )
                ),
            ),
            apns=fcm_messaging.APNSConfig(
                payload=fcm_messaging.APNSPayload(
                    aps=fcm_messaging.Aps(
                        # iOS message-duplicate fix: when this push is data-only
                        # (messages / silent controls), OMIT the APNS `alert` so
                        # iOS does NOT auto-display a system banner on top of the
                        # notification the app renders itself. Keeping
                        # content_available=True still wakes the app in the
                        # background to render its single notification. Calls keep
                        # the alert (no CallKit yet → the alert IS the ring UI).
                        alert=(
                            fcm_messaging.ApsAlert(title=title, body=message)
                            if include_ios_alert
                            else None
                        ),
                        sound=("default" if include_ios_alert else None),
                        badge=1,
                        content_available=True,
                    ),
                ),
                headers={"apns-priority": "10" if include_ios_alert else "5"},
            ),
        )
        # firebase_admin.messaging.send is synchronous → run in thread
        msg_id = await asyncio.to_thread(
            fcm_messaging.send, msg, app=_firebase_app
        )
        return True, msg_id
    except Exception as e:
        # FCM v1 raises NotFoundError for unregistered tokens — we should
        # remove those from our store. For now just log and return False.
        msg_str = f"{type(e).__name__}: {e}"
        logger.warning(f"fcm_send_v1 failed for token {device_token[:12]}…: {msg_str}")
        return False, msg_str


class RegisterPushBody(BaseModel):
    user_id: str
    platform: str  # "android" | "ios"
    device_token: str
    # iter-182: the app's CURRENT Android channel ids (versioned per the
    # user's selected ringtone/notification tone — Android channels are
    # immutable so a tone change = a new channel id). When present, FCM
    # sends route into these channels so the chosen sound actually plays.
    call_channel_id: str | None = None
    message_channel_id: str | None = None
    # iter-198: the user's Convex `users._id`. Mobile clients only know
    # OTHER participants by their Convex id (conversation.otherUser._id),
    # so client-triggered pushes (/api/notify-event) address recipients
    # by Convex id. Storing it here lets send_push match on EITHER id.
    convex_user_id: str | None = None
    # iter-385: the device's per-type notification toggles (messages, groups,
    # …). Stored on the token doc so send_push can AUTHORITATIVELY skip a
    # recipient who turned a type OFF — the previous JS-only suppression was
    # bypassed whenever the OS auto-displayed a notification-block push before
    # the app's background task ran (the "toggle OFF but still shows" bug).
    notification_prefs: dict | None = None


# ── Direct APNs sender (iOS only) ──────────────────────────────────────────────────
# WHY: iOS registers a RAW APNs device token (64 hex chars) through
# expo-notifications getDevicePushTokenAsync(). Firebase only accepts its own
# registration-token format, so EVERY iOS push was rejected server-side with
#   "InvalidArgumentError: The registration token is not a valid FCM
#    registration token"
# while Android (which registers a real FCM token) delivered fine. Confirmed in
# production: same minute, same code path — Android success=1, iOS error=1.
# Rather than change the app, deliver iOS pushes to Apple directly.
#
# Config — ALL OPTIONAL. While unset, apns_configured() is False and callers
# fall back to the previous FCM behaviour, so this change is inert until the
# .p8 key is installed.
#   APNS_KEY_ID       10-char Key ID of the .p8 auth key
#   APNS_TEAM_ID      10-char Apple Team ID (A7W96FN66D)
#   APNS_PRIVATE_KEY  full contents of AuthKey_XXXXXXXXXX.p8 (PEM text)
#   APNS_TOPIC        bundle id (default com.smilers.app)
#   APNS_USE_SANDBOX  "1" to target the sandbox gateway.
#                     LEAVE UNSET for TestFlight/App Store — those builds carry
#                     aps-environment=production; sandbox would silently drop.
APNS_KEY_ID = os.environ.get("APNS_KEY_ID", "")
APNS_TEAM_ID = os.environ.get("APNS_TEAM_ID", "")
APNS_PRIVATE_KEY = os.environ.get("APNS_PRIVATE_KEY", "")
APNS_TOPIC = os.environ.get("APNS_TOPIC", "com.smilers.app")
APNS_HOST = (
    "https://api.sandbox.push.apple.com"
    if os.environ.get("APNS_USE_SANDBOX") == "1"
    else "https://api.push.apple.com"
)

_apns_client: httpx.AsyncClient | None = None
_apns_jwt: tuple[str, float] | None = None


def apns_configured() -> bool:
    return bool(APNS_KEY_ID and APNS_TEAM_ID and APNS_PRIVATE_KEY)


def _apns_auth_token() -> str:
    """ES256 JWT for APNs, reused ~40 min. Apple rejects tokens older than 60
    minutes AND refreshes made more often than every 20 minutes."""
    global _apns_jwt
    now = time.time()
    if _apns_jwt and (now - _apns_jwt[1]) < 2400:
        return _apns_jwt[0]
    token = jwt.encode(
        {"iss": APNS_TEAM_ID, "iat": int(now)},
        APNS_PRIVATE_KEY,
        algorithm="ES256",
        headers={"kid": APNS_KEY_ID},
    )
    _apns_jwt = (token, now)
    return token


def _get_apns_client() -> httpx.AsyncClient:
    global _apns_client
    if _apns_client is None:
        # APNs requires HTTP/2 — h2 is already in requirements.txt.
        _apns_client = httpx.AsyncClient(http2=True, base_url=APNS_HOST, timeout=10.0)
    return _apns_client


async def apns_send(
    device_token: str,
    title: str,
    message: str,
    data: dict | None = None,
    include_alert: bool = True,
    ttl_seconds: int | None = None,
    is_call: bool = False,
) -> tuple[bool, str | None]:
    """Deliver one push straight to Apple.

    Returns the SAME (ok, error_message) contract as fcm_send_v1 so it drops
    into the existing asyncio.gather() without changing the caller's bookkeeping.
    """
    if not apns_configured():
        return False, "APNs not configured (APNS_KEY_ID/APNS_TEAM_ID/APNS_PRIVATE_KEY unset)"
    if not device_token:
        return False, "empty device token"

    payload: dict = {"aps": {}}
    if include_alert:
        # An APNs push with NO alert block displays nothing on iOS. Message
        # pushes previously had their alert suppressed, which is why nothing
        # ever appeared even when delivery worked.
        payload["aps"]["alert"] = {"title": title, "body": message}
        payload["aps"]["sound"] = "default"
        if is_call:
            # Surfaces the banner even in Focus/Do-Not-Disturb.
            payload["aps"]["interruption-level"] = "time-sensitive"
    else:
        payload["aps"]["content-available"] = 1
    for k, v in (data or {}).items():
        if k != "aps":
            payload[k] = v

    headers = {
        "authorization": "bearer " + _apns_auth_token(),
        "apns-topic": APNS_TOPIC,
        "apns-push-type": "alert" if include_alert else "background",
        "apns-priority": "10" if include_alert else "5",
    }
    if ttl_seconds:
        headers["apns-expiration"] = str(int(time.time()) + int(ttl_seconds))

    try:
        resp = await _get_apns_client().post(
            "/3/device/" + device_token, json=payload, headers=headers
        )
    except Exception as e:
        return False, "APNs request failed: " + str(e)

    if resp.status_code == 200:
        return True, None
    try:
        reason = (resp.json() or {}).get("reason", "")
    except Exception:
        reason = (resp.text or "")[:120]
    # Common reasons worth recognising:
    #   BadDeviceToken     token/environment mismatch (sandbox vs production)
    #   TopicDisallowed    apns-topic does not match the key's app
    #   ExpiredProviderToken  JWT too old — handled by the 40-min refresh above
    return False, "APNs " + str(resp.status_code) + ": " + str(reason)


async def _dispatch_push(
    token_doc: dict,
    title: str,
    message: str,
    data: dict | None,
    android_channel_id: str,
    ttl_seconds: int | None,
    android_data_only: bool,
    include_ios_alert: bool,
    apns_include_alert: bool,
    is_call: bool,
) -> tuple[bool, str | None]:
    """Pick the delivery transport for ONE token.

    iOS tokens are raw APNs tokens and Firebase rejects them outright, so they
    go straight to Apple when APNs is configured. Everything else keeps the
    exact previous fcm_send_v1 call — Android behaviour is unchanged, and if
    APNs is not configured iOS also falls back to the old path so this change
    is a no-op until the .p8 key is installed.
    """
    if str(token_doc.get("platform") or "").lower() == "ios" and apns_configured():
        return await apns_send(
            device_token=token_doc.get("device_token") or "",
            title=title,
            message=message,
            data=data,
            # Messages previously had their iOS alert suppressed so the app
            # could render its own. Nothing was ever delivered, and a killed
            # iOS app cannot run JS to render anything, so the alert block is
            # the only thing that can actually show. Only true silent-control
            # pushes stay alert-less.
            include_alert=apns_include_alert,
            ttl_seconds=ttl_seconds,
            is_call=is_call,
        )
    return await fcm_send_v1(
        device_token=token_doc.get("device_token") or "",
        title=title,
        message=message,
        data=data,
        android_channel_id=android_channel_id,
        ttl_seconds=ttl_seconds,
        android_data_only=android_data_only,
        include_ios_alert=include_ios_alert,
    )


@api_router.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody):
    """
    Frontend → backend. Stores the device's native FCM/APNs token in
    MongoDB (so we can send directly via FCM v1) AND relays to the
    Emergent push provider (so once EMERGENT_PUSH_KEY is real, that
    path also works).
    """
    if not body.user_id or not body.device_token:
        raise HTTPException(400, "user_id and device_token are required")
    if body.platform not in ("ios", "android"):
        raise HTTPException(400, "platform must be 'ios' or 'android'")

    # Write to MongoDB FIRST — this is the path we control and the one
    # we rely on for FCM v1 direct delivery. Use the (user_id, platform,
    # device_token) tuple as the natural key so re-registrations from
    # the same device just touch the updatedAt timestamp.
    try:
        update_set: dict = {
            "user_id": body.user_id,
            "platform": body.platform,
            "device_token": body.device_token,
            "updated_at": datetime.now(timezone.utc),
        }
        # iter-182: persist the device's current channel ids when sent.
        if body.call_channel_id:
            update_set["call_channel_id"] = body.call_channel_id
        if body.message_channel_id:
            update_set["message_channel_id"] = body.message_channel_id
        # iter-198: persist the Convex user id for client-triggered pushes.
        if body.convex_user_id:
            update_set["convex_user_id"] = body.convex_user_id
        # iter-385: persist the device's notification toggles (booleans only)
        # so send_push can suppress opted-out types server-side.
        if isinstance(body.notification_prefs, dict):
            update_set["notification_prefs"] = {
                str(k): bool(v)
                for k, v in body.notification_prefs.items()
                if isinstance(v, bool)
            }
        await db.push_tokens.update_one(
            {
                "user_id": body.user_id,
                "platform": body.platform,
                "device_token": body.device_token,
            },
            {
                "$set": update_set,
                "$setOnInsert": {
                    "created_at": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )
    except Exception as e:
        # MongoDB write failures shouldn't block — log + degrade.
        logger.warning(f"push_tokens upsert failed (continuing): {e}")

    # ALSO relay to Emergent — best-effort, swallow failures so the
    # primary path (FCM v1 direct) doesn't depend on Emergent's relay
    # being healthy.
    try:
        resp = await _push_client.post(
            "/api/v1/push/users/register",
            # Relay only understands the original three fields.
            json=body.model_dump(include={"user_id", "platform", "device_token"}),
        )
        # Only surface the response status; don't fail the request.
        if resp.status_code not in (200, 201, 202):
            logger.warning(
                f"register-push: Emergent relay returned {resp.status_code} "
                f"(continuing — FCM v1 path is independent)"
            )
    except httpx.HTTPError as e:
        logger.warning(f"register-push: Emergent relay unreachable (continuing): {e}")

    return {"status": "registered"}


def _resolve_android_channel(data: dict, token_doc: dict | None = None) -> str:
    """
    iter-182: decide which Android notification channel a push lands in.

    The user-facing regression this fixes: incoming-call pushes were
    falling into the default "messages-v3" channel (one short beep +
    short vibration) because Convex doesn't always send `channel_id`.
    We now DERIVE call-ness from the payload itself, and honor the
    per-device channel ids registered by the app (versioned per the
    user's selected ringtone — Android channels are immutable, so a
    tone change = a new channel id).

    Resolution order:
      1. Per-token override (call_channel_id / message_channel_id)
      2. Explicit data["channel_id"] from Convex
      3. Type-derived default: "calls" for call payloads, else "messages-v3"
    """
    explicit = str(data.get("channel_id") or "").strip()
    # iter-193: scan title AND body AND subtext. Convex sends WhatsApp-style
    # call pushes (title = caller's NAME, body = "Incoming voice call…"),
    # so a title-only regex classified them as messages → short beep +
    # short vibration instead of the full ring when the app is killed.
    haystack = " ".join(
        str(data.get(k) or "") for k in ("title", "message", "subtext")
    )
    action_url = str(data.get("action_url") or "")
    # iter-262: ALSO treat the mere PRESENCE of call-metadata fields as a
    # definitive call signal. The killed-app "message tone for incoming calls"
    # bug happens when Convex sends an incoming-call push whose title is just
    # the caller's name (no "incoming call" words) and without type/action_url
    # — the relay then mis-routed it to the message channel, so the OS played
    # the short message tone and the data-only → notifee full-screen ring never
    # fired. Any of these keys can ONLY belong to a call payload.
    has_call_metadata = any(
        str(data.get(k) or "").strip()
        for k in (
            "callId",
            "callType",
            "callerId",
            "twilio_room_name",
            "twilio_room_sid",
            "twilio_caller_identity",
        )
    )
    is_call = (
        explicit.startswith("calls")
        or str(data.get("type") or "").strip() in ("call", "incoming-call")
        or action_url.startswith("/call")
        or has_call_metadata
        or bool(re.search(r"\b(incoming|missed)\b[^.]*\bcall", haystack, re.IGNORECASE))
    )
    if token_doc:
        override = token_doc.get("call_channel_id" if is_call else "message_channel_id")
        if override:
            return str(override)
    if explicit:
        return explicit
    # iter-252: default to the VERSIONED channels (created by the app with the
    # correct custom sounds), NOT the legacy "calls"/"messages-v3" ids. Android
    # channels are immutable, so those legacy channels keep whatever sound they
    # were FIRST created with on older builds (often the system default) — which
    # is exactly why messages rang with the default tone and mis-classified
    # call pushes used the message beep. The versioned ids are (re)created on
    # every app launch via applyNotificationChannelPrefs with the right sound.
    return "calls-v4-smilers_never_cry" if is_call else "messages-v4-message_notification"


def _derive_push_routing(data: dict) -> dict[str, str]:
    """
    iter-197: synthesize the routing fields the MOBILE tap-handler expects
    (`type`, `conversationId`, `callId`, `displayName`) from the
    Convex-provided `action_url`. Without these, taps on backend pushes
    did NOTHING because the handler only routes on `payload.type`.
    """
    out: dict[str, str] = {}
    # iter-272: honor an EXPLICIT type sent by the caller. Convex's
    # `notifyIncomingCall` now sends a data-only payload with `type:'call'`.
    # `is_call_push` (which drives android_data_only → dropping the FCM
    # notification block, plus the 45s TTL) is derived from THIS routing, so
    # we must trust the explicit type even when `action_url` is absent or
    # points somewhere else. Without this a killed app gets a notification
    # block → plays the message tone instead of ringing.
    explicit_type = str(data.get("type") or "").strip().lower()
    if explicit_type in ("call", "incoming-call"):
        out["type"] = "call"
    elif explicit_type == "missed-call":
        out["type"] = "missed-call"
    elif explicit_type == "message":
        out["type"] = "message"
    elif explicit_type in ("call-cancelled", "call-declined", "call-removed", "call-add-request", "call-add-declined"):
        # Control signals — preserve exactly so the callee/caller Kotlin handler
        # routes them correctly. Without this they get overridden to "call" or
        # "message" by the has_call_metadata / channel-detection fallback below.
        out["type"] = explicit_type

    action_url = str(data.get("action_url") or "")
    if not action_url.startswith("/"):
        return out
    path, _, query = action_url.partition("?")
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 2 and parts[0] == "call":
        # Don't override an explicit control signal (call-cancelled /
        # call-declined) — those must reach the Kotlin handler as-is, but
        # still carry the callId so it knows WHICH call to dismiss.
        if out.get("type") not in ("call-cancelled", "call-declined"):
            out["type"] = "call"
        out["conversationId"] = parts[1]
        # iter-396 FIX (P0 subsequent-call suppression): do NOT clobber an explicit
        # per-attempt callId. webrtc_ring sends a UNIQUE call_id per attempt, but the
        # action_url is /call/<conversationId>, so parsing it here used to overwrite
        # callId with the STABLE conversationId. The native Android dedup
        # (checkAndMarkHandled) keys on callId with a 5-min window, so a stable
        # conversationId made every 2nd/3rd call to the same person get silently
        # suppressed. Only fall back to conversationId when no explicit callId exists.
        if not str(data.get("callId") or "").strip():
            out["callId"] = parts[1]
    elif len(parts) >= 2 and parts[0] == "chat":
        # Don't downgrade an explicit call / control-signal type via the
        # action_url path. call-cancelled / call-declined route to /chat/<id>
        # but MUST keep their type so the native service cancels the ring /
        # ringback instead of rendering a plain message banner.
        if out.get("type") not in ("call", "call-cancelled", "call-declined"):
            out["type"] = "message"
        out["conversationId"] = parts[1]
    if query:
        try:
            from urllib.parse import parse_qs
            display_name = (parse_qs(query).get("displayName") or [""])[0]
            if display_name:
                out["displayName"] = display_name
        except Exception:
            pass
    return out


_DEAD_TOKEN_MARKERS = ("UnregisteredError", "Requested entity was not found", "NotFoundError")


async def _is_duplicate_push(
    idempotency_key: str | None,
    content_hash: str | None,
    is_call: bool = False,
) -> bool:
    """
    iter-198: cross-trigger dedupe. Pushes can now originate from TWO
    sources — Convex server triggers (/api/send-push-internal) and the
    sender's own device (/api/notify-event). If both fire for the same
    message/call, the recipient must still get exactly ONE notification.

    - idempotency_key (the Convex message/call id) dedupes for 10 min.
    - content_hash (recipients+title+body+action_url) dedupes for 60 s,
      catching double-triggers even when the two sources use different
      keys.
    Records are written with a `ts` used by a TTL index (best-effort).

    fork-fix (call inconsistency — the root cause of "calls are time-bound"):
    when `is_call` is True we use a VERY SHORT 6-second window for BOTH the key
    and the content hash. Two legitimate consecutive calls between the same two
    people are CONTENT-IDENTICAL (same caller name, "Incoming call", same
    /call/<conv> action_url) and often reuse a stable idempotency key, so the
    old 60s/600s windows silently suppressed the 2nd, 3rd … call as a
    "duplicate" — the callee never rang until the window expired ("after some
    minutes"). A 6s window still collapses the near-simultaneous Convex+device
    dual-trigger of ONE call attempt (they fire within ~1s) while letting every
    genuinely distinct call attempt through immediately.
    """
    now = datetime.now(timezone.utc)
    try:
        keys = []
        if idempotency_key:
            keys.append(f"key:{idempotency_key}")
        if content_hash:
            keys.append(f"hash:{content_hash}")
        if not keys:
            return False
        existing = await db.push_dedupe.find({"k": {"$in": keys}}).to_list(length=4)
        for doc in existing:
            ts = doc.get("ts")
            if not ts:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            age = (now - ts).total_seconds()
            if is_call:
                window = 6
            else:
                window = 600 if str(doc.get("k", "")).startswith("key:") else 60
            if age < window:
                return True
        for k in keys:
            await db.push_dedupe.update_one(
                {"k": k}, {"$set": {"k": k, "ts": now}}, upsert=True
            )
    except Exception as e:
        logger.warning(f"push dedupe check failed (treating as not-duplicate): {e}")
    return False


def _push_content_hash(recipients: list[str], data: dict) -> str:
    import hashlib

    raw = "|".join(
        [
            ",".join(sorted(recipients)),
            str(data.get("title") or ""),
            str(data.get("message") or ""),
            str(data.get("action_url") or ""),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


async def _prune_dead_token(token_doc: dict, error_message: str | None) -> bool:
    """Remove FCM tokens that Firebase reports as permanently dead so the
    store stays healthy (stale tokens from uninstalled/rebuilt apps)."""
    if not error_message or not any(m in error_message for m in _DEAD_TOKEN_MARKERS):
        return False
    try:
        await db.push_tokens.delete_one({"_id": token_doc["_id"]})
        logger.info(
            f"send_push: pruned dead token {str(token_doc.get('device_token') or '')[:12]}… "
            f"(user={token_doc.get('user_id')})"
        )
        return True
    except Exception as e:
        logger.warning(f"send_push: dead-token prune failed: {e}")
        return False


# ── Task 3: proactive stale-token purge (DB bloat prevention) ───────────────
# Reactive pruning (_prune_dead_token) removes tokens Firebase reports as dead,
# but a token whose app is uninstalled/rebuilt is never SENT to again once the
# user re-registers a new token, so its old row lingers forever. We also want to
# collapse the rare case of many rows for one (user, platform). This time-based
# sweep deletes any push_tokens row not refreshed in `days` days — a live device
# re-registers on every cold start (see useEmergentPush), so a row untouched for
# months is definitively stale.
_STALE_TOKEN_DAYS = int(os.environ.get("PUSH_TOKEN_STALE_DAYS", "90"))
_TOKEN_PURGE_INTERVAL_SECONDS = 24 * 60 * 60  # daily


async def _purge_stale_push_tokens(days: int = _STALE_TOKEN_DAYS) -> int:
    """Delete push_tokens whose `updated_at` (fallback `created_at`) is older
    than `days` days. Returns the number of rows removed."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, days))
    try:
        res = await db.push_tokens.delete_many(
            {
                "$or": [
                    {"updated_at": {"$lt": cutoff}},
                    # rows that predate updated_at tracking: fall back to created_at
                    {"updated_at": {"$exists": False}, "created_at": {"$lt": cutoff}},
                ]
            }
        )
        removed = int(getattr(res, "deleted_count", 0) or 0)
        if removed:
            logger.info(f"push-token purge: removed {removed} stale token(s) older than {days}d")
        return removed
    except Exception as e:  # noqa: BLE001
        logger.warning(f"push-token purge failed (non-fatal): {e}")
        return 0


async def _push_token_purge_loop():
    """Background loop: purge stale tokens once at boot, then daily."""
    while True:
        try:
            await _purge_stale_push_tokens()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"push-token purge loop error (non-fatal): {e}")
        await asyncio.sleep(_TOKEN_PURGE_INTERVAL_SECONDS)


class PurgeStaleTokensBody(BaseModel):
    days: int | None = None


@api_router.post("/maintenance/purge-stale-tokens")
async def purge_stale_tokens(body: PurgeStaleTokensBody):
    """Manually trigger the stale-token sweep (also runs daily in the
    background). Returns how many rows were removed and the cutoff used."""
    days = body.days if (body.days and body.days > 0) else _STALE_TOKEN_DAYS
    before = await db.push_tokens.count_documents({})
    removed = await _purge_stale_push_tokens(days)
    after = await db.push_tokens.count_documents({})
    return {
        "removed": removed,
        "days": days,
        "tokens_before": before,
        "tokens_after": after,
    }



async def _recent_call_push_to_user(token_user_id: str, call_key: str = "") -> bool:
    """
    iter-199: SEMANTIC call-push dedupe. Incoming-call pushes can originate
    from BOTH the Convex trigger (recipient keyed by OIDC sub) and the
    caller's device (recipient keyed by Convex id) — different idempotency
    keys and different action_urls, so the generic dedupe can't catch the
    pair. Collapse them here.

    iter-A6b: window reduced from 25s → 8s.

    fork-fix (call inconsistency): the dedupe is now keyed by (user, CALL) —
    `callpush:<user>:<callId>` — instead of just the user. The old per-user
    key meant ANY second call push to a user within 8 s was dropped, so:
      • a legitimate re-call after a quick hang-up never rang, and
      • a DIFFERENT caller ringing the same user within 8 s was silently
        suppressed.
    Both surfaced as "the callee's phone just doesn't ring" with no obvious
    reason. Keying by callId still collapses the Convex + caller-device
    duplicate for the SAME call (they share the room/call id) while letting
    every genuinely distinct call through. Falls back to the per-user key only
    when no call identifier is available.
    """
    key = f"callpush:{token_user_id}:{call_key}" if call_key else f"callpush:{token_user_id}"
    now = datetime.now(timezone.utc)
    try:
        existing = await db.push_dedupe.find_one({"k": key})
        if existing and existing.get("ts"):
            ts = existing["ts"]
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if (now - ts).total_seconds() < 8:
                return True
        await db.push_dedupe.update_one(
            {"k": key}, {"$set": {"k": key, "ts": now}}, upsert=True
        )
    except Exception as e:
        logger.warning(f"call-push dedupe failed (treating as not-duplicate): {e}")
    return False


async def send_push(
    recipients: list[str],
    data: dict,
    idempotency_key: str | None = None,
) -> dict:
    """
    Server-side helper. Sends a push notification to all device tokens
    registered for the given recipient user IDs.

    iter-129: PRIMARY path is FCM v1 (Firebase Admin SDK) using tokens
    stored in MongoDB. SECONDARY path is the Emergent relay (which only
    works once EMERGENT_PUSH_KEY is real). Both paths fire in parallel
    — the OS dedupes by content so the user never sees doubles.

    iter-197: now RETURNS real delivery stats
    {token_count, success_count, error_count, errors, pruned_count}
    and prunes permanently-dead tokens (UnregisteredError).

    Wrap calls in try/except — push delivery failures never block the
    primary operation.
    """
    stats: dict = {
        "token_count": 0,
        "success_count": 0,
        "error_count": 0,
        "errors": [],
        "pruned_count": 0,
    }
    if not recipients:
        return stats
    if len(recipients) > 100:
        raise ValueError("max 100 recipients per send_push call; chunk before sending")
    if "title" not in data or "message" not in data:
        raise ValueError("data must include 'title' and 'message'")

    title = str(data["title"])
    message = str(data["message"])

    # iter-242: decide UP FRONT whether this is a CALL push. Calls must be
    # delivered ONLY via the FCM v1 data-only path below (the single path that
    # wakes the device background task → renders the notifee full-screen
    # incoming-call UI with Answer/Decline + looping ringtone). The Emergent
    # relay can only send a plain `notification` banner (no action buttons,
    # and it does NOT trigger the data-only background task), so for calls it
    # produces a button-less banner that masks the real ring. We therefore
    # SKIP the relay entirely for call pushes (see the relay block below).
    _call_probe_routing = _derive_push_routing(data)
    if "type" not in _call_probe_routing:
        _call_probe_channel = _resolve_android_channel({**data, "title": title}, None)
        _call_probe_routing["type"] = "call" if _call_probe_channel.startswith("calls") else "message"
    is_call_push_global = _call_probe_routing.get("type") == "call"
    is_message_push_global = _call_probe_routing.get("type") == "message"

    # iter-262: one-line classification log so production push routing is
    # debuggable (esp. the "killed app plays the message tone for calls" bug —
    # this tells us whether the relay saw it as CALL or MESSAGE and why).
    try:
        _diag_channel = _resolve_android_channel({**data, "title": title}, None)
        logger.info(
            "[PUSH][classify] -> %s channel=%s recipients=%d type=%r action_url=%r "
            "has_callId=%s title=%r",
            "CALL" if is_call_push_global else "MESSAGE",
            _diag_channel,
            len(recipients),
            str(data.get("type") or ""),
            str(data.get("action_url") or ""),
            bool(str(data.get("callId") or "").strip()),
            title[:48],
        )
    except Exception:
        pass

    # ── Primary path: FCM v1 ──────────────────────────────────────
    # Look up all stored device tokens for these recipients and send
    # in parallel via Firebase Admin SDK.
    if _ensure_firebase_initialized():
        try:
            # iter-198: match on the OIDC sub (what mobile registers as
            # user_id) OR the Convex users._id (what client-triggered
            # pushes know recipients by).
            cursor = db.push_tokens.find(
                {
                    "$or": [
                        {"user_id": {"$in": recipients}},
                        {"convex_user_id": {"$in": recipients}},
                    ]
                }
            )
            tokens = await cursor.to_list(length=500)
            # Dedupe by device_token string: the same physical device can have
            # MULTIPLE push_tokens rows (repeated APK installs, or one row keyed
            # by user_id/OIDC-sub and another by convex_user_id that share the
            # SAME token). Sending to a duplicate token delivers the identical
            # FCM twice → two identical notifications on the device. This is the
            # message-duplicate that survived the data-only + relay-skip fixes.
            # Keep the first row per unique device_token.
            _seen_tokens: set[str] = set()
            _deduped_tokens = []
            for _t in tokens:
                _tok = str(_t.get("device_token") or "")
                if not _tok or _tok in _seen_tokens:
                    continue
                _seen_tokens.add(_tok)
                _deduped_tokens.append(_t)
            if len(_deduped_tokens) != len(tokens):
                logger.info(
                    "send_push: deduped device tokens %d -> %d (same device had "
                    "multiple push_tokens rows)",
                    len(tokens),
                    len(_deduped_tokens),
                )
            tokens = _deduped_tokens
            stats["token_count"] = len(tokens)
            # iter-385: AUTHORITATIVE server-side suppression of message/group
            # pushes. The device syncs its per-type toggles on register; if a
            # recipient turned "messages"/"groups" OFF, drop their token so no
            # push (data-only OR notification-block) reaches them — the old
            # JS-only suppression was bypassed whenever the OS auto-displayed
            # the notification-block push before the app's background task ran.
            # `native_token_count` records the pre-suppression count so the
            # relay-skip gate below still fires (a SUPPRESSED native recipient
            # must NOT leak a banner via the Emergent relay fallback).
            stats["native_token_count"] = len(tokens)
            if is_message_push_global and tokens:
                _is_group_push = (
                    str(data.get("conversationType") or "").lower() == "group"
                    or str(data.get("channelId") or "").startswith("groups-")
                )
                _pref_key = "groups" if _is_group_push else "messages"
                _kept_by_pref = []
                for _t in tokens:
                    _prefs = _t.get("notification_prefs") or {}
                    if _prefs.get(_pref_key) is False:
                        logger.info(
                            "send_push: suppressing %s push for user=%s (device toggle OFF)",
                            _pref_key,
                            str(_t.get("user_id") or "")[:14],
                        )
                        continue
                    _kept_by_pref.append(_t)
                if len(_kept_by_pref) != len(tokens):
                    tokens = _kept_by_pref
                    stats["token_count"] = len(tokens)
                    stats["suppressed_by_pref"] = stats["native_token_count"] - len(tokens)
            # iter-342: per-recipient token-mapping diagnostic. Pinpoints WHY a
            # push (esp. a call-declined to the caller) delivered to nobody:
            #   • recipients with 0 tokens  → the id we were given matches no
            #     push_tokens row on either key (registration/id-form mismatch)
            #   • which key matched          → user_id (OIDC sub) vs convex_user_id
            # This makes "backend accepted 202 but caller got nothing" logs
            # self-explanatory. Kept concise (ids truncated) and INFO-level.
            try:
                recip_set = set(recipients)
                by_user_id: set[str] = set()
                by_convex_id: set[str] = set()
                for t in tokens:
                    uid = str(t.get("user_id") or "")
                    cid = str(t.get("convex_user_id") or "")
                    if uid in recip_set:
                        by_user_id.add(uid)
                    if cid in recip_set:
                        by_convex_id.add(cid)
                matched = by_user_id | by_convex_id
                missing = [r for r in recipients if r not in matched]
                stats["unmatched_recipients"] = [str(m) for m in missing]
                stats["matched_via_user_id"] = len(by_user_id)
                stats["matched_via_convex_id"] = len(by_convex_id)
                _push_type_dbg = _derive_push_routing(data).get("type") or "?"
                logger.info(
                    "[PUSH][token-map] type=%s recipients=%d matched=%d tokens=%d "
                    "via_user_id=%d via_convex_id=%d missing=%s",
                    _push_type_dbg,
                    len(recipients),
                    len(matched),
                    len(tokens),
                    len(by_user_id),
                    len(by_convex_id),
                    [str(m)[:14] + "…" for m in missing[:5]],
                )
            except Exception:
                pass
            if tokens:
                # FCM data payload: keep small + string-only. Include
                # the deeplink so the mobile tap-handler can route.
                fcm_data: dict[str, str] = {
                    "title": title,
                    "message": message,
                }
                if data.get("action_url"):
                    fcm_data["action_url"] = str(data["action_url"])
                if data.get("subtext"):
                    fcm_data["subtext"] = str(data["subtext"])
                if idempotency_key:
                    fcm_data["idempotency_key"] = idempotency_key
                # iter-197: include type/conversationId/callId so the
                # mobile tap-handler actually routes (it ignores
                # action_url-only payloads), and the in-app receive
                # listener can mark messages delivered.
                routing = _derive_push_routing(data)
                # Fall back to title/body call detection when there is
                # no parseable action_url (mirrors _resolve_android_channel).
                if "type" not in routing:
                    probe_channel = _resolve_android_channel({**data, "title": title}, None)
                    routing["type"] = "call" if probe_channel.startswith("calls") else "message"
                fcm_data.update(routing)
                # iter-217: forward the call-routing fields the mobile
                # notifee handler needs directly (Answer → /twilio-call,
                # Decline → /api/twilio/end-call). _derive_push_routing only
                # emits type/conversationId/callId, so carry the twilio_*
                # hints + callId/displayName through explicitly.
                for _k in (
                    "twilio_room_name",
                    "twilio_room_sid",
                    "twilio_is_video",
                    "twilio_caller_identity",
                    "callId",
                    "callerId",
                    "callerName",
                    "callType",
                    # Sender/caller phone (E.164) → device-contact name resolution
                    # for the incoming-call + message notifications.
                    "callerPhone",
                    "senderPhone",
                    "senderId",
                    "isConference",
                    "conversationId",
                    "displayName",
                    "backendUrl",
                    # Stream call room to JOIN (1:1 → conference "add participant").
                    "stream_room",
                    # Group-message tone routing: the app picks the group
                    # notification channel/sound when these are present.
                    "channelId",
                    "conversationType",
                    "conversationName",
                    # Group-call add-request control-push fields (Phase 2).
                    "requester_identity",
                    "requester_name",
                    "target_identity",
                    "target_name",
                    "target_phone",
                    "add_permanently",
                ):
                    _v = data.get(_k)
                    if _v is not None and _k not in fcm_data:
                        fcm_data[_k] = str(_v)
                is_call_push = routing.get("type") == "call"
                # call-cancelled / call-declined are silent control signals: send
                # data-only so Android does not auto-display a banner or play a
                # ringtone. The Kotlin SmilersCallNotificationService intercepts them
                # directly via handleIntent and handles the UI (dismiss ring, show
                # missed-call, etc.).
                is_silent_control = routing.get("type") in (
                    "call-cancelled",
                    "call-declined",
                    "call-removed",
                    "call-add-request",
                    "call-add-declined",
                )
                # MESSAGE pushes are now ALSO sent data-only. Previously they carried
                # a `notification` block, so Android auto-displayed the SERVER title
                # (the sender's Google/account name) the instant the FCM arrived —
                # AND the app's background JS task rendered a SECOND notification with
                # the recipient's saved DEVICE-CONTACT name. Result: two notifications
                # per message, one with the wrong (Google) name. Sending data-only
                # means the OS displays nothing; only the app's background task renders
                # the notification, using the correct device-contact name — exactly the
                # same reliable high-priority data-only path calls already use. Other
                # user-facing pushes (emergency/login-approval/broadcast) are NOT typed
                # "message", so they keep their notification block and stay OS-displayed.
                is_message_push = routing.get("type") == "message"

                # sml-msgdiag: log exactly how THIS push was classified so we can
                # confirm whether message pushes go out data-only (correct: app
                # renders the per-conversation channel/tone + device-contact name)
                # or with a notification block (bug: Android auto-displays the
                # server title on the default channel → universal tone + account
                # name). hasNotifBlock == not(data_only). If Convex sends a chat
                # push WITHOUT type="message"/action_url="/chat/..", this logs
                # is_message_push=False → hasNotifBlock=True and pinpoints the fix.
                _data_only_dbg = is_call_push or is_silent_control or is_message_push
                logger.info(
                    "[MSG-PUSH] type=%s is_message_push=%s is_call_push=%s "
                    "data_only=%s hasNotifBlock=%s title=%r action_url=%r channel_hint=%s",
                    routing.get("type"),
                    is_message_push,
                    is_call_push,
                    _data_only_dbg,
                    (not _data_only_dbg),
                    title,
                    data.get("action_url"),
                    data.get("channel_id"),
                )

                # iter-199: collapse Convex-trigger + caller-device call
                # pushes into ONE ring per recipient (25 s window).
                if is_call_push:
                    _call_dedup_key = str(
                        data.get("callId")
                        or data.get("twilio_room_name")
                        or data.get("conversationId")
                        or idempotency_key
                        or ""
                    )
                    kept_tokens = []
                    for t in tokens:
                        if await _recent_call_push_to_user(
                            str(t.get("user_id") or ""), _call_dedup_key
                        ):
                            logger.info(
                                f"send_push: call-push dedupe — skipping token for "
                                f"user={t.get('user_id')} call={_call_dedup_key} (already rang <8s ago)"
                            )
                            continue
                        kept_tokens.append(t)
                    tokens = kept_tokens
                    if not tokens:
                        logger.info("send_push: all call tokens deduped — nothing to send")

                # iter-262: resolve the Android channel PER TOKEN up front so we
                # can both reuse it in the send AND log the exact channel each
                # device was targeted on (useful when one device rings and
                # another plays the message tone — different registered channels).
                resolved_channels = [
                    _resolve_android_channel({**data, "title": title}, t) for t in tokens
                ]
                if tokens:
                    from collections import Counter

                    logger.info(
                        "[PUSH][channels] %s",
                        dict(Counter(resolved_channels)),
                    )

                send_tasks = [
                    _dispatch_push(
                        token_doc=t,
                        title=title,
                        message=message,
                        data=fcm_data,
                        # iter-182/262: channel resolved per token (precomputed
                        # above) — honors the device's registered (tone-versioned)
                        # channel ids, then Convex's explicit channel_id, then a
                        # type-derived default. This is what makes incoming calls
                        # RING on the calls channel instead of the message beep.
                        android_channel_id=ch,
                        # iter-197: incoming-call pushes expire fast so a
                        # device that was offline doesn't get a ghost ring
                        # minutes after the caller hung up.
                        ttl_seconds=45 if is_call_push else None,
                        # iter-221 — Issue 6/7/8 (recurring): CALL pushes are
                        # sent DATA-ONLY again so the OS does NOT auto-display a
                        # plain, button-less notification. A data-only high-
                        # priority FCM message wakes the device's background
                        # task (for backgrounded/swiped-away apps), which renders
                        # the rich notifee full-screen incoming-call UI: looping
                        # custom RINGTONE + Answer/Decline + auto-dismissing
                        # missed-call follow-up. The iter-218 notification-block
                        # approach broke this — Android showed a plain banner
                        # (no Answer/Decline) AND the background task bailed out
                        # because a notification block was present, so the ring
                        # never fired and the wrong tone played. Messages still
                        # carry a notification block so they display normally.
                        # NOTE: apps force-stopped from Settings can't run JS, so
                        # those won't ring — an accepted Android platform limit.
                        # MESSAGES are now data-only too (is_message_push) so the OS
                        # never auto-displays the server's Google-name notification;
                        # the app renders the single, device-contact-named one.
                        android_data_only=is_call_push or is_silent_control or is_message_push,
                        # iOS: suppress the OS banner for data-only message and
                        # silent-control pushes (app renders its own single
                        # notification). Calls + emergency/login alerts keep the
                        # APNS alert so they still surface on iOS.
                        include_ios_alert=not (is_message_push or is_silent_control),
                        # APNs path: only genuine silent-control pushes stay
                        # alert-less. Messages and calls MUST carry an alert or
                        # iOS displays nothing at all.
                        apns_include_alert=not is_silent_control,
                        is_call=is_call_push,
                    )
                    for t, ch in zip(tokens, resolved_channels)
                ]
                results = await asyncio.gather(*send_tasks, return_exceptions=True)
                for token_doc, result in zip(tokens, results):
                    if isinstance(result, tuple) and result[0]:
                        stats["success_count"] += 1
                        continue
                    stats["error_count"] += 1
                    error_message = (
                        result[1] if isinstance(result, tuple) else str(result)
                    )
                    if error_message:
                        stats["errors"].append(error_message[:200])
                    if await _prune_dead_token(token_doc, error_message):
                        stats["pruned_count"] += 1
                logger.info(
                    f"send_push FCM v1: {stats['success_count']}/{len(tokens)} delivered "
                    f"(recipients={len(recipients)}, pruned={stats['pruned_count']}, "
                    f"is_call={is_call_push}, data_only={is_call_push}, dispatched_tokens={len(tokens)})"
                )
        except Exception as e:
            logger.warning(f"send_push FCM v1 path failed: {e}")
            stats["errors"].append(f"FCM v1 path failed: {e}")

    # ── Secondary path: Emergent relay (only works once key is real) ──
    # iter-242: NEVER route CALL pushes through the relay. The relay delivers a
    # plain `notification` (button-less banner) that does NOT trigger the
    # data-only background task, so in deployment (real EMERGENT_PUSH_KEY) it
    # was showing callees a notification with no Answer/Decline and masking the
    # FCM v1 data-only ring. Calls are delivered exclusively via FCM v1 above.
    if is_call_push_global:
        return stats
    # iter-fork: MESSAGES also skip the Emergent relay for any NATIVE recipient
    # (one that has registered FCM tokens). The relay delivers a notification-
    # block push that Android auto-displays with the app's default label
    # ("Smilers") / the server-provided sender name — appearing as a SECOND
    # notification next to the FCM v1 DATA-ONLY push that the app itself renders
    # with the recipient's saved DEVICE-CONTACT name ("ABC Albania"). Same body,
    # two titles = the duplicate the user reported. We gate on token_count (not
    # success_count) so that even a STALE-token delivery failure can't let the
    # relay leak a duplicate banner — the app builds the single notification from
    # the data push. Web-only recipients (no FCM tokens) still fall through to
    # the relay so they aren't left without any notification.
    if is_message_push_global and stats.get("native_token_count", stats.get("token_count", 0)) > 0:
        logger.info(
            "send_push: native message recipient "
            f"(native_tokens={stats.get('native_token_count', 0)}, sent={stats.get('token_count', 0)}, "
            f"suppressed={stats.get('suppressed_by_pref', 0)}, success={stats.get('success_count', 0)}) "
            "— skipping Emergent relay to avoid a duplicate/opted-out banner"
        )
        return stats
    payload: dict = {"recipients": recipients, "data": data}
    if idempotency_key:
        payload["$idempotency_key"] = idempotency_key
    try:
        resp = await _push_client.post("/api/v1/push/trigger", json=payload)
        if resp.status_code == 401:
            # Expected while EMERGENT_PUSH_KEY=placeholder — silent.
            pass
        elif resp.status_code >= 500:
            logger.warning(f"send_push Emergent relay upstream 5xx ({resp.status_code})")
        else:
            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                logger.warning(f"send_push Emergent relay non-2xx: {e}")
    except httpx.HTTPError as e:
        logger.warning(f"send_push Emergent relay HTTP error (continuing): {e}")

    return stats


class SendPushBody(BaseModel):
    recipients: List[str]
    title: str
    message: str
    subtext: str | None = None
    image_url: str | None = None
    action_url: str | None = None
    idempotency_key: str | None = None
    # iter-130: backend can specify which Android channel to deliver into.
    # "calls" — high-importance, lockscreen public, custom call ringtone
    # "messages" — default for chat/mention notifications (high importance)
    # "default" — fallback catch-all
    channel_id: str | None = None
    # iter-253: optional structured passthrough so Convex can forward the
    # Twilio call fields (twilio_room_name, type, callId, …) on its backup
    # incoming-call push. Without these the ring shows but can't connect the
    # callee to the room. Values must be strings (FCM data is string-only).
    data: dict[str, str] | None = None


@api_router.post("/send-push-internal", status_code=202)
async def send_push_internal(
    body: SendPushBody,
    x_internal_push_token: str | None = Header(default=None),
):
    """
    Internal endpoint for Convex to trigger pushes. Authenticated by a
    shared secret (X-Internal-Push-Token header) that ONLY the Convex
    deployment knows. Mobile clients NEVER call this endpoint directly.

    iter-130: response now includes a structured `delivery` report so
    Convex (and `/api/push-debug`) can see EXACTLY what happened —
    which recipients matched stored tokens, which were unknown, how
    many FCM sends succeeded/failed. This is the only way to debug
    user_id format mismatches between mobile registration and Convex
    push triggers without rebuilding.
    """
    if not INTERNAL_PUSH_TOKEN:
        logger.warning("send-push-internal: INTERNAL_PUSH_TOKEN not configured")
        raise HTTPException(503, "Push trigger endpoint not configured")
    if not x_internal_push_token or x_internal_push_token != INTERNAL_PUSH_TOKEN:
        raise HTTPException(401, "Invalid internal push token")

    data: dict = {"title": body.title, "message": body.message}
    if body.subtext:
        data["subtext"] = body.subtext
    if body.image_url:
        data["image_url"] = body.image_url
    if body.action_url:
        data["action_url"] = body.action_url
    if body.channel_id:
        data["channel_id"] = body.channel_id
    # iter-253: forward Convex's structured call fields (twilio_room_name,
    # type, callId, twilio_caller_identity, …) so the backup incoming-call
    # push can actually connect the callee to the Twilio room.
    if body.data:
        for _k, _v in body.data.items():
            if _v is not None and _k not in ("title", "message"):
                data[_k] = str(_v)

    # iter-198: cross-trigger dedupe — the sender's device may have already
    # fired this exact push via /api/notify-event.
    _internal_is_call = str(data.get("type") or "").startswith("call") or str(
        data.get("type") or ""
    ) in ("missed-call",)
    if await _is_duplicate_push(
        body.idempotency_key, _push_content_hash(body.recipients, data),
        is_call=_internal_is_call,
    ):
        logger.info(
            f"send-push-internal: DUPLICATE suppressed title={body.title!r} "
            f"key={body.idempotency_key!r}"
        )
        return {"status": "duplicate", "delivery": {"deduped": True}}

    delivery: dict = {
        "requested_recipients": body.recipients,
        "requested_count": len(body.recipients),
        "matched_recipients": [],
        "unmatched_recipients": [],
        "fcm_success_count": 0,
        "fcm_error_count": 0,
        "fcm_errors": [],
    }

    # Look up which recipients have stored tokens BEFORE calling send_push
    # so we can populate the delivery report.
    #
    # iter-203 (critical regression fix): the lookup MUST include both
    # `user_id` AND `convex_user_id` fields. The native app registers
    # push tokens with `convex_user_id` populated (the Convex Id<"users">
    # value), while message notify-events arrive with the Convex id as
    # the recipient. The previous single-field lookup silently returned
    # zero matches, breaking ALL message + missed-call notifications
    # when the app was backgrounded or killed (logs showed
    # `tokens=0 delivered=0` for every message). `send_push` itself
    # uses the correct `$or` query — this lookup just needs to mirror it
    # so the delivery report counts and dedupe matching are accurate.
    try:
        cursor = db.push_tokens.find(
            {
                "$or": [
                    {"user_id": {"$in": body.recipients}},
                    {"convex_user_id": {"$in": body.recipients}},
                ]
            }
        )
        tokens = await cursor.to_list(length=500)
        matched_ids = set()
        for tok in tokens:
            # A token row could match via either field — record whichever
            # value appears in the recipient list so the delivery report
            # accurately reflects what the caller requested.
            requested = set(body.recipients)
            if tok.get("convex_user_id") in requested:
                matched_ids.add(tok["convex_user_id"])
            elif tok.get("user_id") in requested:
                matched_ids.add(tok["user_id"])
        delivery["matched_recipients"] = sorted(matched_ids)
        delivery["unmatched_recipients"] = sorted(
            set(body.recipients) - matched_ids
        )
        delivery["matched_token_count"] = len(tokens)
    except Exception as e:
        delivery["lookup_error"] = str(e)
        tokens = []

    logger.info(
        f"send-push-internal: recipients={delivery['requested_count']} "
        f"matched={len(delivery['matched_recipients'])} "
        f"unmatched={len(delivery['unmatched_recipients'])} "
        f"title={body.title!r} "
        # iter-197: log the ACTUAL ids — the single most important piece of
        # evidence for diagnosing Convex↔mobile user_id format mismatches.
        f"requested_ids={body.recipients} "
        f"unmatched_ids={delivery['unmatched_recipients']}"
    )

    # Now actually fire the pushes via send_push() (which itself uses
    # FCM v1 + Emergent relay)
    try:
        push_stats = await send_push(
            recipients=body.recipients,
            data=data,
            idempotency_key=body.idempotency_key,
        )
        # iter-197: REAL per-token delivery stats from send_push.
        delivery["fcm_success_count"] = push_stats.get("success_count", 0)
        delivery["fcm_error_count"] = push_stats.get("error_count", 0)
        delivery["fcm_errors"] = push_stats.get("errors", [])
        delivery["pruned_token_count"] = push_stats.get("pruned_count", 0)
    except Exception as e:
        logger.warning(f"send-push-internal: send_push raised: {e}")
        delivery["fcm_errors"].append(f"send_push raised: {e}")

    # iter-197: persist every trigger to a capped diagnostic collection so
    # /api/push-debug?triggers=N can show EXACTLY what Convex sent and what
    # happened — without needing shell access to the deployed pod.
    try:
        await db.push_trigger_log.insert_one(
            {
                "ts": datetime.now(timezone.utc),
                "title": body.title,
                "message": (body.message or "")[:200],
                "action_url": body.action_url,
                "channel_id": body.channel_id,
                "recipients": body.recipients,
                "matched": delivery["matched_recipients"],
                "unmatched": delivery["unmatched_recipients"],
                "fcm_success_count": delivery["fcm_success_count"],
                "fcm_error_count": delivery["fcm_error_count"],
                "fcm_errors": delivery["fcm_errors"][:5],
            }
        )
        total = await db.push_trigger_log.count_documents({})
        if total > 300:
            old_cursor = (
                db.push_trigger_log.find({}, {"_id": 1}).sort("ts", 1).limit(total - 300)
            )
            old_ids = [doc["_id"] async for doc in old_cursor]
            if old_ids:
                await db.push_trigger_log.delete_many({"_id": {"$in": old_ids}})
    except Exception as e:
        logger.warning(f"send-push-internal: trigger log write failed: {e}")

    return {"status": "accepted", "delivery": delivery}


class NotifyEventBody(BaseModel):
    """iter-198: client-triggered push. The SENDER's device calls this
    right after a successful Convex send/initiateCall so the recipient
    gets a push even if the Convex backend's own trigger is missing or
    misconfigured. Recipients are CONVEX user ids (the only id the
    client knows other users by); send_push matches them against the
    `convex_user_id` field captured at registration."""

    recipients: List[str]
    event: str  # "message" | "call" | "missed-call" | "call-cancelled" | "call-declined"
    title: str | None = None
    message: str | None = None
    conversation_id: str | None = None
    call_id: str | None = None
    call_type: str | None = None  # "voice" | "video"
    display_name: str | None = None
    sender_phone: str | None = None  # E.164 → receiver device-contact name resolution
    sender_id: str | None = None  # Convex user id → fallback name resolution
    conversation_type: str | None = None  # "group" | "direct" → group vs 1:1 tone
    conversation_name: str | None = None  # group name → notification title for groups
    idempotency_key: str | None = None


@api_router.post("/notify-event", status_code=202)
async def notify_event(body: NotifyEventBody):
    from urllib.parse import quote

    recipients = [str(r).strip() for r in (body.recipients or []) if str(r).strip()]
    if not recipients:
        raise HTTPException(400, "recipients is required")
    if len(recipients) > 20:
        recipients = recipients[:20]
    event = body.event if body.event in ("message", "call", "missed-call", "call-cancelled", "call-declined") else "message"
    title = (body.title or "").strip()[:120] or "Smilers"
    message = (body.message or "").strip()[:300] or (
        "Incoming call" if event == "call" else "New message"
    )
    conv = (body.conversation_id or "").strip()[:128]

    if event == "call":
        display = (body.display_name or title).strip()[:80]
        action_url = f"/call/{conv}" if conv else "/"
        params = []
        if display:
            params.append(f"displayName={quote(display)}")
        if body.call_type in ("voice", "video"):
            params.append(f"type={body.call_type}")
        if params:
            action_url += "?" + "&".join(params)
    elif event in ("missed-call", "call-cancelled", "call-declined"):
        action_url = f"/chat/{conv}" if conv else "/notifications"
    else:
        action_url = f"/chat/{conv}" if conv else "/notifications"

    data: dict = {"title": title, "message": message, "action_url": action_url}

    # iter-269: the BACKUP push path was emitting only title/message/action_url.
    # The client routes to the full-screen ringing UI (Answer/Decline,
    # lock-screen wake, looping ringtone) ONLY when it sees `type == 'call'`
    # + call metadata; without them the push fell through to the plain message
    # banner with the message tone. Mirror the call payload the Twilio/Convex
    # call path builds so a backup-triggered call still rings properly.
    if event == "call":
        data["type"] = "call"
        if body.call_id:
            data["callId"] = str(body.call_id)
        if conv:
            data["conversationId"] = conv
        if body.call_type in ("voice", "video"):
            data["callType"] = body.call_type
            data["twilio_is_video"] = "1" if body.call_type == "video" else "0"
        if display:
            data["callerName"] = display
            data["displayName"] = display
    elif event == "missed-call":
        data["type"] = "missed-call"
        if conv:
            data["conversationId"] = conv
    elif event == "call-cancelled":
        # Caller hung up during ringing — tell the callee's device to cancel
        # the ring notification immediately instead of waiting for its 35s
        # timeout, then surface a missed call.
        data["type"] = "call-cancelled"
        if body.call_id:
            data["callId"] = str(body.call_id)
        if conv:
            data["conversationId"] = conv
    elif event == "call-declined":
        # Callee tapped Decline (often from the notification tray via the
        # native CallActionReceiver) — tell the CALLER's device to stop the
        # outgoing-call UI / ringback immediately.
        data["type"] = "call-declined"
        if body.call_id:
            data["callId"] = str(body.call_id)
        if conv:
            data["conversationId"] = conv
    else:
        # MESSAGE. Set explicit type + conversationId (so the relay classifies
        # it as a data-only message → the app renders it with the DEVICE-CONTACT
        # name + custom message channel). Thread senderPhone/senderId so the
        # receiver can resolve the sender's saved name for GROUP messages (where
        # the cached conversation name is the group, not the sender).
        data["type"] = "message"
        if conv:
            data["conversationId"] = conv
        sender_phone = (body.sender_phone or "").strip()[:32]
        if sender_phone:
            data["senderPhone"] = sender_phone
        sender_id = (body.sender_id or "").strip()[:64]
        if sender_id:
            data["senderId"] = sender_id
        conv_type = (body.conversation_type or "").strip().lower()
        if conv_type in ("group", "direct"):
            data["conversationType"] = conv_type
            # Group messages get their own tone channel so they're
            # distinguishable from 1:1 messages by sound alone.
            if conv_type == "group":
                data["channelId"] = "groups-v6-group_notification"
                conv_name = (body.conversation_name or "").strip()[:120]
                if conv_name:
                    data["conversationName"] = conv_name

    if await _is_duplicate_push(
        body.idempotency_key, _push_content_hash(recipients, data),
        is_call=event in ("call", "missed-call", "call-cancelled", "call-declined"),
    ):
        logger.info(f"notify-event: DUPLICATE suppressed title={title!r} key={body.idempotency_key!r}")
        return {"status": "duplicate"}

    stats: dict = {}
    try:
        stats = await send_push(
            recipients=recipients,
            data=data,
            idempotency_key=body.idempotency_key,
        )
    except Exception as e:
        logger.warning(f"notify-event: send_push raised: {e}")
        stats = {"errors": [str(e)]}

    logger.info(
        f"notify-event: event={event} recipients={recipients} "
        f"tokens={stats.get('token_count', 0)} delivered={stats.get('success_count', 0)} "
        f"title={title!r}"
    )

    # Same diagnostic trail as Convex triggers — visible via
    # /api/push-debug?triggers=N with source="client".
    try:
        await db.push_trigger_log.insert_one(
            {
                "ts": datetime.now(timezone.utc),
                "source": "client",
                "event": event,
                "title": title,
                "message": message[:200],
                "action_url": action_url,
                "recipients": recipients,
                "fcm_success_count": stats.get("success_count", 0),
                "fcm_error_count": stats.get("error_count", 0),
                "fcm_errors": (stats.get("errors") or [])[:5],
                "token_count": stats.get("token_count", 0),
                # iter-342: id-mapping diagnostic — which recipients had NO
                # matching device token, and which key the matches came from.
                "unmatched_recipients": stats.get("unmatched_recipients", []),
                "matched_via_user_id": stats.get("matched_via_user_id", 0),
                "matched_via_convex_id": stats.get("matched_via_convex_id", 0),
            }
        )
    except Exception as e:
        logger.warning(f"notify-event: trigger log write failed: {e}")

    return {
        "status": "accepted",
        "token_count": stats.get("token_count", 0),
        "delivered": stats.get("success_count", 0),
    }


@api_router.get("/push-debug")
async def push_debug(user_id: str | None = None, triggers: int = 0):
    """
    iter-130 diagnostic — no auth, read-only. Returns what's registered
    for the given user_id (or summary stats if user_id omitted) so we
    can verify the format Convex sends matches what mobile registered.

    iter-197: pass ?triggers=N to ALSO get the last N send-push-internal
    triggers (what Convex sent, which recipients matched, FCM results).

    Usage from mobile:
      GET /api/push-debug?user_id=<userInfo.sub>
      → { user_id, token_count, tokens: [{platform, device_token: <preview>, updated_at}] }

    Usage from terminal:
      curl https://app-migration-75.emergent.host/api/push-debug?triggers=20
      → { total_tokens, ..., recent_triggers: [...] }
    """
    recent_triggers = []
    if triggers > 0:
        try:
            cursor = db.push_trigger_log.find({}).sort("ts", -1).limit(min(triggers, 100))
            rows = await cursor.to_list(length=100)
            for r in rows:
                r.pop("_id", None)
                if r.get("ts"):
                    r["ts"] = r["ts"].isoformat()
                recent_triggers.append(r)
        except Exception as e:
            recent_triggers = [{"error": f"trigger lookup failed: {e}"}]

    if user_id:
        try:
            cursor = db.push_tokens.find({"user_id": user_id})
            rows = await cursor.to_list(length=10)
        except Exception as e:
            return {"user_id": user_id, "error": f"lookup failed: {e}"}
        return {
            "user_id": user_id,
            "token_count": len(rows),
            "tokens": [
                {
                    "platform": r.get("platform"),
                    "device_token_preview": (r.get("device_token") or "")[:16] + "…",
                    # iter-199: visibility into whether this registration
                    # carried the Convex user id (required for client-
                    # triggered recipient matching).
                    "has_convex_id": bool(r.get("convex_user_id")),
                    # iter-200: registered channel ids — pushes targeting a
                    # channel that doesn't exist on the device can be
                    # silently dropped, so this matters for diagnosis.
                    "call_channel_id": r.get("call_channel_id"),
                    "message_channel_id": r.get("message_channel_id"),
                    "updated_at": (
                        r["updated_at"].isoformat()
                        if r.get("updated_at")
                        else None
                    ),
                }
                for r in rows
            ],
            **({"recent_triggers": recent_triggers} if triggers > 0 else {}),
        }
    # Summary mode
    try:
        total = await db.push_tokens.count_documents({})
        cursor = db.push_tokens.find({}, {"user_id": 1}).limit(50)
        rows = await cursor.to_list(length=50)
        unique = sorted({r["user_id"] for r in rows if r.get("user_id")})
    except Exception as e:
        return {"error": f"lookup failed: {e}"}
    return {
        "total_tokens": total,
        "unique_user_ids_in_first_50": len(unique),
        "sample_user_ids": unique[:10],
        **({"recent_triggers": recent_triggers} if triggers > 0 else {}),
    }


@api_router.post("/self-test-push", status_code=202)
async def self_test_push(body: dict):
    """
    Mobile diagnostic endpoint — sends a push notification to the calling
    user as a smoke test through BOTH FCM v1 (primary) and Emergent relay
    (secondary). Returns the FCM v1 result inline so the mobile UI can
    distinguish "queued" vs "delivered to FCM" vs "FCM rejected".
    """
    user_id = (body or {}).get("user_id")
    if not user_id:
        raise HTTPException(400, "user_id is required")

    fcm_result: dict = {"attempted": False, "success_count": 0, "error_count": 0, "errors": []}

    if _ensure_firebase_initialized():
        try:
            cursor = db.push_tokens.find({"user_id": user_id})
            tokens = await cursor.to_list(length=10)
            fcm_result["attempted"] = len(tokens) > 0
            fcm_result["token_count"] = len(tokens)
            for t in tokens:
                ok, msg = await fcm_send_v1(
                    device_token=t["device_token"],
                    title="Smilers self-test",
                    message="If you can read this, FCM v1 push delivery works.",
                    data={"type": "diagnostic-fcm-v1-self-test", "action_url": "/notifications"},
                    # iter-182: token-aware channel (was hardcoded legacy
                    # 'messages' which no build ever creates).
                    android_channel_id=_resolve_android_channel(
                        {"title": "Smilers self-test"}, t
                    ),
                )
                if ok:
                    fcm_result["success_count"] += 1
                else:
                    fcm_result["error_count"] += 1
                    if msg:
                        fcm_result["errors"].append(msg[:200])
        except Exception as e:
            fcm_result["errors"].append(f"FCM v1 path raised: {e}")

    # Also fire the Emergent relay (silent failure mode while placeholder)
    try:
        await send_push(
            recipients=[user_id],
            data={
                "title": "Smilers self-test",
                "message": "If you can read this, push notifications are working on this device.",
                "action_url": "/notifications",
            },
            idempotency_key=f"self-test-{user_id}-{uuid.uuid4().hex[:8]}",
        )
    except Exception as e:
        logger.warning(f"self-test-push: send_push raised: {e}")

    return {"status": "accepted", "fcm": fcm_result}


# ============================================================================
# iter-218: DIARY — private "note to self" feature.
#
# A purely additive feature backed by MongoDB. No Convex involvement (the
# web team owns Convex; we don't block on them). Each diary entry is
# scoped to a single user via their OIDC sub. Supports text + optional
# attachment URL/type so users can also save voice notes / images by
# uploading them elsewhere and referencing them here.
# ============================================================================


class DiaryEntryIn(BaseModel):
    user_id: str  # OIDC sub of the diary owner
    text: Optional[str] = None
    attachment_url: Optional[str] = None
    attachment_type: Optional[str] = None  # 'image' | 'audio' | 'video' | 'file'
    attachment_name: Optional[str] = None
    attachment_duration_ms: Optional[int] = None
    client_id: Optional[str] = None  # optional idempotency token from device


class DiaryEntryOut(BaseModel):
    id: str
    user_id: str
    text: Optional[str] = None
    attachment_url: Optional[str] = None
    attachment_type: Optional[str] = None
    attachment_name: Optional[str] = None
    attachment_duration_ms: Optional[int] = None
    created_at: datetime
    updated_at: datetime


def _diary_doc_to_out(doc: dict) -> DiaryEntryOut:
    return DiaryEntryOut(
        id=str(doc.get("_id", doc.get("id", ""))),
        user_id=doc.get("user_id", ""),
        text=doc.get("text"),
        attachment_url=doc.get("attachment_url"),
        attachment_type=doc.get("attachment_type"),
        attachment_name=doc.get("attachment_name"),
        attachment_duration_ms=doc.get("attachment_duration_ms"),
        created_at=doc.get("created_at", datetime.utcnow()),
        updated_at=doc.get("updated_at", doc.get("created_at", datetime.utcnow())),
    )


@api_router.post("/diary", response_model=DiaryEntryOut)
async def create_diary_entry(payload: DiaryEntryIn):
    """Append a new diary entry. Requires `user_id` (OIDC sub) and at
    minimum one of `text` or `attachment_url`."""
    if not payload.user_id or not payload.user_id.strip():
        raise HTTPException(status_code=400, detail="user_id required")
    if not (payload.text and payload.text.strip()) and not (
        payload.attachment_url and payload.attachment_url.strip()
    ):
        raise HTTPException(
            status_code=400, detail="text or attachment_url required"
        )
    now = datetime.utcnow()
    entry_id = str(uuid.uuid4())
    doc = {
        "_id": entry_id,
        "user_id": payload.user_id.strip(),
        "text": (payload.text or "").strip() or None,
        "attachment_url": (payload.attachment_url or "").strip() or None,
        "attachment_type": payload.attachment_type or None,
        "attachment_name": payload.attachment_name or None,
        "attachment_duration_ms": payload.attachment_duration_ms or None,
        "client_id": payload.client_id or None,
        "created_at": now,
        "updated_at": now,
    }
    # Idempotency: if client_id provided + already inserted, return existing.
    if payload.client_id:
        existing = await db.diary_entries.find_one(
            {"user_id": doc["user_id"], "client_id": payload.client_id}
        )
        if existing:
            return _diary_doc_to_out(existing)
    await db.diary_entries.insert_one(doc)
    return _diary_doc_to_out(doc)


@api_router.get("/diary")
async def list_diary_entries(user_id: str, limit: int = 200):
    """List diary entries for a user, newest first. Capped at 1000 to
    avoid runaway responses."""
    if not user_id or not user_id.strip():
        raise HTTPException(status_code=400, detail="user_id required")
    capped = max(1, min(limit, 1000))
    cursor = (
        db.diary_entries.find({"user_id": user_id.strip()})
        .sort("created_at", -1)
        .limit(capped)
    )
    docs = await cursor.to_list(length=capped)
    return [_diary_doc_to_out(d) for d in docs]


@api_router.delete("/diary/{entry_id}")
async def delete_diary_entry(entry_id: str, user_id: str):
    """Delete a diary entry. Requires both `entry_id` (path) and
    `user_id` (query) so users cannot delete other users' entries."""
    if not user_id or not user_id.strip():
        raise HTTPException(status_code=400, detail="user_id required")
    result = await db.diary_entries.delete_one(
        {"_id": entry_id, "user_id": user_id.strip()}
    )
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"deleted": True, "id": entry_id}


# ============================================================================
# iter-218: SAFE BROWSING — auto-detect malicious links/files.
#
# Uses the Google Safe Browsing v4 API (key already in env). The mobile
# client posts a URL; we return whether Google has it flagged. The
# client masks the bubble locally if so — no Convex mutation needed.
# Results are cached client-side, and we also keep a short-lived
# in-process cache here to avoid hammering Google for repeated checks.
# ============================================================================


class SafeBrowsingCheckRequest(BaseModel):
    urls: List[str]


class SafeBrowsingMatch(BaseModel):
    url: str
    threat_type: str
    platform_type: Optional[str] = None


class SafeBrowsingCheckResponse(BaseModel):
    matches: List[SafeBrowsingMatch] = Field(default_factory=list)


# Short-lived (10 min) in-process cache: url → bool flagged.
_SAFE_BROWSING_CACHE: dict[str, tuple[float, Optional[SafeBrowsingMatch]]] = {}
_SAFE_BROWSING_CACHE_TTL_SEC = 600
_SAFE_BROWSING_API_URL = (
    "https://safebrowsing.googleapis.com/v4/threatMatches:find?key="
)


@api_router.post("/safe-browsing/check", response_model=SafeBrowsingCheckResponse)
async def safe_browsing_check(payload: SafeBrowsingCheckRequest, request: Request):
    """Check up to 100 URLs against Google Safe Browsing. Returns the
    subset that Google flagged. Empty `matches` ≡ all safe."""
    # Per-IP rate limit (endpoint is unauthenticated; protects Google quota).
    _ok, _retry = await _rate_limit_ok_async("safe_browsing", _client_ip_of(request), 60, 60)
    if not _ok:
        raise HTTPException(
            status_code=429,
            detail="Too many URL safety checks; please slow down.",
            headers={"Retry-After": str(_retry)},
        )

    api_key = os.environ.get("GOOGLE_SAFE_BROWSING_API_KEY", "").strip()
    if not api_key:
        # We never want to *block* delivery when the API key is missing —
        # just return empty so the client renders the URL normally.
        return SafeBrowsingCheckResponse(matches=[])

    urls = [u.strip() for u in (payload.urls or []) if u and u.strip()]
    urls = [u for u in urls if u.startswith(("http://", "https://"))]
    urls = list(dict.fromkeys(urls))[:100]  # dedupe + cap
    if not urls:
        return SafeBrowsingCheckResponse(matches=[])

    # Cache hits short-circuit Google calls.
    import time
    now = time.time()
    cached: List[SafeBrowsingMatch] = []
    to_check: List[str] = []
    for url in urls:
        cache_entry = _SAFE_BROWSING_CACHE.get(url)
        if cache_entry and now - cache_entry[0] < _SAFE_BROWSING_CACHE_TTL_SEC:
            if cache_entry[1] is not None:
                cached.append(cache_entry[1])
        else:
            to_check.append(url)

    if not to_check:
        return SafeBrowsingCheckResponse(matches=cached)

    # Google Safe Browsing v4 threatMatches:find
    body = {
        "client": {"clientId": "smilers-mobile", "clientVersion": "2.1.88"},
        "threatInfo": {
            "threatTypes": [
                "MALWARE",
                "SOCIAL_ENGINEERING",
                "UNWANTED_SOFTWARE",
                "POTENTIALLY_HARMFUL_APPLICATION",
            ],
            "platformTypes": ["ANY_PLATFORM"],
            "threatEntryTypes": ["URL"],
            "threatEntries": [{"url": u} for u in to_check],
        },
    }
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.post(
                _SAFE_BROWSING_API_URL + api_key, json=body
            )
            resp.raise_for_status()
            data = resp.json() or {}
    except Exception as e:  # noqa: BLE001
        logger.warning(f"safe-browsing: upstream failed: {e}")
        # Fail open — never block messages if Google is unreachable.
        return SafeBrowsingCheckResponse(matches=cached)

    new_matches: List[SafeBrowsingMatch] = []
    matches_raw = data.get("matches", []) or []
    for m in matches_raw:
        url = (m.get("threat") or {}).get("url") or ""
        if not url:
            continue
        match = SafeBrowsingMatch(
            url=url,
            threat_type=m.get("threatType", "UNKNOWN"),
            platform_type=m.get("platformType"),
        )
        new_matches.append(match)
        _SAFE_BROWSING_CACHE[url] = (now, match)
    # Negative cache for non-matched URLs in this batch.
    matched_urls = {m.url for m in new_matches}
    for u in to_check:
        if u not in matched_urls:
            _SAFE_BROWSING_CACHE[u] = (now, None)

    return SafeBrowsingCheckResponse(matches=cached + new_matches)


# ============================================================================
# AI Safety Shield — text-based scam / phishing / fake-investment detection.
#
# The URL/file layer (Safe Browsing + heuristics) only catches malicious
# links. This LLM classifier catches TEXT cons that carry no link at all:
# fake prize/lottery wins, crypto & investment fraud, account-phishing
# ("your account is suspended, verify now"), impersonation, and
# advance-fee / "send money" scams.
#
# Verdict is CONSERVATIVE by design (user pref, iter): only clear scams
# are flagged so ordinary chat between friends is never removed. The
# mobile client masks the bubble locally when `is_scam` is true — no
# Convex mutation, the original message is preserved server-side.
# ============================================================================

_SCAN_TEXT_CACHE: dict[str, "ScanTextResponse"] = {}
_SCAN_TEXT_CACHE_MAX = 1000


class ScanTextRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


class ScanTextResponse(BaseModel):
    is_scam: bool = False
    category: str = "safe"  # scam | phishing | investment_fraud | safe
    reason: str = ""


_SCAN_TEXT_SYSTEM = (
    "You are a conservative fraud-detection classifier for a personal messaging app. "
    "Decide ONLY whether an incoming chat message is a CLEAR scam that should be hidden "
    "from the recipient for their safety. Be very conservative: normal conversation, "
    "jokes, opinions, business talk, links to legitimate sites, and money talk between "
    "friends are NOT scams. Flag a message ONLY when it clearly matches one of these: "
    "(1) fake prize/lottery/gift-card winnings requiring action or fees; "
    "(2) crypto or investment fraud promising guaranteed/high returns, 'double your money', signals groups; "
    "(3) account-phishing pretending to be a bank/service telling the user to verify/unlock/confirm credentials or a code; "
    "(4) advance-fee / 'send money' / wire-transfer cons, romance-scam money requests, impersonation of officials. "
    "When unsure, respond safe. "
    "Respond with ONLY a compact JSON object, no markdown, of the form: "
    '{"is_scam": <true|false>, "category": "<scam|phishing|investment_fraud|safe>", "reason": "<short user-facing reason, max 100 chars>"}'
)


@api_router.post("/scan-text", response_model=ScanTextResponse)
async def scan_text(payload: ScanTextRequest, request: Request) -> ScanTextResponse:
    """Classify a chat message as a clear scam/phishing/investment-fraud (or safe)."""
    _ok, _retry = await _rate_limit_ok_async("scan_text", _client_ip_of(request), 90, 60)
    if not _ok:
        raise HTTPException(
            status_code=429,
            detail="Too many safety checks; please slow down.",
            headers={"Retry-After": str(_retry)},
        )

    text = (payload.text or "").strip()
    # Too short to be a meaningful scam — skip the LLM call entirely.
    if len(text) < 12:
        return ScanTextResponse(is_scam=False, category="safe", reason="")

    cache_key = text[:4000]
    cached = _SCAN_TEXT_CACHE.get(cache_key)
    if cached is not None:
        return cached

    api_key = os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        # Fail open — never block delivery when the key is missing.
        return ScanTextResponse(is_scam=False, category="safe", reason="")

    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=f"smilers-scan-{uuid.uuid4()}",
            system_message=_SCAN_TEXT_SYSTEM,
        ).with_model("gemini", "gemini-2.5-flash")
        raw = (await chat.send_message(UserMessage(text=text[:4000]))).strip()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"scan-text: LLM failed: {e}")
        return ScanTextResponse(is_scam=False, category="safe", reason="")

    result = _parse_scan_text_verdict(raw)
    # Bounded LRU-ish cache.
    if len(_SCAN_TEXT_CACHE) >= _SCAN_TEXT_CACHE_MAX:
        try:
            _SCAN_TEXT_CACHE.pop(next(iter(_SCAN_TEXT_CACHE)))
        except StopIteration:
            pass
    _SCAN_TEXT_CACHE[cache_key] = result
    return result


def _parse_scan_text_verdict(raw: str) -> ScanTextResponse:
    """Parse the model's JSON verdict, tolerating markdown fences / stray text."""
    import json as _json
    import re as _re

    if not raw:
        return ScanTextResponse()
    cleaned = raw.strip()
    # Strip ```json ... ``` fences if present.
    fence = _re.search(r"\{.*\}", cleaned, _re.DOTALL)
    if fence:
        cleaned = fence.group(0)
    try:
        data = _json.loads(cleaned)
    except Exception:  # noqa: BLE001
        return ScanTextResponse()
    is_scam = bool(data.get("is_scam"))
    category = str(data.get("category") or ("scam" if is_scam else "safe")).strip().lower()
    if category not in {"scam", "phishing", "investment_fraud", "safe"}:
        category = "scam" if is_scam else "safe"
    reason = str(data.get("reason") or "").strip()[:100]
    if not is_scam:
        category = "safe"
        reason = ""
    return ScanTextResponse(is_scam=is_scam, category=category, reason=reason)


# ── App version / update banner (Play Store + App Store) ──────────────────
# The mobile client calls GET /api/app-version on launch and, if its bundled
# version is older than `latestVersion`, shows a dismissible "Update available"
# banner linking to the correct store. Bump these when a new build ships —
# either via env vars (no redeploy of code) or by editing the defaults here.
#   - SMILERS_LATEST_VERSION   : latest published version, e.g. "2.3.0"
#   - SMILERS_MIN_VERSION      : oldest still-supported version (below → force)
#   - SMILERS_ANDROID_URL      : Play Store listing (or direct APK) URL
#   - SMILERS_IOS_URL          : App Store listing URL (empty until live)
#   - SMILERS_FORCE_UPDATE     : "1" to force-block below latestVersion
#   - SMILERS_RELEASE_NOTES    : short changelog shown in the banner
_ANDROID_PACKAGE = "com.smilers.app"
APP_VERSION_CONFIG = {
    "latestVersion": os.environ.get("SMILERS_LATEST_VERSION", "2.2.20"),
    "minSupportedVersion": os.environ.get("SMILERS_MIN_VERSION", "0.0.0"),
    "androidUrl": os.environ.get(
        "SMILERS_ANDROID_URL",
        f"https://play.google.com/store/apps/details?id={_ANDROID_PACKAGE}",
    ),
    "iosUrl": os.environ.get("SMILERS_IOS_URL", ""),
    "forceUpdate": os.environ.get("SMILERS_FORCE_UPDATE", "0") == "1",
    "releaseNotes": os.environ.get(
        "SMILERS_RELEASE_NOTES",
        "Google Play in-app updates so you're always on the latest version\n"
        "Noise cancellation for voice note recordings\n"
        "New App Version & Updates screen with manual update check\n"
        "Performance and stability improvements",
    ),
}


class AppVersionResponse(BaseModel):
    latestVersion: str
    minSupportedVersion: str
    androidUrl: str
    iosUrl: str
    forceUpdate: bool
    releaseNotes: str


@api_router.get("/app-version", response_model=AppVersionResponse)
async def get_app_version():
    """Latest published app version + store links for the in-app update banner.
    Values are env-overridable so a new release can be announced without a code
    change (set SMILERS_LATEST_VERSION and restart the backend)."""
    return AppVersionResponse(**APP_VERSION_CONFIG)


# ── Health / readiness ────────────────────────────────────────────────────
# GET /api/health — at-a-glance readiness of each integration so a silent
# misconfiguration (e.g. a dropped API key) is obvious right after a deploy.
# `status` is "ok" when nothing critical is missing, else "degraded".
@api_router.get("/health")
async def health_readiness():
    def _present(var: str) -> bool:
        return bool(os.environ.get(var, "").strip())

    # MongoDB ping (best-effort, short timeout).
    mongo_ok = False
    try:
        await db.command("ping")
        mongo_ok = True
    except Exception as e:  # noqa: BLE001
        logger.warning(f"health: mongo ping failed: {e}")

    # Rate-limit store backend.
    if _REDIS_URL and not _redis_disabled:
        r = _get_rate_redis()
        rate_store = "in_memory"
        if r is not None:
            try:
                await r.ping()
                rate_store = "redis"
            except Exception as e:  # noqa: BLE001
                logger.warning(f"health: redis ping failed: {e}")
                rate_store = "in_memory_fallback"
    else:
        rate_store = "in_memory"

    integrations = {
        "safe_browsing": _present("GOOGLE_SAFE_BROWSING_API_KEY"),
        "openai_transcription": _present("OPENAI_API_KEY"),
        "llm_translation": _present("EMERGENT_LLM_KEY"),
        "twilio_video": _present("TWILIO_ACCOUNT_SID")
        and _present("TWILIO_API_KEY_SID")
        and _present("TWILIO_API_KEY_SECRET"),
        "push": _present("EMERGENT_PUSH_KEY"),
        "mongo": mongo_ok,
    }

    # Critical integrations whose absence should flip status to degraded.
    critical = ["safe_browsing", "mongo"]
    degraded = [k for k in critical if not integrations[k]]

    uptime_seconds = int((datetime.now(timezone.utc) - _SERVER_STARTED_AT).total_seconds())

    return {
        "status": "ok" if not degraded else "degraded",
        "degraded": degraded,
        "integrations": integrations,
        "rate_limit_store": rate_store,
        "version": APP_VERSION_CONFIG.get("latestVersion"),
        # Push-pipeline build marker — lets us verify (by curling this deployed
        # /api/health) that the message data-only + Emergent-relay-skip fixes are
        # actually live on the relay the app talks to. Bump `build` on each fix.
        "push_pipeline": {
            "build": "iter-fork-call-dedupe-6s+ios-msg-noalert-v3",
            # iOS delivery transport. iOS registers a RAW APNs token, which
            # Firebase rejects ("not a valid FCM registration token"), so iOS
            # pushes go straight to Apple once the .p8 key is configured.
            # Until then apns_configured() is False and iOS silently falls back
            # to the failing FCM path — which is exactly what this field makes
            # visible, so nobody has to send a test message and read error logs
            # to find out whether the credentials actually reached the app.
            "ios_transport": "apns-direct" if apns_configured() else "fcm-fallback",
            "apns_configured": apns_configured(),
            "apns_env": "sandbox" if os.environ.get("APNS_USE_SANDBOX") == "1" else "production",
            "apns_topic": APNS_TOPIC,
            "message_data_only": True,
            "message_skips_emergent_relay_for_native": True,
            "call_dedupe_window_seconds": 6,
            "ios_message_apns_alert_suppressed": True,
        },
        "startedAt": _SERVER_STARTED_AT.isoformat(),
        "uptimeSeconds": uptime_seconds,
    }


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def _warn_missing_integration_keys():
    """Surface silent-outage risks at boot. A missing Safe Browsing key makes
    /api/safe-browsing/check fail-open (all links treated as safe), which is
    exactly the kind of regression that hides until a user notices."""
    if not os.environ.get("GOOGLE_SAFE_BROWSING_API_KEY", "").strip():
        logger.warning(
            "⚠️  GOOGLE_SAFE_BROWSING_API_KEY is missing — malicious-link "
            "detection is DISABLED (endpoint will treat every URL as safe)."
        )
    else:
        logger.info("Safe Browsing key present — malicious-link detection active.")
    # Task 3: start the daily stale push-token purge (runs once now, then daily).
    try:
        asyncio.create_task(_push_token_purge_loop())
        logger.info(f"push-token purge loop started (stale threshold = {_STALE_TOKEN_DAYS}d)")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"could not start push-token purge loop: {e}")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
