import { defaultInventory, inventoryToMass, isStorageNode, validateInventory } from './inventory.js';

export const INVENTORY_UNITS = { mass: ['kg', 't'], volume: ['m³', 'L'], level: ['m', 'cm', 'mm'] };
export const INVENTORY_LABELS = { mass: 'Mass inventory', volume: 'Volume inventory', level: 'Level inventory' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const format = value => !Number.isFinite(value) ? '—' : value !== 0 && Math.abs(value) < 0.001 ? value.toExponential(3) : new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(value);
const number = field => field.value === '' ? '' : Number(field.value);

export function parseCalibrationPoints(text) {
  if (typeof text !== 'string') throw new Error('Enter calibration points as level in m, volume in m³.');
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const columns = line.split(',').map(value => value.trim());
    if (columns.length !== 2 || columns.some(value => !value || !Number.isFinite(Number(value)))) throw new Error(`Calibration row ${index + 1}: enter two numbers, level in m and volume in m³.`);
    return { level: Number(columns[0]), volume: Number(columns[1]) };
  });
}

export function inventoryFromForm(form, current) {
  const fields = form.elements, inventory = structuredClone(current || defaultInventory());
  inventory.basis = fields.inventoryBasis.value;
  inventory.unit = fields.inventoryUnit.value;
  inventory.density = inventory.basis === 'mass' ? inventory.density : number(fields.inventoryDensity);
  inventory.densityUncertainty = inventory.basis === 'mass' ? inventory.densityUncertainty ?? 0 : number(fields.inventoryDensityUncertainty);
  inventory.readingCorrelation = number(fields.inventoryCorrelation);
  inventory.capacityMass = fields.inventoryCapacity.value === '' ? null : Number(fields.inventoryCapacity.value);
  const kind = fields.inventoryGeometry.value;
  if (inventory.basis === 'level') inventory.geometry = kind === 'calibration' ? { kind, points: parseCalibrationPoints(fields.inventoryCalibration.value) } : kind === 'constantArea' ? { kind, area: number(fields.inventoryArea) } : { kind, diameter: number(fields.inventoryDiameter) };
  for (const endpoint of ['opening', 'closing']) {
    const title = endpoint === 'opening' ? 'Opening' : 'Closing';
    inventory[endpoint] = { ...inventory[endpoint], measured: fields[`inventory${title}Measured`].checked, value: number(fields[`inventory${title}Value`]), uncertainty: number(fields[`inventory${title}Uncertainty`]), uncertaintyType: fields[`inventory${title}UncertaintyType`].value };
    const sourceName = fields[`inventory${title}Source`].value.trim();
    if (sourceName) inventory[endpoint].dataMapping = { sourceName }; else delete inventory[endpoint].dataMapping;
  }
  validateInventory(inventory, fields.name.value.trim() || 'Storage unit', { allowDraftReadings: true });
  return inventory;
}

export function fillInventoryForm(form, configured) {
  const defaults = defaultInventory(), inventory = { ...defaults, ...configured, geometry: configured?.geometry || defaults.geometry }, fields = form.elements;
  fields.inventoryBasis.value = inventory.basis;
  fields.inventoryUnit.replaceChildren(...INVENTORY_UNITS[inventory.basis].map(unit => new Option(unit, unit)));
  fields.inventoryUnit.value = inventory.unit;
  fields.inventoryDensity.value = inventory.density;
  fields.inventoryDensityUncertainty.value = inventory.densityUncertainty ?? 0;
  fields.inventoryCorrelation.value = inventory.readingCorrelation ?? 0;
  fields.inventoryCapacity.value = inventory.capacityMass ?? '';
  fields.inventoryGeometry.value = inventory.geometry.kind;
  fields.inventoryDiameter.value = inventory.geometry.diameter ?? 2;
  fields.inventoryArea.value = inventory.geometry.area ?? 1;
  fields.inventoryCalibration.value = (inventory.geometry.points || [{ level: 0, volume: 0 }, { level: 1, volume: 1 }]).map(point => `${point.level}, ${point.volume}`).join('\n');
  for (const endpoint of ['opening', 'closing']) {
    const title = endpoint === 'opening' ? 'Opening' : 'Closing', reading = inventory[endpoint];
    fields[`inventory${title}Measured`].checked = reading.measured;
    fields[`inventory${title}Value`].value = reading.value ?? '';
    fields[`inventory${title}Uncertainty`].value = reading.uncertainty;
    fields[`inventory${title}UncertaintyType`].value = reading.uncertaintyType;
    fields[`inventory${title}Source`].value = reading.dataMapping?.sourceName || '';
  }
}

export function inventoryMassHtml(inventory, endpoint, name) {
  if (!inventory?.[endpoint]?.measured) return '<span class="muted">Inferred if observable</span>';
  try {
    const mass = inventoryToMass(inventory, endpoint, name);
    return `<strong>${format(mass.value)} kg</strong><small>σ ${format(mass.sigma)} kg</small>`;
  } catch (error) {
    return `<span class="reading-error" title="${esc(error.message)}">${inventory[endpoint].value === '' || inventory[endpoint].value === null ? 'Reading needed' : 'Check inventory settings'}</span>`;
  }
}

export function inventoryRowsHtml(model) {
  return (model?.nodes || []).filter(isStorageNode).flatMap(node => ['opening', 'closing'].map(endpoint => {
    const reading = node.inventory[endpoint], label = `${node.name} ${endpoint} inventory`, title = endpoint === 'opening' ? 'Opening' : 'Closing';
    return `<tr data-inventory-node="${esc(node.id)}" data-inventory-endpoint="${endpoint}"><td><button type="button" class="stream-name-button" data-edit-inventory="${esc(node.id)}">${esc(node.name)}</button><small>${title} · at reporting-period ${endpoint === 'opening' ? 'start' : 'end'}</small></td><td>${esc(INVENTORY_LABELS[node.inventory.basis])}<small>${esc(node.inventory.unit)}</small></td><td><label class="inventory-measured-toggle"><input type="checkbox" data-inventory-field="measured" ${reading.measured ? 'checked' : ''} aria-label="${esc(label)} measured"><span>${reading.measured ? 'Measured' : 'Unmeasured'}</span></label></td><td>${reading.measured ? `<input class="number-input" type="number" min="0" step="any" data-inventory-field="value" value="${esc(reading.value)}" aria-label="${esc(label)} reading" placeholder="Enter value">` : '<span class="muted">Inferred if observable</span>'}</td><td>${reading.measured ? `<div class="uncertainty-input"><input class="number-input" type="number" min="0.000001" step="any" data-inventory-field="uncertainty" value="${esc(reading.uncertainty)}" aria-label="${esc(label)} uncertainty"><select data-inventory-field="uncertaintyType" aria-label="${esc(label)} uncertainty format"><option value="absolute" ${reading.uncertaintyType === 'absolute' ? 'selected' : ''}>${esc(node.inventory.unit)}</option><option value="percent" ${reading.uncertaintyType === 'percent' ? 'selected' : ''}>%</option></select></div>` : '—'}</td><td class="inventory-mass-summary">${inventoryMassHtml(node.inventory, endpoint, node.name)}</td></tr>`;
  })).join('');
}

export function inventoryResultsHtml(inventories = []) {
  if (!inventories.length) return '';
  return `<div class="table-heading"><h2>Storage inventory results</h2><span class="helper">Opening and closing are inventories in kg; accumulation is closing − opening</span></div><div class="table-wrap"><table class="data-table inventory-results-table"><thead><tr><th>Storage unit</th><th>Quantity</th><th>Input kg</th><th>Reconciled kg</th><th>Adjustment kg</th><th>Estimate uncertainty (1σ) kg</th><th>Status</th></tr></thead><tbody>${inventories.flatMap(inventory => ['opening', 'closing', 'accumulation'].map(endpoint => {
    const quantity = inventory[endpoint] || {}, label = endpoint[0].toUpperCase() + endpoint.slice(1), status = quantity.status;
    return `<tr><td><button type="button" class="stream-name-button" data-result-inventory="${esc(inventory.id)}">${esc(inventory.name)}</button></td><td>${label}${endpoint === 'accumulation' ? '<small>Negative means inventory decreased</small>' : ''}</td><td class="mono">${format(quantity.raw)}</td><td class="mono result-number">${format(quantity.value)}</td><td class="mono">${Number.isFinite(quantity.correction) && quantity.correction > 0 ? '+' : ''}${format(quantity.correction)}</td><td class="mono">${format(quantity.uncertainty)}${quantity.atBound ? '<small>At physical bound</small>' : ''}</td><td><span class="status-pill ${esc(status || 'unobservable')}">${status === 'unobservable' || !Number.isFinite(quantity.value) ? 'Needs measurement' : quantity.atBound ? 'At physical bound' : status === 'estimated' ? 'Inferred' : 'Reconciled'}</span></td></tr>`;
  })).join('')}</tbody></table></div>`;
}
