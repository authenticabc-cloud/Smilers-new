import os
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values


def _resolve_base_url() -> str:
    env_value = os.environ.get("EXPO_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    if env_value:
        return env_value.rstrip("/")

    frontend_env = Path("/app/frontend/.env")
    if frontend_env.exists():
        parsed = dotenv_values(frontend_env)
        candidate = parsed.get("EXPO_BACKEND_URL") or parsed.get("EXPO_PUBLIC_BACKEND_URL")
        if candidate:
            return str(candidate).rstrip("/")

    pytest.skip("Backend base URL env missing (EXPO_BACKEND_URL / EXPO_PUBLIC_BACKEND_URL)")


@pytest.fixture(scope="session")
def base_url() -> str:
    return _resolve_base_url()


@pytest.fixture(scope="session")
def api_client():
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    yield session
    session.close()
