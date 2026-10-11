// Exported numbers remain usable, but warnings must travel with their verdict.
// The policy is deliberately conservative: even modeling-assumption warnings
// require downstream review, rather than being silently labeled clean.
export const EXPORT_QUALITY_POLICY = 'conservative-v1';
export const SQL_EXPORT_STATUSES = Object.freeze({
  stream: Object.freeze(['measured', 'estimated', 'measured_questionable', 'estimated_questionable']),
  unit: Object.freeze(['reconciled', 'reconciled_questionable']),
});
const usableStatuses = new Set(['ok', 'warning', 'underdetermined']);

export function exportQuality(run) {
  const result = run?.result;
  if (!result || !usableStatuses.has(result.status)
      || run.status !== undefined && !usableStatuses.has(run.status)
      || !Array.isArray(result.streams) || !Array.isArray(result.warnings)
      || result.warnings.some(warning => typeof warning !== 'string' || !warning.trim())) {
    throw new Error('Only successful reconciliation results with a known quality verdict can be exported.');
  }
  const inputWarnings = ['sql', 'pi'].flatMap(type => (run[type]?.input?.readings ?? [])
    .flatMap(reading => (reading.quality?.warnings ?? []).map(warning => `${reading.sourceName}: ${warning}`)));
  const warnings = [...new Set([...result.warnings, ...inputWarnings])];
  const unobservable = result.streams.some(item => item.status === 'unobservable')
    || (result.inventories ?? []).some(item => ['opening', 'closing', 'accumulation'].some(field => item[field]?.status === 'unobservable'));
  const questionable = result.status !== 'ok' || run.status === 'warning' || run.status === 'underdetermined' || warnings.length > 0 || unobservable;
  return { policy: EXPORT_QUALITY_POLICY, verdict: questionable ? 'questionable' : 'good', reconciliationStatus: result.status, warnings };
}

export function sqlExportStatus(status, itemType, quality) {
  const output = quality.verdict === 'questionable' ? `${status}_questionable` : status;
  if (!SQL_EXPORT_STATUSES[itemType]?.includes(output)) throw new Error('Only observable reconciled results can be exported.');
  return output;
}
