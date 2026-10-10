import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleModel } from '../public/model.js';
import { createCatalog, addModel, appendRun, registerSource, setSchedule, updateModel } from '../public/management-store.js';
import { executeModelRun, sameRunInputs } from '../public/schedule-runner.js';

const start = Date.parse('2026-10-09T12:00:00.000Z');
const clone = value => structuredClone(value);
const clock = () => { let time = start; return () => time++; };
const options = (extra = {}) => ({ id: 'run-1', now: clock(), ...extra });
const catalog = () => createCatalog(exampleModel(), { id: 'model-a', now: start });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const reading = (model, id) => model.streams.find(stream => stream.id === id);
const flow = (run, id) => run.result.streams.find(stream => stream.id === id);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

function withSources() {
  let value = registerSource(catalog(), 'model-a', { id: 'readings', name: 'Test readings', direction: 'input', type: 'test-input' });
  value = registerSource(value, 'model-a', { id: 'report', name: 'Test report', direction: 'output', type: 'test-output' });
  return setSchedule(value, 'model-a', { inputSourceId: 'readings', outputSourceId: 'report' }, start);
}

function virtualModel() {
  const model = exampleModel();
  reading(model, 'f1').meterName = 'Feed meter';
  Object.assign(reading(model, 'f2'), { measured: true, meterType: 'virtual', meterName: 'Internal meter', formula: '[Feed meter]', value: 9999, uncertainty: 1, uncertaintyType: 'absolute' });
  Object.assign(reading(model, 'f3'), { meterType: 'virtual', meterName: 'Product meter', formula: '[Internal meter] * 0.6', value: -9999 });
  Object.assign(reading(model, 'f4'), { meterType: 'virtual', formula: '[Internal meter] - [Product meter]', value: '' });
  return model;
}

test('manual saved-measurement run preserves the analytical example and can be appended by the host', async () => {
  const saved = catalog(), before = clone(saved);
  const response = await executeModelRun(saved, 'model-a', options());
  assert.deepEqual(Object.keys(response), ['run']);
  const { run } = response;
  assert.equal(run.id, 'run-1');
  assert.equal(run.modelId, 'model-a');
  assert.equal(run.modelName, before.models[0].model.name);
  assert.equal(run.modelUpdatedAt, before.models[0].updatedAt);
  assert.equal(run.trigger, 'manual');
  assert.equal(run.startedAt, '2026-10-09T12:00:00.000Z');
  assert.equal(run.finishedAt, '2026-10-09T12:00:00.001Z');
  assert.equal(run.inputSourceId, null);
  assert.equal(run.outputSourceId, null);
  assert.equal(run.error, null);
  assert.equal(run.status, 'ok');
  near(flow(run, 'f1').value, 99.4444444444);
  near(flow(run, 'f2').value, 99.4444444444);
  near(flow(run, 'f3').value, 62.2222222222);
  near(flow(run, 'f4').value, 37.2222222222);
  assert.deepEqual(run.modelSnapshot, before.models[0].model);
  assert.deepEqual(saved, before);
  assert.equal(appendRun(saved, 'model-a', run).runs['model-a'].length, 1);
});

test('scheduled execution of A leaves B, active selection, schedules, and original catalog unchanged', async () => {
  let saved = addModel(catalog(), { ...exampleModel(), name: 'Model B' }, { id: 'model-b', now: start });
  saved = setSchedule(saved, 'model-a', { enabled: true, intervalMinutes: 1 }, start);
  const before = clone(saved);
  freeze(saved);
  const { run } = await executeModelRun(saved, 'model-a', options({ trigger: 'scheduled' }));
  assert.equal(run.trigger, 'scheduled');
  assert.equal(run.modelId, 'model-a');
  assert.equal(saved.activeId, 'model-b');
  assert.deepEqual(saved, before);
  reading(run.modelSnapshot, 'f1').value = 999;
  assert.equal(reading(saved.models[0].model, 'f1').value, 100);
});

test('registered asynchronous input and output adapters receive detached data and the actual run snapshot', async () => {
  const saved = withSources(), before = clone(saved), calls = [];
  let inputResult;
  const { run } = await executeModelRun(saved, 'model-a', options({
    trigger: 'scheduled',
    inputAdapters: { 'test-input': async (source, model, context) => {
      calls.push('input');
      assert.deepEqual(context, { modelId: 'model-a' });
      assert.equal(source.id, 'readings');
      source.name = 'Adapter changed source';
      reading(model, 'f1').value = 120;
      inputResult = model;
      return model;
    } },
    outputAdapters: { 'test-output': async (source, output, context) => {
      calls.push('output');
      assert.deepEqual(context, { modelId: 'model-a' });
      assert.equal(source.id, 'report');
      assert.equal(reading(output.modelSnapshot, 'f1').value, 120);
      near(flow(output, 'f1').value, 117.2222222222);
      source.name = 'Adapter changed report';
      output.result.streams[0].value = 999;
      output.modelSnapshot.name = 'Adapter changed model';
      output.status = 'failed';
    } }
  }));
  assert.deepEqual(calls, ['input', 'output']);
  assert.equal(run.status, 'warning');
  assert.equal(run.error, null);
  assert.equal(reading(run.modelSnapshot, 'f1').value, 120);
  near(flow(run, 'f1').value, 117.2222222222);
  assert.equal(run.finishedAt, '2026-10-09T12:00:00.002Z');
  assert.deepEqual(saved, before);
  reading(inputResult, 'f1').value = 777;
  assert.equal(reading(run.modelSnapshot, 'f1').value, 120);
});

test('manual runs honor optional configured sources even when their schedule is disabled', async () => {
  const saved = withSources();
  let outputs = 0;
  const { run } = await executeModelRun(saved, 'model-a', options({
    inputAdapters: { 'test-input': async (_source, model) => model },
    outputAdapters: { 'test-output': async () => { outputs++; } }
  }));
  assert.equal(saved.schedules['model-a'].enabled, false);
  assert.equal(run.trigger, 'manual');
  assert.equal(run.inputSourceId, 'readings');
  assert.equal(run.outputSourceId, 'report');
  assert.equal(outputs, 1);
});

test('adapterKey and adapter fields select explicitly registered handlers', async () => {
  for (const field of ['adapterKey', 'adapter']) {
    let saved = registerSource(catalog(), 'model-a', { id: 'custom', name: 'Custom input', direction: 'input', type: 'unused-type', [field]: 'custom-handler' });
    saved = setSchedule(saved, 'model-a', { inputSourceId: 'custom' }, start);
    let calls = 0;
    const { run } = await executeModelRun(saved, 'model-a', options({ inputAdapters: { 'custom-handler': (_source, model) => { calls++; return model; } } }));
    assert.equal(calls, 1);
    assert.equal(run.status, 'ok');
  }
});

test('missing and inherited input handlers become failed records without running or delivering results', async () => {
  for (const type of ['test-input', 'toString']) {
    let saved = registerSource(catalog(), 'model-a', { id: 'readings', name: 'Unavailable input', direction: 'input', type });
    saved = registerSource(saved, 'model-a', { id: 'report', name: 'Report', direction: 'output', type: 'test-output' });
    saved = setSchedule(saved, 'model-a', { inputSourceId: 'readings', outputSourceId: 'report' }, start);
    let outputs = 0;
    const { run } = await executeModelRun(saved, 'model-a', options({ outputAdapters: { 'test-output': () => { outputs++; } } }));
    assert.equal(run.status, 'failed');
    assert.equal(run.result, null);
    assert.match(run.error, /Input failed: No registered input handler/);
    assert.equal(outputs, 0);
    assert.equal(appendRun(saved, 'model-a', run).runs['model-a'][0].status, 'failed');
  }
});

test('input adapter exceptions or invalid returned models are recorded as failures', async () => {
  const saved = withSources(), before = clone(saved);
  for (const handler of [async () => { throw new Error('Read unavailable'); }, async () => ({ version: 99 })]) {
    const { run } = await executeModelRun(saved, 'model-a', options({ inputAdapters: { 'test-input': handler } }));
    assert.equal(run.status, 'failed');
    assert.equal(run.result, null);
    assert.match(run.error, /^Input failed:/);
    assert.equal(reading(run.modelSnapshot, 'f1').value, 100);
  }
  assert.deepEqual(saved, before);
});

test('invalid solver results preserve raw inputs and are withheld from output adapters', async () => {
  let saved = withSources();
  const draft = clone(saved.models[0].model);
  reading(draft, 'f1').value = '';
  saved = updateModel(saved, 'model-a', draft, start + 1);
  let outputs = 0;
  const { run } = await executeModelRun(saved, 'model-a', options({
    inputAdapters: { 'test-input': (_source, model) => model },
    outputAdapters: { 'test-output': () => { outputs++; } }
  }));
  assert.equal(run.status, 'invalid');
  assert.equal(run.result.status, 'invalid');
  assert.match(run.error, /nonnegative (?:physical meter reading|measurement)/);
  assert.equal(reading(run.modelSnapshot, 'f1').value, '');
  assert.equal(outputs, 0);
  assert.equal(appendRun(saved, 'model-a', run).runs['model-a'][0].status, 'invalid');
});

test('unsupported output or delivery exceptions retain solver results in a failed run record', async () => {
  const saved = withSources(), before = clone(saved);
  for (const outputAdapters of [{}, { 'test-output': async () => { throw new Error('Delivery unavailable'); } }]) {
    const { run } = await executeModelRun(saved, 'model-a', options({
      inputAdapters: { 'test-input': (_source, model) => model }, outputAdapters
    }));
    assert.equal(run.status, 'failed');
    assert.equal(run.result.status, 'ok');
    near(flow(run, 'f1').value, 99.4444444444);
    assert.match(run.error, /^Output failed:/);
    assert.equal(appendRun(saved, 'model-a', run).runs['model-a'][0].status, 'failed');
  }
  assert.deepEqual(saved, before);
});

test('host can append a delayed run to its latest catalog without overwriting later edits', async () => {
  const saved = withSources();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const execution = executeModelRun(saved, 'model-a', options({
    inputAdapters: { 'test-input': async (_source, model) => { await waiting; return model; } },
    outputAdapters: { 'test-output': () => {} }
  }));
  const changed = clone(saved.models[0].model);
  reading(changed, 'f1').value = 150;
  const latest = updateModel(saved, 'model-a', changed, start + 10);
  release();
  const { run } = await execution;
  const appended = appendRun(latest, 'model-a', run);
  assert.equal(reading(appended.models[0].model, 'f1').value, 150);
  assert.equal(reading(run.modelSnapshot, 'f1').value, 100);
  assert.equal(run.modelUpdatedAt, saved.models[0].updatedAt);
  assert.notEqual(run.modelUpdatedAt, appended.models[0].updatedAt);
});

test('unknown models and invalid execution options reject before running adapters', async () => {
  const saved = catalog();
  await assert.rejects(executeModelRun(saved, 'missing', options()), /model does not exist/);
  await assert.rejects(executeModelRun(saved, 'model-a', options({ trigger: 'other' })), /trigger/);
  await assert.rejects(executeModelRun(saved, 'model-a', options({ id: '__proto__' })), /safe run ID/);
  await assert.rejects(executeModelRun(saved, 'model-a', options({ now: start })), /clock must be a function/);
});

test('virtual readings are computed after input adapters and audit snapshots retain formulas without editing the saved model', async () => {
  const model = virtualModel();
  let saved = createCatalog(model, { id: 'model-a', now: start });
  saved = registerSource(saved, 'model-a', { id: 'readings', name: 'Test readings', direction: 'input', type: 'test-input' });
  saved = registerSource(saved, 'model-a', { id: 'report', name: 'Test report', direction: 'output', type: 'test-output' });
  saved = setSchedule(saved, 'model-a', { enabled: true, intervalMinutes: 1, inputSourceId: 'readings', outputSourceId: 'report' }, start);
  const before = clone(saved);
  let outputSnapshot;
  const { run } = await executeModelRun(freeze(saved), 'model-a', options({
    trigger: 'scheduled',
    inputAdapters: { 'test-input': (_source, snapshot) => { reading(snapshot, 'f1').value = 120; return snapshot; } },
    outputAdapters: { 'test-output': (_source, output) => { outputSnapshot = output.modelSnapshot; } }
  }));
  assert.equal(run.status, 'warning', run.error);
  assert.equal(reading(run.modelSnapshot, 'f2').value, 120);
  assert.equal(reading(run.modelSnapshot, 'f3').value, 72);
  assert.equal(reading(run.modelSnapshot, 'f4').value, 48);
  for (const id of ['f2', 'f3', 'f4']) assert.equal(reading(run.modelSnapshot, id).formula, reading(model, id).formula);
  assert.deepEqual(outputSnapshot, run.modelSnapshot);
  near(flow(run, 'f1').value, 120);
  near(flow(run, 'f3').value, 72);
  assert.deepEqual(saved, before);
  assert.equal(appendRun(saved, 'model-a', run).runs['model-a'][0].modelSnapshot.streams[1].value, 120);
});

test('invalid or circular virtual formulas fail clearly and never reach output adapters', async () => {
  for (const formula of ['', '[Missing meter] + 1', '1 / 0', '[Product meter]']) {
    const model = virtualModel(); reading(model, 'f2').formula = formula;
    let saved = createCatalog(model, { id: 'model-a', now: start });
    saved = registerSource(saved, 'model-a', { id: 'report', name: 'Test report', direction: 'output', type: 'test-output' });
    saved = setSchedule(saved, 'model-a', { outputSourceId: 'report' }, start);
    let outputs = 0;
    const { run } = await executeModelRun(saved, 'model-a', options({ outputAdapters: { 'test-output': () => { outputs++; } } }));
    assert.equal(run.status, 'failed');
    assert.equal(run.result, null);
    assert.match(run.error, /Reconciliation failed:.*Internal meter/);
    assert.equal(reading(run.modelSnapshot, 'f2').value, null);
    assert.equal(reading(run.modelSnapshot, 'f2').formula, formula);
    assert.equal(outputs, 0);
    assert.equal(appendRun(saved, 'model-a', run).runs['model-a'][0].status, 'failed');
  }
});

test('run input matching ignores virtual value caches but preserves every editable dependency', () => {
  const model = virtualModel(), audit = clone(model);
  reading(audit, 'f2').value = 100; reading(audit, 'f3').value = 60; reading(audit, 'f4').value = 40;
  assert.equal(sameRunInputs(model, audit), true);
  assert.equal(sameRunInputs(audit, model), true);
  assert.equal(sameRunInputs(null, audit), false);
  for (const [id, field, value] of [
    ['f1', 'value', 110], ['f1', 'meterName', 'Renamed meter'],
    ['f2', 'formula', '[Feed meter] + 1'], ['f2', 'meterName', 'Renamed virtual'],
    ['f2', 'uncertainty', 5], ['f2', 'meterType', 'physical'], ['f2', 'unit', 't']
  ]) {
    const changed = clone(audit); reading(changed, id)[field] = value;
    assert.equal(sameRunInputs(model, changed), false, `${id}.${field} must invalidate old results`);
  }
  assert.equal(reading(model, 'f2').value, 9999);
});
