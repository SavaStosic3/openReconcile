import { isStorageNode } from './inventory.js';
import { createQuantityFormatter } from './quantity-format.js';

const SUCCESSFUL_RESULTS = new Set(['ok', 'warning', 'underdetermined']);
export const formatPublishedMass = createQuantityFormatter({ minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const hasPublishedResults = result => SUCCESSFUL_RESULTS.has(result?.status) && Array.isArray(result.streams);

// Use only the solver's exposed values. A zero mass-balance residual does not
// make unidentified throughput observable, so it cannot supply a unit total.
export function getPublishedUnitSummary(node, model, result) {
  const incoming = model.streams.filter(stream => stream.target === node.id);
  const outgoing = model.streams.filter(stream => stream.source === node.id);
  const connected = [...incoming, ...outgoing];
  const isBoundary = node.kind === 'inlet' || node.kind === 'outlet';
  const values = new Map((result?.streams || []).map(stream => [stream.id, stream]));
  let status = 'ready', input = null, output = null;
  if (!hasPublishedResults(result)) status = 'awaiting';
  else if (!connected.length || connected.some(stream => {
    const value = values.get(stream.id);
    return !value || value.status === 'unobservable' || !Number.isFinite(value.value);
  })) status = 'unresolved';
  else {
    const sum = streams => streams.reduce((total, stream) => total + values.get(stream.id).value, 0);
    input = incoming.length ? sum(incoming) : null;
    output = outgoing.length ? sum(outgoing) : null;
    if ((input !== null && !Number.isFinite(input)) || (output !== null && !Number.isFinite(output))) {
      status = 'unresolved'; input = null; output = null;
    }
  }
  const storage = isStorageNode(node) && Boolean(node.inventory);
  const inventory = storage ? result?.inventories?.find(item => item.id === node.id) : null;
  const observable = quantity => Number.isFinite(quantity?.value) && quantity.status !== 'unobservable' ? quantity.value : null;
  const opening = observable(inventory?.opening), closing = observable(inventory?.closing), accumulation = observable(inventory?.accumulation);
  if (storage && status !== 'awaiting' && !connected.length && [opening, closing, accumulation].every(value => value !== null)) { status = 'ready'; input = 0; output = 0; }
  if (storage && status !== 'awaiting' && [opening, closing, accumulation].some(value => value === null)) status = 'unresolved';
  const heading = status === 'awaiting' ? 'Awaiting run' : storage ? 'Storage inventory · kg' : 'Reconciled · kg/period';
  const lines = status === 'awaiting' ? [] : storage ? [`Opening ${formatPublishedMass(opening)}`, `Closing ${formatPublishedMass(closing)}`, `Δ inventory ${formatPublishedMass(accumulation)}`] : node.kind === 'inlet'
    ? [`Inflow ${formatPublishedMass(output)}`]
    : node.kind === 'outlet' ? [`Outflow ${formatPublishedMass(input)}`]
      : [`In ${formatPublishedMass(input)}`, `Out ${formatPublishedMass(output)}`];
  const description = status === 'awaiting' ? 'No successful reconciliation is available for this published version.'
    : storage ? `Reconciled opening inventory: ${formatPublishedMass(opening)} kg. Closing inventory: ${formatPublishedMass(closing)} kg. Accumulation (closing − opening): ${formatPublishedMass(accumulation)} kg over the reporting period. Incoming mass: ${formatPublishedMass(input)} kg; outgoing mass: ${formatPublishedMass(output)} kg.${status === 'unresolved' ? ' Some inventories or connected stream totals are unobservable; add independent measurements.' : ''}`
    : status === 'unresolved' ? connected.length
      ? 'Unit throughput is unavailable because a connected stream is missing or unobservable. Add independent measurements and reconcile again.'
      : 'Unit throughput is unavailable because this unit has no connected streams.'
    : node.kind === 'inlet' ? `Plant inflow: ${formatPublishedMass(output)} kg per reporting period.`
      : node.kind === 'outlet' ? `Plant outflow: ${formatPublishedMass(input)} kg per reporting period.`
        : `Reconciled incoming mass: ${formatPublishedMass(input)} kg per reporting period. Reconciled outgoing mass: ${formatPublishedMass(output)} kg per reporting period.`;
  const width = Math.max(172, ...[heading, ...lines].map(line => line.length * 7 + 24));
  const height = status === 'awaiting' ? 28 : storage ? 82 : isBoundary ? 46 : 64;
  const bottom = isBoundary ? -38 : -46;
  return { status, incoming: input, outgoing: output, heading, lines, description, ...(storage ? { opening, closing, accumulation } : {}), bounds: { left: -width / 2, right: width / 2, top: bottom - height, bottom } };
}
