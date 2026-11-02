#!/usr/bin/env python3
"""Incident drill: generate steady traffic, inject a fault mid-way, remove it, and leave logs for logtriage.

  baseline (N s) -> fault ON (N s) -> recovery (N s)

Requires ENABLE_CHAOS=true on the API and an admin account. See docs/incident-drill.md.
"""
from __future__ import annotations

import argparse
import os
import random
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(__file__))
from opsclient import get_token, request  # noqa: E402


def traffic(base, tokens, stop, counters, rps):
    def worker():
        while not stop.is_set():
            token = random.choice(tokens)
            s, _, _ = request("GET", f"{base}/incidents?limit=5", token=token, timeout=20)
            counters[s] = counters.get(s, 0) + 1
            time.sleep(random.uniform(0.5, 1.5) / max(rps, 1))

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(4)]
    for t in threads:
        t.start()
    return threads


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8080")
    ap.add_argument("--phase-seconds", type=int, default=60)
    ap.add_argument("--rps", type=float, default=20)
    ap.add_argument("--error-rate", type=float, default=0.7)
    ap.add_argument("--latency-ms", type=int, default=800)
    a = ap.parse_args()
    base, pw = a.base_url.rstrip("/"), os.environ.get("SMOKE_PASSWORD", "ChangeMe!12345")

    admin = get_token(base, "admin@opsbridge.local", pw)
    tokens = [admin, get_token(base, "engineer@opsbridge.local", pw), get_token(base, "viewer@opsbridge.local", pw)]
    counters: dict = {}
    stop = threading.Event()
    traffic(base, tokens, stop, counters, a.rps)

    def phase(name, seconds):
        print(f"[{time.strftime('%H:%M:%S')}] {name} for {seconds}s", flush=True)
        time.sleep(seconds)
        print(f"            status counts so far: {dict(sorted(counters.items()))}", flush=True)

    try:
        phase("BASELINE (healthy)", a.phase_seconds)
        s, _, _ = request("PUT", f"{base}/admin/chaos", {"errorRate": a.error_rate, "latencyMs": a.latency_ms}, token=admin)
        if s != 200:
            print(f"could not enable chaos ({s}); is ENABLE_CHAOS=true?", file=sys.stderr)
            return 1
        phase(f"FAULT INJECTED (errorRate={a.error_rate}, latencyMs={a.latency_ms})", a.phase_seconds)
        request("PUT", f"{base}/admin/chaos", {"errorRate": 0, "latencyMs": 0}, token=admin)
        phase("RECOVERY", a.phase_seconds)
    finally:
        stop.set()
        request("PUT", f"{base}/admin/chaos", {"errorRate": 0, "latencyMs": 0}, token=admin)
    print("drill finished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
