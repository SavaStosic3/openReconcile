import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../dist/solver.js';

const node = (id, kind) => ({ id, kind, name: id, x: 0, y: 0 });
const stream = (id, source, target, value = null, sigma = 1, extra = {}) => ({
  id, source, target, name: id, material: 'Material', measured: value !== null,
  metric: 'mass', unit: 'kg', value: value ?? '', uncertainty: sigma,
  uncertaintyType: 'absolute', density: 1000, phase: 'Liquid', temperature: 20, pressure: 101.325, ...extra
});
const model = (nodes, streams, periodHours = 1) => ({ version: 1, name: 'Test process', periodHours, nodes, streams });
const lineNodes = [node('in', 'inlet'), node('unit', 'process'), node('out', 'outlet')];
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`);
const entry = (result, id) => result.streams.find(s => s.id === id);
const usable = result => assert.ok(['ok', 'warning', 'underdetermined'].includes(result.status), result.message);

test('unequal variances produce the analytical equality-constrained estimate and covariance', () => {
  const result = reconcile(model(lineNodes, [stream('feed', 'in', 'unit', 100, 1), stream('product', 'unit', 'out', 90, 3)]));
  usable(result);
  near(entry(result, 'feed').value, 99);
  near(entry(result, 'product').value, 99);
  near(entry(result, 'feed').correction, -1);
  near(entry(result, 'product').normalizedCorrection, 3);
  near(entry(result, 'feed').uncertainty, Math.sqrt(0.9));
  near(entry(result, 'product').uncertainty, Math.sqrt(0.9));
  near(result.objective, 10);
  assert.equal(result.degreesOfFreedom, 1);
  near(result.balances[0].raw, 10);
  near(result.balances[0].reconciled, 0);
  assert.ok(result.warnings.some(w => w.includes('does not identify a bad meter')));
});

test('a missing reading is inferred from conservation without an invented objective term', () => {
  const result = reconcile(model(lineNodes, [stream('feed', 'in', 'unit', 100, 2), stream('product', 'unit', 'out')]));
  usable(result);
  near(entry(result, 'feed').value, 100);
  const product = entry(result, 'product');
  assert.equal(product.status, 'estimated');
  assert.equal(product.raw, null);
  assert.equal(product.sigma, null);
  near(product.value, 100);
  near(product.uncertainty, 2);
  near(result.objective, 0);
  assert.equal(result.degreesOfFreedom, 0);
  assert.equal(result.balances[0].raw, null);
});

test('unmeasured split branches remain unobservable despite identifiable throughput', () => {
  const nodes = [node('in', 'inlet'), node('split', 'splitter'), node('a', 'outlet'), node('b', 'outlet')];
  const result = reconcile(model(nodes, [stream('feed', 'in', 'split', 10), stream('a', 'split', 'a'), stream('b', 'split', 'b')]));
  assert.equal(result.status, 'underdetermined');
  near(entry(result, 'feed').value, 10);
  for (const id of ['a', 'b']) {
    assert.equal(entry(result, id).status, 'unobservable');
    assert.equal(entry(result, id).value, null);
    assert.equal(entry(result, id).uncertainty, null);
  }
  near(result.balances[0].reconciled, 0);
});

test('an unmeasured disconnected circulation does not erase observable subset results', () => {
  const nodes = [...lineNodes, node('a', 'process'), node('b', 'process')];
  const result = reconcile(model(nodes, [
    stream('feed', 'in', 'unit', 23, 2), stream('product', 'unit', 'out'),
    stream('ab', 'a', 'b'), stream('ba', 'b', 'a')
  ]));
  assert.equal(result.status, 'underdetermined');
  near(entry(result, 'product').value, 23);
  near(entry(result, 'product').uncertainty, 2);
  assert.equal(entry(result, 'ab').value, null);
  assert.equal(entry(result, 'ba').value, null);
  assert.ok(result.warnings.some(w => w.includes('disconnected')));
});

test('duplicate internal cycle balances are rank-reduced, not counted twice', () => {
  const result = reconcile(model([node('a', 'process'), node('b', 'process')], [stream('ab', 'a', 'b', 8, 1), stream('ba', 'b', 'a', 12, 2)]));
  usable(result);
  near(entry(result, 'ab').value, 8.8);
  near(entry(result, 'ba').value, 8.8);
  near(entry(result, 'ab').uncertainty, Math.sqrt(0.8));
  near(result.objective, 3.2);
  assert.equal(result.degreesOfFreedom, 1);
  for (const balance of result.balances) near(balance.reconciled, 0);
});

test('zero measurements use absolute standard deviation and remain valid', () => {
  const result = reconcile(model(lineNodes, [stream('feed', 'in', 'unit', 0, 1), stream('product', 'unit', 'out', 10, 1)]));
  usable(result);
  near(entry(result, 'feed').value, 5);
  near(entry(result, 'product').value, 5);
  near(result.objective, 50);
  const invalidPercent = reconcile(model(lineNodes, [stream('feed', 'in', 'unit', 0, 2, { uncertaintyType: 'percent' }), stream('product', 'unit', 'out')]));
  assert.equal(invalidPercent.status, 'invalid');
  assert.match(invalidPercent.message, /absolute uncertainty/);
});

test('mass/volume rates and absolute uncertainties use one kg-per-interval basis', () => {
  const result = reconcile(model(lineNodes, [
    stream('feed', 'in', 'unit', 2, 0.1, { metric: 'massFlow', unit: 't/h' }),
    stream('product', 'unit', 'out', 2000, 100, { metric: 'volumeFlow', unit: 'L/h', density: 1000 })
  ], 3));
  usable(result);
  near(entry(result, 'feed').raw, 6000);
  near(entry(result, 'product').raw, 6000);
  near(entry(result, 'feed').sigma, 300);
  near(entry(result, 'product').sigma, 300);
  near(entry(result, 'feed').uncertainty, 300 / Math.sqrt(2));
  near(result.objective, 0);
  assert.ok(result.warnings.some(w => w.includes('Density uncertainty')));
});

test('percentage uncertainty is converted to standard deviation before weighting', () => {
  const result = reconcile(model(lineNodes, [
    stream('feed', 'in', 'unit', 1, 1, { unit: 't', uncertaintyType: 'percent' }),
    stream('product', 'unit', 'out', 900, 30)
  ]));
  usable(result);
  near(entry(result, 'feed').sigma, 10);
  near(entry(result, 'feed').value, 990);
  near(entry(result, 'product').value, 990);
});

test('negative unconstrained loss activates a zero bound and reoptimizes measurements', () => {
  const nodes = [...lineNodes, node('loss', 'outlet')];
  const result = reconcile(model(nodes, [
    stream('feed', 'in', 'unit', 10, 1), stream('product', 'unit', 'out', 15, 1), stream('loss', 'unit', 'loss')
  ]));
  usable(result);
  near(entry(result, 'feed').value, 12.5);
  near(entry(result, 'product').value, 12.5);
  near(entry(result, 'loss').value, 0);
  assert.equal(entry(result, 'loss').atBound, true);
  assert.equal(entry(result, 'loss').uncertainty, null);
  assert.equal(entry(result, 'feed').uncertainty, null);
  assert.equal(entry(result, 'product').uncertainty, null);
  near(result.objective, 12.5);
  near(result.balances[0].reconciled, 0);
});

test('a measured split branch at a bound gives the correct constrained optimum', () => {
  const nodes = [node('in', 'inlet'), node('unit', 'splitter'), node('out', 'outlet'), node('small', 'outlet')];
  const result = reconcile(model(nodes, [
    stream('feed', 'in', 'unit', 1, 1), stream('product', 'unit', 'out', 10, 1), stream('small', 'unit', 'small', 1, 1)
  ]));
  usable(result);
  near(entry(result, 'feed').value, 5.5);
  near(entry(result, 'product').value, 5.5);
  near(entry(result, 'small').value, 0);
  near(result.objective, 41.5);
  assert.equal(entry(result, 'small').uncertainty, null);
});

test('nonnegative zero throughput uniquely fixes unmeasured split flows', () => {
  const nodes = [node('in', 'inlet'), node('split', 'splitter'), node('a', 'outlet'), node('b', 'outlet')];
  const result = reconcile(model(nodes, [stream('feed', 'in', 'split', 0), stream('a', 'split', 'a'), stream('b', 'split', 'b')]));
  usable(result);
  assert.notEqual(result.status, 'underdetermined');
  near(entry(result, 'a').value, 0);
  near(entry(result, 'b').value, 0);
  assert.equal(entry(result, 'a').status, 'estimated');
  assert.equal(entry(result, 'a').uncertainty, null);
});

test('no measurements do not produce arbitrary throughput estimates', () => {
  const result = reconcile(model(lineNodes, [stream('feed', 'in', 'unit'), stream('product', 'unit', 'out')]));
  assert.equal(result.status, 'underdetermined');
  assert.equal(result.objective, 0);
  for (const s of result.streams) assert.equal(s.value, null);
});

test('topology-forced zero is reported with a missing-boundary warning', () => {
  const result = reconcile(model([node('in', 'inlet'), node('unit', 'process')], [stream('deadend', 'in', 'unit', 10, 1)]));
  usable(result);
  near(entry(result, 'deadend').value, 0);
  near(result.objective, 100);
  assert.equal(result.degreesOfFreedom, 1);
  assert.ok(result.warnings.some(w => w.includes('cannot carry nonzero flow')));
});

test('a topology-forced zero branch preserves interior covariance on the valid process', () => {
  const nodes = [...lineNodes, node('deadend', 'process')];
  const result = reconcile(model(nodes, [
    stream('feed', 'in', 'unit', 100, 1), stream('product', 'unit', 'out', 90, 3), stream('dead', 'unit', 'deadend')
  ]));
  usable(result);
  near(entry(result, 'feed').value, 99);
  near(entry(result, 'feed').uncertainty, Math.sqrt(0.9));
  near(entry(result, 'dead').value, 0);
  assert.equal(entry(result, 'dead').atBound, false);
  near(entry(result, 'dead').uncertainty, 0);
});

test('an active bound does not withhold covariance from a separate connected process', () => {
  const nodes = [...lineNodes, node('loss', 'outlet'), node('in2', 'inlet'), node('unit2', 'process'), node('out2', 'outlet')];
  const result = reconcile(model(nodes, [
    stream('feed', 'in', 'unit', 10), stream('product', 'unit', 'out', 15), stream('loss', 'unit', 'loss'),
    stream('feed2', 'in2', 'unit2', 100, 1), stream('product2', 'unit2', 'out2', 90, 3)
  ]));
  usable(result);
  assert.equal(entry(result, 'feed').uncertainty, null);
  near(entry(result, 'feed2').uncertainty, Math.sqrt(0.9));
});

test('an enormous topology-forced residual cannot hide optimization of viable flows', () => {
  const nodes = [...lineNodes, node('loss', 'outlet'), node('in2', 'inlet'), node('deadend', 'process')];
  const result = reconcile(model(nodes, [
    stream('feed', 'in', 'unit', 10), stream('product', 'unit', 'out', 15), stream('loss', 'unit', 'loss'),
    stream('impossible', 'in2', 'deadend', 1e20)
  ]));
  usable(result);
  near(entry(result, 'feed').value, 12.5);
  near(entry(result, 'product').value, 12.5);
  near(entry(result, 'impossible').value, 0);
});

test('a large inconsistent separate process cannot hide a small process active-bound optimum', () => {
  const nodes = [...lineNodes, node('loss', 'outlet'), node('in2', 'inlet'), node('unit2', 'process'), node('out2', 'outlet')];
  const result = reconcile(model(nodes, [
    stream('feed', 'in', 'unit', 10), stream('product', 'unit', 'out', 15), stream('loss', 'unit', 'loss'),
    stream('feed2', 'in2', 'unit2', 1e20), stream('product2', 'unit2', 'out2', 2e20)
  ]));
  usable(result);
  near(entry(result, 'feed').value, 12.5);
  near(entry(result, 'product').value, 12.5);
  near(entry(result, 'feed2').value, 1.5e20);
  near(entry(result, 'product2').value, 1.5e20);
});

test('two disconnected observable processes reconcile independently', () => {
  const nodes = [...lineNodes, node('in2', 'inlet'), node('unit2', 'mixer'), node('out2', 'outlet')];
  const result = reconcile(model(nodes, [
    stream('feed', 'in', 'unit', 100), stream('product', 'unit', 'out', 98),
    stream('feed2', 'in2', 'unit2', 5), stream('product2', 'unit2', 'out2', 5)
  ]));
  assert.equal(result.status, 'warning');
  near(entry(result, 'feed').value, 99);
  near(entry(result, 'product').value, 99);
  near(entry(result, 'feed2').value, 5);
  assert.equal(result.degreesOfFreedom, 2);
  assert.ok(result.warnings.some(w => w.includes('disconnected')));
});

test('a missing direct boundary-to-boundary stream is unobservable', () => {
  const result = reconcile(model([node('in', 'inlet'), node('out', 'outlet')], [stream('direct', 'in', 'out')]));
  assert.equal(result.status, 'underdetermined');
  assert.equal(entry(result, 'direct').value, null);
});

test('invalid, dangling, blank, and overflowing inputs return invalid without throwing', () => {
  const cases = [
    null,
    model([], []),
    model(lineNodes, [stream('bad', 'in', 'missing', 1)]),
    model(lineNodes, [stream('bad', 'out', 'unit', 1)]),
    model(lineNodes, [stream('bad', 'in', 'unit', 1, 0)]),
    model(lineNodes, [stream('bad', 'in', 'unit', 1, 1, { density: 0, metric: 'volume', unit: 'm³' })]),
    model(lineNodes, [stream('bad', 'in', 'unit', 1, 1, { value: '' })]),
    model(lineNodes, [stream('bad', 'in', 'unit', 1e308, 1, { unit: 't' })]),
    model(lineNodes, [stream('same', 'in', 'unit', 1), stream('same', 'unit', 'out', 1)])
  ];
  for (const input of cases) {
    let result; assert.doesNotThrow(() => { result = reconcile(input); });
    assert.equal(result.status, 'invalid', JSON.stringify(input));
    assert.equal(result.objective, null);
  }
});

test('meter uncertainties with unsupported numerical conditioning withhold results', () => {
  const result = reconcile(model([node('in', 'inlet'), node('out', 'outlet')], [
    stream('precise', 'in', 'out', 1, 1e-20), stream('loose', 'in', 'out', 2, 1e20)
  ]));
  assert.equal(result.status, 'invalid');
  assert.match(result.message, /ill-conditioned/);
});
