import test from 'node:test';
import assert from 'node:assert/strict';
import { connectWorkspace } from '../public/workspace-api.js';
import { exampleModel } from '../public/model.js';
import { createCatalog } from '../public/management-store.js';

const clone = value => structuredClone(value);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(condition) { for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve(); assert.ok(condition(), 'Expected operation to start.'); }

function setup(t, { canEdit = true, role = 'editor' } = {}) {
  const keys = ['fetch', 'document', 'localStorage', 'location', 'setTimeout', 'clearTimeout'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalNow = Date.now, nodes = new Map(), timers = new Map(), storage = new Map();
  const controllers = [], calls = [], errors = [];
  const now = Date.parse('2026-10-09T20:00:00.000Z'); let timerId = 0, handler;
  const user = { id: 'editor-subject', email: 'editor@example.com', name: 'Editor', role, active: true };
  const permission = { revision: 1, published: true, editLocked: !canEdit, unpublishLocked: false, canView: true, canRun: role !== 'viewer', canEdit, canSchedule: canEdit, canPublish: false, canUnpublish: canEdit, canDelete: role === 'admin' };
  let server = { user, catalog: createCatalog(exampleModel(), { id: 'model-1', now }), permissions: { 'model-1': permission }, serverTime: new Date(now + 30_000).toISOString() };
  const classes = new Set();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: '', classList: { add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, contains(name) { return classes.has(name); } } }); return nodes.get(selector); };
  const values = {
    document: { body: node('body'), querySelector: node }, location: { reload() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (path, options) => {
      const call = { path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call);
      if (handler) { const handled = await handler(call); if (handled) return handled; }
      if (path === '/api/session') return reply({ user, signInUrl: '/login', signOutUrl: '/logout' });
      if (path === '/api/workspace') return reply(clone(server));
      if (path === '/api/models/model-1' && call.method === 'PATCH') {
        if (call.body.revision !== server.permissions['model-1'].revision) return reply({ error: 'This model changed.' }, 409);
        server.catalog.models[0].model = clone(call.body.model);
        server.permissions['model-1'].revision++;
        return reply({ entry: clone(server.catalog.models[0]), permission: clone(server.permissions['model-1']) });
      }
      if (path.endsWith('/schedule')) {
        if (call.body.revision !== server.permissions['model-1'].revision) return reply({ error: 'This model changed.' }, 409);
        server.permissions['model-1'].revision++;
        server.catalog.schedules['model-1'] = { ...server.catalog.schedules['model-1'], ...call.body.changes };
        return reply({ schedule: clone(server.catalog.schedules['model-1']), permission: clone(server.permissions['model-1']) });
      }
      if (path.endsWith('/runs')) return reply({ run: { id: 'run-1', modelId: 'model-1', trigger: call.body.trigger, modelSnapshot: clone(server.catalog.models[0].model) }, schedule: clone(server.catalog.schedules['model-1']), permission: clone(server.permissions['model-1']) });
      if (path === '/api/admin') return reply({ users: [user], models: [], grants: [] });
      return reply({ error: 'Unknown test route.' }, 404);
    }
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Date.now = () => now;
  t.after(() => { for (const controller of controllers) controller.destroy(); Date.now = originalNow; for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return {
    calls, errors, node, timers,
    get server() { return server; }, set server(value) { server = clone(value); },
    handle(callback) { handler = callback; },
    async connect() { const controller = await connectWorkspace(message => errors.push(message)); controllers.push(controller); calls.length = 0; return controller; },
    runTimers() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); }
  };
}

test('refresh and subsequent draft saves are serialized so a slow GET cannot reset a saved revision', async t => {
  const f = setup(t), workspace = await f.connect(), gate = deferred();
  const oldSnapshot = clone(f.server);
  f.handle(call => call.path === '/api/workspace' ? gate.promise : null);
  const refreshed = workspace.refresh();
  await until(() => f.calls.length === 1);
  const model = exampleModel(); model.name = 'Latest local draft';
  const saved = workspace.queueSave('model-1', model), flushed = workspace.flush();
  await Promise.resolve(); assert.deepEqual(f.calls.map(call => call.method), ['GET']);
  gate.resolve(reply(oldSnapshot)); await refreshed; await flushed;
  assert.equal(await saved, true); assert.deepEqual(f.calls.map(call => call.method), ['GET', 'PATCH']);
  assert.equal(workspace.permission('model-1').revision, 2); assert.equal(workspace.workspace.catalog.models[0].model.name, 'Latest local draft');
  assert.equal(workspace.now(), Date.parse(f.server.serverTime));
});

test('scheduled settings and raw admin reads wait for an in-flight draft write and use its latest revision', async t => {
  const f = setup(t), workspace = await f.connect(), gate = deferred(); let held = true;
  f.handle(call => call.method === 'PATCH' && call.path === '/api/models/model-1' && held ? gate.promise : null);
  const model = exampleModel(); model.name = 'Saved first';
  const saved = workspace.queueSave('model-1', model), flushed = workspace.flush();
  await until(() => f.calls.length === 1);
  const changed = workspace.schedule('model-1', { enabled: false }), admin = workspace.api('/api/admin');
  await Promise.resolve(); assert.equal(f.calls.length, 1);
  f.server.catalog.models[0].model = model; f.server.permissions['model-1'].revision = 2; held = false;
  gate.resolve(reply({ entry: clone(f.server.catalog.models[0]), permission: clone(f.server.permissions['model-1']) }));
  await flushed; assert.equal(await saved, true); await changed; await admin;
  assert.deepEqual(f.calls.map(call => call.path), ['/api/models/model-1', '/api/models/model-1/schedule', '/api/admin']);
  assert.equal(f.calls[1].body.revision, 2); assert.equal(workspace.permission('model-1').revision, 3);
});

test('debounce coalesces edits into the newest model and resolves every save waiter', async t => {
  const f = setup(t), workspace = await f.connect();
  const first = exampleModel(), second = exampleModel(); first.name = 'Earlier'; second.name = 'Newest';
  const earlierSaved = workspace.queueSave('model-1', first), latestSaved = workspace.queueSave('model-1', second);
  assert.equal(f.timers.size, 1); assert.equal(f.calls.length, 0);
  f.runTimers(); await workspace.flush();
  assert.deepEqual(await Promise.all([earlierSaved, latestSaved]), [true, true]);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.model.name, 'Newest');
  assert.equal(workspace.workspace.catalog.models[0].model.name, 'Newest');
});

test('explicit published and draft runs preserve the publication snapshot while queued draft saves finish', async t => {
  const f = setup(t);
  const entry = f.server.catalog.models[0];
  entry.publishedModel = exampleModel(); entry.publishedVersion = 1; entry.publishedAt = f.server.serverTime;
  const workspace = await f.connect();
  f.handle(call => {
    if (!call.path.endsWith('/runs')) return null;
    const published = call.body.target === 'published', saved = f.server.catalog.models[0];
    return reply({ run: { id: `run-${call.body.target}`, modelId: saved.id, trigger: call.body.trigger, target: call.body.target,
      publishedVersion: published ? saved.publishedVersion : null, modelSnapshot: clone(published ? saved.publishedModel : saved.model) },
      permission: clone(f.server.permissions[saved.id]), schedule: clone(f.server.catalog.schedules[saved.id]) });
  });
  const changed = exampleModel(); changed.streams[0].value = 120;
  const save = workspace.queueSave(entry.id, changed);
  const published = await workspace.execute(entry.id, 'manual', { target: 'published' });
  assert.equal(await save, true);
  assert.equal(published.modelSnapshot.streams[0].value, 100);
  assert.equal(published.publishedVersion, 1);
  assert.equal(workspace.workspace.catalog.models[0].model.streams[0].value, 120);
  assert.equal(workspace.workspace.catalog.models[0].publishedModel.streams[0].value, 100);
  const draft = await workspace.execute(entry.id, 'manual', { target: 'draft' });
  assert.equal(draft.modelSnapshot.streams[0].value, 120);
  assert.equal(draft.publishedVersion, null);
  assert.deepEqual(f.calls.map(call => call.body?.target).filter(Boolean), ['published', 'draft']);
});

test('failed saves preserve local drafts and block run/refresh instead of using older server readings', async t => {
  const f = setup(t), workspace = await f.connect();
  f.handle(call => call.method === 'PATCH' ? reply({ error: 'Model editing is locked.' }, 403) : null);
  const draft = exampleModel(); draft.streams[0].value = 999;
  const saved = workspace.queueSave('model-1', draft);
  await assert.rejects(workspace.flush(), error => error.unsavedDraft && /Export your draft/.test(error.message));
  assert.equal(await saved, false); assert.equal(workspace.hasFailedSave, true); assert.equal(workspace.failedDraft().streams[0].value, 999);
  await assert.rejects(workspace.execute('model-1'), /Changes could not be saved/);
  await assert.rejects(workspace.refresh(), /Changes could not be saved/);
  assert.equal(f.calls.length, 1); assert.equal(workspace.workspace.catalog.models[0].model.streams[0].value, 100);
  const preserved = workspace.failedDraft(); preserved.streams[0].value = 7;
  assert.equal(workspace.failedDraft().streams[0].value, 999);
});

test('an edit made during a failed save is the preserved draft and both generations resolve false', async t => {
  const f = setup(t), workspace = await f.connect(), gate = deferred();
  f.handle(call => call.method === 'PATCH' ? gate.promise : null);
  const first = exampleModel(), next = exampleModel(); first.name = 'Earlier draft'; next.name = 'Most recent draft';
  const firstSaved = workspace.queueSave('model-1', first), flushed = workspace.flush();
  await until(() => f.calls.length === 1);
  const nextSaved = workspace.queueSave('model-1', next);
  gate.resolve(reply({ error: 'Stale revision.' }, 409));
  await assert.rejects(flushed, /Changes could not be saved/);
  assert.deepEqual(await Promise.all([firstSaved, nextSaved]), [false, false]);
  assert.equal(workspace.failedDraft().name, 'Most recent draft');
  f.runTimers(); await assert.rejects(workspace.flush(), /Changes could not be saved/);
  assert.equal(f.calls.length, 1);
});

test('explicit user discard refresh clears the failed block; intentional new saving can retry a transient failure', async t => {
  const f = setup(t), workspace = await f.connect(); let fail = true;
  f.handle(call => fail && call.method === 'PATCH' ? reply({ error: 'Temporary network problem.' }, 503) : null);
  const draft = exampleModel(); draft.name = 'Keep this draft';
  let saved = workspace.queueSave('model-1', draft);
  await assert.rejects(workspace.flush()); assert.equal(await saved, false);
  fail = false; saved = workspace.queueSave('model-1', draft); await workspace.flush(); assert.equal(await saved, true);
  assert.equal(workspace.hasFailedSave, false); assert.equal(workspace.workspace.catalog.models[0].model.name, 'Keep this draft');
  fail = true; draft.name = 'Discard only on request'; saved = workspace.queueSave('model-1', draft);
  await assert.rejects(workspace.flush()); assert.equal(await saved, false);
  await workspace.refresh({ discardDrafts: true });
  assert.equal(workspace.hasFailedSave, false); assert.equal(workspace.failedDraft(), null);
  assert.equal(workspace.workspace.catalog.models[0].model.name, 'Keep this draft');
  assert.equal(f.calls.at(-1).path, '/api/workspace');
});

test('read-only and non-admin permissions cannot enqueue model writes', async t => {
  const f = setup(t, { canEdit: false, role: 'viewer' }), workspace = await f.connect();
  assert.equal(await workspace.queueSave('model-1', exampleModel()), false);
  await workspace.flush(); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(workspace.permission().canDelete, false); assert.equal(workspace.permission().canEdit, false);
});

test('expired sessions show the authentication screen and preserve the rejected draft without a follow-up GET', async t => {
  const f = setup(t), workspace = await f.connect();
  f.handle(call => call.method === 'PATCH' ? reply({ error: 'Session expired.' }, 401) : null);
  const draft = exampleModel(); draft.name = 'Unsaved before expiry'; const saved = workspace.queueSave('model-1', draft);
  await assert.rejects(workspace.flush(), error => error.status === 401); assert.equal(await saved, false);
  assert.equal(f.node('#auth-screen').hidden, false); assert.equal(f.node('#workspace-main').hidden, true);
  assert.equal(workspace.failedDraft().name, 'Unsaved before expiry'); assert.equal(f.calls.length, 1);
  assert.equal(workspace.user.active, false); assert.equal(workspace.user.role, null); assert.equal(workspace.user.email, '');
  assert.deepEqual(workspace.permission(), {}); assert.deepEqual(workspace.workspace.catalog.models, []);
  await assert.rejects(workspace.api('/api/admin'), error => error.status === 401);
  assert.equal(f.calls.length, 1);
});

test('disabled account workspace403 closes cached admin access and preserves drafts queued during refresh', async t => {
  const f = setup(t, { role: 'admin' }), workspace = await f.connect(), gate = deferred();
  f.node('#menu-admin').hidden = false; f.node('#app-menu').hidden = false;
  f.handle(call => call.path === '/api/workspace' ? gate.promise : null);
  const refreshed = workspace.refresh(); await until(() => f.calls.length === 1);
  const draft = exampleModel(); draft.name = 'Local draft before disabling'; const saved = workspace.queueSave('model-1', draft);
  gate.resolve(reply({ error: 'Your account is disabled. Contact an administrator.' }, 403));
  await assert.rejects(refreshed, error => error.status === 403 && error.authUnavailable);
  assert.equal(await saved, false); assert.equal(f.node('#auth-title').textContent, 'Account access is unavailable');
  assert.equal(f.node('#auth-screen').hidden, false); assert.equal(f.node('#workspace-main').hidden, true);
  assert.equal(f.node('#menu-admin').hidden, true); assert.equal(f.node('#app-menu').hidden, true);
  assert.equal(workspace.user.role, null); assert.equal(workspace.user.active, false); assert.equal(workspace.user.email, '');
  assert.deepEqual(workspace.workspace.permissions, {}); assert.deepEqual(workspace.workspace.catalog.models, []);
  assert.equal(workspace.failedDraft().name, 'Local draft before disabling');
  assert.equal(await workspace.queueSave('model-1', exampleModel()), false);
  await assert.rejects(workspace.api('/api/admin'), error => error.status === 403);
  await assert.rejects(workspace.execute('model-1'));
  assert.equal(f.calls.length, 1);
});

test('ordinary model action403 preserves the connected workspace and does not revoke account namespace', async t => {
  const f = setup(t, { role: 'admin' }), workspace = await f.connect();
  f.handle(call => call.path.endsWith('/runs') ? reply({ error: 'Your account cannot run this model.' }, 403) : null);
  await assert.rejects(workspace.execute('model-1'), error => error.status === 403 && !error.authUnavailable);
  assert.equal(f.node('#auth-screen').hidden, true); assert.equal(f.node('#workspace-main').hidden, false);
  assert.equal(workspace.user.role, 'admin'); assert.equal(workspace.user.active, true);
  assert.equal(workspace.workspace.catalog.models.length, 1);
  assert.equal((await workspace.api('/api/admin')).users.length, 1);
});

test('session403 after connection uses disabled-account handling rather than exposing cached roles', async t => {
  const f = setup(t, { role: 'admin' }), workspace = await f.connect();
  f.handle(call => call.path === '/api/session' ? reply({ error: 'Account disabled.' }, 403) : null);
  await assert.rejects(workspace.api('/api/session'), error => error.status === 403 && error.authUnavailable);
  assert.equal(workspace.user.role, null); assert.equal(workspace.workspace.catalog.activeId, null);
  assert.equal(f.node('#auth-title').textContent, 'Account access is unavailable');
});
