import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePiSource } from '../public/pi-sources.js';
import { validatePiConnections, piConnections, testPiSource, readPiInput, piAdapters } from '../backend/pi-connectors.js';
import { createCatalog, registerSource, setSchedule } from '../public/management-store.js';
import { executeModelRun, runMatchesInputSource, connectorInputAudit, connectorOutputAudit } from '../public/schedule-runner.js';
import { reconcile } from '../public/solver.js';
import { defaultInventory } from '../public/inventory.js';
import { newStream } from '../public/model.js';
import { window, piInput, piOutput, profile, mappedModel, piMock } from './helpers/pi-fixture.js';

const closeTo = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);
function catalog(model = mappedModel(), input = piInput) {
  let value = createCatalog(model, { id: 'pi-model', now: window.end });
  value = registerSource(value, 'pi-model', validatePiSource(input)); value = registerSource(value, 'pi-model', piOutput);
  return setSchedule(value, 'pi-model', { inputSourceId: input.id, outputSourceId: piOutput.id }, window.end);
}

test('PI model sources contain only server connection IDs and bounded acquisition settings', () => {
  const normalized = validatePiSource(piInput);
  assert.equal(normalized.type, 'pi'); assert.equal(normalized.quality.qualityColumn, 'piQuality');
  assert.deepEqual(normalized.quality.goodQualityValues, ['Good']);
  assert.deepEqual(validatePiSource(piOutput), piOutput);
  for (const change of [{ baseUrl: 'https://rogue.test' }, { password: 'secret' }, { username: 'intruder' }, { token: 'secret' }, { path: '\\\\PIDA\\ANY' }, { webId: 'unregistered' }, { connectionId: '__proto__' }, { aggregation: 'interpolated' }, { direction: 'both' }, { quality: { qualityColumn: 'custom' } }, { quality: null }, { quality: [] }, { quality: true }, { quality: { goodQualityValues: ['Good', 'Bad'] } }]) assert.throws(() => validatePiSource({ ...piInput, ...change }));
  assert.throws(() => validatePiSource({ ...piOutput, aggregation: 'sum' }));
});

test('server PI profiles require HTTPS and explicit path and output-metric allowlists', () => {
  const valid = profile(); assert.doesNotThrow(() => validatePiConnections([valid]));
  for (const changes of [{ baseUrl: 'http://pi.test/piwebapi' }, { baseUrl: 'https://user:password@pi.test/piwebapi' }, { baseUrl: 'https://pi.test/piwebapi?token=secret' }, { baseUrl: 'https://pi.test/piwebapi#secret' }, { auth: { type: 'basic', username: '', password: '' } }, { auth: { type: 'none' } }, { auth: { type: 'bearer', token: '' } }, { inputs: [{ sourceName: 'Feed', path: 'https://rogue.test', unit: 'kg' }] }, { inputs: [...valid.inputs, valid.inputs[0]] }, { outputs: [...valid.outputs, valid.outputs[0]] }, { outputs: [{ ...valid.outputs[0], metric: 'execute' }] }, { unexpected: 'secret' }]) assert.throws(() => validatePiConnections([{ ...valid, ...changes }]));
  assert.throws(() => validatePiConnections([valid, valid]));
  assert.throws(() => validatePiConnections([{ ...valid, inputs: [...valid.inputs, { sourceName: 'other', path: valid.inputs[0].path.toLowerCase(), unit: 'kg' }] }]));
  assert.throws(() => validatePiConnections([{ ...valid, outputs: [{ ...valid.outputs[0], path: valid.inputs[0].path.toLowerCase() }] }]));
});

test('public PI metadata exposes approved aliases and units without endpoints or credentials', async () => {
  const mock = piMock(), data = await piConnections(mock.env);
  assert.equal(data.configured, true); assert.equal(data.connections.length, 1);
  assert.equal(data.connections[0].canRead, true); assert.equal(data.connections[0].canWrite, true);
  assert.deepEqual(data.connections[0].inputs[0], { sourceName: 'f1', unit: 'kg' });
  assert.deepEqual(data.connections[0].outputs[0], { sourceName: 'f1', metric: 'mass', unit: 'kg' });
  const serialized = JSON.stringify(data);
  for (const secret of ['fixture-user', 'fixture-only-password', 'pi.example.test', 'PIDA', 'baseUrl', 'auth']) assert.ok(!serialized.includes(secret));
  assert.deepEqual(await piConnections({}), { configured: false, connections: [] });
  assert.equal(mock.requests.length, 0, 'reading connection metadata must not issue PI writes or disclose the server path');
});

test('PI input uses bounded authenticated metadata and recorded requests and preserves half-open reporting periods', async () => {
  const mock = piMock({ samples: (name, request, event) => [event(window.start, { f1: 100, f3: 60, f4: 35 }[name]), event(window.end, 999999)] });
  const model = mappedModel(), before = structuredClone(model);
  const result = await readPiInput(mock.env, piInput, model, window);
  assert.deepEqual(result.window, window); assert.deepEqual(result.readings.map(item => item.value), [100, 60, 35]);
  assert.deepEqual(model, before);
  for (const request of mock.requests) {
    assert.equal(request.options.redirect, 'manual'); assert.ok(request.options.signal instanceof AbortSignal);
    assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from('fixture-user:fixture-only-password').toString('base64')}`);
    assert.equal(request.url.origin, 'https://pi.example.test');
    if (request.route.endsWith('/recorded')) {
      assert.equal(request.url.searchParams.get('startTime'), window.start);
      assert.equal(request.url.searchParams.get('endTime'), window.end);
      assert.equal(request.url.searchParams.get('boundaryType').toLowerCase(), 'inside');
      assert.equal(request.url.searchParams.get('maxCount'), '10000');
    }
  }
  mock.connection.auth = { type: 'bearer', token: 'fixture-bearer-token' };
  mock.requests.length = 0; await readPiInput(mock.env, piInput, model, window);
  assert.equal(mock.requests[0].options.headers.Authorization, 'Bearer fixture-bearer-token');
});

test('PI input never follows remote links, redirects, truncated pages or remote error messages', async () => {
  for (const reply of [new Response(null, { status: 302, headers: { Location: 'https://other.test/secret' } }), new Response('plant-password-private', { status: 500 }), Response.json({ Errors: ['password=secret PI host=plant-private'] }), new Response('x'.repeat(1_000_001)), Response.json({ Items: [], Links: { Next: 'https://rogue.test/paging' } })]) {
    const mock = piMock({ onRequest: request => request.route.endsWith('/recorded') ? reply : undefined });
    await assert.rejects(readPiInput(mock.env, piInput, mappedModel(), window), error => !/plant-password|plant-private|rogue\.test|password=secret/.test(error.message));
    assert.ok(mock.requests.every(request => request.url.origin === 'https://pi.example.test'));
  }
  const mock = piMock({ samples: (_name, _request, event) => Array.from({ length: 10000 }, () => event(window.start, 100)) });
  await assert.rejects(readPiInput(mock.env, piInput, mappedModel(), window), /complete|limit|page|truncat/i);
  for (const response of [new Response(null, { status: 200, headers: { 'Content-Length': '4000001' } }), new Response('x'.repeat(4_000_001))]) {
    const oversized = piMock({ onRequest: request => request.route.endsWith('/recorded') ? response : undefined });
    await assert.rejects(readPiInput(oversized.env, piInput, mappedModel(), window), /size|permitted/i);
  }
});

test('PI quality flags are explicit and cannot silently treat bad, questionable, substituted, or digital states as numeric Good samples', async () => {
  for (const change of [{ Good: false }, { Questionable: true }, { Substituted: true }, { Good: 'true' }, { Good: undefined }, { Questionable: undefined }, { Substituted: undefined }, { Value: { Name: 'No Data', Value: 248, IsSystem: true } }, { Value: '100' }, { Value: null }, { Value: -1 }]) {
    const mock = piMock({ samples: (_name, _request, event) => [event(window.start, 100, change)] });
    await assert.rejects(readPiInput(mock.env, piInput, mappedModel(), window));
  }
  const mock = piMock({ samples: (_name, _request, event) => [event(window.start, 100), event('2026-10-10T09:20:00.000Z', 100, { Good: false }), event('2026-10-10T09:40:00.000Z', 100)] });
  const result = await readPiInput(mock.env, { ...piInput, quality: { badQualityPolicy: 'exclude', minCoveragePercent: 60 } }, mappedModel(), window);
  closeTo(result.readings[0].quality.coveragePercent, 200 / 3);
  assert.equal(result.readings[0].quality.rejectedCount, 1); assert.match(result.readings[0].quality.warnings[0], /not bridged/);
  await assert.rejects(readPiInput(mock.env, { ...piInput, quality: { badQualityPolicy: 'exclude', minCoveragePercent: 100 } }, mappedModel(), window), /coverage/i);
});

test('PI units, numeric metadata and server aliases are validated before any readings are accepted', async () => {
  for (const changes of [{ EngineeringUnits: 't' }, { PointType: 'Digital' }, { PointType: 'String' }, { WebId: '../escape' }]) {
    const mock = piMock({ onRequest: request => request.route === 'points' ? Response.json({ WebId: 'IN_f1', Name: 'f1', PointType: 'Float64', EngineeringUnits: 'kg', ...changes }) : undefined });
    await assert.rejects(readPiInput(mock.env, piInput, mappedModel(), window));
    assert.equal(mock.requests.filter(request => request.route.endsWith('/recorded')).length, 0);
  }
  const mock = piMock(), model = mappedModel(); model.streams[0].dataMapping.sourceName = '\\\\PIDA\\UNAUTHORIZED';
  await assert.rejects(readPiInput(mock.env, piInput, model, window), /allow|configur|mapping|Source Name/i);
  assert.equal(mock.requests.length, 0);
});

test('PI time-weighted flow integration uses elapsed duration rather than the count of archive events', async () => {
  const connection = profile({ unit: 'kg/h' }), model = mappedModel();
  for (const stream of model.streams.filter(item => item.measured)) Object.assign(stream, { metric: 'massFlow', unit: 'kg/h' });
  const mock = piMock({ connection, samples: (name, _request, event) => {
    const first = { f1: 100, f3: 60, f4: 40 }[name];
    return [event(window.start, first), event('2026-10-10T09:10:00.000Z', first * 2), event(window.end, first * 2)];
  } });
  const source = { ...piInput, aggregation: 'timeWeightedAverage' }, before = structuredClone(model);
  const data = await readPiInput(mock.env, source, model, window);
  closeTo(data.readings[0].value, 550 / 3); closeTo(data.readings[1].value, 110); closeTo(data.readings[2].value, 220 / 3);
  assert.equal(data.readings[0].quality.coveragePercent, 100); assert.deepEqual(model, before);
  const { run } = await executeModelRun(catalog(model, source), 'pi-model', { id: 'weighted-pi', now: () => Date.parse(window.end), ...piAdapters(mock.env) });
  assert.ok(['ok', 'warning'].includes(run.status), run.error);
  closeTo(run.result.streams.find(item => item.id === 'f1').value, 550 / 3);
  run.result.balances.forEach(balance => closeTo(balance.reconciled, 0));
});

test('PI totalizers require complete boundaries and an explicit reset or rollover policy', async () => {
  const source = { ...piInput, aggregation: 'totalizerDelta' };
  const mock = piMock({ samples: (_name, _request, event) => [event(window.start, 950), event('2026-10-10T09:30:00.000Z', 25), event(window.end, 50)] });
  await assert.rejects(readPiInput(mock.env, source, mappedModel(), window), /totalizer decreased|reset|rollover/i);
  const result = await readPiInput(mock.env, { ...source, quality: { totalizerReset: 'rollover', rolloverValue: 1000 } }, mappedModel(), window);
  result.readings.forEach(item => { closeTo(item.value, 100); assert.equal(item.quality.resetCount, 1); });
  const incomplete = piMock({ samples: (_name, _request, event) => [event(window.start, 100), event('2026-10-10T09:30:00.000Z', 150)] });
  await assert.rejects(readPiInput(incomplete.env, source, mappedModel(), window), /exactly.*end|boundar|complete/i);
});

test('PI tank inventories request exact opening and closing archive events without interpolating boundaries', async () => {
  const inventory = defaultInventory();
  inventory.opening.dataMapping = { sourceName: 'stock' }; inventory.closing.dataMapping = { sourceName: 'stock' };
  const model = { version: 1, name: 'Boundary tank', periodHours: 1,
    nodes: [{ id: 'feed', kind: 'inlet', name: 'Feed', x: 0, y: 0 }, { id: 'tank', kind: 'tank', name: 'Tank', x: 100, y: 0, inventory }, { id: 'product', kind: 'outlet', name: 'Product', x: 200, y: 0 }],
    streams: [newStream('feed', 'tank', 1), newStream('tank', 'product', 2)] };
  model.streams.forEach((stream, index) => Object.assign(stream, { id: index ? 'f3' : 'f1', measured: true, value: 99999, uncertainty: 1, uncertaintyType: 'absolute', dataMapping: { sourceName: index ? 'f3' : 'f1' } }));
  const connection = profile(); connection.inputs = [...connection.inputs, { sourceName: 'stock', path: '\\\\PIDA\\TANK_STOCK', unit: 'kg' }];
  const mock = piMock({ connection, values: { f1: 50, f3: 30 }, onRequest: request => request.route.includes('IN_stock/recordedattime')
    ? Response.json({ Timestamp: request.url.searchParams.get('time'), Value: request.url.searchParams.get('time') === window.start ? 100 : 120, Good: true, Questionable: false, Substituted: false }) : undefined });
  const data = await readPiInput(mock.env, piInput, model, window);
  assert.deepEqual(data.readings.filter(item => item.itemKind === 'inventory').map(item => [item.endpoint, item.value, item.timestamp]), [['opening', 100, window.start], ['closing', 120, window.end]]);
  for (const request of mock.requests.filter(item => item.route.endsWith('/recordedattime'))) assert.equal(request.url.searchParams.get('retrievalMode').toLowerCase(), 'exact');
  model.nodes.find(item => item.id === 'tank').dataMapping = { sourceName: 'stock' };
  connection.outputs.push(...['incoming_mass', 'outgoing_mass', 'opening_inventory', 'closing_inventory', 'accumulation'].map(metric => ({ sourceName: 'stock', metric, path: `\\\\PIDA\\OUT_STOCK_${metric}`, unit: 'kg' })));
  const execution = await executeModelRun(catalog(model), 'pi-model', { id: 'tank-pi', now: () => Date.parse(window.end), ...piAdapters(mock.env) });
  assert.ok(['ok', 'warning'].includes(execution.run.status), execution.run.error);
  closeTo(execution.run.result.objective, 0); closeTo(execution.run.result.inventories[0].opening.value, 100);
  closeTo(execution.run.result.inventories[0].closing.value, 120); closeTo(execution.run.result.inventories[0].accumulation.value, 20);
  execution.run.result.balances.forEach(balance => closeTo(balance.reconciled, 0));
  const audit = connectorOutputAudit(execution.run);
  assert.equal(audit.events.find(event => event.metric === 'opening_inventory').timestamp, window.start);
  assert.equal(audit.events.find(event => event.metric === 'closing_inventory').timestamp, window.end);
  closeTo(audit.events.find(event => event.metric === 'accumulation').value, 20);
  const exact = mock.env.PI_WEB_API_FETCH;
  mock.env.PI_WEB_API_FETCH = async (url, options) => new URL(url).pathname.endsWith('/recordedattime') ? Response.json({ Timestamp: '2026-10-10T09:59:00.000Z', Value: 120, Good: true, Questionable: false, Substituted: false }) : exact(url, options);
  await assert.rejects(readPiInput(mock.env, piInput, model, window), /exact|boundar/i);
});

test('PI outputs are reconciled mass events at the period end with explicit replacement and bounded units', async () => {
  const mock = piMock(); mock.connection.outputs[0].unit = 't';
  const { run } = await executeModelRun(catalog(), 'pi-model', { id: 'pi-out', now: () => Date.parse(window.end), target: 'published', publishedVersion: 3, ...piAdapters(mock.env) });
  assert.ok(['ok', 'warning'].includes(run.status), run.error);
  closeTo(run.result.objective, 25 / 9);
  const writes = mock.requests.filter(request => request.options.method === 'POST'); assert.equal(writes.length, 6);
  closeTo(writes[0].body.Value, 895 / 9000);
  assert.deepEqual({ ...writes[0].body, Value: 0 }, { Timestamp: window.end, Value: 0, Good: true, Questionable: false });
  writes.forEach(request => { assert.equal(request.url.searchParams.get('updateOption'), 'Replace'); assert.equal(request.url.searchParams.get('bufferOption'), 'DoNotBuffer'); assert.equal(request.options.headers['X-Requested-With'], 'XmlHttpRequest'); });
  const audit = connectorOutputAudit(run); assert.equal(audit.written, 6); assert.equal(audit.events.length, 6); assert.ok(audit.events.every(event => event.confirmed));
  assert.equal(connectorInputAudit(run).readings[0].originalValue, 100);
  for (const forbidden of ['fixture-only-password', 'fixture-user', 'pi.example.test', 'PIDA']) assert.ok(!JSON.stringify(run).includes(forbidden));
});

test('PI output preflights all destinations read-only and refuses integers or unsupported mass units before writing', async () => {
  const model = mappedModel(), mock = piMock();
  assert.deepEqual(await testPiSource(mock.env, piOutput, model), { ok: true });
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 0);
  const normal = mock.env.PI_WEB_API_FETCH;
  mock.env.PI_WEB_API_FETCH = async (url, options) => new URL(url).pathname.endsWith('/points') && new URL(url).searchParams.get('path').includes('OUT_f4')
    ? Response.json({ WebId: 'OUT_f4_mass', PointType: 'Int32', EngineeringUnits: 'kg' }) : normal(url, options);
  const run = { id: 'integer-output', modelId: 'pi-model', modelName: model.name, modelSnapshot: model, result: reconcile(model), finishedAt: window.end };
  await assert.rejects(piAdapters(mock.env).outputAdapters.pi(piOutput, run, { window, recordOutputAudit() {}, authorizeOutput: async () => {} }));
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 0, 'a late invalid target must not leave earlier destinations partially written');
});

test('PI output preserves partial acknowledgements and rejects any unconfirmed scalar response', async () => {
  let writes = 0;
  const mock = piMock({ onRequest: request => request.options.method === 'POST' && ++writes === 2 ? new Response('private plant error', { status: 500 }) : undefined });
  const { run } = await executeModelRun(catalog(), 'pi-model', { id: 'pi-partial', now: () => Date.parse(window.end), ...piAdapters(mock.env) });
  assert.equal(run.status, 'failed'); assert.ok(run.result); assert.match(run.error, /Output failed/); assert.ok(!run.error.includes('private plant error'));
  const audit = connectorOutputAudit(run); assert.equal(audit.written, 1); assert.equal(audit.events.filter(event => event.confirmed).length, 1);
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 2);
  for (const response of [new Response(null, { status: 200 }), new Response(null, { status: 203 }), new Response(null, { status: 204 }), new Response(null, { status: 207 }), Response.json({ success: true }, { status: 202 }), Response.json({ Errors: ['secret'] }, { status: 202 })]) {
    const failure = piMock({ onRequest: request => request.options.method === 'POST' ? response : undefined });
    const outcome = await executeModelRun(catalog(), 'pi-model', { id: 'bad-ack', now: () => Date.parse(window.end), ...piAdapters(failure.env) });
    assert.equal(outcome.run.status, 'failed'); assert.equal(connectorOutputAudit(outcome.run).written, 0);
  }
});

test('PI audit matching invalidates changed acquisition rules and rejects missing snapshots while preserving delivery history', async () => {
  const mock = piMock(), sourceCatalog = catalog();
  const { run } = await executeModelRun(sourceCatalog, 'pi-model', { id: 'matching-pi', now: () => Date.parse(window.end), ...piAdapters(mock.env) });
  assert.equal(runMatchesInputSource(run, sourceCatalog.sources['pi-model'], sourceCatalog.schedules['pi-model']), true);
  const sources = structuredClone(sourceCatalog.sources['pi-model']); sources[0].aggregation = 'sum';
  assert.equal(runMatchesInputSource(run, sources, sourceCatalog.schedules['pi-model']), false);
  assert.equal(runMatchesInputSource({ inputSourceId: piInput.id }, sourceCatalog.sources['pi-model'], sourceCatalog.schedules['pi-model']), false);
  assert.equal(connectorInputAudit({ pi: { input: { source: { type: 'pi' }, readings: [] } } }).source.type, 'pi');
  assert.equal(connectorOutputAudit({ sql: { output: { written: 2 } } }).written, 2);
});

test('PI ISO offsets and supported trailing precision normalize without collapsing distinct submillisecond events', async () => {
  for (const timestamp of ['2026-10-10T09:00:00.0000000Z', '2026-10-10T05:00:00.0000000-04:00', '2026-10-10T10:00:00.0000000+01:00']) {
    const mock = piMock({ samples: (_name, _request, event) => [event(timestamp, 100)] });
    const data = await readPiInput(mock.env, piInput, mappedModel(), window);
    assert.equal(data.readings[0].timestamp, window.start); assert.equal(data.readings[0].quality.coveragePercent, 100);
  }
  for (const timestamp of ['2026-10-10T09:00:00.0000001Z', '2026-10-10T09:00:00.0001000Z']) {
    const mock = piMock({ samples: (_name, _request, event) => [event(timestamp, 100)] });
    await assert.rejects(readPiInput(mock.env, { ...piInput, aggregation: 'sum' }, mappedModel(), window), /precision|submillisecond/i);
  }
});

test('PI AF attributes resolve through the attribute endpoint and retain exact engineering-unit checks', async () => {
  const connection = profile(); connection.inputs[0].path = '\\\\AFSERVER\\Plant\\Area\\Mixer|Feed';
  const mock = piMock({ connection });
  const data = await readPiInput(mock.env, piInput, mappedModel(), window);
  assert.equal(data.readings[0].value, 100);
  assert.ok(mock.requests.some(request => request.route === 'attributes' && request.url.searchParams.get('path') === connection.inputs[0].path));
  const normal = mock.env.PI_WEB_API_FETCH;
  mock.env.PI_WEB_API_FETCH = async (url, options) => new URL(url).pathname.endsWith('/attributes')
    ? Response.json({ WebId: 'IN_f1', Type: 'Double', DefaultUnitsOfMeasureAbbreviation: 't' }) : normal(url, options);
  await assert.rejects(readPiInput(mock.env, piInput, mappedModel(), window), /units/i);
});

test('PI physical identities reject duplicate sensors and destination aliases before any output write', async () => {
  const duplicate = piMock({ onRequest: request => request.route === 'points' && request.url.searchParams.get('path').includes('f3')
    ? Response.json({ WebId: 'IN_f1', PointType: 'Float64', EngineeringUnits: 'kg' }) : undefined });
  await assert.rejects(readPiInput(duplicate.env, piInput, mappedModel(), window), /distinct|same|identit|duplicate/i);
  const output = piMock({ onRequest: request => request.route === 'points' && request.url.searchParams.get('path').includes('OUT_f2')
    ? Response.json({ WebId: 'OUT_f1_mass', PointType: 'Float64', EngineeringUnits: 'kg' }) : undefined });
  const outcome = await executeModelRun(catalog(), 'pi-model', { id: 'duplicate-target', now: () => Date.parse(window.end), ...piAdapters(output.env) });
  assert.equal(outcome.run.status, 'failed'); assert.ok(outcome.run.result);
  assert.equal(output.requests.filter(request => request.options.method === 'POST').length, 0);
  const connection = profile(); connection.inputs[0].path = '\\\\AFSERVER\\Plant\\Mixer|Feed';
  const unverifiable = piMock({ connection, onRequest: request => request.route === 'attributes'
    ? Response.json({ WebId: 'IN_f1', Type: 'Double', DefaultUnitsOfMeasureAbbreviation: 'kg', Links: { Point: 'https://rogue.test/points/SECRET' } }) : undefined });
  await assert.rejects(readPiInput(unverifiable.env, piInput, mappedModel(), window), /identit|verifi|configured.*service/i);
  assert.ok(unverifiable.requests.every(request => request.url.origin === 'https://pi.example.test'));
});

test('PI rate outputs divide reconciled period mass by duration and cannot label inventories as a rate', async () => {
  const connection = profile(); connection.outputs = [{ ...connection.outputs[0], unit: 'kg/h' }];
  const mock = piMock({ connection }), model = mappedModel(); model.periodHours = 2;
  const run = { id: 'two-hour-output', modelId: 'pi-model', modelName: model.name, modelSnapshot: model, result: reconcile(model), finishedAt: window.end };
  await piAdapters(mock.env).outputAdapters.pi(piOutput, run, { window: { start: '2026-10-10T08:00:00.000Z', end: window.end }, recordOutputAudit() {}, authorizeOutput: async () => {} });
  const event = mock.requests.find(request => request.options.method === 'POST'); closeTo(event.body.Value, 895 / 18);
  assert.equal(event.body.Timestamp, window.end);
  for (const metric of ['opening_inventory', 'closing_inventory', 'accumulation']) assert.throws(() => validatePiConnections([{ ...connection, outputs: [{ ...connection.outputs[0], metric }] }]));
});

test('PI output requires a current server authorization callback and fails before writing when it is absent', async () => {
  const mock = piMock(), model = mappedModel();
  const run = { id: 'missing-permission-check', modelId: 'pi-model', modelName: model.name, modelSnapshot: model, result: reconcile(model), finishedAt: window.end };
  await assert.rejects(piAdapters(mock.env).outputAdapters.pi(piOutput, run, { window, recordOutputAudit() {} }), /authoriz|permission/i);
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('PI outputs cannot overwrite an AF-backed physical input through a different declared path', async () => {
  const connection = profile(); connection.inputs[0].path = '\\\\AFSERVER\\Plant\\Mixer|Feed';
  const mock = piMock({ connection, onRequest: request => request.route === 'points' && request.url.searchParams.get('path').includes('OUT_f1')
    ? Response.json({ WebId: 'PHYSICAL_f1', PointType: 'Float64', EngineeringUnits: 'kg' }) : undefined });
  await assert.rejects(testPiSource(mock.env, piOutput, mappedModel()), /input|raw|overwrit|same|identit/i);
  const execution = await executeModelRun(catalog(), 'pi-model', { id: 'raw-protection', now: () => Date.parse(window.end), ...piAdapters(mock.env) });
  assert.equal(execution.run.status, 'failed'); assert.ok(execution.run.result); assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 0);
  const first = profile(), second = profile(); second.id = 'same-service-writer'; second.inputs = []; second.outputs = [{ ...second.outputs[0], path: first.inputs[0].path.toLowerCase() }];
  assert.throws(() => validatePiConnections([first, second]));
});

test('PI integer attributes reject values that JSON would round beyond JavaScript safe-integer precision', async () => {
  const connection = profile(); connection.inputs[0].path = '\\\\AFSERVER\\Plant\\Mixer|Feed';
  for (const Type of ['Int64', 'UInt64']) for (const aggregation of ['latest', 'totalizerDelta']) {
    const mock = piMock({ connection, onRequest: request => {
      if (request.route === 'attributes') return Response.json({ WebId: 'IN_f1', Type, DefaultUnitsOfMeasureAbbreviation: 'kg', Links: { Point: `${connection.baseUrl}/points/PHYSICAL_f1` } });
      if (request.route === 'streams/IN_f1/recorded') return new Response(`{"Items":[{"Timestamp":"${window.start}","Value":9007199254740993,"Good":true,"Questionable":false,"Substituted":false},{"Timestamp":"${window.end}","Value":9007199254740994,"Good":true,"Questionable":false,"Substituted":false}]}`);
    } });
    await assert.rejects(readPiInput(mock.env, { ...piInput, aggregation }, mappedModel(), window), /integer|precision|range/i);
  }
  const safe = piMock({ connection, values: { f1: Number.MAX_SAFE_INTEGER, f3: 60, f4: 35 }, onRequest: request => request.route === 'attributes'
    ? Response.json({ WebId: 'IN_f1', Type: 'UInt64', DefaultUnitsOfMeasureAbbreviation: 'kg', Links: { Point: `${connection.baseUrl}/points/PHYSICAL_f1` } }) : undefined });
  assert.equal((await readPiInput(safe.env, piInput, mappedModel(), window)).readings[0].value, Number.MAX_SAFE_INTEGER);
});
