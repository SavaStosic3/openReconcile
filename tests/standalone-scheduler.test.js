import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../deploy/sqlite.js';
import { handleApi } from '../backend/api.js';
import { Repository } from '../backend/repository.js';
import { createScheduledRunner } from '../backend/scheduled-runs.js';
import { createScheduler } from '../deploy/scheduler.mjs';
import { exampleModel } from '../public/model.js';
import { showcaseModel } from '../public/showcase-model.js';
import { storageShowcaseModel } from '../public/storage-showcase-model.js';
import { validateCatalog } from '../public/management-store.js';

const closeTo = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-7, `${actual} differs from ${expected}`);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const withTimeout = async (promise, message) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
};
const inputSource = { id: 'plant-input', name: 'Plant measurements', type: 'sql', direction: 'input', connectionId: 'plant', table: 'readings', tagColumn: 'tag', valueColumn: 'value', timestampColumn: 'observed_at', aggregation: 'latest' };
const outputSource = { id: 'plant-output', name: 'Plant results', type: 'sql', direction: 'output', connectionId: 'results', table: 'reconciled_results' };

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openreconcile-scheduler-'));
  const DB = openDatabase({ dataDir });
  let time = Date.parse('2026-10-10T10:07:00.000Z'), serial = 0;
  const env = { DB, ADMIN_EMAIL: 'admin@example.test', STANDALONE_SCHEDULER: true, SCHEDULER_ENABLED: true, SCHEDULER_POLL_SECONDS: 1,
    NOW: () => time, UUID: () => `scheduler-test-${String(++serial).padStart(6, '0')}` };
  const identity = { id: 'scheduler-admin', email: 'admin@example.test', name: 'Plant administrator' };
  const repo = new Repository(DB, { now: env.NOW, uuid: env.UUID });
  const runners = [];
  const runner = (options = {}) => { const result = createScheduledRunner(env, { leaseMs: 120_000, ...options }); runners.push(result); return result; };
  t.after(async () => { try { await Promise.all(runners.map(value => value.drain())); } finally { DB.close(); await rm(dataDir, { recursive: true, force: true }); } });
  async function requestAny(path, method = 'GET', body, actingIdentity = identity) {
    const response = await handleApi(new Request(`https://plant.test${path}`, { method,
      headers: { Origin: 'https://plant.test', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, actingIdentity);
    return { status: response.status, data: await response.json() };
  }
  async function request(path, method = 'GET', body, expected = 200, actingIdentity = identity) {
    const result = await requestAny(path, method, body, actingIdentity);
    assert.equal(result.status, expected, JSON.stringify(result.data)); return result.data;
  }
  async function create(model = exampleModel(), sources = []) {
    const created = await request('/api/models', 'POST', { model }, 201), id = created.entry.id;
    if (sources.length) await request(`/api/models/${id}/sources`, 'PUT', { revision: 1, sources });
    const current = await repo.model(id);
    await request(`/api/models/${id}/publication`, 'PATCH', { revision: current.revision, published: true });
    return id;
  }
  async function enable(id, changes = {}) {
    const current = await repo.model(id);
    await request(`/api/models/${id}/schedule`, 'PATCH', { revision: current.revision, changes: { enabled: true, intervalMinutes: 60, ...changes } });
  }
  async function due(id) {
    const model = await repo.model(id), schedule = { ...model.schedule, nextRunAt: new Date(time - 1000).toISOString() };
    await DB.prepare('UPDATE models SET schedule_json=? WHERE id=?').bind(JSON.stringify(schedule), id).run();
  }
  function gateway({ onRead, onWrite, values = { f1: 100, f3: 60, f4: 35 } } = {}) {
    const calls = [];
    Object.assign(env, { SQL_GATEWAY_URL: 'https://gateway.test', SQL_GATEWAY_TOKEN: 'g'.repeat(40), SQL_GATEWAY_FETCH: async (url, options) => {
      const endpoint = new URL(url).pathname.slice(1), body = options.body ? JSON.parse(options.body) : null;
      calls.push({ endpoint, body });
      if (endpoint === 'read' && onRead) await onRead(body);
      if (endpoint === 'write' && onWrite) await onWrite(body);
      const data = endpoint === 'connections' ? { connections: [{ id: 'plant', name: 'Plant', dialect: 'postgres', canRead: true, canWrite: false }, { id: 'results', name: 'Results', dialect: 'postgres', canRead: false, canWrite: true }] }
        : endpoint === 'read' ? { readings: body.tags.map(sourceName => ({ sourceName, value: values[sourceName], timestamp: new Date((Date.parse(body.start) + Date.parse(body.end)) / 2).toISOString() })), window: { start: body.start, end: body.end } }
          : { written: body.rows.length };
      return new Response(JSON.stringify(data));
    } });
    return calls;
  }
  async function sqlModel() {
    const model = exampleModel(); for (const stream of model.streams) stream.dataMapping = { sourceName: stream.id };
    const id = await create(model, [inputSource, outputSource]);
    await enable(id, { inputSourceId: inputSource.id, outputSourceId: outputSource.id }); await due(id); return id;
  }
  return { DB, env, repo, identity, runner, request, requestAny, create, enable, due, gateway, sqlModel, advance(ms) { time += ms; } };
}

test('server schedules reconcile both published analytic models without a session and preserve working drafts', async t => {
  const f = await fixture(t), ids = [];
  for (const model of [showcaseModel(), storageShowcaseModel()]) {
    const id = await f.create(model); ids.push(id); await f.enable(id); await f.due(id);
    const current = await f.repo.model(id), draft = structuredClone(model);
    draft.name = `${model.name} unsaved publication`; draft.streams.find(stream => stream.measured).value = 999999;
    await f.request(`/api/models/${id}`, 'PATCH', { revision: current.revision, model: draft });
  }
  assert.equal(await f.DB.prepare('SELECT COUNT(*) AS count FROM local_sessions').first('count'), 0);
  const worker = f.runner(); await worker.tick();
  for (const [index, id] of ids.entries()) {
    const runs = await f.repo.runs(id); assert.equal(runs.length, 1);
    const run = runs[0]; assert.equal(run.trigger, 'scheduled'); assert.equal(run.target, 'published'); assert.equal(run.publishedVersion, 1);
    assert.ok(['ok', 'warning'].includes(run.status), run.error);
    assert.equal(run.reportingPeriod.start, '2026-10-10T09:00:00.000Z'); assert.equal(run.reportingPeriod.end, '2026-10-10T10:00:00.000Z');
    closeTo(run.result.objective, index ? 100 / 350 : 0.4);
    run.result.balances.forEach(balance => closeTo(balance.reconciled, 0));
    if (index) { assert.equal(run.result.inventories.length, 3); run.result.inventories.forEach((inventory, position) => closeTo(inventory.accumulation.value, [200, 200, 100][position] + 10 / 7)); }
    const saved = await f.repo.model(id); assert.ok(saved.model.name.endsWith('unsaved publication')); assert.equal(saved.model.streams.find(stream => stream.measured).value, 999999);
    assert.equal(saved.publishedModel.name, index ? 'Three-tank transfer' : 'Slurry filtration with recycle');
  }
  await f.runner().tick();
  for (const id of ids) assert.equal((await f.repo.runs(id)).length, 1, 'a fresh worker must not repeat a completed occurrence');
});

test('company servers reject browser scheduled triggers while leaving manual reconciliation available', async t => {
  const f = await fixture(t), id = await f.create(); await f.enable(id); await f.due(id);
  await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'scheduled' }, 409);
  assert.equal((await f.repo.runs(id)).length, 0);
  const manual = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
  assert.ok(manual.run.result); assert.equal(manual.run.trigger, 'manual');
  await f.runner().tick(); assert.equal((await f.repo.runs(id)).length, 2);
});

test('a clock rollback during input records a readable failure and prevents output', async t => {
  const f=await fixture(t),calls=f.gateway({onRead:async()=>{f.advance(-30_000);}}),id=await f.sqlModel();
  await f.runner().tick();
  const run=(await f.repo.runs(id))[0];
  assert.equal(run.status,'failed');assert.match(run.error,/clock.*before.*start/i);
  assert.ok(Date.parse(run.finishedAt)>=Date.parse(run.startedAt),'a failure cannot corrupt its run chronology');
  assert.ok(run.result,'the completed calculation must survive the clock failure');
  assert.equal(run.execution.delivery,'not_attempted');
  assert.equal(calls.filter(call=>call.endpoint==='write').length,0);
  const workspace=await f.request('/api/workspace');
  assert.doesNotThrow(()=>validateCatalog(workspace.catalog));
  assert.equal(workspace.catalog.runs[id][0].status,'failed');
});

test('existing enabled schedules require deliberate authorization before the server can run them', async t => {
  const f = await fixture(t), id = await f.create(), current = await f.repo.model(id);
  const legacy = { ...current.schedule, enabled: true, nextRunAt: new Date(f.env.NOW() - 1000).toISOString() };
  await f.DB.prepare('UPDATE models SET schedule_json=? WHERE id=?').bind(JSON.stringify(legacy), id).run();
  const worker = f.runner(); await worker.tick(); assert.equal((await f.repo.runs(id)).length, 0);
  await f.enable(id); await f.due(id); await worker.tick(); assert.equal((await f.repo.runs(id)).length, 1);
});

test('simultaneous workers claim one durable run before reading and cannot deliver duplicate output', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const first = f.runner(), second = f.runner(), executing = first.tick();
  await entered.promise;
  try {
    const pending = await f.repo.runs(id); assert.equal(pending.length, 1); assert.equal(pending[0].status, 'running');
    await second.tick(); assert.equal(calls.filter(call => call.endpoint === 'read').length, 1);
    assert.equal(calls.filter(call => call.endpoint === 'write').length, 0);
  } finally { release.resolve(); await executing; }
  const runs = await f.repo.runs(id); assert.equal(runs.length, 1); assert.ok(['ok','warning'].includes(runs[0].status), runs[0].error);
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
});

test('a schedule authorizer who loses edit-level authority cannot start background SQL reads', async t => {
  const f = await fixture(t), calls = f.gateway(), id = await f.sqlModel();
  await f.DB.prepare("UPDATE users SET role='operator' WHERE id=?").bind(f.identity.id).run();
  await f.runner().tick(); assert.equal(calls.filter(call => call.endpoint === 'read').length, 0); assert.equal((await f.repo.runs(id)).length, 0);
});

test('disabled, unpublished, deleted and changed-source schedules do not read input', async t => {
  for (const mutation of ['disabled', 'unpublished', 'deleted', 'source']) await t.test(mutation, async t => {
    const f = await fixture(t), calls = f.gateway(), id = await f.sqlModel(), current = await f.repo.model(id);
    if (mutation === 'disabled') await f.request(`/api/models/${id}/schedule`, 'PATCH', { revision: current.revision, changes: { enabled: false } });
    if (mutation === 'unpublished') await f.request(`/api/models/${id}/publication`, 'PATCH', { revision: current.revision, published: false });
    if (mutation === 'deleted') await f.request(`/api/admin/models/${id}`, 'DELETE', { revision: current.revision });
    if (mutation === 'source') await f.request(`/api/models/${id}/sources`, 'PUT', { revision: current.revision, sources: [{ ...inputSource, table: 'other_readings' }, outputSource] });
    await f.runner().tick(); assert.equal(calls.filter(call => call.endpoint === 'read').length, 0); assert.equal((await f.repo.runs(id)).length, 0);
  });
});

test('permissions and schedule changes during SQL input block output and leave a visible terminal record', async t => {
  for (const mutation of ['inactive', 'unpublished', 'deleted', 'source', 'disabled']) await t.test(mutation, async t => {
    const f = await fixture(t), entered = deferred(), release = deferred();
    const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel(), worker = f.runner();
    const executing = worker.tick(); await entered.promise;
    try {
      const current = await f.repo.model(id);
      if (mutation === 'inactive') await f.DB.prepare('UPDATE users SET active=0 WHERE id=?').bind(f.identity.id).run();
      if (mutation === 'unpublished') await f.request(`/api/models/${id}/publication`, 'PATCH', { revision: current.revision, published: false });
      if (mutation === 'deleted') await f.request(`/api/admin/models/${id}`, 'DELETE', { revision: current.revision });
      if (mutation === 'source') await f.request(`/api/models/${id}/sources`, 'PUT', { revision: current.revision, sources: [inputSource, { ...outputSource, table: 'new_results' }] });
      if (mutation === 'disabled') await f.request(`/api/models/${id}/schedule`, 'PATCH', { revision: current.revision, changes: { enabled: false } });
    } finally { release.resolve(); await executing; }
    assert.equal(calls.filter(call => call.endpoint === 'write').length, 0);
    const runs = await f.DB.prepare('SELECT run_json FROM model_runs WHERE model_id=?').bind(id).all();
    assert.equal(runs.results.length, 1); const run = JSON.parse(runs.results[0].run_json); assert.equal(run.status, 'failed'); assert.ok(run.error);
  });
});

test('lost leases recover a pending run as interrupted and prevent the old worker from outputting or replacing recovery', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const crashed = f.runner(), executing = crashed.tick(); await entered.promise;
  let recovered;
  try {
    f.advance(121_000); await f.runner().recover(); recovered = (await f.repo.runs(id))[0];
    assert.equal(recovered.status, 'failed'); assert.equal(recovered.execution.state, 'interrupted'); assert.match(recovered.error, /No automatic retry/i);
  } finally { release.resolve(); await executing; }
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 0);
  assert.deepEqual((await f.repo.runs(id))[0], recovered);
  await f.runner().tick(); assert.equal((await f.repo.runs(id)).length, 1, 'interrupted occurrences require an explicit rerun');
  assert.equal((await f.repo.model(id)).schedule.enabled, true, 'input-only interruption must preserve future scheduling');
  f.advance(60 * 60_000); await f.runner().tick();
  assert.equal((await f.repo.runs(id)).length, 2); assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
});

test('an interrupted external delivery retains its result and is never automatically replayed', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onWrite: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const executing = f.runner().tick(); await entered.promise;
  let recovered;
  try {
    const pending = (await f.repo.runs(id))[0];
    assert.equal(pending.status, 'running'); assert.ok(pending.result); assert.equal(pending.execution.delivery, 'uncertain');
    f.advance(121_000); await f.runner().recover(); recovered = (await f.repo.runs(id))[0];
    assert.equal(recovered.status, 'failed'); assert.ok(recovered.result); assert.match(recovered.error, /output|deliver|uncertain/i);
  } finally { release.resolve(); await executing; }
  const paused = await f.repo.model(id); assert.equal(paused.schedule.enabled, false); assert.equal(paused.schedule.nextRunAt, null);
  f.advance(60 * 60_000); await f.runner().tick(); assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
  assert.deepEqual((await f.repo.runs(id))[0], recovered);
  const audits = await f.DB.prepare("SELECT * FROM audit_events WHERE model_id=? AND category='schedule' AND action='delivery_paused'").bind(id).all();
  assert.equal(audits.results.length, 1, 'recovery and stale completion must record one automatic pause');
});

test('worker shutdown stops new claims, drains active SQL, and keeps its database usable until completion', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const scheduler = createScheduler(f.env, { pollSeconds: 1 });
  let closed = false, closing;
  try {
    await entered.promise;
    closing = scheduler.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.equal(scheduler.status().stopping, true);
    assert.equal(await f.DB.prepare('SELECT 1 AS alive').first('alive'), 1);
    await scheduler.tick(); assert.equal(calls.filter(call => call.endpoint === 'read').length, 1);
  } finally { release.resolve(); await (closing ?? scheduler.close()); }
  const runs = await f.repo.runs(id); assert.equal(runs.length, 1); assert.ok(['ok','warning'].includes(runs[0].status), runs[0].error);
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 1); assert.equal(closed, true);
});

test('saving a schedule under another authorized user cancels the prior generation and transfers future authorization', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel(), worker = f.runner();
  const successor = { id: 'shift-editor', email: 'editor@example.test', name: 'Shift editor' };
  await f.request('/api/session', 'GET', undefined, 200, successor);
  await f.request(`/api/admin/users/${successor.id}`, 'PATCH', { role: 'editor' });
  await f.request(`/api/admin/models/${id}/permissions`, 'PUT', { userId: successor.id, level: 'editor' });
  const original = await f.DB.prepare('SELECT * FROM schedule_authorizations WHERE model_id=?').bind(id).first();
  const executing = worker.tick(); await entered.promise;
  try {
    const current = await f.repo.model(id);
    await f.request(`/api/models/${id}/schedule`, 'PATCH', { revision: current.revision, changes: { enabled: true } }, 200, successor);
    const transferred = await f.DB.prepare('SELECT * FROM schedule_authorizations WHERE model_id=?').bind(id).first();
    assert.equal(transferred.user_id, successor.id); assert.equal(transferred.generation, original.generation + 1);
  } finally { release.resolve(); await executing; }
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 0);
  const cancelled = (await f.repo.runs(id))[0]; assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.execution.state, 'cancelled');
  await f.due(id); await worker.tick();
  const next = (await f.repo.runs(id)).find(run => run.id !== cancelled.id);
  assert.ok(['ok','warning'].includes(next.status), next.error); assert.equal(next.execution.actorId, successor.id);
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
});

test('an active worker renews its lease so another process cannot interrupt a long SQL read', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel(), worker = f.runner();
  const executing = worker.tick(); await entered.promise;
  try {
    f.advance(60_000); await worker.heartbeat(); f.advance(61_000);
    assert.equal(await f.runner().recover(), 0);
    assert.equal((await f.repo.runs(id))[0].status, 'running');
  } finally { release.resolve(); await executing; }
  assert.ok(['ok','warning'].includes((await f.repo.runs(id))[0].status));
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
});

test('globally disabled scheduling recovers expired jobs without starting another overdue model', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const executing = f.runner().tick(); await entered.promise;
  try {
    const other = await f.create(); await f.enable(other); await f.due(other);
    f.advance(121_000);
    const disabled = createScheduledRunner({ ...f.env, SCHEDULER_ENABLED: false });
    await disabled.tick(); await disabled.drain();
    assert.equal((await f.repo.runs(id))[0].execution.state, 'interrupted');
    assert.equal((await f.repo.runs(other)).length, 0);
  } finally { release.resolve(); await executing; }
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 0);
});

test('manual reconciliation is refused while a scheduled SQL run owns the model', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const executing = f.runner().tick(); await entered.promise;
  try { await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' }, 409); }
  finally { release.resolve(); await executing; }
  assert.equal(calls.filter(call => call.endpoint === 'read').length, 1); assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
  assert.equal((await f.repo.runs(id)).length, 1);
});

test('scheduled reconciliation retains twenty runs and twenty terminal jobs after extended operation', async t => {
  const f = await fixture(t), id = await f.create(showcaseModel()), worker = f.runner(); await f.enable(id);
  const ids = [];
  for (let index = 0; index < 25; index++) {
    await f.due(id); await worker.tick();
    ids.push((await f.repo.runs(id)).at(-1).id); f.advance(60 * 60_000);
  }
  const history = await f.repo.runs(id);
  assert.equal(history.length, 20); assert.deepEqual(history.map(run => run.id), ids.slice(-20));
  assert.equal(await f.DB.prepare('SELECT COUNT(*) AS count FROM scheduled_jobs WHERE model_id=?').bind(id).first('count'), 20);
  assert.ok(history.every(run => ['ok','warning'].includes(run.status)));
});

test('manual reconciliation reserves a model throughout SQL input and output, then releases it to the scheduler', async t => {
  for (const stage of ['input', 'output']) await t.test(stage, async t => {
    const f = await fixture(t), entered = deferred(), release = deferred();
    const hold = async () => { entered.resolve(); await release.promise; };
    const calls = f.gateway(stage === 'input' ? { onRead: hold } : { onWrite: hold }), id = await f.sqlModel();
    const manual = f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
    await entered.promise;
    const worker = f.runner(); let completed;
    try {
      const pending = (await f.repo.runs(id))[0]; assert.equal(pending.trigger, 'manual'); assert.equal(pending.status, 'running');
      await worker.tick();
      await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' }, 409);
      assert.equal((await f.repo.runs(id)).length, 1);
      assert.equal(calls.filter(call => call.endpoint === 'read').length, 1);
      assert.equal(calls.filter(call => call.endpoint === 'write').length, stage === 'output' ? 1 : 0);
      assert.ok(Date.parse((await f.repo.model(id)).schedule.nextRunAt) <= f.env.NOW(), 'a blocked worker must leave its due occurrence available');
    } finally { release.resolve(); completed = await manual; }
    assert.ok(['ok','warning'].includes(completed.run.status), completed.run.error);
    await worker.tick();
    const runs = await f.repo.runs(id); assert.equal(runs.length, 2); assert.deepEqual(runs.map(run => run.trigger).sort(), ['manual','scheduled']);
    assert.equal(calls.filter(call => call.endpoint === 'read').length, 2); assert.equal(calls.filter(call => call.endpoint === 'write').length, 2);
  });
});

test('simultaneous manual requests acquire one shared reservation and reject the loser before any SQL input', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const requests = [f.requestAny(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' }), f.requestAny(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' })];
  await entered.promise;
  try {
    const rejected = await withTimeout(Promise.race(requests), 'the competing manual request must be rejected while its winner is still reading');
    assert.equal(rejected.status, 409); assert.equal(calls.filter(call => call.endpoint === 'read').length, 1);
  } finally { release.resolve(); }
  const responses = await Promise.all(requests); assert.deepEqual(responses.map(result => result.status).sort(), [200,409]);
  assert.equal(calls.filter(call => call.endpoint === 'read').length, 1); assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
  assert.equal((await f.repo.runs(id)).length, 1);
});

test('an expired manual lease is durably recovered and its old request cannot output or overwrite the failure', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onRead: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const request = f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
  await entered.promise; let recovered, response;
  try {
    f.advance(121_000); assert.equal(await f.runner().recover(), 1);
    recovered = (await f.repo.runs(id))[0]; assert.equal(recovered.trigger, 'manual'); assert.equal(recovered.status, 'failed'); assert.equal(recovered.execution.state, 'interrupted');
  } finally { release.resolve(); response = await request; }
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 0);
  assert.deepEqual((await f.repo.runs(id))[0], recovered); assert.deepEqual(response.run, recovered);
  assert.equal((await f.repo.model(id)).schedule.enabled, true);
  f.advance(60 * 60_000); await f.runner().tick();
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
});

test('a bookkeeping failure after acknowledged SQL output preserves the reconciled snapshot and future scheduling', async t => {
  const f = await fixture(t); let failNextHistoryRead = false, injected = false;
  const calls = f.gateway({ values: { f1: 120, f3: 60, f4: 35 }, onWrite: async () => { if (!injected) failNextHistoryRead = true; } }), id = await f.sqlModel();
  const original = Repository.prototype.runs;
  Repository.prototype.runs = async function (modelId, ...args) {
    if (modelId === id && failNextHistoryRead) { failNextHistoryRead = false; injected = true; throw new Error('Injected post-output history failure'); }
    return original.call(this, modelId, ...args);
  };
  try { await f.runner().tick(); }
  finally { Repository.prototype.runs = original; }
  assert.equal(failNextHistoryRead, false, 'the fault must occur after delivery, before completion');
  const runs = await f.repo.runs(id); assert.equal(runs.length, 1); const run = runs[0];
  assert.equal(run.status, 'failed'); assert.ok(run.result, 'the output checkpoint must preserve its calculation');
  assert.equal(run.modelSnapshot.streams.find(stream => stream.id === 'f1').value, 120);
  assert.equal(run.sql.input.readings.find(reading => reading.sourceName === 'f1').originalValue, 100);
  assert.equal(run.execution.delivery, 'confirmed'); assert.equal((await f.repo.model(id)).schedule.enabled, true);
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
  await f.runner().tick(); assert.equal(calls.filter(call => call.endpoint === 'write').length, 1);
  f.advance(60 * 60_000); await f.runner().tick();
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 2, 'a confirmed delivery must not disable later reporting periods');
  assert.equal(await f.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE model_id=? AND action='delivery_paused'").bind(id).first('count'), 0);
});

test('one hundred ineligible overdue models cannot starve the next authorized model', async t => {
  const f = await fixture(t), id = await f.create(showcaseModel()); await f.enable(id); await f.due(id);
  const revoked = { id: 'revoked-scheduler', email: 'revoked@example.test', name: 'Revoked scheduler' };
  await f.request('/api/session', 'GET', undefined, 200, revoked);
  const template = await f.DB.prepare('SELECT * FROM models WHERE id=?').bind(id).first(), columns = Object.keys(template);
  const insert = f.DB.raw.prepare(`INSERT INTO models (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (let index = 0; index < 100; index++) {
    const blockedId = `ineligible-${String(index).padStart(3, '0')}`;
    const clone = { ...template, id: blockedId, schedule_json: JSON.stringify({ ...JSON.parse(template.schedule_json), nextRunAt: new Date(f.env.NOW() - 3600_000).toISOString() }) };
    insert.run(...columns.map(column => clone[column]));
    if (index % 2) await f.DB.prepare('INSERT INTO schedule_authorizations(model_id,user_id,generation,configured_at) VALUES (?,?,1,?)').bind(blockedId, revoked.id, new Date(f.env.NOW()).toISOString()).run();
  }
  await f.runner().tick(); assert.equal((await f.repo.runs(id)).length, 1);
  assert.equal(await f.DB.prepare("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE model_id LIKE 'ineligible-%'").first('count'), 0);
});

test('an uncertain output error pauses future automatic runs and records the pause once for either trigger', async t => {
  for (const trigger of ['manual', 'scheduled']) await t.test(trigger, async t => {
    const f = await fixture(t), calls = f.gateway({ onWrite: async () => { throw new Error('Connection interrupted after output was submitted'); } }), id = await f.sqlModel();
    if (trigger === 'manual') await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
    else await f.runner().tick();
    const run = (await f.repo.runs(id))[0]; assert.equal(run.trigger, trigger); assert.equal(run.status, 'failed'); assert.ok(run.result); assert.equal(run.execution.delivery, 'uncertain');
    const model = await f.repo.model(id); assert.equal(model.schedule.enabled, false); assert.equal(model.schedule.nextRunAt, null);
    f.advance(2 * 60 * 60_000); await f.runner().tick(); await f.runner().recover();
    assert.equal(calls.filter(call => call.endpoint === 'write').length, 1); assert.equal((await f.repo.runs(id)).length, 1);
    const pauses = await f.DB.prepare("SELECT * FROM audit_events WHERE model_id=? AND category='schedule' AND action='delivery_paused'").bind(id).all();
    assert.equal(pauses.results.length, 1); assert.equal(pauses.results[0].actor_id, f.identity.id);
  });
});

test('recovering uncertain manual output also pauses the due automatic schedule before its next period', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const calls = f.gateway({ onWrite: async () => { entered.resolve(); await release.promise; } }), id = await f.sqlModel();
  const manual = f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
  await entered.promise; let recovered, response;
  try {
    f.advance(121_000); await f.runner().recover(); recovered = (await f.repo.runs(id))[0];
    assert.equal(recovered.status, 'failed'); assert.equal(recovered.execution.delivery, 'uncertain'); assert.ok(recovered.result);
  } finally { release.resolve(); response = await manual; }
  assert.deepEqual(response.run, recovered);
  const model = await f.repo.model(id); assert.equal(model.schedule.enabled, false); assert.equal(model.schedule.nextRunAt, null);
  f.advance(2 * 60 * 60_000); await f.runner().tick();
  assert.equal(calls.filter(call => call.endpoint === 'write').length, 1); assert.equal((await f.repo.runs(id)).length, 1);
  assert.equal(await f.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE model_id=? AND action='delivery_paused'").bind(id).first('count'), 1);
});
