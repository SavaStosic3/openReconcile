const QUERY_TIMEOUT_MS = 10_000;

// Each operation leases one connection. Abort destroys it rather than returning
// a query that may still be running to the pool.
function aborted(signal) {
  if (signal?.aborted) throw new Error('Operation cancelled.');
}
function withAbort(promise, signal, cancel) {
  aborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => { try { cancel(); } catch {} reject(new Error('Operation cancelled.')); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}
export function driverOptions(connection) {
  const insecure = connection.allowInsecureLocalDevelopment === true;
  const tls = { rejectUnauthorized: true, ...(connection.tls?.ca ? { ca: connection.tls.ca } : {}) };
  const base = { host: connection.host, port: connection.port, database: connection.database, user: connection.user, password: connection.password };
  if (connection.dialect === 'postgres') return {
    ...base, ssl: insecure ? false : tls, max: 4, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000, statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS, application_name: 'openReconcile SQL gateway',
  };
  if (connection.dialect === 'mysql') return {
    ...base, ssl: insecure ? undefined : tls, connectionLimit: 4, connectTimeout: 5000,
    waitForConnections: true, queueLimit: 8, timezone: 'Z',
    multipleStatements: false, decimalNumbers: false,
  };
  return {
    server: connection.host, port: connection.port, database: connection.database,
    user: connection.user, password: connection.password,
    connectionTimeout: 5000, requestTimeout: QUERY_TIMEOUT_MS,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
    options: { encrypt: !insecure, trustServerCertificate: insecure, useUTC: true,
      abortTransactionOnError: true,
      ...(connection.tls?.ca ? { cryptoCredentialsDetails: { ca: connection.tls.ca } } : {}) },
  };
}
export async function createDriver(connection, imports = {}) {
  const options = driverOptions(connection);
  if (connection.dialect === 'postgres') {
    const imported = imports.pg || await import('pg');
    const pg = imported.default || imported;
    const pool = new pg.Pool(options);
    pool.on?.('error', () => {}); // Driver errors are surfaced by requests, never logged with credentials.
    async function operation(queries, transaction, signal) {
      aborted(signal);
      const acquiring = pool.connect().then(client => {
        if (signal?.aborted) { client.release(true); throw new Error('Operation cancelled.'); }
        return client;
      });
      const client = await withAbort(acquiring, signal, () => {});
      let discarded = false;
      const discard = () => { if (!discarded) { discarded = true; client.release(true); } };
      const query = (sql, params = []) => withAbort(client.query(sql, params), signal, discard);
      try {
        if (transaction) await query('BEGIN');
        const results = [];
        for (const item of queries) { aborted(signal); results.push((await query(item.sql, item.params)).rows); }
        aborted(signal);
        if (transaction) await query('COMMIT');
        return results;
      } catch (error) {
        if (transaction && !discarded) { try { await client.query('ROLLBACK'); } catch { discard(); } }
        throw error;
      } finally { if (!discarded) client.release(); }
    }
    return { query: async (item, signal) => (await operation([item], false, signal))[0],
      transaction: (items, signal) => operation(items, true, signal), close: () => pool.end() };
  }
  if (connection.dialect === 'mysql') {
    const imported = imports.mysql || await import('mysql2/promise');
    const mysql = imported.default || imported;
    const pool = mysql.createPool(options);
    async function operation(queries, transaction, signal) {
      aborted(signal);
      const acquiring = pool.getConnection().then(client => {
        if (signal?.aborted) { client.destroy(); throw new Error('Operation cancelled.'); }
        return client;
      });
      const client = await withAbort(acquiring, signal, () => {});
      let discarded = false;
      const discard = () => { if (!discarded) { discarded = true; client.destroy(); } };
      const query = (sql, params = []) => withAbort(client.execute({ sql, timeout: QUERY_TIMEOUT_MS }, params), signal, discard);
      try {
        if (transaction) await withAbort(client.beginTransaction(), signal, discard);
        const results = [];
        for (const item of queries) { aborted(signal); results.push((await query(item.sql, item.params))[0]); }
        aborted(signal);
        if (transaction) await withAbort(client.commit(), signal, discard);
        return results;
      } catch (error) {
        if (transaction && !discarded) { try { await client.rollback(); } catch { discard(); } }
        // A timed-out MySQL statement may continue server-side; destroy its session.
        if (error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') discard();
        throw error;
      } finally { if (!discarded) client.release(); }
    }
    return { query: async (item, signal) => (await operation([item], false, signal))[0],
      transaction: (items, signal) => operation(items, true, signal), close: () => pool.end() };
  }
  const imported = imports.mssql || await import('mssql');
  const sql = imported.default || imported;
  const pool = new sql.ConnectionPool(options);
  pool.on?.('error', () => {});
  await pool.connect();
  function query(item, target, signal) {
    aborted(signal);
    const request = target.request ? target.request() : new sql.Request(target);
    item.params.forEach((value, i) => {
      const type = value instanceof Date ? sql.DateTime2(3) : typeof value === 'number' ? sql.Float : sql.NVarChar(4000);
      request.input(`p${i}`, type, value);
    });
    return withAbort(request.query(item.sql), signal, () => request.cancel());
  }
  return {
    query: async (item, signal) => (await query(item, pool, signal)).recordset,
    transaction: async (items, signal) => {
      aborted(signal);
      const transaction = new sql.Transaction(pool);
      let rolledBack = false;
      transaction.on?.('rollback', () => { rolledBack = true; });
      await transaction.begin();
      try {
        const results = [];
        for (const item of items) results.push((await query(item, transaction, signal)).recordset);
        aborted(signal);
        await transaction.commit();
        return results;
      } catch (error) {
        if (!rolledBack) { try { await transaction.rollback(); } catch {} }
        throw error;
      }
    },
    close: () => pool.close(),
  };
}
