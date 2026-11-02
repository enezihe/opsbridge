#!/usr/bin/env python3
"""Post-deployment smoke test: the check a pipeline runs after a release (and an on-call engineer after a rollback).

Exercises the real path end to end: health -> authN -> authZ (401/403) -> CRUD + lifecycle -> async audit trail
(Kafka -> worker -> Mongo). Exit code 0 = release looks healthy, 1 = at least one check failed.

  python tools/smoke_test.py --base-url http://localhost:8080
Credentials come from env (SMOKE_ADMIN / SMOKE_ENGINEER / SMOKE_VIEWER, SMOKE_PASSWORD), never from code.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from opsclient import get_token, request, wait_until  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail and not ok else ""))
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=os.environ.get("BASE_URL", "http://localhost:8080"))
    ap.add_argument("--skip-events", action="store_true", help="do not wait for the Kafka-driven audit trail")
    ap.add_argument("--event-timeout", type=float, default=30)
    args = ap.parse_args()
    base = args.base_url.rstrip("/")
    pw = os.environ.get("SMOKE_PASSWORD", "ChangeMe!12345")
    started = time.time()
    print(f"Smoke test against {base}")

    s, b, _ = request("GET", f"{base}/healthz")
    check("gateway liveness", s == 200, f"{s} {b}")
    s, b, _ = request("GET", f"{base}/readyz")
    check("gateway readiness (upstream reachable)", s == 200, f"{s} {b}")

    s, _, _ = request("GET", f"{base}/incidents")
    check("anonymous request is rejected (401)", s == 401, str(s))
    s, _, _ = request("GET", f"{base}/internal/anything", token="x")
    check("unknown route is not exposed (404)", s == 404, str(s))

    try:
        admin = get_token(base, os.environ.get("SMOKE_ADMIN", "admin@opsbridge.local"), pw)
        eng = get_token(base, os.environ.get("SMOKE_ENGINEER", "engineer@opsbridge.local"), pw)
        viewer = get_token(base, os.environ.get("SMOKE_VIEWER", "viewer@opsbridge.local"), pw)
        check("login for admin/engineer/viewer", True)
    except Exception as err:  # noqa: BLE001
        check("login for admin/engineer/viewer", False, str(err))
        return summary()

    new = {"title": f"smoke {int(started)}", "severity": "sev2", "service": "smoke"}
    s, _, _ = request("POST", f"{base}/incidents", new, token=viewer)
    check("viewer cannot create incidents (403)", s == 403, str(s))
    s, inc, hdr = request("POST", f"{base}/incidents", new, token=eng)
    check("engineer creates incident (201 + Location)", s == 201 and "location" in hdr, f"{s} {inc}")
    if s != 201:
        return summary()
    iid = inc["id"]
    check("response carries a trace id", len(hdr.get("x-trace-id", "")) == 32)

    s, _, _ = request("PATCH", f"{base}/incidents/{iid}", {"status": "resolved"}, token=eng)
    check("cannot skip investigation (409)", s == 409, str(s))
    s, _, _ = request("PATCH", f"{base}/incidents/{iid}", {"status": "investigating"}, token=eng)
    check("open -> investigating (200)", s == 200, str(s))
    s, _, _ = request("PATCH", f"{base}/incidents/{iid}", {"status": "resolved"}, token=eng)
    check("resolving without root cause is refused (422)", s == 422, str(s))
    s, done, _ = request("PATCH", f"{base}/incidents/{iid}", {"status": "resolved", "rootCause": "Smoke test: synthetic root cause"}, token=eng)
    check("resolve with root cause (200)", s == 200 and done.get("resolvedAt"), f"{s} {done}")
    s, _, _ = request("DELETE", f"{base}/incidents/{iid}", token=eng)
    check("engineer cannot delete (403)", s == 403, str(s))
    s, stats, _ = request("GET", f"{base}/stats", token=viewer)
    check("stats endpoint returns MTTR", s == 200 and stats.get("resolved", 0) >= 1, f"{s} {stats}")

    if not args.skip_events:
        def audit_types():
            st, body, _ = request("GET", f"{base}/audit?incidentId={iid}", token=eng)
            types = [e["type"] for e in body["data"]] if st == 200 else []
            return types if {"incident.created", "incident.resolved"} <= set(types) else None

        types = wait_until(audit_types, args.event_timeout)
        check("Kafka -> worker -> audit trail received created+resolved", types, "no audit events before timeout")

    s, _, _ = request("DELETE", f"{base}/incidents/{iid}", token=admin)
    check("admin cleans up (204)", s == 204, str(s))
    return summary()


def summary() -> int:
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
