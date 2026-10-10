import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../public/solver.js';

const node = (id, kind) => ({ id, kind, name: id, x: 0, y: 0 });
const stream = (id, source, target, value, sigma = 1, extra = {}) => ({ id, source, target, name: id, measured: value !== null, material: 'Material', metric: 'mass', unit: 'kg', value: value ?? '', uncertainty: sigma, uncertaintyType: 'absolute', density: 1000, phase: 'Liquid', ...extra });
const model = (nodes, streams, periodHours = 1) => ({ version: 1, name: 'Virtual test', periodHours, nodes, streams });
const line = [node('in', 'inlet'), node('unit', 'process'), node('out', 'outlet')];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const entry = (result, id) => result.streams.find(s => s.id === id);
const usable = result => assert.ok(['ok', 'warning', 'underdetermined'].includes(result.status), result.message);

test('a copied virtual meter does not double-count its physical source as independent evidence', () => {
  const result = reconcile(model(line, [stream('Feed', 'in', 'unit', 100, 2), stream('Copy', 'unit', 'out', -999, 3, { meterType: 'virtual', formula: '[Feed]' })]));
  usable(result);
  for (const id of ['Feed', 'Copy']) { near(entry(result, id).value, 100); near(entry(result, id).uncertainty, 2); }
  near(entry(result, 'Copy').raw, 100);
  near(entry(result, 'Copy').sigma, Math.sqrt(13));
  near(result.objective, 0);
});

test('adding a duplicate virtual meter does not change the independent physical optimum or its uncertainty', () => {
  const nodes = [node('in', 'inlet'), node('first', 'process'), node('second', 'process'), node('out', 'outlet')];
  const result = reconcile(model(nodes, [stream('Feed', 'in', 'first', 100, 2), stream('Copy', 'first', 'second', 999, 3, { meterType: 'virtual', formula: '[Feed]' }), stream('Product', 'second', 'out', 90, 1)]));
  usable(result);
  for (const id of ['Feed', 'Copy', 'Product']) { near(entry(result, id).value, 92); near(entry(result, id).uncertainty, Math.sqrt(0.8)); }
  near(result.objective, 20);
});

test('shared-source split formulas use analytical full covariance rather than independent marginal weights', () => {
  const nodes = [node('in', 'inlet'), node('split', 'splitter'), node('a', 'outlet'), node('b', 'outlet')];
  const result = reconcile(model(nodes, [stream('Feed', 'in', 'split', 100, 2), stream('A', 'split', 'a', 0, 3, { meterType: 'virtual', formula: '[Feed] * .6' }), stream('B', 'split', 'b', 0, 4, { meterType: 'virtual', formula: '[Feed] * .4' })]));
  usable(result);
  near(entry(result, 'Feed').uncertainty, 2);
  near(entry(result, 'A').uncertainty, Math.sqrt(7.2));
  near(entry(result, 'B').uncertainty, Math.sqrt(6.4));
  near(entry(result, 'A').value, 60);
  near(entry(result, 'B').value, 40);
  near(result.balances[0].reconciled, 0);
});

test('formula references use raw selected units and covariance uses mass/rate/density conversion factors', () => {
  const result = reconcile(model(line, [stream('Feed', 'in', 'unit', 2, .1, { metric: 'massFlow', unit: 't/h' }), stream('Copy', 'unit', 'out', 0, 100, { meterType: 'virtual', formula: '[Feed] * 1000', metric: 'volumeFlow', unit: 'L/h', density: 1000 })], 2));
  usable(result);
  near(entry(result, 'Copy').raw, 4000);
  near(entry(result, 'Copy').sigma, Math.sqrt(80000));
  near(entry(result, 'Copy').uncertainty, 200);
  near(entry(result, 'Feed').uncertainty, 200);
});

test('correlated objective preserves the active nonnegative-bound optimum', () => {
  const nodes = [...line, node('loss', 'outlet')];
  const result = reconcile(model(nodes, [stream('Feed', 'in', 'unit', 10, 1), stream('Product', 'unit', 'out', 999, 2, { meterType: 'virtual', formula: '[Feed] + 5' }), stream('Loss', 'unit', 'loss', null)]));
  usable(result);
  near(entry(result, 'Feed').value, 10);
  near(entry(result, 'Product').value, 10);
  near(entry(result, 'Loss').value, 0);
  near(result.objective, 6.25);
  assert.equal(entry(result, 'Feed').uncertainty, null);
});

test('constant virtual calculations provide independent evidence and invalid formulas withhold all reconciliation results', () => {
  const constant = reconcile(model(line, [stream('Feed', 'in', 'unit', 100, 1), stream('Virtual', 'unit', 'out', 0, 3, { meterType: 'virtual', formula: '90' })]));
  usable(constant); near(entry(constant, 'Feed').value, 99); near(entry(constant, 'Feed').uncertainty, Math.sqrt(.9));
  for (const formula of ['', '[Missing]', '[Feed] / 0', '[Feed] - 101']) {
    const result = reconcile(model(line, [stream('Feed', 'in', 'unit', 100), stream('Virtual', 'unit', 'out', 100, 1, { meterType: 'virtual', formula })]));
    assert.equal(result.status, 'invalid'); assert.equal(result.objective, null); assert.deepEqual(result.streams, []);
  }
});

test('all-physical reconciliation still accepts finite standard deviations whose squares overflow', () => {
  const result = reconcile(model(line, [stream('Feed', 'in', 'unit', 100, 1e200), stream('Product', 'unit', 'out', 90, 1e200)]));
  usable(result);
  near(entry(result, 'Feed').value, 95);
  near(entry(result, 'Product').value, 95);
  assert.equal(entry(result, 'Feed').sigma, 1e200);
  assert.equal(entry(result, 'Product').sigma, 1e200);
});
