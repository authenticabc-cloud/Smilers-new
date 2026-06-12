"""
iter-197 regression tests — _derive_push_routing + dead-token markers.

These guard the fix that makes backend pushes tappable on mobile:
the FCM data payload must carry `type` / `conversationId` / `callId`
derived from the Convex-provided `action_url`, because the mobile
tap-handler routes on `payload.type`, NOT on `action_url`.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def server_module():
    if "server" in sys.modules:
        return sys.modules["server"]
    spec = importlib.util.spec_from_file_location("server", BACKEND_DIR / "server.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["server"] = module
    spec.loader.exec_module(module)
    return module


class TestDerivePushRouting:
    def test_call_action_url(self, server_module):
        out = server_module._derive_push_routing(
            {"action_url": "/call/jx7abc123?displayName=ABC%20INVESTOR"}
        )
        assert out["type"] == "call"
        assert out["conversationId"] == "jx7abc123"
        assert out["callId"] == "jx7abc123"
        assert out["displayName"] == "ABC INVESTOR"

    def test_call_action_url_without_query(self, server_module):
        out = server_module._derive_push_routing({"action_url": "/call/conv99"})
        assert out["type"] == "call"
        assert out["callId"] == "conv99"
        assert "displayName" not in out

    def test_chat_action_url(self, server_module):
        out = server_module._derive_push_routing({"action_url": "/chat/k57def?focus=m1"})
        assert out["type"] == "message"
        assert out["conversationId"] == "k57def"
        assert "callId" not in out

    def test_non_routable_action_url(self, server_module):
        assert server_module._derive_push_routing({"action_url": "/notifications"}) == {}
        assert server_module._derive_push_routing({"action_url": "https://x.com/call/1"}) == {}
        assert server_module._derive_push_routing({}) == {}


class TestDeadTokenMarkers:
    def test_markers_cover_fcm_unregistered_error(self, server_module):
        # The exact strings FCM v1 produced against the deployed backend's
        # 17 dead tokens on 2026-06-12.
        markers = server_module._DEAD_TOKEN_MARKERS
        sample = "UnregisteredError: Requested entity was not found."
        assert any(m in sample for m in markers)

    def test_markers_do_not_match_transient_errors(self, server_module):
        markers = server_module._DEAD_TOKEN_MARKERS
        transient = "DeadlineExceeded: timed out"
        assert not any(m in transient for m in markers)
