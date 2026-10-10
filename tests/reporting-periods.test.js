import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultReportingSettings, validateReportingSettings, resolveReportingPeriod, recentReportingPeriods, formatReportingPeriod } from '../public/reporting-periods.js';

const model = { periodHours: 1 };
const settings = (changes = {}) => ({ ...defaultReportingSettings(model, 'America/Toronto'), ...changes });
const bounds = period => [period.start, period.end, period.periodHours];

test('reporting defaults derive from model duration and accept configurable plant settings', () => {
  assert.equal(defaultReportingSettings(model).kind, 'hour');
  assert.equal(defaultReportingSettings({ periodHours: 24 }).kind, 'day');
  assert.equal(defaultReportingSettings({ periodHours: 6 }).kind, 'batch');
  assert.equal(defaultReportingSettings({ periodHours: 6 }).batchHours, 6);
  assert.deepEqual(validateReportingSettings({ kind: 'shift', timeZone: 'America/Toronto', dayStart: '07:00', shiftStart: '07:00', shiftHours: 12, batchHours: 2.5, settlingMinutes: 15 }), {
    kind: 'shift', timeZone: 'America/Toronto', dayStart: '07:00', shiftStart: '07:00', shiftHours: 12, batchHours: 2.5, settlingMinutes: 15
  });
});

test('a run at 10:07 selects the completed 09:00–10:00 local hour', () => {
  const period = resolveReportingPeriod(settings(), model, '2026-10-10T14:07:00Z');
  assert.deepEqual(bounds(period), ['2026-10-10T13:00:00.000Z', '2026-10-10T14:00:00.000Z', 1]);
  assert.equal(period.readyAt, period.end);
  assert.equal(period.timeZone, 'America/Toronto');
  assert.match(period.label, /Hour:.*09:00.*10:00.*America\/Toronto/);
  assert.equal(period.label, formatReportingPeriod(period));
});

test('the late-data allowance holds back an otherwise completed hour until it is ready', () => {
  const config = settings({ settlingMinutes: 15 });
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-10-10T14:07:00Z')), ['2026-10-10T12:00:00.000Z', '2026-10-10T13:00:00.000Z', 1]);
  const ready = resolveReportingPeriod(config, model, '2026-10-10T14:15:00Z');
  assert.equal(ready.end, '2026-10-10T14:00:00.000Z');
  assert.equal(ready.readyAt, '2026-10-10T14:15:00.000Z');
  assert.throws(() => resolveReportingPeriod(config, model, '2026-10-10T14:07:00Z', { start: '2026-10-10T13:00:00Z', end: '2026-10-10T14:00:00Z' }), /late-data allowance/);
});

test('calendar days preserve 23 and 25 actual hours across daylight saving changes', () => {
  const config = settings({ kind: 'day' });
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-03-09T14:00:00Z')), ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23]);
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-11-02T15:00:00Z')), ['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25]);
});

test('both occurrences of the repeated local hour are distinct completed periods', () => {
  const first = resolveReportingPeriod(settings(), model, '2026-11-01T06:30:00Z');
  const second = resolveReportingPeriod(settings(), model, '2026-11-01T07:07:00Z');
  assert.deepEqual(bounds(first), ['2026-11-01T05:00:00.000Z', '2026-11-01T06:00:00.000Z', 1]);
  assert.deepEqual(bounds(second), ['2026-11-01T06:00:00.000Z', '2026-11-01T07:00:00.000Z', 1]);
  assert.match(first.label, /GMT-4.*GMT-5/);
  const recent = recentReportingPeriods(settings(), model, '2026-11-01T07:07:00Z', 3);
  assert.deepEqual(recent.map(item => item.start), ['2026-11-01T06:00:00.000Z', '2026-11-01T05:00:00.000Z', '2026-11-01T04:00:00.000Z']);
  for (let index = 1; index < recent.length; index++) assert.equal(recent[index].end, recent[index - 1].start);
});

test('spring-forward hours neither invent a nonexistent hour nor leave a UTC gap', () => {
  assert.deepEqual(bounds(resolveReportingPeriod(settings(), model, '2026-03-08T07:07:00Z')), ['2026-03-08T06:00:00.000Z', '2026-03-08T07:00:00.000Z', 1]);
  assert.deepEqual(bounds(resolveReportingPeriod(settings(), model, '2026-03-08T08:07:00Z')), ['2026-03-08T07:00:00.000Z', '2026-03-08T08:00:00.000Z', 1]);
});

test('default shifts start at 06:00 and use the actual elapsed duration at DST transitions', () => {
  const config = settings({ kind: 'shift' });
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-10-10T18:07:00Z')), ['2026-10-10T10:00:00.000Z', '2026-10-10T18:00:00.000Z', 8]);
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-03-08T10:07:00Z')), ['2026-03-08T03:00:00.000Z', '2026-03-08T10:00:00.000Z', 7]);
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-11-01T11:07:00Z')), ['2026-11-01T02:00:00.000Z', '2026-11-01T11:00:00.000Z', 9]);
  assert.deepEqual(bounds(resolveReportingPeriod(settings({ kind: 'shift', shiftStart: '07:30', shiftHours: 12 }), model, '2026-10-10T23:31:00Z')), ['2026-10-10T11:30:00.000Z', '2026-10-10T23:30:00.000Z', 12]);
});

test('reporting day cutoff is configurable and ambiguous/nonexistent cutoffs resolve deterministically', () => {
  assert.deepEqual(bounds(resolveReportingPeriod(settings({ kind: 'day', dayStart: '06:00' }), model, '2026-10-10T12:00:00Z')), ['2026-10-09T10:00:00.000Z', '2026-10-10T10:00:00.000Z', 24]);
  // Repeated 01:30 chooses its first occurrence on the transition day.
  assert.deepEqual(bounds(resolveReportingPeriod(settings({ kind: 'day', dayStart: '01:30' }), model, '2026-11-02T07:00:00Z')), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', 25]);
  // Nonexistent 02:30 advances one hour to 03:30, preserving clock minutes.
  assert.deepEqual(bounds(resolveReportingPeriod(settings({ kind: 'day', dayStart: '02:30' }), model, '2026-03-09T07:00:00Z')), ['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z', 23]);
});

test('hour boundaries also work in zones with quarter-hour offsets and half-hour DST', () => {
  assert.deepEqual(bounds(resolveReportingPeriod(settings({ timeZone: 'Asia/Kathmandu' }), model, '2026-10-10T04:22:00Z')), ['2026-10-10T03:15:00.000Z', '2026-10-10T04:15:00.000Z', 1]);
  assert.deepEqual(bounds(resolveReportingPeriod(settings({ timeZone: 'Australia/Lord_Howe' }), model, '2026-10-03T16:07:00Z')), ['2026-10-03T15:30:00.000Z', '2026-10-03T16:00:00.000Z', 0.5]);
});

test('historical calendar selections rerun exactly the same completed interval', () => {
  const selected = { start: '2026-10-01T09:00:00-04:00', end: '2026-10-01T10:00:00-04:00' };
  const period = resolveReportingPeriod(settings(), model, '2026-10-10T14:07:00Z', selected);
  assert.deepEqual(bounds(period), ['2026-10-01T13:00:00.000Z', '2026-10-01T14:00:00.000Z', 1]);
  assert.deepEqual(bounds(resolveReportingPeriod(settings(), model, '2026-10-10T18:00:00Z', { kind: 'day', start: '2026-10-09T04:00:00Z', end: '2026-10-10T04:00:00Z' })), ['2026-10-09T04:00:00.000Z', '2026-10-10T04:00:00.000Z', 24]);
  for (const invalid of [
    { start: '2026-10-01T13:07:00Z', end: '2026-10-01T14:07:00Z' },
    { start: '2026-10-01T13:00:00Z', end: '2026-10-01T15:00:00Z' },
    { start: '2026-10-10T14:00:00Z', end: '2026-10-10T15:00:00Z' },
    { start: '2026-10-01T13:00:00', end: '2026-10-01T14:00:00Z' }
  ]) assert.throws(() => resolveReportingPeriod(settings(), model, '2026-10-10T14:07:00Z', invalid), /aligned|completed|time zone/);
});

test('recurring batches have deterministic fixed boundaries while custom completed batches need no alignment', () => {
  const config = settings({ kind: 'batch', timeZone: 'UTC', batchHours: 6 });
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-10-10T10:07:00Z')), ['2026-10-10T00:00:00.000Z', '2026-10-10T06:00:00.000Z', 6]);
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-10-10T10:55:00Z')), ['2026-10-10T00:00:00.000Z', '2026-10-10T06:00:00.000Z', 6]);
  assert.deepEqual(bounds(resolveReportingPeriod(config, model, '2026-10-10T10:07:00Z', { start: '2026-10-09T08:05:00Z', end: '2026-10-09T11:35:00Z' })), ['2026-10-09T08:05:00.000Z', '2026-10-09T11:35:00.000Z', 3.5]);
  const recent = recentReportingPeriods(config, model, '2026-10-10T10:07:00Z', 4);
  assert.equal(recent[0].end, '2026-10-10T06:00:00.000Z');
  assert.equal(recent[3].start, '2026-10-09T06:00:00.000Z');
});

test('malformed settings and incomplete or oversized periods are rejected', () => {
  for (const changes of [{ kind: 'rolling' }, { timeZone: 'Not/AZone' }, { dayStart: '24:00' }, { shiftStart: '6:00' }, { shiftHours: 7 }, { shiftHours: 0 }, { batchHours: 0 }, { batchHours: 8785 }, { settlingMinutes: -1 }, { settlingMinutes: 0.5 }, { settlingMinutes: 10081 }, { unexpected: true }]) assert.throws(() => validateReportingSettings(settings(changes)));
  const config = settings({ kind: 'batch' });
  for (const selection of [{}, { start: '2026-10-01T12:00:00Z', end: '2026-10-01T12:00:00Z' }, { start: '2025-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' }, { start: '2026-02-30T00:00:00Z', end: '2026-03-01T00:00:00Z' }, { kind: 'unsupported', start: '2026-10-01T12:00:00Z', end: '2026-10-01T13:00:00Z' }, { start: '2026-10-01T12:00:00Z', end: '2026-10-01T13:00:00Z', arbitrary: true }]) assert.throws(() => resolveReportingPeriod(config, model, '2026-10-10T14:07:00Z', selection));
  for (const limit of [0, 101, 1.5]) assert.throws(() => recentReportingPeriods(config, model, Date.now(), limit));
});
