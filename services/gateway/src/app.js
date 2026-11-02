import http from 'node:http';
import { AppError, createMetrics, errorBody, formatTraceparent, traceMiddleware } from '@opsbridge/common';
import { findRule, hasRole } from './policy.js';
import { createRateLimiter } from './ratelimit.js';
import { createVerifier } from './verifier.js';
import express from 'express';

const STRIP_INBOUND = ['x-internal-key', 'x-user-id', 'x-user-email', 'x-user-roles', 'host', 'connection', 'content-length'];

export function createApp({ config, logger, metrics = createMetrics('gateway'), verifier = createVerifier(config) }) {
  const app = express();
  const denied = metrics.counter('gateway_denied_total', 'Requests rejected at the entry point', ['reason']);
  const limiter = createRateLimiter({ limit: config.rateLimitPerMinute });
  const authLimiter = createRateLimiter({ limit: config.authRateLimitPerMinute });
  const upstream = new URL(config.upstream);

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(traceMiddleware({ logger, metrics }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      const r = await fetch(new URL('/healthz', upstream), { signal: AbortSignal.timeout(2000) });
      res.status(r.ok ? 200 : 503).json({ status: r.ok ? 'ready' : 'not_ready', upstream: r.status });
    } catch {
      res.status(503).json({ status: 'not_ready', upstream: 'unreachable' });
    }
  });
  app.get('/metrics', metrics.handler);

  const reject = (req, res, status, code, message, reason) => {
    denied.inc({ reason });
    logger.warn('request_denied', { event: 'request_denied', reason, method: req.method, path: req.path, ip: req.ip, userId: req.user?.id });
    res.status(status).json(errorBody(code, message, req.trace.traceId));
  };

  app.use(async (req, res) => {
    const path = req.path;
    const match = findRule(req.method, path);
    req.routeLabel = match?.label;
    if (!match) return reject(req, res, 404, 'ROUTE_NOT_FOUND', `${req.method} ${path} does not exist`, 'no_matching_rule');

    const isAuthRoute = path.startsWith('/auth/');
    const quota = (isAuthRoute ? authLimiter : limiter).take(`${isAuthRoute ? 'auth' : 'api'}:${req.ip}`);
    res.setHeader('x-ratelimit-remaining', quota.remaining);
    if (!quota.allowed) {
      res.setHeader('retry-after', quota.retryAfterSeconds);
      return reject(req, res, 429, 'RATE_LIMITED', 'Too many requests', 'rate_limited');
    }

    if (match.access !== 'public') {
      const [scheme, token] = (req.headers.authorization ?? '').split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !token) return reject(req, res, 401, 'UNAUTHENTICATED', 'Missing bearer token', 'no_token');
      try {
        req.user = await verifier(token);
      } catch (err) {
        return reject(req, res, 401, 'UNAUTHENTICATED', err.code === 'ERR_JWT_EXPIRED' ? 'Token expired' : 'Invalid token', err.code === 'ERR_JWT_EXPIRED' ? 'token_expired' : 'invalid_token');
      }
      if (!hasRole(req.user.roles, match.access)) return reject(req, res, 403, 'FORBIDDEN', `Requires role "${match.access}"`, 'insufficient_role');
    }

    forward(req, res, { config, upstream, logger });
  });

  return app;
}

function forward(req, res, { config, upstream, logger }) {
  const headers = { ...req.headers };
  for (const h of STRIP_INBOUND) delete headers[h]; // never trust identity headers supplied by a client
  if (!config.forwardAuthorization) delete headers.authorization;
  headers.traceparent = formatTraceparent(req.trace.traceId, req.trace.spanId);
  headers['x-forwarded-for'] = req.ip;
  if (req.user) {
    headers['x-internal-key'] = config.internalKey;
    headers['x-user-id'] = req.user.id;
    headers['x-user-email'] = req.user.email ?? '';
    headers['x-user-roles'] = req.user.roles.join(',');
  }

  let received = 0;
  const proxyReq = http.request(
    { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.originalUrl, headers, timeout: config.upstreamTimeoutMs },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  const fail = (status, code, message) => {
    if (res.headersSent) return res.destroy();
    logger.error('upstream_failure', { event: 'upstream_failure', code, path: req.path });
    res.status(status).json(errorBody(code, message, req.trace.traceId));
  };
  proxyReq.on('timeout', () => { proxyReq.destroy(); fail(504, 'UPSTREAM_TIMEOUT', 'Upstream service timed out'); });
  proxyReq.on('error', () => fail(502, 'UPSTREAM_UNAVAILABLE', 'Upstream service is unavailable'));
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > config.maxBodyBytes) {
      proxyReq.destroy();
      fail(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
      req.destroy();
    }
  });
  req.pipe(proxyReq);
}

export { AppError };
