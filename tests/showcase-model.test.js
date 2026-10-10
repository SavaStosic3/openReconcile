import test from 'node:test';
import assert from 'node:assert/strict';
import { showcaseModel } from '../public/showcase-model.js';
import { validateModel } from '../public/model.js';
import { reconcile } from '../public/solver.js';
import { evaluateMeterDetails } from '../public/virtual-meters.js';
import { getSqlInputMappings } from '../public/sql-sources.js';

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
const valuesById = result => new Map(result.streams.map(stream => [stream.id, stream.value]));

test('showcase is a valid, detached model with uniquely mapped physical inputs', () => {
  const first = showcaseModel(), second = showcaseModel();
  assert.equal(validateModel(first), first);
  assert.equal(first.nodes.length, 9);
  assert.equal(first.streams.length, 9);
  assert.ok(first.streams.every(stream => stream.metric === 'massFlow' && stream.unit === 'kg/h'));
  assert.ok(first.nodes.every(node => !/tank|storage/i.test(node.kind)));
  const inputs = getSqlInputMappings(first);
  assert.equal(inputs.length, 5);
  assert.equal(new Set(inputs.map(input => input.sourceName)).size, 5);
  first.nodes[0].name = 'Changed';
  first.streams[0].value = 0;
  first.streams[0].dataMapping.sourceName = 'Changed';
  assert.equal(second.nodes[0].name, 'Raw slurry');
  assert.equal(second.streams[0].value, 800);
  assert.notEqual(second.streams[0].dataMapping.sourceName, 'Changed');
});

test('showcase solves the independent 10 kg/h mismatch without double-counting its virtual sum', () => {
  const model = showcaseModel(), before = structuredClone(model);
  const virtual = evaluateMeterDetails(model).get('mixed-feed');
  assert.equal(virtual.value, 1050);
  close(virtual.sigma, Math.sqrt(10 ** 2 + 5 ** 2 + 5 ** 2 + 5 ** 2));
  const result = reconcile(model), values = valuesById(result);
  // r + w + c = h; the discrepancy is 10 and the physical variance sum
  // is 100 + 25 + 25 + 100 = 250. Weighted corrections are +4,+1,+1,-4.
  // The virtual innovation v - r - w - c is already zero by conservation.
  const expected = { 'raw-feed-flow': 804, 'pump-discharge': 804, 'wash-water-flow': 201, 'mixed-feed': 1056, 'conditioned-feed': 1056, 'filtrate': 951, 'filter-cake-flow': 105, 'product-flow': 900, 'recycle': 51 };
  for (const [id, value] of Object.entries(expected)) close(values.get(id), value);
  close(result.objective, 4 ** 2 / 100 + 1 ** 2 / 25 + 1 ** 2 / 25 + (-4) ** 2 / 100);
  assert.equal(result.degreesOfFreedom, 2);
  assert.ok(result.streams.filter(stream => ['pump-discharge', 'filtrate', 'filter-cake-flow'].includes(stream.id)).every(stream => stream.status === 'estimated'));
  assert.ok(result.streams.every(stream => stream.value !== null && stream.value > 0 && Number.isFinite(stream.uncertainty)));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^Virtual meter uncertainties/);
  assert.deepEqual(model, before);
});

test('showcase closes every unit and the external boundary balance', () => {
  const model = showcaseModel(), result = reconcile(model), values = valuesById(result);
  for (const node of model.nodes.filter(node => !['inlet', 'outlet'].includes(node.kind))) {
    const incoming = model.streams.filter(stream => stream.target === node.id).reduce((sum, stream) => sum + values.get(stream.id), 0);
    const outgoing = model.streams.filter(stream => stream.source === node.id).reduce((sum, stream) => sum + values.get(stream.id), 0);
    close(incoming, outgoing);
  }
  close(values.get('raw-feed-flow') + values.get('wash-water-flow'), values.get('product-flow') + values.get('filter-cake-flow'));
  for (const balance of result.balances) close(balance.reconciled, 0);
});

test('showcase rate measurements scale with actual reporting duration and retain the same objective', () => {
  const baseline = reconcile(showcaseModel());
  for (const periodHours of [2.5, 8, 23, 24, 25]) {
    const model = showcaseModel(); model.periodHours = periodHours;
    const result = reconcile(model);
    for (const stream of result.streams) {
      const reference = baseline.streams.find(item => item.id === stream.id);
      close(stream.value, reference.value * periodHours, 1e-6);
      close(stream.uncertainty, reference.uncertainty * periodHours, 1e-6);
    }
    close(result.objective, baseline.objective);
    assert.equal(model.streams.find(stream => stream.id === 'raw-feed-flow').value, 800);
  }
});

test('removing the controlled meter mismatch preserves readings and infers 100 kg/h of wet cake', () => {
  const model = showcaseModel();
  model.streams.find(stream => stream.id === 'conditioned-feed').value = 1050;
  const result = reconcile(model), values = valuesById(result);
  close(values.get('filter-cake-flow'), 100);
  close(values.get('recycle'), 50);
  close(values.get('raw-feed-flow'), 800);
  close(values.get('wash-water-flow'), 200);
  close(values.get('product-flow'), 900);
  close(result.objective, 0);
});
