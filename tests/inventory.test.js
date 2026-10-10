import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultInventory, isStorageNode, validateInventory, inventoryToMass, inventoryVolumeAtLevel, inventoryCapacityMass, inventoryMeasurementCovariance } from '../public/inventory.js';

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`);
const inventory = extra => ({ ...defaultInventory(), opening: { measured: true, value: 10, uncertainty: 0.5, uncertaintyType: 'absolute' }, closing: { measured: true, value: 12, uncertainty: 0.5, uncertaintyType: 'absolute' }, ...extra });

test('storage defaults have independent editable endpoints and both storage kinds are recognized', () => {
  const first = defaultInventory(), second = defaultInventory('bulkStorage');
  first.opening.value = 9;
  assert.equal(first.closing.value, ''); assert.equal(second.opening.value, '');
  assert.equal(second.geometry.kind, 'constantArea');
  assert.equal(isStorageNode({ kind: 'tank' }), true);
  assert.equal(isStorageNode({ kind: 'bulkStorage' }), true);
  assert.equal(isStorageNode({ kind: 'process' }), false);
});

test('mass inventory conversion includes tonne and percent uncertainty without interval integration', () => {
  const config = inventory({ unit: 't' });
  config.opening.uncertainty = 2; config.opening.uncertaintyType = 'percent';
  const result = inventoryToMass(config, 'opening');
  near(result.value, 10000); near(result.sigma, 200); near(result.factor, 1000);
  assert.equal(result.densityContribution, 0);
});

test('volume inventories propagate both reading error and shared density error', () => {
  const config = inventory({ basis: 'volume', unit: 'L', density: 800, densityUncertainty: 10 });
  config.opening.value = 2000; config.opening.uncertainty = 20;
  config.closing.value = 2500; config.closing.uncertainty = 30;
  const opening = inventoryToMass(config, 'opening'), closing = inventoryToMass(config, 'closing');
  near(opening.value, 1600); near(opening.independentSigma, 16); near(opening.densityContribution, 20);
  near(opening.sigma, Math.hypot(16, 20));
  near(inventoryMeasurementCovariance(config, opening, closing), 500);
  config.readingCorrelation = -0.25;
  near(inventoryMeasurementCovariance(config, opening, closing), 500 - 0.25 * 16 * 24);
});

test('vertical cylinder and area conversions use m/cm/mm and local level derivatives', () => {
  const cylinder = inventory({ basis: 'level', unit: 'cm', density: 900, geometry: { kind: 'verticalCylinder', diameter: 2 } });
  cylinder.opening.value = 200; cylinder.opening.uncertainty = 1;
  const converted = inventoryToMass(cylinder, 'opening');
  near(converted.value, 1800 * Math.PI); near(converted.independentSigma, 9 * Math.PI);
  const area = inventory({ basis: 'level', unit: 'mm', geometry: { kind: 'constantArea', area: 4 } });
  area.opening.value = 500; area.opening.uncertainty = 5;
  near(inventoryToMass(area, 'opening').value, 2000);
  near(inventoryToMass(area, 'opening').sigma, 20);
});

test('monotone calibrated levels interpolate and enforce the table range without extrapolation', () => {
  const geometry = { kind: 'calibration', points: [{ level: 0, volume: 0 }, { level: 1, volume: 2 }, { level: 3, volume: 8 }] };
  assert.deepEqual(inventoryVolumeAtLevel(geometry, 0.5), { volume: 1, derivative: 2 });
  assert.deepEqual(inventoryVolumeAtLevel(geometry, 1), { volume: 2, derivative: 3 });
  assert.deepEqual(inventoryVolumeAtLevel(geometry, 3), { volume: 8, derivative: 3 });
  assert.throws(() => inventoryVolumeAtLevel(geometry, 3.01), /extrapolation/);
  const config = inventory({ basis: 'level', unit: 'm', density: 800, geometry });
  config.opening.value = 2; config.closing.value = 3;
  near(inventoryToMass(config, 'opening').value, 4000);
  near(inventoryToMass(config, 'opening').factor, 2400);
  near(inventoryCapacityMass(config), 6400);
  config.capacityMass = 6000; near(inventoryCapacityMass(config), 6000);
});

test('calibration shape and uncertain-density calibration are rejected explicitly', () => {
  for (const points of [[], [{ level: 0, volume: 0 }], [{ level: 1, volume: 0 }, { level: 2, volume: 2 }], [{ level: 0, volume: 1 }, { level: 2, volume: 2 }], [{ level: 0, volume: 0 }, { level: 1, volume: 2 }, { level: 1, volume: 3 }], [{ level: 0, volume: 0 }, { level: 1, volume: 2 }, { level: 2, volume: 1 }]]) {
    assert.throws(() => validateInventory(inventory({ basis: 'level', unit: 'm', geometry: { kind: 'calibration', points } })));
  }
  const config = inventory({ basis: 'level', unit: 'm', geometry: { kind: 'calibration', points: [{ level: 0, volume: 0 }, { level: 20, volume: 20 }] }, densityUncertainty: 0.5 });
  assert.throws(() => validateInventory(config), /fixed density/);
});

test('blank and invalid scalar reading drafts are saveable but never runnable observations', () => {
  const config = defaultInventory();
  assert.equal(validateInventory(config), config);
  assert.throws(() => validateInventory(config, 'Tank', { requireReadings: true }), /enter an inventory reading/);
  config.opening.value = 'bad'; config.opening.uncertainty = '';
  assert.equal(validateInventory(config, 'Tank', { allowDraftReadings: true }), config);
  assert.throws(() => validateInventory(config), /positive inventory uncertainty/);
  config.opening.value = {}; assert.throws(() => validateInventory(config, 'Tank', { allowDraftReadings: true }), /scalar/);
});

test('unused unmeasured endpoint uncertainty is never treated as data or required evidence', () => {
  const config = inventory(); config.opening.measured = false; config.opening.value = ''; config.opening.uncertainty = '';
  assert.equal(validateInventory(config, 'Tank', { requireReadings: true }), config);
  config.opening.uncertainty = {}; assert.throws(() => validateInventory(config), /scalar/);
});

test('nonnegative inventories, zero percent errors, invalid correlations and numeric overflow are rejected', () => {
  for (const extra of [{ basis: 'unknown' }, { unit: 'm' }, { density: 0 }, { densityUncertainty: -1 }, { readingCorrelation: 1 }, { readingCorrelation: -1 }, { capacityMass: 0 }, { basis: 'level', unit: 'm', geometry: { kind: 'verticalCylinder', diameter: 0 } }]) assert.throws(() => validateInventory(inventory(extra)));
  const config = inventory(); config.opening.value = -1;
  assert.throws(() => validateInventory(config), /nonnegative/);
  config.opening.value = 0; config.opening.uncertaintyType = 'percent';
  assert.throws(() => validateInventory(config), /absolute uncertainty/);
  config.opening.value = 1e308; config.unit = 't';
  assert.throws(() => inventoryToMass(config, 'opening'), /numerical range/);
});
