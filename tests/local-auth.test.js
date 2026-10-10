import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleAuthenticatedApi, hashPassword, verifyPassword } from '../backend/local-auth.js';
import { Repository } from '../backend/repository.js';
import { exampleModel } from '../public/model.js';

const password = 'Fixture password 42';
const pepper = 'test-only-private-pepper-'.repeat(3);
const external = { id: 'owner-subject', email: 'owner@example.test', name: 'Owner' };
const sessionName = '__Host-openreconcile_session';
const suppressionName = '__Host-openreconcile_signed_out';

test('standalone hashing has its own fixed stronger work factor without changing hosted credentials', async () => {
  const hash = await hashPassword(password, pepper, { iterations: 600_000 });
  assert.match(hash, /^pbkdf2_sha256_hmac\$600000\$/);
  assert.equal(await verifyPassword(password, hash, pepper, { iterations: 600_000 }), true);
  assert.equal(await verifyPassword('Wrong fixture password', hash, pepper, { iterations: 600_000 }), false);
  assert.equal(await verifyPassword(password, hash, pepper), false);
  await assert.rejects(hashPassword(password, pepper, { iterations: 10 }));
  await assert.rejects(verifyPassword(password, hash, pepper, { iterations: 10 }));
});
let fixtureHash;
function cookies(response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]);
}
function fixture(t, { bootstrap = true, origin = 'https://balance.test' } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of ['0000_complete_random.sql', '0001_published_snapshots.sql', '0002_elite_layla_miller.sql', '0003_kind_tempest.sql']) sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  let tail = Promise.resolve(), now = Date.parse('2026-10-10T12:00:00.000Z');
  const DB = {
    prepare(sql) {
      return { values: [], bind(...values) { this.values = values; return this; },
        async first() { return sqlite.prepare(sql).get(...this.values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
        async run() { const result = sqlite.prepare(sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
      };
    },
    async batch(statements) {
      const result = tail.then(async () => {
        sqlite.exec('BEGIN');
        try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      tail = result.catch(() => {}); return result;
    }
  };
  const env = { DB, NOW: () => now, ADMIN_EMAIL: external.email, LOCAL_AUTH_PEPPER: pepper,
    ...(bootstrap ? { LOCAL_BOOTSTRAP_USERNAME: 'PlantAdmin', LOCAL_BOOTSTRAP_PASSWORD_HASH: fixtureHash } : {}) };
  async function request(path, { method = 'GET', body, cookie, identity = null, headers = {}, urlOrigin = origin } = {}) {
    const allHeaders = { ...(method === 'GET' ? {} : { Origin: urlOrigin, 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers };
    const result = await handleAuthenticatedApi(new Request(`${urlOrigin}${path}`, { method, headers: allHeaders, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env, identity);
    const response = { status: result.status, headers: result.headers };
    response.body = result.headers.get('Content-Type')?.includes('application/json') ? await result.json() : null;
    return response;
  }
  async function login(options = {}) { return request('/api/auth/login', { method: 'POST', body: { username: 'PlantAdmin', password }, ...options }); }
  const repository = new Repository(DB, { now: env.NOW });
  t.after(() => sqlite.close());
  return { sqlite, env, repository, request, login, advance(ms) { now += ms; }, count(table) { return sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; } };
}

test('password hashes are salted, peppered, fixed-cost and reject tampered/invalid formats', async () => {
  fixtureHash = await hashPassword(password, pepper);
  const second = await hashPassword(password, pepper);
  assert.notEqual(fixtureHash, second);
  assert.match(fixtureHash, /^pbkdf2_sha256_hmac\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyPassword(password, fixtureHash, pepper), true);
  assert.equal(await verifyPassword('Incorrect fixture password', fixtureHash, pepper), false);
  assert.equal(await verifyPassword(password, fixtureHash, `${pepper}changed`), false);
  for (const hash of [null, 'plaintext', fixtureHash.replace('100000', '600000'), fixtureHash.replace('pbkdf2_sha256_hmac', 'sha256'), `${fixtureHash}$extra`]) assert.equal(await verifyPassword(password, hash, pepper), false);
  await assert.rejects(hashPassword('short', pepper));
  await assert.rejects(hashPassword(password, 'short'));
});

test('first login provisions one admin and issues opaque HttpOnly host cookie with only token hash stored', async t => {
  const f = fixture(t), result = await f.login();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { ok: true });
  const sessionCookie = cookies(result).find(value => value.startsWith(`${sessionName}=`));
  assert.ok(sessionCookie); assert.match(result.headers.getSetCookie()[0], /Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=28800/);
  assert.ok(!result.headers.getSetCookie()[0].includes('Domain='));
  const token = sessionCookie.split('=')[1], row = f.sqlite.prepare('SELECT * FROM local_sessions').get();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(row.token_hash, token); assert.equal(row.expires_at - row.created_at, 8 * 60 * 60_000);
  const user = f.sqlite.prepare('SELECT * FROM users').get(); assert.equal(user.id, 'local:plantadmin'); assert.equal(user.role, 'admin'); assert.equal(user.email, '');
  const session = await f.request('/api/session', { cookie: sessionCookie, identity: external });
  assert.equal(session.status, 200); assert.equal(session.body.user.name, 'PlantAdmin'); assert.equal(session.body.authMethod, 'password'); assert.equal(session.body.signOutUrl, '/api/auth/logout');
  assert.ok(!JSON.stringify(session.body).includes('hash')); assert.ok(!JSON.stringify(session.body).includes(password)); assert.ok(!JSON.stringify(session.body).includes(pepper));
  assert.equal((await f.request('/api/admin', { cookie: sessionCookie })).status, 200);
});

test('unknown username, wrong password and disabled user share a generic failure and same KDF cost', async t => {
  const f = fixture(t);
  let derivations = 0;
  const original = crypto.subtle.deriveBits.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'deriveBits', async (...args) => { derivations++; assert.equal(args[0].iterations, 100_000); return original(...args); });
  const wrong = await f.login({ body: { username: 'PlantAdmin', password: 'Incorrect fixture password' } });
  const missing = await f.login({ body: { username: 'NobodyHere', password } });
  f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run('local:plantadmin');
  const disabled = await f.login();
  assert.equal(derivations, 3);
  for (const result of [wrong, missing, disabled]) { assert.equal(result.status, 401); assert.deepEqual(result.body, { error: 'The username or password is incorrect.' }); assert.deepEqual(cookies(result), []); }
  assert.equal(f.count('local_sessions'), 0);
});

test('auth mutations require same-origin JSON and reject CSRF, unsupported fields and oversized bodies', async t => {
  const f = fixture(t);
  for (const path of ['/api/auth/login', '/api/auth/logout']) {
    const body = path.endsWith('login') ? { username: 'PlantAdmin', password } : {};
    for (const headers of [{ Origin: 'https://attacker.test' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.request(path, { method: 'POST', body, headers })).status, 403);
    assert.equal((await f.request(path, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await f.request(path)).status, 405);
    assert.equal((await f.request(path, { method: 'POST', body: { ...body, role: 'admin' } })).status, 400);
    assert.equal((await f.request(path, { method: 'POST', body: ' '.repeat(8193) })).status, 413);
  }
  assert.equal(f.count('users'), 0); assert.equal(f.count('local_sessions'), 0);
});

test('account rate limits are atomic across concurrent attempts and shared across different client IPs', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => f.login({ headers: { 'CF-Connecting-IP': `192.0.2.${i}` } })));
  assert.equal(results.filter(result => result.status === 200).length, 5);
  assert.equal(results.filter(result => result.status === 429).length, 5);
  assert.equal(f.count('local_sessions'), 5);
  for (const result of results.filter(item => item.status === 429)) assert.equal(result.headers.get('Retry-After'), '900');
  f.advance(15 * 60_000);
  assert.equal((await f.login()).status, 200);
});

test('IP rate limits cover rotating unknown usernames and ignore spoofed forwarded-for', async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await f.login({ body: { username: `Unknown${i}`, password }, headers: { 'CF-Connecting-IP': '192.0.2.25', 'X-Forwarded-For': `192.0.2.${i}` } })).status, 401);
  assert.equal((await f.login({ headers: { 'CF-Connecting-IP': '192.0.2.25', 'X-Forwarded-For': '198.51.100.1' } })).status, 429);
  const limits = f.sqlite.prepare('SELECT key FROM local_login_limits').all();
  assert.ok(limits.every(row => !row.key.includes('192.0.2') && !row.key.includes('unknown')));
});

test('expired, malformed, duplicate and unknown local cookies fail closed even with trusted external identity', async t => {
  const f = fixture(t), result = await f.login(), validCookie = cookies(result)[0];
  for (const cookie of [`${sessionName}=wrong`, `${sessionName}=${'A'.repeat(43)}`, `${validCookie}; ${validCookie}`]) assert.equal((await f.request('/api/session', { cookie, identity: external })).status, 401);
  f.advance(8 * 60 * 60_000);
  assert.equal((await f.request('/api/session', { cookie: validCookie, identity: external })).status, 401);
  assert.equal(f.count('local_sessions'), 0);
  assert.equal(f.count('users'), 1, 'failed local cookies must not upsert an external account');
});

test('logout revokes the session and suppresses external fallback until explicit ChatGPT sign-in', async t => {
  const f = fixture(t), login = await f.login(), sessionCookie = cookies(login)[0];
  const logout = await f.request('/api/auth/logout', { method: 'POST', body: {}, cookie: sessionCookie, identity: external });
  assert.equal(logout.status, 200); assert.equal(f.count('local_sessions'), 0);
  const suppressed = cookies(logout).find(value => value.startsWith(`${suppressionName}=`));
  assert.ok(suppressed);
  assert.ok(logout.headers.getSetCookie().some(value => value.startsWith(suppressionName) && value.includes('Max-Age=31536000')));
  assert.equal((await f.request('/api/session', { cookie: suppressed, identity: external })).status, 401);
  const signIn = await f.request('/api/auth/chatgpt', { cookie: suppressed });
  assert.equal(signIn.status, 303); assert.equal(signIn.headers.get('Location'), '/signin-with-chatgpt?return_to=%2F');
  assert.ok(signIn.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
  assert.equal((await f.request('/api/session', { identity: external })).body.authMethod, 'chatgpt');
});

test('cross-site ChatGPT sign-in requests cannot clear or revoke an existing local session', async t => {
  const f = fixture(t), login = await f.login(), cookie = cookies(login)[0];
  const blocked = await f.request('/api/auth/chatgpt', { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(blocked.status, 403); assert.equal(f.count('local_sessions'), 1); assert.deepEqual(cookies(blocked), []);
  assert.equal((await f.request('/api/session', { cookie })).status, 200);
});

test('new login replaces any previous local session and clears explicit logout suppression', async t => {
  const f = fixture(t), first = await f.login(), cookie = cookies(first)[0];
  const second = await f.login({ cookie: `${cookie}; ${suppressionName}=1` });
  assert.equal(second.status, 200); assert.notEqual(cookies(second)[0], cookie); assert.equal(f.count('local_sessions'), 1);
  assert.ok(second.headers.getSetCookie().some(value => value.startsWith(suppressionName) && value.includes('Max-Age=0')));
  assert.equal((await f.request('/api/session', { cookie, identity: external })).status, 401);
  assert.equal((await f.request('/api/session', { cookie: cookies(second)[0] })).status, 200);
});

test('existing local account is never reset, promoted, re-enabled or updated by bootstrap/ADMIN_EMAIL', async t => {
  const f = fixture(t); await f.login();
  f.sqlite.prepare("UPDATE users SET role='viewer',active=0,name='Existing account' WHERE id=?").run('local:plantadmin');
  f.env.LOCAL_BOOTSTRAP_PASSWORD_HASH = await hashPassword('Changed fixture password', pepper);
  f.env.ADMIN_EMAIL = '';
  assert.equal((await f.login()).status, 401);
  const user = f.sqlite.prepare('SELECT * FROM users WHERE id=?').get('local:plantadmin');
  assert.equal(user.active, 0); assert.equal(user.role, 'viewer'); assert.equal(user.name, 'Existing account');
  assert.equal(f.sqlite.prepare('SELECT password_hash FROM local_credentials').get().password_hash, fixtureHash);
  f.env.LOCAL_BOOTSTRAP_USERNAME = 'SecondAdmin';
  assert.equal((await f.login({ body: { username: 'SecondAdmin', password: 'Changed fixture password' } })).status, 401);
  assert.equal(f.count('users'), 1);
});

test('bootstrap cannot attach credentials to or modify a pre-existing user with the local identifier', async t => {
  const f = fixture(t), stamp = '2026-10-10T12:00:00.000Z';
  f.sqlite.prepare("INSERT INTO users(id,email,name,role,active,created_at,updated_at) VALUES (?,'','Existing','viewer',0,?,?)").run('local:plantadmin', stamp, stamp);
  assert.equal((await f.login()).status, 401);
  assert.equal(f.count('local_credentials'), 0);
  assert.equal(f.sqlite.prepare('SELECT role,active FROM users').get().active, 0);
});

test('live role/active changes invalidate sessions and login respects current RBAC without SSO updates', async t => {
  const f = fixture(t), first = await f.login();
  const owner = await f.repository.authenticate(external, external.email);
  f.advance(1);
  await f.repository.updateUser(owner, 'local:plantadmin', { role: 'viewer' });
  assert.equal((await f.request('/api/admin', { cookie: cookies(first)[0], identity: external })).status, 401);
  const second = await f.login(), session = await f.request('/api/session', { cookie: cookies(second)[0], identity: external });
  assert.equal(session.body.user.role, 'viewer'); assert.equal((await f.request('/api/admin', { cookie: cookies(second)[0] })).status, 403);
  const create = await f.request('/api/models', { method: 'POST', cookie: cookies(second)[0], body: { model: exampleModel() } });
  assert.equal(create.status, 403);
  f.advance(1); await f.repository.updateUser(owner, 'local:plantadmin', { active: false });
  assert.equal((await f.request('/api/session', { cookie: cookies(second)[0], identity: external })).status, 401);
  assert.equal((await f.login()).status, 401);
});

test('no local configuration preserves external SSO and never creates a local account or public registration', async t => {
  const f = fixture(t, { bootstrap: false });
  assert.equal((await f.request('/api/session')).status, 401);
  const session = await f.request('/api/session', { identity: external });
  assert.equal(session.status, 200); assert.equal(session.body.user.role, 'admin'); assert.equal(session.body.signInUrl, '/api/auth/chatgpt');
  assert.equal((await f.login()).status, 401); assert.equal(f.count('local_credentials'), 0);
  assert.equal((await f.request('/api/auth/register', { method: 'POST', body: { username: 'NewUser', password }, identity: external })).status, 404);
  assert.equal(f.count('users'), 1);
});

test('misconfigured bootstrap/pepper fails safely without exposing values or partial provisioning', async t => {
  const f = fixture(t);
  delete f.env.LOCAL_AUTH_PEPPER;
  let result = await f.login(); assert.equal(result.status, 503); assert.equal(f.count('users'), 0);
  f.env.LOCAL_AUTH_PEPPER = pepper; f.env.LOCAL_BOOTSTRAP_PASSWORD_HASH = 'bad secret hash';
  result = await f.login(); assert.equal(result.status, 503); assert.equal(f.count('users'), 0); assert.ok(!JSON.stringify(result.body).includes('bad secret hash'));
});

test('password sign-in permits loopback HTTP for development and requires HTTPS elsewhere', async t => {
  const f = fixture(t);
  assert.equal((await f.login({ urlOrigin: 'http://plant.internal' })).status, 403);
  assert.equal(f.count('users'), 0);
  const login = await f.login({ urlOrigin: 'http://127.0.0.1' });
  assert.equal(login.status, 200); assert.ok(login.headers.getSetCookie()[0].startsWith('openreconcile_session=')); assert.ok(!login.headers.getSetCookie()[0].includes('; Secure'));
});
