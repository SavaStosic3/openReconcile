import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApi } from '../backend/api.js';
import { Repository } from '../backend/repository.js';
import { permissions } from '../backend/policy.js';
import { exampleModel, emptyModel, newStream } from '../public/model.js';
import { reconcile } from '../public/solver.js';

// Execute the production SQL against SQLite, matching D1's prepared/batch API.
// Authorization tests therefore exercise WHERE guards rather than mocked calls.
function fixture(t, { legacyModel = null } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_complete_random.sql', import.meta.url), 'utf8'));
  if (legacyModel) {
    const stamp = '2026-10-09T19:00:00.000Z';
    sqlite.prepare('INSERT INTO users(id,email,name,role,active,created_at,updated_at) VALUES (?,?,?,\'admin\',1,?,?)').run('owner-subject', 'OWNER@example.com', 'Owner', stamp, stamp);
    sqlite.prepare('INSERT INTO models(id,name,model_json,revision,published,schedule_json,created_by,created_at,updated_at) VALUES (?,?,?,1,1,?,?,?,?)').run('legacy-model', legacyModel.name, JSON.stringify(legacyModel), JSON.stringify({ enabled: false, intervalMinutes: 60, inputSourceId: null, outputSourceId: null, nextRunAt: null }), 'owner-subject', stamp, stamp);
    for (const [id, snapshot] of [['legacy-match', legacyModel], ['legacy-different', { ...legacyModel, name: 'Earlier draft' }]]) {
      const run = { id, modelId: 'legacy-model', modelName: snapshot.name, modelUpdatedAt: stamp, modelSnapshot: snapshot, trigger: 'scheduled', startedAt: stamp, finishedAt: stamp, status: 'ok', result: reconcile(snapshot) };
      sqlite.prepare('INSERT INTO model_runs(id,model_id,run_json,started_at,created_by) VALUES (?,?,?,?,?)').run(id, 'legacy-model', JSON.stringify(run), stamp, 'owner-subject');
    }
  }
  sqlite.exec(readFileSync(new URL('../drizzle/0001_published_snapshots.sql', import.meta.url), 'utf8'));
  let batchTail = Promise.resolve();
  const DB = {
    prepare(sql) {
      return {
        values: [], bind(...values) { this.values = values; return this; },
        async first() { return sqlite.prepare(sql).get(...this.values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
        async run() { const result = sqlite.prepare(sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
      };
    },
    async batch(statements) {
      // D1 serializes atomic batches; DatabaseSync needs the same queue when
      // independent requests initialize the same legacy model concurrently.
      const execute = batchTail.then(async () => {
        sqlite.exec('BEGIN');
        try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      batchTail = execute.catch(() => {});
      return execute;
    }
  };
  let time = Date.parse('2026-10-09T20:00:00.000Z'), serial = 0;
  const env = { DB, ADMIN_EMAIL: 'owner@example.com', NOW: () => time, UUID: () => `id-${String(++serial).padStart(6, '0')}` };
  const admin = { id: 'owner-subject', email: 'OWNER@example.com', name: 'Owner', signInUrl: '/auth/sign-in', signOutUrl: '/auth/sign-out' };
  const viewer = { id: 'viewer-subject', email: 'viewer@example.com', name: 'Viewer' };
  async function request(path, method = 'GET', body, identity = admin, extraHeaders = {}) {
    const headers = method === 'GET' ? {} : { Origin: 'https://balance.test', 'Content-Type': 'application/json' };
    const result = await handleApi(new Request(`https://balance.test${path}`, { method, headers: { ...headers, ...extraHeaders }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env, identity);
    return { status: result.status, body: await result.json(), headers: result.headers };
  }
  async function create() { const result = await request('/api/models', 'POST', { model: exampleModel() }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function register(identity = viewer) { return request('/api/session', 'GET', undefined, identity); }
  async function assign(modelId, level, userId = viewer.id) { const result = await request(`/api/admin/models/${modelId}/permissions`, 'PUT', { userId, level }); assert.equal(result.status, 200, JSON.stringify(result.body)); }
  async function role(value, id = viewer.id) { const result = await request(`/api/admin/users/${id}`, 'PATCH', { role: value }); assert.equal(result.status, 200, JSON.stringify(result.body)); }
  t.after(() => sqlite.close());
  return { sqlite, env, admin, viewer, request, create, register, assign, role, advance(ms) { time += ms; } };
}

test('trusted identities bootstrap only configured admin; new users see no models or admin data', async t => {
  const f = fixture(t);
  assert.equal((await f.request('/api/session', 'GET', undefined, null)).status, 401);
  assert.equal((await f.register()).body.user.role, 'viewer');
  const session = await f.register(f.admin);
  assert.equal(session.body.user.role, 'admin'); assert.equal(session.body.signOutUrl, '/auth/sign-out');
  await f.create();
  const workspace = await f.request('/api/workspace', 'GET', undefined, f.viewer);
  assert.deepEqual(workspace.body.catalog.models, []); assert.equal(workspace.body.catalog.activeId, null);
  assert.equal((await f.request('/api/admin', 'GET', undefined, f.viewer)).status, 403);
  assert.equal((await f.request('/api/session?role=admin', 'GET', undefined, null, { 'X-User-Role': 'admin' })).status, 401);
});

test('global role and explicit model level intersect for visibility, running and edits', async t => {
  const f = fixture(t); const model = await f.create(); await f.register();
  await f.assign(model.entry.id, 'editor');
  let workspace = await f.request('/api/workspace', 'GET', undefined, f.viewer);
  assert.equal(workspace.body.permissions[model.entry.id].canView, true);
  assert.equal(workspace.body.permissions[model.entry.id].canRun, false);
  assert.equal((await f.request(`/api/models/${model.entry.id}/runs`, 'POST', { trigger: 'manual' }, f.viewer)).status, 403);
  await f.role('editor'); await f.assign(model.entry.id, 'viewer');
  assert.equal((await f.request(`/api/models/${model.entry.id}`, 'PATCH', { model: exampleModel(), revision: 1 }, f.viewer)).status, 403);
  await f.assign(model.entry.id, 'operator');
  assert.equal((await f.request(`/api/models/${model.entry.id}/runs`, 'POST', { trigger: 'manual' }, f.viewer)).status, 200);
  await f.assign(model.entry.id, 'none');
  workspace = await f.request('/api/workspace', 'GET', undefined, f.viewer);
  assert.equal(workspace.body.catalog.models.length, 0);
  assert.equal((await f.request(`/api/models/${model.entry.id}/runs`, 'POST', { trigger: 'manual' }, f.viewer)).status, 403);
});

test('only editors/admins create, creator grant is scoped to the new model, client roles rejected', async t => {
  const f = fixture(t); await f.register(); await f.register(f.admin);
  assert.equal((await f.request('/api/models', 'POST', { model: exampleModel() }, f.viewer)).status, 403);
  assert.equal((await f.request('/api/models', 'POST', { model: exampleModel(), role: 'admin' })).status, 400);
  await f.role('editor');
  const created = await f.request('/api/models', 'POST', { model: exampleModel() }, f.viewer);
  assert.equal(created.status, 201); assert.equal(created.body.permission.canEdit, true); assert.equal(created.body.permission.published, false);
  assert.equal(created.body.permission.canPublish, true);
  await f.create();
  assert.equal((await f.request('/api/workspace', 'GET', undefined, f.viewer)).body.catalog.models.length, 1);
});

test('editing locks cover admin and editor model/measurement changes; unlock is required', async t => {
  const f = fixture(t); const model = await f.create(); const id = model.entry.id;
  await f.register(); await f.role('editor'); await f.assign(id, 'editor');
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { editLocked: true, revision: 1 })).status, 200);
  const changedModel = exampleModel(); changedModel.streams[0].value = 999;
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: changedModel, revision: 2 })).status, 403);
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: changedModel, revision: 2 }, f.viewer)).status, 403);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { editLocked: false, revision: 2 })).status, 200);
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: changedModel, revision: 3 }, f.viewer)).status, 200);
  assert.equal((await f.request('/api/workspace')).body.catalog.models[0].model.streams[0].value, 999);
});

test('publication is explicit; draft schedules denied and unpublish lock applies to administrators', async t => {
  const f = fixture(t); const model = await f.create(); const id = model.entry.id;
  assert.equal((await f.request(`/api/models/${id}/schedule`, 'PATCH', { changes: { enabled: true }, revision: 1 })).status, 403);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { published: true, unpublishLocked: true, revision: 1 })).status, 200);
  const scheduled = await f.request(`/api/models/${id}/schedule`, 'PATCH', { changes: { enabled: true, intervalMinutes: 1 }, revision: 2 });
  assert.equal(scheduled.status, 200); assert.equal(scheduled.body.schedule.enabled, true);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { published: false, unpublishLocked: false, revision: 3 })).status, 403);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { unpublishLocked: false, revision: 3 })).status, 200);
  const unpublished = await f.request(`/api/admin/models/${id}`, 'PATCH', { published: false, revision: 4 });
  assert.equal(unpublished.status, 200); assert.equal(unpublished.body.schedule.enabled, false); assert.equal(unpublished.body.schedule.nextRunAt, null);
});

test('optimistic revisions reject stale content, schedule and policy writes', async t => {
  const f = fixture(t); const model = await f.create(); const id = model.entry.id;
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: exampleModel(), revision: 1 })).status, 200);
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: exampleModel(), revision: 1 })).status, 409);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { published: true, revision: 1 })).status, 409);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { published: true, revision: 2 })).status, 200);
  assert.equal((await f.request(`/api/models/${id}/schedule`, 'PATCH', { changes: { enabled: true }, revision: 2 })).status, 409);
});

test('only administrators soft-delete models, pause schedules, and restore original data', async t => {
  const f = fixture(t); const model = await f.create(); const id = model.entry.id;
  await f.register(); await f.role('editor'); await f.assign(id, 'editor');
  await f.request(`/api/admin/models/${id}`, 'PATCH', { published: true, revision: 1 });
  await f.request(`/api/models/${id}/schedule`, 'PATCH', { changes: { enabled: true }, revision: 2 });
  assert.equal((await f.request(`/api/admin/models/${id}`, 'DELETE', { revision: 3 }, f.viewer)).status, 403);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'DELETE', { revision: 3 })).status, 200);
  assert.equal((await f.request('/api/workspace')).body.catalog.models.length, 0);
  const deleted = (await f.request('/api/admin')).body.models.find(item => item.id === id);
  assert.ok(deleted.deletedAt); assert.equal(deleted.scheduleEnabled, false);
  const restored = await f.request(`/api/admin/models/${id}/restore`, 'POST', { revision: 4 });
  assert.equal(restored.status, 200); assert.deepEqual(restored.body.entry.model, exampleModel()); assert.equal(restored.body.schedule.enabled, false); assert.equal(restored.body.permission.published, false);
});

test('last active administrator cannot be demoted or disabled; existing accounts never auto-promote', async t => {
  const f = fixture(t); await f.register(f.admin); await f.register();
  assert.equal((await f.request(`/api/admin/users/${f.admin.id}`, 'PATCH', { role: 'viewer' })).status, 409);
  assert.equal((await f.request(`/api/admin/users/${f.admin.id}`, 'PATCH', { active: false })).status, 409);
  await f.role('admin');
  assert.equal((await f.request(`/api/admin/users/${f.admin.id}`, 'PATCH', { role: 'viewer' })).status, 200);
  assert.equal((await f.register(f.admin)).body.user.role, 'viewer');
  assert.equal((await f.request('/api/admin')).status, 403);
  const disabled = await f.request(`/api/admin/users/${f.admin.id}`, 'PATCH', { active: false }, f.viewer);
  assert.equal(disabled.status, 200); assert.equal((await f.register(f.admin)).status, 403);
});

test('scheduled runs validate due time and atomically claim one run across concurrent requests', async t => {
  const f = fixture(t); const model = await f.create(); const id = model.entry.id;
  await f.request(`/api/admin/models/${id}`, 'PATCH', { published: true, revision: 1 });
  await f.request(`/api/models/${id}/schedule`, 'PATCH', { changes: { enabled: true, intervalMinutes: 1 }, revision: 2 });
  assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'scheduled' })).status, 409);
  f.advance(5 * 60_000);
  const attempts = await Promise.all([f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'scheduled' }), f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'scheduled' })]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
  const success = attempts.find(result => result.status === 200);
  assert.equal(success.body.run.status, 'ok'); assert.equal(success.body.run.trigger, 'scheduled');
  assert.ok(Date.parse(success.body.schedule.nextRunAt) > f.env.NOW());
  assert.equal((await f.request('/api/workspace')).body.catalog.runs[id].length, 1);
});

test('run results retain snapshots and correct reconciliation with bounded per-model history', async t => {
  const f = fixture(t); const model = await f.create(); const other = await f.create(); const id = model.entry.id;
  for (let i = 0; i < 22; i++) { f.advance(1000); assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual' })).status, 200); }
  const workspace = await f.request('/api/workspace'); const runs = workspace.body.catalog.runs[id];
  assert.equal(runs.length, 20); assert.equal(workspace.body.catalog.runs[other.entry.id].length, 0);
  assert.deepEqual(runs.at(-1).modelSnapshot, exampleModel());
  const feed = runs.at(-1).result.streams.find(stream => stream.id === 'f1');
  assert.ok(Math.abs(feed.value - 99.44444444444444) < 1e-8);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM model_runs WHERE model_id=?').get(id).count, 20);
});

test('same-origin JSON writes, body size, strict fields/routes/methods and model validation', async t => {
  const f = fixture(t); await f.register(f.admin);
  assert.equal((await f.request('/api/models', 'POST', { model: exampleModel() }, f.admin, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.request('/api/models', 'POST', { model: exampleModel() }, f.admin, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/models', 'POST', '{broken')).status, 400);
  assert.equal((await f.request('/api/models', 'POST', { model: { nonsense: true } })).status, 400);
  assert.equal((await f.request('/api/models', 'POST', JSON.stringify({ model: 'x'.repeat(2_000_000) }))).status, 413);
  assert.equal((await f.request('/api/missing')).status, 404);
  assert.equal((await f.request('/api/workspace', 'POST', {})).status, 405);
  assert.equal((await f.request('/api/models/__proto__', 'PATCH', {})).status, 400);
  const model = await f.create();
  assert.equal((await f.request(`/api/models/${model.entry.id}`, 'PATCH', { model: exampleModel(), revision: 0 })).status, 400);
  assert.equal((await f.request(`/api/admin/models/${model.entry.id}`, 'PATCH', { published: 'yes', revision: 1 })).status, 400);
});

test('SQL write boundary rechecks grants, user activity and locks after an earlier read', async t => {
  const f = fixture(t); const created = await f.create(); const id = created.entry.id;
  await f.register(); await f.role('editor'); await f.assign(id, 'editor');
  const repo = new Repository(f.env.DB, { now: f.env.NOW, uuid: f.env.UUID });
  const user = await repo.user(f.viewer.id), snapshot = await repo.accessibleModel(user, id, 'canEdit');
  await f.assign(id, 'none');
  await assert.rejects(() => repo.updateModel(user, id, exampleModel(), snapshot.model.revision), error => error.status === 403);
  await f.assign(id, 'editor');
  await f.request(`/api/admin/users/${f.viewer.id}`, 'PATCH', { active: false });
  await assert.rejects(() => repo.updateModel(user, id, exampleModel(), snapshot.model.revision), error => error.status === 403);
  assert.equal((await f.request('/api/workspace')).body.permissions[id].revision, 1);
});

test('permission matrix reserves deletion for admins and publication for effective editors', () => {
  for (const role of ['viewer', 'operator', 'editor']) for (const grant of ['none', 'viewer', 'operator', 'editor']) {
    const policy = permissions({ role, active: true }, { revision: 1, published: true, editLocked: false, unpublishLocked: false }, grant);
    assert.equal(policy.canDelete, false); assert.equal(policy.canPublish, false); assert.equal(policy.canUnpublish, role === 'editor' && grant === 'editor');
  }
  const locked = permissions({ role: 'admin', active: true }, { revision: 1, published: true, editLocked: true, unpublishLocked: true });
  assert.equal(locked.canEdit, false); assert.equal(locked.canUnpublish, false); assert.equal(locked.canDelete, true);
  for (const role of ['viewer', 'operator', 'editor']) for (const grant of ['none', 'viewer', 'operator', 'editor']) {
    const changed = permissions({ role, active: true }, { revision: 2, published: true, editLocked: false, unpublishLocked: false, hasUnpublishedChanges: true }, grant);
    assert.equal(changed.canPublish, role === 'editor' && grant === 'editor');
  }
  assert.equal(permissions({ role: 'admin', active: true }, { published: true, editLocked: true, hasUnpublishedChanges: true }).canPublish, false);
});

test('effective editor publication requires unlocked edits and cannot bypass unpublish lock', async t => {
  const f = fixture(t); const created = await f.create(); const id = created.entry.id;
  await f.register(); await f.role('editor'); await f.assign(id, 'editor');
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { editLocked: true, revision: 1 })).status, 200);
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 2 }, f.viewer)).status, 403);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { published: true, revision: 2 })).status, 403);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { editLocked: false, revision: 2 })).status, 200);
  const published = await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 3 }, f.viewer);
  assert.equal(published.status, 200); assert.equal(published.body.permission.published, true); assert.equal(published.body.permission.canEdit, true);
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: false, revision: 3 }, f.viewer)).status, 409);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { unpublishLocked: true, revision: 4 })).status, 200);
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: false, revision: 5 }, f.viewer)).status, 403);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { unpublishLocked: false, revision: 5 })).status, 200);
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: false, revision: 6 }, f.viewer)).status, 200);
  await f.assign(id, 'operator');
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 7 }, f.viewer)).status, 403);
});

test('published snapshots stay isolated from draft edits and manual or scheduled runs select the requested version', async t => {
  const f = fixture(t); const created = await f.create(); const id = created.entry.id;
  assert.equal(created.entry.publishedModel, null); assert.equal(created.entry.publishedVersion, 0); assert.equal(created.entry.publishedAt, null);
  const first = await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 1 });
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.entry.publishedVersion, 1);
  assert.deepEqual(first.body.entry.publishedModel, exampleModel()); assert.equal(first.body.entry.hasUnpublishedChanges, false);
  assert.equal(first.body.permission.canPublish, false);
  f.advance(1000);
  const draft = exampleModel(); draft.name = 'Edited plant'; draft.nodes[1].kind = 'pump'; draft.streams[0].value = 120;
  const saved = await f.request(`/api/models/${id}`, 'PATCH', { model: draft, revision: 2 });
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.entry.model, draft);
  assert.deepEqual(saved.body.entry.publishedModel, exampleModel()); assert.equal(saved.body.entry.publishedAt, first.body.entry.publishedAt);
  assert.equal(saved.body.entry.hasUnpublishedChanges, true); assert.equal(saved.body.permission.canPublish, true);
  const publishedRun = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual' });
  assert.equal(publishedRun.status, 200); assert.equal(publishedRun.body.run.target, 'published'); assert.equal(publishedRun.body.run.publishedVersion, 1);
  assert.deepEqual(publishedRun.body.run.modelSnapshot, exampleModel()); assert.deepEqual(publishedRun.body.run.result, reconcile(exampleModel()));
  const draftRun = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'draft' });
  assert.equal(draftRun.status, 200); assert.equal(draftRun.body.run.target, 'draft'); assert.equal(draftRun.body.run.publishedVersion, null);
  assert.deepEqual(draftRun.body.run.modelSnapshot, draft); assert.deepEqual(draftRun.body.run.result, reconcile(draft));
  assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'scheduled', target: 'draft' })).status, 400);
  assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'other' })).status, 400);
  assert.equal((await f.request(`/api/models/${id}/schedule`, 'PATCH', { changes: { enabled: true, intervalMinutes: 1 }, revision: 3 })).status, 200);
  f.advance(60_000);
  const scheduled = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'scheduled' });
  assert.equal(scheduled.status, 200); assert.equal(scheduled.body.run.target, 'published'); assert.equal(scheduled.body.run.publishedVersion, 1);
  assert.deepEqual(scheduled.body.run.modelSnapshot, exampleModel()); assert.deepEqual(scheduled.body.run.result, reconcile(exampleModel()));
  const promoted = await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: scheduled.body.permission.revision });
  assert.equal(promoted.status, 200); assert.equal(promoted.body.entry.publishedVersion, 2); assert.deepEqual(promoted.body.entry.publishedModel, draft);
  assert.equal(promoted.body.entry.hasUnpublishedChanges, false); assert.equal(promoted.body.permission.canPublish, false);
  const latest = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
  assert.equal(latest.body.run.publishedVersion, 2); assert.deepEqual(latest.body.run.modelSnapshot, draft);
  const history = (await f.request('/api/workspace')).body.catalog.runs[id];
  assert.equal(history.find(run => run.id === publishedRun.body.run.id).publishedVersion, 1);
  assert.deepEqual(history.find(run => run.id === publishedRun.body.run.id).modelSnapshot, exampleModel());
});

test('unpublishing pauses scheduling and retains snapshot history without allowing published execution', async t => {
  const f = fixture(t); const created = await f.create(); const id = created.entry.id;
  assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' })).status, 403);
  const draft = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual' });
  assert.equal(draft.body.run.target, 'draft'); assert.equal(draft.body.run.publishedVersion, null);
  await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 1 });
  await f.request(`/api/models/${id}/schedule`, 'PATCH', { changes: { enabled: true }, revision: 2 });
  const unpublished = await f.request(`/api/models/${id}/publication`, 'PATCH', { published: false, revision: 3 });
  assert.equal(unpublished.status, 200); assert.equal(unpublished.body.permission.published, false); assert.equal(unpublished.body.schedule.enabled, false);
  assert.equal(unpublished.body.entry.publishedVersion, 1); assert.deepEqual(unpublished.body.entry.publishedModel, exampleModel());
  assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' })).status, 403);
  const republished = await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 4 });
  assert.equal(republished.status, 200); assert.equal(republished.body.entry.publishedVersion, 2);
});

test('saving administrator lock settings never silently republishes an edited draft', async t => {
  const f = fixture(t); const created = await f.create(); const id = created.entry.id;
  await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 1 });
  const draft = exampleModel(); draft.streams[0].value = 150;
  await f.request(`/api/models/${id}`, 'PATCH', { model: draft, revision: 2 });
  const locked = await f.request(`/api/admin/models/${id}`, 'PATCH', { published: true, editLocked: true, unpublishLocked: true, revision: 3 });
  assert.equal(locked.status, 200); assert.equal(locked.body.entry.publishedVersion, 1);
  assert.deepEqual(locked.body.entry.publishedModel, exampleModel()); assert.deepEqual(locked.body.entry.model, draft);
  assert.equal(locked.body.entry.hasUnpublishedChanges, true); assert.equal(locked.body.permission.canPublish, false);
});

test('schema-only migration projects existing active models and legacy results without changing their data', async t => {
  const f = fixture(t, { legacyModel: exampleModel() });
  const pending = readFileSync(new URL('../drizzle/0001_published_snapshots.sql', import.meta.url), 'utf8');
  const statements = pending.split('--> statement-breakpoint').map(statement => statement.trim()).filter(Boolean);
  assert.equal(statements.length, 3); for (const statement of statements) assert.match(statement, /^ALTER TABLE `models` ADD /);
  const persisted = f.sqlite.prepare('SELECT * FROM models WHERE id=\'legacy-model\'').get();
  assert.equal(persisted.published_model_json, null); assert.equal(persisted.published_version, 0); assert.equal(persisted.revision, 1);
  const workspace = await f.request('/api/workspace'); assert.equal(workspace.status, 200);
  const entry = workspace.body.catalog.models.find(item => item.id === 'legacy-model');
  assert.deepEqual(entry.model, exampleModel()); assert.deepEqual(entry.publishedModel, exampleModel());
  assert.equal(entry.publishedVersion, 1); assert.equal(entry.publishedAt, '2026-10-09T19:00:00.000Z'); assert.equal(entry.hasUnpublishedChanges, false);
  const history = workspace.body.catalog.runs['legacy-model'];
  assert.equal(history.find(run => run.id === 'legacy-match').target, 'published'); assert.equal(history.find(run => run.id === 'legacy-match').publishedVersion, 1);
  assert.equal(history.find(run => run.id === 'legacy-different').target, 'draft'); assert.equal(history.find(run => run.id === 'legacy-different').publishedVersion, null);
  assert.equal(f.sqlite.prepare('SELECT published_version FROM models WHERE id=\'legacy-model\'').get().published_version, 0);
  const admin = await f.request('/api/admin'); assert.equal(admin.body.models.find(model => model.id === 'legacy-model').publishedVersion, 1);
  assert.equal(f.sqlite.prepare('SELECT published_version FROM models WHERE id=\'legacy-model\'').get().published_version, 0);
});

test('first legacy draft edit initializes its live copy and result provenance before changing the draft', async t => {
  const f = fixture(t, { legacyModel: exampleModel() });
  const previous = f.sqlite.prepare('SELECT * FROM models WHERE id=\'legacy-model\'').get();
  const draft = exampleModel(); draft.streams[0].value = 150;
  const edited = await f.request('/api/models/legacy-model', 'PATCH', { model: draft, revision: 1 });
  assert.equal(edited.status, 200); assert.deepEqual(edited.body.entry.model, draft); assert.deepEqual(edited.body.entry.publishedModel, exampleModel());
  assert.equal(edited.body.entry.publishedVersion, 1); assert.equal(edited.body.entry.publishedAt, previous.updated_at); assert.equal(edited.body.entry.hasUnpublishedChanges, true);
  assert.equal(edited.body.permission.revision, 2);
  const persisted = f.sqlite.prepare('SELECT * FROM models WHERE id=\'legacy-model\'').get();
  assert.equal(persisted.schedule_json, previous.schedule_json); assert.equal(persisted.sources_json, previous.sources_json);
  assert.equal(persisted.edit_locked, previous.edit_locked); assert.equal(persisted.unpublish_locked, previous.unpublish_locked);
  const first = JSON.parse(f.sqlite.prepare('SELECT run_json FROM model_runs WHERE id=\'legacy-match\'').get().run_json);
  assert.equal(first.target, 'published'); assert.equal(first.publishedVersion, 1);
  const promoted = await f.request('/api/models/legacy-model/publication', 'PATCH', { published: true, revision: 2 });
  assert.equal(promoted.status, 200); assert.equal(promoted.body.entry.publishedVersion, 2);
  const historical = (await f.request('/api/workspace')).body.catalog.runs['legacy-model'].find(run => run.id === 'legacy-match');
  assert.equal(historical.target, 'published'); assert.equal(historical.publishedVersion, 1); assert.deepEqual(historical.modelSnapshot, exampleModel());
});

test('concurrent first accesses initialize a legacy publication once without changing revision or any live settings', async t => {
  const f = fixture(t, { legacyModel: exampleModel() });
  const before = f.sqlite.prepare('SELECT * FROM models WHERE id=\'legacy-model\'').get();
  const repo = new Repository(f.env.DB, { now: f.env.NOW, uuid: f.env.UUID });
  const models = await Promise.all([repo.model('legacy-model'), repo.model('legacy-model'), repo.model('legacy-model')]);
  for (const model of models) { assert.equal(model.publishedVersion, 1); assert.equal(model.revision, 1); assert.deepEqual(model.publishedModel, exampleModel()); }
  const after = f.sqlite.prepare('SELECT * FROM models WHERE id=\'legacy-model\'').get();
  for (const key of Object.keys(before).filter(key => !['published_model_json', 'published_version', 'published_at'].includes(key))) assert.equal(after[key], before[key], key);
  assert.equal(after.published_version, 1); assert.equal(after.published_at, before.updated_at);
  await repo.model('legacy-model'); assert.equal(f.sqlite.prepare('SELECT published_version FROM models WHERE id=\'legacy-model\'').get().published_version, 1);
});

test('legacy initialization tags at most twenty runs and never auto-publishes an unpublished model', async t => {
  const f = fixture(t, { legacyModel: exampleModel() });
  const base = JSON.parse(f.sqlite.prepare('SELECT run_json FROM model_runs WHERE id=\'legacy-match\'').get().run_json);
  for (let index = 0; index < 25; index++) {
    const id = `legacy-extra-${String(index).padStart(2, '0')}`, stamp = new Date(Date.parse(base.startedAt) + (index + 1) * 1000).toISOString();
    f.sqlite.prepare('INSERT INTO model_runs(id,model_id,run_json,started_at,created_by) VALUES (?,?,?,?,?)').run(id, 'legacy-model', JSON.stringify({ ...base, id, startedAt: stamp, finishedAt: stamp }), stamp, 'owner-subject');
  }
  const repo = new Repository(f.env.DB, { now: f.env.NOW });
  await repo.model('legacy-model');
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM model_runs WHERE json_type(run_json,'$.target') IS NOT NULL").get().count, 20);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM model_runs WHERE json_type(run_json,'$.target') IS NULL").get().count, 7);
  const created = await f.create(); await repo.model(created.entry.id);
  assert.equal(f.sqlite.prepare('SELECT published,published_version,published_model_json FROM models WHERE id=?').get(created.entry.id).published, 0);
  assert.equal(f.sqlite.prepare('SELECT published_version FROM models WHERE id=?').get(created.entry.id).published_version, 0);
  // An old inactive model also remains unpublished after first access.
  f.sqlite.prepare('UPDATE models SET published=0,published_model_json=NULL,published_version=0,published_at=NULL WHERE id=\'legacy-model\'').run();
  const inactive = await repo.model('legacy-model'); assert.equal(inactive.published, false); assert.equal(inactive.publishedModel, null); assert.equal(inactive.publishedVersion, 0);
});

test('schedule claims retain the selected publication if a newer publication appears immediately afterward', async t => {
  const f = fixture(t); const created = await f.create(); const id = created.entry.id;
  await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 1 });
  await f.request(`/api/models/${id}/schedule`, 'PATCH', { changes: { enabled: true, intervalMinutes: 1 }, revision: 2 });
  f.advance(60_000);
  const prepare = f.env.DB.prepare;
  let interposed = false;
  f.env.DB.prepare = sql => {
    const statement = prepare(sql), execute = statement.run;
    if (sql.startsWith('UPDATE models SET schedule_json=?') && sql.includes('schedule_json=? AND')) {
      statement.run = async function () {
        const result = await execute.call(this);
        if (result.meta.changes && !interposed) {
          interposed = true;
          const newer = exampleModel(); newer.streams[0].value = 130;
          f.sqlite.prepare('UPDATE models SET model_json=?,published_model_json=?,published_version=2,revision=revision+1 WHERE id=?').run(JSON.stringify(newer), JSON.stringify(newer), id);
        }
        return result;
      };
    }
    return statement;
  };
  const executed = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'scheduled' });
  assert.equal(executed.status, 200, JSON.stringify(executed.body)); assert.equal(interposed, true);
  assert.equal(executed.body.run.target, 'published'); assert.equal(executed.body.run.publishedVersion, 1);
  assert.deepEqual(executed.body.run.modelSnapshot, exampleModel());
  assert.equal((await f.request('/api/workspace')).body.catalog.models[0].publishedVersion, 2);
});

test('invalid draft readings are preserved and recorded as an invalid run rather than discarded', async t => {
  const f = fixture(t); const created = await f.create(); const id = created.entry.id;
  const draft = exampleModel(); draft.streams[0].value = -50;
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: draft, revision: 1 })).status, 200);
  const executed = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual' });
  assert.equal(executed.status, 200); assert.equal(executed.body.run.status, 'invalid');
  assert.equal(executed.body.run.modelSnapshot.streams[0].value, -50);
  assert.equal((await f.request('/api/workspace')).body.catalog.runs[id][0].status, 'invalid');
});

test('concurrent administrator self-demotions retain one active administrator', async t => {
  const f = fixture(t); await f.register(f.admin); await f.register(); await f.role('admin');
  const changed = await Promise.all([
    f.request(`/api/admin/users/${f.admin.id}`, 'PATCH', { role: 'viewer' }, f.admin),
    f.request(`/api/admin/users/${f.viewer.id}`, 'PATCH', { role: 'viewer' }, f.viewer)
  ]);
  assert.deepEqual(changed.map(result => result.status).sort(), [200, 409]);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM users WHERE role='admin' AND active=1").get().count, 1);
});

test('new equipment kinds persist through authenticated saves and reconcile as ordinary mass-conserving units', async t => {
  const f = fixture(t);
  const kinds = ['process', 'mixer', 'splitter', 'pump', 'compressor', 'valve', 'heatExchanger', 'filter', 'cyclone', 'conveyor'];
  const model = emptyModel(); model.name = 'Equipment symbol validation';
  model.nodes = [
    { id: 'symbol-feed', kind: 'inlet', name: 'Feed', x: 100, y: 200 },
    ...kinds.map((kind, index) => ({ id: `symbol-${kind}`, kind, name: kind, x: 300 + index * 180, y: 200 })),
    { id: 'symbol-output', kind: 'outlet', name: 'Product', x: 2300, y: 200 }
  ];
  model.streams = model.nodes.slice(0, -1).map((node, index) => ({ ...newStream(node.id, model.nodes[index + 1].id, index + 1), id: `symbol-flow-${index}` }));
  Object.assign(model.streams[0], { measured: true, value: 100, uncertainty: 1, uncertaintyType: 'absolute' });
  Object.assign(model.streams.at(-1), { measured: true, value: 95, uncertainty: 2, uncertaintyType: 'absolute' });
  const created = await f.request('/api/models', 'POST', { model });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.entry.id;
  assert.deepEqual((await f.request('/api/workspace')).body.catalog.models.find(entry => entry.id === id).model, model);
  const changed = structuredClone(model);
  changed.nodes.find(node => node.kind === 'pump').kind = 'filter';
  const saved = await f.request(`/api/models/${id}`, 'PATCH', { model: changed, revision: 1 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.entry.model, changed);
  const unknown = structuredClone(changed); unknown.nodes[1].kind = 'unknown-equipment';
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: unknown, revision: 2 })).status, 400);
  const executed = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual' });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.deepEqual(executed.body.run.modelSnapshot, changed);
  const baseline = structuredClone(changed);
  for (const node of baseline.nodes) if (node.kind !== 'inlet' && node.kind !== 'outlet') node.kind = 'process';
  assert.deepEqual(executed.body.run.result, reconcile(baseline));
  assert.equal(executed.body.run.result.balances.length, kinds.length);
  for (const stream of executed.body.run.result.streams) assert.ok(Math.abs(stream.value - 99) < 1e-8);
  for (const balance of executed.body.run.result.balances) assert.ok(Math.abs(balance.reconciled) < 1e-8);
});
