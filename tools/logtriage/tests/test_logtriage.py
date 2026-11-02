import json
import unittest
from datetime import datetime, timedelta, timezone

from logtriage import analyze
from logtriage.cli import main
from logtriage.parse import parse_lines
from logtriage.report import build_report

T0 = datetime(2026, 1, 5, 10, 0, 0, tzinfo=timezone.utc)


def line(offset_s, service="api", level="info", event="http_request", **extra):
    rec = {"ts": (T0 + timedelta(seconds=offset_s)).isoformat().replace("+00:00", "Z"), "level": level, "service": service, "msg": event, "event": event}
    rec.update(extra)
    return json.dumps(rec)


def healthy(minute_idx, n=10, status=200):
    return [line(minute_idx * 60 + i * 5, status=status, method="GET", route="/incidents", durationMs=20 + i, traceId=f"{minute_idx:02d}{i:02d}".ljust(32, "a")) for i in range(n)]


def outage_logs():
    lines = []
    for m in range(0, 5):
        lines += healthy(m)
    lines.append(line(5 * 60 - 3, service="api", level="warn", event="chaos_updated", errorRate=0.8, latencyMs=0, by="admin1"))
    for m in range(5, 8):  # 3 bad minutes: 8 of 10 requests fail
        for i in range(10):
            bad = i < 8
            lines.append(line(m * 60 + i * 5, status=504 if bad else 200, method="GET", route="/incidents", durationMs=5000 if bad else 25, level="error" if bad else "info", traceId="bb" * 16 if i == 0 else f"{m}{i}".ljust(32, "c"), userId=f"user{i % 3}"))
            if bad:
                lines.append(line(m * 60 + i * 5, level="error", event="unhandled_error", code="DB_TIMEOUT", err={"message": f"timed out after {i}00ms on 64b7f0c2a1d3e4f5a6b7c8d9"}))
    for m in range(8, 11):
        lines += healthy(m)
    return lines


class ParseTests(unittest.TestCase):
    def test_tolerates_junk_and_compose_prefix(self):
        res = parse_lines(["not json", "", "api-1  | " + line(0), '{"no_ts": 1}', "{broken"])
        self.assertEqual(len(res.records), 1)
        self.assertEqual(res.skipped, 3)

    def test_sorts_by_time(self):
        res = parse_lines([line(30), line(0)])
        self.assertLess(res.records[0].ts, res.records[1].ts)


class AnalyzeTests(unittest.TestCase):
    def setUp(self):
        self.res = parse_lines(outage_logs())
        self.http = analyze.http_records(self.res.records, "api")

    def test_detects_exactly_one_spike_with_correct_bounds(self):
        spikes = analyze.detect_spikes(analyze.buckets_per_minute(self.http))
        self.assertEqual(len(spikes), 1)
        self.assertEqual(spikes[0].start, T0 + timedelta(minutes=5))
        self.assertEqual(spikes[0].end, T0 + timedelta(minutes=8))
        self.assertAlmostEqual(spikes[0].peak_error_rate, 0.8)
        self.assertEqual(spikes[0].errors, 24)

    def test_healthy_traffic_has_no_spike(self):
        res = parse_lines([l for m in range(10) for l in healthy(m)])
        self.assertEqual(analyze.detect_spikes(analyze.buckets_per_minute(analyze.http_records(res.records))), [])

    def test_a_single_blip_below_min_rate_is_ignored(self):
        lines = [l for m in range(10) for l in healthy(m)]
        lines += [line(100, status=500, level="error", method="GET", route="/x", durationMs=1)]
        res = parse_lines(lines)
        self.assertEqual(analyze.detect_spikes(analyze.buckets_per_minute(analyze.http_records(res.records)), min_rate=0.2), [])

    def test_diluted_first_minute_is_still_flagged(self):
        # Fault starts 34s into the minute while healthy traffic dominates: only ~5% of that minute fails.
        lines = [l for m in range(5) for l in healthy(m, n=60)]
        for i in range(60):
            lines.append(line(5 * 60 + i, status=504 if i >= 34 and i % 3 else 200, level="error" if i >= 34 and i % 3 else "info", method="GET", route="/incidents", durationMs=10))
        for i in range(40):
            lines.append(line(6 * 60 + i, status=504, level="error", method="GET", route="/incidents", durationMs=800))
        res = parse_lines(lines)
        spikes = analyze.detect_spikes(analyze.buckets_per_minute(analyze.http_records(res.records)))
        self.assertEqual(len(spikes), 1)
        self.assertEqual(spikes[0].start, T0 + timedelta(minutes=5))

    def test_quiet_minutes_are_zero_filled(self):
        res = parse_lines(healthy(0) + healthy(3))
        self.assertEqual(len(analyze.buckets_per_minute(analyze.http_records(res.records))), 4)

    def test_percentiles(self):
        self.assertEqual(analyze.percentile([1, 2, 3, 4, 5], 50), 3)
        self.assertAlmostEqual(analyze.percentile(list(range(1, 101)), 95), 95.05)
        self.assertEqual(analyze.percentile([], 95), 0.0)

    def test_signatures_collapse_variable_parts(self):
        sigs = analyze.top_signatures(self.res.records)
        timeouts = [s for s in sigs if "DB_TIMEOUT" in s["signature"]]
        self.assertEqual(len(timeouts), 1)
        self.assertEqual(timeouts[0]["count"], 24)
        self.assertIn("<id>", timeouts[0]["signature"])

    def test_change_event_before_spike_is_found(self):
        changes = analyze.changes_before(self.res.records, T0 + timedelta(minutes=5, seconds=30))
        self.assertEqual([c.event for c in changes], ["chaos_updated"])
        self.assertEqual(changes[0].raw["errorRate"], 0.8)

    def test_latency_ranks_slowest_route_first(self):
        rows = analyze.latency_by_route(self.http)
        self.assertEqual(rows[0]["route"], "GET /incidents")
        self.assertGreaterEqual(rows[0]["p99"], 5000)


class ReportAndCliTests(unittest.TestCase):
    def test_report_names_cause_and_change(self):
        md = build_report(parse_lines(outage_logs()), service="api")
        self.assertIn("Error spike 10:05:00 - 10:08:00", md)
        self.assertIn("DB_TIMEOUT", md)
        self.assertIn("chaos_updated", md)
        self.assertIn("errorRate=0.8", md)
        self.assertIn("bbbbbbbbbbbb", md)

    def test_report_on_empty_input(self):
        self.assertIn("No parsable", build_report(parse_lines([])))

    def test_cli_gate_exit_codes(self):
        import os
        import tempfile

        def run(lines, *extra):
            with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as f:
                f.write("\n".join(lines))
            try:
                return main(["analyze", f.name, "--format", "json", *extra])
            finally:
                os.unlink(f.name)

        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(run(outage_logs(), "--fail-on-spike"), 2)
            self.assertEqual(run([l for m in range(10) for l in healthy(m)], "--fail-on-spike"), 0)


if __name__ == "__main__":
    unittest.main()
