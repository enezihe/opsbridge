import { contextFromTraceparent, formatTraceparent, runWithTrace } from './trace.js';

/** Starts/continues a trace for each request, echoes ids back, logs one access line per request. */
export function traceMiddleware({ logger, metrics }) {
  return (req, res, next) => {
    const ctx = contextFromTraceparent(req.headers.traceparent);
    req.trace = ctx;
    res.setHeader('x-trace-id', ctx.traceId);
    res.setHeader('traceparent', formatTraceparent(ctx.traceId, ctx.spanId));
    const started = process.hrtime.bigint();

    runWithTrace(ctx, () => {
      res.on('finish', () => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const route = routeLabel(req);
        metrics?.httpDuration.observe({ method: req.method, route, status: res.statusCode }, seconds);
        if (req.path === '/healthz' || req.path === '/metrics') return;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logger[level]('http_request', {
          event: 'http_request',
          method: req.method,
          path: req.originalUrl.split('?')[0],
          route,
          status: res.statusCode,
          durationMs: Math.round(seconds * 1000),
          userId: req.user?.id,
        });
      });
      next();
    });
  };
}

/** Uniform JSON error body: { error: { code, message, details?, traceId } } */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errorBody = (code, message, traceId, details) => ({ error: { code, message, ...(details && { details }), traceId } });

// express resets req.baseUrl once a router finishes, so routers record it in req.routeBase and the
// gateway sets req.routeLabel from its policy table. Keeps metric/log labels low-cardinality and identical
// for success and failure of the same endpoint.
function routeLabel(req) {
  if (req.routeLabel) return req.routeLabel;
  const base = req.routeBase ?? req.baseUrl ?? '';
  const label = `${base}${req.route?.path ?? ''}`.replace(/(.)\/$/, '$1');
  return label || 'unmatched';
}
