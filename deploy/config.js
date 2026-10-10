import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { loadServerSecrets } from './accounts.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function validatePublicOrigin(value = 'http://localhost:8080') {
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_ORIGIN must be an absolute HTTP or HTTPS origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== url.origin) {
    throw new Error('PUBLIC_ORIGIN must contain only the HTTP or HTTPS scheme, hostname, and optional port, without a path or trailing slash.');
  }
  if (url.protocol === 'http:' && !LOOPBACK_NAMES.has(url.hostname)) throw new Error('PUBLIC_ORIGIN must use HTTPS except for localhost, 127.0.0.1, or [::1].');
  return url.origin;
}

export async function loadConfig({ env = process.env } = {}) {
  const publicOrigin = validatePublicOrigin(env.PUBLIC_ORIGIN || 'http://localhost:8080');
  const portText = env.PORT || '8080', host = env.HOST || '0.0.0.0';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  if (!isIP(host)) throw new Error('HOST must be a valid IPv4 or IPv6 listening address.');
  const loginIpLimit = env.LOGIN_IP_LIMIT ?? '100';
  if (!/^\d{2,4}$/.test(loginIpLimit) || Number(loginIpLimit) < 20 || Number(loginIpLimit) > 1000) throw new Error('LOGIN_IP_LIMIT must be an integer from 20 to 1000.');
  const schedulerEnabled = env.SCHEDULER_ENABLED ?? 'true';
  if (!['true', 'false'].includes(schedulerEnabled)) throw new Error('SCHEDULER_ENABLED must be true or false.');
  const schedulerPollSeconds = env.SCHEDULER_POLL_SECONDS ?? '5';
  if (!/^[1-9]\d?$/.test(schedulerPollSeconds) || Number(schedulerPollSeconds) > 60) throw new Error('SCHEDULER_POLL_SECONDS must be an integer from 1 to 60.');
  const dataDir = resolve(env.APP_DATA_DIR || resolve(ROOT, 'data'));
  const secrets = await loadServerSecrets({ dataDir });
  const backendEnv = {
    AUTH_MODE: 'password', LOCAL_AUTH_ITERATIONS: 600_000, LOCAL_AUTH_IP_LIMIT: Number(loginIpLimit),
    LOCAL_AUTH_PEPPER: secrets.localAuthPepper,
  };
  if (Boolean(env.SQL_GATEWAY_URL) !== Boolean(env.SQL_GATEWAY_TOKEN)) throw new Error('Configure both SQL_GATEWAY_URL and SQL_GATEWAY_TOKEN, or neither.');
  if (env.SQL_GATEWAY_URL) {
    let gateway;
    try { gateway = new URL(env.SQL_GATEWAY_URL); } catch { throw new Error('SQL_GATEWAY_URL must be a valid HTTPS URL.'); }
    const local = env.SQL_GATEWAY_ALLOW_LOCAL === 'true' && LOOPBACK_NAMES.has(gateway.hostname);
    if ((gateway.protocol !== 'https:' && !(gateway.protocol === 'http:' && local)) || gateway.username || gateway.password || gateway.search || gateway.hash) {
      throw new Error('SQL_GATEWAY_URL must use HTTPS. Explicit local HTTP is supported only for a loopback gateway.');
    }
    if (typeof env.SQL_GATEWAY_TOKEN !== 'string' || env.SQL_GATEWAY_TOKEN.length < 32 || env.SQL_GATEWAY_TOKEN.length > 512 || /\s/.test(env.SQL_GATEWAY_TOKEN)) throw new Error('SQL_GATEWAY_TOKEN must contain 32 to 512 non-whitespace characters.');
    Object.assign(backendEnv, { SQL_GATEWAY_URL: gateway.toString(), SQL_GATEWAY_TOKEN: env.SQL_GATEWAY_TOKEN, ...(local ? { SQL_GATEWAY_ALLOW_LOCAL: 'true' } : {}) });
  }
  return {
    host, port: Number(portText), publicOrigin, dataDir,
    publicDir: resolve(ROOT, 'public'), migrationsDir: resolve(ROOT, 'drizzle'), backendEnv,
    scheduler: { enabled: schedulerEnabled === 'true', pollSeconds: Number(schedulerPollSeconds) },
  };
}
