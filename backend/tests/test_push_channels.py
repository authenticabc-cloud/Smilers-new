"""
iter-182 — tests for the Android push channel resolution logic that
restores incoming-call ringing (calls were landing on "messages-v3"
with one short beep instead of the calls channel with the ringtone).

Run: cd /app/backend && python -m pytest tests/test_push_channels.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import _resolve_android_channel  # noqa: E402


def test_message_defaults_to_messages_v3():
    assert _resolve_android_channel({"title": "New message"}) == "messages-v3"


def test_incoming_call_title_routes_to_calls():
    assert _resolve_android_channel({"title": "Incoming call"}) == "calls"
    assert _resolve_android_channel({"title": "Incoming video call"}) == "calls"
    assert _resolve_android_channel({"title": "Missed call"}) == "calls"


def test_call_action_url_routes_to_calls():
    assert (
        _resolve_android_channel({"title": "Ahmed", "action_url": "/call/abc123"})
        == "calls"
    )


def test_explicit_type_call_routes_to_calls():
    assert _resolve_android_channel({"title": "x", "type": "call"}) == "calls"


def test_explicit_channel_id_wins_over_default():
    assert _resolve_android_channel({"title": "hi", "channel_id": "calls"}) == "calls"
    assert (
        _resolve_android_channel({"title": "Incoming call", "channel_id": "calls-v4-ringtone"})
        == "calls-v4-ringtone"
    )


def test_token_override_wins_for_calls():
    token = {"call_channel_id": "calls-v4-smilers_never_cry_2", "message_channel_id": "messages-v4-message_notification"}
    assert (
        _resolve_android_channel({"title": "Incoming call"}, token)
        == "calls-v4-smilers_never_cry_2"
    )


def test_token_override_wins_for_messages():
    token = {"call_channel_id": "calls-v4-ringtone", "message_channel_id": "messages-v4-message_notification"}
    assert (
        _resolve_android_channel({"title": "New message from Ana"}, token)
        == "messages-v4-message_notification"
    )


def test_token_without_overrides_falls_back():
    token = {"device_token": "x"}
    assert _resolve_android_channel({"title": "Incoming call"}, token) == "calls"
    assert _resolve_android_channel({"title": "hello"}, token) == "messages-v3"


def test_title_with_word_call_but_not_a_call_stays_message():
    # "Called you out in the group" should NOT route to the calls channel.
    assert (
        _resolve_android_channel({"title": "Ana replied. Call me maybe lyrics"})
        == "messages-v3"
    )


def test_whatsapp_style_call_push_routes_to_calls():
    """iter-193 regression: Convex sends title=<caller name>, body='Incoming
    voice call…' — the old title-only regex classified these as messages,
    causing the killed-app beep+short-vibration instead of a full ring."""
    assert _resolve_android_channel(
        {"title": "Edward Marku", "message": "Incoming voice call"}
    ) == "calls"
    assert _resolve_android_channel(
        {"title": "Edward Marku", "message": "📹 Incoming video call from Edward"}
    ) == "calls"
    assert _resolve_android_channel(
        {"title": "Edward Marku", "subtext": "Missed voice call"}
    ) == "calls"
    # Sanity: a normal text message about a phone call must NOT ring.
    assert _resolve_android_channel(
        {"title": "Edward Marku", "message": "see you at 5"}
    ) == "messages-v3"


def test_per_token_call_channel_override_with_body_detection():
    token_doc = {"call_channel_id": "calls-v4-smilers_never_cry"}
    assert _resolve_android_channel(
        {"title": "Edward Marku", "message": "Incoming voice call"}, token_doc
    ) == "calls-v4-smilers_never_cry"
