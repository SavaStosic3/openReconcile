import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, connectionManifest } from '../src/config.js';
import { aggregateReadings, dateField, insertQuery, OUTPUT_COLUMNS, readQuery, testQuery, validateRead, validateWrite } from '../src/contract.js';
import { createGateway } from '../src/gateway.js';
import { createDriver, driverOptions } from '../src/drivers.js';

const token = 'a'.repeat(40);
const connection = { id: 'plant', name: 'Plant SQL', dialect: 'postgres', host: 'db.example.test', database: 'plant', user: 'reader', password: 'secret', readableTables: ['public.readings'], writableTables: ['public.results'] };
const input = { connectionId: 'plant', table: 'public.readings', tagColumn: 'tag', valueColumn: 'reading', timestampColumn: 'recorded_at', tags: ['FEED', "product' OR 1=1 --"], start: '2026-10-10T00:00:00Z', end: '2026-10-10T01:00:00Z', aggregation: 'latest' };
const resultRow = { run_id: 'run1', model_id: 'model1', model_name: 'Plant', published_version: 1, item_id: 'meter1', item_type: 'stream', source_name: 'FEED', metric: 'mass', value_kg: 10, raw_kg: 11, correction_kg: -1, uncertainty_kg: 0.5, status: 'measured', batch_start: input.start, batch_end: input.end, finished_at: '2026-10-10T01:00:01Z' };
function config(extra = {}) { return loadConfig({ SQL_GATEWAY_TOKEN: token, SQL_CONNECTIONS_JSON: JSON.stringify([{ ...connection, ...extra }]) }); }
function assertInvalid(callback, code = 'INVALID_REQUEST') { assert.throws(callback, error => error.code === code); }

test('startup rejects weak secrets, unknown options, duplicate IDs, and remote TLS bypass', () => {
  assertInvalid(() => loadConfig({ SQL_GATEWAY_TOKEN: 'short' }), 'INVALID_CONFIG');
  assertInvalid(() => config({ allowInsecureLocalDevelopment: true }), 'INVALID_CONFIG');
  assertInvalid(() => config({ tls: { rejectUnauthorized: false } }), 'INVALID_CONFIG');
  assertInvalid(() => config({ trustServerCertificate: true }), 'INVALID_CONFIG');
  assertInvalid(() => config({ readableTables: ['public.readings; DROP TABLE x'] }), 'INVALID_CONFIG');
  assertInvalid(() => loadConfig({ SQL_GATEWAY_TOKEN: token, SQL_CONNECTIONS_JSON: JSON.stringify([connection, connection]) }), 'INVALID_CONFIG');
  assert.equal(config().connections[0].port, 5432);
  assert.equal(config({ host: '127.0.0.1', allowInsecureLocalDevelopment: true }).connections[0].allowInsecureLocalDevelopment, true);
});

test('manifest includes capabilities without database secrets', () => {
  assert.deepEqual(connectionManifest(connection), { id: 'plant', name: 'Plant SQL', dialect: 'postgres', canRead: true, canWrite: true });
});

for (const dialect of ['postgres', 'mysql', 'sqlserver']) {
  test(`${dialect} parameterizes every source tag and timestamp and limits raw rows`, () => {
    const query = readQuery({ ...connection, dialect }, validateRead(input, connection));
    assert.equal(query.sql.includes(input.tags[1]), false);
    assert.equal(query.params[1], input.tags[1]);
    assert.ok(query.params[2] instanceof Date);
    assert.match(query.sql, /10001/);
    assert.match(query.sql, / >= /);
    assert.match(query.sql, / < /);
    assert.equal(query.params.length, 4);
  });
  test(`${dialect} uses verified TLS by default and loopback-only development bypass`, () => {
    const options = driverOptions({ ...connection, dialect });
    if (dialect === 'sqlserver') {
      assert.equal(options.options.encrypt, true);
      assert.equal(options.options.trustServerCertificate, false);
    } else assert.equal(options.ssl.rejectUnauthorized, true);
  });
  test(`${dialect} inserts only canonical output columns with parameter values`, () => {
    const row = validateWrite({ table: 'public.results', rows: [resultRow] }, connection)[0];
    const query = insertQuery({ ...connection, dialect }, 'public.results', row);
    assert.equal(query.sql.includes(resultRow.model_name), false);
    assert.equal(query.params.length, OUTPUT_COLUMNS.length);
    assert.equal(query.params[0], 'run1');
    assert.ok(query.params.at(-1) instanceof Date);
  });
}

test('input validation rejects table injection, column expressions, duplicate tags, malformed windows and excessive batches', () => {
  assertInvalid(() => validateRead({ ...input, table: 'public.readings;delete' }, connection));
  assertInvalid(() => validateRead({ ...input, table: 'public.other' }, connection), 'TABLE_NOT_ALLOWED');
  assertInvalid(() => validateRead({ ...input, valueColumn: 'SUM(reading)' }, connection));
  assertInvalid(() => validateRead({ ...input, tags: ['same', 'same'] }, connection));
  assertInvalid(() => validateRead({ ...input, tags: Array.from({ length: 501 }, (_, i) => `t${i}`) }, connection));
  assertInvalid(() => validateRead({ ...input, start: input.end }, connection));
  assertInvalid(() => validateRead({ ...input, start: '2026-10-10 00:00:00' }, connection));
  assertInvalid(() => validateRead({ ...input, aggregation: 'sql' }, connection));
});
test('timestamps reject calendar rollover and preserve explicit timezone instants', () => {
  for (const value of ['2026-02-31T00:00:00Z', '2026-02-29T00:00:00Z', '2026-10-10T24:00:00Z', '2026-04-31T00:00:00Z']) assertInvalid(() => dateField(value, 'Timestamp'));
  assert.equal(dateField('2024-02-29T02:00:00+02:00', 'Timestamp'), '2024-02-29T00:00:00.000Z');
});

test('test connectivity checks use SELECT0 for inputs and canonical outputs without writing', () => {
  assert.match(testQuery(connection, { ...input, direction: 'input' }).sql, /WHERE 1 = 0$/);
  const query = testQuery(connection, { direction: 'output', table: 'public.results' });
  OUTPUT_COLUMNS.forEach(column => assert.ok(query.sql.includes(`"${column}"`)));
  assert.equal(/INSERT|UPDATE|DELETE|CREATE/.test(query.sql), false);
});

const normalizedInput = validateRead({ ...input, tags: ['FEED'] }, connection);
const samples = [
  { source_name: 'FEED', value: '2.5', timestamp: new Date('2026-10-10T00:10:00Z') },
  { source_name: 'FEED', value: 3.5, timestamp: '2026-10-10T00:20:00Z' },
];
test('latest, sum, and average aggregate decimal strings and numbers inside the half-open window', () => {
  assert.equal(aggregateReadings(samples, normalizedInput).readings[0].value, 3.5);
  assert.equal(aggregateReadings(samples, { ...normalizedInput, aggregation: 'sum' }).readings[0].value, 6);
  assert.equal(aggregateReadings(samples, { ...normalizedInput, aggregation: 'average' }).readings[0].value, 3);
  assert.deepEqual(aggregateReadings(samples, normalizedInput).window, { start: normalizedInput.start, end: normalizedInput.end });
});
test('latest timestamp ties fail only if readings conflict', () => {
  assertInvalid(() => aggregateReadings([samples[1], { ...samples[1], value: 4 }], normalizedInput), 'AMBIGUOUS_SOURCE_DATA');
  assert.equal(aggregateReadings([samples[1], samples[1]], normalizedInput).readings[0].value, 3.5);
});
test('source reading rejects missing tags, invalid numbers, invalid timestamps, unexpected tags, and outside-window records', () => {
  assertInvalid(() => aggregateReadings([], normalizedInput), 'MISSING_SOURCE_DATA');
  for (const value of [null, '', ' ', 'NaN', 'Infinity', true, -1, {}, Infinity]) assertInvalid(() => aggregateReadings([{ ...samples[0], value }], normalizedInput), 'INVALID_SOURCE_DATA');
  assertInvalid(() => aggregateReadings([{ ...samples[0], timestamp: input.end }], normalizedInput), 'INVALID_SOURCE_DATA');
  assertInvalid(() => aggregateReadings([{ ...samples[0], timestamp: 'invalid' }], normalizedInput), 'INVALID_SOURCE_DATA');
  assertInvalid(() => aggregateReadings([{ ...samples[0], source_name: 'OTHER' }], normalizedInput), 'INVALID_SOURCE_DATA');
  assertInvalid(() => aggregateReadings(Array(10_001).fill(samples[0]), normalizedInput), 'TOO_MANY_ROWS');
});
test('averages avoid overflow; sums that overflow fail', () => {
  const large = samples.map(row => ({ ...row, value: 1e308 }));
  assert.equal(aggregateReadings(large, { ...normalizedInput, aggregation: 'average' }).readings[0].value, 1e308);
  assertInvalid(() => aggregateReadings(large, { ...normalizedInput, aggregation: 'sum' }), 'INVALID_SOURCE_DATA');
});

for (const dialect of ['postgres', 'mysql', 'sqlserver']) {
  test(`${dialect} advanced reads bind their lookback and boundaries and quote the configured quality column`, () => {
    const advanced = validateRead({ ...input, aggregation: 'timeWeightedAverage', quality: { maxAgeMinutes: 30, qualityColumn: 'historian_flag' } }, connection);
    const query = readQuery({ ...connection, dialect }, advanced);
    assert.equal(query.sql.includes(input.tags[1]), false);
    assert.match(query.sql, /WITH source_rows AS/);
    assert.match(query.sql, /MAX\(/);
    assert.match(query.sql, /10001/);
    assert.match(query.sql, /quality_value/);
    assert.equal(query.params.length, input.tags.length + 4);
    assert.equal(query.params[input.tags.length].toISOString(), '2026-10-09T23:30:00.000Z');
    assert.equal(query.params[input.tags.length + 1].toISOString(), '2026-10-10T01:00:00.000Z');
    assert.equal(query.params.at(-1).toISOString(), '2026-10-10T00:00:00.000Z');
    if (dialect === 'mysql') assert.equal(query.sql.match(/\?/g).length, query.params.length);
  });
}

test('quality column schema tests and reads reject identifier injection and duplicate columns', () => {
  assertInvalid(() => validateRead({ ...input, quality: { qualityColumn: 'flag;DROP' } }, connection));
  assertInvalid(() => validateRead({ ...input, quality: { qualityColumn: input.valueColumn } }, connection));
  assertInvalid(() => testQuery(connection, { ...input, direction: 'input', quality: { qualityColumn: 'flag;DROP' } }));
  assert.match(testQuery(connection, { ...input, direction: 'input', quality: { qualityColumn: 'flag' } }).sql, /"flag"/);
  assert.equal(Object.hasOwn(validateRead(input, connection), 'quality'), false);
  assert.equal(validateRead({ ...input, aggregation: 'totalizerDelta' }, connection).quality.maxAgeMinutes, 60);
});

test('gateway quality aggregation preserves legacy shapes and rejects unsafe boundary or invalid Date records', () => {
  assert.deepEqual(Object.keys(aggregateReadings(samples, normalizedInput).readings[0]), ['sourceName', 'value', 'timestamp']);
  const weighted = validateRead({ ...input, tags: ['FEED'], aggregation: 'timeWeightedAverage', quality: {} }, connection);
  const points = [{ source_name: 'FEED', value: 10, timestamp: '2026-10-09T23:50:00Z' }, { source_name: 'FEED', value: 40, timestamp: '2026-10-10T00:20:00Z' }];
  const result = aggregateReadings(points, weighted);
  assert.ok(Math.abs(result.readings[0].value - 30) < 1e-10);
  assert.equal(result.readings[0].quality.coveragePercent, 100);
  assertInvalid(() => aggregateReadings([{ ...points[0], timestamp: new Date(NaN) }], weighted), 'INVALID_SOURCE_DATA');
  assertInvalid(() => aggregateReadings([{ ...points[0], timestamp: '2026-10-09T22:00:00Z' }], weighted), 'INVALID_SOURCE_DATA');
  assertInvalid(() => aggregateReadings([{ ...points[0], timestamp: '2026-10-10T01:01:00Z' }], weighted), 'INVALID_SOURCE_DATA');
  assertInvalid(() => aggregateReadings(Array(10_001).fill(points[0]), weighted), 'TOO_MANY_ROWS');
});

test('HTTP quality reads include audited integration and safe quality failures', async () => {
  let bad = false;
  const gateway = await startGateway({ driverFactory: async () => ({
    query: async () => [
      { source_name: 'FEED', value: 10, timestamp: input.start, quality_value: 'Good' },
      { source_name: 'FEED', value: 30, timestamp: '2026-10-10T00:30:00Z', quality_value: bad ? 'Bad' : 'Good' },
    ], close: async () => {},
  }) });
  try {
    const body = { ...input, tags: ['FEED'], aggregation: 'timeWeightedAverage', quality: { qualityColumn: 'flag' } };
    const success = await gateway.request('/read', body);
    assert.equal(success.status, 200);
    const result = await success.json();
    assert.equal(result.readings[0].value, 20);
    assert.equal(result.readings[0].quality.coveragePercent, 100);
    bad = true;
    const rejected = await gateway.request('/read', body);
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, 'BAD_SOURCE_QUALITY');
  } finally { await gateway.close(); }
});
test('output validation rejects duplicate identities, unsafe statuses, mixed runs and nonnumeric fields', () => {
  assertInvalid(() => validateWrite({ table: 'public.results', rows: [resultRow, resultRow] }, connection));
  assertInvalid(() => validateWrite({ table: 'public.results', rows: [{ ...resultRow, status: 'unobservable' }] }, connection));
  assertInvalid(() => validateWrite({ table: 'public.results', rows: [{ ...resultRow, value_kg: true }] }, connection));
  assertInvalid(() => validateWrite({ table: 'public.results', rows: [resultRow, { ...resultRow, item_id: 'other', run_id: 'other' }] }, connection));
  assertInvalid(() => validateWrite({ table: 'public.results', rows: [{ ...resultRow, item_type: 'unit', metric: 'mass' }] }, connection));
  const unit = validateWrite({ table: 'public.results', rows: [{ ...resultRow, item_type: 'unit', metric: 'incoming_mass', status: 'reconciled', raw_kg: null, correction_kg: null, uncertainty_kg: null }] }, connection);
  assert.equal(unit[0].raw_kg, null);
  assert.equal(validateWrite({ table: 'public.results', rows: [{ ...resultRow, item_id: 'i'.repeat(128) }] }, connection)[0].item_id.length, 128);
  assertInvalid(() => validateWrite({ table: 'public.results', rows: [{ ...resultRow, item_id: 'i'.repeat(129) }] }, connection));
  for (const status of ['measured_questionable', 'estimated_questionable']) assert.equal(validateWrite({ table: 'public.results', rows: [{ ...resultRow, status }] }, connection)[0].status, status);
  const questionableUnit = { ...resultRow, item_type: 'unit', metric: 'incoming_mass', status: 'reconciled_questionable' };
  assert.equal(validateWrite({ table: 'public.results', rows: [questionableUnit] }, connection)[0].status, 'reconciled_questionable');
  assertInvalid(() => validateWrite({ table: 'public.results', rows: [resultRow, { ...resultRow, item_id: 'warning', status: 'measured_questionable' }] }, connection));
});

async function startGateway(options = {}) {
  const gateway = createGateway(config(), options);
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const request = (path, body, headers = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...gateway, base, request };
}
test('HTTP requires bearer auth, strips secrets, and serves no CORS headers', async () => {
  const gateway = await startGateway({ driverFactory: () => { throw new Error('must not open DB'); } });
  try {
    const denied = await gateway.request('/connections', undefined, { authorization: 'Bearer invalid' });
    assert.equal(denied.status, 401);
    const response = await gateway.request('/connections');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const body = await response.text();
    assert.equal(body.includes('password'), false);
    assert.equal(body.includes('db.example.test'), false);
    assert.equal(body.includes('reader'), false);
  } finally { await gateway.close(); }
});
test('HTTP read, readonly test and transactional write use generated queries', async () => {
  const calls = [];
  const gateway = await startGateway({ driverFactory: async () => ({
    query: async query => { calls.push(query); return query.sql.includes('WHERE 1 = 0') ? [] : samples; },
    transaction: async queries => { calls.push(...queries); }, close: async () => {},
  }) });
  try {
    assert.deepEqual(await (await gateway.request('/test', { ...input, direction: 'input' })).json(), { ok: true });
    const read = await gateway.request('/read', { ...input, tags: ['FEED'] });
    assert.equal((await read.json()).readings[0].value, 3.5);
    assert.deepEqual(await (await gateway.request('/write', { connectionId: 'plant', table: 'public.results', rows: [resultRow] })).json(), { written: 1 });
    assert.equal(calls.length, 3);
  } finally { await gateway.close(); }
});
test('HTTP database errors are generic, body and method limits fail before querying', async () => {
  const gateway = await startGateway({ driverFactory: async () => ({ query: async () => { throw new Error('password=secret SQL SELECT server private'); }, close: async () => {} }) });
  try {
    const response = await gateway.request('/test', { ...input, direction: 'input' });
    assert.equal(response.status, 502);
    const error = await response.text();
    assert.equal(error.includes('secret'), false);
    assert.equal(error.includes('SELECT'), false);
    assert.equal((await gateway.request('/unknown', {})).status, 404);
    assert.equal((await gateway.request('/read', { payload: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
    assert.equal((await gateway.request('/read', {}, { 'content-type': 'text/plain' })).status, 415);
  } finally { await gateway.close(); }
});
test('HTTP deadline cancels work and keeps pending rollback within concurrency cap', async () => {
  let finish;
  let signal;
  const gateway = await startGateway({ deadlineMs: 20, maxConcurrency: 1, driverFactory: async () => ({
    query: async (_, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); }, close: async () => {},
  }) });
  try {
    const response = await gateway.request('/test', { ...input, direction: 'input' });
    assert.equal(response.status, 504);
    assert.equal(signal.aborted, true);
    assert.equal((await gateway.request('/test', { ...input, direction: 'input' })).status, 503);
    finish([]);
  } finally { await gateway.close(); }
});

test('PostgreSQL transaction rolls back and releases client after statement error', async () => {
  const calls = [];
  const client = { query: async sql => { calls.push(sql); if (sql === 'FAIL') throw new Error('database failure'); return { rows: [] }; }, release: () => calls.push('RELEASE') };
  class Pool { constructor(options) { this.options = options; } async connect() { return client; } async end() {} }
  const driver = await createDriver(connection, { pg: { Pool } });
  await assert.rejects(driver.transaction([{ sql: 'INSERT', params: [] }, { sql: 'FAIL', params: [] }]));
  assert.deepEqual(calls, ['BEGIN', 'INSERT', 'FAIL', 'ROLLBACK', 'RELEASE']);
});
test('MySQL transaction rolls back and releases client after statement error', async () => {
  const calls = [];
  const client = { beginTransaction: async () => calls.push('BEGIN'), execute: async ({ sql }) => { calls.push(sql); if (sql === 'FAIL') throw new Error('database failure'); return [[]]; }, rollback: async () => calls.push('ROLLBACK'), commit: async () => calls.push('COMMIT'), release: () => calls.push('RELEASE'), destroy: () => calls.push('DESTROY') };
  const driver = await createDriver({ ...connection, dialect: 'mysql' }, { mysql: { createPool: () => ({ getConnection: async () => client, end: async () => {} }) } });
  await assert.rejects(driver.transaction([{ sql: 'INSERT', params: [] }, { sql: 'FAIL', params: [] }]));
  assert.deepEqual(calls, ['BEGIN', 'INSERT', 'FAIL', 'ROLLBACK', 'RELEASE']);
});
test('SQL Server transaction rolls back after statement error and uses typed parameters', async () => {
  const calls = [];
  class Request {
    input(name, type, value) { calls.push([name, type, value]); return this; }
    async query(sql) { calls.push(sql); if (sql === 'FAIL') throw new Error('database failure'); return { recordset: [] }; }
  }
  class ConnectionPool { async connect() {} async close() {} request() { return new Request(); } }
  class Transaction { async begin() { calls.push('BEGIN'); } async commit() { calls.push('COMMIT'); } async rollback() { calls.push('ROLLBACK'); } }
  const driver = await createDriver({ ...connection, dialect: 'sqlserver' }, { mssql: { ConnectionPool, Transaction, Request, DateTime2: () => 'DATE', Float: 'FLOAT', NVarChar: () => 'TEXT' } });
  await assert.rejects(driver.transaction([{ sql: 'INSERT', params: ['tag', 2, new Date(input.start)] }, { sql: 'FAIL', params: [] }]));
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.deepEqual(calls[1].slice(0, 2), ['p0', 'TEXT']);
  assert.deepEqual(calls[2].slice(0, 2), ['p1', 'FLOAT']);
  assert.deepEqual(calls[3].slice(0, 2), ['p2', 'DATE']);
});
test('aborted PostgreSQL operations discard the leased connection', async () => {
  const calls = [];
  const client = { query: () => new Promise(() => {}), release: destroy => calls.push(destroy) };
  class Pool { async connect() { return client; } async end() {} }
  const driver = await createDriver(connection, { pg: { Pool } });
  const abort = new AbortController();
  const work = driver.query({ sql: 'SELECT', params: [] }, abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(work);
  assert.deepEqual(calls, [true]);
});
