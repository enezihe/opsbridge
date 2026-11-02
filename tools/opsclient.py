"""Tiny stdlib HTTP client shared by smoke_test.py and drill.py."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional, Tuple


def request(method: str, url: str, body: Any = None, token: Optional[str] = None, headers: Optional[Dict[str, str]] = None, timeout: float = 15) -> Tuple[int, Any, Dict[str, str]]:
    data = None if body is None else json.dumps(body).encode()
    h = {"accept": "application/json", **(headers or {})}
    if data is not None:
        h.setdefault("content-type", "application/json")
    if token:
        h["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw, status, hdrs = res.read(), res.status, dict(res.headers)
    except urllib.error.HTTPError as err:
        raw, status, hdrs = err.read(), err.code, dict(err.headers)
    except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
        return 0, {"error": str(err)}, {}
    try:
        return status, json.loads(raw) if raw else None, {k.lower(): v for k, v in hdrs.items()}
    except ValueError:
        return status, raw.decode(errors="replace"), {k.lower(): v for k, v in hdrs.items()}


def get_token(base_url: str, email: str, password: str) -> str:
    """Local-mode login through the gateway, or a Keycloak password grant when KEYCLOAK_TOKEN_URL is set."""
    kc = os.environ.get("KEYCLOAK_TOKEN_URL")
    if kc:
        form = urllib.parse.urlencode({"grant_type": "password", "client_id": os.environ.get("KEYCLOAK_CLIENT_ID", "opsbridge-cli"), "username": email, "password": password}).encode()
        req = urllib.request.Request(kc, data=form, headers={"content-type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.load(res)["access_token"]
    status, body, _ = request("POST", f"{base_url}/auth/login", {"email": email, "password": password})
    if status != 200:
        raise RuntimeError(f"login failed for {email}: {status} {body}")
    return body["accessToken"]


def wait_until(predicate, timeout: float, interval: float = 0.5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None
