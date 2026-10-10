import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, profile, piInput, piOutput, piMock } from './helpers/pi-fixture.js';
import { runMatchesInputSource } from '../public/schedule-runner.js';

async function configured(t, options = {}) {
  const f = await fixture(t, options); f.env.PI_CONNECTIONS = []; f.env.LOCAL_AUTH_PEPPER = 'test-pi-encryption-pepper-'.repeat(3);
  await f.request('/api/session');
  const connection = { ...profile(), id: 'ui-plant' };
  const endpoint = `/api/admin/pi/connections/${connection.id}`;
  const save = (value = connection, revision = 0, actor) => f.request(endpoint, 'PUT', { profile: value, revision }, actor);
  return { ...f, connection, endpoint, save };
}
const publicAuth = connection => ({ type: 'basic', username: connection.auth.username });
async function modelUsing(f) {
  const id = await f.create(undefined, []), model = await f.repo.model(id);
  const sources = [{ ...piInput, connectionId: f.connection.id }, { ...piOutput, connectionId: f.connection.id }];
  const saved = await f.request(`/api/models/${id}/sources`, 'PUT', { sources, connectorType: 'pi', revision: model.revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await f.publish(id); await f.select(id, { enabled: true }); return id;
}

test('PI setup is administrator-only and stores encrypted profiles with write-only credentials', async t => {
  const f = await configured(t);
  for (const method of ['GET', 'PUT']) {
    const result = await f.request(method === 'GET' ? '/api/admin/pi/connections' : f.endpoint, method, method === 'PUT' ? { profile: f.connection, revision: 0 } : undefined, f.viewer);
    assert.equal(result.status, 403);
  }
  const saved = await f.save(); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.revision, 1);
  assert.deepEqual(saved.body.profiles[0].auth, { ...publicAuth(f.connection), credentialConfigured: true });
  const row = await f.DB.prepare('SELECT * FROM pi_configuration').first();
  for (const secret of [f.connection.auth.password, f.connection.auth.username, f.connection.baseUrl, f.connection.inputs[0].path]) assert.ok(!JSON.stringify(row).includes(secret));
  const metadata = await f.request('/api/pi/connections'); assert.equal(metadata.status, 200);
  for (const secret of [f.connection.auth.password, f.connection.auth.username, f.connection.baseUrl, f.connection.inputs[0].path]) assert.ok(!JSON.stringify(metadata.body).includes(secret));
  const audit = await f.request('/api/audit'); assert.ok(JSON.stringify(audit.body).includes('pi_connection_saved')); assert.ok(!JSON.stringify(audit.body).includes(f.connection.auth.password));
  assert.ok(!JSON.stringify((await f.request('/api/workspace')).body).includes(f.connection.auth.password));
});

test('saved Basic and proxy Bearer credentials can be retained, replaced, and never redirected silently', async t => {
  const f = await configured(t); assert.equal((await f.save()).status, 200);
  const retained = { ...f.connection, name: 'Renamed connection', auth: publicAuth(f.connection) };
  assert.equal((await f.save(retained, 1)).status, 200);
  for (const changed of [{ ...retained, baseUrl: 'https://different.test/piwebapi' }, { ...retained, auth: { type: 'basic', username: 'another-account' } }, { ...retained, auth: { type: 'bearer' } }]) assert.equal((await f.save(changed, 2)).status, 400);
  const bearer = { ...retained, auth: { type: 'bearer', token: 'fixture-proxy-token-not-real-12345' } };
  const updated = await f.save(bearer, 2); assert.equal(updated.status, 200); assert.deepEqual(updated.body.profiles[0].auth, { type: 'bearer', credentialConfigured: true });
  assert.equal((await f.save({ ...bearer, auth: { type: 'bearer' } }, 3)).status, 200);
  const id = await modelUsing(f), result = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
  assert.equal(result.status, 200); assert.equal(result.body.run.status, 'ok', result.body.run.error);
  assert.ok(f.mock.requests.every(request => request.options.headers.Authorization === `Bearer ${bearer.auth.token}`));
});

test('UI connection tests are read-only, use retained secrets, and check current revision and administrator access', async t => {
  const f = await configured(t); assert.equal((await f.save()).status, 200);
  const body = { profile: { ...f.connection, auth: publicAuth(f.connection) }, revision: 1 };
  const tested = await f.request('/api/admin/pi/connections/test', 'POST', body); assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(f.mock.requests.filter(request => request.options.method === 'POST').length, 0);
  assert.equal((await f.request('/api/admin/pi/connections/test', 'POST', { ...body, revision: 0 })).status, 409);
  assert.equal((await f.request('/api/admin/pi/connections/test', 'POST', body, f.viewer)).status, 403);
});

test('connection changes fence captured sources, pause selected schedules, and invalidate old run applicability', async t => {
  const f = await configured(t); await f.save(); const id = await modelUsing(f);
  const original = await f.repo.model(id); assert.ok(original.sources.every(source => source.connectionRevision === 1));
  const result = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' }); assert.equal(result.status, 200); assert.equal(result.body.run.status, 'ok', result.body.run.error);
  assert.equal(runMatchesInputSource(result.body.run, original.sources, original.schedule), true);
  assert.equal((await f.save({ ...f.connection, name: 'Updated historian', auth: publicAuth(f.connection) }, 1)).status, 200);
  const changed = await f.repo.model(id); assert.equal(changed.schedule.enabled, false); assert.equal(changed.schedule.nextRunAt, null); assert.ok(changed.revision > original.revision);
  assert.ok(changed.sources.every(source => source.connectionRevision === 2));
  assert.equal(runMatchesInputSource(result.body.run, changed.sources, changed.schedule), false);
  const workspace = JSON.stringify((await f.request('/api/workspace')).body); assert.ok(!workspace.includes(f.connection.auth.password)); assert.ok(!workspace.includes(f.connection.baseUrl));
  assert.equal((await f.request(f.endpoint, 'DELETE', { revision: 2 })).status, 409);
});

test('optimistic connection writes allow one winner and authentication revocation blocks commit and audit', async t => {
  const f = await configured(t), results = await Promise.all([f.save(), f.save()]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const batch = f.DB.batch.bind(f.DB); f.DB.batch = async statements => { await f.DB.prepare('UPDATE users SET active=0 WHERE id=?').bind(f.admin.id).run(); return batch(statements); };
  assert.equal((await f.save({ ...f.connection, name: 'Rejected change' }, 1)).status, 403);
  assert.equal((await f.DB.prepare('SELECT revision FROM pi_configuration').first()).revision, 1);
  const events = await f.DB.prepare("SELECT id FROM audit_events WHERE action='pi_connection_saved'").all(); assert.equal(events.results.length, 1);
});

test('missing keys, ciphertext tampering, and mismatched restoration fail without exposing saved credentials', async t => {
  const f = await configured(t), pepper = f.env.LOCAL_AUTH_PEPPER;
  delete f.env.LOCAL_AUTH_PEPPER; assert.equal((await f.save()).status, 503);
  f.env.LOCAL_AUTH_PEPPER = pepper; assert.equal((await f.save()).status, 200);
  f.env.LOCAL_AUTH_PEPPER = 'wrong-fixture-pepper-'.repeat(4);
  const wrong = await f.request('/api/admin/pi/connections'); assert.equal(wrong.status, 503); assert.ok(!JSON.stringify(wrong.body).includes(f.connection.auth.password));
  f.env.LOCAL_AUTH_PEPPER = pepper;
  await f.DB.prepare('UPDATE pi_configuration SET revision=revision+1').run(); assert.equal((await f.request('/api/pi/connections')).status, 503);
});

test('UI cannot override file-managed connections and unused connections can be removed with sanitized audit', async t => {
  const f = await configured(t); f.env.PI_CONNECTIONS = [profile()];
  const read = await f.request('/api/admin/pi/connections'); assert.equal(read.status, 200); assert.equal(read.body.profiles[0].readOnly, true);
  assert.equal((await f.request('/api/admin/pi/connections/plant-pi', 'PUT', { profile: profile(), revision: 0 })).status, 400);
  assert.equal((await f.save()).status, 200); assert.equal((await f.request(f.endpoint, 'DELETE', { revision: 1 })).status, 200);
  assert.equal((await f.request('/api/admin/pi/connections')).body.profiles.length, 1);
  assert.ok(JSON.stringify((await f.request('/api/audit')).body).includes('pi_connection_deleted'));
});

test('unsaved PI source tests reject a connection change during metadata inspection', async t => {
  let f, changed = false;
  const mock = piMock({ onRequest: async () => {
    if (!changed) { changed = true; assert.equal((await f.save({ ...f.connection, name: 'Changed during preview', auth: publicAuth(f.connection) }, 1)).status, 200); }
  } });
  f = await configured(t, { mock }); await f.save();
  const id = await f.create(undefined, []), model = await f.repo.model(id);
  const result = await f.request(`/api/models/${id}/sources/test`, 'POST', { source: { ...piInput, connectionId: f.connection.id }, revision: model.revision });
  assert.equal(result.status, 409);
  assert.deepEqual((await f.repo.model(id)).sources, []);
});

test('atomic guards reject deletion raced by assignment and assignment raced by deletion', async t => {
  const f = await configured(t); await f.save();
  const id = await f.create(undefined, []), model = await f.repo.model(id);
  const sources = [{ ...piInput, connectionId: f.connection.id, connectionRevision: 1 }];
  const batch = f.DB.batch.bind(f.DB); let inject = true;
  f.DB.batch = async statements => {
    if (inject) { inject = false; await f.DB.prepare('UPDATE models SET sources_json=? WHERE id=?').bind(JSON.stringify(sources), id).run(); }
    return batch(statements);
  };
  assert.equal((await f.request(f.endpoint, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await f.request('/api/admin/pi/connections')).body.profiles.length, 1);
  f.DB.batch = batch;
  await f.DB.prepare("UPDATE models SET sources_json='[]' WHERE id=?").bind(id).run();
  inject = true;
  f.DB.batch = async statements => {
    if (inject) { inject = false; assert.equal((await f.request(f.endpoint, 'DELETE', { revision: 1 })).status, 200); }
    return batch(statements);
  };
  const result = await f.request(`/api/models/${id}/sources`, 'PUT', { sources, connectorType: 'pi', revision: model.revision });
  assert.equal(result.status, 409);
  assert.deepEqual((await f.repo.model(id)).sources, []);
});

for (const afterFirstWrite of [false, true]) test(`changing credentials during ${afterFirstWrite ? 'delivery' : 'preflight'} stops PI writes and retains calculation provenance`, async t => {
  let f, changed = false;
  const change = async () => { if (!changed) { changed = true; assert.equal((await f.save({ ...f.connection, name: 'Changed during run', auth: publicAuth(f.connection) }, 1)).status, 200); } };
  const mock = piMock({ onRequest: request => !afterFirstWrite && request.route === 'points' && request.url.searchParams.get('path').includes('OUT_') ? change() : undefined, onWrite: () => afterFirstWrite ? change() : undefined });
  f = await configured(t, { standalone: true, mock }); await f.save(); const id = await modelUsing(f);
  const result = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' }); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.run.status, 'failed'); assert.ok(result.body.run.result); assert.equal(result.body.run.publishedVersion, 1);
  assert.equal(mock.requests.filter(request => request.options.method === 'POST').length, afterFirstWrite ? 1 : 0);
  assert.equal((await f.repo.model(id)).schedule.enabled, false);
});
