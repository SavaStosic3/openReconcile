import { GatewayError, identifier, stringField } from './contract.js';

function configError() { throw new GatewayError('INVALID_CONFIG', 'Invalid SQL gateway configuration. Check the connection fields and table allowlists.', 500); }
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
export function loadConfig(env = process.env) {
  if (typeof env.SQL_GATEWAY_TOKEN !== 'string' || env.SQL_GATEWAY_TOKEN.length < 32 || env.SQL_GATEWAY_TOKEN.length > 512 || /\s/.test(env.SQL_GATEWAY_TOKEN)) throw new GatewayError('INVALID_CONFIG', 'SQL_GATEWAY_TOKEN must be a secret of 32–512 non-whitespace characters.', 500);
  let parsed;
  try { parsed = JSON.parse(env.SQL_CONNECTIONS_JSON || '[]'); } catch { configError(); }
  if (!Array.isArray(parsed) || parsed.length > 32) configError();
  const ids = new Set();
  const connections = parsed.map(connection => {
    try {
      if (!connection || typeof connection !== 'object' || Array.isArray(connection)) configError();
      const allowed = new Set(['id', 'name', 'dialect', 'host', 'port', 'database', 'user', 'password', 'schema', 'tls', 'allowInsecureLocalDevelopment', 'readableTables', 'writableTables']);
      if (Object.keys(connection).some(key => !allowed.has(key))) configError();
      stringField(connection.id, 'Connection ID', 100);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(connection.id) || ['constructor', 'prototype', '__proto__'].includes(connection.id) || ids.has(connection.id)) configError();
      ids.add(connection.id);
      stringField(connection.name, 'Connection name', 160);
      if (!['postgres', 'sqlserver', 'mysql'].includes(connection.dialect)) configError();
      stringField(connection.host, 'Database host', 253);
      if (!/^[A-Za-z0-9.:-]+$/.test(connection.host)) configError();
      stringField(connection.database, 'Database name', 100);
      stringField(connection.user, 'Database user', 200);
      if (typeof connection.password !== 'string' || !connection.password || connection.password.length > 4096) configError();
      if (connection.schema !== undefined) identifier(connection.schema);
      if (connection.port !== undefined && (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)) configError();
      if (connection.allowInsecureLocalDevelopment !== undefined && typeof connection.allowInsecureLocalDevelopment !== 'boolean') configError();
      if (connection.allowInsecureLocalDevelopment && !LOOPBACK.has(connection.host)) configError();
      if (connection.tls !== undefined && (!connection.tls || typeof connection.tls !== 'object' || Array.isArray(connection.tls) || Object.keys(connection.tls).some(key => key !== 'ca') || (connection.tls.ca !== undefined && (typeof connection.tls.ca !== 'string' || !connection.tls.ca.includes('-----BEGIN CERTIFICATE-----') || connection.tls.ca.length > 65_536)))) configError();
      for (const key of ['readableTables', 'writableTables']) {
        if (!Array.isArray(connection[key]) || connection[key].length > 100 || new Set(connection[key]).size !== connection[key].length) configError();
        connection[key].forEach(table => identifier(table, true));
      }
      return { ...connection, port: connection.port ?? ({ postgres: 5432, sqlserver: 1433, mysql: 3306 })[connection.dialect] };
    } catch { configError(); }
  });
  const port = Number(env.SQL_GATEWAY_PORT ?? 4180);
  const host = env.SQL_GATEWAY_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9.:-]+$/.test(host)) configError();
  return { token: env.SQL_GATEWAY_TOKEN, connections, host, port };
}
export function connectionManifest(connection) {
  return { id: connection.id, name: connection.name, dialect: connection.dialect, canRead: connection.readableTables.length > 0, canWrite: connection.writableTables.length > 0 };
}
