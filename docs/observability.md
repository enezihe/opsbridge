# Observability

## What is emitted
- **Logs**: one JSON object per line on stdout: `ts, level, service, msg, event, traceId, spanId` plus event fields. Access lines (`event=http_request`) carry `method, route, status, durationMs, userId`. `route` is the route *template* (`/incidents/:id`), identical for success and failure.
- **Traces**: W3C `traceparent` is created at the gateway, continued by the API (and into Kafka message headers), and by the worker. Dynatrace/Application Insights/OpenTelemetry understand it, and `x-trace-id` is returned to clients so a user report maps to a trace.
- **Metrics** (`/metrics`, Prometheus format): `http_request_duration_seconds{method,route,status}`, `gateway_denied_total{reason}`, `outbox_events_sent_total`, `outbox_publish_failures_total`, `worker_events_processed_total{type,outcome}`, Node runtime metrics.

## Shipping to Splunk
Either forward stdout with the Universal Forwarder / Azure Monitor, or set `SPLUNK_HEC_URL` and `SPLUNK_HEC_TOKEN` and the services ship batches to the HTTP Event Collector directly (failures never affect the app). Not exercised against a real Splunk here.

## Splunk searches (index `opsbridge`, sourcetype `_json`)
```spl
# 1. 5xx rate per minute by service
index=opsbridge event=http_request | eval err=if(status>=500,1,0)
| timechart span=1m sum(err) AS errors count AS requests by service

# 2. Follow one request across gateway -> api -> worker
index=opsbridge traceId=<id> | sort 0 _time | table _time service level event status durationMs

# 3. p95 latency per route
index=opsbridge event=http_request service=api | stats perc95(durationMs) AS p95 count by route | sort - p95

# 4. Why are users being denied?
index=opsbridge event=request_denied | stats count by reason, path | sort - count

# 5. Dead letters and retries
index=opsbridge (event=event_dead_lettered OR event=event_retry) | stats count by event, reason

# 6. Brute-force signal on login
index=opsbridge event=login_failed | stats count by email | where count>5

# 7. Change correlation: what changed before the spike?
index=opsbridge (event=chaos_updated OR event=*_listening OR event=worker_started) | table _time service event
```
Alert suggestion: query 1 with `errors/requests > 0.05` for 3 consecutive minutes.

## Dynatrace
Ingest logs through Log Monitoring / OneAgent, and tag services `opsbridge-{gateway,api,worker}`. Because every hop carries `traceparent`, distributed traces join the three services; filter by `traceId` from the logs. Davis can alert on the failure rate of `GET /incidents`. Dashboards: failure rate and response time by route, `gateway_denied_total`, dead-letter count.

## Azure
Terraform provisions Log Analytics + App Insights, diagnostic settings (HTTP, console, platform logs) for all three apps, metric alerts on gateway 5xx and latency, and a KQL alert on `event_dead_lettered`. Example KQL:
```kusto
AppServiceConsoleLogs
| where ResultDescription has "http_request"
| extend j = parse_json(ResultDescription)
| summarize requests=count(), errors=countif(toint(j.status) >= 500) by bin(TimeGenerated, 1m)
```

## Local equivalent
`make logs && make triage` produces the same analysis from `docker compose logs` using [`tools/logtriage`](../tools/logtriage).
