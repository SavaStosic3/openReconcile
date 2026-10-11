import test from 'node:test';
import assert from 'node:assert/strict';
import { newStream } from '../public/model.js';
import { createCatalog, registerSource, setSchedule } from '../public/management-store.js';
import { executeModelRun, runMatchesModelInputs } from '../public/schedule-runner.js';
import { getSqlInventoryMappings, readSqlInput, sqlAdapters, sqlOutputRows } from '../backend/sql-connectors.js';
import { validateInputQuality } from '../public/input-quality.js';
import { aggregateReadings, MAX_WRITE_ROWS, readQuery, validateRead, validateWrite } from '../connectors/sql-gateway/src/contract.js';

const window = { start: '2026-10-10T12:00:00.000Z', end: '2026-10-10T13:00:00.000Z' };
const input = { id: 'sql-in', name: 'Plant input', type: 'sql', direction: 'input', connectionId: 'plant', table: 'readings', tagColumn: 'tag', valueColumn: 'value', timestampColumn: 'timestamp', aggregation: 'latest' };
const output = { id: 'sql-out', name: 'Plant output', type: 'sql', direction: 'output', connectionId: 'plant', table: 'results' };
const connection = { dialect: 'postgres', readableTables: ['readings'], writableTables: ['results'] };
function model() {
  const result = { version: 1, name: 'Buffer tank SQL verification', periodHours: 1, nodes: [
    { id: 'feed', kind: 'inlet', name: 'Feed', x: 100, y: 200 },
    { id: 'tank', kind: 'tank', name: 'Buffer tank', x: 400, y: 200, dataMapping: { sourceName: 'BUFFER' }, inventory: {
      basis: 'volume', unit: 'm³', density: 1000, densityUncertainty: 20, readingCorrelation: 0.5,
      geometry: { kind: 'constantArea', area: 1 }, capacityMass: null,
      opening: { measured: true, value: 0.05, uncertainty: 0.001, uncertaintyType: 'absolute', dataMapping: { sourceName: 'TANK.VOLUME' } },
      closing: { measured: true, value: 0.04, uncertainty: 0.001, uncertaintyType: 'absolute', dataMapping: { sourceName: 'TANK.VOLUME' } },
    } },
    { id: 'product', kind: 'outlet', name: 'Product', x: 700, y: 200 },
  ], streams: [newStream('feed', 'tank'), newStream('tank', 'product')] };
  Object.assign(result.streams[0], { id: 'feed-flow', measured: true, value: 60, uncertainty: 1, uncertaintyType: 'absolute', dataMapping: { sourceName: 'FEED' } });
  Object.assign(result.streams[1], { id: 'product-flow', measured: true, value: 80, uncertainty: 1, uncertaintyType: 'absolute', dataMapping: { sourceName: 'PRODUCT' } });
  return result;
}
function catalog(value = model(), source = input, withOutput = true) {
  let result = createCatalog(value, { id: 'model-sql', now: window.end });
  result = registerSource(result, 'model-sql', source);
  if (withOutput) result = registerSource(result, 'model-sql', output);
  return setSchedule(result, 'model-sql', { inputSourceId: source.id, outputSourceId: withOutput ? output.id : null }, window.end);
}
function gateway({ missingClosing = false, badQuality = false, wrongTimestamp = false } = {}) {
  const calls = [];
  const env = { SQL_GATEWAY_URL: 'https://gateway.example.test', SQL_GATEWAY_TOKEN: 'a'.repeat(40), SQL_GATEWAY_FETCH: async (url, options) => {
    const body = JSON.parse(options.body), endpoint = new URL(url).pathname.slice(1); calls.push({ endpoint, body });
    try {
      if (endpoint === 'write') return new Response(JSON.stringify({ written: validateWrite(body, connection).length }));
      const query = validateRead(body, connection), boundary = query.aggregation === 'inventoryBoundary';
      const rows = missingClosing && boundary && query.start === window.end ? [] : query.tags.map(tag => ({
        source_name: tag, value: boundary ? query.start === window.start ? 0.1 : 0.08 : tag === 'FEED' ? 60 : 80,
        timestamp: boundary ? query.start : '2026-10-10T12:30:00.000Z', quality_value: badQuality && boundary ? 'Bad' : 'Good',
      }));
      const result = aggregateReadings(rows, query);
      if (wrongTimestamp && boundary) result.readings[0].timestamp = '2026-10-10T12:59:59.000Z';
      return new Response(JSON.stringify(result));
    } catch (error) { return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), { status: error.status ?? 400 }); }
  } };
  return { env, calls };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7 * Math.max(1, Math.abs(expected)), `${actual} differs from ${expected}`);

test('inventory SQL reads exact reporting boundaries separately from flow aggregation and uses one tag at two distinct instants', async () => {
  const value = model(), prior = structuredClone(value), g = gateway();
  const result = await readSqlInput(g.env, input, value, window);
  assert.equal(g.calls.length, 3); assert.equal(g.calls[0].body.aggregation, 'latest');
  assert.deepEqual(g.calls.slice(1).map(call => [call.body.aggregation, call.body.start, call.body.end]), [['inventoryBoundary', window.start, window.start], ['inventoryBoundary', window.end, window.end]]);
  const endpoints = result.readings.filter(reading => reading.itemKind === 'inventory');
  assert.deepEqual(endpoints.map(reading => [reading.itemId, reading.endpoint, reading.unit, reading.value, reading.timestamp]), [['tank', 'opening', 'm³', 0.1, window.start], ['tank', 'closing', 'm³', 0.08, window.end]]);
  assert.deepEqual(result.window, window); assert.deepEqual(value, prior);
});

test('SQL inventories never inherit flow sum, weighted-average, or totalizer aggregation', async () => {
  for (const aggregation of ['sum', 'average', 'timeWeightedAverage', 'totalizerDelta']) {
    const value = model(); value.streams.forEach(stream => { stream.measured = false; });
    const g = gateway(); await readSqlInput(g.env, { ...input, aggregation }, value, window);
    assert.equal(g.calls.length, 2); assert.ok(g.calls.every(call => call.body.aggregation === 'inventoryBoundary'));
  }
});

test('default quality rules accept complete exact-boundary snapshots and preserve endpoint context for SQL previews', async () => {
  const value = model(); value.streams.forEach(stream => { stream.measured = false; });
  const source = { ...input, quality: validateInputQuality() }, g = gateway();
  const result = await readSqlInput(g.env, source, value, window);
  assert.equal(result.readings.length, 2); assert.deepEqual(result.window, window);
  assert.deepEqual(result.readings.map(reading => [reading.modelName, reading.endpoint, reading.timestamp]), [['Buffer tank · Opening inventory', 'opening', window.start], ['Buffer tank · Closing inventory', 'closing', window.end]]);
  assert.ok(result.readings.every(reading => reading.quality.coveragePercent === 100 && reading.quality.sampleCount === 1 && reading.quality.latestTimestamp === reading.timestamp));
  assert.ok(g.calls.every(call => JSON.stringify(call.body.quality) === JSON.stringify(source.quality)));
});

test('SQL requires every measured inventory endpoint mapping and rejects duplicated sensor inputs across units', async () => {
  const value = model(); delete value.nodes[1].inventory.closing.dataMapping;
  assert.throws(() => getSqlInventoryMappings(value), /Closing inventory.*Source Name/);
  const next = model(), second = structuredClone(next.nodes[1]); second.id = 'second-tank'; next.nodes.push(second);
  assert.throws(() => getSqlInventoryMappings(next), /distinct/);
  assert.throws(() => getSqlInventoryMappings(model(), [{ sourceName: 'TANK.VOLUME' }]), /distinct/);
  next.nodes[1].inventory.opening.measured = false; next.nodes[1].inventory.closing.measured = false;
  assert.equal(getSqlInventoryMappings(next).length, 2);
});

test('detached SQL run snapshots restore saved inventory values for applicability and export signed accumulation with joint uncertainty', async () => {
  const value = model(), sourceCatalog = catalog(value), before = structuredClone(sourceCatalog), g = gateway();
  const { run } = await executeModelRun(sourceCatalog, 'model-sql', { id: 'tank-run', now: () => Date.parse(window.end), ...sqlAdapters(g.env) });
  assert.ok(['ok', 'warning'].includes(run.status), run.error); assert.deepEqual(sourceCatalog, before);
  assert.equal(run.modelSnapshot.nodes[1].inventory.opening.value, 0.1); assert.equal(run.modelSnapshot.nodes[1].inventory.closing.value, 0.08);
  assert.deepEqual(run.sql.input.readings.filter(reading => reading.itemKind === 'inventory').map(reading => reading.originalValue), [0.05, 0.04]);
  assert.equal(runMatchesModelInputs(run, value), true);
  const changed = structuredClone(value); changed.nodes[1].inventory.closing.value = 0.045; assert.equal(runMatchesModelInputs(run, changed), false);
  const rows = g.calls.find(call => call.endpoint === 'write').body.rows;
  assert.equal(rows.length, 7);
  const accumulated = rows.find(row => row.metric === 'accumulation'); near(accumulated.value_kg, -20); near(accumulated.raw_kg, -20);
  near(run.result.inventories[0].accumulation.sigma, Math.sqrt(1.16));
  near(accumulated.uncertainty_kg, Math.sqrt(2 * 1.16 / (2 + 1.16)));
  assert.ok(rows.filter(row => ['opening_inventory', 'closing_inventory'].includes(row.metric)).every(row => row.value_kg >= 0 && row.uncertainty_kg > 0));
});

test('missing, stale-boundary, or bad-quality inventories fail before reconciliation output', async () => {
  for (const options of [{ missingClosing: true }, { wrongTimestamp: true }, { badQuality: true }]) {
    const g = gateway(options), source = { ...input, quality: validateInputQuality({ qualityColumn: 'flag', minCoveragePercent: 0 }) };
    const { run } = await executeModelRun(catalog(model(), source), 'model-sql', { id: `reject-${Object.keys(options)[0]}`, now: () => Date.parse(window.end), ...sqlAdapters(g.env) });
    assert.equal(run.status, 'failed'); assert.match(run.error, /Input failed/); assert.equal(run.result, null); assert.equal(g.calls.some(call => call.endpoint === 'write'), false);
  }
});

for (const dialect of ['postgres', 'mysql', 'sqlserver']) test(`${dialect} inventory snapshots use equality at a bound timestamp and retain tied rows for conflict checks`, () => {
  const body = { ...input, tags: ["tag' OR 1=1 --"], start: window.end, end: window.end, aggregation: 'inventoryBoundary' };
  const query = readQuery({ ...connection, dialect }, validateRead(body, connection));
  assert.equal(query.sql.includes(body.tags[0]), false); assert.match(query.sql, /timestamp[^\n]* = /); assert.equal(query.params.length, 2); assert.equal(query.params[0], body.tags[0]); assert.equal(query.params[1].toISOString(), window.end);
  assert.equal(/AVG|SUM|MAX\(/.test(query.sql), false);
});

test('gateway rejects inventory carry/interpolation, boundary conflicts, missing readings and bad quality', () => {
  const body = { ...input, tags: ['TANK'], start: window.start, end: window.start, aggregation: 'inventoryBoundary' };
  const query = validateRead(body, connection), sample = { source_name: 'TANK', value: 10, timestamp: window.start };
  assert.equal(aggregateReadings([sample, sample], query).readings[0].value, 10);
  for (const rows of [[], [{ ...sample, timestamp: '2026-10-10T11:59:59.000Z' }], [sample, { ...sample, value: 11 }]]) assert.throws(() => aggregateReadings(rows, query));
  assert.throws(() => validateRead({ ...body, end: window.end }, connection), /exact boundary/);
  const checked = validateRead({ ...body, quality: { qualityColumn: 'flag', badQualityPolicy: 'exclude' } }, connection);
  assert.throws(() => aggregateReadings([{ ...sample, quality_value: 'Bad' }], checked), error => error.code === 'MISSING_SOURCE_DATA');
  assert.throws(() => aggregateReadings([{ ...sample, quality_value: 'Good' }, { ...sample, quality_value: 'Bad' }], checked), error => error.code === 'AMBIGUOUS_SOURCE_DATA');
  assert.equal(aggregateReadings([{ ...sample, quality_value: 'Good' }], checked).readings[0].quality.coveragePercent, 100);
  assert.equal(aggregateReadings([{ ...sample, quality_value: 'Good' }, { ...sample, quality_value: 'Good' }], checked).readings[0].quality.sampleCount, 1);
});

test('gateway allows signed accumulation only and supports a complete maximum-sized model output', () => {
  assert.equal(MAX_WRITE_ROWS, 1500);
  const row = { run_id: 'run', model_id: 'model', model_name: 'Plant', published_version: null, item_id: 'tank', item_type: 'unit', source_name: 'TANK', metric: 'accumulation', value_kg: -20, raw_kg: -21, correction_kg: 1, uncertainty_kg: 1, status: 'reconciled', batch_start: window.start, batch_end: window.end, finished_at: window.end };
  assert.equal(validateWrite({ table: 'results', rows: [row] }, connection)[0].value_kg, -20);
  for (const metric of ['opening_inventory', 'closing_inventory', 'incoming_mass', 'outgoing_mass']) assert.throws(() => validateWrite({ table: 'results', rows: [{ ...row, metric }] }, connection), /nonnegative/);
  const rows = Array.from({ length: 1500 }, (_, index) => ({ ...row, item_id: `item-${index}` }));
  assert.equal(validateWrite({ table: 'results', rows }, connection).length, 1500);
  assert.throws(() => validateWrite({ table: 'results', rows: [...rows, { ...row, item_id: 'extra' }] }, connection), /1500/);
});

test('SQL output skips unobservable absolute inventories but preserves observable signed accumulation', () => {
  const value = model();
  const run = { id: 'run', modelId: 'model', modelName: value.name, finishedAt: window.end, modelSnapshot: value, result: {
    status: 'underdetermined', warnings: ['Absolute inventories are unobservable.'],
    streams: value.streams.map(stream => ({ id: stream.id, value: stream.value, raw: stream.value, correction: 0, uncertainty: 1, status: 'measured' })),
    inventories: [{ id: 'tank', opening: { value: null, raw: null, status: 'unobservable' }, closing: { value: null, raw: null, status: 'unobservable' }, accumulation: { value: -20, raw: null, uncertainty: 1, status: 'estimated' } }],
  } };
  const exported = sqlOutputRows(run, window);
  assert.equal(exported.skipped, 2); assert.ok(exported.rows.some(row => row.metric === 'accumulation' && row.value_kg === -20));
  assert.equal(exported.rows.some(row => row.metric === 'opening_inventory' || row.metric === 'closing_inventory'), false);
});
