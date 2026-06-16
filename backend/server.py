from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form
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
    callee_identities: List[str] = Field(default_factory=list, description="Stable user IDs of all invitees")
    is_video: bool = True
    conversation_id: Optional[str] = Field(None, description="Convex conversation _id — used for room naming + push routing")
    room_name: Optional[str] = Field(None, description="Optional explicit room name; otherwise generated")


class TwilioInitiateCallResponse(BaseModel):
    room_name: str
    room_sid: str
    room_status: str
    media_region: Optional[str]
    caller_identity: str
    callee_identities: List[str]
    # Token for the caller — saves a round trip; callees fetch their own.
    caller_token: str
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
                # Don't auto-record — Phase A.4 will start recording explicitly.
                record_participants_on_connect=False,
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
                "created_at": datetime.now(timezone.utc),
                "status": room.status,
            }
        )
    except Exception:
        logger.warning("twilio-initiate-call: persisting call record to MongoDB failed (non-fatal)")

    return TwilioInitiateCallResponse(
        room_name=room_name,
        room_sid=room.sid,
        room_status=room.status,
        media_region=getattr(room, "media_region", None) or _TWILIO_MEDIA_REGION,
        caller_identity=payload.caller_identity,
        callee_identities=payload.callee_identities,
        caller_token=caller_jwt,
        server_time=datetime.now(timezone.utc).isoformat(),
    )


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
        ).with_model("gemini", "gemini-3-flash-preview")
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
            notification=fcm_messaging.Notification(title=title, body=message),
            data=safe_data,
            android=fcm_messaging.AndroidConfig(
                priority="high",
                # iter-197: call pushes carry a short TTL so a missed
                # delivery window doesn't produce a ghost ring minutes
                # later when the device comes back online.
                **({"ttl": timedelta(seconds=ttl_seconds)} if ttl_seconds else {}),
                notification=fcm_messaging.AndroidNotification(
                    channel_id=android_channel_id,
                    sound="default",
                    default_vibrate_timings=True,
                    default_light_settings=True,
                    visibility="public",
                    priority="high",
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
    is_call = (
        explicit.startswith("calls")
        or str(data.get("type") or "").strip() in ("call", "incoming-call")
        or action_url.startswith("/call")
        or bool(re.search(r"\b(incoming|missed)\b[^.]*\bcall", haystack, re.IGNORECASE))
    )
    if token_doc:
        override = token_doc.get("call_channel_id" if is_call else "message_channel_id")
        if override:
            return str(override)
    if explicit:
        return explicit
    return "calls" if is_call else "messages-v3"


def _derive_push_routing(data: dict) -> dict[str, str]:
    """
    iter-197: synthesize the routing fields the MOBILE tap-handler expects
    (`type`, `conversationId`, `callId`, `displayName`) from the
    Convex-provided `action_url`. Without these, taps on backend pushes
    did NOTHING because the handler only routes on `payload.type`.
    """
    out: dict[str, str] = {}
    action_url = str(data.get("action_url") or "")
    if not action_url.startswith("/"):
        return out
    path, _, query = action_url.partition("?")
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 2 and parts[0] == "call":
        out["type"] = "call"
        out["conversationId"] = parts[1]
        out["callId"] = parts[1]
    elif len(parts) >= 2 and parts[0] == "chat":
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
    owner) per 25 seconds.
    """
    key = f"callpush:{token_user_id}"
    now = datetime.now(timezone.utc)
    try:
        existing = await db.push_dedupe.find_one({"k": key})
        if existing and existing.get("ts"):
            ts = existing["ts"]
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if (now - ts).total_seconds() < 25:
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
                is_call_push = routing.get("type") == "call"

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

                send_tasks = [
                    fcm_send_v1(
                        device_token=t["device_token"],
                        title=title,
                        message=message,
                        data=fcm_data,
                        # iter-182: channel resolved per token — honors the
                        # device's registered (tone-versioned) channel ids,
                        # then Convex's explicit channel_id, then a
                        # type-derived default. This is what makes incoming
                        # calls RING on the calls channel instead of landing
                        # in "messages-v3" with a single short beep.
                        android_channel_id=_resolve_android_channel(
                            {**data, "title": title}, t
                        ),
                        # iter-197: incoming-call pushes expire fast so a
                        # device that was offline doesn't get a ghost ring
                        # minutes after the caller hung up.
                        ttl_seconds=45 if is_call_push else None,
                    )
                    for t in tokens
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
                    f"(recipients={len(recipients)}, pruned={stats['pruned_count']})"
                )
        except Exception as e:
            logger.warning(f"send_push FCM v1 path failed: {e}")
            stats["errors"].append(f"FCM v1 path failed: {e}")

    # ── Secondary path: Emergent relay (only works once key is real) ──
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
    event: str  # "message" | "call" | "missed-call"
    title: str
    message: str
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
    event = body.event if body.event in ("message", "call", "missed-call") else "message"
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
    elif event == "missed-call":
        action_url = f"/chat/{conv}" if conv else "/notifications"
    else:
        action_url = f"/chat/{conv}" if conv else "/notifications"

    data: dict = {"title": title, "message": message, "action_url": action_url}

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
