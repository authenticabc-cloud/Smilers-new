from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List
import uuid
from datetime import datetime
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
