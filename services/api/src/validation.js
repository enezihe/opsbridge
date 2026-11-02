import { z } from 'zod';
import mongoose from 'mongoose';
import { AppError } from '@opsbridge/common';
import { SEVERITIES, STATUSES } from './models.js';

export const credentials = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12, 'must be at least 12 characters').max(128),
});

export const createIncident = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().max(5000).optional(),
  severity: z.enum(SEVERITIES),
  service: z.string().trim().min(2).max(60),
  assignee: z.string().trim().max(120).nullable().optional(),
});

export const updateIncident = z
  .object({
    title: z.string().trim().min(3).max(140),
    description: z.string().max(5000),
    severity: z.enum(SEVERITIES),
    status: z.enum(STATUSES),
    assignee: z.string().trim().max(120).nullable(),
    rootCause: z.string().trim().min(10).max(5000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');

export const addNote = z.object({ text: z.string().trim().min(1).max(2000) });

export const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  service: z.string().max(60).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Parse or throw a 400 with field-level details. */
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
}

export function objectId(value) {
  if (!mongoose.isValidObjectId(value)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid id', [{ field: 'id', message: 'must be a valid ObjectId' }]);
  return value;
}
