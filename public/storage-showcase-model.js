import { defaultInventory } from './inventory.js';

const endpoint = (value, uncertainty, sourceName) => ({ measured: true, value, uncertainty, uncertaintyType: 'absolute', dataMapping: { sourceName } });
const tank = (id, name, x, basis, unit, opening, closing, uncertainty, extra = {}) => ({
  id, kind: 'tank', name, x, y: 300, dataMapping: { sourceName: `TANKS.${id.toUpperCase()}` },
  inventory: { ...defaultInventory(), basis, unit, capacityMass: 10000, ...extra,
    opening: endpoint(opening, uncertainty, `TANKS.${id.toUpperCase()}.OPENING`),
    closing: endpoint(closing, uncertainty, `TANKS.${id.toUpperCase()}.CLOSING`) }
});
const stream = (id, source, target, name, extra = {}) => ({
  id, source, target, name, material: 'Water', phase: 'Liquid', density: 1000,
  temperature: 20, pressure: 200, metric: 'massFlow', unit: 'kg/h',
  measured: false, value: '', uncertainty: 10, uncertaintyType: 'absolute',
  dataMapping: { sourceName: `TANKS.${id.toUpperCase().replaceAll('-', '_')}` }, ...extra
});

// One-hour analytical reference: feed − product − total accumulation = 10 kg.
// Independent variance is 10² + 10² + 6 × 5² = 350 kg². See the example notes.
const STORAGE_SHOWCASE = {
  version: 1, name: 'Three-tank transfer', periodHours: 1,
  nodes: [
    { id: 'supply', kind: 'inlet', name: 'Water supply', x: 70, y: 300 },
    tank('buffer-a', 'Buffer A · mass', 300, 'mass', 'kg', 2000, 2200, 5),
    { id: 'transfer-pump', kind: 'pump', name: 'Transfer pump', x: 520, y: 300 },
    tank('buffer-b', 'Buffer B · volume', 740, 'volume', 'm³', 3, 3.2, 0.005),
    { id: 'transfer-valve', kind: 'valve', name: 'Transfer valve', x: 960, y: 300 },
    tank('dispatch', 'Dispatch · level', 1180, 'level', 'm', 2, 2.05, 0.0025, { geometry: { kind: 'constantArea', area: 2 } }),
    { id: 'delivery', kind: 'outlet', name: 'Water delivery', x: 1400, y: 300 }
  ],
  streams: [
    stream('supply-flow', 'supply', 'buffer-a', 'F-01 · Supply', { measured: true, meterType: 'physical', meterName: 'WATER SUPPLY', value: 1010 }),
    stream('pump-suction', 'buffer-a', 'transfer-pump', 'F-02 · Pump suction'),
    stream('pump-discharge', 'transfer-pump', 'buffer-b', 'F-03 · Pump discharge'),
    stream('valve-inlet', 'buffer-b', 'transfer-valve', 'F-04 · Valve inlet'),
    stream('valve-outlet', 'transfer-valve', 'dispatch', 'F-05 · Valve outlet'),
    stream('delivery-flow', 'dispatch', 'delivery', 'F-06 · Delivery', { measured: true, meterType: 'physical', meterName: 'WATER DELIVERY', value: 500 })
  ]
};

export function storageShowcaseModel() { return structuredClone(STORAGE_SHOWCASE); }

export function resetStorageShowcaseReadings(model) {
  const reference = storageShowcaseModel();
  for (const node of model.nodes) {
    const preset = reference.nodes.find(item => item.id === node.id && item.kind === node.kind);
    if (!preset?.inventory || !node.inventory) continue;
    // Restore a reading only if its conversion configuration still matches.
    const configuration = inventory => JSON.stringify({ basis: inventory.basis, unit: inventory.unit, density: inventory.density, geometry: inventory.geometry });
    if (configuration(node.inventory) !== configuration(preset.inventory)) continue;
    for (const key of ['opening', 'closing']) if (node.inventory[key].measured) node.inventory[key].value = preset.inventory[key].value;
  }
  for (const item of model.streams) {
    const preset = reference.streams.find(candidate => candidate.id === item.id);
    if (preset?.measured && item.measured && item.meterType !== 'virtual' && item.metric === preset.metric && item.unit === preset.unit) item.value = preset.value;
  }
  return model;
}
