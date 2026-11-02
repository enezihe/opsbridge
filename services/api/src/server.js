import mongoose from 'mongoose';
import { createLogger, createMetrics, kafkaClientOptions } from '@opsbridge/common';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { KafkaPublisher, LogPublisher, OutboxRelay } from './events.js';

const logger = createLogger('api');
const config = loadConfig();
const metrics = createMetrics('api');

await mongoose.connect(config.mongoUrl, { serverSelectionTimeoutMS: 10_000 });
logger.info('mongo_connected', { event: 'mongo_connected' });

const publisher = config.kafkaBrokers ? new KafkaPublisher(kafkaClientOptions()) : new LogPublisher(logger);
const relay = new OutboxRelay({ publisher, logger, metrics });
relay.start();

const server = createApp({ config, logger, metrics }).listen(config.port, () =>
  logger.info('api_listening', { event: 'api_listening', port: config.port, authMode: config.authMode, kafka: Boolean(config.kafkaBrokers) }),
);

const shutdown = async (signal) => {
  logger.info('shutdown', { event: 'shutdown', signal });
  server.close();
  await relay.stop();
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
