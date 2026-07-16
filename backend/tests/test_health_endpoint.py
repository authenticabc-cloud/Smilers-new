"""Tests for GET /api/health readiness endpoint (iter server-status)."""
import os
import requests
import pytest

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL') or os.environ.get('EXPO_BACKEND_URL') or 'https://smilers-launch.preview.emergentagent.com'
BASE_URL = BASE_URL.rstrip('/')

EXPECTED_INTEGRATIONS = {
    'safe_browsing', 'openai_transcription', 'llm_translation',
    'twilio_video', 'push', 'mongo',
}


@pytest.fixture(scope='module')
def health_response():
    resp = requests.get(f'{BASE_URL}/api/health', timeout=15)
    return resp


class TestHealthEndpoint:
    def test_status_code_200(self, health_response):
        assert health_response.status_code == 200

    def test_returns_json(self, health_response):
        assert 'application/json' in health_response.headers.get('content-type', '')

    def test_shape_and_types(self, health_response):
        data = health_response.json()
        assert data['status'] in ('ok', 'degraded')
        assert isinstance(data['degraded'], list)
        assert isinstance(data['integrations'], dict)
        assert isinstance(data['rate_limit_store'], str)
        assert isinstance(data['version'], str) and data['version']
        assert isinstance(data['startedAt'], str) and 'T' in data['startedAt']
        assert isinstance(data['uptimeSeconds'], int)
        assert data['uptimeSeconds'] >= 0

    def test_integrations_keys_present(self, health_response):
        integrations = health_response.json()['integrations']
        for key in EXPECTED_INTEGRATIONS:
            assert key in integrations, f'Missing integration key: {key}'
            assert isinstance(integrations[key], bool)

    def test_status_is_ok(self, health_response):
        data = health_response.json()
        assert data['status'] == 'ok', f'Expected ok, got {data["status"]} (degraded={data["degraded"]})'

    def test_critical_integrations_up(self, health_response):
        integrations = health_response.json()['integrations']
        assert integrations['mongo'] is True
        assert integrations['safe_browsing'] is True

    def test_all_integrations_up(self, health_response):
        """Per review request: all 6 integrations should be 'Up'."""
        integrations = health_response.json()['integrations']
        down = [k for k, v in integrations.items() if not v]
        assert not down, f'Integrations reporting Down: {down}'
