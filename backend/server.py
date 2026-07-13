from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import asyncio
import re
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone, timedelta
from emergentintegrations.llm.chat import LlmChat, UserMessage

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

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


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

    async def _dispatch():
        try:
            stats = await send_push(
                recipients=payload.callee_identities,
                data=push_data,
                idempotency_key=f"twilio-call:{payload.conversation_id}",
            )
            logger.info(
                f"webrtc-ring pushed to {len(payload.callee_identities)} callees: "
                f"tokens={stats.get('token_count')} ok={stats.get('success_count')} "
                f"err={stats.get('error_count')} backendUrl={backend_url}"
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"webrtc-ring: push failed (non-fatal): {exc}")

    asyncio.create_task(_dispatch())
    return {"scheduled": True, "conversation_id": payload.conversation_id}



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
        participants.append(
            {
                "identity": identity,
                "display_name": d.get("display_name"),
                "phone_number": phone if can_see_phone else None,
                "hide_number": hide,
                "added_by": added_by,
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


@api_router.post("/translate", response_model=TranslationResponse)
async def translate_text(payload: TranslationRequest):
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
async def transcribe_media(payload: TranscriptionRequest) -> TranscriptionResponse:
    """Download the media at ``payload.media_url`` and transcribe it with
    OpenAI Whisper. Supports voice notes (.m4a/.mp3/.webm/.wav) and short
    videos (.mp4/.mov) — Whisper extracts the audio internally."""

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

    return await _run_whisper(content, suffix, payload.language_hint, api_key)


@api_router.post("/transcribe/upload", response_model=TranscriptionResponse)
async def transcribe_uploaded_media(
    file: UploadFile = File(...),
    language_hint: str | None = Form(default=None),
) -> TranscriptionResponse:
    """Multipart-upload variant of /transcribe — used by the mobile client
    when the message is E2EE-encrypted (mediaUrl points at ciphertext, so
    fetching by URL is useless). The mobile sends the PLAINTEXT audio
    bytes directly here, before Convex upload + encryption."""

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

    return await _run_whisper(content, suffix, language_hint, api_key)


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
            if language_hint:
                kwargs["language"] = language_hint
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

import httpx
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
                        alert=fcm_messaging.ApsAlert(title=title, body=message),
                        sound="default",
                        badge=1,
                        content_available=True,
                    ),
                ),
                headers={"apns-priority": "10"},
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
    elif explicit_type in ("call-cancelled", "call-declined"):
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


async def _recent_call_push_to_user(token_user_id: str) -> bool:
    """
    iter-199: SEMANTIC call-push dedupe. Incoming-call pushes can originate
    from BOTH the Convex trigger (recipient keyed by OIDC sub) and the
    caller's device (recipient keyed by Convex id) — different idempotency
    keys and different action_urls, so the generic dedupe can't catch the
    pair. Collapse them here: at most ONE call push per recipient (token
    owner) per 8 seconds.

    iter-A6b: window reduced from 25s → 8s. The original 25s window was
    suppressing legitimate caller retries (e.g. callee rejected, caller
    tapped again) — the user's phone would never ring on the second
    attempt. 8s is enough to catch the dual-trigger duplicate (Convex +
    caller device fire within ~1s of each other) while letting genuine
    user-initiated retries through.
    """
    key = f"callpush:{token_user_id}"
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
            stats["token_count"] = len(tokens)
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
                    "isConference",
                    "conversationId",
                    "displayName",
                    "backendUrl",
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
                is_silent_control = routing.get("type") in ("call-cancelled", "call-declined")

                # iter-199: collapse Convex-trigger + caller-device call
                # pushes into ONE ring per recipient (25 s window).
                if is_call_push:
                    kept_tokens = []
                    for t in tokens:
                        if await _recent_call_push_to_user(str(t.get("user_id") or "")):
                            logger.info(
                                f"send_push: call-push dedupe — skipping token for "
                                f"user={t.get('user_id')} (already rang <25s ago)"
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
                    fcm_send_v1(
                        device_token=t["device_token"],
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
                        android_data_only=is_call_push or is_silent_control,
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
    if await _is_duplicate_push(
        body.idempotency_key, _push_content_hash(body.recipients, data)
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

    if await _is_duplicate_push(
        body.idempotency_key, _push_content_hash(recipients, data)
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
async def safe_browsing_check(payload: SafeBrowsingCheckRequest):
    """Check up to 100 URLs against Google Safe Browsing. Returns the
    subset that Google flagged. Empty `matches` ≡ all safe."""
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
    "latestVersion": os.environ.get("SMILERS_LATEST_VERSION", "2.2.17"),
    "minSupportedVersion": os.environ.get("SMILERS_MIN_VERSION", "0.0.0"),
    "androidUrl": os.environ.get(
        "SMILERS_ANDROID_URL",
        f"https://play.google.com/store/apps/details?id={_ANDROID_PACKAGE}",
    ),
    "iosUrl": os.environ.get("SMILERS_IOS_URL", ""),
    "forceUpdate": os.environ.get("SMILERS_FORCE_UPDATE", "0") == "1",
    "releaseNotes": os.environ.get("SMILERS_RELEASE_NOTES", ""),
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


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
