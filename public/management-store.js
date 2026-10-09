import { validateModel } from './model.js';

export const CATALOG_VERSION = 1;
export const MAX_RUN_HISTORY = 100;
const MINUTE_MS = 60_000;
const DIRECTIONS = new Set(['input', 'output', 'both']);
const RUN_STATUSES = new Set(['ok', 'warning', 'underdetermined', 'invalid', 'failed']);

// Persistence, source adapters and execution belong to the host. These helpers
// return detached JSON data, take explicit IDs/clocks, and never mutate inputs.
function copy(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Stored data must contain finite JSON values.');
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined) throw new Error('Stored data must be plain JSON.');
    return item;
  }));
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function validId(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) {
    throw new Error(`${label} must be a nonempty, safe identifier of at most 128 characters.`);
  }
  return value;
}

export function timeToEpoch(value, label = 'Time') {
  // Bare dates/local datetime strings are deliberately rejected. Offset/Z times
  // preserve the same instant across server time zones and daylight saving time.
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} must be epoch milliseconds or an ISO timestamp with a time zone.`);
  }
  const epoch = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(epoch) || epoch < -62_167_219_200_000 || epoch > 253_402_300_799_999 || !Number.isFinite(new Date(epoch).getTime())) throw new Error(`${label} is not a valid timestamp.`);
  if (typeof value === 'string') {
    const day = Number(value.slice(8, 10)), month = Number(value.slice(5, 7)), year = Number(value.slice(0, 4));
    const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth || Number(value.slice(11, 13)) > 23) throw new Error(`${label} is not a valid timestamp.`);
  }
  return epoch;
}

const iso = (value, label) => new Date(timeToEpoch(value, label)).toISOString();

// Invalid scalar readings/uncertainties are editable drafts, not ready-to-run measurements.
// The solver still calls validateModel on the original data at execution time.
export function validateEditableModel(model) {
  if (!record(model) || !Array.isArray(model.streams)) return validateModel(model);
  const draft = copy(model);
  for (const stream of draft.streams) {
    if (!record(stream) || typeof stream.measured !== 'boolean' || ![stream.value, stream.uncertainty].every(value => value === null || typeof value === 'string' || typeof value === 'number')) throw new Error('A flow connection has an invalid editable measurement.');
  }
  validateModel({ ...draft, streams: draft.streams.map(stream => ({ ...stream, measured: false, uncertainty: 1 })) });
  return draft;
}

export function frequencyToMinutes(value, unit = 'minutes') {
  const factor = { minutes: 1, hours: 60, days: 1440 }[unit];
  if (!factor || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Choose a positive frequency in minutes, hours, or days.');
  const minutes = value * factor;
  if (minutes < 1 || !Number.isSafeInteger(minutes * MINUTE_MS)) throw new Error('Scheduling frequency must be at least one minute and fit a whole number of milliseconds.');
  return minutes;
}

export function defaultSchedule() {
  return { enabled: false, intervalMinutes: 60, inputSourceId: null, outputSourceId: null, nextRunAt: null };
}

function sourceRef(value, sources, direction) {
  if (value === null) return null;
  validId(value, `${direction} source ID`);
  const source = sources.find(item => item.id === value);
  if (!source || ![direction, 'both'].includes(source.direction)) throw new Error(`Choose a registered ${direction} source for this model.`);
  return value;
}

export function validateSchedule(schedule, sources = []) {
  if (!record(schedule) || typeof schedule.enabled !== 'boolean') throw new Error('A schedule must specify whether it is enabled.');
  frequencyToMinutes(schedule.intervalMinutes);
  const normalized = {
    enabled: schedule.enabled,
    intervalMinutes: schedule.intervalMinutes,
    inputSourceId: sourceRef(schedule.inputSourceId, sources, 'input'),
    outputSourceId: sourceRef(schedule.outputSourceId, sources, 'output'),
    nextRunAt: schedule.nextRunAt === null ? null : iso(schedule.nextRunAt, 'Next run')
  };
  if (normalized.enabled && normalized.nextRunAt === null) throw new Error('An enabled schedule needs a next run timestamp.');
  if (!normalized.enabled && normalized.nextRunAt !== null) throw new Error('A disabled schedule must have no next run timestamp.');
  return normalized;
}

function normalizedSource(source) {
  if (!record(source)) throw new Error('A source must be a registered source record.');
  validId(source.id, 'Source ID');
  if (typeof source.name !== 'string' || !source.name.trim() || source.name.length > 160 || !DIRECTIONS.has(source.direction)) throw new Error('A source needs a name and an input, output, or both direction.');
  return copy(source);
}

function normalizedRun(run, modelId) {
  if (!record(run)) throw new Error('A run must be a run record.');
  validId(run.id, 'Run ID');
  if (run.modelId !== undefined && run.modelId !== modelId) throw new Error('The run belongs to a different model.');
  if (!RUN_STATUSES.has(run.status)) throw new Error('Choose a supported run status.');
  const trigger = run.trigger ?? 'manual';
  if (!['manual', 'scheduled'].includes(trigger)) throw new Error('A run trigger must be manual or scheduled.');
  if (run.target !== undefined) {
    // Historical schedules ran the editable model before snapshots existed.
    // New scheduled API requests enforce published targets at their boundary.
    if (!['draft', 'published'].includes(run.target)) throw new Error('Choose a valid draft or published run target.');
    if (run.target === 'published' ? !Number.isSafeInteger(run.publishedVersion) || run.publishedVersion < 1 : run.publishedVersion !== null) throw new Error('A run must identify its published version, or null for a draft.');
  }
  const startedAt = iso(run.startedAt, 'Run start'), finishedAt = iso(run.finishedAt, 'Run finish');
  if (timeToEpoch(finishedAt) < timeToEpoch(startedAt)) throw new Error('A run cannot finish before it starts.');
  for (const key of ['inputSourceId', 'outputSourceId']) if (run[key] !== undefined && run[key] !== null) validId(run[key], 'Run source ID');
  return { ...copy(run), modelId, trigger, startedAt, finishedAt };
}

export function validateCatalog(catalog) {
  if (!record(catalog) || catalog.version !== CATALOG_VERSION || !Array.isArray(catalog.models) || !record(catalog.schedules) || !record(catalog.sources) || !record(catalog.runs)) throw new Error('This is not a supported model catalog.');
  const result = { version: CATALOG_VERSION, activeId: catalog.activeId, models: [], schedules: {}, sources: {}, runs: {} };
  const ids = new Set();
  for (const entry of catalog.models) {
    if (!record(entry)) throw new Error('A catalog model entry is invalid.');
    validId(entry.id, 'Model ID');
    if (ids.has(entry.id)) throw new Error('Model IDs must be unique.');
    ids.add(entry.id);
    const normalized = { id: entry.id, model: validateEditableModel(entry.model), updatedAt: iso(entry.updatedAt, 'Model update') };
    if (['publishedModel', 'publishedVersion', 'publishedAt', 'hasUnpublishedChanges'].some(key => own(entry, key))) {
      const snapshot = entry.publishedModel === null ? null : validateEditableModel(entry.publishedModel);
      if (snapshot === null ? entry.publishedVersion !== 0 || entry.publishedAt !== null : !Number.isSafeInteger(entry.publishedVersion) || entry.publishedVersion < 1 || entry.publishedAt === null) throw new Error('A published snapshot needs a matching version and publication timestamp.');
      Object.assign(normalized, { publishedModel: snapshot, publishedVersion: entry.publishedVersion,
        publishedAt: snapshot === null ? null : iso(entry.publishedAt, 'Model publication'),
        hasUnpublishedChanges: JSON.stringify(normalized.model) !== JSON.stringify(snapshot) });
    }
    result.models.push(normalized);
    if (!own(catalog.sources, entry.id) || !Array.isArray(catalog.sources[entry.id])) throw new Error('Every model needs a source registry.');
    result.sources[entry.id] = catalog.sources[entry.id].map(normalizedSource);
    if (new Set(result.sources[entry.id].map(source => source.id)).size !== result.sources[entry.id].length) throw new Error('Source IDs must be unique within a model.');
    if (!own(catalog.schedules, entry.id)) throw new Error('Every model needs a schedule.');
    result.schedules[entry.id] = validateSchedule(catalog.schedules[entry.id], result.sources[entry.id]);
    if (!own(catalog.runs, entry.id) || !Array.isArray(catalog.runs[entry.id]) || catalog.runs[entry.id].length > MAX_RUN_HISTORY) throw new Error(`Every model needs run history of at most ${MAX_RUN_HISTORY} entries.`);
    result.runs[entry.id] = catalog.runs[entry.id].map(run => normalizedRun(run, entry.id));
    if (new Set(result.runs[entry.id].map(run => run.id)).size !== result.runs[entry.id].length) throw new Error('Run IDs must be unique within a model.');
  }
  if (result.models.length ? !ids.has(result.activeId) : result.activeId !== null) throw new Error('The active model must exist in the catalog.');
  for (const key of ['schedules', 'sources', 'runs']) if (Object.keys(catalog[key]).some(id => !ids.has(id))) throw new Error(`${key} contains data for an unknown model.`);
  return result;
}

function existing(catalog, modelId) {
  validId(modelId, 'Model ID');
  const entry = catalog.models.find(item => item.id === modelId);
  if (!entry) throw new Error('That model does not exist.');
  return entry;
}

export function getModelEntry(catalog, modelId = catalog.activeId) {
  return existing(validateCatalog(catalog), modelId);
}

export function createCatalog(model, { id = 'model-1', now } = {}) {
  return addModel({ version: CATALOG_VERSION, activeId: null, models: [], schedules: {}, sources: {}, runs: {} }, model, { id, now });
}

export const migrateLegacyModel = createCatalog;

export function addModel(catalog, model, { id, now } = {}) {
  const result = validateCatalog(catalog);
  validId(id, 'Model ID');
  if (result.models.some(entry => entry.id === id)) throw new Error('That model ID already exists.');
  result.models.push({ id, model: validateEditableModel(model), updatedAt: iso(now, 'Model update') });
  result.schedules[id] = defaultSchedule();
  result.sources[id] = [];
  result.runs[id] = [];
  result.activeId = id;
  return result;
}

export function updateModel(catalog, modelId, model, now) {
  const result = validateCatalog(catalog), entry = existing(result, modelId);
  entry.model = validateEditableModel(model);
  entry.updatedAt = iso(now, 'Model update');
  if (own(entry, 'publishedModel')) entry.hasUnpublishedChanges = JSON.stringify(entry.model) !== JSON.stringify(entry.publishedModel);
  return result;
}

export function duplicateModel(catalog, modelId, { id, name, now } = {}) {
  const model = getModelEntry(catalog, modelId).model;
  model.name = name ?? `${model.name} (copy)`;
  return addModel(catalog, model, { id, now });
}

export function removeModel(catalog, modelId) {
  const result = validateCatalog(catalog);
  existing(result, modelId);
  result.models = result.models.filter(entry => entry.id !== modelId);
  for (const key of ['schedules', 'sources', 'runs']) delete result[key][modelId];
  if (result.activeId === modelId) result.activeId = result.models[0]?.id ?? null;
  return result;
}

export function setActiveModel(catalog, modelId) {
  const result = validateCatalog(catalog);
  existing(result, modelId);
  result.activeId = modelId;
  return result;
}

export function registerSource(catalog, modelId, source) {
  const result = validateCatalog(catalog);
  existing(result, modelId);
  const normalized = normalizedSource(source);
  if (result.sources[modelId].some(item => item.id === normalized.id)) throw new Error('That source ID is already registered for this model.');
  result.sources[modelId].push(normalized);
  return result;
}

export function removeSource(catalog, modelId, sourceId) {
  const result = validateCatalog(catalog);
  existing(result, modelId);
  if (!result.sources[modelId].some(source => source.id === sourceId)) throw new Error('That source is not registered for this model.');
  result.sources[modelId] = result.sources[modelId].filter(source => source.id !== sourceId);
  const schedule = result.schedules[modelId];
  if (schedule.inputSourceId === sourceId || schedule.outputSourceId === sourceId) {
    if (schedule.inputSourceId === sourceId) schedule.inputSourceId = null;
    if (schedule.outputSourceId === sourceId) schedule.outputSourceId = null;
    schedule.enabled = false;
    schedule.nextRunAt = null;
  }
  return result;
}

export function setSchedule(catalog, modelId, changes, now) {
  const result = validateCatalog(catalog);
  existing(result, modelId);
  if (!record(changes)) throw new Error('Schedule settings must be a record.');
  const allowed = new Set(['enabled', 'intervalMinutes', 'inputSourceId', 'outputSourceId', 'nextRunAt']);
  if (Object.keys(changes).some(key => !allowed.has(key))) throw new Error('Schedule settings contain an unsupported field.');
  const previous = result.schedules[modelId], schedule = { ...previous, ...changes };
  const epoch = timeToEpoch(now, 'Schedule clock');
  frequencyToMinutes(schedule.intervalMinutes);
  if (!schedule.enabled) schedule.nextRunAt = null;
  else if ((!own(changes, 'nextRunAt') && (!previous.enabled || previous.intervalMinutes !== schedule.intervalMinutes)) || schedule.nextRunAt === null) schedule.nextRunAt = epoch + schedule.intervalMinutes * MINUTE_MS;
  result.schedules[modelId] = validateSchedule(schedule, result.sources[modelId]);
  return result;
}

export function dueSchedules(catalog, now) {
  const result = validateCatalog(catalog), epoch = timeToEpoch(now, 'Scheduler clock');
  return result.models.flatMap(({ id }) => {
    const schedule = result.schedules[id];
    if (!schedule.enabled || timeToEpoch(schedule.nextRunAt) > epoch) return [];
    return [{ modelId: id, scheduledAt: schedule.nextRunAt, inputSourceId: schedule.inputSourceId, outputSourceId: schedule.outputSourceId }];
  });
}

export function advanceSchedule(catalog, modelId, now) {
  const result = validateCatalog(catalog);
  existing(result, modelId);
  const epoch = timeToEpoch(now, 'Scheduler clock'), schedule = result.schedules[modelId];
  if (!schedule.enabled) return result;
  const due = timeToEpoch(schedule.nextRunAt), period = schedule.intervalMinutes * MINUTE_MS;
  if (due <= epoch) schedule.nextRunAt = iso(due + (Math.floor((epoch - due) / period) + 1) * period, 'Next run');
  return result;
}

export function appendRun(catalog, modelId, run, { limit = MAX_RUN_HISTORY } = {}) {
  const result = validateCatalog(catalog);
  existing(result, modelId);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUN_HISTORY) throw new Error(`History limit must be from 1 to ${MAX_RUN_HISTORY}.`);
  const normalized = normalizedRun(run, modelId);
  if (result.runs[modelId].some(item => item.id === normalized.id)) throw new Error('That run ID already exists for this model.');
  for (const direction of ['input', 'output']) if (normalized[`${direction}SourceId`] !== undefined) sourceRef(normalized[`${direction}SourceId`], result.sources[modelId], direction);
  result.runs[modelId] = [...result.runs[modelId], normalized].slice(-limit);
  return result;
}
