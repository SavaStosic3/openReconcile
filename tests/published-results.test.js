import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleModel, newStream } from '../public/model.js';
import { UNIT_SYMBOLS } from '../public/unit-symbols.js';
import { reconcile } from '../public/solver.js';
import { formatPublishedMass, getPublishedUnitSummary } from '../public/published-results.js';

test('published unit totals use reconciled streams and batch mass, including inferred flows', () => {
  const model = exampleModel(), result = reconcile(model);
  const summary = id => getPublishedUnitSummary(model.nodes.find(node => node.id === id), model, result);
  assert.equal(summary('mix').status, 'ready');
  assert.ok(Math.abs(summary('mix').incoming - 99.4444444444) < 1e-7);
  assert.ok(Math.abs(summary('mix').outgoing - 99.4444444444) < 1e-7);
  assert.deepEqual(summary('mix').lines, ['In 99.444', 'Out 99.444']);
  assert.deepEqual(summary('split').lines, ['In 99.444', 'Out 99.444']);
  assert.deepEqual(summary('feed').lines, ['Inflow 99.444']);
  assert.deepEqual(summary('product').lines, ['Outflow 62.222']);
  assert.deepEqual(summary('byproduct').lines, ['Outflow 37.222']);
  assert.match(summary('mix').description, /kg per batch/);
  assert.equal(summary('feed').incoming, null);
  assert.equal(summary('product').outgoing, null);
});

test('multiple incoming and outgoing totals sum only the streams connected to that unit', () => {
  const model = exampleModel();
  model.streams.push({ ...newStream('feed', 'split', 5), id: 'second-input' });
  const result = { status: 'warning', streams: [
    { id: 'f1', value: 100, status: 'measured' }, { id: 'f2', value: 100, status: 'estimated' },
    { id: 'f3', value: 75, status: 'measured' }, { id: 'f4', value: 50, status: 'estimated' },
    { id: 'second-input', value: 25, status: 'measured' }
  ] };
  const split = getPublishedUnitSummary(model.nodes.find(node => node.id === 'split'), model, result);
  assert.equal(split.incoming, 125); assert.equal(split.outgoing, 125);
  assert.deepEqual(split.lines, ['In 125.000', 'Out 125.000']);
  const feed = getPublishedUnitSummary(model.nodes[0], model, result);
  assert.deepEqual(feed.lines, ['Inflow 125.000']);
});

test('unobservable or missing stream values withhold whole-unit throughput without substituting zero', () => {
  const model = exampleModel(), result = reconcile(model);
  const split = model.nodes.find(node => node.id === 'split');
  const unresolved = structuredClone(result);
  Object.assign(unresolved.streams.find(stream => stream.id === 'f3'), { value: null, status: 'unobservable' });
  unresolved.status = 'underdetermined';
  const summary = getPublishedUnitSummary(split, model, unresolved);
  assert.equal(summary.status, 'unresolved');
  assert.equal(summary.incoming, null); assert.equal(summary.outgoing, null);
  assert.deepEqual(summary.lines, ['In —', 'Out —']);
  assert.match(summary.description, /unobservable/);
  const missing = structuredClone(result);
  missing.streams = missing.streams.filter(stream => stream.id !== 'f4');
  assert.equal(getPublishedUnitSummary(split, model, missing).status, 'unresolved');
  const numericButUnobservable = structuredClone(result);
  numericButUnobservable.streams.find(stream => stream.id === 'f4').status = 'unobservable';
  assert.equal(getPublishedUnitSummary(split, model, numericButUnobservable).outgoing, null);
  const unmeasured = exampleModel();
  unmeasured.streams.forEach(stream => { stream.measured = false; });
  const unmeasuredResult = reconcile(unmeasured);
  assert.equal(unmeasuredResult.status, 'underdetermined');
  assert.deepEqual(getPublishedUnitSummary(unmeasured.nodes[1], unmeasured, unmeasuredResult).lines, ['In —', 'Out —']);
});

test('every industrial asset symbol uses the same connected-stream mass totals', () => {
  const model = exampleModel(), result = reconcile(model);
  for (const kind of Object.keys(UNIT_SYMBOLS)) {
    const unit = { ...model.nodes[1], kind };
    const summary = getPublishedUnitSummary(unit, model, result);
    assert.equal(summary.status, 'ready', kind);
    assert.deepEqual(summary.lines, ['In 99.444', 'Out 99.444'], kind);
  }
});

test('missing and invalid results show awaiting status; isolated units never display made-up zeros', () => {
  const model = exampleModel(), node = model.nodes[1];
  for (const result of [null, undefined, { status: 'invalid', streams: [{ id: 'f1', value: 100 }] }, { status: 'ok' }]) {
    const summary = getPublishedUnitSummary(node, model, result);
    assert.equal(summary.status, 'awaiting'); assert.equal(summary.heading, 'Awaiting run');
    assert.deepEqual(summary.lines, []); assert.equal(summary.incoming, null); assert.equal(summary.outgoing, null);
  }
  model.nodes.push({ id: 'isolated', kind: 'pump', name: 'Unused pump', x: 0, y: 0 });
  const isolated = getPublishedUnitSummary(model.nodes.at(-1), model, reconcile(model));
  assert.equal(isolated.status, 'unresolved'); assert.deepEqual(isolated.lines, ['In —', 'Out —']);
  assert.match(isolated.description, /no connected streams/);
});

test('published mass formatting retains real zero and result badges have finite extents clear of symbols', () => {
  assert.equal(formatPublishedMass(0), '0.000'); assert.equal(formatPublishedMass(-0), '0.000');
  assert.equal(formatPublishedMass(null), '—'); assert.equal(formatPublishedMass(Infinity), '—');
  const model = exampleModel(), result = reconcile(model);
  for (const node of model.nodes) for (const run of [result, null]) {
    const summary = getPublishedUnitSummary(node, model, run);
    assert.ok(Object.values(summary.bounds).every(Number.isFinite));
    assert.ok(summary.bounds.left < summary.bounds.right);
    assert.ok(summary.bounds.top < summary.bounds.bottom);
    assert.ok(summary.bounds.bottom <= (node.kind === 'inlet' || node.kind === 'outlet' ? -38 : -46));
  }
});
