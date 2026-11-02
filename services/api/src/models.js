import mongoose from 'mongoose';

const { Schema } = mongoose;

export const ROLES = ['viewer', 'engineer', 'admin'];
export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'];
export const STATUSES = ['open', 'investigating', 'mitigated', 'resolved'];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    roles: { type: [String], enum: ROLES, default: ['viewer'] },
  },
  { timestamps: true },
);
userSchema.set('toJSON', {
  transform: (_doc, ret) => ({ id: ret._id, email: ret.email, roles: ret.roles, createdAt: ret.createdAt }),
});

const noteSchema = new Schema({ at: { type: Date, default: Date.now }, by: String, text: String }, { _id: false });

const incidentSchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    severity: { type: String, enum: SEVERITIES, required: true },
    status: { type: String, enum: STATUSES, default: 'open' },
    service: { type: String, required: true, index: true },
    assignee: { type: String, default: null },
    rootCause: { type: String, default: null },
    timeline: { type: [noteSchema], default: [] },
    createdBy: { type: String, required: true },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
incidentSchema.index({ status: 1, severity: 1, createdAt: -1 });
incidentSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const { _id, __v, ...rest } = ret;
    return { id: _id, ...rest };
  },
});

// Transactional-outbox record: written next to the business change, relayed to Kafka asynchronously.
const outboxSchema = new Schema(
  {
    topic: String,
    key: String,
    payload: Schema.Types.Mixed,
    headers: { type: Map, of: String },
    status: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: String,
  },
  { timestamps: true },
);

// Written by the worker service, read by the API (GET /audit).
const auditSchema = new Schema(
  { eventId: { type: String, unique: true }, type: String, incidentId: { type: String, index: true }, actor: String, traceId: String, data: Schema.Types.Mixed, occurredAt: Date },
  { timestamps: true },
);

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);
export const Incident = mongoose.models.Incident ?? mongoose.model('Incident', incidentSchema);
export const Outbox = mongoose.models.Outbox ?? mongoose.model('Outbox', outboxSchema);
export const AuditEvent = mongoose.models.AuditEvent ?? mongoose.model('AuditEvent', auditSchema, 'audit_events');
