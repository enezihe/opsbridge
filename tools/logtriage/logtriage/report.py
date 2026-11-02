"""Markdown incident-triage report: the first draft of an RCA that an engineer then confirms and edits."""
from __future__ import annotations

from datetime import timedelta
from typing import List, Optional

from . import analyze
from .parse import ParseResult, Record

fmt = lambda dt: dt.strftime("%H:%M:%S")  # noqa: E731


def build_report(result: ParseResult, service: Optional[str] = None, min_rate: float = 0.02) -> str:
    records: List[Record] = result.records
    if not records:
        return "# Incident triage\n\nNo parsable log records.\n"

    http = analyze.http_records(records, service)
    buckets = analyze.buckets_per_minute(http)
    spikes = analyze.detect_spikes(buckets, min_rate=min_rate)
    errors = [r for r in records if r.is_error and (service is None or r.service == service)]
    out = ["# Incident triage report", ""]
    out += [
        f"- **Window:** {records[0].ts:%Y-%m-%d %H:%M:%S} to {records[-1].ts:%H:%M:%S} UTC",
        f"- **Records:** {len(records)} parsed, {result.skipped} skipped" + (f" | **Service filter:** `{service}`" if service else ""),
        f"- **HTTP requests:** {len(http)} | **5xx / error events:** {len(errors)} | **Distinct users hitting errors:** {analyze.affected_users(records)}",
        "",
        "## Verdict",
    ]

    if not spikes:
        out += ["No error-rate anomaly detected against the median baseline.", ""]
    for s in spikes:
        first = next((r for r in errors if s.start - timedelta(minutes=1) <= r.ts < s.end), None)
        out += [
            f"**Error spike {fmt(s.start)} - {fmt(s.end)}**: peak {s.peak_error_rate:.0%} (baseline {s.baseline:.0%}), {s.errors} errors across {s.requests} requests."
            + (f" First error at {first.ts:%H:%M:%S}." if first else ""),
            "",
        ]
    if spikes:
        # Look one minute back: the minute the fault began is often diluted below the spike threshold.
        first_error = next((r for r in errors if r.ts >= spikes[0].start - timedelta(minutes=1)), None)
        if first_error:
            recent = analyze.changes_before(records, first_error.ts)
            deliberate = [c for c in recent if c.event not in ("api_listening", "gateway_listening", "worker_started")]
            suspect = (deliberate or recent or [None])[-1]
            if suspect:
                gap = (first_error.ts - suspect.ts).total_seconds()
                out += [f"**Prime suspect:** `{suspect.service}` **{suspect.event}** at {fmt(suspect.ts)}, {gap:.0f}s before the first error.", ""]

    sigs = analyze.top_signatures(records if service is None else [r for r in records if r.service == service])
    if sigs:
        out += ["## Top error signatures", "", "| # | Count | Level | First seen | Signature | Example trace |", "|---|---|---|---|---|---|"]
        for i, s in enumerate(sigs, 1):
            out.append(f"| {i} | {s['count']} | {s['level']} | {fmt(s['first'])} | `{s['signature']}` | `{(s['example_trace'] or '-')[:12]}` |")
        out.append("")

    if spikes:
        s = spikes[0]
        changes = analyze.changes_before(records, s.start + timedelta(minutes=1))
        out += ["## Change correlation (15 min before first spike)", ""]
        if changes:
            out += [f"- {fmt(c.ts)} `{c.service}` **{c.event}**" + "".join(f" {k}={c.raw[k]}" for k in ("errorRate", "latencyMs", "by", "port") if k in c.raw) for c in changes]
        else:
            out.append("- No deploy/config change events found: suspect a dependency or traffic pattern, not a release.")
        out.append("")

    lat = analyze.latency_by_route(http)
    if lat:
        out += ["## Latency by route (ms)", "", "| Route | Count | p50 | p95 | p99 | max |", "|---|---|---|---|---|---|"]
        out += [f"| `{r['route']}` | {r['count']} | {r['p50']} | {r['p95']} | {r['p99']} | {r['max']} |" for r in lat[:8]]
        out.append("")

    failing = [t for t in analyze.group_traces(records).values() if any(x.is_error for x in t)]
    if failing:
        worst = analyze.trace_summary(sorted(failing, key=lambda t: len(t), reverse=True)[0])
        out += [f"## Example failing trace `{worst['trace_id']}`", "", f"Services: {', '.join(worst['services'])} | duration {worst['duration_ms']:.0f} ms", ""]
        out += [f"- {fmt(ts)} `{svc}` {level} {event}" + (f" ({status})" if status else "") for ts, svc, level, event, status in worst["events"]]
        out += ["", "Search it: Splunk `index=opsbridge traceId=" + worst["trace_id"] + "` | Dynatrace: distributed traces filtered by this trace id.", ""]

    out += [
        "## Next steps (draft)",
        "",
        "1. Confirm the top signature against the example trace and the dependency it names.",
        "2. Check whether the change events above can be rolled back or toggled off.",
        "3. Record the confirmed root cause on the incident (`PATCH /incidents/{id}` with `rootCause`) before resolving.",
        "",
    ]
    return "\n".join(out)
