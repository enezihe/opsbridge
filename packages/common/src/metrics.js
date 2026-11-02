import client from 'prom-client';

/** Prometheus metrics (scraped by Azure Monitor managed Prometheus / Dynatrace ActiveGate). */
export function createMetrics(service) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const counter = (name, help, labelNames = []) => new client.Counter({ name, help, labelNames, registers: [registry] });

  return {
    registry,
    httpDuration,
    counter,
    gauge: (name, help, labelNames = []) => new client.Gauge({ name, help, labelNames, registers: [registry] }),
    handler: async (_req, res) => {
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    },
  };
}
