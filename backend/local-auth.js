import { handleApi } from './api.js';
import { ApiError, fields } from './policy.js';
import { localAccountIdentity } from './repository.js';

const SESSION_MS = 8 * 60 * 60 * 1000;
const SIGNED_OUT_SECONDS = 365 * 24 * 60 * 60;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const ITERATIONS = 100_000;
const HASH_SCHEME = 'pbkdf2_sha256_hmac';
const SIGN_IN_URL = '/api/auth/chatgpt';
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const encoder = new TextEncoder();
const reply = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } });
const nowFor = env => typeof env.NOW === 'function' ? env.NOW() : Date.now();
const statement = (env, sql, values = []) => env.DB.prepare(sql).bind(...values);
const changed = result => Number(result?.meta?.changes ?? 0) > 0;
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const random = bytes => crypto.getRandomValues(new Uint8Array(bytes));
const digest = async value => base64(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const normalizeUsername = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._-]{2,63}$/.test(value.trim()) ? value.trim().toLowerCase() : null;

function passwordIterations(value = ITERATIONS) {
  if (![ITERATIONS, 600_000].includes(value)) throw new Error('Unsupported password work factor.');
  return value;
}
const authIterations = env => passwordIterations(env.LOCAL_AUTH_ITERATIONS ?? ITERATIONS);
const signInUrl = env => env.AUTH_MODE === 'password' ? '/?signin=1' : SIGN_IN_URL;

function pepperFor(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 1024) throw new ApiError(503, 'Password sign-in is unavailable. Contact an administrator.');
  return value;
}
function parseHash(value, iterations = ITERATIONS) {
  if (typeof value !== 'string') return null;
  const parts = value.split('$');
  if (parts.length !== 4 || parts[0] !== HASH_SCHEME || parts[1] !== String(iterations) || !/^[A-Za-z0-9_-]{22}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) return null;
  const salt = decode(parts[2]), signature = decode(parts[3]);
  return salt.length === 16 && signature.length === 32 && base64(salt) === parts[2] && base64(signature) === parts[3] ? { salt, signature } : null;
}
async function passwordKey(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations, salt }, key, 256);
}
async function pepperKey(pepper, usages) {
  return crypto.subtle.importKey('raw', encoder.encode(pepperFor(pepper)), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

// Workers production currently caps native PBKDF2 at 100,000 iterations:
// https://github.com/cloudflare/workerd/issues/1346
// A server-only post-KDF HMAC pepper protects hashes if D1 alone is exposed.
// The pepper must be kept separately in the host's secret store.
export async function hashPassword(password, pepper, { iterations = ITERATIONS } = {}) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('Choose a password between 8 and 1024 characters.');
  passwordIterations(iterations);
  const salt = random(16), derived = await passwordKey(password, salt, iterations);
  const signature = await crypto.subtle.sign('HMAC', await pepperKey(pepper, ['sign']), derived);
  return `${HASH_SCHEME}$${iterations}$${base64(salt)}$${base64(signature)}`;
}
export async function verifyPassword(password, serialized, pepper, { iterations = ITERATIONS } = {}) {
  passwordIterations(iterations);
  const parsed = parseHash(serialized, iterations);
  // Unknown/invalid accounts perform the same KDF and native constant-time
  // HMAC verification, then fail without revealing whether a username exists.
  const candidate = parsed ?? { salt: new Uint8Array(16), signature: new Uint8Array(32) };
  const derived = await passwordKey(password, candidate.salt, iterations);
  const valid = await crypto.subtle.verify('HMAC', await pepperKey(pepper, ['verify']), candidate.signature, derived);
  return Boolean(parsed && valid);
}

function cookieNames(request) {
  const secure = new URL(request.url).protocol === 'https:';
  return { secure, session: `${secure ? '__Host-' : ''}openreconcile_session`, suppress: `${secure ? '__Host-' : ''}openreconcile_signed_out` };
}
function cookie(request, name, value, maxAge) {
  const secure = cookieNames(request).secure;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${maxAge}`;
}
function cookieValue(request, name) {
  const matches = (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.split('=')[0] === name);
  return { present: matches.length > 0, value: matches.length === 1 ? matches[0].slice(name.length + 1) : null };
}
function withCookies(response, values) {
  const copy = new Response(response.body, response);
  for (const value of values) copy.headers.append('Set-Cookie', value);
  return copy;
}
async function authBody(request) {
  const origin = new URL(request.url).origin;
  if (request.headers.get('Origin') !== origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'Writes must originate from this application.');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'Send this request as application/json.');
  if (Number(request.headers.get('Content-Length')) > 8192) throw new ApiError(413, 'Choose a request smaller than 8 KB.');
  if (!request.body) throw new ApiError(400, 'A JSON request body is required.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new ApiError(413, 'Choose a request smaller than 8 KB.'); }
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

async function provision(env) {
  if (!env.LOCAL_BOOTSTRAP_USERNAME && !env.LOCAL_BOOTSTRAP_PASSWORD_HASH) return;
  const username = normalizeUsername(env.LOCAL_BOOTSTRAP_USERNAME);
  if (!username || !parseHash(env.LOCAL_BOOTSTRAP_PASSWORD_HASH, authIterations(env))) throw new ApiError(503, 'Password sign-in is unavailable. Contact an administrator.');
  pepperFor(env.LOCAL_AUTH_PEPPER);
  const id = `local:${username}`, stamp = new Date(nowFor(env)).toISOString();
  // D1 batches are atomic. changes() gates credential insertion on the new
  // user insert, so an existing user is never reset, promoted, or re-enabled.
  await env.DB.batch([
    statement(env, "INSERT INTO users(id,email,name,role,active,created_at,updated_at) SELECT ?,'',?,'admin',1,?,? WHERE NOT EXISTS(SELECT 1 FROM local_credentials) AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)", [id, env.LOCAL_BOOTSTRAP_USERNAME.trim(), stamp, stamp, id]),
    statement(env, 'INSERT INTO local_credentials(username,user_id,password_hash,created_at) SELECT ?,id,?,? FROM users WHERE id=? AND changes()=1', [username, env.LOCAL_BOOTSTRAP_PASSWORD_HASH, stamp, id])
  ]);
}
async function attempt(env, key, limit, now) {
  const row = await statement(env, 'INSERT INTO local_login_limits(key,attempts,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING attempts,window_start', [key, now, now - RATE_WINDOW_MS, now - RATE_WINDOW_MS]).first();
  if (row.attempts > limit) throw new ApiError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
}
async function revokeCookieSession(request, env) {
  const { session } = cookieNames(request), token = cookieValue(request, session).value;
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) await statement(env, 'DELETE FROM local_sessions WHERE token_hash=?', [await digest(token)]).run();
}
async function login(request, env) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new ApiError(403, 'Use HTTPS to sign in.');
  const body = await authBody(request);
  fields(body, ['username', 'password'], ['username', 'password']);
  if (typeof body.username !== 'string' || body.username.length > 128 || typeof body.password !== 'string' || body.password.length > 1024) throw new ApiError(400, 'Enter a username and password.');
  pepperFor(env.LOCAL_AUTH_PEPPER);
  const now = nowFor(env), username = normalizeUsername(body.username);
  // Cloudflare supplies/replaces CF-Connecting-IP at the edge. Never trust
  // browser-supplied X-Forwarded-For. Dev/missing-IP requests share one bucket.
  const ip = env.AUTH_MODE === 'password' ? env.LOCAL_CLIENT_IP ?? 'missing-client-ip' : request.headers.get('CF-Connecting-IP') ?? 'missing-edge-ip';
  await attempt(env, `ip:${await digest(ip)}`, env.AUTH_MODE === 'password' ? env.LOCAL_AUTH_IP_LIMIT ?? 20 : 20, now);
  await attempt(env, `user:${await digest(username ?? body.username.trim().toLowerCase())}`, 5, now);
  // Bounded expiry housekeeping prevents abandoned limits/sessions building up.
  await env.DB.batch([
    statement(env, 'DELETE FROM local_login_limits WHERE key IN(SELECT key FROM local_login_limits WHERE window_start<=? ORDER BY window_start LIMIT 100)', [now - RATE_WINDOW_MS]),
    statement(env, 'DELETE FROM local_sessions WHERE token_hash IN(SELECT token_hash FROM local_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 100)', [now])
  ]);
  await provision(env);
  const account = username ? await statement(env, 'SELECT c.password_hash,u.id,u.active,u.updated_at FROM local_credentials c JOIN users u ON u.id=c.user_id WHERE c.username=?', [username]).first() : null;
  const valid = await verifyPassword(body.password, account?.password_hash, env.LOCAL_AUTH_PEPPER, { iterations: authIterations(env) });
  if (!valid || !account?.active) throw new ApiError(401, 'The username or password is incorrect.');
  const token = base64(random(32)), tokenHash = await digest(token);
  await revokeCookieSession(request, env);
  const result = await statement(env, 'INSERT INTO local_sessions(token_hash,user_id,user_updated_at,created_at,expires_at) SELECT ?,u.id,u.updated_at,?,? FROM users u JOIN local_credentials c ON c.user_id=u.id WHERE u.id=? AND u.active=1 AND c.password_hash=?', [tokenHash, now, now + SESSION_MS, account.id, account.password_hash]).run();
  if (!changed(result)) throw new ApiError(401, 'The username or password is incorrect.');
  const names = cookieNames(request);
  return withCookies(reply({ ok: true }), [cookie(request, names.session, token, SESSION_MS / 1000), cookie(request, names.suppress, '', 0)]);
}
async function resolveLocal(request, env) {
  const names = cookieNames(request), stored = cookieValue(request, names.session);
  if (stored.present) {
    if (!stored.value || !/^[A-Za-z0-9_-]{43}$/.test(stored.value)) throw new ApiError(401, 'Sign in to access this workspace.');
    const tokenHash = await digest(stored.value), now = nowFor(env);
    const row = await statement(env, 'SELECT u.id FROM local_sessions s JOIN users u ON u.id=s.user_id JOIN local_credentials c ON c.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND s.user_updated_at=u.updated_at', [tokenHash, now]).first();
    if (!row) { await statement(env, 'DELETE FROM local_sessions WHERE token_hash=?', [tokenHash]).run(); throw new ApiError(401, 'Sign in to access this workspace.'); }
    return { id: row.id, [localAccountIdentity]: true, signInUrl: signInUrl(env), signOutUrl: '/api/auth/logout' };
  }
  if (cookieValue(request, names.suppress).present) throw new ApiError(401, 'Sign in to access this workspace.');
  return null;
}

export async function handleAuthenticatedApi(request, env, externalIdentity) {
  try {
    const path = new URL(request.url).pathname;
    if (path === '/api/auth/chatgpt') {
      if (env.AUTH_MODE === 'password') return reply({ error: 'ChatGPT sign-in is unavailable on this server.' }, 404);
      if (request.method !== 'GET') return reply({ error: 'That method is not supported.' }, 405, { Allow: 'GET' });
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'Sign in from this application.');
      await revokeCookieSession(request, env);
      const names = cookieNames(request);
      return withCookies(new Response(null, { status: 303, headers: { Location: '/signin-with-chatgpt?return_to=%2F', 'Cache-Control': 'no-store' } }), [cookie(request, names.session, '', 0), cookie(request, names.suppress, '', 0)]);
    }
    if (path === '/api/auth/login' || path === '/api/auth/logout') {
      if (request.method !== 'POST') return reply({ error: 'That method is not supported.' }, 405, { Allow: 'POST' });
      if (path.endsWith('/login')) return await login(request, env);
      fields(await authBody(request), [], []);
      await revokeCookieSession(request, env);
      const names = cookieNames(request);
      return withCookies(reply({ ok: true }), [cookie(request, names.session, '', 0), cookie(request, names.suppress, '1', SIGNED_OUT_SECONDS)]);
    }
    const local = await resolveLocal(request, env);
    const identity = local ?? (env.AUTH_MODE === 'password' ? null : externalIdentity);
    const result = await handleApi(request, env, identity);
    if (path === '/api/session' && result.ok) {
      const data = await result.json();
      return reply({ ...data, authMethod: local ? 'password' : 'chatgpt', signInUrl: signInUrl(env), signOutUrl: '/api/auth/logout' });
    }
    return result;
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return reply({ error: error instanceof ApiError ? error.message : 'Sign-in could not be completed. Try again.' }, status, status === 429 ? { 'Retry-After': String(RATE_WINDOW_MS / 1000) } : {});
  }
}
