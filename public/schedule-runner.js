import { getModelEntry, timeToEpoch, validateEditableModel } from './management-store.js';
import { reconcile } from './solver.js';
import { evaluateMeterReadings, getMeterName, isVirtualMeter } from './virtual-meters.js';
import { defaultReportingSettings, validateReportingSettings, resolveReportingPeriod } from './reporting-periods.js';

const clone = value => structuredClone(value);
const usableStatuses = new Set(['ok', 'warning', 'underdetermined']);

// Computed virtual values are run audit data, not editable inputs. All physical
// readings, formulas, meter names and other model properties must still match.
export function sameRunInputs(left, right) {
  if (!left || !right || !Array.isArray(left.streams) || !Array.isArray(right.streams)) return false;
  const normalized = model => ({ ...model, streams: model.streams.map(stream => isVirtualMeter(stream) ? { ...stream, value: null } : stream) });
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

// SQL readings replace only this run's detached snapshot. Restore their audited
// saved values when deciding whether results still belong to the current model.
export function runMatchesModelInputs(run, model) {
  if (!run?.modelSnapshot) return false;
  const baseline = clone(run.modelSnapshot);
  if (run.reportingPeriod) baseline.periodHours = run.reportingPeriod.modelPeriodHours;
  if (run.sql?.input) {
    if (!Array.isArray(run.sql.input.readings)) return false;
    for (const reading of run.sql.input.readings) {
      const stream = baseline.streams.find(item => item.id === reading.itemId);
      if (!stream || !Object.hasOwn(reading, 'originalValue')) return false;
      stream.value = reading.originalValue;
    }
  }
  return sameRunInputs(baseline, model);
}

export function runMatchesInputSource(run, sources, schedule) {
  if ((run?.inputSourceId ?? null) !== (schedule?.inputSourceId ?? null)) return false;
  if (run?.inputSourceId == null) return !run?.sql?.input;
  if (!Array.isArray(sources)) return false;
  const source = sources.find(item => item.id === run.inputSourceId);
  if (!source) return false;
  if (source.type === 'sql') {
    const audited = run.sql?.input?.source;
    return Boolean(audited && Object.keys(audited).length === Object.keys(source).length && Object.keys(source).every(key => Object.hasOwn(audited, key) && JSON.stringify(audited[key]) === JSON.stringify(source[key])));
  }
  return !run.sql?.input;
}

function sourceHandler(source, adapters, direction) {
  const key = source.adapterKey ?? source.adapter ?? source.type;
  if (typeof key !== 'string' || !key || !adapters || !Object.hasOwn(adapters, key) || typeof adapters[key] !== 'function') {
    throw new Error(`No registered ${direction} handler for source "${source.name}".`);
  }
  return adapters[key];
}

// The host appends this detached record to its latest catalog. Execution never
// selects a model, edits saved readings, advances a schedule, or writes storage.
export async function executeModelRun(catalog, modelId, {
  trigger = 'manual', id = crypto.randomUUID(), now = Date.now,
  inputAdapters = {}, outputAdapters = {}, target, publishedVersion = null,
  beforeOutput = async () => {}, period = null
} = {}) {
  if (!['manual', 'scheduled'].includes(trigger)) throw new Error('A run trigger must be manual or scheduled.');
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) throw new Error('Choose a safe run ID of at most 128 characters.');
  if (typeof now !== 'function') throw new Error('The execution clock must be a function.');

  const snapshot = clone(catalog);
  const entry = getModelEntry(snapshot, modelId);
  const schedule = snapshot.schedules[modelId];
  const sources = snapshot.sources[modelId];
  const timestamp = () => new Date(timeToEpoch(now(), 'Execution clock')).toISOString();
  const startedAt = timestamp();
  const settings = schedule.reporting == null ? defaultReportingSettings(entry.model) : validateReportingSettings(schedule.reporting);
  const reportingPeriod = { ...resolveReportingPeriod(settings, entry.model, startedAt, period), modelPeriodHours: entry.model.periodHours, settings };
  const run = {
    id, modelId, modelName: entry.model.name, modelUpdatedAt: entry.updatedAt,
    trigger, startedAt, finishedAt: startedAt,
    inputSourceId: schedule.inputSourceId, outputSourceId: schedule.outputSourceId,
    modelSnapshot: { ...clone(entry.model), periodHours: reportingPeriod.periodHours }, reportingPeriod,
    result: null, status: 'failed', error: null
  };
  if (target !== undefined) {
    if (!['draft', 'published'].includes(target) || (target === 'published' ? !Number.isSafeInteger(publishedVersion) || publishedVersion < 1 : publishedVersion !== null)) throw new Error('Choose a valid run target and publication version.');
    run.target = target; run.publishedVersion = publishedVersion;
  }
  const window = { start: reportingPeriod.start, end: reportingPeriod.end };
  const context = () => ({ modelId, runId: id, startedAt, window: clone(window), target: run.target ?? 'draft', publishedVersion: run.publishedVersion ?? null,
    recordInputAudit: audit => { run.sql ??= {}; run.sql.input = clone(audit); },
    recordOutputAudit: audit => { run.sql ??= {}; run.sql.output = clone(audit); } });
  let stage = 'Input';
  try {
    if (run.inputSourceId !== null) {
      const source = sources.find(item => item.id === run.inputSourceId);
      const handler = sourceHandler(source, inputAdapters, 'input');
      const imported = await handler(clone(source), clone(run.modelSnapshot), source.type === 'sql' ? context() : { modelId });
      run.modelSnapshot = validateEditableModel(imported);
      run.modelSnapshot.periodHours = reportingPeriod.periodHours;
    }
    stage = 'Reconciliation';
    // Evaluate after input delivery using raw readings from this run, not any
    // client-supplied cached virtual values. Preserve formulas in the audit copy.
    const readings = evaluateMeterReadings(run.modelSnapshot);
    const virtualMeters = run.modelSnapshot.streams.filter(stream => stream.measured && isVirtualMeter(stream));
    for (const stream of virtualMeters) stream.value = readings.get(stream.id)?.value ?? null;
    for (const stream of virtualMeters) {
      const reading = readings.get(stream.id);
      if (reading?.error || reading?.value === null || reading === undefined) {
        throw new Error(`${getMeterName(stream)}: ${reading?.error ?? 'The virtual meter could not be calculated.'}`);
      }
    }
    run.result = reconcile(clone(run.modelSnapshot));
    const qualityWarnings = [...new Set((run.sql?.input?.readings ?? []).flatMap(reading => (reading.quality?.warnings ?? []).map(warning => `${reading.sourceName}: ${warning}`)))];
    if (qualityWarnings.length && usableStatuses.has(run.result.status)) {
      run.result.warnings.push(...qualityWarnings);
      if (run.result.status === 'ok') run.result.status = 'warning';
      run.result.message = 'Reconciliation completed. Review the model and data warnings.';
    }
    run.status = run.result.status === 'infeasible' ? 'failed' : run.result.status;
    if (!usableStatuses.has(run.result.status)) {
      run.error = run.result.message || 'The model could not be reconciled.';
    } else if (run.outputSourceId !== null) {
      stage = 'Output';
      const source = sources.find(item => item.id === run.outputSourceId);
      const handler = sourceHandler(source, outputAdapters, 'output');
      run.finishedAt = timestamp();
      await beforeOutput(clone(run));
      await handler(clone(source), clone(run), source.type === 'sql' ? context() : { modelId });
    }
  } catch (error) {
    run.status = 'failed';
    run.error = `${stage} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  run.finishedAt = timestamp();
  if (timeToEpoch(run.finishedAt) < timeToEpoch(run.startedAt)) throw new Error('The execution clock moved before the run start.');
  return { run };
}
