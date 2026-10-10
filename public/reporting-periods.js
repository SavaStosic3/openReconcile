const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_PERIOD_MS = 366 * DAY_MS;
const KINDS = new Set(['hour', 'day', 'shift', 'batch']);
const FIELDS = new Set(['kind', 'timeZone', 'dayStart', 'shiftStart', 'shiftHours', 'batchHours', 'settlingMinutes']);
const formatters = new Map();
const boundaryCache = new Map();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function time(value, label = 'Reporting time') {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) throw new Error(`${label} must include a time zone.`);
    const [, y, m, d, h, minute, second] = match.map(Number);
    const date = new Date(0); date.setUTCFullYear(y, m - 1, d); date.setUTCHours(0, 0, 0, 0);
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || h > 23 || minute > 59 || second > 59) throw new Error(`${label} is not a valid timestamp.`);
    value = Date.parse(value);
  }
  if (!Number.isSafeInteger(value) || value < -62_135_596_800_000 || value > 253_402_300_799_999) throw new Error(`${label} is not a valid timestamp.`);
  return value;
}

function clockMinutes(value, label) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${label} must be a clock time in HH:MM format.`);
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function formatter(timeZone) {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
    formatters.set(timeZone, cached);
  }
  return cached;
}

function wallTime(epoch, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(epoch).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

function nearbyOffsets(reference, timeZone) {
  const offsets = new Set();
  // Sampling the surrounding six days observes both offsets at a transition,
  // including zones with half-hour changes and a skipped calendar date.
  for (let delta = -3 * DAY_MS; delta <= 3 * DAY_MS; delta += 6 * HOUR_MS) {
    const epoch = Math.floor((reference + delta) / 1000) * 1000;
    offsets.add(wallTime(epoch, timeZone) - epoch);
  }
  return [...offsets];
}

function wallInstants(wall, timeZone, offsets, repeated = 'earlier') {
  const candidates = offsets.map(offset => wall - offset).map(epoch => ({ epoch, actual: wallTime(epoch, timeZone) }));
  const exact = [...new Set(candidates.filter(item => item.actual === wall).map(item => item.epoch))].sort((a, b) => a - b);
  if (exact.length) return repeated === 'both' ? exact : [exact[0]];
  // A nonexistent clock boundary moves forward by the size of the clock jump:
  // 02:30 in a one-hour gap becomes 03:30. Day/shift overlaps use the earlier
  // occurrence. Hourly boundaries include both occurrences of a repeated hour.
  const forward = candidates.filter(item => item.actual > wall).sort((a, b) => a.actual - b.actual || a.epoch - b.epoch)[0];
  if (!forward) throw new Error('Unable to resolve this reporting boundary in the selected time zone.');
  return [forward.epoch];
}

export function defaultReportingSettings(model, timeZone = 'UTC') {
  const hours = Number(model?.periodHours ?? 1);
  return validateReportingSettings({ kind: hours === 1 ? 'hour' : hours === 24 ? 'day' : 'batch', timeZone, dayStart: '00:00', shiftStart: '06:00', shiftHours: 8, batchHours: hours, settlingMinutes: 0 });
}

export function validateReportingSettings(settings) {
  if (!record(settings) || Object.keys(settings).some(key => !FIELDS.has(key))) throw new Error('Reporting settings contain an unsupported field.');
  const result = { kind: 'hour', timeZone: 'UTC', dayStart: '00:00', shiftStart: '06:00', shiftHours: 8, batchHours: 1, settlingMinutes: 0, ...settings };
  if (!KINDS.has(result.kind)) throw new Error('Choose an hour, day, shift, or batch reporting period.');
  if (typeof result.timeZone !== 'string' || !result.timeZone || result.timeZone.length > 100) throw new Error('Choose a valid IANA reporting time zone.');
  try { result.timeZone = formatter(result.timeZone).resolvedOptions().timeZone; } catch { throw new Error('Choose a valid IANA reporting time zone.'); }
  clockMinutes(result.dayStart, 'Reporting day start');
  clockMinutes(result.shiftStart, 'First shift start');
  if (!Number.isInteger(result.shiftHours) || result.shiftHours < 1 || result.shiftHours > 24 || 24 % result.shiftHours !== 0) throw new Error('Shift duration must be a whole number of hours that divides 24.');
  if (typeof result.batchHours !== 'number' || !Number.isFinite(result.batchHours) || result.batchHours <= 0 || result.batchHours * HOUR_MS > MAX_PERIOD_MS || !Number.isSafeInteger(result.batchHours * HOUR_MS)) throw new Error('Batch duration must be positive, fit whole milliseconds, and be at most 366 days.');
  if (!Number.isInteger(result.settlingMinutes) || result.settlingMinutes < 0 || result.settlingMinutes > 10_080) throw new Error('Late-data allowance must be a whole number of minutes from 0 to 10,080.');
  return result;
}

function boundaries(settings, reference) {
  const wall = new Date(wallTime(reference, settings.timeZone));
  wall.setUTCHours(0, 0, 0, 0);
  const day = wall.getTime();
  const key = `${settings.kind}|${settings.timeZone}|${settings.dayStart}|${settings.shiftStart}|${settings.shiftHours}|${day}`;
  if (boundaryCache.has(key)) return boundaryCache.get(key);
  const offsets = nearbyOffsets(day, settings.timeZone), result = [];
  for (let delta = -2; delta <= 2; delta++) {
    const date = day + delta * DAY_MS;
    if (settings.kind === 'hour') {
      for (let hour = 0; hour < 24; hour++) result.push(...wallInstants(date + hour * HOUR_MS, settings.timeZone, offsets, 'both'));
    } else if (settings.kind === 'day') {
      result.push(...wallInstants(date + clockMinutes(settings.dayStart, 'Reporting day start') * MINUTE_MS, settings.timeZone, offsets));
    } else {
      for (let shift = 0; shift < 24 / settings.shiftHours; shift++) result.push(...wallInstants(date + clockMinutes(settings.shiftStart, 'First shift start') * MINUTE_MS + shift * settings.shiftHours * HOUR_MS, settings.timeZone, offsets));
    }
  }
  const normalized = [...new Set(result)].sort((a, b) => a - b);
  if (boundaryCache.size >= 128) boundaryCache.delete(boundaryCache.keys().next().value);
  boundaryCache.set(key, normalized);
  return normalized;
}

function batchAnchor(settings) {
  // Default recurring batches use fixed elapsed durations from the model's
  // 1970-01-01 reporting-day start in its time zone, rather than a rolling
  // window ending at the run time. Custom batch start/end times override this.
  const wall = clockMinutes(settings.dayStart, 'Reporting day start') * MINUTE_MS;
  return wallInstants(wall, settings.timeZone, nearbyOffsets(wall, settings.timeZone))[0];
}

export function formatReportingPeriod(period) {
  if (!record(period) || !KINDS.has(period.kind)) throw new Error('Choose a valid reporting period.');
  const display = new Intl.DateTimeFormat('en-CA', { timeZone: period.timeZone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
  const title = { hour: 'Hour', day: 'Day', shift: 'Shift', batch: 'Batch' }[period.kind];
  return `${title}: ${display.format(time(period.start, 'Period start'))} – ${display.format(time(period.end, 'Period end'))} (${period.timeZone})`;
}

export function resolveReportingPeriod(settings, model, now, selection = null) {
  let config = settings == null ? defaultReportingSettings(model) : validateReportingSettings(settings);
  if (record(selection) && Object.hasOwn(selection, 'kind')) config = validateReportingSettings({ ...config, kind: selection.kind });
  const cutoff = time(now, 'Reporting clock') - config.settlingMinutes * MINUTE_MS;
  let start, end;
  if (selection !== null) {
    if (!record(selection) || !Object.hasOwn(selection, 'start') || !Object.hasOwn(selection, 'end') || Object.keys(selection).some(key => !['start', 'end', 'kind'].includes(key))) throw new Error('Select a reporting period with start and end timestamps and an optional period kind.');
    start = time(selection.start, 'Period start'); end = time(selection.end, 'Period end');
    if (end <= start || end - start > MAX_PERIOD_MS) throw new Error('Reporting periods must have a positive duration of at most 366 days.');
    if (end > cutoff) throw new Error('Select a completed reporting period whose late-data allowance has elapsed.');
    if (config.kind !== 'batch') {
      const candidates = boundaries(config, start), index = candidates.indexOf(start);
      if (index < 0 || candidates[index + 1] !== end) throw new Error('Select one complete period aligned with the configured reporting boundaries.');
    }
  } else if (config.kind === 'batch') {
    const duration = config.batchHours * HOUR_MS, anchor = batchAnchor(config);
    end = anchor + Math.floor((cutoff - anchor) / duration) * duration; start = end - duration;
  } else {
    const candidates = boundaries(config, cutoff);
    const index = candidates.findLastIndex(value => value <= cutoff);
    if (index < 1) throw new Error('Unable to determine the latest completed reporting period.');
    start = candidates[index - 1]; end = candidates[index];
  }
  const result = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), kind: config.kind, timeZone: config.timeZone, periodHours: (end - start) / HOUR_MS, readyAt: new Date(end + config.settlingMinutes * MINUTE_MS).toISOString() };
  result.label = formatReportingPeriod(result);
  return result;
}

export function recentReportingPeriods(settings, model, now, limit = 24) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Choose from 1 to 100 recent reporting periods.');
  const config = settings == null ? defaultReportingSettings(model) : validateReportingSettings(settings), result = [];
  let cursor = time(now, 'Reporting clock');
  for (let index = 0; index < limit; index++) {
    const period = resolveReportingPeriod(config, model, cursor);
    result.push(period);
    cursor = Date.parse(period.start) + config.settlingMinutes * MINUTE_MS;
  }
  return result;
}
