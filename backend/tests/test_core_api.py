import uuid


# Core API health + translation + status CRUD smoke coverage
def test_api_root_ok(api_client, base_url):
    response = api_client.get(f"{base_url}/api/")
    assert response.status_code == 200
    assert response.json().get("message") == "Hello World"


def test_translate_required_fields_passthrough(api_client, base_url):
    response = api_client.post(
        f"{base_url}/api/translate",
        json={"text": "Hello there", "target_language": ""},
    )
    assert response.status_code == 200
    body = response.json()
    assert body.get("translated_text") == "Hello there"


def test_translate_success_structure(api_client, base_url):
    response = api_client.post(
        f"{base_url}/api/translate",
        json={
            "text": "Good morning",
            "target_language": "French",
            "skip_languages": ["English"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body.get("translated_text"), str)
    assert len(body.get("translated_text", "").strip()) > 0


def test_status_create_and_persisted_get(api_client, base_url):
    payload = {"client_name": f"TEST_client_{uuid.uuid4().hex[:8]}"}
    created = api_client.post(f"{base_url}/api/status", json=payload)
    assert created.status_code == 200
    created_body = created.json()
    assert created_body.get("client_name") == payload["client_name"]
    assert isinstance(created_body.get("id"), str)
    assert created_body.get("id")

    fetched = api_client.get(f"{base_url}/api/status")
    assert fetched.status_code == 200
    rows = fetched.json()
    assert isinstance(rows, list)
    assert any(item.get("id") == created_body["id"] for item in rows)
