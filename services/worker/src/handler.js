import mongoose from 'mongoose';
import { contextFromTraceparent, runWithTrace } from '@opsbridge/common';
import { withRetry } from './retry.js';

const auditSchema = new mongoose.Schema(
  { eventId: { type: String, unique: true }, type: String, incidentId: { type: String, index: true }, actor: String, traceId: String, data: mongoose.Schema.Types.Mixed, occurredAt: Date, notifiedAt: Date },
  { timestamps: true },
);
export const AuditEvent = mongoose.models.AuditEvent ?? mongoose.model('AuditEvent', auditSchema, 'audit_events');

export class PermanentError extends Error {}

const PAGE_SEVERITIES = new Set(['sev1', 'sev2']);

/**
 * Handles one Kafka message. Guarantees:
 *  - idempotent: redelivery of the same eventId changes nothing (unique index on eventId)
 *  - transient failures (notification webhook) are retried with backoff
 *  - poison messages and exhausted retries go to the dead-letter topic with the failure reason, and the
 *    partition keeps moving, so one bad message cannot block the stream.
 */
export function createHandler({ logger, metrics, sendToDlq, notify, retry = {}, dlqTopic = 'incident.events.dlq' }) {
  const processed = metrics?.counter('worker_events_processed_total', 'Events handled', ['type', 'outcome']);

  return async function handle({ value, headers = {}, topic, partition, offset }) {
    const ctx = contextFromTraceparent(headers.traceparent?.toString());
    return runWithTrace(ctx, async () => {
      let event;
      try {
        event = JSON.parse(value.toString());
        if (!event.eventId || !event.type || !event.data?.incidentId) throw new PermanentError('event is missing eventId/type/data.incidentId');
      } catch (err) {
        return deadLetter(err instanceof PermanentError ? err : new PermanentError(`unparseable payload: ${err.message}`), value, { topic, partition, offset });
      }

      try {
        const fresh = await withRetry(() => process_(event), { ...retry, isRetryable: (e) => !(e instanceof PermanentError), onRetry: (e, attempt, delay) => logger.warn('event_retry', { event: 'event_retry', eventId: event.eventId, attempt, delayMs: Math.round(delay), err: e }) });
        processed?.inc({ type: event.type, outcome: fresh ? 'processed' : 'duplicate' });
        logger.info(fresh ? 'event_processed' : 'event_duplicate_skipped', { event: fresh ? 'event_processed' : 'event_duplicate_skipped', eventId: event.eventId, type: event.type, incidentId: event.data.incidentId });
      } catch (err) {
        await deadLetter(err, value, { topic, partition, offset }, event);
      }
    });
  };

  // Two idempotent steps. The audit row records progress (notifiedAt), so a retry after a failed
  // notification resumes at the notification instead of being mistaken for a duplicate delivery.
  async function process_(event) {
    let record = await AuditEvent.findOne({ eventId: event.eventId });
    let created = false;
    if (!record) {
      try {
        record = await AuditEvent.create({ eventId: event.eventId, type: event.type, incidentId: event.data.incidentId, actor: event.actor, traceId: event.traceId, data: event.data, occurredAt: new Date(event.occurredAt) });
        created = true;
      } catch (err) {
        if (err.code !== 11000) throw err;
        record = await AuditEvent.findOne({ eventId: event.eventId }); // concurrent consumer won the race
      }
    }
    const needsPage = notify && event.type === 'incident.created' && PAGE_SEVERITIES.has(event.data.severity) && !record.notifiedAt;
    if (needsPage) {
      await notify(event);
      await AuditEvent.updateOne({ eventId: event.eventId }, { notifiedAt: new Date() });
    }
    return created || needsPage;
  }

  async function deadLetter(err, value, origin, event) {
    processed?.inc({ type: event?.type ?? 'unknown', outcome: 'dead_lettered' });
    logger.error('event_dead_lettered', { event: 'event_dead_lettered', eventId: event?.eventId, reason: err.message, attempts: err.attempts ?? 1, ...origin });
    await sendToDlq({
      topic: dlqTopic,
      messages: [{ key: event?.data?.incidentId ?? null, value, headers: { 'x-error': String(err.message).slice(0, 500), 'x-attempts': String(err.attempts ?? 1), 'x-origin': `${origin.topic}/${origin.partition}/${origin.offset}` } }],
    });
  }
}

/** Posts a Slack/Teams-compatible message. 5xx/network errors are retryable, 4xx are permanent. */
export function webhookNotifier(url, fetchImpl = fetch) {
  return async (event) => {
    const { severity, title, service, incidentId } = event.data;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `:rotating_light: ${severity.toUpperCase()} on ${service}: ${title} (${incidentId})` }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 400 && res.status < 500) throw new PermanentError(`webhook rejected with ${res.status}`);
    if (!res.ok) throw new Error(`webhook failed with ${res.status}`);
  };
}
