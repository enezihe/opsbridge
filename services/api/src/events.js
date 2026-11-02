import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import { currentTrace, outgoingTraceHeaders } from '@opsbridge/common';
import { Outbox } from './models.js';

/**
 * Domain events are stored in an outbox collection next to the incident change and relayed to Kafka by a
 * background loop. A broker outage therefore never fails a user request; delivery is at-least-once with
 * exponential backoff, and consumers de-duplicate on `eventId`.
 * (With a replica set / Cosmos DB transactions the two writes can be made atomic; on a standalone
 *  Mongo the window between them is accepted and covered by the idempotent consumer.)
 */
export async function recordEvent(config, type, incident, actor) {
  const event = {
    eventId: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    traceId: currentTrace().traceId,
    actor,
    data: {
      incidentId: String(incident.id),
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      service: incident.service,
      createdAt: incident.createdAt,
      resolvedAt: incident.resolvedAt,
    },
  };
  await Outbox.create({ topic: config.eventsTopic, key: event.data.incidentId, payload: event, headers: outgoingTraceHeaders() });
  return event;
}

export class KafkaPublisher {
  constructor(clientOptions, clientId = 'opsbridge-api') {
    this.producer = new Kafka({ ...clientOptions, clientId, logLevel: logLevel.NOTHING, retry: { retries: 2 } }).producer({ allowAutoTopicCreation: true });
    this.connected = false;
  }

  async send({ topic, key, value, headers }) {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    await this.producer.send({ topic, messages: [{ key, value: JSON.stringify(value), headers }] });
  }

  async disconnect() {
    if (this.connected) await this.producer.disconnect();
  }
}

/** Used when no broker is configured: events are logged and considered delivered. */
export class LogPublisher {
  constructor(logger) {
    this.logger = logger;
  }

  async send({ topic, value }) {
    this.logger.info('event_published_noop', { event: 'event_published_noop', topic, type: value.type, eventId: value.eventId });
  }

  async disconnect() {}
}

export class OutboxRelay {
  constructor({ publisher, logger, metrics, intervalMs = 1000, batchSize = 50, maxAttempts = 10, leaseMs = 30_000 }) {
    Object.assign(this, { publisher, logger, intervalMs, batchSize, maxAttempts, leaseMs });
    this.sent = metrics?.counter('outbox_events_sent_total', 'Events delivered to the broker');
    this.failed = metrics?.counter('outbox_publish_failures_total', 'Failed publish attempts');
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => this.logger.error('outbox_tick_failed', { err })), this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    await this.publisher.disconnect();
  }

  /** Claims due records (lease prevents two relays double-sending) and publishes them. Returns how many were sent. */
  async tick() {
    let delivered = 0;
    for (let i = 0; i < this.batchSize; i++) {
      const now = new Date();
      const record = await Outbox.findOneAndUpdate(
        { $or: [{ status: 'pending', nextAttemptAt: { $lte: now } }, { status: 'sending', nextAttemptAt: { $lte: now } }] },
        { $set: { status: 'sending', nextAttemptAt: new Date(now.getTime() + this.leaseMs) }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, new: true },
      );
      if (!record) break;
      try {
        await this.publisher.send({ topic: record.topic, key: record.key, value: record.payload, headers: Object.fromEntries(record.headers ?? []) });
        record.status = 'sent';
        await record.save();
        this.sent?.inc();
        delivered++;
      } catch (err) {
        const exhausted = record.attempts >= this.maxAttempts;
        record.status = exhausted ? 'failed' : 'pending';
        record.lastError = err.message;
        record.nextAttemptAt = new Date(Date.now() + Math.min(60_000, 500 * 2 ** record.attempts));
        await record.save();
        this.failed?.inc();
        this.logger[exhausted ? 'error' : 'warn']('outbox_publish_failed', { event: 'outbox_publish_failed', eventId: record.payload?.eventId, attempts: record.attempts, exhausted, err });
      }
    }
    return delivered;
  }
}
