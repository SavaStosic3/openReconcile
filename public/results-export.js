import { exportQuality } from './export-quality.js';

export function resultsCsv(model, result, run = null) {
  // A failed external delivery does not invalidate the computed balance. Keep
  // that run status visible while deriving numerical quality from its result.
  const qualityRun = { ...run, result };
  if (run?.status === 'failed') qualityRun.status = result?.status;
  const quality = exportQuality(qualityRun);
  const cell = value => {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [['Item', 'Item type', 'Quantity', 'Material', 'Input kg', 'Reconciled kg', 'Adjustment kg', 'Standard uncertainty kg', 'Status', 'Period start UTC', 'Period end UTC', 'Period type', 'Model time zone', 'Run ID', 'Rerun of', 'Reconciliation status', 'Result quality', 'Quality policy', 'Warnings', 'Run status']];
  const add = (name, type, quantity, material, value) => rows.push([name, type, quantity, material, value.raw, value.value, value.correction, value.uncertainty, value.status, run?.reportingPeriod?.start, run?.reportingPeriod?.end, run?.reportingPeriod?.kind, run?.reportingPeriod?.timeZone, run?.id, run?.rerunOf, quality.reconciliationStatus, quality.verdict, quality.policy, JSON.stringify(quality.warnings), run?.status ?? result.status]);
  for (const value of result.streams) {
    const stream = model.streams.find(item => item.id === value.id);
    add(stream?.name, 'stream', 'transferred_mass', stream?.material, value);
  }
  for (const inventory of result.inventories ?? []) {
    for (const endpoint of ['opening', 'closing', 'accumulation']) add(inventory.name, 'inventory', endpoint, '', inventory[endpoint] ?? {});
  }
  return rows.map(row => row.map(cell).join(',')).join('\r\n');
}
