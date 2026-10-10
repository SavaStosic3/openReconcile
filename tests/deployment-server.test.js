import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { loadConfig, validatePublicOrigin } from '../deploy/config.js';
import { startServer } from '../deploy/server.mjs';
import { setupAdmin } from '../deploy/accounts.js';
import { openDatabase } from '../deploy/sqlite.js';
import { hashPassword } from '../backend/local-auth.js';
import { showcaseModel } from '../public/showcase-model.js';
import { storageShowcaseModel } from '../public/storage-showcase-model.js';

const USERNAME = 'PlantAdmin', PASSWORD = 'independent-test-password';
const closeTo = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-7, `${actual} differs from ${expected}`);

async function fixture(t, publicOrigin = 'http://localhost:8080') {
  const dataDir = await mkdtemp(join(tmpdir(), 'openreconcile-server-'));
  let running;
  t.after(async () => {
    try { if (running) await running.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  await setupAdmin({ dataDir, username: USERNAME, password: PASSWORD });
  const config = { ...await loadConfig({ env: { APP_DATA_DIR: dataDir, PUBLIC_ORIGIN: publicOrigin } }), port: 0, host: '127.0.0.1' };
  running = await startServer({ config });
  const request = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${running.address.port}${path}`, {
      method, headers: { ...(body !== undefined ? { Origin: publicOrigin, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      redirect: 'manual',
    });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, headers: response.headers, data };
  };
  const login = async (username = USERNAME, password = PASSWORD) => {
    const response = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return { response, cookie: response.headers.getSetCookie().find(value => /openreconcile_session=/.test(value)).split(';')[0] };
  };
  return { config, request, login, get running() { return running; }, async restart() { await running.close(); running = await startServer({ config }); } };
}

function rawRequest(port, path, { method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers }, response => {
      const result = []; response.on('data', chunk => result.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(result).toString('utf8') }));
    });
    request.once('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('standalone configuration requires persisted secrets and a canonical HTTPS public origin for company access', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'openreconcile-config-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(loadConfig({ env: { APP_DATA_DIR: dataDir } }), /secret|setup|initializ|install/i);
  assert.equal(validatePublicOrigin(), 'http://localhost:8080');
  for (const value of ['http://plant.internal', 'ftp://localhost', 'https://user:password@plant.internal', 'https://plant.internal/app', 'https://plant.internal/', 'https://plant.internal?x=1', 'https://plant.internal#top', '//plant.internal']) assert.throws(() => validatePublicOrigin(value), /PUBLIC_ORIGIN/);
  for (const value of ['https://plant.internal', 'http://127.0.0.1:8080', 'http://[::1]:8080']) assert.equal(validatePublicOrigin(value), value);
  await setupAdmin({ dataDir, username: USERNAME, password: PASSWORD });
  const config = await loadConfig({ env: { APP_DATA_DIR: dataDir, PUBLIC_ORIGIN: 'https://plant.internal', LOCAL_AUTH_PEPPER: 'client-chosen-pepper', AUTH_MODE: 'chatgpt' } });
  assert.equal(config.backendEnv.AUTH_MODE, 'password'); assert.equal(config.backendEnv.LOCAL_AUTH_ITERATIONS, 600_000);
  assert.equal(config.backendEnv.LOCAL_AUTH_IP_LIMIT, 100);
  assert.notEqual(config.backendEnv.LOCAL_AUTH_PEPPER, 'client-chosen-pepper');
  for (const changes of [{ PORT: '0' }, { PORT: '70000' }, { HOST: 'plant.internal' }, { SQL_GATEWAY_URL: 'https://gateway.internal' }, { SQL_GATEWAY_TOKEN: 's'.repeat(40) }, { SQL_GATEWAY_URL: 'http://gateway.internal', SQL_GATEWAY_TOKEN: 's'.repeat(40) }, { SQL_GATEWAY_URL: 'https://gateway.internal', SQL_GATEWAY_TOKEN: 'weak' }]) {
    await assert.rejects(loadConfig({ env: { APP_DATA_DIR: dataDir, ...changes } }));
  }
  const configured = await loadConfig({ env: { APP_DATA_DIR: dataDir, SQL_GATEWAY_URL: 'https://gateway.internal', SQL_GATEWAY_TOKEN: 's'.repeat(40) } });
  assert.equal(configured.backendEnv.SQL_GATEWAY_URL, 'https://gateway.internal/');
  for (const LOGIN_IP_LIMIT of ['0', '19', '1001', '1000000', '20.5', 'abc', '', '-100']) await assert.rejects(loadConfig({ env: { APP_DATA_DIR: dataDir, LOGIN_IP_LIMIT } }), /LOGIN_IP_LIMIT/);
  for (const LOGIN_IP_LIMIT of ['20', '250', '1000']) assert.equal((await loadConfig({ env: { APP_DATA_DIR: dataDir, LOGIN_IP_LIMIT } })).backendEnv.LOCAL_AUTH_IP_LIMIT, Number(LOGIN_IP_LIMIT));
});

test('real HTTP login, publication, both analytic showcases, and persisted sessions work after a server restart', async t => {
  const f = await fixture(t), { cookie } = await f.login();
  const session = await f.request('/api/session', { cookie });
  assert.equal(session.status, 200); assert.equal(session.data.user.role, 'admin'); assert.equal(session.data.authMethod, 'password'); assert.equal(session.data.signInUrl, '/?signin=1');
  const models = [];
  for (const model of [showcaseModel(), storageShowcaseModel()]) {
    const created = await f.request('/api/models', { method: 'POST', body: { model }, cookie });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.entry.id; models.push(id);
    const published = await f.request(`/api/models/${id}/publication`, { method: 'PATCH', body: { published: true, revision: created.data.permission.revision }, cookie });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    const executed = await f.request(`/api/models/${id}/runs`, { method: 'POST', body: { trigger: 'manual', target: 'published' }, cookie });
    assert.equal(executed.status, 200, JSON.stringify(executed.data));
    const result = executed.data.run.result;
    assert.ok(result, executed.data.run.error);
    for (const balance of result.balances) closeTo(balance.reconciled, 0);
    if (model.name === 'Three-tank transfer') {
      closeTo(result.objective, 100 / 350);
      closeTo(result.streams.find(stream => stream.id === 'supply-flow').value, 1010 - 20 / 7);
      closeTo(result.streams.find(stream => stream.id === 'delivery-flow').value, 500 + 20 / 7);
      assert.equal(result.inventories.length, 3);
      for (const [index, inventory] of result.inventories.entries()) closeTo(inventory.accumulation.value, [200, 200, 100][index] + 10 / 7);
    } else {
      closeTo(result.objective, 0.4);
      closeTo(result.streams.find(stream => stream.id === 'raw-feed-flow').value, 804);
      closeTo(result.streams.find(stream => stream.id === 'filter-cake-flow').value, 105);
    }
  }
  await f.restart();
  const workspace = await f.request('/api/workspace', { cookie });
  assert.equal(workspace.status, 200);
  assert.deepEqual(workspace.data.catalog.models.map(model => model.id).sort(), models.sort());
  assert.ok(models.every(id => workspace.data.permissions[id].published));
  assert.ok(models.every(id => workspace.data.catalog.runs[id].length === 1));
  const logout = await f.request('/api/auth/logout', { method: 'POST', body: {}, cookie });
  assert.equal(logout.status, 200);
  assert.equal((await f.request('/api/workspace', { cookie })).status, 401);
});

test('company HTTPS uses Secure host cookies and enforces browser Origin while ignoring client identity and proxy headers', async t => {
  const f = await fixture(t, 'https://massbalance.plant.internal');
  const spoofed = { 'CF-Connecting-IP': '203.0.113.88', 'X-Forwarded-For': '203.0.113.99', 'X-Forwarded-Proto': 'https', Forwarded: 'for=203.0.113.77;proto=https;host=massbalance.plant.internal', 'oai-user-id': 'admin', 'oai-user-email': 'admin@plant.internal', 'X-OpenAI-User-ID': 'admin', Cookie: '__sites_local_auth=1' };
  for (const path of ['/api/session', '/api/workspace', '/api/admin']) assert.equal((await f.request(path, { headers: spoofed })).status, 401);
  assert.equal((await f.request('/api/auth/chatgpt', { headers: spoofed })).status, 404);
  const { cookie, response } = await f.login();
  const sessionCookie = response.headers.getSetCookie().find(value => /openreconcile_session=/.test(value));
  assert.match(sessionCookie, /^__Host-openreconcile_session=/); assert.match(sessionCookie, /; Secure/); assert.match(sessionCookie, /; HttpOnly/); assert.match(sessionCookie, /; SameSite=Strict/);
  for (const origin of ['https://attacker.example', 'http://massbalance.plant.internal', '']) {
    assert.equal((await f.request('/api/auth/logout', { method: 'POST', body: {}, cookie, headers: { Origin: origin } })).status, 403);
    assert.equal((await f.request('/api/models', { method: 'POST', body: { model: showcaseModel() }, cookie, headers: { Origin: origin, ...spoofed, Cookie: cookie } })).status, 403);
  }
  assert.equal((await f.request('/api/workspace', { cookie, headers: { Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example' } })).status, 200);
  const ipLimit = await f.running.DB.prepare("SELECT key FROM local_login_limits WHERE key LIKE 'ip:%'").first();
  await f.running.DB.prepare('UPDATE local_login_limits SET attempts=? WHERE key=?').bind(f.config.backendEnv.LOCAL_AUTH_IP_LIMIT, ipLimit.key).run();
  const limited = await f.request('/api/auth/login', { method: 'POST', body: { username: 'DifferentUser', password: PASSWORD }, headers: { ...spoofed, 'CF-Connecting-IP': '198.51.100.33', 'X-Forwarded-For': '198.51.100.44' } });
  assert.equal(limited.status, 429);
});

test('server exposes only shipped static assets and minimal readiness, rejects traversal and oversized bodies', async t => {
  const f = await fixture(t);
  const health = await f.request('/healthz'); assert.equal(health.status, 200); assert.deepEqual(health.data, { status: 'ok' });
  const home = await f.request('/'); assert.equal(home.status, 200); assert.match(home.headers.get('Content-Type'), /^text\/html/); assert.match(home.data, /<meta name="openreconcile-auth-mode" content="password">/);
  assert.match(home.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal((await f.request('/solver.js')).headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  assert.equal((await f.request('/styles.css')).headers.get('Content-Type'), 'text/css; charset=utf-8');
  for (const path of ['/backend/local-auth.js', '/deploy/accounts.js', '/data/server-secrets.json', '/.env', '/unknown-file', '/signin-with-chatgpt']) assert.equal((await f.request(path)).status, 404);
  for (const path of ['/../backend/local-auth.js', '/%2e%2e/data/server-secrets.json', '/foo/./solver.js', '/foo\\..\\deploy/accounts.js', '/%5cdata%5cserver-secrets.json', '/%2fdata', '/%00', '/%zz', '//attacker.example/api/session', 'http://attacker.example/api/session']) {
    assert.equal((await rawRequest(f.running.address.port, path)).status, 400, path);
  }
  const { cookie } = await f.login();
  assert.equal((await f.request('/api/unknown', { cookie })).status, 404);
  assert.equal((await f.request('/api/models', { method: 'POST', body: 'x'.repeat(2_000_001), cookie })).status, 413);
  const oversized = await rawRequest(f.running.address.port, '/api/models', { method: 'POST', headers: { Origin: f.config.publicOrigin, 'Content-Type': 'application/json', Cookie: cookie }, chunks: [Buffer.alloc(1_000_001), Buffer.alloc(1_000_001)] });
  assert.equal(oversized.status, 413);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD, extra: 'x'.repeat(9_000) } })).status, 413);
  const head = await f.request('/solver.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.data, '');
  assert.equal((await f.request('/healthz', { method: 'POST', body: {} })).status, 405);
});

test('real HTTP permissions prevent viewers from editing, running, publishing, deleting, and reaching admin settings', async t => {
  const f = await fixture(t), { cookie: adminCookie } = await f.login();
  const created = await f.request('/api/models', { method: 'POST', body: { model: showcaseModel() }, cookie: adminCookie });
  const id = created.data.entry.id;
  const stamp = new Date().toISOString(), userId = 'local:vieweruser';
  const passwordHash = await hashPassword(PASSWORD, f.config.backendEnv.LOCAL_AUTH_PEPPER, { iterations: 600_000 });
  await f.running.DB.batch([
    f.running.DB.prepare("INSERT INTO users(id,email,name,role,active,created_at,updated_at) VALUES (?,'','Viewer','viewer',1,?,?)").bind(userId, stamp, stamp),
    f.running.DB.prepare('INSERT INTO local_credentials(username,user_id,password_hash,created_at) VALUES (?,?,?,?)').bind('vieweruser', userId, passwordHash, stamp),
  ]);
  const assigned = await f.request(`/api/admin/models/${id}/permissions`, { method: 'PUT', body: { userId, level: 'viewer' }, cookie: adminCookie }); assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  const { cookie } = await f.login('vieweruser');
  assert.equal((await f.request('/api/workspace', { cookie })).status, 200);
  assert.equal((await f.request('/api/admin', { cookie })).status, 403);
  for (const [path, method, body] of [
    [`/api/models/${id}`, 'PATCH', { model: showcaseModel(), revision: 1 }],
    [`/api/models/${id}/runs`, 'POST', { trigger: 'manual' }],
    [`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 1 }],
    [`/api/admin/models/${id}`, 'DELETE', { revision: 1 }],
  ]) assert.equal((await f.request(path, { method, body, cookie })).status, 403, path);
});

test('starting without an active administrator fails before accepting requests', async t => {
  const f = await fixture(t);
  await f.running.close();
  const DB = openDatabase({ dataDir: f.config.dataDir, migrationsDir: f.config.migrationsDir });
  await DB.prepare("UPDATE users SET active=0 WHERE role='admin'").run(); DB.close();
  await assert.rejects(startServer({ config: f.config }), /active administrator/);
});

test('readiness reports database unavailability without exposing internal details', async t => {
  const f = await fixture(t);
  f.running.DB.close();
  const response = await f.request('/healthz');
  assert.equal(response.status, 503);
  assert.deepEqual(response.data, { status: 'unavailable' });
});
