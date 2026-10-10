import { validateDataMapping } from './data-mapping.js';

export const INVENTORY_BASES = {
  mass: { label: 'Mass inventory', units: ['kg', 't'] },
  volume: { label: 'Volume inventory', units: ['m³', 'L'] },
  level: { label: 'Level inventory', units: ['m', 'cm', 'mm'] }
};

export const isStorageNode = node => ['tank', 'bulkStorage'].includes(node?.kind);

export function defaultInventory(kind = 'tank') {
  const endpoint = () => ({ measured: true, value: '', uncertainty: 1, uncertaintyType: 'absolute' });
  return {
    basis: 'mass', unit: 'kg', density: 1000, densityUncertainty: 0, readingCorrelation: 0,
    geometry: kind === 'bulkStorage' ? { kind: 'constantArea', area: 1 } : { kind: 'verticalCylinder', diameter: 2 },
    capacityMass: null, opening: endpoint(), closing: endpoint()
  };
}

const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value));
const positive = value => numeric(value) && Number(value) > 0;
const nonnegative = value => numeric(value) && Number(value) >= 0;
const blank = value => value === '' || value === null;

function geometryCheck(geometry, name) {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) throw new Error(`${name}: configure a level-to-volume geometry.`);
  if (geometry.kind === 'verticalCylinder') {
    if (!positive(geometry.diameter)) throw new Error(`${name}: cylinder diameter must be positive in metres.`);
    const area = Math.PI * (Number(geometry.diameter) / 2) ** 2;
    if (!Number.isFinite(area) || !(area > 0)) throw new Error(`${name}: cylinder dimensions exceed the supported numerical range.`);
  } else if (geometry.kind === 'constantArea') {
    if (!positive(geometry.area)) throw new Error(`${name}: cross-sectional area must be positive in m².`);
  } else if (geometry.kind === 'calibration') {
    const points = geometry.points;
    if (!Array.isArray(points) || points.length < 2 || points.length > 200) throw new Error(`${name}: use a calibration table containing 2–200 level/volume points.`);
    if (Number(points[0]?.level) !== 0 || Number(points[0]?.volume) !== 0) throw new Error(`${name}: the calibration table must start at zero level and zero volume.`);
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (!point || !nonnegative(point.level) || !nonnegative(point.volume) || i > 0 && (Number(point.level) <= Number(points[i - 1].level) || Number(point.volume) <= Number(points[i - 1].volume))) throw new Error(`${name}: calibration levels (m) and volumes (m³) must increase strictly.`);
      if (i > 0) {
        const slope = (Number(point.volume) - Number(points[i - 1].volume)) / (Number(point.level) - Number(points[i - 1].level));
        if (!Number.isFinite(slope) || !(slope > 0)) throw new Error(`${name}: calibration slopes exceed the supported numerical range.`);
      }
    }
  } else throw new Error(`${name}: select a vertical cylinder, constant area, or calibration table.`);
}

export function validateInventory(inventory, nodeName = 'Storage unit', { allowDraftReadings = false, requireReadings = false } = {}) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) throw new Error(`${nodeName}: configure opening and closing inventories.`);
  const basis = INVENTORY_BASES[inventory.basis];
  if (!basis || !basis.units.includes(inventory.unit)) throw new Error(`${nodeName}: select a valid inventory basis and unit.`);
  if (!positive(inventory.density)) throw new Error(`${nodeName}: density must be positive in kg/m³.`);
  if (!nonnegative(inventory.densityUncertainty ?? 0)) throw new Error(`${nodeName}: density uncertainty must be nonnegative in kg/m³.`);
  if (!numeric(inventory.readingCorrelation ?? 0) || Math.abs(Number(inventory.readingCorrelation ?? 0)) >= 1) throw new Error(`${nodeName}: opening/closing reading correlation must be strictly between −1 and 1.`);
  if (inventory.capacityMass !== undefined && inventory.capacityMass !== null && !positive(inventory.capacityMass)) throw new Error(`${nodeName}: capacity must be positive in kg, or left unset.`);
  if (inventory.basis === 'level' || inventory.geometry !== undefined) geometryCheck(inventory.geometry, nodeName);
  if (inventory.basis === 'level' && inventory.geometry.kind === 'calibration' && Number(inventory.densityUncertainty ?? 0) > 0) throw new Error(`${nodeName}: calibrated level inventories require fixed density. Set density uncertainty to zero or use already converted mass inventory readings.`);
  for (const key of ['opening', 'closing']) {
    const endpoint = inventory[key], name = `${nodeName} ${key}`;
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) || typeof endpoint.measured !== 'boolean' || !['absolute', 'percent'].includes(endpoint.uncertaintyType)) throw new Error(`${name}: configure measured status and a valid inventory uncertainty type.`);
    if (allowDraftReadings || !endpoint.measured) {
      if (!(endpoint.uncertainty === null || typeof endpoint.uncertainty === 'number' && Number.isFinite(endpoint.uncertainty) || typeof endpoint.uncertainty === 'string' && endpoint.uncertainty.length <= 100)) throw new Error(`${name}: enter a scalar inventory uncertainty.`);
    } else if (!positive(endpoint.uncertainty)) throw new Error(`${name}: configure a positive inventory uncertainty.`);
    if (!(endpoint.value === null || typeof endpoint.value === 'number' && Number.isFinite(endpoint.value) || typeof endpoint.value === 'string' && endpoint.value.length <= 100)) throw new Error(`${name}: enter a scalar inventory reading.`);
    validateDataMapping(endpoint.dataMapping, `${nodeName} ${key} inventory`);
    if (!endpoint.measured) continue;
    if (blank(endpoint.value)) {
      if (requireReadings) throw new Error(`${name}: enter an inventory reading or mark it unmeasured.`);
    } else if (!allowDraftReadings) inventoryToMass(inventory, endpoint, name);
  }
  return inventory;
}

// Geometry is fixed. For calibration tables, the uncertainty derivative uses
// the segment containing the raw level (the right segment at an interior knot).
// No extrapolation is performed, including while converting run results.
export function inventoryVolumeAtLevel(geometry, level, nodeName = 'Storage unit') {
  geometryCheck(geometry, nodeName);
  if (!nonnegative(level)) throw new Error(`${nodeName}: level must be nonnegative in metres.`);
  const h = Number(level);
  if (geometry.kind !== 'calibration') {
    const derivative = geometry.kind === 'constantArea' ? Number(geometry.area) : Math.PI * (Number(geometry.diameter) / 2) ** 2;
    const volume = derivative * h;
    if (!Number.isFinite(volume)) throw new Error(`${nodeName}: level conversion exceeds the supported numerical range.`);
    return { volume, derivative };
  }
  const points = geometry.points;
  if (h > Number(points.at(-1).level)) throw new Error(`${nodeName}: level is outside the calibrated range; extrapolation is not allowed.`);
  let i = 1;
  while (i < points.length - 1 && h >= Number(points[i].level)) i++;
  const left = points[i - 1], right = points[i];
  const derivative = (Number(right.volume) - Number(left.volume)) / (Number(right.level) - Number(left.level));
  return { volume: Number(left.volume) + (h - Number(left.level)) * derivative, derivative };
}

export function inventoryCapacityMass(inventory) {
  let capacity = inventory.capacityMass === null || inventory.capacityMass === undefined ? Infinity : Number(inventory.capacityMass);
  if (inventory.basis === 'level' && inventory.geometry?.kind === 'calibration') {
    const calibratedCapacity = Number(inventory.geometry.points.at(-1).volume) * Number(inventory.density);
    if (!Number.isFinite(calibratedCapacity) || !(calibratedCapacity > 0)) throw new Error('Calibrated inventory capacity exceeds the supported numerical range.');
    capacity = Math.min(capacity, calibratedCapacity);
  }
  if (!(capacity > 0) || !Number.isFinite(capacity) && capacity !== Infinity) throw new Error('Inventory capacity exceeds the supported numerical range.');
  return capacity;
}

export function inventoryToMass(inventory, endpoint, nodeName = 'Storage unit') {
  const reading = typeof endpoint === 'string' ? inventory[endpoint] : endpoint;
  const basis = INVENTORY_BASES[inventory.basis];
  if (!basis || !basis.units.includes(inventory.unit) || !reading) throw new Error(`${nodeName}: select a valid inventory reading and unit.`);
  if (inventory.basis === 'level' && inventory.geometry?.kind === 'calibration' && Number(inventory.densityUncertainty ?? 0) > 0) throw new Error(`${nodeName}: calibrated level inventories require fixed density. Set density uncertainty to zero or use already converted mass inventory readings.`);
  if (!nonnegative(reading.value)) throw new Error(`${nodeName}: enter a nonnegative inventory reading.`);
  if (!positive(reading.uncertainty) || !['absolute', 'percent'].includes(reading.uncertaintyType)) throw new Error(`${nodeName}: inventory uncertainty must be greater than zero.`);
  const input = Number(reading.value), inputSigma = reading.uncertaintyType === 'percent' ? input * Number(reading.uncertainty) / 100 : Number(reading.uncertainty);
  if (!(inputSigma > 0)) throw new Error(`${nodeName}: use absolute uncertainty for a zero inventory.`);
  let value, factor, volume = 0;
  if (inventory.basis === 'mass') {
    factor = inventory.unit === 't' ? 1000 : 1;
    value = input * factor;
  } else {
    if (!positive(inventory.density) || !nonnegative(inventory.densityUncertainty ?? 0)) throw new Error(`${nodeName}: configure positive density and nonnegative density uncertainty.`);
    const rho = Number(inventory.density);
    if (inventory.basis === 'volume') {
      const volumeFactor = inventory.unit === 'L' ? 0.001 : 1;
      volume = input * volumeFactor; factor = volumeFactor * rho;
    } else {
      const levelFactor = inventory.unit === 'cm' ? 0.01 : inventory.unit === 'mm' ? 0.001 : 1;
      const converted = inventoryVolumeAtLevel(inventory.geometry, input * levelFactor, nodeName);
      volume = converted.volume; factor = converted.derivative * levelFactor * rho;
    }
    value = volume * rho;
  }
  const independentSigma = inputSigma * factor;
  const densityContribution = volume * Number(inventory.densityUncertainty ?? 0);
  const sigma = Math.hypot(independentSigma, densityContribution);
  if (![value, factor, independentSigma, sigma, densityContribution].every(Number.isFinite) || !(factor > 0) || !(independentSigma > 0) || !(sigma > 0)) throw new Error(`${nodeName}: converted inventory or uncertainty exceeds the supported numerical range.`);
  return { value, sigma, factor, independentSigma, densityContribution, volume, inputSigma };
}

export function inventoryMeasurementCovariance(inventory, opening, closing) {
  const correlation = Number(inventory.readingCorrelation ?? 0);
  return correlation * opening.independentSigma * closing.independentSigma + opening.densityContribution * closing.densityContribution;
}
