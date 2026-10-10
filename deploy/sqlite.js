import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultMigrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const ledger = '_openreconcile_migrations';
const owner = Symbol('SQLite statement owner');
const fingerprint = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

function migrationFiles(directory) {
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  if (!files.length) throw new Error('No database migrations were found.');
  const journal = JSON.parse(readFileSync(join(directory, 'meta', '_journal.json'), 'utf8'));
  if (journal.dialect !== 'sqlite' || !Array.isArray(journal.entries)) throw new Error('Invalid SQLite migration journal.');
  const ordered = journal.entries.map((entry, index) => {
    if (entry.idx !== index || !/^[0-9]{4}_[A-Za-z0-9_]+$/.test(entry.tag)) throw new Error('Migrations must have consecutive journal indexes and valid names.');
    const name = `${entry.tag}.sql`;
    const sql = readFileSync(join(directory, name), 'utf8');
    return { name, sql, checksum: fingerprint(sql) };
  });
  if (ordered.length !== files.length || ordered.some((migration, index) => migration.name !== files[index])) throw new Error('Migration files do not match the ordered journal.');
  return ordered;
}

function migrate(raw, directory) {
  const files = migrationFiles(directory);
  // One immediate transaction holds the migration lock across inspection, DDL,
  // and ledger writes. A failed release never records a partially applied file.
  raw.exec('BEGIN IMMEDIATE');
  try {
    const hasLedger = Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(ledger));
    if (!hasLedger && raw.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error('Refusing an unmanaged, nonempty database. Restore an openReconcile backup or use an empty data directory.');
    raw.exec(`CREATE TABLE IF NOT EXISTS ${ledger}(name TEXT PRIMARY KEY NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)`);
    const applied = raw.prepare(`SELECT name,checksum FROM ${ledger} ORDER BY name`).all();
    if (applied.length > files.length || applied.some((row, index) => row.name !== files[index]?.name || row.checksum !== files[index]?.checksum)) throw new Error('Applied migrations differ from this release. Do not edit applied SQL or downgrade the application.');
    for (const migration of files.slice(applied.length)) {
      raw.exec(migration.sql);
      raw.prepare(`INSERT INTO ${ledger}(name,checksum,applied_at) VALUES(?,?,?)`).run(migration.name, migration.checksum, new Date().toISOString());
    }
    if (raw.prepare('PRAGMA foreign_key_check').get()) throw new Error('The database has invalid foreign-key references.');
    raw.exec('COMMIT');
  } catch (error) {
    raw.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase({ dataDir, migrationsDir = defaultMigrations } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('A persistent data directory is required.');
  const directory = resolve(dataDir), file = join(directory, 'app.sqlite');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    try { writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  chmodSync(file, 0o600);
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  let closed = false;
  try {
    raw.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF');
    migrate(raw, migrationsDir);
  } catch (error) { raw.close(); throw error; }
  const ensureOpen = () => { if (closed) throw new Error('The database is closed.'); };
  const identity = {};

  function transaction(fn) {
    ensureOpen();
    if (typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction') throw new Error('SQLite transaction callbacks must be synchronous.');
    raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('SQLite transaction callbacks must be synchronous.');
      raw.exec('COMMIT'); return result;
    } catch (error) { raw.exec('ROLLBACK'); throw error; }
  }
  function prepare(sql, values = []) {
    ensureOpen();
    const statement = raw.prepare(sql);
    const bound = values.map(value => typeof value === 'boolean' ? Number(value) : value);
    const execute = () => {
      ensureOpen();
      if (statement.columns().length) return { results: statement.all(...bound), success: true, meta: { changes: /^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(sql) ? 0 : Number(raw.prepare('SELECT changes() AS count').get().count) } };
      const result = statement.run(...bound);
      return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    };
    return {
      [owner]: identity,
      bind(...next) { return prepare(sql, next); },
      async first(column) {
        ensureOpen(); const row = statement.get(...bound);
        if (!row) return null;
        if (column === undefined) return row;
        if (!Object.hasOwn(row, column)) throw new Error(`Column ${column} does not exist.`);
        return row[column];
      },
      async all() { return execute(); },
      async run() { return execute(); },
      executeSync: execute
    };
  }
  return {
    file, raw, prepare, transaction,
    async batch(statements) {
      if (!Array.isArray(statements) || statements.some(statement => statement?.[owner] !== identity)) throw new Error('A batch requires statements prepared by this database.');
      // No await occurs between BEGIN and COMMIT. SQLite changes() must still
      // refer to the immediately preceding guarded write in the same batch.
      return transaction(() => statements.map(statement => statement.executeSync()));
    },
    close() { if (!closed) { raw.close(); closed = true; } }
  };
}
