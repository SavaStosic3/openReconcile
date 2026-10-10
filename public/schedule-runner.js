import { getModelEntry, timeToEpoch, validateEditableModel } from './management-store.js';
import { reconcile } from './solver.js';
import { evaluateMeterReadings, getMeterName, isVirtualMeter } from './virtual-meters.js';
import { defaultReportingSettings, validateReportingSettings, resolveReportingPeriod } from './reporting-periods.js';
import { validatePiSource } from './pi-sources.js';

const clone = value => structuredClone(value);
const usableStatuses = new Set(['ok', 'warning', 'underdetermined']);

// Keep historical SQL records readable while each connector retains its own
// detached input/output provenance. A run can read one type and write another.
export function connectorInputAudit(run) { return run?.pi?.input ?? run?.sql?.input ?? null; }
export function connectorOutputAudit(run) { return run?.pi?.output ?? run?.sql?.output ?? null; }
const auditedConnector = source => ['sql', 'pi'].includes(source.type);

// Computed virtual values are run audit data, not editable inputs. All physical
// readings, formulas, meter names and other model properties must still match.
export function sameRunInputs(left, right) {
  if (!left || !right || !Array.isArray(left.streams) || !Array.isArray(right.streams)) return false;
  const normalized = model => ({ ...model, streams: model.streams.map(stream => isVirtualMeter(stream) ? { ...stream, value: null } : stream) });
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

// Connector readings replace only this run's detached snapshot. Restore their audited
// saved values when deciding whether results still belong to the current model.
export function runMatchesModelInputs(run, model) {
  if (!run?.modelSnapshot) return false;
  const baseline = clone(run.modelSnapshot);
  if (run.reportingPeriod) baseline.periodHours = run.reportingPeriod.modelPeriodHours;
  const input = connectorInputAudit(run);
  if (input) {
    if (!Array.isArray(input.readings)) return false;
    for (const reading of input.readings) {
      if (reading.itemKind === 'inventory') {
        if (!['opening', 'closing'].includes(reading.endpoint)) return false;
        const node = baseline.nodes?.find(item => item.id === reading.itemId);
        if (!node?.inventory?.[reading.endpoint] || !Object.hasOwn(reading, 'originalValue')) return false;
        node.inventory[reading.endpoint].value = reading.originalValue;
        continue;
      }
      const stream = baseline.streams.find(item => item.id === reading.itemId);
      if (!stream || !Object.hasOwn(reading, 'originalValue')) return false;
      stream.value = reading.originalValue;
    }
  }
  return sameRunInputs(baseline, model);
}

export function runMatchesInputSource(run, sources, schedule) {
  if ((run?.inputSourceId ?? null) !== (schedule?.inputSourceId ?? null)) return false;
  if (run?.inputSourceId == null) return !connectorInputAudit(run);
  if (!Array.isArray(sources)) return false;
  let source = sources.find(item => item.id === run.inputSourceId);
  if (!source) return false;
  // PI quality is mandatory even when a registered source omitted its default
  // settings. Compare the effective policy used for this run, not its spelling.
  if (source.type === 'pi') { try { source = validatePiSource(source); } catch { return false; } }
  if (auditedConnector(source)) {
    const audited = connectorInputAudit(run)?.source;
    return Boolean(audited && Object.keys(audited).length === Object.keys(source).length && Object.keys(source).every(key => Object.hasOwn(audited, key) && JSON.stringify(audited[key]) === JSON.stringify(source[key])));
  }
  return !connectorInputAudit(run);
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
  const context = source => ({ modelId, runId: id, startedAt, window: clone(window), target: run.target ?? 'draft', publishedVersion: run.publishedVersion ?? null,
    recordInputAudit: audit => { run[source.type] ??= {}; run[source.type].input = clone(audit); },
    recordOutputAudit: audit => { run[source.type] ??= {}; run[source.type].output = clone(audit); },
    ...(source.type === 'pi' ? { authorizeOutput: async () => { await beforeOutput(clone(run)); } } : {}) });
  let stage = 'Input';
  try {
    if (run.inputSourceId !== null) {
      const source = sources.find(item => item.id === run.inputSourceId);
      const handler = sourceHandler(source, inputAdapters, 'input');
      const imported = await handler(clone(source), clone(run.modelSnapshot), auditedConnector(source) ? context(source) : { modelId });
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
    const qualityWarnings = [...new Set((connectorInputAudit(run)?.readings ?? []).flatMap(reading => (reading.quality?.warnings ?? []).map(warning => `${reading.sourceName}: ${warning}`)))];
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
      // PI resolves and validates all targets before writing separate events.
      // Its adapter fences each write after those asynchronous metadata reads.
      if (source.type !== 'pi') await beforeOutput(clone(run));
      await handler(clone(source), clone(run), auditedConnector(source) ? context(source) : { modelId });
    }
  } catch (error) {
    run.status = 'failed';
    run.error = `${stage} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  run.finishedAt = timestamp();
  if (timeToEpoch(run.finishedAt) < timeToEpoch(run.startedAt)) throw new Error('The execution clock moved before the run start.');
  return { run };
}
