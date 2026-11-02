import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createLogger } from '@opsbridge/common';
import { AuditEvent, PermanentError, createHandler, webhookNotifier } from '../src/handler.js';
import { withRetry } from '../src/retry.js';

const event = (over = {}) => ({
  eventId: crypto.randomUUID(), type: 'incident.created', occurredAt: new Date().toISOString(), traceId: 'e'.repeat(32), actor: 'u1',
  data: { incidentId: 'inc-1', title: 'DB down', severity: 'sev1', status: 'open', service: 'orders' }, ...over,
});
const msg = (e) => ({ value: Buffer.from(typeof e === 'string' ? e : JSON.stringify(e)), headers: {}, topic: 'incident.events', partition: 0, offset: '7' });

describe('worker handler', () => {
  let mongo; let dlq; let logs;
  const logger = () => createLogger('w', { sink: (l) => logs.push(JSON.parse(l)) });
  const fast = { attempts: 3, baseMs: 1, sleep: async () => {} };

  before(async () => {
    mongo = process.env.MONGO_URL ? null : await MongoMemoryServer.create();
    await mongoose.connect(process.env.MONGO_URL ?? mongo.getUri('worker_test'));
    await AuditEvent.init();
  });
  after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
  beforeEach(async () => { dlq = []; logs = []; await AuditEvent.deleteMany({}); });

  it('writes an audit record', async () => {
    const e = event();
    await createHandler({ logger: logger(), sendToDlq: async (m) => dlq.push(m), retry: fast })(msg(e));
    const rec = await AuditEvent.findOne({ eventId: e.eventId });
    assert.equal(rec.incidentId, 'inc-1');
    assert.equal(rec.traceId, e.traceId);
    assert.equal(dlq.length, 0);
  });

  it('is idempotent when Kafka redelivers the same event', async () => {
    const e = event();
    const handle = createHandler({ logger: logger(), sendToDlq: async (m) => dlq.push(m), retry: fast });
    await handle(msg(e));
    await handle(msg(e));
    assert.equal(await AuditEvent.countDocuments({ eventId: e.eventId }), 1);
    assert.ok(logs.some((l) => l.event === 'event_duplicate_skipped'));
    assert.equal(dlq.length, 0);
  });

  it('dead-letters poison messages immediately, with the reason', async () => {
    const handle = createHandler({ logger: logger(), sendToDlq: async (m) => dlq.push(m), retry: fast });
    await handle(msg('{not json'));
    await handle(msg({ type: 'incident.created' }));
    assert.equal(dlq.length, 2);
    assert.equal(dlq[0].topic, 'incident.events.dlq');
    assert.match(dlq[0].messages[0].headers['x-error'], /unparseable/);
    assert.equal(dlq[0].messages[0].headers['x-origin'], 'incident.events/0/7');
  });

  it('retries a flaky webhook then succeeds without dead-lettering', async () => {
    let calls = 0;
    const notify = async () => { if (++calls < 3) throw new Error('503'); };
    await createHandler({ logger: logger(), sendToDlq: async (m) => dlq.push(m), notify, retry: fast })(msg(event()));
    assert.equal(calls, 3);
    assert.equal(dlq.length, 0);
    assert.equal(logs.filter((l) => l.event === 'event_retry').length, 2);
  });

  it('dead-letters after retries are exhausted and keeps the stream moving', async () => {
    const notify = async () => { throw new Error('webhook down'); };
    await createHandler({ logger: logger(), sendToDlq: async (m) => dlq.push(m), notify, retry: fast })(msg(event()));
    assert.equal(dlq.length, 1);
    assert.equal(dlq[0].messages[0].headers['x-attempts'], '3');
  });

  it('does not page for low severity events', async () => {
    let calls = 0;
    const handle = createHandler({ logger: logger(), sendToDlq: async () => {}, notify: async () => { calls++; }, retry: fast });
    await handle(msg(event({ data: { incidentId: 'i2', title: 't', severity: 'sev4', status: 'open', service: 's' } })));
    await handle(msg(event({ type: 'incident.updated' })));
    assert.equal(calls, 0);
  });

  it('webhook 4xx is permanent (no retries), 5xx is retryable', async () => {
    const e = event();
    const notifier = (status) => webhookNotifier('http://hook', async () => new Response('', { status }));
    await assert.rejects(notifier(400)(e), PermanentError);
    await assert.rejects(notifier(503)(e), (err) => !(err instanceof PermanentError));
    await notifier(200)(e);
  });
});

describe('withRetry', () => {
  it('backs off exponentially and stops on non-retryable errors', async () => {
    const delays = [];
    let n = 0;
    await assert.rejects(withRetry(() => { n++; throw new Error('x'); }, { attempts: 4, baseMs: 100, sleep: async (d) => delays.push(d) }));
    assert.equal(n, 4);
    assert.equal(delays.length, 3);
    assert.ok(delays[2] > delays[0], 'delays grow');
    n = 0;
    await assert.rejects(withRetry(() => { n++; throw new PermanentError('p'); }, { attempts: 4, isRetryable: (e) => !(e instanceof PermanentError), sleep: async () => {} }));
    assert.equal(n, 1);
  });
});
