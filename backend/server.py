from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import asyncio
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List
import uuid
from datetime import datetime, timezone
from emergentintegrations.llm.chat import LlmChat, UserMessage


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
        await db.push_tokens.update_one(
            {
                "user_id": body.user_id,
                "platform": body.platform,
                "device_token": body.device_token,
            },
            {
                "$set": {
                    "user_id": body.user_id,
                    "platform": body.platform,
                    "device_token": body.device_token,
                    "updated_at": datetime.now(timezone.utc),
                },
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
            json=body.model_dump(),
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


async def send_push(
    recipients: list[str],
    data: dict,
    idempotency_key: str | None = None,
) -> None:
    """
    Server-side helper. Sends a push notification to all device tokens
    registered for the given recipient user IDs.

    iter-129: PRIMARY path is FCM v1 (Firebase Admin SDK) using tokens
    stored in MongoDB. SECONDARY path is the Emergent relay (which only
    works once EMERGENT_PUSH_KEY is real). Both paths fire in parallel
    — the OS dedupes by content so the user never sees doubles.

    Wrap calls in try/except — push delivery failures never block the
    primary operation.
    """
    if not recipients:
        return
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
            cursor = db.push_tokens.find({"user_id": {"$in": recipients}})
            tokens = await cursor.to_list(length=500)
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

                send_tasks = [
                    fcm_send_v1(
                        device_token=t["device_token"],
                        title=title,
                        message=message,
                        data=fcm_data,
                        android_channel_id="messages",
                    )
                    for t in tokens
                ]
                results = await asyncio.gather(*send_tasks, return_exceptions=True)
                successes = sum(
                    1 for r in results
                    if isinstance(r, tuple) and r[0]
                )
                logger.info(
                    f"send_push FCM v1: {successes}/{len(tokens)} delivered "
                    f"(recipients={len(recipients)})"
                )
        except Exception as e:
            logger.warning(f"send_push FCM v1 path failed: {e}")

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


class SendPushBody(BaseModel):
    recipients: List[str]
    title: str
    message: str
    subtext: str | None = None
    image_url: str | None = None
    action_url: str | None = None
    idempotency_key: str | None = None


@api_router.post("/send-push-internal", status_code=202)
async def send_push_internal(
    body: SendPushBody,
    x_internal_push_token: str | None = Header(default=None),
):
    """
    Internal endpoint for Convex to trigger pushes. Authenticated by a
    shared secret (X-Internal-Push-Token header) that ONLY the Convex
    deployment knows. Mobile clients NEVER call this endpoint directly.
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

    try:
        await send_push(
            recipients=body.recipients,
            data=data,
            idempotency_key=body.idempotency_key,
        )
    except Exception as e:
        logger.warning(f"send-push-internal: send_push raised: {e}")
    return {"status": "accepted"}


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
                    android_channel_id="messages",
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
