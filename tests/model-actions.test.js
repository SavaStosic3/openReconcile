import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createModelActions, modelActionPermissions } from '../public/model-actions.js';
import { exampleModel } from '../public/model.js';
import { handleApi } from '../backend/api.js';
import { permissions } from '../backend/policy.js';
import { Repository } from '../backend/repository.js';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of ['0000_complete_random.sql', '0001_published_snapshots.sql', '0002_elite_layla_miller.sql', '0003_kind_tempest.sql']) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  }
  let serial = 0, tail = Promise.resolve();
  const DB = {
    prepare(sql) {
      return {
        values: [], bind(...values) { this.values = values; return this; },
        async first() { return sqlite.prepare(sql).get(...this.values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...this.values).changes) } }; }
      };
    },
    batch(statements) {
      const operation = tail.then(async () => {
        sqlite.exec('BEGIN');
        try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      tail = operation.catch(() => {});
      return operation;
    }
  };
  const env = { DB, ADMIN_EMAIL: 'owner@example.test', NOW: () => Date.parse('2026-10-10T12:00:00.000Z'), UUID: () => `id-${String(++serial).padStart(8, '0')}` };
  const owner = { id: 'owner', email: 'owner@example.test', name: 'Owner' };
  const editor = { id: 'editor', email: 'editor@example.test', name: 'Editor' };
  const calls = [], repo = new Repository(DB, { now: env.NOW, uuid: env.UUID });
  async function request(path, method = 'GET', body, identity = owner) {
    calls.push({ path, method, body: structuredClone(body), identity: identity.id });
    const response = await handleApi(new Request(`https://balance.test${path}`, {
      method, headers: method === 'GET' ? {} : { Origin: 'https://balance.test', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env, identity);
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error); error.status = response.status; throw error; }
    return result;
  }
  async function connect(identity = owner) {
    let state = await request('/api/workspace', 'GET', undefined, identity);
    const backend = {
      get user() { return structuredClone(state.user); },
      get workspace() { return structuredClone(state); },
      permission(id) { return structuredClone(state.permissions[id] ?? {}); },
      async flush() {},
      async refresh() {
        const activeId = state.catalog.activeId;
        state = await request('/api/workspace', 'GET', undefined, identity);
        if (state.catalog.models.some(entry => entry.id === activeId)) state.catalog.activeId = activeId;
        return structuredClone(state);
      },
      api(path, method, body) { return request(path, method, body, identity); },
      async create(model) {
        const result = await request('/api/models', 'POST', { model }, identity);
        state.catalog.models.push(result.entry);
        state.permissions[result.entry.id] = result.permission;
        state.catalog.schedules[result.entry.id] = result.schedule;
        state.catalog.sources[result.entry.id] = result.sources;
        state.catalog.runs[result.entry.id] = result.runs;
        state.catalog.activeId = result.entry.id;
        return structuredClone(result.entry);
      },
      select(id) { state.catalog.activeId = id; }
    };
    return backend;
  }
  async function create(model = exampleModel()) { return (await request('/api/models', 'POST', { model })).entry; }
  t.after(() => sqlite.close());
  return { sqlite, repo, request, connect, create, calls, owner, editor };
}

test('card action permissions match edit locks, global creation roles, model access and administrator deletion', () => {
  const cases = [
    ['viewer', 'viewer', false, { canRename: false, canDuplicate: false, canDelete: false }],
    ['operator', 'editor', false, { canRename: false, canDuplicate: false, canDelete: false }],
    ['editor', 'viewer', false, { canRename: false, canDuplicate: true, canDelete: false }],
    ['editor', 'editor', false, { canRename: true, canDuplicate: true, canDelete: false }],
    ['editor', 'editor', true, { canRename: false, canDuplicate: true, canDelete: false }],
    ['editor', 'none', false, { canRename: false, canDuplicate: false, canDelete: false }],
    ['admin', 'none', false, { canRename: true, canDuplicate: true, canDelete: true }],
    ['admin', 'none', true, { canRename: false, canDuplicate: true, canDelete: true }]
  ];
  for (const [role, grant, editLocked, expected] of cases) {
    const user = { role, active: true };
    assert.deepEqual(modelActionPermissions(user, permissions(user, { revision: 1, published: true, editLocked, unpublishLocked: true }, grant)), expected, `${role}/${grant}/locked=${editLocked}`);
  }
  assert.deepEqual(modelActionPermissions({ role: 'admin', active: false }, { canView: true, canEdit: true, canDelete: true }), { canRename: false, canDuplicate: false, canDelete: false });
  assert.deepEqual(modelActionPermissions(null), { canRename: false, canDuplicate: false, canDelete: false });
});

test('rename saves pending measurements first, uses the latest revision and changes only the draft name', async t => {
  const f = fixture(t), entry = await f.create();
  await f.request(`/api/models/${entry.id}/publication`, 'PATCH', { published: true, revision: 1 });
  const backend = await f.connect(), actions = createModelActions({ backend });
  let pending = true;
  backend.flush = async () => {
    if (!pending) return;
    pending = false;
    const model = structuredClone(entry.model);
    model.streams[0].value = 123;
    model.streams[0].dataMapping = { sourceName: 'PLANT.FEED' };
    await f.request(`/api/models/${entry.id}`, 'PATCH', { model, revision: 2 });
  };
  f.calls.length = 0;
  const result = await actions.rename(entry.id, '  Receiving line  ');
  const stored = await f.repo.model(entry.id);
  assert.equal(result.action, 'rename'); assert.equal(result.entry.model.name, 'Receiving line');
  assert.equal(result.activeId, entry.id);
  assert.equal(stored.model.streams[0].value, 123);
  assert.deepEqual(stored.model.streams[0].dataMapping, { sourceName: 'PLANT.FEED' });
  assert.deepEqual(stored.publishedModel, entry.model);
  assert.equal(stored.publishedVersion, 1); assert.equal(stored.published, true);
  assert.equal(stored.hasUnpublishedChanges, true);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').at(-1).body.revision, 3);
  assert.ok((await f.request(`/api/audit?modelId=${entry.id}`)).events.some(event => event.category === 'model' && event.changes.some(change => change.field === 'name' && change.after === 'Receiving line')));
});

test('rename validates names without a request and blocks a newly locked model after refreshing', async t => {
  const f = fixture(t), entry = await f.create(), backend = await f.connect(), actions = createModelActions({ backend });
  f.calls.length = 0;
  for (const value of ['', '   ', 'a'.repeat(161), null]) await assert.rejects(actions.rename(entry.id, value), /1–160/);
  assert.equal(f.calls.length, 0);
  await f.request(`/api/admin/models/${entry.id}`, 'PATCH', { revision: 1, editLocked: true });
  assert.equal(actions.permissions(entry.id).canRename, true, 'The initial card had editing permission.');
  f.calls.length = 0;
  await assert.rejects(actions.rename(entry.id, 'Locked rename'), /permission to rename/);
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
  assert.equal(actions.busy, false);
  assert.equal((await f.repo.model(entry.id)).model.name, entry.model.name);
});

test('duplicate copies the latest draft as a detached unpublished model, retaining the previous selection', async t => {
  const f = fixture(t), entry = await f.create();
  await f.request(`/api/models/${entry.id}/publication`, 'PATCH', { published: true, revision: 1 });
  const model = structuredClone(entry.model); model.name = 'Working draft'; model.streams[0].value = 123;
  model.streams[0].dataMapping = { sourceName: 'PLANT.FEED' };
  await f.request(`/api/models/${entry.id}`, 'PATCH', { model, revision: 2 });
  f.sqlite.prepare('UPDATE models SET sources_json=? WHERE id=?').run(JSON.stringify([{ id: 'source', name: 'Plant readings', type: 'csv', direction: 'input' }]), entry.id);
  await f.request(`/api/models/${entry.id}/schedule`, 'PATCH', { revision: 3, changes: { enabled: true, intervalMinutes: 120 } });
  await f.request(`/api/models/${entry.id}/runs`, 'POST', { trigger: 'manual' });
  const backend = await f.connect(), actions = createModelActions({ backend });
  const result = await actions.duplicate(entry.id), original = await f.repo.model(entry.id), copied = await f.repo.model(result.id);
  assert.notEqual(result.id, entry.id); assert.equal(result.action, 'duplicate');
  assert.equal(result.activeId, entry.id); assert.equal(backend.workspace.catalog.activeId, entry.id);
  assert.deepEqual(copied.model, { ...model, name: 'Working draft (copy)' });
  assert.equal(copied.published, false); assert.equal(copied.publishedModel, null); assert.equal(copied.publishedVersion, 0);
  assert.equal(copied.schedule.enabled, false); assert.equal(copied.schedule.nextRunAt, null);
  assert.equal(copied.schedule.inputSourceId, null); assert.equal(copied.schedule.outputSourceId, null);
  assert.deepEqual(copied.sources, []); assert.deepEqual(await f.repo.runs(result.id), []);
  assert.equal(original.sources[0].id, 'source');
  assert.equal(original.schedule.enabled, true); assert.equal((await f.repo.runs(entry.id)).length, 1);
  result.entry.model.streams[0].value = 999;
  assert.equal(backend.workspace.catalog.models.find(item => item.id === entry.id).model.streams[0].value, 123);
  assert.equal(backend.workspace.catalog.models.find(item => item.id === result.id).model.streams[0].value, 123);
});

test('an editor with read-only source access can duplicate into a new model with only the creator grant', async t => {
  const f = fixture(t), entry = await f.create();
  await f.request('/api/session', 'GET', undefined, f.editor);
  await f.request(`/api/admin/users/${f.editor.id}`, 'PATCH', { role: 'editor' });
  await f.request(`/api/admin/models/${entry.id}/permissions`, 'PUT', { userId: f.editor.id, level: 'viewer' });
  const backend = await f.connect(f.editor), actions = createModelActions({ backend });
  assert.deepEqual(actions.permissions(entry.id), { canRename: false, canDuplicate: true, canDelete: false });
  const result = await actions.duplicate(entry.id);
  const grants = f.sqlite.prepare('SELECT user_id,level FROM model_grants WHERE model_id=?').all(result.id);
  assert.deepEqual(grants.map(row => ({ ...row })), [{ user_id: f.editor.id, level: 'editor' }]);
  assert.equal(backend.permission(result.id).canEdit, true);
  await assert.rejects(actions.remove(entry.id), /permission to delete/);
});

test('newly revoked model access or global creation role blocks duplication before creating a copy', async t => {
  const f = fixture(t), entry = await f.create();
  await f.request('/api/session', 'GET', undefined, f.editor);
  await f.request(`/api/admin/users/${f.editor.id}`, 'PATCH', { role: 'editor' });
  await f.request(`/api/admin/models/${entry.id}/permissions`, 'PUT', { userId: f.editor.id, level: 'editor' });
  const backend = await f.connect(f.editor), actions = createModelActions({ backend });
  await f.request(`/api/admin/users/${f.editor.id}`, 'PATCH', { role: 'operator' });
  f.calls.length = 0;
  await assert.rejects(actions.duplicate(entry.id), /permission to duplicate/);
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
  await f.request(`/api/admin/users/${f.editor.id}`, 'PATCH', { role: 'editor' });
  await f.request(`/api/admin/models/${entry.id}/permissions`, 'PUT', { userId: f.editor.id, level: 'none' });
  f.calls.length = 0;
  await assert.rejects(actions.duplicate(entry.id), /no longer have access/);
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM models').get().count, 1);
});

test('published-card duplication copies the displayed publication rather than an unpublished draft', async t => {
  const f = fixture(t), entry = await f.create();
  await f.request(`/api/models/${entry.id}/publication`, 'PATCH', { published: true, revision: 1 });
  const draft = structuredClone(entry.model); draft.name = 'Private draft changes'; draft.streams[0].value = 789;
  await f.request(`/api/models/${entry.id}`, 'PATCH', { model: draft, revision: 2 });
  const backend = await f.connect(), actions = createModelActions({ backend });
  const published = await actions.duplicate(entry.id, { view: 'published' });
  assert.deepEqual((await f.repo.model(published.id)).model, { ...entry.model, name: `${entry.model.name} (copy)` });
  const editing = await actions.duplicate(entry.id, { view: 'editing' });
  assert.deepEqual((await f.repo.model(editing.id)).model, { ...draft, name: 'Private draft changes (copy)' });
  assert.equal(backend.workspace.catalog.activeId, entry.id);
});

test('a publication withdrawn since the card rendered cannot be duplicated from its retained snapshot', async t => {
  const f = fixture(t), entry = await f.create();
  await f.request(`/api/models/${entry.id}/publication`, 'PATCH', { published: true, revision: 1 });
  const backend = await f.connect(), actions = createModelActions({ backend });
  await f.request(`/api/models/${entry.id}/publication`, 'PATCH', { published: false, revision: 2 });
  f.calls.length = 0;
  await assert.rejects(actions.duplicate(entry.id, { view: 'published' }), /no longer published/);
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
  await assert.rejects(actions.duplicate(entry.id, { view: 'other' }), /published model or draft/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM models').get().count, 1);
});

test('rename and deletion refuse a confirmation reviewed before another server change', async t => {
  const f = fixture(t), entry = await f.create(), backend = await f.connect(), actions = createModelActions({ backend });
  const revision = backend.permission(entry.id).revision;
  const changed = structuredClone(entry.model); changed.streams[0].value = 456;
  await f.request(`/api/models/${entry.id}`, 'PATCH', { model: changed, revision });
  f.calls.length = 0;
  await assert.rejects(actions.rename(entry.id, 'Stale reviewed name', { revision }), error => error.status === 409 && /review the action again/.test(error.message));
  await assert.rejects(actions.remove(entry.id, { revision }), error => error.status === 409);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET']);
  assert.deepEqual((await f.repo.model(entry.id)).model, changed);
  const result = await actions.rename(entry.id, 'Reviewed latest', { revision: backend.permission(entry.id).revision });
  assert.equal(result.entry.model.name, 'Reviewed latest');
  await actions.remove(entry.id, { revision: backend.permission(entry.id).revision });
  assert.ok((await f.repo.model(entry.id, true)).deletedAt);
});

test('administrator deletion uses a fresh revision, soft-deletes the active model and selects the remaining model', async t => {
  const f = fixture(t), entry = await f.create(), remaining = await f.create();
  await f.request(`/api/models/${entry.id}/publication`, 'PATCH', { published: true, revision: 1 });
  await f.request(`/api/models/${entry.id}/schedule`, 'PATCH', { revision: 2, changes: { enabled: true } });
  const backend = await f.connect(), actions = createModelActions({ backend });
  backend.select(entry.id);
  await f.request(`/api/admin/models/${entry.id}`, 'PATCH', { revision: 3, editLocked: true, unpublishLocked: true });
  const result = await actions.remove(entry.id), stored = await f.repo.model(entry.id, true);
  assert.equal(result.deletedActive, true); assert.equal(result.activeId, remaining.id);
  assert.equal(result.action, 'delete'); assert.equal(result.entry.id, entry.id);
  assert.ok(stored.deletedAt); assert.equal(stored.schedule.enabled, false); assert.equal(stored.schedule.nextRunAt, null);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').at(-1).body.revision, 4);
  assert.deepEqual(backend.workspace.catalog.models.map(item => item.id), [remaining.id]);
  assert.ok((await f.request(`/api/audit?modelId=${entry.id}`)).events.some(event => event.action === 'deleted'));
  await actions.remove(remaining.id);
  assert.equal(backend.workspace.catalog.activeId, null);
});

test('deleting a different card retains the selected model', async t => {
  const f = fixture(t), first = await f.create(), second = await f.create(), backend = await f.connect();
  const result = await createModelActions({ backend }).remove(second.id);
  assert.equal(result.deletedActive, false); assert.equal(result.activeId, first.id);
});

test('deleting the final model clears selection, stops its schedule and repeated deletion creates no audit event', async t => {
  const f = fixture(t), entry = await f.create();
  await f.request(`/api/models/${entry.id}/publication`, 'PATCH', { published: true, revision: 1 });
  await f.request(`/api/models/${entry.id}/schedule`, 'PATCH', { revision: 2, changes: { enabled: true } });
  const backend = await f.connect(), actions = createModelActions({ backend });
  const result = await actions.remove(entry.id, { revision: backend.permission(entry.id).revision });
  assert.equal(result.deletedActive, true); assert.equal(result.activeId, null);
  assert.equal(backend.workspace.catalog.activeId, null); assert.deepEqual(backend.workspace.catalog.models, []);
  assert.deepEqual(backend.workspace.permissions, {});
  const stored = await f.repo.model(entry.id, true);
  assert.ok(stored.deletedAt); assert.equal(stored.schedule.enabled, false); assert.equal(stored.schedule.nextRunAt, null);
  const events = (await f.request(`/api/audit?modelId=${entry.id}`)).events;
  assert.equal(events.filter(event => event.action === 'deleted').length, 1);
  f.calls.length = 0;
  await assert.rejects(actions.remove(entry.id), /no longer have access/);
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
  assert.deepEqual((await f.request(`/api/audit?modelId=${entry.id}`)).events, events);
});

test('concurrent server edits reject stale rename revisions without retrying or overwriting their changes', async t => {
  const f = fixture(t), entry = await f.create(), backend = await f.connect(), actions = createModelActions({ backend });
  const api = backend.api.bind(backend);
  backend.api = async (path, method, body) => {
    const model = structuredClone(entry.model); model.streams[0].value = 321;
    await f.request(path, method, { model, revision: body.revision });
    return api(path, method, body);
  };
  f.calls.length = 0;
  await assert.rejects(actions.rename(entry.id, 'Stale rename'), error => error.status === 409);
  const stored = await f.repo.model(entry.id);
  assert.equal(stored.model.name, entry.model.name); assert.equal(stored.model.streams[0].value, 321);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 2);
  assert.equal(actions.busy, false);
});

test('failed queued saves stop actions and duplicate invocations are rejected while an action is pending', async t => {
  const f = fixture(t), entry = await f.create(), backend = await f.connect(), actions = createModelActions({ backend });
  backend.flush = async () => { throw new Error('Changes could not be saved.'); };
  f.calls.length = 0;
  await assert.rejects(actions.remove(entry.id), /could not be saved/);
  assert.equal(f.calls.length, 0); assert.equal(actions.busy, false);
  let release;
  backend.flush = () => new Promise(resolve => { release = resolve; });
  const first = actions.duplicate(entry.id);
  assert.equal(actions.busy, true);
  await assert.rejects(actions.duplicate(entry.id), /in progress/);
  release();
  await first;
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(actions.busy, false);
});
