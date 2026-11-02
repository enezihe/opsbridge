import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

// W3C Trace Context (https://www.w3.org/TR/trace-context/). Dynatrace, Azure
// Application Insights and OpenTelemetry all understand `traceparent`, so every
// hop (gateway -> api -> kafka -> worker) keeps one trace id that can be searched
// in Splunk or followed in a Dynatrace PurePath.
const als = new AsyncLocalStorage();
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');

export function parseTraceparent(header) {
  const m = typeof header === 'string' ? TRACEPARENT.exec(header.trim()) : null;
  if (!m || /^0+$/.test(m[1])) return null;
  return { traceId: m[1], parentSpanId: m[2], flags: m[3] };
}

export const formatTraceparent = (traceId, spanId, flags = '01') => `00-${traceId}-${spanId}-${flags}`;

export function runWithTrace(ctx, fn) {
  return als.run(ctx, fn);
}

export const currentTrace = () => als.getStore() ?? {};

/** Context for a new unit of work, continuing the incoming trace when there is one. */
export function contextFromTraceparent(header) {
  const parsed = parseTraceparent(header);
  return { traceId: parsed?.traceId ?? newTraceId(), spanId: newSpanId(), parentSpanId: parsed?.parentSpanId };
}

/** Headers to send downstream so the next hop joins the same trace. */
export function outgoingTraceHeaders() {
  const { traceId, spanId } = currentTrace();
  if (!traceId) return {};
  return { traceparent: formatTraceparent(traceId, spanId ?? newSpanId()) };
}
