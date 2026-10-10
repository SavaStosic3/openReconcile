import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSqlSource, getSqlInputMappings, SQL_OUTPUT_COLUMNS } from '../public/sql-sources.js';
import { callSqlGateway, sqlConnections, testSqlSource, readSqlInput, sqlBatchWindow, sqlOutputRows, sqlAdapters } from '../backend/sql-connectors.js';
import { exampleModel } from '../public/model.js';
import { createCatalog, registerSource, setSchedule } from '../public/management-store.js';
import { executeModelRun, runMatchesModelInputs, runMatchesInputSource } from '../public/schedule-runner.js';
import { reconcile } from '../public/solver.js';
import { validateRead, validateWrite, OUTPUT_COLUMNS } from '../connectors/sql-gateway/src/contract.js';
import { validateInputQuality } from '../public/input-quality.js';

test('known input-quality failures are actionable while remote database details remain private', async () => {
  const env = { SQL_GATEWAY_URL: 'https://gateway.example', SQL_GATEWAY_TOKEN: 'a'.repeat(40), SQL_GATEWAY_FETCH: async () => new Response(JSON.stringify({ error: { code: 'STALE_SOURCE_DATA', message: 'Feed: password=secret host=plant-private' } }), { status: 400 }) };
  await assert.rejects(callSqlGateway(env, 'read', { tags: ['Feed'] }), error => error.status === 422 && error.message.startsWith('Feed: ') && /stale/.test(error.message) && !error.message.includes('secret') && !error.message.includes('plant-private'));
  env.SQL_GATEWAY_FETCH = async () => new Response(JSON.stringify({ error: { code: 'DATABASE_ERROR', message: 'password=secret' } }), { status: 400 });
  await assert.rejects(callSqlGateway(env, 'read', { tags: ['Feed'] }), error => error.status === 502 && !error.message.includes('secret'));
});

test('weighted input validates rate units and quality audits and totalizers validate cumulative units', async () => {
  const model = mappedModel(), window = sqlBatchWindow(model, end);
  const source = { ...input, aggregation: 'timeWeightedAverage', quality: validateInputQuality() };
  const g = gateway((_endpoint, body) => ({ ...readings(body), readings: body.tags.map(sourceName => ({ sourceName, value: 10, timestamp: body.end, quality: { coveragePercent: 100, sampleCount: 2, rejectedCount: 0, latestTimestamp: body.end, resetCount: 0, warnings: [] } })) }));
  await assert.rejects(readSqlInput(g.env, source, model, window), /rate unit/); assert.equal(g.requests.length, 0);
  for (const stream of model.streams.filter(item => item.measured)) Object.assign(stream, { metric: 'massFlow', unit: 'kg/h' });
  const result = await readSqlInput(g.env, source, model, window); assert.equal(result.readings[0].quality.coveragePercent, 100); assert.deepEqual(g.requests[0].body.quality, source.quality);
  await assert.rejects(readSqlInput(g.env, { ...source, aggregation: 'totalizerDelta' }, model, window), /cumulative/);
  g.env.SQL_GATEWAY_FETCH = async (_url, options) => { const body = JSON.parse(options.body); return new Response(JSON.stringify({ ...readings(body), readings: body.tags.map(sourceName => ({ sourceName, value: 10, timestamp: body.end, quality: { coveragePercent: 50, sampleCount: 2, rejectedCount: 0, latestTimestamp: body.end, resetCount: 0, warnings: [] } })) })); };
  await assert.rejects(readSqlInput(g.env, source, model, window), /invalid/);
});

test('quality warnings are retained in run results and nested policies compare by value', async () => {
  let value = createCatalog(mappedModel(), { id: 'model-a', now: end });
  const source = { ...input, quality: validateInputQuality({ minCoveragePercent: 50, badQualityPolicy: 'exclude' }) };
  value = registerSource(value, 'model-a', source); value = setSchedule(value, 'model-a', { inputSourceId: source.id }, end);
  const g = gateway((_endpoint, body) => ({ ...readings(body), readings: readings(body).readings.map(reading => ({ ...reading, quality: { coveragePercent: 50, sampleCount: 2, rejectedCount: 1, latestTimestamp: reading.timestamp, resetCount: 0, warnings: ['Excluded a reading with a bad quality flag.'] } })) }));
  const { run } = await executeModelRun(value, 'model-a', { id: 'quality-run', now: () => Date.parse(end), ...sqlAdapters(g.env) });
  assert.equal(run.status, 'warning'); assert.ok(run.result.warnings.some(warning => warning.startsWith('f1: Excluded')));
  assert.equal(runMatchesInputSource(run, structuredClone(value.sources['model-a']), value.schedules['model-a']), true);
  const changed = structuredClone(value.sources['model-a']); changed[0].quality.minCoveragePercent = 60;
  assert.equal(runMatchesInputSource(run, changed, value.schedules['model-a']), false);
});

const end = '2026-10-10T20:00:00.000Z';
const input = { id: 'sql-input', name: 'Historian SQL', type: 'sql', direction: 'input', connectionId: 'plant', table: 'dbo.Readings', tagColumn: 'tag_name', valueColumn: 'reading', timestampColumn: 'observed_at', aggregation: 'latest' };
const output = { id: 'sql-output', name: 'Reconciled SQL', type: 'sql', direction: 'output', connectionId: 'plant-output', table: 'dbo.Reconciled' };
function mappedModel() { const model = exampleModel(); for (const stream of model.streams) stream.dataMapping = { sourceName: stream.id }; model.nodes[2].dataMapping = { sourceName: 'Separator' }; return model; }
function gateway(handler) { const requests = []; const env = { SQL_GATEWAY_URL: 'https://gateway.example/base', SQL_GATEWAY_TOKEN: 'a'.repeat(40), SQL_GATEWAY_FETCH: async (url, options) => { const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ url, options, body }); return new Response(JSON.stringify(await handler(new URL(url).pathname.split('/').at(-1), body)), { headers: { 'Content-Type': 'application/json' } }); } }; return { env, requests }; }
function readings(body, values = { f1: 110, f3: 65, f4: 40 }) { return { readings: body.tags.map(sourceName => ({ sourceName, value: values[sourceName], timestamp: '2026-10-10T19:30:00.000Z' })), window: { start: body.start, end: body.end } }; }
function catalog(model = mappedModel()) { let catalog = createCatalog(model, { id: 'model-a', now: end }); catalog = registerSource(catalog, 'model-a', input); catalog = registerSource(catalog, 'model-a', output); return setSchedule(catalog, 'model-a', { inputSourceId: input.id, outputSourceId: output.id }, end); }

test('SQL configuration permits bounded identifiers and rejects secrets, queries, unsafe IDs, and unknown fields', () => {
  assert.deepEqual(validateSqlSource(input), input); assert.notEqual(validateSqlSource(input), input);
  for (const source of [{ ...input, password: 'secret' }, { ...input, query: 'SELECT *' }, { ...input, table: 'db.dbo.Readings' }, { ...input, table: 'readings;DROP' }, { ...input, tagColumn: 'schema.tag' }, { ...input, id: '__proto__' }, { ...input, connectionId: 'https://bad' }, { ...input, aggregation: 'execute' }, { ...input, valueColumn: input.tagColumn }, { ...output, aggregation: 'sum' }]) assert.throws(() => validateSqlSource(source));
});

test('SQL network configuration enforces HTTPS, explicit local opt-in, secret strength, no redirects, and sanitized errors', async () => {
  for (const patch of [{ SQL_GATEWAY_URL: 'http://evil.example' }, { SQL_GATEWAY_URL: 'http://127.0.0.1:4567' }, { SQL_GATEWAY_URL: 'https://user:secret@example.com' }, { SQL_GATEWAY_URL: 'https://example.com?token=secret' }, { SQL_GATEWAY_TOKEN: 'short' }]) await assert.rejects(callSqlGateway({ SQL_GATEWAY_URL: 'https://example.com', SQL_GATEWAY_TOKEN: 'a'.repeat(40), ...patch }, 'connections'), /configuration/);
  const g = gateway(() => ({ connections: [] })); await sqlConnections(g.env);
  assert.equal(g.requests[0].options.redirect, 'manual'); assert.ok(g.requests[0].options.signal instanceof AbortSignal); assert.equal(g.requests[0].options.headers.Authorization, `Bearer ${'a'.repeat(40)}`);
  g.env.SQL_GATEWAY_URL = 'http://localhost:4567'; g.env.SQL_GATEWAY_ALLOW_LOCAL = 'true'; assert.deepEqual(await sqlConnections(g.env), { configured: true, connections: [] });
  g.env.SQL_GATEWAY_FETCH = async () => { throw new Error('password=very-secret host=database.local SELECT everything'); };
  await assert.rejects(sqlConnections(g.env), error => !error.message.includes('very-secret') && !error.message.includes('database.local') && error.status === 502);
  g.env.SQL_GATEWAY_FETCH = async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/secret' } });
  await assert.rejects(sqlConnections(g.env), error => error.status === 502 && !error.message.includes('other.example'));
  assert.deepEqual(await sqlConnections({}), { configured: false, connections: [] });
});

test('SQL gateway responses are bounded and public metadata contains only approved fields', async () => {
  const g = gateway(() => ({ connections: [{ id: 'plant', name: 'Plant', dialect: 'postgres', canRead: true, canWrite: false }] }));
  assert.equal((await sqlConnections(g.env)).connections[0].id, 'plant');
  g.env.SQL_GATEWAY_FETCH = async () => new Response('x'.repeat(1_000_001)); await assert.rejects(sqlConnections(g.env), /request failed/);
  g.env.SQL_GATEWAY_FETCH = async () => new Response(JSON.stringify({ connections: [{ id: 'plant', name: 'Plant', dialect: 'postgres', canRead: true, canWrite: false, password: 'secret' }] })); await assert.rejects(sqlConnections(g.env), /invalid connection metadata/);
  g.env.SQL_GATEWAY_FETCH = async () => new Response('secret gateway SQL error', { status: 500 }); await assert.rejects(sqlConnections(g.env), /request failed/);
});

test('SQL tests are read-only and expose no SQL or credentials', async () => {
  const g = gateway(() => ({ ok: true })); assert.deepEqual(await testSqlSource(g.env, output), { ok: true });
  assert.deepEqual(g.requests[0].body, { connectionId: output.connectionId, direction: 'output', table: output.table });
  assert.ok(!JSON.stringify(g.requests[0].body).includes(g.env.SQL_GATEWAY_TOKEN));
});

test('SQL input maps only physical meters, requires every physical mapping, and rejects duplicated tags', () => {
  const model = mappedModel(); model.streams[1].measured = true; model.streams[1].meterType = 'virtual'; model.streams[1].formula = '[F-01]';
  assert.deepEqual(getSqlInputMappings(model).map(item => item.itemId), ['f1', 'f3', 'f4']);
  delete model.streams[0].dataMapping; assert.throws(() => getSqlInputMappings(model), /set a Source Name/);
  model.streams[0].dataMapping = { sourceName: 'f3' }; assert.throws(() => getSqlInputMappings(model), /distinct/);
});

test('SQL input returns complete finite fresh half-open batch readings and never mutates saved values', async () => {
  const model = mappedModel(), before = structuredClone(model), window = sqlBatchWindow(model, end);
  assert.deepEqual(window, { start: '2026-10-10T19:00:00.000Z', end });
  const g = gateway((_endpoint, body) => readings(body));
  const result = await readSqlInput(g.env, input, model, window);
  assert.equal(result.readings[0].value, 110); assert.deepEqual(model, before);
  assert.deepEqual(g.requests[0].body.tags, ['f1', 'f3', 'f4']);
  for (const value of [null, '110', -1, Infinity]) { g.env.SQL_GATEWAY_FETCH = async (_url, options) => { const data = readings(JSON.parse(options.body)); data.readings[0].value = value; return new Response(JSON.stringify(data)); }; await assert.rejects(readSqlInput(g.env, input, model, window), /invalid/); }
  for (const bad of ['2026-10-10T18:59:59.999Z', end]) { g.env.SQL_GATEWAY_FETCH = async (_url, options) => { const data = readings(JSON.parse(options.body)); data.readings[0].timestamp = bad; return new Response(JSON.stringify(data)); }; await assert.rejects(readSqlInput(g.env, input, model, window), /out-of-window/); }
  g.env.SQL_GATEWAY_FETCH = async (_url, options) => { const data = readings(JSON.parse(options.body)); data.readings.pop(); return new Response(JSON.stringify(data)); }; await assert.rejects(readSqlInput(g.env, input, model, window), /incomplete/);
});

test('SQL run snapshots use fresh physical readings, calculate virtual meters, and output audited normalized rows', async () => {
  const model = mappedModel(); Object.assign(model.streams[1], { measured: true, meterType: 'virtual', formula: '[F-01]', value: 99999, uncertaintyType: 'absolute', uncertainty: 1 });
  const sourceCatalog = catalog(model), before = structuredClone(sourceCatalog);
  const g = gateway((endpoint, body) => endpoint === 'read' ? readings(body) : { written: body.rows.length });
  let rechecked = false;
  const { run } = await executeModelRun(sourceCatalog, 'model-a', { id: 'run-a', now: () => Date.parse(end), target: 'published', publishedVersion: 3, ...sqlAdapters(g.env), beforeOutput: async () => { rechecked = true; } });
  assert.ok(['ok', 'warning'].includes(run.status), run.error); assert.equal(run.modelSnapshot.streams[0].value, 110); assert.equal(run.modelSnapshot.streams[1].value, 110); assert.equal(run.sql.input.readings[0].originalValue, 100); assert.ok(rechecked);
  assert.deepEqual(sourceCatalog, before); assert.ok(runMatchesModelInputs(run, model));
  const changed = structuredClone(model); changed.streams[0].value = 101; assert.equal(runMatchesModelInputs(run, changed), false);
  const payload = g.requests[1].body; assert.equal(payload.rows.length, 6); assert.deepEqual(Object.keys(payload.rows[0]), SQL_OUTPUT_COLUMNS); assert.equal(payload.rows[0].published_version, 3); assert.equal(payload.rows[0].batch_end, end); assert.equal(payload.rows[0].raw_kg, 110); assert.equal(payload.rows[0].status, 'measured');
  assert.equal(run.sql.output.written, 6); assert.equal(run.sql.output.source.id, output.id);
});

test('SQL output failure retains computed result and audited input, and access revocation prevents external writes', async () => {
  const sourceCatalog = catalog();
  const g = gateway((endpoint, body) => endpoint === 'read' ? readings(body) : { written: 0 });
  let { run } = await executeModelRun(sourceCatalog, 'model-a', { id: 'run-fail', now: () => Date.parse(end), ...sqlAdapters(g.env) });
  assert.equal(run.status, 'failed'); assert.match(run.error, /Output failed/); assert.ok(run.result); assert.equal(run.sql.output.written, 0);
  g.requests.length = 0;
  ({ run } = await executeModelRun(sourceCatalog, 'model-a', { id: 'run-revoked', now: () => Date.parse(end), ...sqlAdapters(g.env), beforeOutput: async () => { throw new Error('Access revoked'); } }));
  assert.equal(run.status, 'failed'); assert.match(run.error, /Access revoked/); assert.equal(g.requests.length, 1); assert.ok(run.result);
});

test('SQL output skips unobservable estimates and totals only completely observed incident flows', () => {
  const model = mappedModel(), run = { id: 'run-a', modelId: 'model-a', modelName: model.name, modelSnapshot: model, result: reconcile(model), finishedAt: end };
  const { rows } = sqlOutputRows(run, sqlBatchWindow(model, end)); assert.equal(rows.length, 6); assert.equal(rows.find(row => row.item_id === 'split' && row.metric === 'incoming_mass').uncertainty_kg, null);
  run.result.streams.find(stream => stream.id === 'f3').value = null; run.result.streams.find(stream => stream.id === 'f3').status = 'unobservable';
  const partial = sqlOutputRows(run, sqlBatchWindow(model, end)); assert.equal(partial.skipped, 2); assert.equal(partial.rows.length, 4); assert.ok(!partial.rows.some(row => row.item_id === 'f3' || (row.item_id === 'split' && row.metric === 'outgoing_mass')));
});

test('run source matching invalidates changed or newly selected SQL inputs without changing old delivery audit', () => {
  const run = { inputSourceId: input.id, sql: { input: { source: structuredClone(input) }, output: { source: structuredClone(output), written: 4 } } };
  assert.ok(runMatchesInputSource(run, [input, output], { inputSourceId: input.id }));
  assert.equal(runMatchesInputSource(run, [{ ...input, aggregation: 'sum' }, output], { inputSourceId: input.id }), false);
  assert.equal(runMatchesInputSource(run, [input, output], { inputSourceId: null }), false);
  assert.equal(runMatchesInputSource({ inputSourceId: null }, [input], { inputSourceId: input.id }), false);
  assert.equal(runMatchesInputSource({ inputSourceId: input.id }, [input], { inputSourceId: input.id }), false);
  assert.ok(runMatchesInputSource(run, [input, { ...output, table: 'new_results' }], { inputSourceId: input.id, outputSourceId: output.id }));
  assert.equal(run.sql.output.source.table, output.table);
  assert.ok(runMatchesInputSource({}, [], { inputSourceId: null }));
});

test('backend SQL requests conform to the real gateway contract', async () => {
  assert.deepEqual(SQL_OUTPUT_COLUMNS, OUTPUT_COLUMNS);
  const connection = { dialect: 'postgres', readableTables: [input.table], writableTables: [output.table] };
  const g = gateway((endpoint, body) => {
    if (endpoint === 'read') { validateRead(body, connection); return readings(body); }
    assert.equal(validateWrite(body, connection).length, body.rows.length);
    return { written: body.rows.length };
  });
  const { run } = await executeModelRun(catalog(), 'model-a', { id: 'contract-run', now: () => Date.parse(end), target: 'draft', publishedVersion: null, ...sqlAdapters(g.env) });
  assert.ok(['ok', 'warning'].includes(run.status), run.error);
});
