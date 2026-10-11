import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReadings, readQuery, UNSUPPORTED_COUNTER_PRECISION_MARKER, validateRead } from '../src/contract.js';
import { driverOptions } from '../src/drivers.js';

const connection = { dialect: 'postgres', readableTables: ['readings'], writableTables: [] };
const start = '2026-10-10T09:00:00.000Z', end = '2026-10-10T10:00:00.000Z';
const input = validateRead({ table: 'readings', tagColumn: 'tag', valueColumn: 'counter', timestampColumn: 'recorded_at', tags: ['COUNTER'], start, end, aggregation: 'totalizerDelta' }, connection);
const rows = (a, b) => [{ source_name: 'COUNTER', value: a, timestamp: start }, { source_name: 'COUNTER', value: b, timestamp: end }];

test('large SQL integer counters retain a one-unit transfer and audited full coverage', () => {
  const result = aggregateReadings(rows('9007199254740992', '9007199254740993'), input);
  assert.equal(result.readings[0].value, 1);
  assert.equal(result.readings[0].quality.coveragePercent, 100);
  assert.deepEqual(result.readings[0].quality.warnings, []);
});

test('SQL DECIMAL totalizers retain a small transfer from a large fractional baseline', () => {
  assert.equal(aggregateReadings(rows('999999999999.000001', '999999999999.000002'), input).readings[0].value, 0.000001);
});

test('unsafe numeric counters reject with a precision error instead of false zero coverage', () => {
  assert.throws(() => aggregateReadings(rows(9007199254740992, 9007199254740993), input), error => error.code === 'UNSUPPORTED_COUNTER_PRECISION' && error.status === 422 && /exact SQL counter as text/.test(error.message));
});

test('MySQL returns BIGINT and DECIMAL counters without coercing them to Number', () => {
  const options = driverOptions({ dialect: 'mysql' });
  assert.equal(options.supportBigNumbers, true);
  assert.equal(options.bigNumberStrings, true);
  assert.equal(options.decimalNumbers, false);
});

test('PostgreSQL preserves stored floating-point distinctions when projecting counter text', () => {
  assert.equal(driverOptions({ dialect: 'postgres' }).options, '-c extra_float_digits=3');
});

for (const dialect of ['postgres', 'mysql', 'sqlserver']) {
  test(`${dialect} totalizer queries preserve exact types and reject unsupported approximate precision`, () => {
    const query = readQuery({ ...connection, dialect }, input);
    if (dialect === 'postgres') {
      assert.match(query.sql, /pg_typeof\("counter"\)::text IN \('bigint', 'integer', 'smallint', 'numeric'/);
      assert.ok(query.sql.includes(`ELSE '${UNSUPPORTED_COUNTER_PRECISION_MARKER}'`));
      assert.match(query.sql, /CAST\("counter" AS TEXT\)/);
    } else if (dialect === 'mysql') {
      assert.match(query.sql, /`counter` AS `value`/);
      assert.equal(query.sql.includes('CAST'), false);
    }
    else {
      assert.match(query.sql, /SQL_VARIANT_PROPERTY\(\[counter\], 'BaseType'\) IN \('money', 'smallmoney'\)/);
      assert.match(query.sql, /CONVERT\(varchar\(max\), \[counter\], 2\)/);
      assert.match(query.sql, /CONVERT\(varchar\(max\), \[counter\], 0\)/);
      assert.match(query.sql, /'decimal', 'numeric', 'char', 'varchar'/);
      assert.ok(query.sql.includes(`ELSE '${UNSUPPORTED_COUNTER_PRECISION_MARKER}'`));
      assert.equal(/'float'|'real'/.test(query.sql), false);
    }
    const ordinary = readQuery({ ...connection, dialect }, { ...input, aggregation: 'timeWeightedAverage' });
    assert.equal(/CAST|CONVERT|SQL_VARIANT_PROPERTY/.test(ordinary.sql), false);
  });
}

test('unsupported SQL counter type marker rejects with an explicit precision error', () => {
  assert.throws(() => aggregateReadings(rows(UNSUPPORTED_COUNTER_PRECISION_MARKER, UNSUPPORTED_COUNTER_PRECISION_MARKER), input), error => error.code === 'UNSUPPORTED_COUNTER_PRECISION' && error.status === 422 && /exact DECIMAL\/BIGINT/.test(error.message));
});

test('native MySQL floating counters reject materially incorrect fractional subtraction', () => {
  assert.throws(() => aggregateReadings(rows(1000000000000000.1, 1000000000000001), input), error => error.code === 'UNSUPPORTED_COUNTER_PRECISION');
  assert.equal(aggregateReadings(rows(1000000000000000.5, 1000000000000001), input).readings[0].value, 0.5);
});
