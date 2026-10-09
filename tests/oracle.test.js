import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../dist/solver.js';

// Independent tiny-network oracle: enumerate every orthant face, solve its
// equality-constrained quadratic stationarity equations directly, then choose
// the feasible candidate with the lowest objective. No production linear
// algebra, conversions, graph decomposition, or optimizer helpers are imported.
// This deliberately uses an exponential algorithm unsuitable for the app.
function solveConsistentSystem(matrix, rhs) {
  const rows = matrix.map((row, i) => [...row, rhs[i]]);
  const n = matrix[0]?.length ?? 0;
  const pivots = [];
  let pivotRow = 0;
  for (let column = 0; column < n && pivotRow < rows.length; column++) {
    let selected = pivotRow;
    for (let i = pivotRow + 1; i < rows.length; i++) {
      if (Math.abs(rows[i][column]) > Math.abs(rows[selected][column])) selected = i;
    }
    if (Math.abs(rows[selected][column]) < 1e-10) continue;
    [rows[pivotRow], rows[selected]] = [rows[selected], rows[pivotRow]];
    const divisor = rows[pivotRow][column];
    for (let j = column; j <= n; j++) rows[pivotRow][j] /= divisor;
    for (let i = 0; i < rows.length; i++) {
      if (i === pivotRow) continue;
      const factor = rows[i][column];
      for (let j = column; j <= n; j++) rows[i][j] -= factor * rows[pivotRow][j];
    }
    pivots.push(column);
    pivotRow++;
  }
  for (let i = pivotRow; i < rows.length; i++) {
    if (Math.abs(rows[i][n]) > 1e-7) return null;
  }
  const result = Array(n).fill(0);
  pivots.forEach((column, row) => { result[column] = rows[row][n]; });
  // Reject numerically inconsistent solutions instead of accepting a lucky
  // singular-system representative as an optimum.
  if (matrix.some((row, i) => Math.abs(row.reduce((s, v, j) => s + v * result[j], 0) - rhs[i]) > 1e-6 * (1 + Math.abs(rhs[i])))) return null;
  return result;
}

function conservation(model) {
  return model.nodes.filter(n => !['inlet', 'outlet'].includes(n.kind)).map(node =>
    model.streams.map(stream => (stream.target === node.id ? 1 : 0) - (stream.source === node.id ? 1 : 0))
  );
}

function exhaustiveOracle(model, measurements) {
  const count = model.streams.length;
  assert.ok(count <= 7, 'Oracle intentionally supports only tiny fixtures.');
  const rows = conservation(model);
  const weight = model.streams.map((s, i) => s.measured ? 1 / measurements[i].sigma ** 2 : 0);
  const observed = model.streams.map((s, i) => s.measured ? measurements[i].value : 0);
  let best = null;
  for (let mask = 0; mask < 2 ** count; mask++) {
    const free = Array.from({ length: count }, (_, i) => i).filter(i => !(mask & (1 << i)));
    const dimension = free.length + rows.length;
    const matrix = Array.from({ length: dimension }, () => Array(dimension).fill(0));
    const rhs = Array(dimension).fill(0);
    for (let i = 0; i < free.length; i++) {
      const index = free[i];
      matrix[i][i] = weight[index];
      rhs[i] = weight[index] * observed[index];
      for (let k = 0; k < rows.length; k++) {
        matrix[i][free.length + k] = rows[k][index];
        matrix[free.length + k][i] = rows[k][index];
      }
    }
    const solution = dimension ? solveConsistentSystem(matrix, rhs) : [];
    if (!solution) continue;
    const values = Array(count).fill(0);
    free.forEach((index, i) => { values[index] = solution[i]; });
    if (values.some(v => v < -1e-7 || !Number.isFinite(v))) continue;
    if (rows.some(row => Math.abs(row.reduce((s, v, i) => s + v * values[i], 0)) > 1e-6)) continue;
    const objective = values.reduce((sum, value, i) => sum + weight[i] * (value - observed[i]) ** 2, 0);
    if (!best || objective < best.objective) best = { values, objective };
  }
  assert.ok(best, 'Every generated fixture has the zero-flow feasible solution.');
  return best;
}

function close(actual, expected, context, tolerance = 3e-7) {
  assert.ok(Number.isFinite(actual), `${context}: expected finite value, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance * (1 + Math.abs(expected)),
    `${context}: actual ${actual}, oracle ${expected}`);
}

function fixture(nodes, connections, values, sigmas, measured = connections.map(() => true)) {
  return {
    version: 1, name: 'Independent oracle fixture', periodHours: 1,
    nodes: nodes.map(([id, kind]) => ({ id, kind, name: id, x: 0, y: 0 })),
    streams: connections.map(([source, target], i) => ({
      id: `s${i}`, source, target, name: `Flow ${i}`, material: 'Test material',
      phase: 'Liquid', density: 1000, temperature: 20, pressure: 101.325,
      measured: measured[i], metric: 'mass', unit: 'kg',
      value: measured[i] ? values[i] : '', uncertainty: sigmas[i], uncertaintyType: 'absolute'
    }))
  };
}

function compare(model, knownMasses = model.streams.map(s => ({ value: Number(s.value), sigma: Number(s.uncertainty) })), context = model.name) {
  const expected = exhaustiveOracle(model, knownMasses);
  const actual = reconcile(model);
  assert.notEqual(actual.status, 'invalid', `${context}: ${actual.message}`);
  close(actual.objective, expected.objective, `${context}: objective`);
  assert.equal(actual.streams.length, model.streams.length);
  model.streams.forEach((stream, i) => {
    const result = actual.streams.find(s => s.id === stream.id);
    assert.ok(result, `${context}: missing stream ${stream.id}`);
    // The objective is strictly convex in measured coordinates. Unmeasured
    // cycles may have multiple equally optimal physical representatives.
    if (stream.measured) close(result.value, expected.values[i], `${context}: ${stream.id}`);
    if (result.value !== null) assert.ok(result.value >= -1e-7, `${context}: negative flow`);
  });
  for (const balance of actual.balances) close(balance.reconciled, 0, `${context}: node ${balance.id}`, 2e-6);
  return { actual, expected };
}

const templates = [
  {
    nodes: [['i','inlet'], ['p','splitter'], ['o1','outlet'], ['o2','outlet']],
    edges: [['i','p'], ['p','o1'], ['p','o2']]
  },
  {
    nodes: [['i','inlet'], ['p','process'], ['q','process'], ['o','outlet']],
    edges: [['i','p'], ['p','q'], ['q','o'], ['p','o'], ['q','p']]
  },
  {
    nodes: [['i1','inlet'], ['i2','inlet'], ['p','mixer'], ['q','splitter'], ['o1','outlet'], ['o2','outlet']],
    edges: [['i1','p'], ['i2','q'], ['p','q'], ['q','p'], ['p','o1'], ['q','o2']]
  },
  {
    nodes: [['i','inlet'], ['p','process'], ['q','process'], ['r','process'], ['o','outlet']],
    edges: [['i','p'], ['p','q'], ['q','r'], ['r','p'], ['r','o'], ['p','o']]
  }
];

test('Independent oracle: 80 deterministic networks, weighted measurements, active bounds, and missing streams', () => {
  let seed = 0x3ef43c29;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  let boundCases = 0, partialCases = 0;
  for (let caseIndex = 0; caseIndex < 80; caseIndex++) {
    const template = templates[caseIndex % templates.length];
    const count = template.edges.length;
    const values = Array.from({ length: count }, () => 1 + 199 * random());
    const sigmas = Array.from({ length: count }, () => .5 + 14.5 * random());
    const measured = Array.from({ length: count }, (_, i) => i === 0 || caseIndex % 2 === 0 || random() > .4);
    const model = fixture(template.nodes, template.edges, values, sigmas, measured);
    const { expected } = compare(model, undefined, `seeded network ${caseIndex}`);
    if (expected.values.some(v => Math.abs(v) < 1e-6)) boundCases++;
    if (measured.some(v => !v)) partialCases++;
  }
  assert.ok(boundCases >= 10, 'Fixtures must exercise nonnegative faces.');
  assert.ok(partialCases >= 20, 'Fixtures must exercise measured/unmeasured networks.');
});

test('Independent oracle: impossible negative split is constrained to a physical zero outlet', () => {
  const { nodes, edges } = templates[0];
  const model = fixture(nodes, edges, [2,100,1], [.5,.5,100]);
  const { actual } = compare(model);
  close(actual.streams[2].value, 0, 'Bound outlet');
  close(actual.streams[0].value, 51, 'Balanced feed');
  close(actual.streams[1].value, 51, 'Balanced product');
});

test('Independent oracle: uncertain recycle remains unreported while measured optimum is unique', () => {
  const model = fixture(
    [['i','inlet'], ['a','process'], ['b','process'], ['o','outlet']],
    [['i','a'], ['a','b'], ['b','a'], ['b','o']],
    [100,0,0,90], [2,1,1,3], [true,false,false,true]
  );
  const { actual } = compare(model);
  close(actual.streams[0].value, 1260 / 13, 'Weighted common throughput');
  close(actual.streams[3].value, 1260 / 13, 'Weighted common throughput');
  for (const stream of actual.streams.slice(1,3)) {
    assert.equal(stream.value, null, 'Recycle does not identify an absolute circulation rate.');
    assert.equal(stream.status, 'unobservable');
  }
});

test('Independent oracle: mixed volume/rate/tonne inputs reconcile to hand-calculated common masses', () => {
  const { nodes, edges } = templates[0];
  const model = fixture(nodes, edges, [.055,30,.06], [.001,.5,.001]);
  model.periodHours = 2;
  Object.assign(model.streams[0], { metric: 'massFlow', unit: 't/h' });
  Object.assign(model.streams[1], { metric: 'volumeFlow', unit: 'L/h', density: 800 });
  Object.assign(model.streams[2], { metric: 'mass', unit: 't' });
  const masses = [{ value: 110, sigma: 2 }, { value: 48, sigma: .8 }, { value: 60, sigma: 1 }];
  const { actual } = compare(model, masses);
  close(actual.streams[0].value, 110 - 8 / 5.64, 'Converted feed');
  close(actual.streams[1].value, 48 + 1.28 / 5.64, 'Converted product');
  close(actual.streams[2].value, 60 + 2 / 5.64, 'Converted byproduct');
});

test('Independent oracle: scale and reordering preserve the physical solution', () => {
  const { nodes, edges } = templates[2];
  const original = fixture(nodes, edges, [105,32,63,18,44,80], [2,9,3,8,.8,4]);
  const base = compare(original).actual;
  const scaled = structuredClone(original);
  scaled.nodes.reverse(); scaled.streams.reverse();
  for (const stream of scaled.streams) { stream.value *= 1000; stream.uncertainty *= 1000; }
  const result = compare(scaled).actual;
  close(result.objective, base.objective, 'Dimensionless objective');
  for (const stream of result.streams) {
    close(stream.value / 1000, base.streams.find(s => s.id === stream.id).value, `Scale invariant ${stream.id}`);
  }
});
