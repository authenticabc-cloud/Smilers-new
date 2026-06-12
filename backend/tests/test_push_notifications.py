"""
Tests for Emergent-managed push notification endpoints + send_push helper.

Backend contract:
  POST /api/register-push           - forwards to Emergent relay; 401 from
                                      upstream surfaces as 500 with detail
                                      'EMERGENT_PUSH_KEY missing or invalid'.
  POST /api/send-push-internal      - requires X-Internal-Push-Token header.
  POST /api/self-test-push          - returns 202 even if upstream fails.
  send_push() helper                - raises ValueError on invalid input.

NOTE: EMERGENT_PUSH_KEY in /app/backend/.env is 'placeholder' in dev mode.
Upstream returns 401 — this is the expected dev behavior, NOT a bug.
"""
import os
import sys
from pathlib import Path

import pytest
from dotenv import dotenv_values


# Load INTERNAL_PUSH_TOKEN from backend/.env (single source of truth)
_BACKEND_ENV = dotenv_values(Path("/app/backend/.env"))
INTERNAL_PUSH_TOKEN = _BACKEND_ENV.get("INTERNAL_PUSH_TOKEN", "")


# ---------------------------------------------------------------------------
# /api/register-push
# ---------------------------------------------------------------------------
class TestRegisterPush:
    """POST /api/register-push validates input and forwards to relay."""

    def test_register_push_missing_user_id_returns_400(self, api_client, base_url):
        resp = api_client.post(
            f"{base_url}/api/register-push",
            json={"user_id": "", "platform": "ios", "device_token": "abc123"},
        )
        assert resp.status_code == 400

    def test_register_push_missing_device_token_returns_400(self, api_client, base_url):
        resp = api_client.post(
            f"{base_url}/api/register-push",
            json={"user_id": "user-1", "platform": "android", "device_token": ""},
        )
        assert resp.status_code == 400

    def test_register_push_invalid_platform_returns_400(self, api_client, base_url):
        resp = api_client.post(
            f"{base_url}/api/register-push",
            json={"user_id": "user-1", "platform": "windows", "device_token": "abc123"},
        )
        assert resp.status_code == 400
        assert "platform" in (resp.json().get("detail", "") or "").lower()

    def test_register_push_pydantic_missing_fields_returns_422(self, api_client, base_url):
        resp = api_client.post(f"{base_url}/api/register-push", json={"user_id": "u1"})
        assert resp.status_code == 422

    def test_register_push_with_placeholder_key_surfaces_500(self, api_client, base_url):
        """With EMERGENT_PUSH_KEY=placeholder, upstream returns 401 which
        the backend surfaces as 500 with detail 'EMERGENT_PUSH_KEY ...'.
        Acceptable outcomes are 500 (key invalid) or 502 (upstream
        unreachable in sandbox). 201 would also be valid if the relay
        actually accepts placeholder."""
        resp = api_client.post(
            f"{base_url}/api/register-push",
            json={
                "user_id": "TEST_user_register_push",
                "platform": "android",
                "device_token": "TEST_native_token_abc",
            },
        )
        assert resp.status_code in (201, 500, 502), (
            f"Unexpected status {resp.status_code}: {resp.text}"
        )
        if resp.status_code == 500:
            detail = (resp.json().get("detail") or "").lower()
            assert "emergent_push_key" in detail or "missing" in detail or "invalid" in detail


# ---------------------------------------------------------------------------
# /api/send-push-internal
# ---------------------------------------------------------------------------
class TestSendPushInternal:
    """POST /api/send-push-internal — gated by X-Internal-Push-Token header."""

    def test_missing_header_returns_401(self, api_client, base_url):
        resp = api_client.post(
            f"{base_url}/api/send-push-internal",
            json={"recipients": ["u1"], "title": "T", "message": "M"},
        )
        assert resp.status_code == 401

    def test_wrong_header_returns_401(self, api_client, base_url):
        resp = api_client.post(
            f"{base_url}/api/send-push-internal",
            json={"recipients": ["u1"], "title": "T", "message": "M"},
            headers={"X-Internal-Push-Token": "wrong-token-deadbeef"},
        )
        assert resp.status_code == 401

    def test_correct_header_returns_202(self, api_client, base_url):
        if not INTERNAL_PUSH_TOKEN:
            pytest.skip("INTERNAL_PUSH_TOKEN not configured in /app/backend/.env")
        resp = api_client.post(
            f"{base_url}/api/send-push-internal",
            json={
                "recipients": ["TEST_user_send_internal"],
                "title": "TEST Title",
                "message": "TEST Message",
                "subtext": "subtext",
                "image_url": "https://example.com/img.png",
                "action_url": "/chats/abc",
                "idempotency_key": "TEST_idem_001",
            },
            headers={"X-Internal-Push-Token": INTERNAL_PUSH_TOKEN},
        )
        assert resp.status_code == 202, f"Expected 202, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body.get("status") == "accepted"

    def test_correct_header_validation_missing_title_returns_422(self, api_client, base_url):
        if not INTERNAL_PUSH_TOKEN:
            pytest.skip("INTERNAL_PUSH_TOKEN not configured")
        resp = api_client.post(
            f"{base_url}/api/send-push-internal",
            json={"recipients": ["u1"], "message": "M"},
            headers={"X-Internal-Push-Token": INTERNAL_PUSH_TOKEN},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# /api/self-test-push
# ---------------------------------------------------------------------------
class TestSelfTestPush:
    """POST /api/self-test-push — always returns 202 even on relay failure."""

    def test_self_test_push_accepts_with_user_id(self, api_client, base_url):
        resp = api_client.post(
            f"{base_url}/api/self-test-push",
            json={"user_id": "TEST_user_self_test"},
        )
        assert resp.status_code == 202
        assert resp.json().get("status") == "accepted"

    def test_self_test_push_missing_user_id_returns_400(self, api_client, base_url):
        resp = api_client.post(f"{base_url}/api/self-test-push", json={})
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# send_push() helper — direct unit tests (import from backend.server)
# ---------------------------------------------------------------------------
class TestSendPushHelper:
    """Unit tests for the send_push() coroutine in backend/server.py."""

    @pytest.fixture(scope="class")
    def send_push_fn(self):
        # Ensure backend module is importable
        if "/app/backend" not in sys.path:
            sys.path.insert(0, "/app/backend")
        # Ensure env vars required at import time are present
        os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
        os.environ.setdefault("DB_NAME", "test_database")
        from server import send_push  # noqa: WPS433
        return send_push

    @pytest.mark.asyncio
    async def test_send_push_too_many_recipients_raises_valueerror(self, send_push_fn):
        recipients = [f"u{i}" for i in range(101)]
        with pytest.raises(ValueError, match="max 100"):
            await send_push_fn(recipients, {"title": "t", "message": "m"})

    @pytest.mark.asyncio
    async def test_send_push_missing_title_raises_valueerror(self, send_push_fn):
        with pytest.raises(ValueError, match="title.*message|message.*title|title' and 'message"):
            await send_push_fn(["u1"], {"message": "m"})

    @pytest.mark.asyncio
    async def test_send_push_missing_message_raises_valueerror(self, send_push_fn):
        with pytest.raises(ValueError):
            await send_push_fn(["u1"], {"title": "t"})

    @pytest.mark.asyncio
    async def test_send_push_empty_recipients_returns_silently(self, send_push_fn):
        # Should NOT raise even with missing data — empty recipients short-circuits.
        # iter-197: send_push now returns a stats dict instead of None.
        result = await send_push_fn([], {})
        assert isinstance(result, dict)
        assert result["token_count"] == 0
        assert result["success_count"] == 0
