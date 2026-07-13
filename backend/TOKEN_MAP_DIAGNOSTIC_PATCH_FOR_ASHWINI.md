# Patch: add the `[PUSH][token-map]` diagnostic to `backend/server.py`

**Goal:** make the two backends identical by adding the iter-342 push
token-mapping diagnostic (the one that revealed the caller's stale FCM tokens).
Two small, additive edits inside `backend/server.py`. Nothing is removed, so it
can't break existing behaviour.

> Apply by anchor text (line numbers will differ in your copy). Both edits live
> inside `async def send_push(...)` / `async def notify_event(...)` where the
> referenced variables (`recipients`, `data`, `stats`, `_derive_push_routing`,
> `logger`) are already in scope.

---

## Edit 1 — in `send_push`, right AFTER the token query

**Find this anchor** (the line that loads the tokens and records the count):

```python
            tokens = await cursor.to_list(length=500)
            stats["token_count"] = len(tokens)
```

**Insert this block immediately after those two lines** (i.e. BEFORE the
existing `if tokens:`):

```python
            # iter-342: per-recipient token-mapping diagnostic. Pinpoints WHY a
            # push (esp. a call-declined to the caller) delivered to nobody:
            #   • recipients with 0 tokens  → the id we were given matches no
            #     push_tokens row on either key (registration/id-form mismatch)
            #   • which key matched          → user_id (OIDC sub) vs convex_user_id
            # This makes "backend accepted 202 but caller got nothing" logs
            # self-explanatory. Kept concise (ids truncated) and INFO-level.
            try:
                recip_set = set(recipients)
                by_user_id: set[str] = set()
                by_convex_id: set[str] = set()
                for t in tokens:
                    uid = str(t.get("user_id") or "")
                    cid = str(t.get("convex_user_id") or "")
                    if uid in recip_set:
                        by_user_id.add(uid)
                    if cid in recip_set:
                        by_convex_id.add(cid)
                matched = by_user_id | by_convex_id
                missing = [r for r in recipients if r not in matched]
                stats["unmatched_recipients"] = [str(m) for m in missing]
                stats["matched_via_user_id"] = len(by_user_id)
                stats["matched_via_convex_id"] = len(by_convex_id)
                _push_type_dbg = _derive_push_routing(data).get("type") or "?"
                logger.info(
                    "[PUSH][token-map] type=%s recipients=%d matched=%d tokens=%d "
                    "via_user_id=%d via_convex_id=%d missing=%s",
                    _push_type_dbg,
                    len(recipients),
                    len(matched),
                    len(tokens),
                    len(by_user_id),
                    len(by_convex_id),
                    [str(m)[:14] + "…" for m in missing[:5]],
                )
            except Exception:
                pass
```

> If your `send_push` names its recipients argument something other than
> `recipients`, use that name in the block above. Everything else is standard.

---

## Edit 2 — in `notify_event`, add 3 fields to the trigger-log document

**Find this anchor** (inside the `push_trigger_log` insert dict):

```python
                "fcm_errors": (stats.get("errors") or [])[:5],
                "token_count": stats.get("token_count", 0),
            }
```

**Change it to** (add the three lines before the closing `}`):

```python
                "fcm_errors": (stats.get("errors") or [])[:5],
                "token_count": stats.get("token_count", 0),
                # iter-342: id-mapping diagnostic — which recipients had NO
                # matching device token, and which key the matches came from.
                "unmatched_recipients": stats.get("unmatched_recipients", []),
                "matched_via_user_id": stats.get("matched_via_user_id", 0),
                "matched_via_convex_id": stats.get("matched_via_convex_id", 0),
            }
```

---

## What it gives you
- A log line per push: `[PUSH][token-map] type=call-declined recipients=1 matched=1
  tokens=3 via_user_id=0 via_convex_id=1 missing=[...]`.
- The same fields persisted to the `push_trigger_log` collection, so they show
  up in `GET /api/push-debug?triggers=N` without needing shell access.

## Verify after applying
1. `python -c "import ast; ast.parse(open('backend/server.py').read())"` → no
   syntax error.
2. Restart the backend, send any push, and confirm a `[PUSH][token-map]` line
   appears in the logs.
