import { createCatalog, defaultSchedule, validateEditableModel, setSchedule, advanceSchedule } from '../public/management-store.js';
import { executeModelRun } from '../public/schedule-runner.js';
import { ApiError, USER_ROLES, MODEL_LEVELS, fields, safeId, validateRevision, requireAdmin, requirePermission } from './policy.js';
import { Repository } from './repository.js';
import { validateSqlSource } from '../public/sql-sources.js';
import { sqlConnections, testSqlSource, readSqlInput, sqlAdapters } from './sql-connectors.js';
import { resolveReportingPeriod } from '../public/reporting-periods.js';

const MAX_BODY_BYTES = 2_000_000;
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const booleanFields = (body, names) => { for (const name of names) if (Object.hasOwn(body, name) && typeof body[name] !== 'boolean') throw new ApiError(400, `${name} must be true or false.`); };
const clock = env => typeof env.NOW === 'function' ? env.NOW : Date.now;
const validated = action => { try { return action(); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, error instanceof Error ? error.message : 'Invalid model data.'); } };

async function readBody(request) {
  const url = new URL(request.url), origin = request.headers.get('Origin');
  if (origin !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'Writes must originate from this application.');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'Send this request as application/json.');
  const length = Number(request.headers.get('Content-Length'));
  if (length > MAX_BODY_BYTES) throw new ApiError(413, 'Choose a request smaller than 2 MB.');
  if (!request.body) throw new ApiError(400, 'A JSON request body is required.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ApiError(413, 'Choose a request smaller than 2 MB.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Send a valid JSON object.');
  } finally { reader.releaseLock(); }
}

function singleCatalog(model, target = 'draft') {
  const catalog = createCatalog(target === 'published' ? model.publishedModel : model.model, { id: model.id, now: target === 'published' ? model.publishedAt : model.updatedAt });
  catalog.schedules[model.id] = model.schedule; catalog.sources[model.id] = model.sources;
  return catalog;
}

function userIdentifier(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400, 'A valid user identity is required.');
  return value;
}

function routeInfo(path) {
  if (path === '/api/session') return { kind: 'session', methods: ['GET'] };
  if (path === '/api/workspace') return { kind: 'workspace', methods: ['GET'] };
  if (path === '/api/admin') return { kind: 'admin', methods: ['GET'] };
  if (path === '/api/sql/connections') return { kind: 'sqlConnections', methods: ['GET'] };
  if (path === '/api/models') return { kind: 'create', methods: ['POST'] };
  let sourceMatch = path.match(/^\/api\/models\/([^/]+)\/sources(?:\/(test|preview))?$/);
  if (sourceMatch) return { kind: sourceMatch[2] === 'test' ? 'sourceTest' : sourceMatch[2] === 'preview' ? 'sourcePreview' : 'sources', id: safeId(decodeURIComponent(sourceMatch[1])), methods: [sourceMatch[2] ? 'POST' : 'PUT'] };
  let match = path.match(/^\/api\/models\/([^/]+)(?:\/(schedule|runs|publication))?$/);
  if (match) return { kind: match[2] || 'model', id: safeId(decodeURIComponent(match[1])), methods: match[2] === 'runs' ? ['POST'] : ['PATCH'] };
  match = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (match) return { kind: 'user', id: userIdentifier(decodeURIComponent(match[1])), methods: ['PATCH'] };
  match = path.match(/^\/api\/admin\/models\/([^/]+)(?:\/(permissions|restore))?$/);
  if (match) return { kind: match[2] || 'policy', id: safeId(decodeURIComponent(match[1])), methods: match[2] === 'permissions' ? ['PUT'] : match[2] === 'restore' ? ['POST'] : ['PATCH', 'DELETE'] };
  throw new ApiError(404, 'That API route does not exist.');
}

// identity is supplied only by the server's trusted authentication dispatch.
// It is never read from request bodies, headers, cookies, or query parameters.
export async function handleApi(request, env, identity) {
  try {
    const repo = new Repository(env.DB, { now: clock(env), ...(typeof env.UUID === 'function' ? { uuid: env.UUID } : {}) });
    const user = await repo.authenticate(identity, env.ADMIN_EMAIL);
    const route = routeInfo(new URL(request.url).pathname);
    if (!route.methods.includes(request.method)) return new Response(JSON.stringify({ error: 'That method is not supported.' }), { status: 405, headers: { ...headers, Allow: route.methods.join(', ') } });
    if (route.kind === 'session') return response({ user, signInUrl: identity.signInUrl ?? env.SIGN_IN_URL ?? null, signOutUrl: identity.signOutUrl ?? env.SIGN_OUT_URL ?? null });
    if (route.kind === 'workspace') return response(await repo.workspace(user));
    if (route.kind === 'admin') return response(await repo.admin(user));
    if (route.kind === 'sqlConnections') {
      requireAdmin(await repo.user(user.id));
      const data = await sqlConnections(env);
      requireAdmin(await repo.user(user.id));
      return response(data);
    }
    const body = await readBody(request);

    if (['sources', 'sourceTest', 'sourcePreview'].includes(route.kind)) {
      requireAdmin(await repo.user(user.id));
      const { model } = await repo.accessibleModel(user, route.id, 'canEdit');
      validateRevision(body.revision);
      if (model.revision !== body.revision) throw new ApiError(409, 'This model changed. Refresh the workspace before saving.');
      if (route.kind === 'sources') {
        fields(body, ['sources', 'revision'], ['sources', 'revision']);
        if (!Array.isArray(body.sources) || body.sources.length > 20) throw new ApiError(400, 'Choose at most 20 SQL sources per model.');
        const sql = validated(() => body.sources.map(validateSqlSource));
        const legacy = model.sources.filter(source => source.type !== 'sql');
        const sources = [...legacy, ...sql];
        if (sources.length > 20 || new Set(sources.map(source => source.id)).size !== sources.length) throw new ApiError(400, 'Choose at most 20 sources with distinct identifiers per model.');
        // Connection names/capabilities are server-owned, not supplied by the browser.
        if (sql.length) {
          const metadata = await sqlConnections(env);
          if (!metadata.configured) throw new ApiError(503, 'SQL is not configured. Ask an administrator to connect the SQL gateway.');
          if (sql.some(source => !metadata.connections.some(connection => connection.id === source.connectionId && connection[source.direction === 'input' ? 'canRead' : 'canWrite']))) throw new ApiError(400, 'Choose an available connection with permission for this source direction.');
        }
        const schedule = { ...model.schedule }; let schedulePaused = false;
        for (const direction of ['input', 'output']) {
          const key = `${direction}SourceId`, selected = schedule[key];
          if (selected !== null && !sources.some(source => source.id === selected && [direction, 'both'].includes(source.direction))) { schedule[key] = null; schedulePaused = true; }
          // Changing a selected source also requires deliberate schedule re-enabling.
          if (selected !== null && JSON.stringify(model.sources.find(source => source.id === selected)) !== JSON.stringify(sources.find(source => source.id === selected))) schedulePaused = true;
        }
        if (schedulePaused) { schedule.enabled = false; schedule.nextRunAt = null; }
        return response({ ...await repo.updateSources(user, route.id, sources, schedule, body.revision), schedulePaused });
      }
      fields(body, ['source', 'revision', ...(route.kind === 'sourcePreview' ? ['target', 'period'] : [])], ['source', 'revision']);
      const source = validated(() => validateSqlSource(body.source));
      let data;
      if (route.kind === 'sourceTest') data = await testSqlSource(env, source);
      else {
        const target = body.target ?? 'draft';
        if (!['draft', 'published'].includes(target)) throw new ApiError(400, 'Choose the draft or published model for this preview.');
        if (target === 'published' && (!model.published || !model.publishedModel)) throw new ApiError(403, 'Publish this model before previewing its published SQL inputs.');
        const snapshot = target === 'published' ? model.publishedModel : model.model;
        if (source.direction !== 'input') throw new ApiError(400, 'Only input sources have a readings preview.');
        const reportingPeriod = validated(() => resolveReportingPeriod(model.schedule.reporting, snapshot, clock(env)(), body.period ?? null));
        data = { ...await readSqlInput(env, source, snapshot, { start: reportingPeriod.start, end: reportingPeriod.end }), reportingPeriod };
      }
      requireAdmin(await repo.user(user.id));
      const fresh = await repo.accessibleModel(user, route.id, 'canEdit');
      if (fresh.model.revision !== body.revision) throw new ApiError(409, 'This model changed. Refresh the workspace before continuing.');
      return response(data);
    }

    if (route.kind === 'create') {
      fields(body, ['model'], ['model']);
      return response(await repo.createModel(user, validated(() => validateEditableModel(body.model)), defaultSchedule()), 201);
    }
    if (route.kind === 'model') {
      fields(body, ['model', 'revision'], ['model', 'revision']); validateRevision(body.revision);
      await repo.accessibleModel(user, route.id, 'canEdit');
      return response(await repo.updateModel(user, route.id, validated(() => validateEditableModel(body.model)), body.revision));
    }
    if (route.kind === 'schedule') {
      fields(body, ['changes', 'revision'], ['changes', 'revision']); validateRevision(body.revision);
      const { model } = await repo.accessibleModel(user, route.id, 'canSchedule');
      const catalog = validated(() => setSchedule(singleCatalog(model), route.id, body.changes, clock(env)()));
      return response(await repo.updateSchedule(user, route.id, catalog.schedules[route.id], body.revision));
    }
    if (route.kind === 'publication') {
      fields(body, ['published', 'revision'], ['published', 'revision']); validateRevision(body.revision); booleanFields(body, ['published']);
      const { model, permission } = await repo.accessibleModel(user, route.id);
      requirePermission(permission, body.published ? 'canPublish' : 'canUnpublish');
      if (model.revision !== body.revision) throw new ApiError(409, 'This model changed. Refresh the workspace before saving.');
      return response(await repo.updatePublication(user, route.id, body.published, body.revision, { ...model.schedule, enabled: false, nextRunAt: null }));
    }
    if (route.kind === 'runs') {
      fields(body, ['trigger', 'target', 'period'], ['trigger']);
      if (!['manual', 'scheduled'].includes(body.trigger)) throw new ApiError(400, 'Choose a manual or scheduled run.');
      if (Object.hasOwn(body, 'target') && !['draft', 'published'].includes(body.target)) throw new ApiError(400, 'Choose the draft or published model for this run.');
      if (body.trigger === 'scheduled' && body.target === 'draft') throw new ApiError(400, 'Scheduled runs use the published model.');
      if (body.trigger === 'scheduled' && Object.hasOwn(body, 'period')) throw new ApiError(400, 'Scheduled runs use the latest completed configured reporting period.');
      let { model, permission } = await repo.accessibleModel(user, route.id, 'canRun');
      const target = body.trigger === 'scheduled' ? 'published' : body.target ?? (model.published ? 'published' : 'draft');
      if (target === 'published' && (!model.published || !model.publishedModel || model.publishedVersion < 1)) throw new ApiError(403, 'Publish this model before running its published version.');
      let catalog = singleCatalog(model, target);
      const reportingPeriod = validated(() => resolveReportingPeriod(model.schedule.reporting, catalog.models[0].model, clock(env)(), body.period ?? null));
      if (body.trigger === 'scheduled') {
        if (!model.published || !model.schedule.enabled) throw new ApiError(403, 'Only a published model with an enabled schedule can run on schedule.');
        const now = clock(env)();
        if (Date.parse(model.schedule.nextRunAt) > now) throw new ApiError(409, 'This schedule is not due yet.');
        catalog = advanceSchedule(catalog, route.id, now);
        model = await repo.claimSchedule(user, model, catalog.schedules[route.id]);
        catalog = singleCatalog(model, target);
      }
      const { run } = await executeModelRun(catalog, route.id, { trigger: body.trigger, id: repo.uuid(), now: clock(env), target, period: { start: reportingPeriod.start, end: reportingPeriod.end, kind: reportingPeriod.kind }, publishedVersion: target === 'published' ? model.publishedVersion : null,
        ...sqlAdapters(env), beforeOutput: async () => { await repo.accessibleModel(user, route.id, 'canRun'); } });
      const previous = (await repo.runs(route.id, model)).findLast(item => item.target === run.target && item.publishedVersion === run.publishedVersion && item.reportingPeriod?.start === reportingPeriod.start && item.reportingPeriod?.end === reportingPeriod.end && item.reportingPeriod?.kind === reportingPeriod.kind);
      if (previous) run.rerunOf = previous.id;
      await repo.appendRun(user, route.id, run);
      const fresh = await repo.model(route.id);
      if (!fresh) throw new ApiError(404, 'That model was deleted during the run.');
      permission = await repo.permission(user, fresh); requirePermission(permission, 'canRun');
      return response({ run, schedule: fresh.schedule, permission });
    }

    requireAdmin(await repo.user(user.id));
    if (route.kind === 'user') {
      fields(body, ['role', 'active']);
      if (!Object.keys(body).length) throw new ApiError(400, 'Choose a role or account status to change.');
      if (Object.hasOwn(body, 'role') && !USER_ROLES.includes(body.role)) throw new ApiError(400, 'Choose an administrator, editor, operator, or viewer role.');
      booleanFields(body, ['active']);
      return response(await repo.updateUser(user, route.id, body));
    }
    if (route.kind === 'permissions') {
      fields(body, ['userId', 'level'], ['userId', 'level']); userIdentifier(body.userId);
      if (!MODEL_LEVELS.includes(body.level)) throw new ApiError(400, 'Choose none, viewer, operator, or editor model access.');
      return response(await repo.setGrant(user, route.id, body.userId, body.level));
    }
    if (route.kind === 'restore') {
      fields(body, ['revision'], ['revision']); validateRevision(body.revision);
      return response(await repo.restoreModel(user, route.id, body.revision));
    }
    if (route.kind === 'policy' && request.method === 'DELETE') {
      fields(body, ['revision'], ['revision']); validateRevision(body.revision);
      const model = await repo.model(route.id);
      if (!model) throw new ApiError(404, 'That model does not exist.');
      return response(await repo.deleteModel(user, route.id, body.revision, { ...model.schedule, enabled: false, nextRunAt: null }));
    }
    if (route.kind === 'policy') {
      fields(body, ['published', 'editLocked', 'unpublishLocked', 'revision'], ['revision']); validateRevision(body.revision);
      if (Object.keys(body).length < 2) throw new ApiError(400, 'Choose a model policy to change.');
      booleanFields(body, ['published', 'editLocked', 'unpublishLocked']);
      const model = await repo.model(route.id);
      if (!model) throw new ApiError(404, 'That model does not exist.');
      const { revision, ...changes } = body;
      return response(await repo.updatePolicy(user, route.id, changes, revision, { ...model.schedule, enabled: false, nextRunAt: null }));
    }
    throw new ApiError(404, 'That API route does not exist.');
  } catch (error) {
    if (error instanceof ApiError) return response({ error: error.message }, error.status);
    if (error instanceof URIError) return response({ error: 'The URL contains an invalid identifier.' }, 400);
    console.error('Reconciliation API request failed.', error instanceof Error ? error.message : 'Unexpected error');
    return response({ error: 'The request could not be completed. Please try again.' }, 500);
  }
}
