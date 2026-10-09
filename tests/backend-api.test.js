import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from '../backend/api.js';
import { Repository } from '../backend/repository.js';
import { permissions } from '../backend/policy.js';
import { exampleModel, emptyModel, newStream } from '../public/model.js';
import { reconcile } from '../public/solver.js';

// Execute the production SQL against SQLite, matching D1's prepared/batch API.
// Authorization tests therefore exercise WHERE guards rather than mocked calls.
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'viewer',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE models(id TEXT PRIMARY KEY,name TEXT NOT NULL,model_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,published INTEGER NOT NULL DEFAULT 0,edit_locked INTEGER NOT NULL DEFAULT 0,unpublish_locked INTEGER NOT NULL DEFAULT 0,schedule_json TEXT NOT NULL,sources_json TEXT NOT NULL DEFAULT '[]',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
    CREATE TABLE model_grants(model_id TEXT NOT NULL REFERENCES models(id),user_id TEXT NOT NULL REFERENCES users(id),level TEXT NOT NULL,PRIMARY KEY(model_id,user_id));
    CREATE TABLE model_runs(id TEXT PRIMARY KEY,model_id TEXT NOT NULL REFERENCES models(id),run_json TEXT NOT NULL,started_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id));`);
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
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
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
});

test('effective editor publication is permitted independently of content locks but cannot bypass unpublish lock', async t => {
  const f = fixture(t); const created = await f.create(); const id = created.entry.id;
  await f.register(); await f.role('editor'); await f.assign(id, 'editor');
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { editLocked: true, revision: 1 })).status, 200);
  const published = await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 2 }, f.viewer);
  assert.equal(published.status, 200); assert.equal(published.body.permission.published, true); assert.equal(published.body.permission.canEdit, false);
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: false, revision: 2 }, f.viewer)).status, 409);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { unpublishLocked: true, revision: 3 })).status, 200);
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: false, revision: 4 }, f.viewer)).status, 403);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { unpublishLocked: false, revision: 4 })).status, 200);
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: false, revision: 5 }, f.viewer)).status, 200);
  await f.assign(id, 'operator');
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 6 }, f.viewer)).status, 403);
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
