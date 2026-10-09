import { getModelEntry, timeToEpoch, validateEditableModel } from './management-store.js';
import { reconcile } from './solver.js';

const clone = value => structuredClone(value);
const usableStatuses = new Set(['ok', 'warning', 'underdetermined']);

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
  inputAdapters = {}, outputAdapters = {}
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
  const run = {
    id, modelId, modelName: entry.model.name, modelUpdatedAt: entry.updatedAt,
    trigger, startedAt, finishedAt: startedAt,
    inputSourceId: schedule.inputSourceId, outputSourceId: schedule.outputSourceId,
    modelSnapshot: clone(entry.model), result: null, status: 'failed', error: null
  };
  let stage = 'Input';
  try {
    if (run.inputSourceId !== null) {
      const source = sources.find(item => item.id === run.inputSourceId);
      const handler = sourceHandler(source, inputAdapters, 'input');
      const imported = await handler(clone(source), clone(run.modelSnapshot), { modelId });
      run.modelSnapshot = validateEditableModel(imported);
    }
    stage = 'Reconciliation';
    run.result = reconcile(clone(run.modelSnapshot));
    run.status = run.result.status === 'infeasible' ? 'failed' : run.result.status;
    if (!usableStatuses.has(run.result.status)) {
      run.error = run.result.message || 'The model could not be reconciled.';
    } else if (run.outputSourceId !== null) {
      stage = 'Output';
      const source = sources.find(item => item.id === run.outputSourceId);
      const handler = sourceHandler(source, outputAdapters, 'output');
      run.finishedAt = timestamp();
      await handler(clone(source), clone(run), { modelId });
    }
  } catch (error) {
    run.status = 'failed';
    run.error = `${stage} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  run.finishedAt = timestamp();
  if (timeToEpoch(run.finishedAt) < timeToEpoch(run.startedAt)) throw new Error('The execution clock moved before the run start.');
  return { run };
}
