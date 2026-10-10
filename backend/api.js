import { createCatalog, defaultSchedule, validateEditableModel, setSchedule, advanceSchedule, timeToEpoch } from '../public/management-store.js';
import { executeModelRun } from '../public/schedule-runner.js';
import { ApiError, USER_ROLES, MODEL_LEVELS, fields, safeId, validateRevision, requireAdmin, requirePermission } from './policy.js';
import { Repository } from './repository.js';
import { validateSqlSource } from '../public/sql-sources.js';
import { sqlConnections, testSqlSource, readSqlInput, sqlAdapters } from './sql-connectors.js';
import { resolveReportingPeriod } from '../public/reporting-periods.js';
import { schedulingStatus, executeStandaloneManualRun } from './scheduled-runs.js';

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
  if (path === '/api/audit') return { kind: 'audit', methods: ['GET'] };
  if (path === '/api/audit/trends') return { kind: 'auditTrends', methods: ['GET'] };
  if (path === '/api/audit/settings') return { kind: 'auditSettings', methods: ['GET','PATCH'] };
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

const AUDIT_CATEGORIES = ['measurement','mapping','model','schedule','connector','publication','permission','retention'];
function auditFilters(url, trends = false) {
  const allowed = trends ? ['modelId','itemId','from','to'] : ['modelId','actorId','category','q','from','to','cursor','limit'];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ApiError(400,'History filters contain unsupported or repeated fields.');
  const result = {};
  for (const key of allowed) if (url.searchParams.has(key)) {
    const value = url.searchParams.get(key);
    if (!value) throw new ApiError(400,'History filters cannot be empty.');
    if (key === 'modelId') result[key] = safeId(value);
    else if (key === 'actorId') result[key] = userIdentifier(value);
    else if (key === 'itemId') {
      if (value.length > 65536 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400,'Choose a valid meter identifier.');
      result[key] = value;
    } else if (key === 'category') { if (!AUDIT_CATEGORIES.includes(value)) throw new ApiError(400,'Choose an available history category.'); result[key] = value; }
    else if (key === 'q') { if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400,'Search history using at most 200 characters.'); result[key] = value.trim(); }
    else if (key === 'from' || key === 'to') result[key] = validated(() => new Date(timeToEpoch(value,'History timestamp')).toISOString());
    else if (key === 'limit') { if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) throw new ApiError(400,'Choose a history page size from 1 to 100.'); result.limit = Number(value); }
    else if (key === 'cursor') {
      try {
        if (value.length > 512 || !/^[A-Za-z0-9+/]+=*$/.test(value)) throw new Error();
        const cursor = JSON.parse(atob(value)); fields(cursor,['occurredAt','id'],['occurredAt','id']);
        cursor.id = safeId(cursor.id);
        if (new Date(timeToEpoch(cursor.occurredAt)).toISOString() !== cursor.occurredAt) throw new Error();
        result.cursor = cursor;
      } catch { throw new ApiError(400,'Choose a valid history cursor.'); }
    }
  }
  if (trends && !result.modelId) throw new ApiError(400,'Choose a model for measurement trends.');
  if (result.from && result.to && result.from >= result.to) throw new ApiError(400,'History start must be before its end.');
  return trends ? result : { ...result, limit: result.limit ?? 50 };
}

// identity is supplied only by the server's trusted authentication dispatch.
// It is never read from request bodies, headers, cookies, or query parameters.
export async function handleApi(request, env, identity) {
  try {
    const repo = new Repository(env.DB, { now: clock(env), ...(typeof env.UUID === 'function' ? { uuid: env.UUID } : {}), standaloneScheduler: env.STANDALONE_SCHEDULER === true });
    const user = await repo.authenticate(identity, env.ADMIN_EMAIL);
    const route = routeInfo(new URL(request.url).pathname);
    if (!route.methods.includes(request.method)) return new Response(JSON.stringify({ error: 'That method is not supported.' }), { status: 405, headers: { ...headers, Allow: route.methods.join(', ') } });
    if (route.kind === 'session') return response({ user, signInUrl: identity.signInUrl ?? env.SIGN_IN_URL ?? null, signOutUrl: identity.signOutUrl ?? env.SIGN_OUT_URL ?? null });
    if (route.kind === 'workspace') {
      const workspace = await repo.workspace(user);
      if (env.STANDALONE_SCHEDULER === true) workspace.scheduling = { mode: 'server', enabled: env.SCHEDULER_ENABLED !== false, pollSeconds: env.SCHEDULER_POLL_SECONDS ?? 5, executions: await schedulingStatus(repo, workspace.catalog.models.map(model => model.id)) };
      return response(workspace);
    }
    if (route.kind === 'admin') return response(await repo.admin(user));
    if (route.kind === 'audit') { await repo.pruneAudit(); return response(await repo.audit(user,auditFilters(new URL(request.url)))); }
    if (route.kind === 'auditTrends') { await repo.pruneAudit(); return response(await repo.auditTrends(user,auditFilters(new URL(request.url),true))); }
    if (route.kind === 'auditSettings' && request.method === 'GET') return response({ settings: await repo.auditSettings(user) });
    if (route.kind === 'sqlConnections') {
      requireAdmin(await repo.user(user.id));
      const data = await sqlConnections(env);
      requireAdmin(await repo.user(user.id));
      return response(data);
    }
    const body = await readBody(request);
    // Reconciliation results retain the existing twenty-run policy and never
    // enter audit history. Only configuration/account mutations prune audits.
    if (!['runs','sourceTest','sourcePreview'].includes(route.kind)) await repo.pruneAudit();
    if (route.kind === 'auditSettings') {
      fields(body,['retentionDays','revision'],['retentionDays','revision']); validateRevision(body.revision);
      if (!Number.isInteger(body.retentionDays) || body.retentionDays < 0 || body.retentionDays > 3650) throw new ApiError(400,'Choose audit retention from 1 to 3650 days, or 0 to keep history indefinitely.');
      return response(await repo.updateAuditSettings(user,body.retentionDays,body.revision));
    }

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
      if (body.trigger === 'scheduled' && env.STANDALONE_SCHEDULER === true) throw new ApiError(409, 'Scheduled reconciliation is managed by the server. Use a manual run to reconcile a selected period.');
      if (Object.hasOwn(body, 'target') && !['draft', 'published'].includes(body.target)) throw new ApiError(400, 'Choose the draft or published model for this run.');
      if (body.trigger === 'scheduled' && body.target === 'draft') throw new ApiError(400, 'Scheduled runs use the published model.');
      if (body.trigger === 'scheduled' && Object.hasOwn(body, 'period')) throw new ApiError(400, 'Scheduled runs use the latest completed configured reporting period.');
      let { model, permission } = await repo.accessibleModel(user, route.id, 'canRun');
      const checkScheduledJob = async () => {
        if (env.STANDALONE_SCHEDULER === true && await repo.first("SELECT id FROM scheduled_jobs WHERE model_id=? AND state IN ('claimed','running','output') LIMIT 1", [route.id])) throw new ApiError(409, 'A scheduled reconciliation is already running for this model. Wait for it to finish before running manually.');
      };
      await checkScheduledJob();
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
      const runOptions = { trigger: body.trigger, id: repo.uuid(), now: clock(env), target, period: { start: reportingPeriod.start, end: reportingPeriod.end, kind: reportingPeriod.kind }, publishedVersion: target === 'published' ? model.publishedVersion : null,
        ...sqlAdapters(env), beforeOutput: async () => { await repo.accessibleModel(user, route.id, 'canRun'); await checkScheduledJob(); } };
      const durableManual = env.STANDALONE_SCHEDULER === true;
      const { run } = durableManual ? await executeStandaloneManualRun(env, repo, user, model, catalog, runOptions) : await executeModelRun(catalog, route.id, runOptions);
      if (!durableManual) {
        const previous = (await repo.runs(route.id, model)).findLast(item => item.target === run.target && item.publishedVersion === run.publishedVersion && item.reportingPeriod?.start === reportingPeriod.start && item.reportingPeriod?.end === reportingPeriod.end && item.reportingPeriod?.kind === reportingPeriod.kind);
        if (previous) run.rerunOf = previous.id;
        await repo.appendRun(user, route.id, run);
      }
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
