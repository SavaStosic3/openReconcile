import { ApiError } from './policy.js';
import { validatePiSource } from '../public/pi-sources.js';
import { getSqlInputMappings } from '../public/sql-sources.js';
import { aggregateQualityReadings, InputQualityError } from '../public/input-quality.js';
import { timeToEpoch } from '../public/management-store.js';
import { getSqlInventoryMappings, sqlOutputRows } from './sql-connectors.js';
import { isVirtualMeter } from '../public/virtual-meters.js';

const MAX_BYTES = 4_000_000, MAX_EVENTS = 10_000, REQUEST_TIMEOUT = 15_000;
const METRICS = new Set(['mass', 'incoming_mass', 'outgoing_mass', 'opening_inventory', 'closing_inventory', 'accumulation']);
const UNITS = new Set(['kg', 't', 'g', 'kg/h', 't/h', 'm³', 'L', 'm³/h', 'L/h', 'm', 'cm', 'mm']);
const NUMERIC_POINTS = new Set(['Float16', 'Float32', 'Float64', 'Int16', 'Int32']);
const FLOAT_POINTS = new Set(['Float64']);
const NUMERIC_ATTRIBUTES = new Set(['Double', 'Single', 'Int16', 'Int32', 'Int64', 'UInt16', 'UInt32', 'UInt64']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const text = (value, max) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const configError = () => { throw new Error('Invalid PI connection configuration. Check connection fields, HTTPS, authentication and point allowlists.'); };
const failure = message => new ApiError(502, message || 'The PI Web API request failed. Check connectivity, authentication, certificate trust and PI permissions.');

export function validatePiConnections(value) {
  if (!Array.isArray(value) || value.length > 32) configError();
  const ids = new Set();
  const result = value.map(profile => {
    if (!exact(profile, ['id', 'name', 'baseUrl', 'auth', 'inputs', 'outputs']) || !safeId(profile.id) || ids.has(profile.id) || !text(profile.name, 160)) configError();
    ids.add(profile.id);
    let url;
    try { url = new URL(profile.baseUrl); } catch { configError(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !text(profile.baseUrl, 2048)) configError();
    if (profile.auth?.type === 'basic') {
      if (!exact(profile.auth, ['type', 'username', 'password']) || !text(profile.auth.username, 200) || profile.auth.username.includes(':') || typeof profile.auth.password !== 'string' || !profile.auth.password || profile.auth.password.length > 4096 || /[\u0000\r\n]/.test(profile.auth.password)) configError();
    } else if (profile.auth?.type === 'bearer') {
      if (!exact(profile.auth, ['type', 'token']) || typeof profile.auth.token !== 'string' || profile.auth.token.length < 16 || profile.auth.token.length > 4096 || /\s/.test(profile.auth.token)) configError();
    } else configError();
    const inputNames = new Set(), inputPaths = new Set(), outputKeys = new Set(), outputPaths = new Set();
    for (const [direction, bindings] of [['inputs', profile.inputs], ['outputs', profile.outputs]]) {
      if (!Array.isArray(bindings) || bindings.length > 500) configError();
      for (const binding of bindings) {
        if (!exact(binding, direction === 'inputs' ? ['sourceName', 'path', 'unit'] : ['sourceName', 'metric', 'path', 'unit']) || !text(binding.sourceName, 200) || !text(binding.path, 2048) || !binding.path.startsWith('\\\\') || !UNITS.has(binding.unit)) configError();
        const parts = binding.path.slice(2).split('\\');
        if (parts.length < 2 || parts.some(part => !part) || !parts[0] || parts[0].includes('|')) configError();
        const isAttribute = binding.path.includes('|');
        if (isAttribute && (parts.length < 3 || binding.path.split('|').length !== 2 || !binding.path.split('|')[1])) configError();
        if (!isAttribute && parts.length !== 2) configError();
        const pathKey = binding.path.toLowerCase();
        if (direction === 'inputs') {
          if (inputNames.has(binding.sourceName) || inputPaths.has(pathKey)) configError();
          inputNames.add(binding.sourceName); inputPaths.add(pathKey);
        } else {
          const key = JSON.stringify([binding.sourceName, binding.metric]);
          if (!METRICS.has(binding.metric) || !['kg', 't', 'g', 'kg/h', 't/h'].includes(binding.unit) || binding.unit.endsWith('/h') && !['mass', 'incoming_mass', 'outgoing_mass'].includes(binding.metric) || isAttribute || outputKeys.has(key) || outputPaths.has(pathKey)) configError();
          outputKeys.add(key); outputPaths.add(pathKey);
        }
      }
    }
    if ([...outputPaths].some(path => inputPaths.has(path))) configError();
    return { ...structuredClone(profile), baseUrl: url.toString().replace(/\/$/, '') };
  });
  const rawPoints = new Set(result.flatMap(profile => profile.inputs.map(binding => `${profile.baseUrl.toLowerCase()}|${binding.path.toLowerCase()}`)));
  if (result.some(profile => profile.outputs.some(binding => rawPoints.has(`${profile.baseUrl.toLowerCase()}|${binding.path.toLowerCase()}`)))) configError();
  return result;
}

function profiles(env) {
  try { return validatePiConnections(env.PI_CONNECTIONS ?? []); }
  catch { throw new ApiError(503, 'The PI connection configuration is invalid. Ask an administrator to review the server connection file.'); }
}
function connection(env, source) {
  const profile = profiles(env).find(item => item.id === source.connectionId);
  if (!profile) throw new ApiError(503, 'The selected PI connection is not configured. Ask an administrator to review the server connection file.');
  if (!profile[source.direction === 'input' ? 'inputs' : 'outputs'].length) throw new ApiError(400, 'The selected PI connection has no allowed bindings for this source direction.');
  return profile;
}

// Metadata contains aliases and units only. Neither the authenticated browser
// nor saved run history receives PI paths, endpoints or account credentials.
export function piConnections(env) {
  const connections = profiles(env);
  return { configured: connections.length > 0, connections: connections.map(({ id, name, inputs, outputs }) => ({ id, name, canRead: inputs.length > 0, canWrite: outputs.length > 0, inputs: inputs.map(({ sourceName, unit }) => ({ sourceName, unit })), outputs: outputs.map(({ sourceName, metric, unit }) => ({ sourceName, metric, unit })) })) };
}

function basicAuthorization(auth) {
  const bytes = new TextEncoder().encode(`${auth.username}:${auth.password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
async function requestPi(env, profile, path, params = {}, body) {
  const url = new URL(`${profile.baseUrl}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await (typeof env.PI_WEB_API_FETCH === 'function' ? env.PI_WEB_API_FETCH : fetch)(url.toString(), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: profile.auth.type === 'basic' ? basicAuthorization(profile.auth) : `Bearer ${profile.auth.token}`, 'X-Requested-With': 'XmlHttpRequest', Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw failure('The PI response exceeds the permitted size. Choose a smaller reporting period.');
    const chunks = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw failure('The PI response exceeds the permitted size. Choose a smaller reporting period.'); } chunks.push(value); } }
      finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (body !== undefined) {
      // Scalar Stream.UpdateValue documents 202. Other success codes, partial
      // statuses and response bodies do not prove that this event was accepted.
      if (response.status !== 202 || raw.trim()) throw failure('PI did not acknowledge this output event. Delivery may be partial or uncertain; review the destination before rerunning.');
      return null;
    }
    if (response.status !== 200 || !raw) throw failure();
    const data = JSON.parse(raw);
    if (!plain(data) || data.Errors || data.Error) throw failure('PI returned an invalid or failed response. Review the connection and requested reporting period.');
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw failure();
  } finally { clearTimeout(timer); }
}

async function resolveBinding(env, profile, binding, output = false) {
  const attribute = binding.path.includes('|');
  const data = await requestPi(env, profile, attribute ? 'attributes' : 'points', { path: binding.path });
  if (!text(data.WebId, 512) || !/^[A-Za-z0-9_-]+$/.test(data.WebId)) throw failure('PI returned an invalid point identifier.');
  const unit = attribute ? data.DefaultUnitsOfMeasureAbbreviation ?? data.DefaultUnitsOfMeasure : data.EngineeringUnits;
  if (unit !== binding.unit) throw new ApiError(422, `${binding.sourceName}: PI engineering units do not match the configured unit. Review the point and connection binding.`);
  if (attribute ? !NUMERIC_ATTRIBUTES.has(data.Type) : !(output ? FLOAT_POINTS : NUMERIC_POINTS).has(data.PointType)) throw new ApiError(422, `${binding.sourceName}: choose a numeric PI input or a floating-point PI output point.`);
  let physicalId = data.WebId;
  if (attribute) {
    let point;
    try { point = new URL(data.Links?.Point); } catch { throw failure('An AF input must reference a PI point with a verifiable physical identity.'); }
    const base = new URL(profile.baseUrl), prefix = `${base.pathname.replace(/\/$/, '')}/points/`;
    if (point.origin !== base.origin || point.username || point.password || point.search || point.hash || !point.pathname.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(point.pathname.slice(prefix.length))) throw failure('An AF input must reference a PI point on the configured PI Web API service.');
    physicalId = point.pathname.slice(prefix.length);
  }
  return { ...binding, webId: data.WebId, physicalId, integer: /^(?:U?Int)/.test(attribute ? data.Type : data.PointType) };
}

async function resolveOutputTargets(env, profile, bindings) {
  const inputs = new Set(), outputs = new Set(), resolved = [];
  // AF attributes and point aliases can resolve to the same physical archive
  // point. Destination isolation is verified by identity before any write.
  for (const binding of profile.inputs) inputs.add((await resolveBinding(env, profile, binding)).physicalId);
  for (const binding of bindings) {
    const point = await resolveBinding(env, profile, binding, true);
    if (inputs.has(point.physicalId)) throw new ApiError(422, 'A PI output resolves to a configured raw input point. No output events were written.');
    if (outputs.has(point.physicalId)) throw new ApiError(422, 'Different PI output metrics resolve to the same destination point. No output events were written.');
    outputs.add(point.physicalId); resolved.push(point);
  }
  return resolved;
}

function inputMappings(model) {
  let flows;
  try { flows = model.streams?.some(stream => stream.measured && !isVirtualMeter(stream)) ? getSqlInputMappings(model) : []; }
  catch (error) { throw new ApiError(400, error.message.replace(/SQL/g, 'PI')); }
  let inventories;
  try { inventories = getSqlInventoryMappings(model, flows); }
  catch (error) { throw new ApiError(400, error.message.replace(/SQL/g, 'PI')); }
  if (!flows.length && !inventories.length) throw new ApiError(400, 'Add at least one physical meter or measured inventory before using PI input.');
  return [...flows, ...inventories];
}
function selectInputBindings(profile, mappings) {
  return mappings.map(mapping => {
    const binding = profile.inputs.find(item => item.sourceName === mapping.sourceName);
    if (!binding) throw new ApiError(400, `${mapping.modelName}: the Source Name is not an allowed PI input alias.`);
    if (binding.unit !== mapping.unit) throw new ApiError(422, `${mapping.modelName}: the model unit does not match the configured PI input unit.`);
    return { ...binding, ...mapping };
  });
}
function isoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw failure('PI returned an invalid timestamp.');
  const fraction = value.match(/\.(\d+)/)?.[1] || '';
  if (/[1-9]/.test(fraction.slice(3))) throw failure('PI timestamps contain submillisecond precision that this application cannot safely reconcile. Configure millisecond reporting data.');
  const normalized = fraction.length > 3 ? value.replace(`.${fraction}`, `.${fraction.slice(0, 3)}`) : value;
  try { return new Date(timeToEpoch(normalized, 'PI timestamp')).toISOString(); }
  catch { throw failure('PI returned an invalid timestamp.'); }
}
function sample(value, unit, integer = false) {
  if (!plain(value) || !['Good', 'Questionable', 'Substituted'].every(key => typeof value[key] === 'boolean') || !Object.hasOwn(value, 'Value')) throw failure('PI returned an invalid reading or incomplete historian quality flags.');
  if (Object.hasOwn(value, 'UnitsAbbreviation') && value.UnitsAbbreviation !== unit) throw failure('PI returned readings with units different from the configured binding.');
  const quality = !value.Good ? 'Bad' : value.Questionable ? 'Questionable' : value.Substituted ? 'Substituted' : 'Good';
  if (quality === 'Good' && !finite(value.Value)) throw failure('PI returned a nonnumeric reading for a Good numeric input.');
  if (quality === 'Good' && integer && !Number.isSafeInteger(value.Value)) throw failure('PI returned an integer reading outside the safely representable numeric range, or a fractional value for an integer stream.');
  return { timestamp: isoTimestamp(value.Timestamp), value: value.Value, quality };
}
function windowBounds(window) {
  let start, end;
  try { start = timeToEpoch(window?.start); end = timeToEpoch(window?.end); } catch { throw new ApiError(400, 'Choose valid PI reporting-period boundaries.'); }
  if (start >= end || end - start > 366 * 86_400_000) throw new ApiError(400, 'Choose a nonempty PI reporting period of at most 366 days.');
  return { start, end };
}

export async function testPiSource(env, source, model = null) {
  source = validatePiSource(source);
  const profile = connection(env, source);
  const bindings = source.direction === 'input' && model ? selectInputBindings(profile, inputMappings(model)) : profile[source.direction === 'input' ? 'inputs' : 'outputs'];
  if (source.direction === 'output') { await resolveOutputTargets(env, profile, bindings); return { ok: true }; }
  const seen = new Set();
  for (const binding of bindings) if (!seen.has(binding.path)) { seen.add(binding.path); await resolveBinding(env, profile, binding, source.direction === 'output'); }
  return { ok: true };
}

export async function readPiInput(env, source, model, window) {
  source = validatePiSource(source);
  if (source.direction !== 'input') throw new ApiError(400, 'Choose an input PI source.');
  const profile = connection(env, source), bounds = windowBounds(window);
  const bindings = selectInputBindings(profile, inputMappings(model));
  const flows = bindings.filter(binding => binding.itemKind !== 'inventory');
  const advanced = ['timeWeightedAverage', 'totalizerDelta'].includes(source.aggregation);
  if (source.aggregation === 'timeWeightedAverage' && flows.some(binding => !binding.unit.endsWith('/h'))) throw new ApiError(400, 'Time-weighted flow requires every mapped physical meter to use a rate unit per hour.');
  if (source.aggregation === 'totalizerDelta' && flows.some(binding => binding.unit.endsWith('/h'))) throw new ApiError(400, 'Totalizer differences require cumulative mass or volume units, without a rate denominator.');
  const resolved = new Map(), identities = new Map(), readings = [];
  // Different aliases must not turn one physical sensor into independent
  // measurements. A tank can read that same sensor at its two boundaries.
  for (const binding of bindings) {
    if (!resolved.has(binding.path)) resolved.set(binding.path, await resolveBinding(env, profile, binding));
    const point = resolved.get(binding.path), previous = identities.get(point.physicalId);
    if (previous && (previous.itemId !== binding.itemId || previous.itemKind !== 'inventory' || binding.itemKind !== 'inventory')) throw new ApiError(422, 'Different physical meters or storage units resolve to the same PI point. Use a virtual meter for a dependent calculation.');
    identities.set(point.physicalId, binding);
  }
  for (const binding of bindings) {
    const point = resolved.get(binding.path);
    if (binding.itemKind === 'inventory') {
      const boundary = binding.endpoint === 'opening' ? window.start : window.end;
      const data = await requestPi(env, profile, `streams/${point.webId}/recordedattime`, { time: boundary, retrievalMode: 'Exact' });
      const reading = sample(data, binding.unit, point.integer);
      if (reading.timestamp !== isoTimestamp(boundary)) throw new ApiError(422, `${binding.modelName}: PI must provide an exact inventory reading at the reporting boundary.`);
      if (!source.quality.goodQualityValues.includes(reading.quality)) throw new ApiError(422, `${binding.modelName}: no accepted historian quality exists at the inventory boundary.`);
      if (!finite(reading.value) || reading.value < 0) throw new ApiError(422, `${binding.modelName}: the inventory reading must be a finite nonnegative number.`);
      readings.push({ ...binding, path: undefined, webId: undefined, value: reading.value, timestamp: reading.timestamp, quality: { coveragePercent: 100, sampleCount: 1, rejectedCount: 0, latestTimestamp: reading.timestamp, resetCount: 0, warnings: [] } });
      continue;
    }
    const data = await requestPi(env, profile, `streams/${point.webId}/recorded`, { startTime: window.start, endTime: window.end, boundaryType: advanced ? 'Outside' : 'Inside', maxCount: MAX_EVENTS });
    if (!Array.isArray(data.Items) || data.Items.length >= MAX_EVENTS || data.Links != null && !plain(data.Links) || data.Links?.Next || data.Links?.next) throw new ApiError(422, `${binding.modelName}: PI archive data may be truncated. Choose a smaller reporting period; incomplete data is never reconciled.`);
    const samples = data.Items.map(value => sample(value, binding.unit, point.integer)).filter(value => {
      const epoch = Date.parse(value.timestamp);
      // PI end boundaries can be inclusive. Simple sums/latest readings use a
      // half-open period; advanced calculations include an exact end sample.
      return epoch >= bounds.start - (advanced ? source.quality.maxAgeMinutes * 60_000 : 0) && (advanced ? epoch <= bounds.end : epoch < bounds.end);
    });
    let result;
    try { result = aggregateQualityReadings(samples, { sourceName: binding.sourceName, ...window, aggregation: source.aggregation, quality: source.quality }); }
    catch (error) { if (error instanceof InputQualityError) throw new ApiError(422, error.message); throw error; }
    const { path, webId, ...safe } = binding;
    readings.push({ ...safe, ...result });
  }
  // Strip private binding fields even from inventory audit records.
  return { readings: readings.map(({ path, webId, ...reading }) => reading), window: { ...window } };
}

function outputBindings(profile, run, window) {
  const expected = new Set();
  for (const stream of run.modelSnapshot?.streams ?? []) if (stream.dataMapping) expected.add(JSON.stringify([stream.dataMapping.sourceName, 'mass']));
  for (const node of run.modelSnapshot?.nodes ?? []) if (node.dataMapping) {
    for (const metric of ['incoming_mass', 'outgoing_mass', ...(node.inventory ? ['opening_inventory', 'closing_inventory', 'accumulation'] : [])]) expected.add(JSON.stringify([node.dataMapping.sourceName, metric]));
  }
  const selected = profile.outputs.filter(binding => expected.has(JSON.stringify([binding.sourceName, binding.metric])));
  if (!selected.length) throw new ApiError(400, 'Map an observable result to an allowed PI output alias and metric.');
  let batch;
  try { batch = sqlOutputRows(run, window); }
  catch { throw new ApiError(422, 'PI output requires observable reconciled results and a valid reporting period.'); }
  const rows = new Map(batch.rows.map(row => [JSON.stringify([row.source_name, row.metric]), row]));
  if (rows.size !== batch.rows.length) throw new ApiError(400, 'PI output Source Names must identify distinct model results.');
  const events = selected.map(binding => {
    const row = rows.get(JSON.stringify([binding.sourceName, binding.metric]));
    if (!row) throw new ApiError(422, `${binding.sourceName}: the selected PI result is unobservable. No output events were written.`);
    const durationHours = (Date.parse(window.end) - Date.parse(window.start)) / 3_600_000;
    const factor = ({ kg: 1, t: 0.001, g: 1000, 'kg/h': 1 / durationHours, 't/h': 0.001 / durationHours })[binding.unit];
    const value = row.value_kg * factor;
    if (!finite(value)) throw new ApiError(422, 'A PI output result cannot be represented in the configured unit.');
    return { binding, sourceName: binding.sourceName, metric: binding.metric, unit: binding.unit, value, timestamp: binding.metric === 'opening_inventory' ? window.start : window.end, confirmed: false };
  });
  return { events, skipped: batch.skipped + batch.rows.length - selected.length };
}

export function piAdapters(env) {
  return {
    inputAdapters: { pi: async (source, model, context) => {
      source = validatePiSource(source);
      context.recordInputAudit({ source, window: { ...context.window }, readings: [] });
      const data = await readPiInput(env, source, model, context.window);
      const target = (value, reading) => reading.itemKind === 'inventory' ? value.nodes.find(node => node.id === reading.itemId).inventory[reading.endpoint] : value.streams.find(stream => stream.id === reading.itemId);
      const readings = data.readings.map(reading => ({ ...reading, originalValue: target(model, reading).value }));
      const next = structuredClone(model);
      for (const reading of readings) target(next, reading).value = reading.value;
      context.recordInputAudit({ source, ...data, readings });
      return next;
    } },
    outputAdapters: { pi: async (source, run, context) => {
      source = validatePiSource(source);
      if (source.direction !== 'output') throw new ApiError(400, 'Choose an output PI source.');
      const profile = connection(env, source);
      windowBounds(context.window);
      context.recordOutputAudit({ source, window: { ...context.window }, written: 0, skipped: 0, events: [] });
      const { events, skipped } = outputBindings(profile, run, context.window);
      // Validate every intended target/result before the first external write.
      const points = await resolveOutputTargets(env, profile, events.map(event => event.binding));
      for (let index = 0; index < events.length; index++) events[index].point = points[index];
      let written = 0;
      const audit = () => context.recordOutputAudit({ source, window: { ...context.window }, written, skipped, events: events.map(({ binding, point, ...event }) => event) });
      audit();
      for (const event of events) {
        await context.authorizeOutput();
        await requestPi(env, profile, `streams/${event.point.webId}/value`, { updateOption: 'Replace', bufferOption: 'DoNotBuffer' }, { Timestamp: event.timestamp, Value: event.value, Good: true, Questionable: false });
        event.confirmed = true; written++; audit();
      }
    } },
  };
}
