# Runbook

Triage order: **is it the change, the dependency, or the load?** Everything is searchable by `traceId`.

## 1. First five minutes
1. `curl $URL/readyz`: gateway ready? (503 means the API is unreachable.)
2. Error rate: Splunk query #1 in [observability.md](observability.md), or `make logs && make triage`.
3. Did anything change just before? `logtriage` prints change events (`deploy`, `chaos_updated`, startups) in the 15 min before the first error.
4. Grab one failing `x-trace-id` from a client response or the report and follow it across services: `python3 -m logtriage trace <id> out/stack.log`.

## 2. Symptom → likely cause → action
| Symptom | Likely cause | Check | Action |
|---|---|---|---|
| Spike of `401` | token expiry, wrong `JWT_SECRET`, Keycloak issuer mismatch | gateway `request_denied` reasons (`token_expired`, `invalid_token`) | align secret / issuer; check Keycloak health |
| Spike of `403` | role mapping changed in Keycloak | `insufficient_role` + user id | fix realm role assignment |
| `429` | rate limit hit or brute force on `/auth/*` | `gateway_denied_total{reason="rate_limited"}`, source IP | raise limit or block IP |
| `502 UPSTREAM_UNAVAILABLE` | API down / restarting | `docker compose ps`, App Service health check | restart, inspect `api` logs |
| `504 DB_TIMEOUT` | data store slow or unreachable | API `unhandled_error`, Mongo/Cosmos metrics (RU throttling `429` on Cosmos) | scale RU/tier, check connection limits |
| Events not appearing in `/audit` | broker down, relay failing, worker stopped | `outbox_publish_failed`, `outbox_events_sent_total`, worker logs | restore Kafka; outbox drains by itself |
| `event_dead_lettered` alert | poison message or notification webhook failing | DLQ header `x-error`, `x-origin` | fix cause, replay from `incident.events.dlq` |

## 3. Rollback
- Azure: re-run the `deploy` workflow with the previous `image_tag` (plan + approval + smoke test apply as usual).
- VM: `ansible-playbook deploy.yml -e opsbridge_image_tag=<previous>`.
- After any rollback run `python3 tools/smoke_test.py --base-url $URL`.

## 4. Closing an incident
Record the confirmed root cause in OpsBridge itself (`PATCH /incidents/{id}` with `status=resolved` and `rootCause`), attach the triage report as a note, and file follow-ups. The API refuses to resolve without a root cause by design.

## 5. Secrets rotation
Rotate `jwt-secret` / `internal-key` in Key Vault (new secret version), then restart the three apps; Key Vault references resolve the new version. Cosmos keys: regenerate secondary, update `mongo-url`, restart, then regenerate primary.
