import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../public/solver.js';
import { defaultInventory } from '../public/inventory.js';

const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`);
const node = (id, kind = 'process') => ({ id, kind, name: id, x: 0, y: 0 });
const endpoint = (value, sigma = 1) => ({ measured: value !== null, value: value ?? '', uncertainty: sigma, uncertaintyType: 'absolute' });
const tank = (id, opening, closing, extra = {}) => ({ ...node(id, 'tank'), inventory: { ...defaultInventory(), opening: endpoint(opening), closing: endpoint(closing), ...extra } });
const stream = (id, source, target, value = null, sigma = 1, extra = {}) => ({ id, source, target, name: id, material: 'Material', phase: 'Liquid', density: 1000, measured: value !== null, metric: 'mass', unit: 'kg', value: value ?? '', uncertainty: sigma, uncertaintyType: 'absolute', ...extra });
const model = (nodes, streams, periodHours = 1) => ({ version: 1, name: 'Storage test', nodes, streams, periodHours });
const line = (storage, feed = 100, product = 40, sigmaFeed = 1, sigmaProduct = 1) => model([node('in', 'inlet'), storage, node('out', 'outlet')], [stream('feed', 'in', storage.id, feed, sigmaFeed), stream('product', storage.id, 'out', product, sigmaProduct)]);
const usable = result => assert.ok(['ok', 'warning', 'underdetermined'].includes(result.status), result.message);
const entry = (result, id) => result.streams.find(row => row.id === id);

// Independent, closed-form GLS oracle for one fully observed finite-period
// tank. This directly inverts its one scalar conservation residual, rather
// than reusing any solver QR/circulation helpers.
function analytical(y, covariance) {
  const a = [1, -1, 1, -1], residual = a.reduce((sum, coefficient, i) => sum + coefficient * y[i], 0);
  const va = covariance.map(row => row.reduce((sum, value, i) => sum + value * a[i], 0));
  const variance = a.reduce((sum, coefficient, i) => sum + coefficient * va[i], 0);
  const adjusted = y.map((value, i) => value - va[i] * residual / variance);
  const fittedCovariance = covariance.map((row, i) => row.map((value, j) => value - va[i] * va[j] / variance));
  return { adjusted, covariance: fittedCovariance, objective: residual * residual / variance };
}

function denseSolve(matrix, rhs) {
  const a = matrix.map((row, i) => [...row, rhs[i]]), n = rhs.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    if (Math.abs(a[pivot][i]) < 1e-10) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const scale = a[i][i];
    for (let k = i; k <= n; k++) a[i][k] /= scale;
    for (let j = 0; j < n; j++) if (j !== i) {
      const factor = a[j][i];
      for (let k = i; k <= n; k++) a[j][k] -= factor * a[i][k];
    }
  }
  return a.map(row => row[n]);
}

// Exhaust all possible lower/upper-bound faces of a four-variable tank and
// solve the Gaussian projection directly on each face. This independent
// oracle checks constrained optimality, not merely balance closure.
function boundedAnalytical(y, covariance, capacity) {
  const bounds = [Infinity, Infinity, capacity, capacity], states = [];
  for (let feed = 0; feed < 2; feed++) for (let product = 0; product < 2; product++) for (let opening = 0; opening < 3; opening++) for (let closing = 0; closing < 3; closing++) states.push([feed, product, opening, closing]);
  let best = null;
  for (const state of states) {
    const a = [[1, -1, 1, -1]], target = [0];
    state.forEach((value, i) => { if (value) { const row = [0, 0, 0, 0]; row[i] = 1; a.push(row); target.push(value === 2 ? bounds[i] : 0); } });
    let x;
    if (a.length === 5) {
      x = target.slice(1);
      if (Math.abs(x[0] - x[1] + x[2] - x[3]) > 1e-9) continue;
    } else {
      const vat = covariance.map(row => a.map(constraint => row.reduce((sum, value, i) => sum + value * constraint[i], 0)));
      const av = a.map(row => a.map((_, j) => row.reduce((sum, coefficient, i) => sum + coefficient * vat[i][j], 0)));
      const residual = a.map((row, i) => row.reduce((sum, coefficient, j) => sum + coefficient * y[j], 0) - target[i]);
      const multiplier = denseSolve(av, residual);
      if (!multiplier) continue;
      x = y.map((value, i) => value - vat[i].reduce((sum, coefficient, j) => sum + coefficient * multiplier[j], 0));
    }
    if (x.some((value, i) => value < -1e-7 || value > bounds[i] + 1e-7)) continue;
    const delta = x.map((value, i) => value - y[i]), determinant = covariance[2][2] * covariance[3][3] - covariance[2][3] ** 2;
    const objective = delta[0] ** 2 / covariance[0][0] + delta[1] ** 2 / covariance[1][1]
      + (delta[2] ** 2 * covariance[3][3] + delta[3] ** 2 * covariance[2][2] - 2 * covariance[2][3] * delta[2] * delta[3]) / determinant;
    if (!best || objective < best.objective) best = { x, objective };
  }
  return best;
}

test('tank finite-period conservation adjusts inventories and flows using their measurement variances', () => {
  const result = reconcile(line(tank('tank', 100, 150)));
  usable(result);
  near(entry(result, 'feed').value, 97.5); near(entry(result, 'product').value, 42.5);
  const inventory = result.inventories[0];
  near(inventory.opening.value, 97.5); near(inventory.closing.value, 152.5); near(inventory.accumulation.value, 55);
  near(inventory.accumulation.raw, 50); near(inventory.accumulation.sigma, Math.sqrt(2));
  near(inventory.opening.uncertainty, Math.sqrt(0.75)); near(inventory.closing.uncertainty, Math.sqrt(0.75));
  near(inventory.covariance, 0.25); near(inventory.accumulation.uncertainty, 1);
  near(result.objective, 25); assert.equal(result.degreesOfFreedom, 1);
  near(result.balances[0].raw, 10); near(result.balances[0].reconciled, 0);
});

test('discharge accumulation is signed and bulk storage follows the same conservation equation', () => {
  const storage = tank('silo', 100, 80); storage.kind = 'bulkStorage';
  const result = reconcile(line(storage, 10, 30)); usable(result);
  near(result.inventories[0].accumulation.value, -20); near(result.objective, 0);
  near(result.balances[0].reconciled, 0);
});

test('a missing endpoint is uniquely inferred without creating an inventory observation', () => {
  const result = reconcile(line(tank('tank', 100, null))); usable(result);
  const inventory = result.inventories[0];
  near(inventory.closing.value, 160); assert.equal(inventory.closing.status, 'estimated');
  assert.equal(inventory.closing.raw, null); near(inventory.closing.uncertainty, Math.sqrt(3));
  near(inventory.accumulation.value, 60); near(inventory.accumulation.uncertainty, Math.sqrt(2));
  assert.equal(inventory.accumulation.raw, null); assert.equal(result.degreesOfFreedom, 0); near(result.objective, 0);
});

test('net accumulation can be identifiable while both absolute endpoint inventories are unknown', () => {
  const result = reconcile(line(tank('tank', null, null))); assert.equal(result.status, 'underdetermined');
  const inventory = result.inventories[0];
  for (const endpoint of [inventory.opening, inventory.closing]) { assert.equal(endpoint.value, null); assert.equal(endpoint.status, 'unobservable'); assert.equal(endpoint.uncertainty, null); }
  near(inventory.accumulation.value, 60); near(inventory.accumulation.uncertainty, Math.sqrt(2));
  assert.equal(inventory.accumulation.status, 'estimated'); near(result.objective, 0);
});

test('an unknown stream is inferred from opening/closing stock and another measured stream', () => {
  const result = reconcile(line(tank('tank', 100, 150), 100, null)); usable(result);
  near(entry(result, 'product').value, 50); near(entry(result, 'product').uncertainty, Math.sqrt(3));
  near(result.inventories[0].accumulation.value, 50); near(result.objective, 0);
});

test('filling and emptying are possible without falsely forcing a tank incident flow to steady-state zero', () => {
  const fill = reconcile(model([node('in', 'inlet'), tank('tank', 100, 160)], [stream('feed', 'in', 'tank', 60)]));
  usable(fill); near(entry(fill, 'feed').value, 60); near(fill.inventories[0].accumulation.value, 60);
  assert.equal(fill.warnings.some(text => text.includes('cannot carry nonzero flow')), false);
  const drain = reconcile(model([tank('tank', 100, 40), node('out', 'outlet')], [stream('product', 'tank', 'out', 60)]));
  usable(drain); near(entry(drain, 'product').value, 60); near(drain.inventories[0].accumulation.value, -60);
});

test('a standalone storage unit reconciles equal opening/closing inventories', () => {
  const result = reconcile(model([tank('tank', 100, 110)], [])); usable(result);
  near(result.inventories[0].opening.value, 105); near(result.inventories[0].closing.value, 105);
  near(result.inventories[0].accumulation.value, 0); near(result.objective, 50);
  assert.equal(result.degreesOfFreedom, 1);
});

test('correlated mass inventory readings match the analytical GLS estimate and covariance', () => {
  const storage = tank('tank', 100, 145, { readingCorrelation: 0.6 });
  storage.inventory.opening.uncertainty = 2; storage.inventory.closing.uncertainty = 3;
  const result = reconcile(line(storage, 100, 40, 4, 5)); usable(result);
  const expected = analytical([100, 40, 100, 145], [[16, 0, 0, 0], [0, 25, 0, 0], [0, 0, 4, 3.6], [0, 0, 3.6, 9]]);
  const actual = [entry(result, 'feed'), entry(result, 'product'), result.inventories[0].opening, result.inventories[0].closing];
  actual.forEach((row, i) => { near(row.value, expected.adjusted[i]); near(row.uncertainty ** 2, expected.covariance[i][i]); });
  near(result.inventories[0].accumulation.uncertainty ** 2, expected.covariance[2][2] + expected.covariance[3][3] - 2 * expected.covariance[2][3]);
  near(result.inventories[0].accumulation.sigma, Math.sqrt(5.8)); near(result.objective, expected.objective);
});

test('shared density covariance is propagated once and accumulation cancels common stock error', () => {
  const storage = tank('tank', 2, 2.06, { basis: 'volume', unit: 'm³', density: 1000, densityUncertainty: 10 });
  storage.inventory.opening.uncertainty = 0.001; storage.inventory.closing.uncertainty = 0.002;
  const result = reconcile(line(storage, 110, 40, 3, 4)); usable(result);
  const expected = analytical([110, 40, 2000, 2060], [[9, 0, 0, 0], [0, 16, 0, 0], [0, 0, 401, 412], [0, 0, 412, 428.36]]);
  const actual = [entry(result, 'feed'), entry(result, 'product'), result.inventories[0].opening, result.inventories[0].closing];
  actual.forEach((row, i) => { near(row.value, expected.adjusted[i]); near(row.uncertainty ** 2, expected.covariance[i][i]); });
  near(result.inventories[0].accumulation.sigma, Math.sqrt(5.36)); near(result.objective, expected.objective);
  assert.ok(result.inventories[0].accumulation.sigma < 3, 'Common density error must not be counted independently twice.');
});

test('joint reading correlation and density covariance produce the analytical solution', () => {
  const storage = tank('tank', 2, 2.06, { basis: 'volume', unit: 'm³', density: 1000, densityUncertainty: 10, readingCorrelation: -0.5 });
  storage.inventory.opening.uncertainty = 0.001; storage.inventory.closing.uncertainty = 0.002;
  const result = reconcile(line(storage, 110, 40, 3, 4)); usable(result);
  const expected = analytical([110, 40, 2000, 2060], [[9, 0, 0, 0], [0, 16, 0, 0], [0, 0, 401, 411], [0, 0, 411, 428.36]]);
  near(result.inventories[0].opening.value, expected.adjusted[2]); near(result.inventories[0].closing.value, expected.adjusted[3]);
  near(result.inventories[0].accumulation.sigma, Math.sqrt(7.36)); near(result.objective, expected.objective);
});

test('known mass capacity constrains inventories and reoptimizes flows rather than clipping results', () => {
  const result = reconcile(line(tank('tank', 90, null, { capacityMass: 100 }), 30, 10)); usable(result);
  near(entry(result, 'feed').value, 30 - 10 / 3); near(entry(result, 'product').value, 10 + 10 / 3);
  near(result.inventories[0].opening.value, 90 - 10 / 3); near(result.inventories[0].closing.value, 100);
  near(result.objective, 100 / 3); near(result.balances[0].reconciled, 0);
  assert.equal(result.inventories[0].closing.atBound, true);
  assert.equal(entry(result, 'feed').uncertainty, null); assert.equal(result.inventories[0].accumulation.uncertainty, null);
});

test('capacity determines an extreme inventory range but keeps interior absolute inventories unknown', () => {
  const interior = reconcile(line(tank('tank', null, null, { capacityMass: 100 }), 100, 40));
  assert.equal(interior.status, 'underdetermined'); assert.equal(interior.inventories[0].opening.value, null); near(interior.inventories[0].accumulation.value, 60);
  const capped = reconcile(line(tank('tank', null, null, { capacityMass: 100 }), 150, 40)); usable(capped);
  near(entry(capped, 'feed').value, 145); near(entry(capped, 'product').value, 45);
  near(capped.inventories[0].opening.value, 0); near(capped.inventories[0].closing.value, 100); near(capped.inventories[0].accumulation.value, 100);
  near(capped.objective, 50); assert.notEqual(capped.status, 'underdetermined');
});

test('100 deterministic bounded correlated cases match independently enumerated constrained GLS optima', () => {
  let seed = 18317;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let sample = 0; sample < 100; sample++) {
    const readings = Array.from({ length: 4 }, () => random() * 150), sigmas = Array.from({ length: 4 }, () => 0.5 + random() * 8);
    const capacity = 10 + random() * 100, correlation = (random() - 0.5) * 1.6;
    const storage = tank('tank', readings[2], readings[3], { capacityMass: capacity, readingCorrelation: correlation });
    storage.inventory.opening.uncertainty = sigmas[2]; storage.inventory.closing.uncertainty = sigmas[3];
    const result = reconcile(line(storage, readings[0], readings[1], sigmas[0], sigmas[1])); usable(result);
    const covariance = [[sigmas[0] ** 2, 0, 0, 0], [0, sigmas[1] ** 2, 0, 0], [0, 0, sigmas[2] ** 2, correlation * sigmas[2] * sigmas[3]], [0, 0, correlation * sigmas[2] * sigmas[3], sigmas[3] ** 2]];
    const expected = boundedAnalytical(readings, covariance, capacity);
    assert.ok(expected);
    [entry(result, 'feed').value, entry(result, 'product').value, result.inventories[0].opening.value, result.inventories[0].closing.value].forEach((value, i) => near(value, expected.x[i], 1e-6));
    near(result.objective, expected.objective, 1e-6); near(result.balances[0].reconciled, 0);
  }
});

test('nonnegative stock prevents impossible negative inferred opening inventory', () => {
  const result = reconcile(line(tank('tank', null, 10), 30, 10)); usable(result);
  near(result.inventories[0].opening.value, 0); near(result.inventories[0].closing.value, 10 + 10 / 3);
  near(entry(result, 'feed').value, 30 - 10 / 3); near(entry(result, 'product').value, 10 + 10 / 3);
  near(result.objective, 100 / 3); near(result.balances[0].reconciled, 0);
});

test('tiny valid mass readings preserve returned flow, stock, accumulation, and balance consistency', () => {
  const storage = tank('tank', 1e-10, 6e-10);
  storage.inventory.opening.uncertainty = 1e-10; storage.inventory.closing.uncertainty = 1e-10;
  const result = reconcile(line(storage, 5e-10, 0, 1e-10, 1e-10)); usable(result);
  const inventory = result.inventories[0];
  assert.ok(inventory.opening.value > 0); assert.ok(inventory.closing.value > 0); assert.ok(entry(result, 'feed').value > 0);
  assert.ok(Math.abs(inventory.opening.value - 1e-10) < 1e-22);
  assert.ok(Math.abs(inventory.closing.value - 6e-10) < 1e-22);
  assert.equal(inventory.accumulation.value, inventory.closing.value - inventory.opening.value);
  assert.ok(Math.abs(entry(result, 'feed').value - entry(result, 'product').value - inventory.accumulation.value) < 1e-22);
  assert.ok(Math.abs(result.balances[0].reconciled) < 1e-22);
});

test('tiny finite capacities still activate the correct bounded optimum', () => {
  const storage = tank('tank', 9e-11, null, { capacityMass: 1e-10 }); storage.inventory.opening.uncertainty = 1e-12;
  const result = reconcile(line(storage, 3e-11, 1e-11, 1e-12, 1e-12)); usable(result);
  const inventory = result.inventories[0];
  assert.ok(Math.abs(inventory.opening.value - (9e-11 - 1e-11 / 3)) < 1e-22);
  assert.ok(Math.abs(inventory.closing.value - 1e-10) < 1e-22);
  assert.ok(Math.abs(entry(result, 'feed').value - (3e-11 - 1e-11 / 3)) < 1e-22);
  assert.ok(Math.abs(entry(result, 'product').value - (1e-11 + 1e-11 / 3)) < 1e-22);
  near(result.objective, (1e-11 / 1e-12) ** 2 / 3); assert.equal(inventory.closing.atBound, true);
});

test('calibration range is a fixed-density upper bound and is enforced on inferred inventories', () => {
  const storage = tank('tank', 90, null, { basis: 'level', unit: 'm', density: 1, geometry: { kind: 'calibration', points: [{ level: 0, volume: 0 }, { level: 100, volume: 100 }] } });
  const result = reconcile(line(storage, 30, 10)); usable(result);
  near(result.inventories[0].capacityMass, 100); near(result.inventories[0].closing.value, 100);
  near(result.balances[0].reconciled, 0);
  storage.inventory.densityUncertainty = 0.5;
  const invalid = reconcile(line(storage)); assert.equal(invalid.status, 'invalid'); assert.match(invalid.message, /fixed density/);
});

test('two tanks transfer mass while keeping each accumulation independent and plant total correct', () => {
  const result = reconcile(model([node('in', 'inlet'), tank('a', 100, 110), tank('b', 100, 90), node('out', 'outlet')], [stream('feed', 'in', 'a', 50), stream('transfer', 'a', 'b', 40), stream('product', 'b', 'out', 50)])); usable(result);
  near(result.inventories[0].accumulation.value, 10); near(result.inventories[1].accumulation.value, -10);
  near(result.inventories.reduce((sum, row) => sum + row.accumulation.value, 0), entry(result, 'feed').value - entry(result, 'product').value);
  for (const row of result.balances) near(row.reconciled, 0);
  assert.equal(result.degreesOfFreedom, 2);
});

test('virtual stream reference correlations are preserved when inventory evidence is added', () => {
  const storage = tank('tank', 100, 100);
  const base = reconcile(line(storage, 100, 90, 1, 3)); usable(base);
  const virtual = reconcile(model([node('in', 'inlet'), storage, node('out', 'outlet'), node('copy', 'outlet')], [stream('feed', 'in', 'tank', 100, 1, { meterName: 'Feed' }), stream('product', 'tank', 'out', 90, 3), stream('duplicate', 'in', 'copy', 0, 0.1, { meterType: 'virtual', formula: '[Feed]', meterName: 'Feed copy' })])); usable(virtual);
  near(entry(virtual, 'feed').value, entry(base, 'feed').value); near(entry(virtual, 'feed').uncertainty, entry(base, 'feed').uncertainty);
  near(virtual.inventories[0].accumulation.value, base.inventories[0].accumulation.value);
});

test('storage conversion uses physical endpoint inventory, not interval-integrated stock', () => {
  const storage = tank('tank', 1, 1.05, { basis: 'volume', unit: 'm³', density: 1000 });
  storage.inventory.opening.uncertainty = 0.001; storage.inventory.closing.uncertainty = 0.001;
  const result = reconcile({ ...line(storage, 30, 10), periodHours: 2, streams: [stream('feed', 'in', 'tank', 30, 1, { metric: 'massFlow', unit: 'kg/h' }), stream('product', 'tank', 'out', 5, 1, { metric: 'massFlow', unit: 'kg/h' })] }); usable(result);
  near(result.inventories[0].opening.raw, 1000); near(result.inventories[0].closing.raw, 1050); near(result.inventories[0].accumulation.value, 50);
  near(result.objective, 0);
});

test('missing or invalid measured inventory observations withhold the entire reconciliation', () => {
  const blank = tank('tank', 100, 110); blank.inventory.opening.value = '';
  const missing = reconcile(line(blank)); assert.equal(missing.status, 'invalid'); assert.equal(missing.streams.length, 0); assert.equal(missing.inventories.length, 0); assert.match(missing.message, /enter an inventory reading/);
  const bad = tank('tank', 0, 110); bad.inventory.opening.uncertaintyType = 'percent';
  assert.equal(reconcile(line(bad)).status, 'invalid');
});
