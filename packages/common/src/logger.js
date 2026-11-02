import { currentTrace } from './trace.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSON logger: one event per line on stdout.
 * Splunk (HEC or Universal Forwarder), Azure Monitor and Dynatrace Log Monitoring
 * all ingest this shape without custom parsing. Optionally ships batches straight
 * to a Splunk HTTP Event Collector when SPLUNK_HEC_URL / SPLUNK_HEC_TOKEN are set.
 */
export function createLogger(service, { level = process.env.LOG_LEVEL ?? 'info', sink } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const out = sink ?? ((line) => process.stdout.write(line + '\n'));
  const hec = process.env.SPLUNK_HEC_URL && process.env.SPLUNK_HEC_TOKEN ? hecShipper() : null;

  const emit = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < threshold) return;
    const { traceId, spanId } = currentTrace();
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      service,
      msg,
      ...(traceId && { traceId, spanId }),
      ...serializeErrors(fields),
    };
    const line = JSON.stringify(record);
    out(line);
    hec?.push(record);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    flush: () => hec?.flush(),
  };
}

function serializeErrors(fields) {
  const copy = { ...fields };
  if (copy.err instanceof Error) {
    copy.err = { name: copy.err.name, message: copy.err.message, code: copy.err.code, stack: copy.err.stack?.split('\n').slice(0, 6).join('\n') };
  }
  return copy;
}

function hecShipper() {
  const url = process.env.SPLUNK_HEC_URL;
  const token = process.env.SPLUNK_HEC_TOKEN;
  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const events = batch.splice(0, batch.length);
    const body = events.map((e) => JSON.stringify({ time: Date.parse(e.ts) / 1000, sourcetype: '_json', source: e.service, event: e })).join('\n');
    try {
      await fetch(url, { method: 'POST', headers: { Authorization: `Splunk ${token}` }, body });
    } catch {
      // Never let log shipping take the application down; stdout remains the source of truth.
    }
  };
  setInterval(flush, 2000).unref();
  return { push: (r) => { batch.push(r); if (batch.length >= 100) flush(); }, flush };
}
