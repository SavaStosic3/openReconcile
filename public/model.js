import { UNIT_SYMBOLS } from './unit-symbols.js';
import { isVirtualMeter } from './virtual-meters.js';

export const NODE_TYPES = { ...Object.fromEntries(Object.entries(UNIT_SYMBOLS).map(([kind, symbol]) => [kind, symbol.label])), inlet: 'Inflow', outlet: 'Outflow' };
export const METRICS = {
  mass: { label: 'Mass transferred', units: ['kg', 't'], rate: false, volume: false },
  massFlow: { label: 'Mass flow rate', units: ['kg/h', 't/h'], rate: true, volume: false },
  volume: { label: 'Volume transferred', units: ['m³', 'L'], rate: false, volume: true },
  volumeFlow: { label: 'Volume flow rate', units: ['m³/h', 'L/h'], rate: true, volume: true }
};
export const uid = () => crypto.randomUUID();
export function newNode(kind, x = 400, y = 260, count = 1) {
  return { id: uid(), kind, name: `${NODE_TYPES[kind] || 'Process unit'} ${count}`, x, y };
}
export function newStream(source, target, count = 1) {
  return { id: uid(), source, target, name: `F-${String(count).padStart(2, '0')}`, material: 'Process material', phase: 'Liquid', density: 1000, temperature: 20, pressure: 101.325, measured: false, metric: 'mass', unit: 'kg', value: '', uncertainty: 2, uncertaintyType: 'percent' };
}
export function emptyModel() { return { version: 1, name: 'Untitled plant', periodHours: 1, nodes: [], streams: [] }; }
export function exampleModel() {
  const m = emptyModel(); m.name = 'Demo · feed & separation';
  m.nodes = [
    { id: 'feed', kind: 'inlet', name: 'Raw feed', x: 100, y: 260 },
    { id: 'mix', kind: 'mixer', name: 'Feed mixer', x: 350, y: 260 },
    { id: 'split', kind: 'splitter', name: 'Separator', x: 620, y: 260 },
    { id: 'product', kind: 'outlet', name: 'Product', x: 920, y: 140 },
    { id: 'byproduct', kind: 'outlet', name: 'By-product', x: 920, y: 380 }
  ];
  m.streams = [newStream('feed','mix',1), newStream('mix','split',2), newStream('split','product',3), newStream('split','byproduct',4)];
  Object.assign(m.streams[0], { id: 'f1', material: 'Feedstock', measured: true, value: 100, uncertainty: 1, uncertaintyType: 'absolute' });
  Object.assign(m.streams[1], { id: 'f2', material: 'Mixed feed' });
  Object.assign(m.streams[2], { id: 'f3', material: 'Product', measured: true, value: 60, uncertainty: 2, uncertaintyType: 'absolute' });
  Object.assign(m.streams[3], { id: 'f4', material: 'By-product', measured: true, value: 35, uncertainty: 2, uncertaintyType: 'absolute' });
  return m;
}
export function measurementToMass(stream, periodHours) {
  const metric = METRICS[stream.metric];
  if (!metric || !metric.units.includes(stream.unit)) throw new Error(`${stream.name}: select a valid measurement and unit.`);
  if (!Number.isFinite(Number(periodHours)) || Number(periodHours) <= 0) throw new Error('Batch duration must be greater than zero.');
  if (stream.value === '' || stream.value === null || !Number.isFinite(Number(stream.value)) || Number(stream.value) < 0) throw new Error(`${stream.name}: enter a nonnegative measurement.`);
  let factor = stream.unit.startsWith('t') ? 1000 : stream.unit.startsWith('L') ? 0.001 : 1;
  if (metric.rate) factor *= Number(periodHours);
  if (metric.volume) {
    if (!Number.isFinite(Number(stream.density)) || Number(stream.density) <= 0) throw new Error(`${stream.name}: volume measurements require a positive density in kg/m³.`);
    factor *= Number(stream.density);
  }
  const u = Number(stream.uncertainty);
  if (!['absolute','percent'].includes(stream.uncertaintyType) || !Number.isFinite(u) || u <= 0) throw new Error(`${stream.name}: uncertainty must be greater than zero.`);
  const sigma = stream.uncertaintyType === 'percent' ? Math.abs(Number(stream.value)) * u / 100 * factor : u * factor;
  if (!(sigma > 0)) throw new Error(`${stream.name}: use absolute uncertainty for a zero reading.`);
  return { value: Number(stream.value) * factor, sigma, factor };
}
export function validateModel(model) {
  if (!model || model.version !== 1 || !Array.isArray(model.nodes) || !Array.isArray(model.streams)) throw new Error('This file is not a supported plant model.');
  if (model.nodes.length > 200 || model.streams.length > 500) throw new Error('This MVP supports up to 200 units and 500 streams.');
  if (typeof model.name !== 'string' || model.name.length > 160) throw new Error('Use a model name under 160 characters.');
  if (!Number.isFinite(Number(model.periodHours)) || Number(model.periodHours) <= 0) throw new Error('Choose a positive batch duration.');
  const ids = new Set();
  for (const n of model.nodes) {
    if (typeof n.id !== 'string' || ids.has(n.id) || !Object.hasOwn(NODE_TYPES,n.kind) || typeof n.name !== 'string' || n.name.length > 100 || !Number.isFinite(n.x) || !Number.isFinite(n.y) || Math.abs(n.x) > 1e6 || Math.abs(n.y) > 1e6) throw new Error('A process unit has invalid properties.');
    ids.add(n.id);
  }
  const streams = new Set();
  for (const s of model.streams) {
    if (typeof s.id !== 'string' || streams.has(s.id) || !ids.has(s.source) || !ids.has(s.target) || s.source === s.target || typeof s.name !== 'string' || s.name.length > 100 || typeof s.material !== 'string' || s.material.length > 160 || typeof s.measured !== 'boolean') throw new Error('A flow connection has invalid properties.');
    if (!Object.hasOwn(METRICS,s.metric) || !METRICS[s.metric].units.includes(s.unit) || !['Liquid','Gas','Solid','Slurry','Mixed'].includes(s.phase) || !Number.isFinite(Number(s.density)) || Number(s.density) <= 0 || !Number.isFinite(Number(s.uncertainty)) || Number(s.uncertainty) <= 0 || !['absolute','percent'].includes(s.uncertaintyType)) throw new Error('A stream has invalid measurement or material settings.');
    if ((s.meterType !== undefined && !['physical', 'virtual'].includes(s.meterType)) || (s.meterName !== undefined && (typeof s.meterName !== 'string' || s.meterName.length > 100 || /[\[\]]/.test(s.meterName))) || (s.formula !== undefined && (typeof s.formula !== 'string' || s.formula.length > 1000))) throw new Error('A meter has invalid type, name, or formula settings.');
    const source = model.nodes.find(n => n.id === s.source), target = model.nodes.find(n => n.id === s.target);
    if (source.kind === 'outlet' || target.kind === 'inlet') throw new Error('Flows must run from inflows toward outflows.');
    // Incomplete formulas remain saveable drafts; reconciliation evaluates them
    // against fresh readings. A previously cached virtual value is never input.
    if (s.measured && !isVirtualMeter(s) && s.value !== '' && s.value !== null) measurementToMass(s, model.periodHours);
    streams.add(s.id);
  }
  return model;
}
