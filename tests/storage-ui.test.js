import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultInventory } from '../public/inventory.js';
import { inventoryFromForm, inventoryRowsHtml, inventoryMassHtml, inventoryResultsHtml, parseCalibrationPoints } from '../public/storage-ui.js';
import { inventoryMappingItems, setItemDataMapping, getModelItemName } from '../public/data-mapping.js';
import { newNode, validateModel } from '../public/model.js';
import { validateEditableModel } from '../public/management-store.js';
import { storageShowcaseModel } from '../public/storage-showcase-model.js';
import { reconcile } from '../public/solver.js';
import { getPublishedUnitSummary } from '../public/published-results.js';

function formFixture(inventory = defaultInventory()) {
  const elements = {}, field = (key, value) => { elements[key] = { value: String(value ?? '') }; };
  field('name', 'Tank A'); field('inventoryBasis', inventory.basis); field('inventoryUnit', inventory.unit);
  field('inventoryDensity', inventory.density); field('inventoryDensityUncertainty', inventory.densityUncertainty); field('inventoryCorrelation', inventory.readingCorrelation);
  field('inventoryCapacity', inventory.capacityMass); field('inventoryGeometry', inventory.geometry.kind); field('inventoryDiameter', inventory.geometry.diameter ?? 2); field('inventoryArea', inventory.geometry.area ?? 1); field('inventoryCalibration', '0, 0\n1, 10\n2, 25');
  for (const endpoint of ['opening', 'closing']) {
    const title = endpoint[0].toUpperCase() + endpoint.slice(1), reading = inventory[endpoint];
    elements[`inventory${title}Measured`] = { checked: reading.measured };
    for (const [suffix, key] of [['Value', 'value'], ['Uncertainty', 'uncertainty'], ['UncertaintyType', 'uncertaintyType']]) field(`inventory${title}${suffix}`, reading[key]);
    field(`inventory${title}Source`, reading.dataMapping?.sourceName || '');
  }
  return { elements };
}

test('new storage nodes have explicit editable inventories and steady-state nodes cannot retain inventory equations', () => {
  for (const kind of ['tank', 'bulkStorage']) {
    const node = newNode(kind, 30, 40, 2);
    assert.equal(node.inventory.opening.measured, true); assert.equal(node.inventory.closing.value, '');
    const model = { version: 1, name: 'Storage', periodHours: 1, nodes: [node], streams: [] };
    assert.deepEqual(validateModel(model), model); assert.deepEqual(validateEditableModel(model), model);
    assert.equal(reconcile(model).status, 'invalid');
    delete node.inventory; assert.throws(() => validateEditableModel(model), /configure opening/);
    node.kind = 'pump'; node.inventory = defaultInventory(); assert.throws(() => validateEditableModel(model), /tank or storage silo/);
  }
});

test('inventory draft readings and uncertainty remain editable while reconciliation rejects invalid values', () => {
  for (const value of ['', null, '-2', 'not a number']) for (const uncertainty of ['', null, '-1', 'invalid']) {
    const model = storageShowcaseModel(), endpoint = model.nodes[1].inventory.opening;
    endpoint.value = value; endpoint.uncertainty = uncertainty;
    assert.deepEqual(validateEditableModel(model), model);
    assert.equal(reconcile(model).status, 'invalid');
  }
  const model = storageShowcaseModel(); model.nodes[1].inventory.opening.value = { unsafe: true };
  assert.throws(() => validateEditableModel(model), /scalar inventory/);
  const inferred = storageShowcaseModel();
  inferred.nodes[1].inventory.opening.measured = false; inferred.nodes[1].inventory.opening.value = ''; inferred.nodes[1].inventory.opening.uncertainty = '';
  const result = reconcile(inferred); assert.ok(['ok', 'warning', 'underdetermined'].includes(result.status));
  assert.equal(result.inventories[0].opening.status, 'estimated');
});

test('storage form saves endpoint measurements and mappings as detached data without altering hidden unmeasured readings', () => {
  const original = defaultInventory(), form = formFixture(original), fields = form.elements;
  fields.inventoryOpeningValue.value = '2000'; fields.inventoryClosingValue.value = '2200'; fields.inventoryOpeningUncertainty.value = '5'; fields.inventoryClosingUncertainty.value = '5';
  fields.inventoryOpeningSource.value = ' PLANT.TANK.LEVEL '; fields.inventoryClosingSource.value = 'PLANT.TANK.LEVEL'; fields.inventoryCapacity.value = '5000';
  const configured = inventoryFromForm(form, original);
  assert.equal(original.opening.value, ''); assert.equal(configured.opening.value, 2000); assert.equal(configured.capacityMass, 5000);
  assert.deepEqual(configured.opening.dataMapping, { sourceName: 'PLANT.TANK.LEVEL' }); assert.deepEqual(configured.closing.dataMapping, configured.opening.dataMapping);
  fields.inventoryOpeningMeasured.checked = false; fields.inventoryOpeningSource.value = '';
  const unmapped = inventoryFromForm(form, configured);
  assert.equal(unmapped.opening.measured, false); assert.equal(unmapped.opening.value, 2000); assert.equal(unmapped.opening.dataMapping, undefined);
});

test('calibration parser uses canonical metres/cubic metres and validation rejects unsafe conversion assumptions', () => {
  assert.deepEqual(parseCalibrationPoints('0, 0\r\n\n 1, 10\n2, 25'), [{ level: 0, volume: 0 }, { level: 1, volume: 10 }, { level: 2, volume: 25 }]);
  for (const text of ['1', ',2', '0,0,0', 'NaN,1', '1,Infinity']) assert.throws(() => parseCalibrationPoints(text), /Calibration row/);
  const inventory = defaultInventory(), form = formFixture(inventory);
  form.elements.inventoryBasis.value = 'level'; form.elements.inventoryUnit.value = 'cm'; form.elements.inventoryGeometry.value = 'calibration';
  const configured = inventoryFromForm(form, inventory); assert.equal(configured.geometry.points.at(-1).volume, 25);
  form.elements.inventoryDensityUncertainty.value = '1'; assert.throws(() => inventoryFromForm(form, inventory), /calibrat|fixed density/i);
});

test('storage measurement rows distinguish snapshots from interval flows and preserve conversion uncertainty', () => {
  const model = storageShowcaseModel(), html = inventoryRowsHtml(model);
  assert.equal((html.match(/data-inventory-node=/g) || []).length, 6);
  assert.ok(html.includes('at reporting-period start') && html.includes('at reporting-period end') && html.includes('Volume inventory') && html.includes('Level inventory'));
  assert.ok(inventoryMassHtml(model.nodes[3].inventory, 'opening', 'Buffer B').includes('3,000 kg'));
  model.nodes[1].inventory.opening.measured = false;
  assert.ok(inventoryRowsHtml(model).includes('Inferred if observable'));
  assert.ok(inventoryMassHtml(defaultInventory(), 'opening', 'Blank').includes('Reading needed'));
  model.nodes[1].name = '<script>alert(1)</script>';
  const escaped = inventoryRowsHtml(model); assert.ok(!escaped.includes('<script>') && escaped.includes('&lt;script&gt;'));
});

test('inventory mappings target stable opening/closing endpoints and derive names after unit rename', () => {
  const original = storageShowcaseModel(), before = structuredClone(original);
  const first = setItemDataMapping(original, { kind: 'inventory', id: 'buffer-a', endpoint: 'opening', sourceName: ' TANK.A ' });
  const mapped = setItemDataMapping(first, { kind: 'inventory', id: 'buffer-a', endpoint: 'closing', sourceName: 'TANK.A' });
  assert.deepEqual(original, before);
  assert.equal(mapped.nodes[1].inventory.opening.dataMapping.sourceName, 'TANK.A'); assert.equal(mapped.nodes[1].inventory.closing.dataMapping.sourceName, 'TANK.A');
  mapped.nodes[1].name = 'Renamed tank';
  const items = inventoryMappingItems(mapped); assert.equal(items.length, 6); assert.equal(getModelItemName(items[0].item, 'inventory'), 'Renamed tank · Opening inventory');
  const removed = setItemDataMapping(mapped, { kind: 'inventory', id: 'buffer-a', endpoint: 'opening', sourceName: '' });
  assert.equal(removed.nodes[1].inventory.opening.dataMapping, undefined); assert.equal(removed.nodes[1].inventory.closing.dataMapping.sourceName, 'TANK.A');
  for (const changes of [{ kind: 'inventory', id: 'buffer-a', endpoint: 'invalid', sourceName: 'X' }, { kind: 'inventory', id: 'transfer-pump', endpoint: 'opening', sourceName: 'X' }]) assert.throws(() => setItemDataMapping(mapped, changes), /opening or closing/);
});

test('published storage badges show reconciled stocks and signed accumulation without presenting inventory as throughput', () => {
  const model = storageShowcaseModel(), result = reconcile(model), summary = getPublishedUnitSummary(model.nodes[1], model, result);
  assert.equal(summary.status, 'ready'); assert.equal(summary.heading, 'Storage inventory · kg');
  assert.deepEqual(summary.lines, ['Opening 1,999.286', 'Closing 2,200.714', 'Δ inventory 201.429']);
  assert.ok(summary.incoming > summary.outgoing); assert.ok(summary.bounds.top < -120); assert.match(summary.description, /closing − opening/);
  const unresolved = structuredClone(result); unresolved.inventories[0].opening.value = null; unresolved.inventories[0].opening.status = 'unobservable';
  const partial = getPublishedUnitSummary(model.nodes[1], model, unresolved); assert.equal(partial.status, 'unresolved'); assert.equal(partial.lines[0], 'Opening —');
  assert.equal(partial.lines[2], 'Δ inventory 201.429');
  const standalone = { version: 1, name: 'Closed storage', periodHours: 1, nodes: [newNode('tank')], streams: [] };
  standalone.nodes[0].inventory.opening.value = 100; standalone.nodes[0].inventory.closing.value = 90;
  const closed = getPublishedUnitSummary(standalone.nodes[0], standalone, reconcile(standalone));
  assert.equal(closed.status, 'ready'); assert.equal(closed.incoming, 0); assert.equal(closed.outgoing, 0);
  assert.deepEqual(closed.lines, ['Opening 95.000', 'Closing 95.000', 'Δ inventory 0.000']);
});

test('inventory result table preserves signed discharge, unobservable values, and escaped model names', () => {
  const html = inventoryResultsHtml([{ id: '<unit>', name: '<Tank>', opening: { raw: 100, value: 100, uncertainty: 1, status: 'measured' }, closing: { raw: 90, value: 90, uncertainty: 1, status: 'measured' }, accumulation: { raw: -10, value: -10, uncertainty: 1.414, status: 'measured' } }]);
  assert.ok(html.includes('Negative means inventory decreased') && html.includes('>-10</td>'));
  assert.ok(!html.includes('<Tank>') && html.includes('&lt;Tank&gt;'));
  const missing = inventoryResultsHtml([{ id: 'unit', name: 'Tank', opening: { value: null, status: 'unobservable' } }]); assert.ok(missing.includes('Needs measurement') && !missing.includes('NaN'));
  assert.equal(inventoryResultsHtml([]), '');
});
