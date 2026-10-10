import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { aggregateReadings, GatewayError, insertQuery, readQuery, testQuery, validateRead, validateWrite } from './contract.js';
import { connectionManifest } from './config.js';
import { createDriver } from './drivers.js';

const BODY_LIMIT = 2 * 1024 * 1024;
const DEADLINE_MS = 20_000;
const MAX_CONCURRENCY = 8;
function authenticated(header, token) {
  if (typeof header !== 'string' || header.length > 520 || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7)), expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function send(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function readBody(request, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new GatewayError('INVALID_REQUEST', 'Send an application/json request.', 415);
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > BODY_LIMIT) throw new GatewayError('BODY_TOO_LARGE', 'The request exceeds the 2 MiB body limit.', 413);
  let size = 0;
  const parts = [];
  const cancel = () => request.destroy();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for await (const part of request) {
      size += part.length;
      if (size > BODY_LIMIT) throw new GatewayError('BODY_TOO_LARGE', 'The request exceeds the 2 MiB body limit.', 413);
      parts.push(part);
    }
  } finally { signal.removeEventListener('abort', cancel); }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new GatewayError('INVALID_REQUEST', 'Send a JSON object.'); }
}
export function createGateway(config, { driverFactory = createDriver, deadlineMs = DEADLINE_MS, maxConcurrency = MAX_CONCURRENCY } = {}) {
  const connections = new Map(config.connections.map(connection => [connection.id, connection]));
  const drivers = new Map();
  let active = 0;
  async function driver(connection) {
    if (!drivers.has(connection.id)) {
      const pending = Promise.resolve().then(() => driverFactory(connection));
      drivers.set(connection.id, pending);
      pending.catch(() => { if (drivers.get(connection.id) === pending) drivers.delete(connection.id); });
    }
    return drivers.get(connection.id);
  }
  async function dispatch(path, body, signal) {
    const connection = connections.get(body.connectionId);
    if (!connection) throw new GatewayError('CONNECTION_NOT_FOUND', 'The selected SQL connection is not configured.', 404);
    if (path === '/test') {
      const query = testQuery(connection, body);
      await (await driver(connection)).query(query, signal);
      return { ok: true };
    }
    if (path === '/read') {
      const input = validateRead(body, connection);
      const rows = await (await driver(connection)).query(readQuery(connection, input), signal);
      return aggregateReadings(rows, input);
    }
    const rows = validateWrite(body, connection);
    await (await driver(connection)).transaction(rows.map(row => insertQuery(connection, body.table, row)), signal);
    return { written: rows.length };
  }
  const server = http.createServer(async (request, response) => {
    if (!authenticated(request.headers.authorization, config.token)) { send(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid gateway bearer token is required.' } }); request.resume(); return; }
    const path = (request.url || '').split('?')[0];
    if (request.method === 'GET' && path === '/connections') { send(response, 200, { connections: config.connections.map(connectionManifest) }); return; }
    if (request.method !== 'POST' || !['/test', '/read', '/write'].includes(path)) { send(response, 404, { error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }); request.resume(); return; }
    if (active >= maxConcurrency) { send(response, 503, { error: { code: 'BUSY', message: 'The gateway is busy. Try again later.' } }); request.resume(); return; }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnected);
    let work;
    try {
      const body = await readBody(request, controller.signal);
      work = dispatch(path, body, controller.signal);
      const timed = new Promise((_, reject) => {
        if (controller.signal.aborted) reject(new GatewayError('TIMEOUT', 'The SQL gateway request timed out.', 504));
        else controller.signal.addEventListener('abort', () => reject(new GatewayError('TIMEOUT', 'The SQL gateway request timed out.', 504)), { once: true });
      });
      const result = await Promise.race([work, timed]);
      send(response, 200, result);
    } catch (error) {
      const safe = error instanceof GatewayError ? error : new GatewayError('DATABASE_ERROR', 'The SQL operation failed. Check connectivity, permissions, and the configured schema.', 502);
      send(response, safe.status, { error: { code: safe.code, message: safe.message } });
    } finally {
      clearTimeout(timer); response.off('close', disconnected);
      // Keep a timed-out operation inside the concurrency bound until its
      // driver has finished cancellation/rollback.
      if (work) work.then(() => { active--; }, () => { active--; });
      else active--;
    }
  });
  server.requestTimeout = 25_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  return { server, close: async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...drivers.values()].map(async pending => (await pending).close()));
  } };
}
