"""Detection and correlation: error spikes, latency percentiles, error signatures, trace reconstruction,
and which change events happened just before things went wrong."""
from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Sequence

from .parse import Record

CHANGE_EVENTS = {"deploy", "chaos_updated", "config_change", "api_listening", "gateway_listening", "worker_started"}


def minute(ts: datetime) -> datetime:
    return ts.replace(second=0, microsecond=0)


@dataclass
class Bucket:
    start: datetime
    requests: int = 0
    errors: int = 0

    @property
    def error_rate(self) -> float:
        return self.errors / self.requests if self.requests else 0.0


@dataclass
class Spike:
    start: datetime
    end: datetime
    peak_error_rate: float
    errors: int
    requests: int
    baseline: float


def http_records(records: Sequence[Record], service: Optional[str] = None) -> List[Record]:
    return [r for r in records if r.event == "http_request" and (service is None or r.service == service)]


def buckets_per_minute(records: Sequence[Record]) -> List[Bucket]:
    """Zero-filled so a quiet minute counts as healthy rather than disappearing from the series."""
    if not records:
        return []
    table: Dict[datetime, Bucket] = {}
    for r in records:
        b = table.setdefault(minute(r.ts), Bucket(minute(r.ts)))
        b.requests += 1
        b.errors += 1 if r.is_error else 0
    start, end = min(table), max(table)
    out, cursor = [], start
    while cursor <= end:
        out.append(table.get(cursor, Bucket(cursor)))
        cursor += timedelta(minutes=1)
    return out


def detect_spikes(buckets: Sequence[Bucket], min_rate: float = 0.02, mad_factor: float = 4.0, min_requests: int = 5, min_errors: int = 3) -> List[Spike]:
    """A minute is anomalous when its error rate exceeds the baseline (median) by max(`mad_factor` median
    absolute deviations, `min_rate`) AND it holds at least `min_errors` errors (so one stray 500 in a quiet
    minute is not an incident). Median/MAD keeps a long outage from hiding itself by dragging the baseline
    up, unlike mean/stddev. Adjacent anomalous minutes are merged. Low `min_rate` on purpose: when an outage
    slows clients down, healthy traffic dilutes the rate, so the first minute is easy to miss."""
    rated = [b for b in buckets if b.requests >= min_requests]
    if not rated:
        return []
    rates = [b.error_rate for b in rated]
    baseline = statistics.median(rates)
    mad = statistics.median(abs(r - baseline) for r in rates)
    threshold = baseline + max(mad_factor * mad, min_rate)

    spikes: List[Spike] = []
    current: Optional[List[Bucket]] = None
    for b in buckets:
        anomalous = b.requests >= min_requests and b.errors >= min_errors and b.error_rate > threshold
        if anomalous:
            current = (current or []) + [b]
        elif current:
            spikes.append(_spike(current, baseline))
            current = None
    if current:
        spikes.append(_spike(current, baseline))
    return spikes


def _spike(group: List[Bucket], baseline: float) -> Spike:
    return Spike(
        start=group[0].start,
        end=group[-1].start + timedelta(minutes=1),
        peak_error_rate=max(b.error_rate for b in group),
        errors=sum(b.errors for b in group),
        requests=sum(b.requests for b in group),
        baseline=baseline,
    )


def percentile(values: Sequence[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = (len(ordered) - 1) * pct / 100
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def latency_by_route(records: Sequence[Record]) -> List[Dict]:
    by_route: Dict[str, List[float]] = defaultdict(list)
    for r in records:
        if r.duration_ms is not None:
            by_route[f"{r.raw.get('method', '?')} {r.raw.get('route') or r.raw.get('path', '?')}"].append(r.duration_ms)
    rows = [
        {"route": route, "count": len(v), "p50": round(percentile(v, 50)), "p95": round(percentile(v, 95)), "p99": round(percentile(v, 99)), "max": round(max(v))}
        for route, v in by_route.items()
    ]
    return sorted(rows, key=lambda row: row["p95"], reverse=True)


# Collapse volatile tokens (ids, durations, big numbers) but keep short numbers: HTTP statuses are signal.
_NOISE = [
    (re.compile(r"[0-9a-f]{24}"), "<id>"),
    (re.compile(r"[0-9a-f]{8}-[0-9a-f-]{27}"), "<uuid>"),
    (re.compile(r"\b\d+(?:\.\d+)?\s?(?:ms|s)\b"), "<dur>"),
    (re.compile(r"\b\d{5,}\b"), "<n>"),
]


def signature(r: Record) -> str:
    """Stable fingerprint so 10,000 'timeout on order 123' lines collapse into one finding."""
    err = r.raw.get("err") if isinstance(r.raw.get("err"), dict) else {}
    where = f"{r.raw.get('method')} {r.raw.get('route')}" if r.event == "http_request" and r.raw.get("route") else ""
    parts = [r.service, r.event, where, str(r.raw.get("code") or err.get("code") or ""), str(r.raw.get("status") or ""), err.get("message") or r.raw.get("reason") or ""]
    text = " | ".join(p for p in parts if p)
    for pattern, repl in _NOISE:
        text = pattern.sub(repl, text)
    return text


def top_signatures(records: Sequence[Record], limit: int = 8) -> List[Dict]:
    groups: Dict[str, List[Record]] = defaultdict(list)
    for r in records:
        if r.is_error or r.level == "warn":
            groups[signature(r)].append(r)
    rows = [
        {"signature": sig, "count": len(rs), "level": "error" if any(x.is_error for x in rs) else "warn", "first": rs[0].ts, "last": rs[-1].ts, "example_trace": next((x.trace_id for x in rs if x.trace_id), None)}
        for sig, rs in groups.items()
    ]
    return sorted(rows, key=lambda row: (row["level"] != "error", -row["count"]))[:limit]


def changes_before(records: Sequence[Record], moment: datetime, window: timedelta = timedelta(minutes=15)) -> List[Record]:
    """Change events inside the window before `moment`: the first place to look for a cause."""
    return [r for r in records if r.event in CHANGE_EVENTS and moment - window <= r.ts <= moment]


def group_traces(records: Sequence[Record]) -> Dict[str, List[Record]]:
    traces: Dict[str, List[Record]] = defaultdict(list)
    for r in records:
        if r.trace_id:
            traces[r.trace_id].append(r)
    return traces


def trace_summary(trace: Sequence[Record]) -> Dict:
    ordered = sorted(trace, key=lambda r: r.ts)
    return {
        "trace_id": ordered[0].trace_id,
        "services": sorted({r.service for r in ordered}),
        "start": ordered[0].ts,
        "duration_ms": max((r.duration_ms or 0) for r in ordered),
        "errors": sum(1 for r in ordered if r.is_error),
        "events": [(r.ts, r.service, r.level, r.event, r.raw.get("status")) for r in ordered],
    }


def affected_users(records: Sequence[Record]) -> int:
    return len({r.raw.get("userId") for r in records if r.is_error and r.raw.get("userId")})


def summarize_levels(records: Sequence[Record]) -> Counter:
    return Counter((r.service, r.level) for r in records)
