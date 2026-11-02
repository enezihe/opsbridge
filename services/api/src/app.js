import express from 'express';
import mongoose from 'mongoose';
import { AppError, errorBody, traceMiddleware } from '@opsbridge/common';
import { authenticate, hashPassword, requireRole, signToken, verifyPassword } from './auth.js';
import { createChaos } from './chaos.js';
import { recordEvent } from './events.js';
import { AuditEvent, Incident, User } from './models.js';
import * as v from './validation.js';

// Allowed lifecycle moves. Anything else is a 409 so clients cannot skip investigation or silently reopen.
const TRANSITIONS = {
  open: ['investigating'],
  investigating: ['mitigated', 'resolved'],
  mitigated: ['investigating', 'resolved'],
  resolved: ['investigating'],
};

export function createApp({ config, logger, metrics }) {
  const app = express();
  const chaos = createChaos();
  const auth = authenticate(config);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(traceMiddleware({ logger, metrics }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', mongo: ready });
  });
  if (metrics) app.get('/metrics', metrics.handler);

  // ---- Authentication (local mode only; behind the gateway identity comes from Keycloak) ----
  if (config.authMode === 'local') {
    app.post('/auth/register', async (req, res) => {
      const { email, password } = v.parse(v.credentials, req.body);
      if (await User.exists({ email })) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      const user = await User.create({ email, passwordHash: await hashPassword(password, config.bcryptCost), roles: ['viewer'] });
      res.status(201).json(user);
    });

    app.post('/auth/login', async (req, res) => {
      const { email, password } = v.parse(v.credentials, req.body);
      const user = await User.findOne({ email }).select('+passwordHash');
      // Same answer for unknown user and wrong password: no account enumeration.
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        logger.warn('login_failed', { event: 'login_failed', email });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }
      res.json({ accessToken: signToken(user, config), tokenType: 'Bearer', expiresIn: config.jwtTtlSeconds });
    });
  }

  app.get('/me', auth, (req, res) => res.json(req.user));

  // ---- Incidents ----
  const incidents = express.Router();
  incidents.use((req, _res, next) => { req.routeBase = req.baseUrl; next(); });
  incidents.use(auth);
  if (config.enableChaos) incidents.use(chaos.middleware);

  incidents.get('/', requireRole('viewer'), async (req, res) => {
    const { status, severity, service, q, page, limit } = v.parse(v.listQuery, req.query);
    const filter = { ...(status && { status }), ...(severity && { severity }), ...(service && { service }) };
    if (q) filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [data, total] = await Promise.all([
      Incident.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Incident.countDocuments(filter),
    ]);
    res.json({ data, page, limit, total });
  });

  incidents.post('/', requireRole('engineer'), async (req, res) => {
    const body = v.parse(v.createIncident, req.body);
    const incident = await Incident.create({ ...body, createdBy: req.user.id, timeline: [{ by: req.user.id, text: 'Incident opened' }] });
    await recordEvent(config, 'incident.created', incident, req.user.id);
    res.status(201).location(`/incidents/${incident.id}`).json(incident);
  });

  incidents.get('/:id', requireRole('viewer'), async (req, res) => {
    const incident = await Incident.findById(v.objectId(req.params.id));
    if (!incident) throw new AppError(404, 'NOT_FOUND', 'Incident not found');
    res.json(incident);
  });

  incidents.patch('/:id', requireRole('engineer'), async (req, res) => {
    const changes = v.parse(v.updateIncident, req.body);
    const incident = await Incident.findById(v.objectId(req.params.id));
    if (!incident) throw new AppError(404, 'NOT_FOUND', 'Incident not found');

    let type = 'incident.updated';
    if (changes.status && changes.status !== incident.status) {
      if (!TRANSITIONS[incident.status].includes(changes.status)) {
        throw new AppError(409, 'INVALID_TRANSITION', `Cannot move from "${incident.status}" to "${changes.status}"`, { allowed: TRANSITIONS[incident.status] });
      }
      if (changes.status === 'resolved') {
        if (!(changes.rootCause ?? incident.rootCause)) throw new AppError(422, 'ROOT_CAUSE_REQUIRED', 'A root cause is required to resolve an incident');
        incident.resolvedAt = new Date();
        type = 'incident.resolved';
      } else {
        incident.resolvedAt = null;
      }
      incident.timeline.push({ by: req.user.id, text: `Status ${incident.status} -> ${changes.status}` });
    }
    Object.assign(incident, changes);
    await incident.save();
    await recordEvent(config, type, incident, req.user.id);
    res.json(incident);
  });

  incidents.post('/:id/notes', requireRole('engineer'), async (req, res) => {
    const { text } = v.parse(v.addNote, req.body);
    const incident = await Incident.findByIdAndUpdate(v.objectId(req.params.id), { $push: { timeline: { by: req.user.id, text } } }, { new: true });
    if (!incident) throw new AppError(404, 'NOT_FOUND', 'Incident not found');
    res.status(201).json(incident.timeline.at(-1));
  });

  incidents.delete('/:id', requireRole('admin'), async (req, res) => {
    const deleted = await Incident.findByIdAndDelete(v.objectId(req.params.id));
    if (!deleted) throw new AppError(404, 'NOT_FOUND', 'Incident not found');
    res.status(204).end();
  });

  app.use('/incidents', incidents);

  app.get('/stats', auth, requireRole('viewer'), async (_req, res) => {
    const [byStatus, bySeverity, [mttr]] = await Promise.all([
      Incident.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Incident.aggregate([{ $group: { _id: '$severity', count: { $sum: 1 } } }]),
      Incident.aggregate([
        { $match: { status: 'resolved', resolvedAt: { $ne: null } } },
        { $group: { _id: null, avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } }, resolved: { $sum: 1 } } },
      ]),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
    res.json({ byStatus: toMap(byStatus), bySeverity: toMap(bySeverity), mttrMinutes: mttr ? Math.round((mttr.avgMs / 60000) * 10) / 10 : null, resolved: mttr?.resolved ?? 0 });
  });

  // Audit trail is written by the worker from Kafka events, so this read proves the async path end to end.
  app.get('/audit', auth, requireRole('engineer'), async (req, res) => {
    const filter = req.query.incidentId ? { incidentId: String(req.query.incidentId) } : {};
    res.json({ data: await AuditEvent.find(filter).sort({ occurredAt: 1 }).limit(200).lean() });
  });

  if (config.enableChaos) {
    app.get('/admin/chaos', auth, requireRole('admin'), (_req, res) => res.json(chaos.state));
    app.put('/admin/chaos', auth, requireRole('admin'), (req, res) => {
      const errorRate = Number(req.body?.errorRate ?? 0);
      const latencyMs = Number(req.body?.latencyMs ?? 0);
      if (!(errorRate >= 0 && errorRate <= 1) || !(latencyMs >= 0 && latencyMs <= 10_000)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'errorRate must be 0..1 and latencyMs 0..10000');
      }
      chaos.set({ errorRate, latencyMs });
      logger.warn('chaos_updated', { event: 'chaos_updated', ...chaos.state, by: req.user.id });
      res.json(chaos.state);
    });
  }

  app.use((req, _res, next) => next(new AppError(404, 'ROUTE_NOT_FOUND', `${req.method} ${req.path} does not exist`)));

  // Centralised error handling: known errors keep their status, anything else is a logged 500 with no internals leaked.
  app.use((err, req, res, _next) => {
    const known = err instanceof AppError;
    const malformed = err.type === 'entity.parse.failed';
    const status = known ? err.status : malformed ? 400 : 500;
    const code = known ? err.code : malformed ? 'MALFORMED_JSON' : 'INTERNAL_ERROR';
    if (status >= 500) logger.error('unhandled_error', { event: 'unhandled_error', code, err });
    const message = status >= 500 && !known ? 'Internal server error' : malformed ? 'Request body is not valid JSON' : err.message;
    res.status(status).json(errorBody(code, message, req.trace?.traceId, known ? err.details : undefined));
  });

  return app;
}
