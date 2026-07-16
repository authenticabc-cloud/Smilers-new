"""Tests for the Google Safe Browsing bridge endpoint (POST /api/safe-browsing/check).

These verify that after re-adding GOOGLE_SAFE_BROWSING_API_KEY to backend/.env
the endpoint no longer fails-open on every request (empty matches for known-bad
URLs) and correctly forwards Google's threat classifications.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://smilers-launch.preview.emergentagent.com").rstrip("/")
ENDPOINT = f"{BASE_URL}/api/safe-browsing/check"

MALWARE_URL = "https://testsafebrowsing.appspot.com/s/malware.html"
PHISHING_URL = "https://testsafebrowsing.appspot.com/s/phishing.html"
SAFE_URL_1 = "https://www.google.com"
SAFE_URL_2 = "https://en.wikipedia.org"


@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _post(api_client, urls):
    return api_client.post(ENDPOINT, json={"urls": urls}, timeout=20)


# --- Health / shape ---------------------------------------------------------

def test_endpoint_returns_200_and_matches_shape(api_client):
    r = _post(api_client, [SAFE_URL_1])
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert "matches" in data and isinstance(data["matches"], list)


# --- Malicious URL detection -----------------------------------------------

def test_malware_test_url_flagged(api_client):
    r = _post(api_client, [MALWARE_URL])
    assert r.status_code == 200, r.text
    data = r.json()
    matches = data.get("matches", [])
    assert len(matches) >= 1, (
        f"Expected MALWARE test URL to be flagged (API key working). "
        f"Got empty matches — likely fail-open: {data}"
    )
    urls = [m["url"] for m in matches]
    assert MALWARE_URL in urls, f"Malware URL missing from matches: {matches}"
    threat_types = {m["threat_type"] for m in matches if m["url"] == MALWARE_URL}
    assert "MALWARE" in threat_types, f"Expected MALWARE threat_type, got {threat_types}"


def test_phishing_test_url_flagged_or_empty(api_client):
    """Google sometimes stops flagging the phishing test URL. If empty, we log
    and treat it as acceptable per the review request."""
    r = _post(api_client, [PHISHING_URL])
    assert r.status_code == 200, r.text
    data = r.json()
    matches = data.get("matches", [])
    if not matches:
        pytest.skip("Google no longer flags the phishing test URL — acceptable per review note.")
    urls = [m["url"] for m in matches]
    assert PHISHING_URL in urls, f"Phishing URL missing from matches: {matches}"
    threat_types = {m["threat_type"] for m in matches if m["url"] == PHISHING_URL}
    assert "SOCIAL_ENGINEERING" in threat_types, (
        f"Expected SOCIAL_ENGINEERING threat_type, got {threat_types}"
    )


# --- Safe URLs --------------------------------------------------------------

def test_safe_urls_return_empty_matches(api_client):
    r = _post(api_client, [SAFE_URL_1, SAFE_URL_2])
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("matches", []) == [], (
        f"Expected safe URLs to return empty matches, got: {data}"
    )


# --- Mixed batch ------------------------------------------------------------

def test_mixed_batch_only_malicious_returned(api_client):
    r = _post(api_client, [MALWARE_URL, SAFE_URL_1])
    assert r.status_code == 200, r.text
    data = r.json()
    matches = data.get("matches", [])
    match_urls = [m["url"] for m in matches]
    assert MALWARE_URL in match_urls, f"Expected malware URL in matches: {matches}"
    assert SAFE_URL_1 not in match_urls, f"Safe URL should not be in matches: {matches}"


# --- Edge cases -------------------------------------------------------------

def test_empty_urls_array(api_client):
    r = _post(api_client, [])
    assert r.status_code == 200, r.text
    assert r.json().get("matches", []) == []


def test_non_http_string_ignored(api_client):
    r = _post(api_client, ["not-a-url"])
    assert r.status_code == 200, r.text
    assert r.json().get("matches", []) == []


def test_missing_urls_field_returns_422(api_client):
    """Pydantic should reject missing required field."""
    r = api_client.post(ENDPOINT, json={}, timeout=10)
    # 422 unprocessable is expected; also accept 400
    assert r.status_code in (400, 422), f"Expected 4xx validation error, got {r.status_code}: {r.text}"
