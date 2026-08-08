"""Tests for Smilers Stream group-call 'Add participant' feature.

Covers:
 - POST /api/calls/add-participant (persists callee=pending+rang_at, adder=joined)
 - GET  /api/twilio/call-participants (new rang_at field, privacy per viewer)
 - POST /api/calls/participant-status (expanded enum: joined/declined/pending/left/missed)
 - Dial-again reset (re-calling add-participant resets status to pending, updates rang_at)
 - POST /api/calls/remove-participant (adder-only authorization; wrong requester -> 403)

Runs against EXTERNAL preview base URL from EXPO_BACKEND_URL / EXPO_PUBLIC_BACKEND_URL.
Uses unique stream_room per test to avoid stale-data collisions.
"""
import time
import uuid
from datetime import datetime, timezone

import pytest


# ---------- Helpers ---------------------------------------------------------

def _unique_room(prefix: str = "TEST_room") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}_{int(time.time())}"


def _find_participant(participants, identity):
    for p in participants:
        if p.get("identity") == identity:
            return p
    return None


def _parse_iso(ts):
    if not ts:
        return None
    # Handle "...+00:00" and "...Z"
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def _get_roster(api_client, base_url, room, viewer):
    r = api_client.get(
        f"{base_url}/api/twilio/call-participants",
        params={"room_name": room, "viewer": viewer},
        timeout=20,
    )
    assert r.status_code == 200, f"GET roster failed: {r.status_code} {r.text}"
    body = r.json()
    assert "participants" in body and isinstance(body["participants"], list)
    return body["participants"]


def _add_participant(api_client, base_url, *, room, adder_identity="adderA",
                     adder_display_name="Alice", adder_phone="+15550001111",
                     callee_identity="calleeB", callee_display_name="Bob",
                     callee_phone="+15551234567", hide_number=False,
                     is_video=False, conversation_id=None):
    payload = {
        "stream_room": room,
        "adder_identity": adder_identity,
        "adder_display_name": adder_display_name,
        "adder_phone": adder_phone,
        "callee_identity": callee_identity,
        "callee_display_name": callee_display_name,
        "callee_phone": callee_phone,
        "hide_number": hide_number,
        "is_video": is_video,
        "conversation_id": conversation_id or f"conv_{uuid.uuid4().hex[:10]}",
    }
    r = api_client.post(f"{base_url}/api/calls/add-participant", json=payload, timeout=20)
    return r


# ---------- Tests -----------------------------------------------------------

class TestAddParticipantPersistence:
    """POST /api/calls/add-participant persists callee(pending+rang_at) + adder(joined)."""

    def test_add_participant_persists_callee_and_adder(self, api_client, base_url):
        room = _unique_room()
        r = _add_participant(api_client, base_url, room=room)
        assert r.status_code == 200, f"add-participant failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("ok") is True
        assert body.get("stream_room") == room

        # Viewer = adderA should see callee 'Bob' pending with rang_at, adder 'Alice' joined.
        participants = _get_roster(api_client, base_url, room, "adderA")
        assert len(participants) >= 2, f"expected 2 participants, got {participants}"

        bob = _find_participant(participants, "calleeB")
        alice = _find_participant(participants, "adderA")
        assert bob is not None, "callee entry missing"
        assert alice is not None, "adder entry missing"

        # Callee fields
        assert bob["status"] == "pending", f"callee status expected pending got {bob['status']}"
        assert bob["call_role"] == "added"
        assert bob["added_by"] == "adderA"
        assert bob["display_name"] == "Bob"
        assert bob["hide_number"] is False
        assert bob["phone_number"] == "+15551234567"  # adder-viewer sees phone
        assert bob.get("rang_at"), "rang_at must be non-null after add"
        ts = _parse_iso(bob["rang_at"])
        assert ts is not None, f"rang_at not ISO parseable: {bob['rang_at']}"

        # Adder fields
        assert alice["status"] == "joined"
        assert alice["display_name"] == "Alice"
        assert alice["phone_number"] == "+15550001111"

        # All expected fields present in every entry
        expected_keys = {"identity", "display_name", "phone_number", "hide_number",
                         "added_by", "status", "call_role", "rang_at"}
        for p in participants:
            missing = expected_keys - set(p.keys())
            assert not missing, f"participant missing keys {missing}: {p}"


class TestPhonePrivacyMasking:
    """hide_number must mask phone_number for non-adder/non-self viewers."""

    def test_hide_number_masks_for_others_but_not_adder_or_self(self, api_client, base_url):
        room = _unique_room()
        r = _add_participant(
            api_client, base_url, room=room,
            callee_identity="calleeC", callee_display_name="Charlie",
            callee_phone="+15559998888", hide_number=True,
        )
        assert r.status_code == 200, r.text

        # Viewer = unrelated user -> phone hidden
        others = _get_roster(api_client, base_url, room, "someoneElse")
        charlie_other = _find_participant(others, "calleeC")
        assert charlie_other is not None
        assert charlie_other["hide_number"] is True
        assert charlie_other["added_by"] == "adderA"
        assert charlie_other["phone_number"] is None, (
            f"phone should be masked for non-adder viewer, got {charlie_other['phone_number']}"
        )

        # Viewer = adder -> phone visible
        by_adder = _get_roster(api_client, base_url, room, "adderA")
        charlie_adder = _find_participant(by_adder, "calleeC")
        assert charlie_adder["phone_number"] == "+15559998888"

        # Viewer = self -> phone visible
        by_self = _get_roster(api_client, base_url, room, "calleeC")
        charlie_self = _find_participant(by_self, "calleeC")
        assert charlie_self["phone_number"] == "+15559998888"

        # hide_number + added_by must be present in ALL responses
        for src, label in ((others, "other"), (by_adder, "adder"), (by_self, "self")):
            c = _find_participant(src, "calleeC")
            assert "hide_number" in c and "added_by" in c, f"missing hide_number/added_by ({label})"


class TestParticipantStatusEnum:
    """POST /api/calls/participant-status must accept new statuses left, missed and reject bogus."""

    @pytest.mark.parametrize("new_status", ["left", "missed", "joined", "declined", "pending"])
    def test_accepts_expanded_statuses(self, api_client, base_url, new_status):
        room = _unique_room(f"TEST_status_{new_status}")
        r = _add_participant(api_client, base_url, room=room)
        assert r.status_code == 200, r.text

        payload = {
            "stream_room": room,
            "identity": "calleeB",
            "status": new_status,
            "display_name": "Bob",
        }
        r2 = api_client.post(f"{base_url}/api/calls/participant-status", json=payload, timeout=20)
        assert r2.status_code == 200, f"status={new_status} failed: {r2.status_code} {r2.text}"
        assert r2.json().get("ok") is True

        participants = _get_roster(api_client, base_url, room, "adderA")
        bob = _find_participant(participants, "calleeB")
        assert bob is not None
        assert bob["status"] == new_status, (
            f"expected callee status {new_status} got {bob['status']}"
        )

    def test_rejects_invalid_status(self, api_client, base_url):
        room = _unique_room("TEST_status_invalid")
        r = _add_participant(api_client, base_url, room=room)
        assert r.status_code == 200

        r2 = api_client.post(
            f"{base_url}/api/calls/participant-status",
            json={"stream_room": room, "identity": "calleeB", "status": "bogus"},
            timeout=20,
        )
        assert r2.status_code == 422, (
            f"expected 422 for invalid status, got {r2.status_code}: {r2.text}"
        )


class TestDialAgainResetsEntry:
    """Re-calling add-participant on an existing callee resets status=pending w/ newer rang_at."""

    def test_redial_resets_status_and_updates_rang_at(self, api_client, base_url):
        room = _unique_room("TEST_redial")
        # Initial add
        r = _add_participant(api_client, base_url, room=room)
        assert r.status_code == 200, r.text

        first_roster = _get_roster(api_client, base_url, room, "adderA")
        first_bob = _find_participant(first_roster, "calleeB")
        assert first_bob is not None
        first_ts = _parse_iso(first_bob["rang_at"])
        assert first_ts is not None

        # Mark callee as 'left'
        r2 = api_client.post(
            f"{base_url}/api/calls/participant-status",
            json={"stream_room": room, "identity": "calleeB", "status": "left"},
            timeout=20,
        )
        assert r2.status_code == 200
        mid = _find_participant(_get_roster(api_client, base_url, room, "adderA"), "calleeB")
        assert mid["status"] == "left", f"expected left got {mid['status']}"

        # Sleep briefly so rang_at delta is observable (server uses UTC now())
        time.sleep(1.2)

        # Redial: add-participant again for the same callee
        r3 = _add_participant(api_client, base_url, room=room)
        assert r3.status_code == 200, r3.text

        final = _find_participant(_get_roster(api_client, base_url, room, "adderA"), "calleeB")
        assert final is not None
        assert final["status"] == "pending", (
            f"redial should reset status to pending, got {final['status']}"
        )
        second_ts = _parse_iso(final["rang_at"])
        assert second_ts is not None
        assert second_ts > first_ts, (
            f"redial rang_at should be newer: first={first_ts} second={second_ts}"
        )


class TestRemoveParticipantAuth:
    """POST /api/calls/remove-participant — adder-only auth."""

    def test_wrong_requester_is_forbidden(self, api_client, base_url):
        room = _unique_room("TEST_remove_wrong")
        r = _add_participant(api_client, base_url, room=room)
        assert r.status_code == 200, r.text

        r2 = api_client.post(
            f"{base_url}/api/calls/remove-participant",
            json={
                "stream_room": room,
                "identity": "calleeB",
                "requester_identity": "notTheAdder",
            },
            timeout=20,
        )
        assert r2.status_code == 403, (
            f"wrong requester should be 403, got {r2.status_code}: {r2.text}"
        )
        # Entry must still be there
        bob = _find_participant(_get_roster(api_client, base_url, room, "adderA"), "calleeB")
        assert bob is not None, "entry should not have been deleted on 403"

    def test_correct_requester_removes_entry(self, api_client, base_url):
        room = _unique_room("TEST_remove_ok")
        r = _add_participant(api_client, base_url, room=room)
        assert r.status_code == 200, r.text

        r2 = api_client.post(
            f"{base_url}/api/calls/remove-participant",
            json={
                "stream_room": room,
                "identity": "calleeB",
                "requester_identity": "adderA",
            },
            timeout=20,
        )
        assert r2.status_code == 200, f"remove failed: {r2.status_code} {r2.text}"
        assert r2.json().get("ok") is True

        bob = _find_participant(_get_roster(api_client, base_url, room, "adderA"), "calleeB")
        assert bob is None, "callee entry should be deleted after remove"
