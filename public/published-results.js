const SUCCESSFUL_RESULTS = new Set(['ok', 'warning', 'underdetermined']);
const formatter = new Intl.NumberFormat(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export const formatPublishedMass = value => Number.isFinite(value) ? formatter.format(Object.is(value, -0) ? 0 : value) : '—';
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
  const heading = status === 'awaiting' ? 'Awaiting run' : 'Reconciled · kg/period';
  const lines = status === 'awaiting' ? [] : node.kind === 'inlet'
    ? [`Inflow ${formatPublishedMass(output)}`]
    : node.kind === 'outlet' ? [`Outflow ${formatPublishedMass(input)}`]
      : [`In ${formatPublishedMass(input)}`, `Out ${formatPublishedMass(output)}`];
  const description = status === 'awaiting' ? 'No successful reconciliation is available for this published version.'
    : status === 'unresolved' ? connected.length
      ? 'Unit throughput is unavailable because a connected stream is missing or unobservable. Add independent measurements and reconcile again.'
      : 'Unit throughput is unavailable because this unit has no connected streams.'
    : node.kind === 'inlet' ? `Plant inflow: ${formatPublishedMass(output)} kg per reporting period.`
      : node.kind === 'outlet' ? `Plant outflow: ${formatPublishedMass(input)} kg per reporting period.`
        : `Reconciled incoming mass: ${formatPublishedMass(input)} kg per reporting period. Reconciled outgoing mass: ${formatPublishedMass(output)} kg per reporting period.`;
  const width = Math.max(172, ...[heading, ...lines].map(line => line.length * 7 + 24));
  const height = status === 'awaiting' ? 28 : isBoundary ? 46 : 64;
  const bottom = isBoundary ? -38 : -46;
  return { status, incoming: input, outgoing: output, heading, lines, description, bounds: { left: -width / 2, right: width / 2, top: bottom - height, bottom } };
}
