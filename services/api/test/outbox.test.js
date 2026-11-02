import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createLogger } from '@opsbridge/common';
import { OutboxRelay, recordEvent } from '../src/events.js';
import { Outbox } from '../src/models.js';

describe('outbox relay', () => {
  let mongo;
  before(async () => {
    mongo = process.env.MONGO_URL ? null : await MongoMemoryServer.create();
    await mongoose.connect(process.env.MONGO_URL ?? mongo.getUri('outbox_test'));
    await Outbox.deleteMany({});
  });
  after(async () => { await mongoose.disconnect(); await mongo?.stop(); });

  const incident = { id: 'abc', title: 't', severity: 'sev1', status: 'open', service: 's' };
  const logger = createLogger('t', { sink: () => {} });

  it('retries with backoff when the broker is down and delivers once it recovers', async () => {
    const sent = [];
    let down = true;
    const publisher = { send: async (m) => { if (down) throw new Error('broker unavailable'); sent.push(m); }, disconnect: async () => {} };
    const relay = new OutboxRelay({ publisher, logger });

    const event = await recordEvent({ eventsTopic: 'incident.events' }, 'incident.created', incident, 'u1');
    assert.equal(await relay.tick(), 0);
    let rec = await Outbox.findOne({ 'payload.eventId': event.eventId });
    assert.equal(rec.status, 'pending');
    assert.equal(rec.attempts, 1);
    assert.match(rec.lastError, /broker unavailable/);
    assert.ok(rec.nextAttemptAt > new Date(), 'backoff pushes the next attempt into the future');

    down = false;
    assert.equal(await relay.tick(), 0, 'not due yet, so it is not retried early');
    await Outbox.updateOne({ _id: rec._id }, { nextAttemptAt: new Date() });
    assert.equal(await relay.tick(), 1);
    rec = await Outbox.findById(rec._id);
    assert.equal(rec.status, 'sent');
    assert.equal(sent[0].value.eventId, event.eventId);
    assert.equal(sent[0].key, 'abc');
  });

  it('parks a poison record as failed after maxAttempts', async () => {
    const publisher = { send: async () => { throw new Error('nope'); }, disconnect: async () => {} };
    const relay = new OutboxRelay({ publisher, logger, maxAttempts: 1 });
    const event = await recordEvent({ eventsTopic: 'incident.events' }, 'incident.updated', incident, 'u1');
    await relay.tick();
    assert.equal((await Outbox.findOne({ 'payload.eventId': event.eventId })).status, 'failed');
  });
});
