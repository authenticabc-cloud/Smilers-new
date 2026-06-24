"""
Whisper transcription endpoint tests.

Verifies POST /api/transcribe (URL-based) and POST /api/transcribe/upload
(multipart) both return the expected shape: `segments[]` array with numeric
start/end (seconds) + text — required for live, time-synced subtitle
overlays in the mobile VideoBubble viewer.
"""
import io
import struct
import math
import pytest


# A short, stable, public audio clip. The backend container has restricted
# egress, so we use widely-available CDN hosts. List is tried in order.
PUBLIC_AUDIO_URLS = [
    # 1-second silence MP3 — tiny, on GitHub raw (allowed egress).
    "https://github.com/anars/blank-audio/raw/master/1-second-of-silence.mp3",
    # Mozilla Hubs sample (used in WebXR demos) on Cloudfront.
    "https://download.samplelib.com/mp3/sample-3s.mp3",
    # Short WAV from learningcontainer (last-resort).
    "https://www.learningcontainer.com/wp-content/uploads/2020/02/Kalimba.mp3",
]


def _build_silent_wav(seconds: float = 2.0, sample_rate: int = 16000) -> bytes:
    """Generate a tiny valid WAV (silent) so the upload endpoint can be tested
    even when no public URL is reachable. Whisper will return empty text /
    segments, but the response SHAPE is still what we are validating."""
    n_samples = int(seconds * sample_rate)
    # 16-bit PCM mono
    data = b"\x00\x00" * n_samples
    byte_rate = sample_rate * 2
    block_align = 2
    fmt_chunk = struct.pack(
        "<4sIHHIIHH", b"fmt ", 16, 1, 1, sample_rate, byte_rate, block_align, 16
    )
    data_chunk = struct.pack("<4sI", b"data", len(data)) + data
    riff = struct.pack("<4sI4s", b"RIFF", 4 + len(fmt_chunk) + len(data_chunk), b"WAVE")
    return riff + fmt_chunk + data_chunk


def _build_speech_wav(seconds: float = 3.0, sample_rate: int = 16000) -> bytes:
    """Generate a tiny WAV with a mix of tones (so Whisper has SOMETHING to
    chew on). Still won't transcribe to real words but exercises the segment
    path more than pure silence on some Whisper versions."""
    n_samples = int(seconds * sample_rate)
    samples = bytearray()
    for i in range(n_samples):
        # 440Hz sine, low amplitude
        v = int(3000 * math.sin(2 * math.pi * 440 * i / sample_rate))
        samples += struct.pack("<h", v)
    byte_rate = sample_rate * 2
    block_align = 2
    fmt_chunk = struct.pack(
        "<4sIHHIIHH", b"fmt ", 16, 1, 1, sample_rate, byte_rate, block_align, 16
    )
    data_chunk = struct.pack("<4sI", b"data", len(samples)) + bytes(samples)
    riff = struct.pack("<4sI4s", b"RIFF", 4 + len(fmt_chunk) + len(data_chunk), b"WAVE")
    return riff + fmt_chunk + data_chunk


# ---------------------------------------------------------------------------
# /api/transcribe — URL-based
# ---------------------------------------------------------------------------


class TestTranscribeUrl:
    def _assert_shape(self, body: dict):
        # Required top-level fields
        assert "text" in body, f"missing 'text': {body}"
        assert "language" in body, f"missing 'language': {body}"
        assert "segments" in body, f"missing 'segments': {body}"
        # text + language types
        assert isinstance(body["text"], str)
        assert isinstance(body["language"], str)
        # segments may be None when audio yields nothing, but if present each
        # entry must carry numeric start/end + a text string — this is what
        # the mobile caption overlay depends on.
        segs = body["segments"]
        assert segs is None or isinstance(segs, list)
        if segs:
            for i, s in enumerate(segs):
                assert "start" in s and "end" in s and "text" in s, f"bad segment[{i}]: {s}"
                assert isinstance(s["start"], (int, float)), f"start not numeric: {s}"
                assert isinstance(s["end"], (int, float)), f"end not numeric: {s}"
                assert isinstance(s["text"], str)
                assert s["end"] >= s["start"], f"end<start in seg[{i}]: {s}"

    def test_transcribe_url_returns_segments(self, base_url, api_client):
        """POST /api/transcribe with a public short audio URL should return
        text/language/segments[] with timed entries."""
        last_status = None
        last_body = ""
        for url in PUBLIC_AUDIO_URLS:
            r = api_client.post(
                f"{base_url}/api/transcribe",
                json={"media_url": url, "language_hint": None},
                timeout=120,
            )
            last_status = r.status_code
            last_body = r.text
            if r.status_code == 200:
                break
        if last_status != 200:
            pytest.skip(
                f"All public audio URLs unreachable from backend container "
                f"(last_status={last_status}, body={last_body[:200]}). "
                f"Backend transcription path needs an externally-reachable URL — verify upload path instead."
            )
        body = r.json()
        self._assert_shape(body)
        # For a real speech clip we expect at least one segment with non-empty text.
        if body.get("segments"):
            assert any((s.get("text") or "").strip() for s in body["segments"]), (
                "expected at least one non-empty segment text for real speech"
            )

    def test_transcribe_url_invalid_returns_4xx_or_5xx(self, base_url, api_client):
        """Bad URL must surface a clear HTTPException, not crash."""
        r = api_client.post(
            f"{base_url}/api/transcribe",
            json={"media_url": "https://example.invalid/none.mp3"},
            timeout=30,
        )
        assert r.status_code in (400, 502), f"unexpected {r.status_code}: {r.text[:200]}"


# ---------------------------------------------------------------------------
# /api/transcribe/upload — multipart
# ---------------------------------------------------------------------------


class TestTranscribeUpload:
    def test_upload_returns_correct_shape(self, base_url):
        """Multipart upload must return the same shape as the URL endpoint."""
        wav_bytes = _build_speech_wav(seconds=3.0)
        files = {"file": ("test_clip.wav", wav_bytes, "audio/wav")}
        # NOTE: use a fresh session here because the shared api_client session
        # forces Content-Type: application/json, which clobbers multipart.
        import requests
        r = requests.post(
            f"{base_url}/api/transcribe/upload",
            files=files,
            timeout=120,
        )
        assert r.status_code == 200, f"unexpected {r.status_code}: {r.text[:400]}"
        body = r.json()
        assert "text" in body and "language" in body and "segments" in body
        # The shape must always be present, even when Whisper finds no speech.
        segs = body["segments"]
        assert segs is None or isinstance(segs, list)
        if segs:
            for s in segs:
                assert isinstance(s.get("start"), (int, float))
                assert isinstance(s.get("end"), (int, float))
                assert isinstance(s.get("text"), str)

    def test_upload_empty_rejected(self, base_url):
        """Empty file must return 400."""
        import requests
        files = {"file": ("empty.m4a", b"", "audio/m4a")}
        r = requests.post(f"{base_url}/api/transcribe/upload", files=files, timeout=15)
        assert r.status_code in (400, 422), f"unexpected {r.status_code}: {r.text[:200]}"
