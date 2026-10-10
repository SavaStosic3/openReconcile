import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { handleAuthenticatedApi } from '../backend/local-auth.js';
import { openDatabase } from './sqlite.js';
import { loadConfig, validatePublicOrigin } from './config.js';
import { createScheduler } from './scheduler.mjs';

const MAX_BODY_BYTES = 2_000_000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
class RequestError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });

function requestPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(raw)) throw new RequestError(400, 'Use a valid application path.');
  const path = raw.split('?')[0];
  if (/%(?:2f|5c|00)/i.test(path)) throw new RequestError(400, 'Use a valid application path.');
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw new RequestError(400, 'Use a valid application path.'); }
  if (decoded.split('/').some(part => part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/.test(decoded)) throw new RequestError(400, 'Use a valid application path.');
  return { path, decoded };
}

async function staticAssets(publicDir) {
  const assets = new Map();
  for (const entry of await readdir(publicDir, { withFileTypes: true })) {
    // Serve only shipped, regular public files. Files outside this directory,
    // hidden files, symlinks, and arbitrary server paths cannot be requested.
    if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name) || !MIME[extname(entry.name)]) continue;
    let body = await readFile(resolve(publicDir, entry.name));
    if (entry.name === 'index.html') body = Buffer.from(body.toString('utf8').replace('<meta name="openreconcile-auth-mode" content="hosted">', '<meta name="openreconcile-auth-mode" content="password">'));
    assets.set(`/${entry.name}`, { body, mime: MIME[extname(entry.name)] });
  }
  if (!assets.has('/index.html')) throw new Error('The application public/index.html file is missing.');
  return assets;
}

function readBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new RequestError(413, 'Choose a request smaller than 2 MB.');
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0, failed = false;
    request.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { failed = true; chunks.length = 0; reject(new RequestError(413, 'Choose a request smaller than 2 MB.')); }
      else chunks.push(chunk);
    });
    request.once('end', () => { if (!failed) resolveBody(size ? Buffer.concat(chunks, size) : undefined); });
    request.once('error', () => reject(new RequestError(400, 'The request could not be read.')));
    request.once('aborted', () => reject(new RequestError(400, 'The request was interrupted.')));
  });
}

async function writeResponse(response, outgoing, method) {
  outgoing.statusCode = response.status;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) outgoing.setHeader(name, value);
  for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
  if (method === 'HEAD' || !response.body) { outgoing.end(); return; }
  await pipeline(Readable.fromWeb(response.body), outgoing);
}

export async function startServer({ config, DB: suppliedDatabase } = {}) {
  config ??= await loadConfig();
  const publicOrigin = validatePublicOrigin(config.publicOrigin);
  const assets = await staticAssets(config.publicDir);
  const DB = suppliedDatabase ?? openDatabase({ dataDir: config.dataDir, migrationsDir: config.migrationsDir });
  try {
    const admin = await DB.prepare("SELECT COUNT(*) AS count FROM local_credentials c JOIN users u ON u.id=c.user_id WHERE u.role='admin' AND u.active=1").first();
    if (!Number(admin?.count)) throw new Error('No active administrator account is configured. Run the installation setup command before starting the server.');
  } catch (error) { if (!suppliedDatabase) DB.close(); throw error; }
  const scheduling = config.scheduler ?? { enabled: true, pollSeconds: 5 };
  const env = { ...config.backendEnv, DB, AUTH_MODE: 'password', LOCAL_AUTH_ITERATIONS: 600_000,
    STANDALONE_SCHEDULER: true, SCHEDULER_ENABLED: scheduling.enabled, SCHEDULER_POLL_SECONDS: scheduling.pollSeconds };
  let scheduler;
  const activeRequests = new Set();
  const server = createServer({ maxHeaderSize: 16_384 }, async (incoming, outgoing) => {
    let completeRequest;
    const completion = new Promise(resolveRequest => { completeRequest = resolveRequest; });
    activeRequests.add(completion);
    try {
      const { path, decoded } = requestPath(incoming.url);
      let response;
      if (path === '/healthz') {
        if (!['GET', 'HEAD'].includes(incoming.method)) response = json({ error: 'That method is not supported.' }, 405);
        else {
          try {
            await DB.prepare('SELECT 1 AS ready').first();
            const state = scheduler?.status();
            response = state?.lastError ? json({ status: 'unavailable' }, 503) : json({ status: 'ok' });
          }
          catch { response = json({ status: 'unavailable' }, 503); }
        }
      } else if (path === '/api' || path.startsWith('/api/')) {
        const body = await readBody(incoming);
        if (body && ['GET', 'HEAD'].includes(incoming.method)) throw new RequestError(400, 'This method does not accept a request body.');
        const request = new Request(`${publicOrigin}${incoming.url}`, { method: incoming.method, headers: incoming.headers, ...(body ? { body } : {}) });
        // This address comes from the accepted TCP socket. Client-provided
        // Cloudflare, OpenAI, and proxy headers never establish identity or IP.
        response = await handleAuthenticatedApi(request, { ...env, LOCAL_CLIENT_IP: incoming.socket.remoteAddress ?? 'missing-socket-address' }, null);
      } else {
        if (!['GET', 'HEAD'].includes(incoming.method)) response = json({ error: 'That method is not supported.' }, 405);
        else {
          const asset = assets.get(decoded === '/' ? '/index.html' : decoded);
          response = asset ? new Response(asset.body, { headers: { 'Content-Type': asset.mime, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS } }) : json({ error: 'That page does not exist.' }, 404);
        }
      }
      await writeResponse(response, outgoing, incoming.method);
    } catch (error) {
      if (outgoing.headersSent || outgoing.destroyed) { outgoing.destroy(); return; }
      const status = error instanceof RequestError ? error.status : 500;
      if (status === 413) { outgoing.setHeader('Connection', 'close'); incoming.resume(); }
      try { await writeResponse(json({ error: error instanceof RequestError ? error.message : 'The request could not be completed.' }, status), outgoing, incoming.method); }
      catch { outgoing.destroy(); }
    } finally {
      activeRequests.delete(completion);
      completeRequest();
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolveListen); });
    scheduler = createScheduler(env, scheduling);
  } catch (error) {
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    if (!suppliedDatabase) DB.close();
    throw error;
  }
  let closing;
  const close = () => closing ??= (async () => {
    const httpClosed = new Promise((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
      server.closeIdleConnections();
    });
    try {
      const outcomes = await Promise.allSettled([httpClosed, scheduler.close()]);
      // A disconnected HTTP client can leave an authorized gateway operation
      // active. Socket closure alone is not permission to close its database.
      await Promise.allSettled([...activeRequests]);
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      if (failure) throw failure.reason;
    }
    finally { if (!suppliedDatabase) DB.close(); }
  })();
  return { server, DB, scheduler, address: server.address(), close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const config = await loadConfig(), running = await startServer({ config });
    console.info(`OpenReconcile is listening at ${config.publicOrigin}.`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      const deadline = setTimeout(() => process.exit(1), 30_000); deadline.unref();
      try { await running.close(); clearTimeout(deadline); process.exit(0); }
      catch { console.error('OpenReconcile could not close cleanly.'); process.exit(1); }
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) {
    console.error(`OpenReconcile could not start: ${error.message}`);
    process.exitCode = 1;
  }
}
