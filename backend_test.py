"""
Backend API tests for FastAPI backend at /app/backend/server.py
Endpoints tested:
  GET  /api/
  POST /api/status
  GET  /api/status
  POST /api/translate (5 sub-cases incl. cache)
"""
import os
import time
import json
import requests

# Load EXPO_PUBLIC_BACKEND_URL from /app/frontend/.env
FRONTEND_ENV = "/app/frontend/.env"
BASE_URL = None
with open(FRONTEND_ENV) as f:
    for line in f:
        if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
            BASE_URL = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not found"
API = f"{BASE_URL}/api"

print(f"== Testing against {API} ==\n")
results = []


def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}: {detail}")
    results.append((name, ok, detail))


# 1. GET /api/
try:
    r = requests.get(f"{API}/", timeout=15)
    ok = r.status_code == 200 and r.json().get("message") == "Hello World"
    record("GET /api/", ok, f"status={r.status_code} body={r.text[:120]}")
except Exception as e:
    record("GET /api/", False, f"error={e}")


# 2. POST /api/status
created_id = None
try:
    payload = {"client_name": "test-iter-43"}
    r = requests.post(f"{API}/status", json=payload, timeout=15)
    body = r.json()
    ok = (
        r.status_code == 200
        and "id" in body and "client_name" in body and "timestamp" in body
        and body["client_name"] == "test-iter-43"
    )
    created_id = body.get("id")
    record("POST /api/status", ok, f"status={r.status_code} id={created_id} body={json.dumps(body)[:200]}")
except Exception as e:
    record("POST /api/status", False, f"error={e}")


# 3. GET /api/status
try:
    r = requests.get(f"{API}/status", timeout=15)
    arr = r.json()
    found = any(item.get("id") == created_id for item in arr) if created_id else False
    ok = r.status_code == 200 and isinstance(arr, list) and found
    record("GET /api/status", ok, f"status={r.status_code} count={len(arr)} contains_created={found}")
except Exception as e:
    record("GET /api/status", False, f"error={e}")


# 4A. POST /api/translate - normal Spanish
t1 = None
try:
    payload = {"text": "Hello, how are you?", "target_language": "Spanish", "skip_languages": []}
    start = time.time()
    r = requests.post(f"{API}/translate", json=payload, timeout=60)
    elapsed_a = time.time() - start
    body = r.json()
    t1 = body.get("translated_text")
    ok = r.status_code == 200 and isinstance(t1, str) and len(t1) > 0 and t1.lower() != payload["text"].lower()
    record("POST /api/translate (A: Spanish normal)", ok, f"status={r.status_code} elapsed={elapsed_a:.2f}s translated='{t1}'")
except Exception as e:
    record("POST /api/translate (A: Spanish normal)", False, f"error={e}")


# 4B. Empty text short-circuit
try:
    payload = {"text": "", "target_language": "Spanish", "skip_languages": []}
    r = requests.post(f"{API}/translate", json=payload, timeout=15)
    body = r.json()
    ok = r.status_code == 200 and body.get("translated_text") == ""
    record("POST /api/translate (B: empty text)", ok, f"status={r.status_code} translated='{body.get('translated_text')}'")
except Exception as e:
    record("POST /api/translate (B: empty text)", False, f"error={e}")


# 4C. Skip language - preserve Spanish
try:
    payload = {"text": "Hola amigo", "target_language": "English", "skip_languages": ["Spanish"]}
    r = requests.post(f"{API}/translate", json=payload, timeout=60)
    body = r.json()
    translated = body.get("translated_text", "")
    # Should preserve "Hola amigo"
    ok = r.status_code == 200 and "Hola" in translated and "amigo" in translated
    record("POST /api/translate (C: skip language)", ok, f"status={r.status_code} translated='{translated}'")
except Exception as e:
    record("POST /api/translate (C: skip language)", False, f"error={e}")


# 4D. Cache hit - same as A
try:
    payload = {"text": "Hello, how are you?", "target_language": "Spanish", "skip_languages": []}
    start = time.time()
    r = requests.post(f"{API}/translate", json=payload, timeout=30)
    elapsed_d = time.time() - start
    body = r.json()
    t2 = body.get("translated_text")
    ok = r.status_code == 200 and t2 == t1 and elapsed_d < 2.0  # cache should be < 2s
    record("POST /api/translate (D: cache hit)", ok, f"status={r.status_code} elapsed={elapsed_d:.3f}s identical={t2==t1}")
except Exception as e:
    record("POST /api/translate (D: cache hit)", False, f"error={e}")


# 4E. Rich text tag preservation
try:
    payload = {"text": "[b]Bold[/b] [color=red]Red[/color]", "target_language": "French", "skip_languages": []}
    r = requests.post(f"{API}/translate", json=payload, timeout=60)
    body = r.json()
    translated = body.get("translated_text", "")
    has_b_open = "[b]" in translated
    has_b_close = "[/b]" in translated
    has_color_open = "[color=red]" in translated
    has_color_close = "[/color]" in translated
    ok = r.status_code == 200 and has_b_open and has_b_close and has_color_open and has_color_close
    record(
        "POST /api/translate (E: rich tags)",
        ok,
        f"status={r.status_code} translated='{translated}' tags_preserved=[b]:{has_b_open}/{has_b_close} [color]:{has_color_open}/{has_color_close}",
    )
except Exception as e:
    record("POST /api/translate (E: rich tags)", False, f"error={e}")


# Summary
print("\n=== SUMMARY ===")
passed = sum(1 for _, ok, _ in results if ok)
failed = sum(1 for _, ok, _ in results if not ok)
print(f"Passed: {passed} / {len(results)}, Failed: {failed}")
for name, ok, detail in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
exit(0 if failed == 0 else 1)
