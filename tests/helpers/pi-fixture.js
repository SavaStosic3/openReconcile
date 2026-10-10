import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../deploy/sqlite.js';
import { handleApi } from '../../backend/api.js';
import { Repository } from '../../backend/repository.js';
import { exampleModel } from '../../public/model.js';

export const window = { start: '2026-10-10T09:00:00.000Z', end: '2026-10-10T10:00:00.000Z' };
export const piInput = { id: 'pi-input', name: 'PI archive readings', type: 'pi', direction: 'input', connectionId: 'plant-pi', aggregation: 'latest' };
export const piOutput = { id: 'pi-output', name: 'PI reconciled totals', type: 'pi', direction: 'output', connectionId: 'plant-pi' };
export const sqlInput = { id: 'sql-input', name: 'Existing SQL readings', type: 'sql', direction: 'input', connectionId: 'plant-sql', table: 'readings', tagColumn: 'tag', valueColumn: 'value', timestampColumn: 'observed_at', aggregation: 'latest' };
export function mappedModel({ virtual = false } = {}) {
  const model = exampleModel();
  for (const stream of model.streams) stream.dataMapping = { sourceName: stream.id };
  model.nodes.find(node => node.id === 'split').dataMapping = { sourceName: 'Separator' };
  if (virtual) {
    model.streams[0].meterName = 'Feed meter';
    Object.assign(model.streams[1], { measured: true, meterType: 'virtual', meterName: 'Calculated feed', formula: '[Feed meter]', value: 999999, uncertainty: 1, uncertaintyType: 'absolute' });
  }
  return model;
}
export function profile({ unit = 'kg' } = {}) {
  return { id: 'plant-pi', name: 'Plant historian', baseUrl: 'https://pi.example.test/piwebapi',
    auth: { type: 'basic', username: 'fixture-user', password: 'fixture-only-password' },
    inputs: ['f1', 'f3', 'f4'].map(sourceName => ({ sourceName, path: `\\\\PIDA\\${sourceName}`, unit })),
    outputs: [...['f1', 'f2', 'f3', 'f4'].map(sourceName => ({ sourceName, metric: 'mass', path: `\\\\PIDA\\OUT_${sourceName}`, unit: 'kg' })),
      ...['incoming_mass', 'outgoing_mass'].map(metric => ({ sourceName: 'Separator', metric, path: `\\\\PIDA\\OUT_${metric}`, unit: 'kg' }))] };
}
export function piMock({ connection = profile(), values = { f1: 100, f3: 60, f4: 35 }, samples, onRequest, onWrite, status = 202 } = {}) {
  const requests = [];
  const env = { PI_CONNECTIONS: [connection], PI_WEB_API_FETCH: async (url, options) => {
    const parsed = new URL(url), route = parsed.pathname.slice('/piwebapi/'.length), body = options.body ? JSON.parse(options.body) : null;
    const request = { url: parsed, options, route, body }; requests.push(request);
    const override = await onRequest?.(request);
    if (override instanceof Response) return override;
    if (route === 'points' || route === 'attributes') {
      const path = parsed.searchParams.get('path');
      const input = connection.inputs.find(item => item.path === path), output = connection.outputs.find(item => item.path === path);
      assert.ok(input || output, 'a request must resolve a server-allowlisted PI path');
      const item = input ?? output, WebId = input ? `IN_${item.sourceName}` : `OUT_${item.sourceName}_${item.metric}`;
      const metadata = route === 'points' ? { WebId, Name: item.sourceName, Path: path, PointType: 'Float64', EngineeringUnits: item.unit }
        : { WebId, Name: item.sourceName, Path: path, Type: 'Double', DefaultUnitsOfMeasure: item.unit, DefaultUnitsOfMeasureAbbreviation: item.unit, Links: { Point: `${connection.baseUrl}/points/PHYSICAL_${item.sourceName}` } };
      return Response.json(metadata);
    }
    const match = /^streams\/([^/]+)\/(recorded|recordedattime|value)$/.exec(route);
    assert.ok(match, `unexpected PI endpoint ${route}`);
    if (match[2] === 'value') {
      await onWrite?.(request);
      return new Response(null, { status });
    }
    const sourceName = decodeURIComponent(match[1]).replace(/^IN_/, ''), start = parsed.searchParams.get('startTime') ?? window.start;
    const event = (Timestamp, Value, extra = {}) => ({ Timestamp, Value, Good: true, Questionable: false, Substituted: false, ...extra });
    if (match[2] === 'recordedattime') return Response.json(event(parsed.searchParams.get('time'), values[sourceName]));
    return Response.json({ Items: samples ? await samples(sourceName, request, event) : [event(start, values[sourceName])] });
  } };
  return { env, requests, connection };
}
export async function fixture(t, { standalone = false, mock = piMock() } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openreconcile-pi-'));
  const DB = openDatabase({ dataDir });
  let time = Date.parse('2026-10-10T10:07:00.000Z'), serial = 0;
  const env = { DB, ADMIN_EMAIL: 'pi-admin@example.test', STANDALONE_SCHEDULER: standalone, SCHEDULER_ENABLED: true,
    NOW: () => time, UUID: () => `pi-test-${String(++serial).padStart(6, '0')}`, ...mock.env };
  const admin = { id: 'pi-admin', email: 'pi-admin@example.test', name: 'PI administrator' }, viewer = { id: 'pi-viewer', email: 'pi-viewer@example.test', name: 'Operator' };
  const repo = new Repository(DB, { now: env.NOW, uuid: env.UUID, standaloneScheduler: standalone });
  t.after(async () => { DB.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, method = 'GET', body, identity = admin) {
    const response = await handleApi(new Request(`https://plant.test${path}`, { method,
      headers: { Origin: 'https://plant.test', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, identity);
    return { status: response.status, body: await response.json() };
  }
  async function create(model = mappedModel(), sources = [piInput, piOutput]) {
    const response = await request('/api/models', 'POST', { model }); assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = response.body.entry.id;
    if (sources.length) { const saved = await request(`/api/models/${id}/sources`, 'PUT', { sources, connectorType: 'pi', revision: 1 }); assert.equal(saved.status, 200, JSON.stringify(saved.body)); }
    return id;
  }
  async function publish(id) { const model = await repo.model(id); const result = await request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: model.revision }); assert.equal(result.status, 200, JSON.stringify(result.body)); }
  async function select(id, changes = {}) { const model = await repo.model(id); const result = await request(`/api/models/${id}/schedule`, 'PATCH', { revision: model.revision, changes: { inputSourceId: piInput.id, outputSourceId: piOutput.id, ...changes } }); assert.equal(result.status, 200, JSON.stringify(result.body)); }
  async function due(id) { const model = await repo.model(id); await DB.prepare('UPDATE models SET schedule_json=? WHERE id=?').bind(JSON.stringify({ ...model.schedule, nextRunAt: new Date(time - 1000).toISOString() }), id).run(); }
  return { DB, env, admin, viewer, repo, request, create, publish, select, due, mock, advance(ms) { time += ms; } };
}
