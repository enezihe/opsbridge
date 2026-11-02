from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime

from . import analyze, __version__
from .parse import iter_files, parse_lines
from .report import build_report


def _default(o):
    if isinstance(o, datetime):
        return o.isoformat()
    raise TypeError(type(o))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="logtriage", description="Triage structured JSON logs")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyze", help="spike detection, signatures, latency, change correlation")
    a.add_argument("files", nargs="*", help="log files (default: stdin)")
    a.add_argument("--service", help="only analyse this service's HTTP traffic")
    a.add_argument("--min-rate", type=float, default=0.02, help="minimum error-rate rise to call a spike (default 0.02)")
    a.add_argument("--format", choices=["md", "json"], default="md")
    a.add_argument("--fail-on-spike", action="store_true", help="exit 2 if a spike is found (use as a post-deploy gate)")

    t = sub.add_parser("trace", help="print the cross-service timeline for one trace id")
    t.add_argument("trace_id")
    t.add_argument("files", nargs="*")

    args = ap.parse_args(argv)
    result = parse_lines(iter_files(args.files))

    if args.cmd == "trace":
        trace = [r for r in result.records if r.trace_id == args.trace_id]
        if not trace:
            print(f"trace {args.trace_id} not found", file=sys.stderr)
            return 1
        for ts, svc, level, event, status in analyze.trace_summary(trace)["events"]:
            print(f"{ts:%H:%M:%S.%f}"[:-3], f"{svc:<8} {level:<5} {event}", status or "")
        return 0

    spikes = analyze.detect_spikes(analyze.buckets_per_minute(analyze.http_records(result.records, args.service)), min_rate=args.min_rate)
    if args.format == "json":
        http = analyze.http_records(result.records, args.service)
        json.dump(
            {
                "records": len(result.records),
                "skipped": result.skipped,
                "spikes": [s.__dict__ for s in spikes],
                "signatures": analyze.top_signatures(result.records),
                "latency": analyze.latency_by_route(http),
            },
            sys.stdout,
            default=_default,
            indent=2,
        )
        print()
    else:
        print(build_report(result, args.service, args.min_rate))
    return 2 if (args.fail_on_spike and spikes) else 0


if __name__ == "__main__":
    sys.exit(main())
