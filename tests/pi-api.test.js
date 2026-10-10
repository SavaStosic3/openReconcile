import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledRunner } from '../backend/scheduled-runs.js';
import { connectorInputAudit, connectorOutputAudit } from '../public/schedule-runner.js';
import { validateCatalog } from '../public/management-store.js';
import { fixture, piInput, piOutput, sqlInput, mappedModel, piMock } from './helpers/pi-fixture.js';

const closeTo = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);
const sqlOutput = { id: 'sql-output', name: 'SQL reconciliation results', type: 'sql', direction: 'output', connectionId: 'plant-sql', table: 'results' };
function sqlMock(f) {
  const calls = [];
  Object.assign(f.env, { SQL_GATEWAY_URL: 'https://gateway.test', SQL_GATEWAY_TOKEN: 'fixture-sql-token-'.repeat(3), SQL_GATEWAY_FETCH: async (url, options) => {
    const endpoint = new URL(url).pathname.slice(1), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ endpoint, body });
    const data = endpoint === 'connections' ? { connections: [{ id: 'plant-sql', name: 'Plant SQL', dialect: 'postgres', canRead: true, canWrite: true }] }
      : endpoint === 'read' ? { readings: body.tags.map(sourceName => ({ sourceName, value: { f1: 100, f3: 60, f4: 35 }[sourceName], timestamp: body.start })), window: { start: body.start, end: body.end } }
        : endpoint === 'write' ? { written: body.rows.length } : { ok: true };
    return Response.json(data);
  } });
  return calls;
}
async function grantEditor(f, id) {
  assert.equal((await f.request('/api/session', 'GET', undefined, f.viewer)).status, 200);
  assert.equal((await f.request(`/api/admin/users/${f.viewer.id}`, 'PATCH', { role: 'editor' })).status, 200);
  assert.equal((await f.request(`/api/admin/models/${id}/permissions`, 'PUT', { userId: f.viewer.id, level: 'editor' })).status, 200);
}

test('PI metadata and source mutations require administrators, current revisions and unlocked model editing', async t => {
  const f = await fixture(t), id = await f.create(); await grantEditor(f, id);
  assert.equal((await f.request('/api/pi/connections', 'GET', undefined, f.viewer)).status, 403);
  const metadata = await f.request('/api/pi/connections'); assert.equal(metadata.status, 200); assert.equal(metadata.body.connections.length, 1);
  for (const forbidden of ['fixture-only-password', 'fixture-user', 'pi.example.test', 'PIDA']) assert.ok(!JSON.stringify(metadata.body).includes(forbidden));
  const current = await f.repo.model(id);
  assert.equal((await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [], connectorType: 'pi', revision: current.revision }, f.viewer)).status, 403);
  assert.equal((await f.request(`/api/models/${id}/sources/test`, 'POST', { source: piInput, revision: current.revision }, f.viewer)).status, 403);
  for (const source of [{ ...piInput, password: 'secret' }, { ...piInput, baseUrl: 'https://rogue.test' }, { ...piInput, connectionId: 'unconfigured' }]) {
    assert.equal((await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [source], connectorType: 'pi', revision: current.revision })).status, 400);
  }
  assert.equal((await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [piInput, piInput], connectorType: 'pi', revision: current.revision })).status, 400);
  assert.equal((await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [], connectorType: 'pi', revision: current.revision - 1 })).status, 409);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { editLocked: true, revision: current.revision })).status, 200);
  const locked = await f.repo.model(id);
  assert.equal((await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [], connectorType: 'pi', revision: locked.revision })).status, 403);
  assert.equal((await f.request(`/api/models/${id}/sources/preview`, 'POST', { source: piInput, revision: locked.revision })).status, 403);
});

test('saving or removing one connector registry preserves SQL, PI and legacy sources and pauses affected schedules', async t => {
  const f = await fixture(t), id = await f.create(), legacy = { id: 'legacy', name: 'Company adapter', type: 'custom', direction: 'both' };
  sqlMock(f);
  let current = await f.repo.model(id);
  await f.DB.prepare('UPDATE models SET sources_json=? WHERE id=?').bind(JSON.stringify([...current.sources, legacy]), id).run();
  let saved = await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [sqlInput, sqlOutput], revision: current.revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(new Set(saved.body.sources.map(source => source.id)), new Set([piInput.id, piOutput.id, sqlInput.id, sqlOutput.id, legacy.id]));
  current = await f.repo.model(id);
  const collision = await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [{ ...piInput, id: sqlInput.id }], connectorType: 'pi', revision: current.revision });
  assert.equal(collision.status, 400, JSON.stringify(collision.body));
  await f.publish(id); await f.select(id, { enabled: true });
  current = await f.repo.model(id);
  saved = await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [], connectorType: 'pi', revision: current.revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.schedulePaused, true);
  assert.equal(saved.body.schedule.enabled, false); assert.equal(saved.body.schedule.inputSourceId, null); assert.equal(saved.body.schedule.outputSourceId, null);
  assert.deepEqual(new Set(saved.body.sources.map(source => source.id)), new Set([sqlInput.id, sqlOutput.id, legacy.id]));
});

test('PI preview and connection testing are read-only and audit exact completed reporting windows', async t => {
  const f = await fixture(t), id = await f.create(mappedModel({ virtual: true })), current = await f.repo.model(id);
  const before = structuredClone(current), writes = () => f.mock.requests.filter(request => request.options.method === 'POST').length;
  const tested = await f.request(`/api/models/${id}/sources/test`, 'POST', { source: piOutput, revision: current.revision });
  assert.equal(tested.status, 200, JSON.stringify(tested.body)); assert.equal(writes(), 0);
  const preview = await f.request(`/api/models/${id}/sources/preview`, 'POST', { source: piInput, revision: current.revision, target: 'draft' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.readings.length, 3);
  assert.equal(preview.body.window.start, '2026-10-10T09:00:00.000Z'); assert.equal(preview.body.window.end, '2026-10-10T10:00:00.000Z');
  assert.equal(preview.body.readings.some(reading => reading.itemId === 'f2'), false); assert.equal(writes(), 0);
  assert.deepEqual(await f.repo.model(id), before); assert.equal((await f.repo.runs(id)).length, 0);
});

test('PI physical inputs refresh published and draft snapshots before their virtual-meter formulas are evaluated', async t => {
  const model = mappedModel({ virtual: true }), f = await fixture(t, { mock: piMock({ values: { f1: 140, f3: 80, f4: 60 } }) }), id = await f.create(model);
  await f.publish(id); await f.select(id);
  const before = await f.repo.model(id), draft = structuredClone(model);
  draft.name = 'Edited PI plant'; draft.streams[0].meterName = 'Renamed feed'; draft.streams[1].formula = '[Renamed feed]';
  draft.streams[0].value = 77777; draft.streams[1].value = 88888;
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: draft, revision: before.revision })).status, 200);
  for (const target of ['published', 'draft']) {
    const response = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target });
    assert.equal(response.status, 200, JSON.stringify(response.body)); const run = response.body.run;
    assert.ok(['ok', 'warning'].includes(run.status), run.error); assert.equal(run.modelSnapshot.streams[0].value, 140); assert.equal(run.modelSnapshot.streams[1].value, 140);
    assert.equal(run.modelSnapshot.streams[1].formula, target === 'published' ? '[Feed meter]' : '[Renamed feed]');
    assert.equal(run.publishedVersion, target === 'published' ? 1 : null); closeTo(run.result.objective, 0);
    run.result.balances.forEach(balance => closeTo(balance.reconciled, 0));
    assert.equal(connectorInputAudit(run).readings.length, 3); assert.equal(connectorOutputAudit(run).written, 6);
  }
  const saved = await f.repo.model(id); assert.deepEqual(saved.model, draft); assert.deepEqual(saved.publishedModel, model);
  const workspace = await f.request('/api/workspace'); assert.doesNotThrow(() => validateCatalog(workspace.body.catalog));
  const raw = JSON.stringify(workspace.body); for (const forbidden of ['fixture-only-password', 'pi.example.test', 'PIDA']) assert.ok(!raw.includes(forbidden));
});

test('PI input quality failures retain period provenance and never calculate or deliver cached readings', async t => {
  const f = await fixture(t, { mock: piMock({ samples: (_name, _request, event) => [event('2026-10-10T09:00:00.000Z', 999999, { Questionable: true })] }) }), id = await f.create();
  await f.publish(id); await f.select(id);
  const response = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
  assert.equal(response.status, 200, JSON.stringify(response.body)); const run = response.body.run;
  assert.equal(run.status, 'failed'); assert.equal(run.result, null); assert.match(run.error, /^Input failed: f1: /);
  assert.equal(run.pi.input.window.start, '2026-10-10T09:00:00.000Z'); assert.deepEqual(run.pi.input.readings, []); assert.equal(run.pi.output, undefined);
  assert.equal(f.mock.requests.filter(request => request.options.method === 'POST').length, 0);
  assert.equal((await f.repo.runs(id)).length, 1);
});

test('unattended PI schedules use the same analytical mass balance with no browser session', async t => {
  const f = await fixture(t, { standalone: true }), id = await f.create();
  await f.publish(id); await f.select(id, { enabled: true, intervalMinutes: 60 }); await f.due(id);
  assert.equal(await f.DB.prepare('SELECT COUNT(*) AS count FROM local_sessions').first('count'), 0);
  const worker = createScheduledRunner(f.env); await worker.tick(); await worker.drain();
  const runs = await f.repo.runs(id); assert.equal(runs.length, 1); const run = runs[0];
  assert.equal(run.trigger, 'scheduled'); assert.equal(run.target, 'published'); assert.equal(run.publishedVersion, 1);
  assert.ok(['ok', 'warning'].includes(run.status), run.error); closeTo(run.result.objective, 25 / 9);
  closeTo(run.result.streams.find(stream => stream.id === 'f1').value, 895 / 9);
  closeTo(run.result.streams.find(stream => stream.id === 'f3').value, 560 / 9);
  closeTo(run.result.streams.find(stream => stream.id === 'f4').value, 335 / 9);
  assert.equal(run.execution.delivery, 'confirmed'); assert.equal(run.pi.output.written, 6);
  await createScheduledRunner(f.env).tick(); assert.equal((await f.repo.runs(id)).length, 1);
});

test('uncertain PI output pauses both manual and scheduled automatic delivery while preserving partial acknowledgements', async t => {
  for (const trigger of ['manual', 'scheduled']) await t.test(trigger, async t => {
    let count = 0;
    const f = await fixture(t, { standalone: true, mock: piMock({ onRequest: request => request.options.method === 'POST' && ++count === 2 ? new Response(null, { status: 500 }) : undefined }) }), id = await f.create();
    await f.publish(id); await f.select(id, { enabled: true, intervalMinutes: 60 });
    if (trigger === 'scheduled') { await f.due(id); await createScheduledRunner(f.env).tick(); }
    else assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger, target: 'published' })).status, 200);
    const run = (await f.repo.runs(id))[0]; assert.equal(run.status, 'failed'); assert.ok(run.result);
    assert.equal(run.pi.output.written, 1); assert.equal(run.pi.output.events.filter(event => event.confirmed).length, 1); assert.equal(run.execution.delivery, 'uncertain');
    const paused = await f.repo.model(id); assert.equal(paused.schedule.enabled, false); assert.equal(paused.schedule.nextRunAt, null);
    f.advance(60 * 60_000); await createScheduledRunner(f.env).tick(); assert.equal(count, 2, 'the next cadence must not repeat partially delivered events');
    const audit = await f.DB.prepare("SELECT * FROM audit_events WHERE model_id=? AND category='schedule' AND action='delivery_paused'").bind(id).all(); assert.equal(audit.results.length, 1);
    const serialized = JSON.stringify([run, audit.results]); for (const forbidden of ['fixture-only-password', 'fixture-user', 'pi.example.test', 'PIDA']) assert.ok(!serialized.includes(forbidden));
  });
});

test('revoking the acting user during PI input prevents external output and keeps a terminal record', async t => {
  let f;
  const mock = piMock({ onRequest: async request => {
    if (request.route === 'streams/IN_f4/recorded') await f.DB.prepare('UPDATE users SET active=0 WHERE id=?').bind(f.admin.id).run();
  } });
  f = await fixture(t, { standalone: true, mock }); const id = await f.create(); await f.publish(id); await f.select(id);
  const response = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
  assert.equal(response.status, 403, JSON.stringify(response.body));
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 0);
  const stored = await f.DB.prepare('SELECT run_json FROM model_runs WHERE model_id=?').bind(id).all(); assert.equal(stored.results.length, 1);
  const run = JSON.parse(stored.results[0].run_json); assert.equal(run.status, 'failed'); assert.equal(run.execution.delivery, 'not_attempted'); assert.match(run.error, /permission|authoriz|access|account/i);
});

test('standalone execution can use PI input with SQL output or SQL input with PI output without merging connector audits', async t => {
  for (const inputType of ['pi', 'sql']) await t.test(inputType, async t => {
    const f = await fixture(t, { standalone: true }), id = await f.create(), sqlCalls = sqlMock(f);
    let current = await f.repo.model(id);
    const saved = await f.request(`/api/models/${id}/sources`, 'PUT', { sources: [sqlInput, sqlOutput], revision: current.revision }); assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await f.publish(id); await f.select(id, { inputSourceId: inputType === 'pi' ? piInput.id : sqlInput.id, outputSourceId: inputType === 'pi' ? sqlOutput.id : piOutput.id });
    const response = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' }); assert.equal(response.status, 200, JSON.stringify(response.body));
    const run = response.body.run; assert.ok(['ok', 'warning'].includes(run.status), run.error); closeTo(run.result.objective, 25 / 9);
    assert.equal(connectorInputAudit(run).source.type, inputType); assert.equal(connectorOutputAudit(run).source.type, inputType === 'pi' ? 'sql' : 'pi');
    assert.equal(run.execution.delivery, 'confirmed');
    if (inputType === 'pi') { assert.equal(run.pi.output, undefined); assert.equal(run.sql.input, undefined); assert.equal(sqlCalls.filter(call => call.endpoint === 'write').length, 1); }
    else { assert.equal(run.pi.input, undefined); assert.equal(run.sql.output, undefined); assert.equal(sqlCalls.filter(call => call.endpoint === 'read').length, 1); }
  });
});

test('permissions revoked during PI output preflight prevent the first event without marking delivery uncertain', async t => {
  let f;
  const mock = piMock({ onRequest: async request => {
    if (request.route === 'points' && request.url.searchParams.get('path').includes('OUT_f1')) await f.DB.prepare('UPDATE users SET active=0 WHERE id=?').bind(f.admin.id).run();
  } });
  f = await fixture(t, { standalone: true, mock }); const id = await f.create(); await f.publish(id); await f.select(id, { enabled: true });
  assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' })).status, 403);
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 0);
  const run = (await f.repo.runs(id))[0]; assert.equal(run.status, 'failed'); assert.ok(run.result); assert.equal(run.execution.delivery, 'not_attempted');
  assert.equal((await f.repo.model(id)).schedule.enabled, true);
  const audit = await f.DB.prepare("SELECT id FROM audit_events WHERE model_id=? AND action='delivery_paused'").bind(id).all(); assert.equal(audit.results.length, 0);
});

test('PI checks permission before every event and retains the first acknowledgement when later access is revoked', async t => {
  let f;
  const mock = piMock({ onWrite: async () => { await f.DB.prepare('UPDATE users SET active=0 WHERE id=?').bind(f.admin.id).run(); } });
  f = await fixture(t, { standalone: true, mock }); const id = await f.create(); await f.publish(id); await f.select(id, { enabled: true });
  assert.equal((await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' })).status, 403);
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 1);
  const run = (await f.repo.runs(id))[0]; assert.equal(run.status, 'failed'); assert.ok(run.result);
  assert.equal(run.pi.output.written, 1); assert.equal(run.pi.output.events.filter(event => event.confirmed).length, 1); assert.equal(run.execution.delivery, 'uncertain');
  assert.equal((await f.repo.model(id)).schedule.enabled, false);
});

test('a lost execution lease during PI preflight is recovered before any external event is written', async t => {
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; }), release = new Promise(resolve => { releaseResolve = resolve; });
  const mock = piMock({ onRequest: async request => {
    if (request.route === 'points' && request.url.searchParams.get('path').includes('OUT_f1')) { enteredResolve(); await release; }
  } });
  const f = await fixture(t, { standalone: true, mock }), id = await f.create(); await f.publish(id); await f.select(id, { enabled: true }); await f.due(id);
  const worker = createScheduledRunner(f.env), running = worker.tick();
  await entered;
  try { f.advance(121_000); await createScheduledRunner(f.env).recover(); }
  finally { releaseResolve(); await running; }
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 0);
  const run = (await f.repo.runs(id))[0]; assert.equal(run.status, 'failed'); assert.equal(run.execution.state, 'interrupted'); assert.equal(run.execution.delivery, 'not_attempted');
  assert.equal((await f.repo.model(id)).schedule.enabled, true);
});

test('hosted PI output rechecks publication and source snapshots after read-only destination preflight', async t => {
  for (const mutation of ['unpublication', 'new publication', 'selected source', 'source registry']) await t.test(mutation, async t => {
    let f, id, changed = false;
    const mock = piMock({ onRequest: async request => {
      if (changed || request.route !== 'points' || !request.url.searchParams.get('path').includes('OUT_f1')) return;
      changed = true;
      const current = await f.repo.model(id);
      if (mutation === 'unpublication') {
        const response = await f.request(`/api/models/${id}/publication`, 'PATCH', { revision: current.revision, published: false });
        assert.equal(response.status, 200, JSON.stringify(response.body));
      } else if (mutation === 'new publication') {
        const model = { ...structuredClone(current.model), name: 'A newer published plant' };
        const edited = await f.request(`/api/models/${id}`, 'PATCH', { revision: current.revision, model });
        assert.equal(edited.status, 200, JSON.stringify(edited.body)); await f.publish(id);
      } else if (mutation === 'selected source') {
        const response = await f.request(`/api/models/${id}/schedule`, 'PATCH', { revision: current.revision, changes: { outputSourceId: null } });
        assert.equal(response.status, 200, JSON.stringify(response.body));
      } else {
        const response = await f.request(`/api/models/${id}/sources`, 'PUT', { revision: current.revision, connectorType: 'pi', sources: [piInput, { ...piOutput, name: 'Changed output configuration' }] });
        assert.equal(response.status, 200, JSON.stringify(response.body));
      }
    } });
    f = await fixture(t, { standalone: false, mock }); id = await f.create(); await f.publish(id); await f.select(id);
    const response = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(changed, true);
    assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, 0);
    const run = response.body.run; assert.equal(run.status, 'failed'); assert.ok(run.result); assert.match(run.error, /chang|publication|source|snapshot|published/i);
    assert.equal(run.pi.output.written, 0); assert.equal((await f.repo.runs(id))[0].status, 'failed');
    assert.equal(run.target, 'published'); assert.equal(run.publishedVersion, 1);
  });
});
