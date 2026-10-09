import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModel } from '../dist/model.js';
import {
  MAX_RUN_HISTORY, createCatalog, migrateLegacyModel, validateCatalog,
  addModel, updateModel, duplicateModel, removeModel, setActiveModel, getModelEntry,
  registerSource, removeSource, setSchedule, validateSchedule, frequencyToMinutes,
  dueSchedules, advanceSchedule, appendRun, timeToEpoch
} from '../dist/management-store.js';

const START = '2026-10-09T12:00:00.000Z';
const time = minutes => Date.parse(START) + minutes * 60_000;
const stamp = minutes => new Date(time(minutes)).toISOString();
const model = (name = 'Plant') => ({
  version: 1, name, periodHours: 1,
  nodes: [
    { id: 'in', kind: 'inlet', name: 'Feed', x: 0, y: 0 },
    { id: 'unit', kind: 'process', name: 'Unit', x: 100, y: 0 },
    { id: 'out', kind: 'outlet', name: 'Product', x: 200, y: 0 }
  ],
  streams: [
    { id: 'feed', source: 'in', target: 'unit', name: 'Feed', material: 'Water', phase: 'Liquid', density: 1000, measured: true, metric: 'mass', unit: 'kg', value: 100, uncertainty: 2, uncertaintyType: 'absolute' },
    { id: 'product', source: 'unit', target: 'out', name: 'Product', material: 'Water', phase: 'Liquid', density: 1000, measured: true, metric: 'mass', unit: 'kg', value: 98, uncertainty: 2, uncertaintyType: 'absolute' }
  ]
});
const catalog = () => createCatalog(model(), { id: 'plant-a', now: START });
const twoModels = () => addModel(catalog(), model('Other plant'), { id: 'plant-b', now: START });
const run = (id = 'run-1', extra = {}) => ({ id, startedAt: START, finishedAt: stamp(1), status: 'ok', result: { status: 'ok', streams: [{ id: 'feed', value: 99 }] }, ...extra });

test('legacy migration preserves model IDs/data and starts with scheduling disabled', () => {
  const legacy = model(), result = migrateLegacyModel(legacy, { id: 'plant-a', now: START });
  assert.deepEqual(result.models, [{ id: 'plant-a', model: legacy, updatedAt: START }]);
  assert.equal(result.activeId, 'plant-a');
  assert.deepEqual(result.schedules['plant-a'], { enabled: false, intervalMinutes: 60, inputSourceId: null, outputSourceId: null, nextRunAt: null });
  assert.deepEqual(result.sources['plant-a'], []);
  assert.deepEqual(result.runs['plant-a'], []);
  legacy.name = 'Changed outside the catalog';
  assert.equal(result.models[0].model.name, 'Plant');
  assert.deepEqual(validateCatalog(JSON.parse(JSON.stringify(result))), result);
});

test('adding/updating/activating models keeps entries and reused stream IDs isolated', () => {
  const original = twoModels(), changed = model('Updated first plant');
  changed.streams[0].value = 7;
  const updated = updateModel(original, 'plant-a', changed, time(5));
  assert.equal(updated.models[0].updatedAt, stamp(5));
  assert.equal(getModelEntry(updated, 'plant-a').model.streams[0].value, 7);
  assert.equal(getModelEntry(updated, 'plant-b').model.streams[0].value, 100);
  assert.equal(original.models[0].model.streams[0].value, 100);
  assert.equal(updated.activeId, 'plant-b');
  assert.equal(setActiveModel(updated, 'plant-a').activeId, 'plant-a');
  assert.throws(() => setActiveModel(updated, 'feed'), /does not exist/);
  assert.throws(() => addModel(updated, model(), { id: 'plant-a', now: START }), /already exists/);
});

test('duplicating a model starts with fresh disabled scheduling, sources and history', () => {
  let original = registerSource(catalog(), 'plant-a', { id: 'meter-readings', name: 'Readings', direction: 'input', data: [{ streamId: 'feed', value: 101 }] });
  original = setSchedule(original, 'plant-a', { enabled: true, inputSourceId: 'meter-readings' }, START);
  original = appendRun(original, 'plant-a', run());
  const result = duplicateModel(original, 'plant-a', { id: 'plant-copy', now: time(10) });
  assert.equal(result.activeId, 'plant-copy');
  assert.equal(result.models[1].model.name, 'Plant (copy)');
  assert.deepEqual(result.models[1].model.streams, original.models[0].model.streams);
  assert.equal(result.schedules['plant-copy'].enabled, false);
  assert.deepEqual(result.sources['plant-copy'], []);
  assert.deepEqual(result.runs['plant-copy'], []);
});

test('deleting a model removes only its management data and selects a remaining model', () => {
  const original = appendRun(twoModels(), 'plant-b', run());
  const result = removeModel(original, 'plant-b');
  assert.equal(result.activeId, 'plant-a');
  for (const key of ['schedules', 'sources', 'runs']) assert.equal(Object.hasOwn(result[key], 'plant-b'), false);
  assert.deepEqual(result.models[0], original.models[0]);
  const empty = removeModel(result, 'plant-a');
  assert.equal(empty.activeId, null);
  assert.deepEqual(validateCatalog(empty), empty);
});

test('draft negative/nonnumeric measurements and incomplete uncertainties remain editable', () => {
  for (const value of [-5, 'bad reading', '']) {
    for (const uncertainty of ['', 0, -2, 'unfinished']) {
      const draft = model();
      Object.assign(draft.streams[0], { value, uncertainty });
      const result = updateModel(catalog(), 'plant-a', draft, START);
      assert.equal(result.models[0].model.streams[0].value, value);
      assert.equal(result.models[0].model.streams[0].uncertainty, uncertainty);
      assert.deepEqual(validateCatalog(result), result);
      assert.throws(() => validateModel(result.models[0].model));
    }
  }
});

test('malformed model topology/settings and non-JSON values are rejected without mutation', () => {
  const invalids = [
    { ...model(), version: 2 },
    { ...model(), periodHours: 0 },
    { ...model(), streams: [{ ...model().streams[0], target: 'unknown' }] },
    { ...model(), streams: [{ ...model().streams[0], measured: 'yes' }] },
    { ...model(), streams: [{ ...model().streams[0], value: { value: 5 } }] },
    { ...model(), streams: [{ ...model().streams[0], uncertaintyType: 'custom' }] },
    { ...model(), streams: [{ ...model().streams[0], density: -1 }] },
    { ...model(), streams: [{ ...model().streams[0], value: NaN }] }
  ];
  const original = catalog();
  for (const invalid of invalids) {
    assert.throws(() => createCatalog(invalid, { id: 'invalid-model', now: START }));
    assert.throws(() => updateModel(original, 'plant-a', invalid, START));
  }
  assert.equal(original.models[0].model.streams[0].value, 100);
});

test('frequency conversion permits minutes/hours/days but never sub-minute or nonnumeric intervals', () => {
  assert.equal(frequencyToMinutes(1), 1);
  assert.equal(frequencyToMinutes(1.5, 'hours'), 90);
  assert.equal(frequencyToMinutes(2, 'days'), 2880);
  assert.equal(frequencyToMinutes(1.5), 1.5);
  for (const [value, unit] of [[0, 'minutes'], [-1, 'hours'], [0.5, 'minutes'], ['1', 'minutes'], [Infinity, 'days'], [1, 'months']]) assert.throws(() => frequencyToMinutes(value, unit));
});

test('schedules use explicit clocks, null saved-model/store-result sources and future first runs', () => {
  const original = catalog(), enabled = setSchedule(original, 'plant-a', { enabled: true, intervalMinutes: 5 }, START);
  assert.equal(enabled.schedules['plant-a'].nextRunAt, stamp(5));
  assert.equal(enabled.schedules['plant-a'].inputSourceId, null);
  assert.equal(enabled.schedules['plant-a'].outputSourceId, null);
  assert.equal(original.schedules['plant-a'].enabled, false);
  assert.deepEqual(dueSchedules(enabled, time(4)), []);
  assert.deepEqual(dueSchedules(enabled, time(5)), [{ modelId: 'plant-a', scheduledAt: stamp(5), inputSourceId: null, outputSourceId: null }]);
});

test('elapsed cadence skips missed periods once, including browser suspension and exact boundaries', () => {
  const enabled = setSchedule(catalog(), 'plant-a', { enabled: true, intervalMinutes: 5 }, START);
  assert.equal(dueSchedules(enabled, time(502)).length, 1);
  const claimed = advanceSchedule(enabled, 'plant-a', time(502));
  assert.equal(claimed.schedules['plant-a'].nextRunAt, stamp(505));
  assert.deepEqual(dueSchedules(claimed, time(502)), []);
  assert.deepEqual(advanceSchedule(claimed, 'plant-a', time(502)), claimed);
  assert.equal(advanceSchedule(enabled, 'plant-a', time(5)).schedules['plant-a'].nextRunAt, stamp(10));
  assert.equal(advanceSchedule(enabled, 'plant-a', time(15)).schedules['plant-a'].nextRunAt, stamp(20));
  assert.equal(enabled.schedules['plant-a'].nextRunAt, stamp(5));
});

test('long execution advances again to a future cadence without an immediate catch-up storm', () => {
  const enabled = setSchedule(catalog(), 'plant-a', { enabled: true, intervalMinutes: 5 }, START);
  const claimed = advanceSchedule(enabled, 'plant-a', time(5));
  const completed = advanceSchedule(claimed, 'plant-a', time(23));
  assert.equal(completed.schedules['plant-a'].nextRunAt, stamp(25));
  assert.deepEqual(dueSchedules(completed, time(23)), []);
});

test('interval edits reset cadence, source edits keep cadence, disabling clears future execution', () => {
  const enabled = setSchedule(catalog(), 'plant-a', { enabled: true, intervalMinutes: 5 }, START);
  const unchanged = setSchedule(enabled, 'plant-a', { inputSourceId: null }, time(2));
  assert.equal(unchanged.schedules['plant-a'].nextRunAt, stamp(5));
  const changed = setSchedule(unchanged, 'plant-a', { intervalMinutes: 10 }, time(2));
  assert.equal(changed.schedules['plant-a'].nextRunAt, stamp(12));
  const disabled = setSchedule(changed, 'plant-a', { enabled: false }, time(3));
  assert.equal(disabled.schedules['plant-a'].nextRunAt, null);
  assert.deepEqual(dueSchedules(disabled, time(1000)), []);
  assert.equal(setSchedule(disabled, 'plant-a', { enabled: true }, time(20)).schedules['plant-a'].nextRunAt, stamp(30));
});

test('UTC/offset timestamps express the same instant, and DST does not change elapsed cadence', () => {
  assert.equal(timeToEpoch('2026-11-01T01:30:00-04:00'), timeToEpoch('2026-11-01T05:30:00Z'));
  const enabled = setSchedule(catalog(), 'plant-a', { enabled: true, intervalMinutes: 60, nextRunAt: '2026-11-01T01:30:00-04:00' }, START);
  const next = advanceSchedule(enabled, 'plant-a', '2026-11-01T01:30:00-04:00');
  assert.equal(next.schedules['plant-a'].nextRunAt, '2026-11-01T06:30:00.000Z');
  assert.equal(dueSchedules(next, '2026-11-01T01:30:00-05:00').length, 1);
  assert.equal(dueSchedules(next, '2026-11-01T01:29:59-05:00').length, 0);
});

test('local/invalid timestamps and invalid schedule fields cannot enable execution', () => {
  for (const value of ['2026-10-09', '2026-10-09T12:00:00', '2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', 'nonsense', NaN, null, 253_402_300_800_000]) assert.throws(() => timeToEpoch(value));
  for (const changes of [{ enabled: 'yes' }, { intervalMinutes: 0 }, { intervalMinutes: '5' }, { nextRunAt: '2026-10-09T12:00:00' }, { connector: 'invented' }]) assert.throws(() => setSchedule(catalog(), 'plant-a', { enabled: true, ...changes }, START));
  assert.throws(() => validateSchedule({ enabled: true, intervalMinutes: 1, inputSourceId: null, outputSourceId: null, nextRunAt: null }), /next run timestamp/);
  assert.throws(() => setSchedule(catalog(), 'plant-a', { enabled: true }, undefined), /timestamp/);
});

test('source IDs are scoped to the model and must support the requested direction', () => {
  let original = registerSource(twoModels(), 'plant-a', { id: 'readings', name: 'Imported readings', direction: 'input', data: { feed: 12 } });
  original = registerSource(original, 'plant-a', { id: 'results', name: 'Result destination', direction: 'output' });
  const enabled = setSchedule(original, 'plant-a', { enabled: true, inputSourceId: 'readings', outputSourceId: 'results' }, START);
  assert.equal(enabled.schedules['plant-a'].inputSourceId, 'readings');
  assert.throws(() => setSchedule(original, 'plant-b', { inputSourceId: 'readings' }, START), /registered input source/);
  assert.throws(() => setSchedule(original, 'plant-a', { inputSourceId: 'results' }, START), /registered input source/);
  assert.throws(() => setSchedule(original, 'plant-a', { outputSourceId: 'readings' }, START), /registered output source/);
  assert.throws(() => setSchedule(original, 'plant-a', { inputSourceId: 'invented-connector' }, START), /registered input source/);
  assert.throws(() => registerSource(original, 'plant-a', { id: 'readings', name: 'Duplicate', direction: 'both' }), /already registered/);
});

test('removing a referenced source disables scheduling while preserving historical provenance', () => {
  let original = registerSource(twoModels(), 'plant-a', { id: 'readings', name: 'Imported readings', direction: 'both' });
  original = setSchedule(original, 'plant-a', { enabled: true, inputSourceId: 'readings', outputSourceId: 'readings' }, START);
  original = setSchedule(original, 'plant-b', { enabled: true }, START);
  original = appendRun(original, 'plant-a', run('run-1', { inputSourceId: 'readings' }));
  const result = removeSource(original, 'plant-a', 'readings');
  assert.equal(result.schedules['plant-a'].enabled, false);
  assert.equal(result.schedules['plant-a'].nextRunAt, null);
  assert.equal(result.schedules['plant-a'].inputSourceId, null);
  assert.equal(result.schedules['plant-a'].outputSourceId, null);
  assert.deepEqual(result.schedules['plant-b'], original.schedules['plant-b']);
  assert.equal(result.runs['plant-a'][0].inputSourceId, 'readings');
  assert.deepEqual(validateCatalog(result), result);
  assert.throws(() => appendRun(result, 'plant-a', run('run-2', { inputSourceId: 'readings' })), /registered input source/);
});

test('removing an unrelated source leaves an enabled schedule unchanged', () => {
  const original = setSchedule(registerSource(catalog(), 'plant-a', { id: 'unused', name: 'Unused source', direction: 'input' }), 'plant-a', { enabled: true }, START);
  assert.deepEqual(removeSource(original, 'plant-a', 'unused').schedules, original.schedules);
});

test('catalog loading rejects orphaned/duplicate IDs and missing or stale source references', () => {
  const duplicate = catalog(); duplicate.models.push({ ...duplicate.models[0] });
  assert.throws(() => validateCatalog(duplicate), /unique/);
  const orphan = catalog(); orphan.schedules.orphan = { ...orphan.schedules['plant-a'] };
  assert.throws(() => validateCatalog(orphan), /unknown model/);
  const missing = catalog(); delete missing.sources['plant-a'];
  assert.throws(() => validateCatalog(missing), /source registry/);
  const stale = catalog(); stale.schedules['plant-a'].inputSourceId = 'removed';
  assert.throws(() => validateCatalog(stale), /registered input source/);
  const unknownActive = catalog(); unknownActive.activeId = 'unknown';
  assert.throws(() => validateCatalog(unknownActive), /active model/);
  for (const id of ['__proto__', 'constructor', 'prototype', '', 'plant/path']) assert.throws(() => addModel(catalog(), model(), { id, now: START }), /safe identifier/);
  assert.equal({}.polluted, undefined);
});

test('bounded run history preserves snapshots, chronological metadata and per-model isolation', () => {
  let original = twoModels();
  const snapshot = model('Run snapshot');
  original = appendRun(original, 'plant-b', run('other-run'));
  for (let index = 0; index < MAX_RUN_HISTORY + 3; index++) original = appendRun(original, 'plant-a', run(`run-${index}`, { modelSnapshot: snapshot, modelUpdatedAt: START, startedAt: time(index), finishedAt: time(index + 1), trigger: 'scheduled' }));
  assert.equal(original.runs['plant-a'].length, MAX_RUN_HISTORY);
  assert.equal(original.runs['plant-a'][0].id, 'run-3');
  assert.equal(original.runs['plant-a'].at(-1).modelId, 'plant-a');
  assert.equal(original.runs['plant-b'].length, 1);
  snapshot.name = 'Changed externally';
  assert.equal(original.runs['plant-a'][0].modelSnapshot.name, 'Run snapshot');
  const limited = appendRun(original, 'plant-a', run('last-run'), { limit: 20 });
  assert.equal(limited.runs['plant-a'].length, 20);
  assert.equal(original.runs['plant-a'].length, MAX_RUN_HISTORY);
  assert.throws(() => appendRun(limited, 'plant-a', run('last-run')), /already exists/);
  assert.throws(() => appendRun(limited, 'plant-a', run('invalid-time', { finishedAt: time(-1) })), /before it starts/);
  assert.throws(() => appendRun(limited, 'plant-a', run('wrong-model', { modelId: 'plant-b' })), /different model/);
  assert.throws(() => appendRun(limited, 'plant-a', run('oversize'), { limit: MAX_RUN_HISTORY + 1 }), /History limit/);
});
