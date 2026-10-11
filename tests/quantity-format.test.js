import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuantityFormatter, formatQuantity } from '../public/quantity-format.js';
import { formatPublishedMass, getPublishedUnitSummary } from '../public/published-results.js';
import { inventoryResultsHtml } from '../public/storage-ui.js';

test('display retains nonzero masses and signs below ordinary display resolution', () => {
  for (const value of [0.0004, -0.0004, 1e-9, -1e-9, Number.MIN_VALUE, -Number.MIN_VALUE]) {
    for (const format of [formatQuantity, formatPublishedMass, createQuantityFormatter({ maximumFractionDigits: 2 })]) {
      const text = format(value);
      assert.match(text, /e-/);
      assert.ok(Number(text) !== 0);
      assert.equal(Math.sign(Number(text)), Math.sign(value));
    }
  }
  assert.equal(formatPublishedMass(0.0004), '4.000e-4');
  assert.equal(formatPublishedMass(-0.0004), '-4.000e-4');
  assert.equal(formatQuantity(Number.MIN_VALUE), '4.941e-324');
});

test('ordinary mass formatting, real zero and unavailable readings stay clear', () => {
  const english = createQuantityFormatter({ locale: 'en' });
  assert.equal(english(1234.56789), '1,234.568');
  assert.equal(english(0.001), '0.001');
  assert.equal(english(0), '0');
  assert.equal(english(-0), '0');
  assert.equal(formatPublishedMass(99.44444), '99.444');
  assert.equal(formatPublishedMass(0.001), '0.001');
  assert.equal(formatPublishedMass(0), '0.000');
  assert.equal(formatPublishedMass(-0), '0.000');
  for (const value of [NaN, Infinity, -Infinity, null, undefined, '0.0004']) {
    assert.equal(english(value), '—');
    assert.equal(formatPublishedMass(value), '—');
  }
});

test('published unit totals and signed tank accumulation show small values rather than zero', () => {
  const node = { id: 'tank', kind: 'tank', name: 'Tank', inventory: {} };
  const streams = [{ id: 'in', target: node.id }, { id: 'out', source: node.id }];
  const result = { status: 'ok', streams: [{ id: 'in', value: 0.0004 }, { id: 'out', value: 0.0008 }], inventories: [{
    id: node.id, name: node.name,
    opening: { value: 0.001, status: 'reconciled' },
    closing: { value: 0.0006, status: 'reconciled' },
    accumulation: { value: -0.0004, status: 'reconciled' },
  }] };
  const summary = getPublishedUnitSummary(node, { nodes: [node], streams }, result);
  assert.deepEqual(summary.lines, ['Opening 0.001', 'Closing 6.000e-4', 'Δ inventory -4.000e-4']);
  assert.match(summary.description, /Incoming mass: 4\.000e-4 kg/);
  assert.match(summary.description, /Accumulation.*-4\.000e-4 kg/);
  const table = inventoryResultsHtml(result.inventories);
  assert.match(table, />-4\.000e-4<\/td>/);
});
