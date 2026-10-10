import { ApiError } from './policy.js';
import { validateSqlSource, getSqlInputMappings } from '../public/sql-sources.js';
import { timeToEpoch } from '../public/management-store.js';

const MAX_BYTES = 1_000_000;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  try { timeToEpoch(value); return true; } catch { return false; }
};
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function sqlGatewayConfigured(env) { return Boolean(env.SQL_GATEWAY_URL && env.SQL_GATEWAY_TOKEN); }
function gatewayConfiguration(env) {
  if (!sqlGatewayConfigured(env)) throw new ApiError(503, 'SQL is not configured. Ask an administrator to connect the SQL gateway.');
  let url;
  try { url = new URL(env.SQL_GATEWAY_URL); } catch { throw new ApiError(503, 'The SQL gateway configuration is invalid.'); }
  const local = env.SQL_GATEWAY_ALLOW_LOCAL === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || typeof env.SQL_GATEWAY_TOKEN !== 'string' || env.SQL_GATEWAY_TOKEN.length < 32 || env.SQL_GATEWAY_TOKEN.length > 512 || /\s/.test(env.SQL_GATEWAY_TOKEN)) throw new ApiError(503, 'The SQL gateway configuration is invalid.');
  return { url, token: env.SQL_GATEWAY_TOKEN };
}

// The server chooses one configured URL. Neither models nor callers supply URLs,
// credentials, SQL strings, or error text that can expose database details.
export async function callSqlGateway(env, endpoint, body) {
  const { url, token } = gatewayConfiguration(env);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${endpoint}`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const fetcher = typeof env.SQL_GATEWAY_FETCH === 'function' ? env.SQL_GATEWAY_FETCH : fetch;
    const result = await fetcher(url.toString(), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: controller.signal });
    if (!result.ok) throw new Error('gateway status');
    if (Number(result.headers.get('Content-Length')) > MAX_BYTES || !result.body) throw new Error('gateway size');
    const reader = result.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('gateway size'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plain(data)) throw new Error('gateway shape');
    return data;
  } catch {
    throw new ApiError(502, 'The SQL gateway request failed. Check its configuration and service availability.');
  } finally { clearTimeout(timer); }
}

export async function sqlConnections(env) {
  if (!sqlGatewayConfigured(env)) return { configured: false, connections: [] };
  const data = await callSqlGateway(env, 'connections');
  if (!exact(data, ['connections']) || !Array.isArray(data.connections) || data.connections.length > 100) throw new ApiError(502, 'The SQL gateway returned invalid connection metadata.');
  const ids = new Set();
  const connections = data.connections.map(item => {
    if (!exact(item, ['id', 'name', 'dialect', 'canRead', 'canWrite']) || !safeId(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160 || /[\u0000-\u001f\u007f]/.test(item.name) || !['sqlserver', 'postgres', 'mysql'].includes(item.dialect) || typeof item.canRead !== 'boolean' || typeof item.canWrite !== 'boolean') throw new ApiError(502, 'The SQL gateway returned invalid connection metadata.');
    ids.add(item.id);
    return { id: item.id, name: item.name, dialect: item.dialect, canRead: item.canRead, canWrite: item.canWrite };
  });
  return { configured: true, connections };
}

export async function testSqlSource(env, source) {
  source = validateSqlSource(source);
  const { connectionId, direction, table, tagColumn, valueColumn, timestampColumn } = source;
  const data = await callSqlGateway(env, 'test', { connectionId, direction, table, ...(direction === 'input' ? { tagColumn, valueColumn, timestampColumn } : {}) });
  if (!exact(data, ['ok']) || data.ok !== true) throw new ApiError(502, 'The SQL gateway could not verify this source.');
  return { ok: true };
}

export function sqlBatchWindow(model, end) {
  const finish = Date.parse(end), start = finish - Number(model.periodHours) * 3_600_000;
  if (!timestamp(end) || !Number.isFinite(start) || Math.abs(start) > 8.64e15 || start >= finish || finish - start > 366 * 86_400_000) throw new Error('Choose a SQL input batch duration of at most 366 days.');
  return { start: new Date(start).toISOString(), end };
}

export async function readSqlInput(env, source, model, window) {
  source = validateSqlSource(source);
  if (source.direction !== 'input') throw new Error('Choose an input SQL source.');
  let mappings;
  try { mappings = getSqlInputMappings(model); } catch (error) { throw new ApiError(400, error.message); }
  const { connectionId, table, tagColumn, valueColumn, timestampColumn, aggregation } = source;
  if (!timestamp(window?.start) || !timestamp(window?.end) || Date.parse(window.start) >= Date.parse(window.end) || Date.parse(window.end) - Date.parse(window.start) > 366 * 86_400_000) throw new Error('Choose a nonempty SQL input window of at most 366 days.');
  const data = await callSqlGateway(env, 'read', { connectionId, table, tagColumn, valueColumn, timestampColumn, tags: mappings.map(mapping => mapping.sourceName), start: window.start, end: window.end, aggregation });
  if (!exact(data, ['readings', 'window']) || !Array.isArray(data.readings) || data.readings.length !== mappings.length || !exact(data.window, ['start', 'end']) || data.window.start !== window.start || data.window.end !== window.end) throw new ApiError(502, 'The SQL gateway returned incomplete readings or a different batch window.');
  const byName = new Map();
  for (const reading of data.readings) {
    if (!exact(reading, ['sourceName', 'value', 'timestamp']) || typeof reading.sourceName !== 'string' || byName.has(reading.sourceName) || !mappings.some(mapping => mapping.sourceName === reading.sourceName) || !finite(reading.value) || reading.value < 0 || !timestamp(reading.timestamp) || Date.parse(reading.timestamp) < Date.parse(window.start) || Date.parse(reading.timestamp) >= Date.parse(window.end)) throw new ApiError(502, 'The SQL gateway returned missing, duplicate, invalid, or out-of-window readings.');
    byName.set(reading.sourceName, reading);
  }
  return { readings: mappings.map(mapping => ({ ...mapping, value: byName.get(mapping.sourceName).value, timestamp: byName.get(mapping.sourceName).timestamp })), window: { ...window } };
}

export function sqlOutputRows(run, window) {
  if (!run?.modelSnapshot || !Array.isArray(run.result?.streams)) throw new Error('SQL output requires reconciliation results.');
  if (!timestamp(window?.start) || !timestamp(window?.end) || Date.parse(window.start) >= Date.parse(window.end)) throw new Error('Choose a valid batch duration for SQL output.');
  const results = new Map(run.result.streams.map(item => [item.id, item]));
  const rows = []; let skipped = 0;
  const base = (item, kind, metric, result) => ({ run_id: run.id, model_id: run.modelId, model_name: run.modelName, published_version: run.publishedVersion ?? null, item_id: item.id, item_type: kind, source_name: item.dataMapping.sourceName, metric,
    value_kg: result.value, raw_kg: finite(result.raw) ? result.raw : null, correction_kg: finite(result.correction) ? result.correction : null, uncertainty_kg: finite(result.uncertainty) ? result.uncertainty : null, status: result.status,
    batch_start: window.start, batch_end: window.end, finished_at: run.finishedAt });
  for (const item of run.modelSnapshot.streams) {
    if (!item.dataMapping) continue;
    const result = results.get(item.id);
    if (!result || result.status === 'unobservable' || !finite(result.value) || result.value < 0) { skipped++; continue; }
    rows.push(base(item, 'stream', 'mass', result));
  }
  for (const item of run.modelSnapshot.nodes) {
    if (!item.dataMapping) continue;
    for (const [metric, field] of [['incoming_mass', 'target'], ['outgoing_mass', 'source']]) {
      const incident = run.modelSnapshot.streams.filter(stream => stream[field] === item.id).map(stream => results.get(stream.id));
      if (incident.some(result => !result || result.status === 'unobservable' || !finite(result.value) || result.value < 0)) { skipped++; continue; }
      const total = incident.reduce((sum, result) => sum + result.value, 0);
      const raw = incident.every(result => finite(result.raw)) ? incident.reduce((sum, result) => sum + result.raw, 0) : null;
      if (!finite(total) || (raw !== null && !finite(raw))) { skipped++; continue; }
      rows.push(base(item, 'unit', metric, { value: total, raw, correction: raw === null ? null : total - raw, uncertainty: null, status: 'reconciled' }));
    }
  }
  if (!rows.length) throw new Error('Map at least one observable stream or process unit to use SQL output.');
  return { rows, skipped };
}

export function sqlAdapters(env) {
  return {
    inputAdapters: { sql: async (source, model, context) => {
      context.recordInputAudit({ source: validateSqlSource(source), window: { ...context.window }, readings: [] });
      const data = await readSqlInput(env, source, model, context.window);
      const readings = data.readings.map(reading => ({ ...reading, originalValue: model.streams.find(stream => stream.id === reading.itemId).value }));
      const next = structuredClone(model);
      for (const reading of readings) next.streams.find(stream => stream.id === reading.itemId).value = reading.value;
      context.recordInputAudit({ source: validateSqlSource(source), ...data, readings });
      return next;
    } },
    outputAdapters: { sql: async (source, run, context) => {
      source = validateSqlSource(source);
      if (source.direction !== 'output') throw new Error('Choose an output SQL source.');
      context.recordOutputAudit({ source, window: { ...context.window }, written: 0, skipped: 0 });
      const { rows, skipped } = sqlOutputRows(run, context.window);
      const audit = { source, window: { ...context.window }, written: 0, skipped };
      context.recordOutputAudit(audit);
      const data = await callSqlGateway(env, 'write', { connectionId: source.connectionId, table: source.table, rows });
      if (!exact(data, ['written']) || data.written !== rows.length) throw new ApiError(502, 'The SQL gateway did not confirm the complete output batch.');
      context.recordOutputAudit({ ...audit, written: data.written });
    } }
  };
}
