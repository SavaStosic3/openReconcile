import { measurementToMass, validateModel } from './model.js';
import { evaluateMeterDetails, getMeterName, isVirtualMeter } from './virtual-meters.js';
import { isStorageNode, validateInventory, inventoryToMass, inventoryCapacityMass } from './inventory.js';

// This solver handles total mass over one interval, fixed density conversions,
// first-order correlated meter/inventory errors, exact conservation, and bounded
// nonnegative streams and inventories. Opening/closing inventories are edges
// into/out of a storage node; accumulation is their difference, never an extra
// independent observation.
// Unmeasured streams have no objective term. A representative of a nonunique
// solution is used internally, but never exposed as an inferred measurement.
const EPS = Number.EPSILON;
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = a => Math.hypot(...a);
const project = (row, values) => row.terms.reduce((sum, term) => sum + term.coefficient * values[term.index], 0);

// For a virtual formula y_i=f_i(y_refs), the linearized error is
// e_i=delta_y_i-sum(df_i/dy_j * delta_y_j). The configured calculation
// uncertainty describes independent e_i. Whiten these innovations directly:
// this is generalized least squares with the full propagated covariance, but
// avoids forming/inverting a nearly singular dense covariance matrix.
function measurementNoiseRows(measurements, details, sigmaScale) {
  const byId = new Map(measurements.map(measurement => [measurement.id, measurement]));
  return measurements.map(measurement => {
    const scale = sigmaScale / measurement.independentSigma;
    const terms = [{ index: measurement.index, coefficient: scale }];
    let target = measurement.value * scale;
    for (const [id, derivative] of details.get(measurement.id).derivatives) {
      const reference = byId.get(id);
      const coefficient = -derivative * measurement.factor / reference.factor * scale;
      terms.push({ index: reference.index, coefficient });
      target += coefficient * reference.value;
    }
    if (!Number.isFinite(target) || terms.some(term => !Number.isFinite(term.coefficient))) throw new Error('The formula and uncertainty scales make the numerical problem ill-conditioned. Check formulas and uncertainties.');
    return { terms, target };
  });
}

function orthonormalize(vectors) {
  const basis = [];
  for (const input of vectors) {
    const v = [...input];
    // Two passes limit the loss of orthogonality in dependent process networks.
    for (let pass = 0; pass < 2; pass++) for (const q of basis) {
      const projection = dot(q, v);
      for (let i = 0; i < v.length; i++) v[i] -= projection * q[i];
    }
    const length = norm(v);
    if (length > 128 * EPS * Math.max(1, v.length)) basis.push(v.map(x => x / length));
  }
  return basis;
}

function nullSpace(rows, columns) {
  const a = rows.map(row => [...row]);
  const pivots = [];
  let pivotRow = 0;
  const tolerance = 128 * EPS * Math.max(1, rows.length, columns);
  for (let col = 0; col < columns && pivotRow < a.length; col++) {
    let best = pivotRow;
    for (let row = pivotRow + 1; row < a.length; row++) if (Math.abs(a[row][col]) > Math.abs(a[best][col])) best = row;
    if (Math.abs(a[best][col]) <= tolerance) continue;
    [a[pivotRow], a[best]] = [a[best], a[pivotRow]];
    const pivot = a[pivotRow][col];
    for (let j = col; j < columns; j++) a[pivotRow][j] /= pivot;
    for (let row = 0; row < a.length; row++) if (row !== pivotRow) {
      const factor = a[row][col];
      if (Math.abs(factor) <= tolerance) { a[row][col] = 0; continue; }
      for (let j = col; j < columns; j++) a[row][j] -= factor * a[pivotRow][j];
      a[row][col] = 0;
    }
    pivots.push(col);
    pivotRow++;
  }
  const pivotSet = new Set(pivots), vectors = [];
  for (let col = 0; col < columns; col++) if (!pivotSet.has(col)) {
    const v = Array(columns).fill(0); v[col] = 1;
    for (let row = 0; row < pivots.length; row++) v[pivots[row]] = -a[row][col];
    vectors.push(v);
  }
  return { basis: orthonormalize(vectors), rank: pivots.length };
}

// Householder QR with column pivoting. The second projection selects the
// minimum-norm correction in flat (unmeasured) directions; it is not evidence
// that those directions have identifiable values.
function leastSquares(matrix, rhs, columns) {
  const m = matrix.length, n = columns;
  const a = matrix.map(row => [...row]), b = [...rhs];
  const permutation = Array.from({ length: n }, (_, i) => i);
  let initialNorm = 0;
  for (let j = 0; j < n; j++) initialNorm = Math.max(initialNorm, norm(a.map(row => row[j])));
  const tolerance = 128 * EPS * Math.max(1, m, n) * initialNorm;
  let rank = 0;
  for (let j = 0; j < Math.min(m, n); j++) {
    let best = j, bestNorm = 0;
    for (let col = j; col < n; col++) {
      const length = norm(a.slice(j).map(row => row[col]));
      if (length > bestNorm) { bestNorm = length; best = col; }
    }
    if (bestNorm <= tolerance || bestNorm === 0) break;
    if (best !== j) {
      for (const row of a) [row[j], row[best]] = [row[best], row[j]];
      [permutation[j], permutation[best]] = [permutation[best], permutation[j]];
    }
    const alpha = a[j][j] >= 0 ? -bestNorm : bestNorm;
    const v = a.slice(j).map(row => row[j]); v[0] -= alpha;
    const vn = norm(v);
    for (let i = 0; i < v.length; i++) v[i] /= vn;
    for (let col = j; col < n; col++) {
      let projection = 0;
      for (let i = j; i < m; i++) projection += v[i - j] * a[i][col];
      for (let i = j; i < m; i++) a[i][col] -= 2 * v[i - j] * projection;
    }
    let projection = 0;
    for (let i = j; i < m; i++) projection += v[i - j] * b[i];
    for (let i = j; i < m; i++) b[i] -= 2 * v[i - j] * projection;
    a[j][j] = alpha;
    for (let i = j + 1; i < m; i++) a[i][j] = 0;
    rank++;
  }
  const triangularSolve = target => {
    const z = Array(rank).fill(0);
    for (let i = rank - 1; i >= 0; i--) {
      let value = target[i];
      for (let j = i + 1; j < rank; j++) value -= a[i][j] * z[j];
      z[i] = value / a[i][i];
    }
    return z;
  };
  const pivoted = Array(n).fill(0);
  const leading = triangularSolve(b.slice(0, rank));
  for (let i = 0; i < rank; i++) pivoted[i] = leading[i];
  const nullVectors = [];
  for (let j = rank; j < n; j++) {
    const v = Array(n).fill(0); v[j] = 1;
    const leadingNull = triangularSolve(Array.from({ length: rank }, (_, i) => -a[i][j]));
    for (let i = 0; i < rank; i++) v[i] = leadingNull[i];
    nullVectors.push(v);
  }
  const pivotedNull = orthonormalize(nullVectors);
  for (const v of pivotedNull) {
    const projection = dot(v, pivoted);
    for (let i = 0; i < n; i++) pivoted[i] -= projection * v[i];
  }
  const unpermute = v => {
    const output = Array(n).fill(0);
    for (let i = 0; i < n; i++) output[permutation[i]] = v[i];
    return output;
  };
  return {
    solution: unpermute(pivoted), rank, nullBasis: pivotedNull.map(unpermute),
    variance(row) {
      // For an observable coordinate a, a^T z is independent of null(B).
      // Its variance under unit whitened noise is ||R11^{-T} a1||^2.
      const permuted = permutation.map(i => row[i]), u = Array(rank).fill(0);
      for (let i = 0; i < rank; i++) {
        let value = permuted[i];
        for (let j = 0; j < i; j++) value -= a[j][i] * u[j];
        u[i] = value / a[i][i];
      }
      return dot(u, u);
    }
  };
}

function graphModel(model, inventoryVariables = []) {
  const internal = model.nodes.filter(n => n.kind !== 'inlet' && n.kind !== 'outlet');
  const internalIndex = new Map(internal.map((n, i) => [n.id, i]));
  const boundary = internal.length;
  const edges = model.streams.map(s => ({ from: internalIndex.get(s.source) ?? boundary, to: internalIndex.get(s.target) ?? boundary }));
  for (const variable of inventoryVariables) edges.push(variable.endpoint === 'opening'
    ? { from: boundary, to: internalIndex.get(variable.node.id) }
    : { from: internalIndex.get(variable.node.id), to: boundary });
  const a = internal.map((_, row) => edges.map(e => (e.to === row ? 1 : 0) - (e.from === row ? 1 : 0)));
  const adjacency = Array.from({ length: internal.length + 1 }, () => []);
  edges.forEach((edge, index) => adjacency[edge.from].push({ to: edge.to, index }));
  const reachable = (start, end, skip = -1, arcs = adjacency) => {
    if (start === end) return true;
    const seen = new Set([start]), queue = [start];
    for (let at = 0; at < queue.length; at++) for (const arc of arcs[queue[at]]) {
      if (arc.index === skip || seen.has(arc.to)) continue;
      if (arc.to === end) return true;
      seen.add(arc.to); queue.push(arc.to);
    }
    return false;
  };
  // In a homogeneous directed network a positive feasible flow is a sum of
  // cycles (all external boundaries are collapsed to the reservoir node).
  const viable = edges.map((e, i) => reachable(e.to, e.from, i));
  const upper = [...model.streams.map(() => Infinity), ...inventoryVariables.map(variable => variable.capacity)];
  return { internal, a, edges, upper, vertices: adjacency.length, viable, reachable };
}

function solveOnFace(a, free, x, noiseRows) {
  if (!free.length) return Array(x.length).fill(0);
  const space = nullSpace(a.map(row => free.map(i => row[i])), free.length).basis;
  if (!space.length) return Array(x.length).fill(0);
  const index = new Map(free.map((i, j) => [i, j]));
  const b = noiseRows.map(row => space.map(v => row.terms.reduce((sum, term) => sum + (index.has(term.index) ? term.coefficient * v[index.get(term.index)] : 0), 0)));
  const target = noiseRows.map(row => row.target - project(row, x));
  const ls = leastSquares(b, target, space.length);
  const correction = Array(x.length).fill(0);
  for (let j = 0; j < free.length; j++) for (let k = 0; k < space.length; k++) correction[free[j]] += space[k][j] * ls.solution[k];
  return correction;
}

function negativeCycle(graph, x, gradient) {
  const arcs = [];
  const scales = new Map();
  gradient.forEach((value, i) => {
    if (graph.viable[i]) {
      const component = graph.edgeComponent[i];
      scales.set(component, Math.max(scales.get(component) || 0, Math.abs(value)));
    }
  });
  if (![...scales.values()].some(value => value > 0)) return null;
  graph.edges.forEach((e, index) => {
    if (!graph.viable[index]) return;
    const scale = scales.get(graph.edgeComponent[index]);
    if (!scale) return;
    if (x[index] < graph.upper[index] - graph.tolerance[index]) arcs.push({ from: e.from, to: e.to, index, direction: 1, cost: gradient[index] / scale });
    if (x[index] > graph.tolerance[index]) arcs.push({ from: e.to, to: e.from, index, direction: -1, cost: -gradient[index] / scale });
  });
  const distance = Array(graph.vertices).fill(0), previous = Array(graph.vertices).fill(null);
  let changed = -1;
  const tolerance = 256 * EPS * Math.max(1, graph.vertices);
  for (let pass = 0; pass < graph.vertices; pass++) {
    changed = -1;
    for (const arc of arcs) if (distance[arc.to] > distance[arc.from] + arc.cost + tolerance) {
      distance[arc.to] = distance[arc.from] + arc.cost;
      previous[arc.to] = arc; changed = arc.to;
    }
    if (changed < 0) return null;
  }
  let vertex = changed;
  for (let i = 0; i < graph.vertices; i++) {
    if (!previous[vertex]) return null;
    vertex = previous[vertex].from;
  }
  const start = vertex, cycle = [];
  do {
    const arc = previous[vertex];
    if (!arc || cycle.length > graph.vertices) return null;
    cycle.push(arc); vertex = arc.from;
  } while (vertex !== start);
  const direction = new Map();
  for (const arc of cycle) direction.set(arc.index, (direction.get(arc.index) || 0) + arc.direction);
  for (const [index, d] of direction) if (d === 0) direction.delete(index);
  const cost = [...direction].reduce((sum, [index, d]) => sum + gradient[index] / scales.get(graph.edgeComponent[index]) * d, 0);
  return cost < -tolerance ? direction : null;
}

function nonnegativeFit(graph, noiseRows) {
  const n = graph.edges.length;
  const all = graph.viable.flatMap((value, i) => value ? [i] : []);
  const x = Array(n).fill(0);
  const unconstrained = solveOnFace(graph.a, all, x, noiseRows);
  if (unconstrained.every((value, i) => Number.isFinite(value) && value >= -graph.tolerance[i] && value <= graph.upper[i] + graph.tolerance[i])) return unconstrained.map((value, i) => Math.min(graph.upper[i], Math.max(0, value)));
  for (let iteration = 0; iteration < 3000; iteration++) {
    const gradient = Array(n).fill(0);
    for (const row of noiseRows) {
      const residual = project(row, x) - row.target;
      for (const term of row.terms) gradient[term.index] += term.coefficient * residual;
    }
    const cycle = negativeCycle(graph, x, gradient);
    if (!cycle) return x;
    let curvature = 0, slope = 0, limit = Infinity;
    for (const [i, direction] of cycle) {
      slope += gradient[i] * direction;
      if (direction < 0) limit = Math.min(limit, x[i] / -direction);
      if (direction > 0) limit = Math.min(limit, (graph.upper[i] - x[i]) / direction);
    }
    for (const row of noiseRows) curvature += row.terms.reduce((sum, term) => sum + term.coefficient * (cycle.get(term.index) || 0), 0) ** 2;
    const step = Math.min(-slope / curvature, limit);
    if (!(curvature > 0) || !(step > 0) || !Number.isFinite(step)) throw new Error('The numerical optimizer could not find a reliable nonnegative step.');
    for (const [i, direction] of cycle) x[i] = Math.min(graph.upper[i], Math.max(0, x[i] + step * direction));
    let free = all.filter(i => x[i] > graph.tolerance[i] && x[i] < graph.upper[i] - graph.tolerance[i]);
    // Exact least-squares correction on the current face, with a feasible line
    // search to any new zero bounds. Each truncated step removes a free edge.
    for (let face = 0; face <= n; face++) {
      const direction = solveOnFace(graph.a, free, x, noiseRows);
      let fraction = 1, hit = -1;
      for (const i of free) {
        const candidate = direction[i] < 0 && x[i] + direction[i] < 0 ? x[i] / -direction[i]
          : direction[i] > 0 && x[i] + direction[i] > graph.upper[i] ? (graph.upper[i] - x[i]) / direction[i] : 1;
        if (candidate < fraction) { fraction = candidate; hit = i; }
      }
      for (const i of free) x[i] = Math.min(graph.upper[i], Math.max(0, x[i] + fraction * direction[i]));
      if (hit >= 0) x[hit] = direction[hit] < 0 ? 0 : graph.upper[hit];
      const next = free.filter(i => x[i] > graph.tolerance[i] && x[i] < graph.upper[i] - graph.tolerance[i]);
      if (fraction >= 1 || !next.length) break;
      if (next.length >= free.length) throw new Error('The numerical optimizer stalled at a nonnegative bound.');
      free = next;
    }
  }
  throw new Error('The numerical optimizer did not converge. Check the model and uncertainty scales.');
}

function components(model) {
  const adjacency = new Map(model.nodes.map(n => [n.id, []]));
  for (const s of model.streams) { adjacency.get(s.source).push(s.target); adjacency.get(s.target).push(s.source); }
  const seen = new Set(), nodeComponent = new Map(); let count = 0;
  for (const n of model.nodes) if (!seen.has(n.id)) {
    count++; const queue = [n.id]; seen.add(n.id); nodeComponent.set(n.id, count);
    for (let i = 0; i < queue.length; i++) for (const id of adjacency.get(queue[i])) if (!seen.has(id)) { seen.add(id); nodeComponent.set(id, count); queue.push(id); }
  }
  return { count, nodeComponent, streamComponent: model.streams.map(s => nodeComponent.get(s.source)) };
}

function invalid(message) {
  return { status: 'invalid', message, objective: null, degreesOfFreedom: 0, streams: [], inventories: [], balances: [], warnings: [] };
}

function inventoryNoiseRows(inventoryGroups, sigmaScale) {
  const rows = [];
  for (const { node, opening, closing } of inventoryGroups) {
    if (opening && closing) {
      const a = opening.independentSigma, b = closing.independentSigma;
      const d = opening.densityContribution, e = closing.densityContribution;
      const r = Number(node.inventory.readingCorrelation ?? 0), openingSigma = opening.sigma;
      const coefficient = r * (a / openingSigma) * (b / openingSigma) + (d / openingSigma) * (e / openingSigma);
      // This factored Schur complement avoids subtracting two nearly equal
      // variances when density dominates both correlated inventories.
      const conditionalSigma = Math.hypot(b * Math.sqrt(1 - r * r), b * r * (d / openingSigma) - e * (a / openingSigma));
      const firstScale = sigmaScale / openingSigma, secondScale = sigmaScale / conditionalSigma;
      rows.push({ terms: [{ index: opening.index, coefficient: firstScale }], target: opening.value * firstScale });
      rows.push({ terms: [{ index: closing.index, coefficient: secondScale }, { index: opening.index, coefficient: -coefficient * secondScale }], target: (closing.value - coefficient * opening.value) * secondScale });
    } else for (const measurement of [opening, closing].filter(Boolean)) {
      const scale = sigmaScale / measurement.sigma;
      rows.push({ terms: [{ index: measurement.index, coefficient: scale }], target: measurement.value * scale });
    }
  }
  if (rows.some(row => !Number.isFinite(row.target) || row.terms.some(term => !Number.isFinite(term.coefficient)))) throw new Error('Inventory correlation or uncertainty scales make the numerical problem ill-conditioned.');
  return rows;
}

export function reconcile(model) {
  try {
    validateModel(model);
    const storageNodes = model.nodes.filter(isStorageNode);
    storageNodes.forEach(node => validateInventory(node.inventory, node.name, { requireReadings: true }));
    if (!model.nodes.length || !model.streams.length && !storageNodes.length) return invalid('Add process units and connected flows before reconciling.');
    const connectivity = components(model);
    const inventoryVariables = storageNodes.flatMap(node => ['opening', 'closing'].map(endpoint => ({ node, endpoint, capacity: inventoryCapacityMass(node.inventory) })));
    const graph = { ...graphModel(model, inventoryVariables), edgeComponent: [...connectivity.streamComponent, ...inventoryVariables.map(variable => connectivity.nodeComponent.get(variable.node.id))] }, measurements = [], byIndex = new Map(), warnings = [];
    const details = evaluateMeterDetails(model);
    model.streams.forEach((s, index) => {
      if (!s.measured) return;
      const reading = details.get(s.id);
      if (reading.error) throw new Error(`${getMeterName(s)}: ${reading.error}`);
      const converted = measurementToMass({ ...s, value: reading.value }, model.periodHours);
      if (!Number.isFinite(converted.value) || !Number.isFinite(converted.sigma) || !(converted.sigma > 0)) throw new Error(`${s.name}: converted mass and uncertainty must be finite.`);
      const sigma = reading.sigma * converted.factor;
      if (!Number.isFinite(sigma) || !(sigma > 0)) throw new Error(`${getMeterName(s)}: propagated uncertainty must be positive and finite.`);
      const measurement = { id: s.id, index, ...converted, independentSigma: converted.sigma, sigma }; measurements.push(measurement); byIndex.set(index, measurement);
    });
    const streamMeasurements = [...measurements], inventoryGroups = storageNodes.map(node => ({ node }));
    inventoryVariables.forEach((variable, offset) => {
      if (!variable.node.inventory[variable.endpoint].measured) return;
      const index = model.streams.length + offset;
      const converted = inventoryToMass(variable.node.inventory, variable.endpoint, `${variable.node.name} ${variable.endpoint}`);
      const measurement = { index, ...converted };
      measurements.push(measurement); byIndex.set(index, measurement);
      inventoryGroups[Math.floor(offset / 2)][variable.endpoint] = measurement;
    });
    // Bound tolerances follow each physical component's mass scale instead of
    // imposing a fixed kg cutoff. Finite small inventories also retain their
    // own capacity scale. Positive returned masses are never rounded to zero.
    const massScales = new Map();
    for (const measurement of measurements) {
      const component = graph.edgeComponent[measurement.index];
      massScales.set(component, Math.max(massScales.get(component) ?? 0, measurement.value));
    }
    const capacityScales = new Map();
    graph.upper.forEach((capacity, i) => {
      if (Number.isFinite(capacity)) capacityScales.set(graph.edgeComponent[i], Math.min(capacityScales.get(graph.edgeComponent[i]) ?? Infinity, capacity));
    });
    graph.tolerance = graph.edges.map((_, i) => {
      const componentScale = massScales.get(graph.edgeComponent[i]) || capacityScales.get(graph.edgeComponent[i]) || 1;
      const measurement = byIndex.get(i), readingScale = measurement ? measurement.value || measurement.independentSigma : Infinity;
      return 128 * EPS * Math.max(1, graph.vertices) * Math.min(componentScale, graph.upper[i], readingScale);
    });
    const sigmaScale = measurements.length ? Math.min(...measurements.map(m => m.independentSigma)) : 1;
    const noiseRows = [...measurementNoiseRows(streamMeasurements, details, sigmaScale), ...inventoryNoiseRows(inventoryGroups, sigmaScale)];
    const viable = graph.viable.flatMap((value, i) => value ? [i] : []);
    const restricted = nullSpace(graph.a.map(row => viable.map(i => row[i])), viable.length);
    const base = restricted.basis.map(v => {
      const embedded = Array(graph.edges.length).fill(0);
      viable.forEach((index, j) => { embedded[index] = v[j]; }); return embedded;
    });
    const measuredRows = measurements.map(m => base.map(v => v[m.index]));
    const unweightedRank = leastSquares(measuredRows, measurements.map(() => 0), base.length).rank;
    const whitened = noiseRows.map(row => base.map(v => project(row, v)));
    const decomposition = leastSquares(whitened, noiseRows.map(row => row.target), base.length);
    if (decomposition.rank !== unweightedRank) return invalid('The uncertainty scales make the numerical problem ill-conditioned. Check uncertainties before using results.');
    const values = nonnegativeFit(graph, noiseRows);
    if (values.some((v, i) => !Number.isFinite(v) || v < -graph.tolerance[i] || v > graph.upper[i] + graph.tolerance[i])) return invalid('The numerical optimizer returned an unreliable flow or inventory. Results were withheld.');
    for (const row of graph.a) {
      const residual = dot(row, values), magnitude = row.reduce((sum, coefficient, i) => sum + Math.abs(coefficient * values[i]), 0);
      if (!Number.isFinite(residual) || !Number.isFinite(magnitude)) return invalid('Conservation exceeds the supported numerical range. Results were withheld.');
      if (Math.abs(residual) > 1e-7 * magnitude) return invalid('Conservation could not be satisfied within numerical tolerance. Results were withheld.');
    }
    const objective = noiseRows.reduce((sum, row) => sum + ((project(row, values) - row.target) / sigmaScale) ** 2, 0);
    if (!Number.isFinite(objective)) return invalid('The objective overflowed. Check measurement and uncertainty scales.');
    const degreesOfFreedom = measurements.length - decomposition.rank;
    const missingArcs = Array.from({ length: graph.vertices }, () => []);
    graph.edges.forEach((e, i) => {
      if (byIndex.has(i) || !graph.viable[i]) return;
      if (values[i] < graph.upper[i] - graph.tolerance[i]) missingArcs[e.from].push({ to: e.to, index: i });
      if (values[i] > graph.tolerance[i]) missingArcs[e.to].push({ to: e.from, index: i });
    });
    // Formula references can correlate different physical process components.
    // A bound in one then affects Gaussian covariance in that entire group.
    const correlated = new Map(graph.edgeComponent.map(component => [component, component]));
    const group = component => {
      while (correlated.get(component) !== component) component = correlated.get(component);
      return component;
    };
    for (const row of noiseRows) for (const term of row.terms.slice(1)) {
      const first = group(graph.edgeComponent[row.terms[0].index]);
      const other = group(graph.edgeComponent[term.index]);
      correlated.set(other, first);
    }
    const boundComponents = new Set();
    let unobservableCount = 0, inventoryUnobservableCount = 0;
    const entries = graph.edges.map((_, i) => {
      const measurement = byIndex.get(i), row = base.map(v => v[i]);
      const linearObservable = decomposition.nullBasis.every(v => Math.abs(dot(v, row)) < 1e-8);
      const e = graph.edges[i];
      const canVary = !measurement && !linearObservable && (
        (values[i] < graph.upper[i] - graph.tolerance[i] && graph.reachable(e.to, e.from, i, missingArcs)) ||
        (values[i] > graph.tolerance[i] && graph.reachable(e.from, e.to, i, missingArcs))
      );
      if (canVary) {
        if (i < model.streams.length) unobservableCount++; else inventoryUnobservableCount++;
        return { raw: null, value: null, sigma: null, correction: null, normalizedCorrection: null, uncertainty: null, status: 'unobservable' };
      }
      const value = Math.max(0, values[i]);
      // An edge outside every directed cycle is identically zero by linear
      // conservation plus network topology. That is distinct from a clamp at
      // the boundary of an otherwise feasible flow and does not invalidate
      // Gaussian covariance elsewhere in the connected process.
      const atBound = graph.viable[i] && (value <= graph.tolerance[i] || value >= graph.upper[i] - graph.tolerance[i]);
      if (atBound || !linearObservable) boundComponents.add(group(graph.edgeComponent[i]));
      const variance = linearObservable ? decomposition.variance(row) * sigmaScale ** 2 : null;
      const uncertainty = !atBound && variance !== null && Number.isFinite(variance) ? Math.sqrt(Math.max(0, variance)) : null;
      return {
        raw: measurement?.value ?? null, value, sigma: measurement?.sigma ?? null,
        correction: measurement ? value - measurement.value : null,
        normalizedCorrection: measurement ? (value - measurement.value) / measurement.sigma : null,
        uncertainty, status: measurement ? 'measured' : 'estimated', atBound
      };
    });
    if (boundComponents.size) entries.forEach((entry, i) => {
      if (boundComponents.has(group(graph.edgeComponent[i]))) entry.uncertainty = null;
    });
    const streams = model.streams.map((stream, i) => ({ id: stream.id, ...entries[i] }));
    const inventories = storageNodes.map((node, offset) => {
      const openingIndex = model.streams.length + offset * 2, closingIndex = openingIndex + 1;
      const opening = entries[openingIndex], closing = entries[closingIndex];
      const row = base.map(v => v[closingIndex] - v[openingIndex]);
      const linearObservable = decomposition.nullBasis.every(v => Math.abs(dot(v, row)) < 1e-8);
      const identifiable = linearObservable || opening.value !== null && closing.value !== null;
      const pair = inventoryGroups[offset], bothMeasured = Boolean(pair.opening && pair.closing);
      const raw = bothMeasured ? pair.closing.value - pair.opening.value : null;
      const r = Number(node.inventory.readingCorrelation ?? 0);
      const sigma = bothMeasured ? Math.hypot(pair.closing.independentSigma - r * pair.opening.independentSigma, pair.opening.independentSigma * Math.sqrt(1 - r * r), pair.closing.densityContribution - pair.opening.densityContribution) : null;
      if (sigma !== null && (!Number.isFinite(sigma) || !(sigma > 0))) throw new Error(`${node.name}: accumulated inventory uncertainty exceeds the supported numerical range.`);
      const value = identifiable ? values[closingIndex] - values[openingIndex] : null;
      const variance = linearObservable ? decomposition.variance(row) * sigmaScale ** 2 : null;
      const uncertainty = !boundComponents.has(group(graph.edgeComponent[openingIndex])) && variance !== null && Number.isFinite(variance) ? Math.sqrt(Math.max(0, variance)) : null;
      // Recover covariance from Var(closing−opening), preserving correlations
      // induced by conservation as well as the original inventory instruments.
      const covarianceValue = opening.uncertainty !== null && closing.uncertainty !== null && uncertainty !== null
        ? 0.5 * opening.uncertainty ** 2 + 0.5 * closing.uncertainty ** 2 - 0.5 * uncertainty ** 2 : null;
      const covariance = covarianceValue !== null && Number.isFinite(covarianceValue) ? covarianceValue : null;
      return {
        id: node.id, name: node.name, basis: node.inventory.basis, unit: node.inventory.unit,
        capacityMass: Number.isFinite(graph.upper[openingIndex]) ? graph.upper[openingIndex] : null,
        opening, closing, covariance,
        accumulation: { raw, value, sigma, correction: bothMeasured && value !== null ? value - raw : null, normalizedCorrection: bothMeasured && value !== null && sigma > 0 ? (value - raw) / sigma : null, uncertainty: identifiable ? uncertainty : null, status: identifiable ? bothMeasured ? 'measured' : 'estimated' : 'unobservable', atBound: opening.atBound || closing.atBound || false }
      };
    });
    const balances = graph.internal.map((node, row) => {
      const coefficients = graph.a[row];
      const complete = coefficients.every((coefficient, i) => coefficient === 0 || byIndex.has(i));
      const inventory = inventories.find(entry => entry.id === node.id);
      return { id: node.id, name: node.name, raw: complete ? coefficients.reduce((sum, c, i) => sum + c * (byIndex.get(i)?.value ?? 0), 0) : null, reconciled: dot(coefficients, values), ...(inventory ? { accumulation: inventory.accumulation.value, rawAccumulation: inventory.accumulation.raw, opening: inventory.opening.value, closing: inventory.closing.value } : {}) };
    });
    if (!measurements.length) warnings.push(storageNodes.length ? 'No flows or inventories are measured. Conservation alone cannot determine throughput or absolute stock; add independent measurements.' : 'No streams are measured. Conservation alone may determine only zero flows; add measurements to estimate throughput.');
    if (unobservableCount) warnings.push(`${unobservableCount} unmeasured stream${unobservableCount === 1 ? ' is' : 's are'} not uniquely identifiable. Add independent measurements or revise the topology; no arbitrary estimates are shown.`);
    if (inventoryUnobservableCount) warnings.push(`${inventoryUnobservableCount} unmeasured inventor${inventoryUnobservableCount === 1 ? 'y is' : 'ies are'} not uniquely identifiable. Net accumulation can still be identifiable; absolute stock requires independent inventory evidence.`);
    const forcedZero = graph.viable.slice(0, model.streams.length).filter(v => !v).length;
    if (forcedZero) warnings.push(`${forcedZero} stream${forcedZero === 1 ? ' cannot' : 's cannot'} carry nonzero flow in this steady-state topology. Check missing boundary connections or inventory changes.`);
    if (connectivity.count > 1) warnings.push('The model has disconnected components. Conservation is enforced within each connected process.');
    if (streamMeasurements.some(m => model.streams[m.index].metric.startsWith('volume'))) warnings.push('Stream densities are fixed conversion inputs. Density uncertainty and shared stream density-input correlations are not modeled.');
    if (storageNodes.some(node => node.inventory.basis !== 'mass')) warnings.push('Inventory conversions use fixed geometry and first-order propagated reading/density uncertainty. A tank’s opening and closing share its density error; separate tanks and stream density inputs are independent.');
    if (storageNodes.some(node => node.inventory.basis === 'level' && node.inventory.geometry.kind === 'calibration')) warnings.push('Calibration tables use local piecewise-linear slopes at raw levels. Uncertainty near a calibration breakpoint may be non-Gaussian; no extrapolation is allowed.');
    if (model.streams.some(isVirtualMeter)) warnings.push('Virtual meter uncertainties include first-order propagated reference errors and independent calculation error. Formula relations are linearized at raw readings; they are not exact constraints on reconciled flows.');
    if (boundComponents.size) warnings.push('One or more flows or inventories are determined at a nonnegative or capacity bound. Reconciled uncertainties are withheld for the affected connected process; Gaussian uncertainty and chi-square assumptions may not hold.');
    if (degreesOfFreedom === 0 && measurements.length) warnings.push('There is no independent measurement redundancy. Exact closure alone cannot test the measurements for consistency.');
    if (degreesOfFreedom > 0) {
      // Wilson-Hilferty approximation to the 99% chi-square quantile. This is a
      // global inconsistency flag under the stated Gaussian interior model,
      // not identification of a particular faulty meter.
      const threshold = degreesOfFreedom * (1 - 2 / (9 * degreesOfFreedom) + 2.326347874 * Math.sqrt(2 / (9 * degreesOfFreedom))) ** 3;
      if (objective > threshold) warnings.push('The overall disagreement is larger than expected under the stated uncertainties. Check readings, units, timing, inventory changes and unmodeled paths; this does not identify a bad meter.');
    }
    const status = unobservableCount || inventoryUnobservableCount ? 'underdetermined' : warnings.length ? 'warning' : 'ok';
    return {
      status,
      message: unobservableCount || inventoryUnobservableCount ? 'Observable flows and inventories are reconciled; some missing values remain undetermined.' : warnings.length ? 'Reconciliation completed. Review the model and data warnings.' : 'Reconciliation completed with exact modeled mass conservation.',
      objective, degreesOfFreedom, streams, inventories, balances, warnings
    };
  } catch (error) { return invalid(error instanceof Error ? error.message : 'The model could not be reconciled.'); }
}
