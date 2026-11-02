import { createLogger } from '@opsbridge/common';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const logger = createLogger('gateway');
const config = loadConfig();
const server = createApp({ config, logger }).listen(config.port, () =>
  logger.info('gateway_listening', { event: 'gateway_listening', port: config.port, authMode: config.authMode, upstream: config.upstream }),
);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
