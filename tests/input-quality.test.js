import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateQualityReadings, INPUT_QUALITY_DEFAULTS, validateInputQuality } from '../public/input-quality.js';
import { validateSqlSource } from '../public/sql-sources.js';

const start = '2026-10-10T00:00:00.000Z', end = '2026-10-10T01:00:00.000Z';
const sample = (minute, value, quality = 'Good') => ({ timestamp: new Date(Date.parse(start) + minute * 60_000).toISOString(), value, quality });
const calculate = (samples, quality = {}, aggregation = 'timeWeightedAverage') => aggregateQualityReadings(samples, { sourceName: 'FEED', start, end, aggregation, quality });
const failure = (callback, code) => assert.throws(callback, error => error.code === code && error.message.startsWith('FEED: '));

test('quality policy normalizes defaults, clones flags, rejects malformed and unsupported options', () => {
  assert.deepEqual(validateInputQuality({}), INPUT_QUALITY_DEFAULTS);
  const flags = ['192']; const result = validateInputQuality({ goodQualityValues: flags }); flags.push('Bad');
  assert.deepEqual(result.goodQualityValues, ['192']);
  for (const value of [null, [], { extra: true }, { maxAgeMinutes: 0 }, { maxAgeMinutes: Infinity }, { maxAgeMinutes: 527041 }, { minCoveragePercent: -1 }, { minCoveragePercent: 101 }, { qualityColumn: 'quality;DROP' }, { qualityColumn: 'schema.quality' }, { goodQualityValues: [] }, { goodQualityValues: ['Good', 'Good'] }, { goodQualityValues: [' Good'] }, { goodQualityValues: Array(33).fill('Good') }, { badQualityPolicy: 'guess' }, { interpolation: 'auto' }, { totalizerReset: 'rollover' }, { rolloverValue: NaN }]) assert.throws(() => validateInputQuality(value));
});

test('SQL source quality is optional for compatibility and validates distinct identifiers', () => {
  const source = { id: 'input', name: 'Input', type: 'sql', direction: 'input', connectionId: 'plant', table: 'readings', tagColumn: 'tag', valueColumn: 'value', timestampColumn: 'timestamp', aggregation: 'latest' };
  assert.deepEqual(validateSqlSource(source), source);
  assert.deepEqual(validateSqlSource({ ...source, quality: {} }).quality, INPUT_QUALITY_DEFAULTS);
  assert.equal(validateSqlSource({ ...source, aggregation: 'timeWeightedAverage' }).aggregation, 'timeWeightedAverage');
  assert.throws(() => validateSqlSource({ ...source, quality: { qualityColumn: 'value' } }));
  assert.throws(() => validateSqlSource({ id: 'out', name: 'Output', type: 'sql', direction: 'output', connectionId: 'plant', table: 'results', quality: {} }));
});

test('step flow integration uses elapsed time for irregular samples, not arithmetic sample weighting', () => {
  const result = calculate([sample(45, 40), sample(0, 10), sample(15, 20)]);
  assert.equal(result.value, 22.5);
  assert.equal(result.quality.coveragePercent, 100);
  assert.equal(result.quality.sampleCount, 3);
  assert.equal(result.quality.latestTimestamp, sample(45, 40).timestamp);
  assert.ok(Math.abs(calculate([sample(45, 40), sample(0, 10), sample(15, 20)], {}, 'average').value - 70 / 3) < 1e-10);
});

test('linear flow integration uses trapezoids and requires endpoint support', () => {
  assert.equal(calculate([sample(0, 0), sample(15, 60), sample(60, 0)], { interpolation: 'linear' }).value, 30);
  assert.equal(calculate([sample(0, 0), sample(15, 60), sample(60, 0)], { interpolation: 'step' }).value, 45);
  failure(() => calculate([sample(0, 0), sample(15, 60)], { interpolation: 'linear' }), 'INSUFFICIENT_COVERAGE');
});

test('weighted aggregation seeds the start from a fresh pre-period sample and clips its duration', () => {
  assert.ok(Math.abs(calculate([sample(-10, 10), sample(20, 40)]).value - 30) < 1e-10);
  assert.ok(Math.abs(calculate([sample(-10, 0), sample(20, 30), sample(60, 30)], { interpolation: 'linear' }).value - 80 / 3) < 1e-10);
  failure(() => calculate([sample(-61, 10), sample(20, 40)]), 'INVALID_SOURCE_DATA');
});

test('latest freshness is measured at the historical period end, never the current clock', () => {
  assert.equal(calculate([sample(0, 10), sample(55, 20)], { maxAgeMinutes: 60 }, 'latest').value, 20);
  failure(() => calculate([sample(0, 10), sample(30, 20)], { maxAgeMinutes: 10, minCoveragePercent: 0 }, 'latest'), 'STALE_SOURCE_DATA');
});

test('coverage measures intervals and rejects unobserved starts rather than counting sample rows', () => {
  failure(() => calculate([sample(10, 10), sample(20, 20)]), 'INSUFFICIENT_COVERAGE');
  const result = calculate([sample(10, 10), sample(20, 20)], { minCoveragePercent: 80 }, 'average');
  assert.ok(Math.abs(result.quality.coveragePercent - 100 * 50 / 60) < 1e-10);
});

test('flow gaps reject by default and require both explicit scaling and sufficient coverage', () => {
  const points = [sample(0, 10), sample(40, 20), sample(55, 20)];
  failure(() => calculate(points, { maxAgeMinutes: 15 }), 'INSUFFICIENT_COVERAGE');
  failure(() => calculate(points, { maxAgeMinutes: 15, minCoveragePercent: 50 }), 'SOURCE_DATA_GAP');
  failure(() => calculate(points, { maxAgeMinutes: 15, minCoveragePercent: 80, gapPolicy: 'scale' }), 'INSUFFICIENT_COVERAGE');
  const result = calculate(points, { maxAgeMinutes: 15, minCoveragePercent: 50, gapPolicy: 'scale' });
  assert.ok(Math.abs(result.quality.coveragePercent - 100 * 35 / 60) < 1e-10);
  assert.ok(Math.abs(result.value - 110 / 7) < 1e-10);
  assert.match(result.quality.warnings[0], /extrapolated/);
});

test('only an explicit historian flag whitelist is accepted, including missing and unfamiliar flags', () => {
  for (const flag of ['Bad', 'good', null, 192]) failure(() => calculate([sample(0, 10), sample(30, 20, flag)], { qualityColumn: 'status' }), 'BAD_SOURCE_QUALITY');
  assert.equal(calculate([sample(0, 10, '192'), sample(30, 20, '192')], { qualityColumn: 'status', goodQualityValues: ['192'] }).value, 15);
  assert.equal(calculate([sample(0, 10, 192), sample(30, 20, 192)], { qualityColumn: 'status', goodQualityValues: ['192'] }).value, 15);
  failure(() => calculate([sample(0, 10, true)], { qualityColumn: 'status', goodQualityValues: ['true'] }), 'BAD_SOURCE_QUALITY');
});

test('excluding bad readings breaks temporal coverage and never bridges through bad samples', () => {
  const points = [sample(0, 10), sample(15, null, 'Bad'), sample(30, 30), sample(60, 30)];
  failure(() => calculate(points, { qualityColumn: 'status', badQualityPolicy: 'exclude' }), 'INSUFFICIENT_COVERAGE');
  const result = calculate(points, { qualityColumn: 'status', badQualityPolicy: 'exclude', minCoveragePercent: 75, gapPolicy: 'scale' });
  assert.equal(result.quality.coveragePercent, 75);
  assert.equal(result.quality.rejectedCount, 1);
  assert.ok(Math.abs(result.value - 70 / 3) < 1e-10);
  assert.match(result.quality.warnings.join(' '), /not bridged/);
  failure(() => calculate(points, { qualityColumn: 'status', badQualityPolicy: 'exclude', interpolation: 'linear', minCoveragePercent: 75, gapPolicy: 'scale' }), 'INSUFFICIENT_COVERAGE');
});

test('conflicting duplicate timestamps fail while identical records contribute once', () => {
  const points = [sample(0, 10), sample(30, 20)];
  assert.equal(calculate([...points, sample(30, 20)]).value, 15);
  assert.equal(calculate([...points, sample(30, 20)]).quality.sampleCount, 2);
  failure(() => calculate([...points, sample(30, 21)]), 'AMBIGUOUS_SOURCE_DATA');
  failure(() => calculate([...points, sample(30, 20, 'Bad')], { qualityColumn: 'flag', badQualityPolicy: 'exclude' }), 'AMBIGUOUS_SOURCE_DATA');
});

test('time-weighted integration avoids overflowing finite large samples', () => {
  assert.equal(calculate([sample(0, 1e308), sample(30, 1e308)]).value, 1e308);
  assert.equal(calculate([sample(0, 1e308), sample(60, 1e308)], { interpolation: 'linear' }).value, 1e308);
});

test('totalizers reconcile deltas and interpolate an observed start bracket', () => {
  assert.equal(calculate([sample(0, 100), sample(20, 150), sample(60, 220)], {}, 'totalizerDelta').value, 120);
  const result = calculate([sample(-10, 80), sample(10, 120), sample(60, 220)], {}, 'totalizerDelta');
  assert.equal(result.value, 120);
  assert.match(result.quality.warnings[0], /boundary.*interpolated/);
});

test('totalizer subtraction preserves exact large integer, decimal, exponent and mixed driver counters', () => {
  for (const [opening, closing, expected] of [
    ['9007199254740992', '9007199254740993', 1],
    [9007199254740992n, '9007199254740993', 1],
    [Number.MAX_SAFE_INTEGER, '9007199254740992', 1],
    ['999999999999.000001', '999999999999.000002', 0.000001],
    ['9.007199254740992e15', '9007199254740993.000', 1],
    [0.3, '0.40', 0.1],
    ['1.0000000000000000000000000000000000000001', '1.1000000000000000000000000000000000000001', 0.1],
  ]) assert.equal(calculate([sample(0, opening), sample(60, closing)], {}, 'totalizerDelta').value, expected);
});

test('totalizer timestamp equality compares exact values before any Number conversion', () => {
  const points = [sample(0, '9007199254740992'), sample(60, '9007199254740993')];
  assert.equal(calculate([...points, sample(0, '9007199254740992.00')], {}, 'totalizerDelta').quality.sampleCount, 2);
  failure(() => calculate([...points, sample(0, '9007199254740993')], {}, 'totalizerDelta'), 'AMBIGUOUS_SOURCE_DATA');
  failure(() => calculate([sample(0, '1000000000000000.1'), sample(0, 1000000000000000.1), sample(60, 1000000000000001)], {}, 'totalizerDelta'), 'AMBIGUOUS_SOURCE_DATA');
  failure(() => calculate([sample(0, 1000000000000000.1), sample(0, '1000000000000000.1'), sample(60, 1000000000000001)], {}, 'totalizerDelta'), 'AMBIGUOUS_SOURCE_DATA');
});

test('totalizer interpolation subtracts exact baselines before estimating a fractional period amount', () => {
  assert.equal(calculate([sample(-30, '9007199254740992'), sample(60, '9007199254740995')], { maxAgeMinutes: 90 }, 'totalizerDelta').value, 2);
  assert.equal(calculate([sample(-30, '9007199254740992'), sample(60, '9007199254740993')], { maxAgeMinutes: 90 }, 'totalizerDelta').value, 2 / 3);
});

test('totalizer restart and rollover arithmetic preserves decimals and rejects unsafe modulus settings', () => {
  assert.equal(calculate([sample(0, '999999999999.000001'), sample(30, '999999999999.000002'), sample(60, '0.000001')], { totalizerReset: 'restart' }, 'totalizerDelta').value, 0.000002);
  assert.equal(calculate([sample(0, '999.999999'), sample(60, '0.000001')], { totalizerReset: 'rollover', rolloverValue: 1000 }, 'totalizerDelta').value, 0.000002);
  assert.throws(() => validateInputQuality({ totalizerReset: 'rollover', rolloverValue: 9007199254740992 }), /safe integer/);
});

test('unsupported counter input or final measurement precision fails rather than silently rounding', () => {
  for (const [opening, closing] of [
    [9007199254740992, 9007199254740993],
    ['0', '9007199254740992'],
    ['0', '0.123456789012345678901'],
    ['1'.repeat(101), '2'.repeat(101)],
    ['1e-101', '2e-101'],
    ['0', '1e100000'],
  ]) failure(() => calculate([sample(0, opening), sample(60, closing)], {}, 'totalizerDelta'), 'UNSUPPORTED_COUNTER_PRECISION');
});

test('native fractional counter precision cannot materially change the transferred amount', () => {
  assert.equal(1000000000000001 - 1000000000000000.1, 0.875);
  for (const [opening, closing] of [[1000000000000000.1, 1000000000000001], [1000000000000000.1, '1000000000000001'], ['1000000000000000.1', 1000000000000000.1], [1000000000000.1, 1000000000000.2]]) {
    failure(() => calculate([sample(0, opening), sample(60, closing)], {}, 'totalizerDelta'), 'UNSUPPORTED_COUNTER_PRECISION');
  }
  // Exactly representable large fractions and ordinary rounding stay usable.
  assert.equal(calculate([sample(0, 1000000000000000.5), sample(60, 1000000000000001)], {}, 'totalizerDelta').value, 0.5);
  assert.equal(calculate([sample(0, 0.3), sample(60, 0.4)], {}, 'totalizerDelta').value, 0.1);
  failure(() => calculate([sample(0, '999999999999999.875'), sample(60, '0.1')], { totalizerReset: 'rollover', rolloverValue: 1000000000000000.1 }, 'totalizerDelta'), 'UNSUPPORTED_COUNTER_PRECISION');
});

test('totalizer resets reject unless restart-to-zero is explicitly selected and audited', () => {
  const points = [sample(0, 100), sample(20, 140), sample(40, 10), sample(60, 50)];
  failure(() => calculate(points, {}, 'totalizerDelta'), 'TOTALIZER_RESET');
  const result = calculate(points, { totalizerReset: 'restart' }, 'totalizerDelta');
  assert.equal(result.value, 90);
  assert.equal(result.quality.resetCount, 1);
  assert.match(result.quality.warnings[0], /unknown and excluded/);
});

test('totalizer rollover uses a configured modulus and records its single-wrap assumption', () => {
  const result = calculate([sample(0, 990), sample(30, 10), sample(60, 40)], { totalizerReset: 'rollover', rolloverValue: 1000 }, 'totalizerDelta');
  assert.equal(result.value, 50);
  assert.equal(result.quality.resetCount, 1);
  assert.match(result.quality.warnings[0], /additional rollovers.*cannot be detected/);
  failure(() => calculate([sample(0, 1000), sample(60, 40)], { totalizerReset: 'rollover', rolloverValue: 1000 }, 'totalizerDelta'), 'INVALID_SOURCE_DATA');
});

test('unknown counter gaps, missing endpoints and boundary resets cannot be silently scaled', () => {
  const settings = { maxAgeMinutes: 15, minCoveragePercent: 0, gapPolicy: 'scale' };
  failure(() => calculate([sample(0, 0), sample(40, 40), sample(60, 60)], settings, 'totalizerDelta'), 'INCOMPLETE_TOTALIZER');
  failure(() => calculate([sample(0, 0), sample(55, 55)], { minCoveragePercent: 0, gapPolicy: 'scale' }, 'totalizerDelta'), 'INCOMPLETE_TOTALIZER');
  failure(() => calculate([sample(10, 10), sample(60, 60)], {}, 'totalizerDelta'), 'INCOMPLETE_TOTALIZER');
  failure(() => calculate([sample(-10, 100), sample(10, 10), sample(60, 60)], { totalizerReset: 'restart' }, 'totalizerDelta'), 'INCOMPLETE_TOTALIZER');
  failure(() => calculate([sample(0, 0), sample(30, 30, 'Bad'), sample(60, 60)], { qualityColumn: 'flag', badQualityPolicy: 'exclude', minCoveragePercent: 0, gapPolicy: 'scale' }, 'totalizerDelta'), 'INCOMPLETE_TOTALIZER');
});

test('good-quality invalid values never become zero or usable coverage', () => {
  for (const value of [null, '', ' ', 'NaN', 'Infinity', true, -1, {}, Infinity]) failure(() => calculate([sample(0, value)]), 'INVALID_SOURCE_DATA');
  failure(() => calculate([]), 'MISSING_SOURCE_DATA');
  failure(() => calculate([sample(0, 10, 'Bad')], { qualityColumn: 'flag', badQualityPolicy: 'exclude' }), 'MISSING_SOURCE_DATA');
});

test('ordinary aggregations keep half-open windows even with quality enabled', () => {
  failure(() => calculate([sample(-1, 10)], {}, 'latest'), 'INVALID_SOURCE_DATA');
  failure(() => calculate([sample(0, 10), sample(60, 20)], {}, 'sum'), 'INVALID_SOURCE_DATA');
});
