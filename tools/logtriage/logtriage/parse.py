"""Reading structured logs. One JSON object per line (what OpsBridge services, Splunk exports and
`docker compose logs --no-log-prefix` all produce). Lines that are not JSON are counted, never fatal."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Iterable, Iterator, List, Optional


@dataclass
class Record:
    ts: datetime
    level: str
    service: str
    msg: str
    event: str
    trace_id: Optional[str]
    raw: Dict

    @property
    def is_error(self) -> bool:
        status = self.raw.get("status")
        return self.level == "error" or (isinstance(status, int) and status >= 500)

    @property
    def duration_ms(self) -> Optional[float]:
        value = self.raw.get("durationMs")
        return float(value) if isinstance(value, (int, float)) else None


@dataclass
class ParseResult:
    records: List[Record] = field(default_factory=list)
    skipped: int = 0


def parse_ts(value: str) -> datetime:
    # Python 3.9 cannot parse the trailing "Z" with fromisoformat.
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_lines(lines: Iterable[str]) -> ParseResult:
    result = ParseResult()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # docker/compose prefixes ("api-1  | {...}") are tolerated by trimming to the first brace.
        start = line.find("{")
        if start < 0:
            result.skipped += 1
            continue
        try:
            obj = json.loads(line[start:])
            result.records.append(
                Record(
                    ts=parse_ts(obj["ts"]),
                    level=str(obj.get("level", "info")),
                    service=str(obj.get("service", "unknown")),
                    msg=str(obj.get("msg", "")),
                    event=str(obj.get("event") or obj.get("msg", "")),
                    trace_id=obj.get("traceId"),
                    raw=obj,
                )
            )
        except (ValueError, KeyError, TypeError):
            result.skipped += 1
    result.records.sort(key=lambda r: r.ts)
    return result


def iter_files(paths: List[str]) -> Iterator[str]:
    import sys

    if not paths or paths == ["-"]:
        yield from sys.stdin
        return
    for path in paths:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            yield from handle
