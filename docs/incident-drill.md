# Incident drill: injected database timeouts

Goal: practise the detect → correlate → diagnose loop with the real stack, and prove the tooling finds the cause.

## Setup
```bash
make up && make seed
python3 tools/drill.py --phase-seconds 75 --rps 15     # baseline -> fault -> recovery
make logs && make triage
```
`drill.py` drives steady traffic through the gateway, then an admin calls `PUT /admin/chaos` (enabled only with `ENABLE_CHAOS=true`) to make `70%` of `/incidents` calls fail with `504 DB_TIMEOUT` and the rest slow down by 800 ms, then removes the fault.

## What the drill printed
```
[12:59:38] BASELINE (healthy) for 75s
            status counts so far: {200: 3853, 429: 16}
[13:00:53] FAULT INJECTED (errorRate=0.7, latencyMs=800) for 75s
            status counts so far: {200: 3967, 429: 16, 504: 226}
[13:02:08] RECOVERY for 75s
            status counts so far: {200: 7860, 429: 16, 504: 226}
drill finished
```
The 16 `429`s at baseline are the gateway rate limiter (3000 req/min per IP) correctly shedding the load generator, not part of the fault.

## What `logtriage` reported
### Incident triage report (output of `logtriage analyze --service api`)

- **Window:** 2026-10-07 16:59:25 to 17:03:23 UTC
- **Records:** 16487 parsed, 0 skipped | **Service filter:** `api`
- **HTTP requests:** 8105 | **5xx / error events:** 452 | **Distinct users hitting errors:** 3

## Verdict
**Error spike 17:01:00 - 17:02:00**: peak 65% (baseline 1%), 178 errors across 272 requests. First error at 17:00:54.

**Prime suspect:** `api` **chaos_updated** at 17:00:53, 1s before the first error.

## Top error signatures

| # | Count | Level | First seen | Signature | Example trace |
|---|---|---|---|---|---|
| 1 | 226 | error | 17:00:54 | `api | unhandled_error | DB_TIMEOUT | Upstream data store timed out (injected fault)` | `50d61dd3fcb9` |
| 2 | 226 | error | 17:00:54 | `api | http_request | GET /incidents | 504` | `50d61dd3fcb9` |
| 3 | 3 | warn | 17:00:53 | `api | chaos_updated` | `b7b4e3506f6c` |
| 4 | 1 | warn | 16:59:36 | `api | http_request | PATCH /incidents/:id | 409` | `5c9f6927884f` |
| 5 | 1 | warn | 16:59:36 | `api | http_request | PATCH /incidents/:id | 422` | `8f8e2a42d1dc` |

## Change correlation (15 min before first spike)

- 16:59:25 `gateway` **gateway_listening** port=8080
- 16:59:25 `api` **api_listening** port=3000
- 16:59:26 `worker` **worker_started**
- 17:00:53 `api` **chaos_updated** errorRate=0.7 latencyMs=800 by=6ac67a78b074698f1a6b84df

## Latency by route (ms)

| Route | Count | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| `POST /auth/login` | 6 | 75 | 90 | 93 | 94 |
| `POST /incidents` | 1 | 15 | 15 | 15 | 15 |
| `GET /incidents` | 8086 | 2 | 9 | 804 | 834 |
| `PATCH /incidents/:id` | 4 | 5 | 8 | 8 | 8 |
| `GET /audit` | 3 | 7 | 7 | 7 | 7 |
| `DELETE /incidents/:id` | 1 | 5 | 5 | 5 | 5 |
| `GET /stats` | 1 | 4 | 4 | 4 | 4 |
| `PUT /admin/chaos` | 3 | 1 | 1 | 1 | 1 |

## Example failing trace `50d61dd3fcb9d4a0aa7d8888656e2d97`

Services: api, gateway | duration 803 ms

- 17:00:54 `api` error unhandled_error
- 17:00:54 `api` error http_request (504)
- 17:00:54 `gateway` error http_request (504)

Search it: Splunk `index=opsbridge traceId=50d61dd3fcb9d4a0aa7d8888656e2d97` | Dynatrace: distributed traces filtered by this trace id.

## Next steps (draft)

1. Confirm the top signature against the example trace and the dependency it names.
2. Check whether the change events above can be rolled back or toggled off.
3. Record the confirmed root cause on the incident (`PATCH /incidents/{id}` with `rootCause`) before resolving.



## Findings
- **Detection**: error-rate spike found by median/MAD baseline; the fault minute was diluted by healthy traffic, so the first error (17:00:54) sits in the minute before the flagged window, and the tool looks one minute back to report it.
- **Impact**: ~226 failed requests of ~8100; p99 on `GET /incidents` rose to ~800 ms while p50 stayed at 2 ms: a *partial* failure that an average would have hidden.
- **Cause chain**: `chaos_updated` (errorRate 0.7, latencyMs 800) one second before the first error → `DB_TIMEOUT` in the API → `504` at the gateway, all under one trace id.
- **Recovery**: error rate returned to baseline within a minute of the fault being removed.

## Two defects the drill exposed (both fixed)
1. `route` was logged as `unmatched` for failed requests (and `/:id` without its prefix), so errors and successes of one endpoint landed in different metric series. Fix: routers record their base path; regression test in `services/api/test/api.test.js`.
2. The first spike detector used a 5% floor and missed the diluted first minute. Fix: floor lowered to a 2% rise with a minimum of 3 errors; regression test `test_diluted_first_minute_is_still_flagged`.

## Resilience drill (Kafka outage)
Stopped the Kafka container, created 3 incidents (all `201`), restarted Kafka: the outbox relay delivered the events and `/audit` showed `incident.created` for all three. Producer failures are retried with backoff and visible as `outbox_publish_failed` and `outbox_publish_failures_total`.
