import test from 'node:test';
import assert from 'node:assert/strict';
import { storageShowcaseModel, resetStorageShowcaseReadings } from '../public/storage-showcase-model.js';
import { showcaseModel } from '../public/showcase-model.js';
import { validateModel } from '../public/model.js';
import { reconcile } from '../public/solver.js';
import { inventoryToMass } from '../public/inventory.js';

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);

test('storage showcase is separate, detached, and has three verifiable inventory bases', () => {
  const first = storageShowcaseModel(), second = storageShowcaseModel();
  assert.equal(validateModel(first), first);
  assert.deepEqual(first.nodes.filter(node => node.inventory).map(node => node.inventory.basis), ['mass', 'volume', 'level']);
  const expected = [[2000, 2200], [3000, 3200], [4000, 4100]];
  first.nodes.filter(node => node.inventory).forEach((node, i) => {
    for (const [index, endpoint] of ['opening', 'closing'].entries()) {
      close(inventoryToMass(node.inventory, endpoint).value, expected[i][index]);
      close(inventoryToMass(node.inventory, endpoint).sigma, 5);
    }
  });
  first.nodes[1].inventory.opening.value = 0;
  assert.equal(second.nodes[1].inventory.opening.value, 2000);
  assert.ok(showcaseModel().nodes.every(node => !node.inventory));
});

test('three-tank reconciliation agrees with an independent closed-form weighted projection', () => {
  const model = storageShowcaseModel(), before = structuredClone(model), result = reconcile(model);
  assert.notEqual(result.status, 'invalid');
  assert.equal(result.degreesOfFreedom, 1);
  close(result.objective, 10 ** 2 / 350);
  const flow = Object.fromEntries(result.streams.map(item => [item.id, item.value]));
  close(flow['supply-flow'], 1010 - 20 / 7);
  close(flow['delivery-flow'], 500 + 20 / 7);
  close(flow['pump-suction'], 800 + 40 / 7);
  close(flow['pump-discharge'], 800 + 40 / 7);
  close(flow['valve-inlet'], 600 + 30 / 7);
  close(flow['valve-outlet'], 600 + 30 / 7);
  const raw = [[2000, 2200], [3000, 3200], [4000, 4100]];
  result.inventories.forEach((inventory, i) => {
    close(inventory.opening.value, raw[i][0] - 5 / 7);
    close(inventory.closing.value, raw[i][1] + 5 / 7);
    close(inventory.accumulation.value, raw[i][1] - raw[i][0] + 10 / 7);
    close(inventory.accumulation.sigma, Math.sqrt(50));
    close(inventory.opening.uncertainty, Math.sqrt(25 - 25 ** 2 / 350));
    close(inventory.accumulation.uncertainty, Math.sqrt(50 - 50 ** 2 / 350));
  });
  close(flow['supply-flow'] - flow['delivery-flow'], result.inventories.reduce((sum, item) => sum + item.accumulation.value, 0));
  for (const balance of result.balances) close(balance.reconciled, 0);
  assert.ok(result.streams.every(item => item.value !== null));
  assert.equal(result.streams.filter(item => item.status === 'estimated').length, 4);
  assert.deepEqual(model, before);
});

test('consistent tank reference preserves readings and infers transfer masses', () => {
  const model = storageShowcaseModel(); model.streams[0].value = 1000;
  const result = reconcile(model);
  close(result.objective, 0);
  assert.deepEqual(result.streams.map(item => Math.round(item.value)), [1000, 800, 800, 600, 600, 500]);
  assert.deepEqual(result.inventories.map(item => Math.round(item.accumulation.value)), [200, 200, 100]);
});

test('template reset preserves modified conversion settings and the first template', () => {
  const model = storageShowcaseModel(); model.nodes[1].inventory.opening.value = 1; model.nodes[3].inventory.unit = 'L'; model.nodes[3].inventory.opening.value = 19;
  model.streams[0].value = 1;
  resetStorageShowcaseReadings(model);
  assert.equal(model.nodes[1].inventory.opening.value, 2000);
  assert.equal(model.nodes[3].inventory.opening.value, 19);
  assert.equal(model.streams[0].value, 1010);
  const simple = showcaseModel(), before = structuredClone(simple);
  resetStorageShowcaseReadings(simple);
  assert.deepEqual(simple, before);
});
