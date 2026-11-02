import http from 'node:http';
import { Kafka, logLevel } from 'kafkajs';
import mongoose from 'mongoose';
import { createLogger, createMetrics, kafkaClientOptions } from '@opsbridge/common';
import { createHandler, webhookNotifier } from './handler.js';

const env = process.env;
const logger = createLogger('worker');
const metrics = createMetrics('worker');
const topic = env.EVENTS_TOPIC ?? 'incident.events';
const kafkaOptions = kafkaClientOptions({ KAFKA_BROKERS: 'localhost:9092', ...env });

await mongoose.connect(env.MONGO_URL ?? 'mongodb://localhost:27017/opsbridge', { serverSelectionTimeoutMS: 10_000 });

const kafka = new Kafka({ ...kafkaOptions, clientId: 'opsbridge-worker', logLevel: logLevel.NOTHING, retry: { retries: 8 } });
const consumer = kafka.consumer({ groupId: 'opsbridge-worker' });
const dlqProducer = kafka.producer();
await Promise.all([consumer.connect(), dlqProducer.connect()]);
if (env.KAFKA_CREATE_TOPICS !== 'false') {
  // Event Hubs has no admin API: there the topics ("event hubs") are created by Terraform.
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic }, { topic: `${topic}.dlq` }], waitForLeaders: true });
  await admin.disconnect();
}
await consumer.subscribe({ topic, fromBeginning: true });

const handle = createHandler({
  logger,
  metrics,
  dlqTopic: `${topic}.dlq`,
  sendToDlq: (msg) => dlqProducer.send(msg),
  notify: env.NOTIFY_WEBHOOK_URL ? webhookNotifier(env.NOTIFY_WEBHOOK_URL) : null,
});

await consumer.run({
  eachMessage: async ({ topic: t, partition, message }) =>
    handle({ value: message.value, headers: message.headers, topic: t, partition, offset: message.offset }),
});
logger.info('worker_started', { event: 'worker_started', topic, brokers: kafkaOptions.brokers });

const ops = http
  .createServer(async (req, res) => {
    if (req.url === '/metrics') return metrics.handler(req, res);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  })
  .listen(Number(env.PORT ?? 9100));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    ops.close();
    await consumer.disconnect();
    await dlqProducer.disconnect();
    await mongoose.disconnect();
    process.exit(0);
  });
}
