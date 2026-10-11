import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { OUTPUT_COLUMNS, validateWrite } from '../connectors/sql-gateway/src/contract.js';

// These exercise the supplied CHECK predicates and keys in SQLite. Dialect
// qualifiers, engine/charset syntax and known binary collations are normalized.
// Explicit native binary collations map to SQLite BINARY. Missing identity
// collations map to NOCASE, simulating an inherited insensitive DB default;
// that makes lost identity sensitivity fail semantic tests rather than pass
// accidentally under SQLite's own binary default. Predicates and keys remain.
// This does not prove PostgreSQL/MySQL/SQL Server driver or server behavior.
function database(t, dialect) {
  const source = readFileSync(new URL(`../connectors/sql-gateway/schema/${dialect}.sql`, import.meta.url), 'utf8');
  const ddl = source.match(/CREATE TABLE (?:public|production|dbo)\.reconciliation_results\s*\([\s\S]*?\)(?: ENGINE = InnoDB)?;/)?.[0];
  assert.ok(ddl, `${dialect}: result DDL must be present`);
  const normalized = ddl.replace(/CREATE TABLE (?:public|production|dbo)\./, 'CREATE TABLE ').replace(/ ENGINE = InnoDB(?=;)/, '')
    .replace(/CHARACTER SET utf8mb4\s+/g, '')
    .replace(/COLLATE (?:utf8mb4_bin|Latin1_General_100_BIN2|"C")/g, 'COLLATE BINARY')
    .replace(/^(\s+(?:run_id|model_id|item_id)\s+[^\r\n]+)$/gm, line => /\bCOLLATE\b/.test(line) ? line : line.replace('NOT NULL', 'COLLATE NOCASE NOT NULL'));
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(normalized);
  const insert = sqlite.prepare(`INSERT INTO reconciliation_results (${OUTPUT_COLUMNS.join(',')}) VALUES (${OUTPUT_COLUMNS.map(() => '?').join(',')})`);
  t.after(() => sqlite.close());
  return { sqlite, insert: row => insert.run(...OUTPUT_COLUMNS.map(column => row[column])) };
}
const base = { run_id: 'run', model_id: 'model', model_name: 'Plant', published_version: 1, item_id: 'tank', item_type: 'unit', source_name: 'TANK', metric: 'opening_inventory', value_kg: 100, raw_kg: 101, correction_kg: -1, uncertainty_kg: 1, status: 'reconciled', batch_start: '2026-10-10T12:00:00.000Z', batch_end: '2026-10-10T13:00:00.000Z', finished_at: '2026-10-10T13:00:01.000Z' };

for (const dialect of ['postgres', 'mysql', 'sqlserver']) {
  test(`${dialect} supplied output CHECK predicates accept inventory endpoints and signed accumulation`, t => {
    const f = database(t, dialect);
    for (const metric of ['incoming_mass', 'outgoing_mass', 'opening_inventory', 'closing_inventory', 'accumulation']) {
      const row = { ...base, metric, value_kg: metric === 'accumulation' ? -20 : 100, raw_kg: metric === 'accumulation' ? -21 : 101 };
      assert.equal(validateWrite({ table: 'results', rows: [row] }, { writableTables: ['results'] }).length, 1);
      assert.equal(f.insert(row).changes, 1);
    }
    assert.equal(f.insert({ ...base, item_id: 'empty-tank', value_kg: 0, raw_kg: 0 }).changes, 1);
    assert.equal(f.insert({ ...base, item_id: 'filled-tank', metric: 'accumulation', value_kg: 20, raw_kg: 21 }).changes, 1);
    for (const status of ['measured', 'estimated', 'measured_questionable', 'estimated_questionable']) assert.equal(f.insert({ ...base, item_id: status, item_type: 'stream', metric: 'mass', status }).changes, 1);
    assert.equal(f.insert({ ...base, item_id: 'questionable-tank', status: 'reconciled_questionable' }).changes, 1);
  });

  test(`${dialect} supplied output CHECK predicates reject negative flows/stocks and unsupported item metrics or statuses`, t => {
    const f = database(t, dialect);
    for (const metric of ['incoming_mass', 'outgoing_mass', 'opening_inventory', 'closing_inventory']) assert.throws(() => f.insert({ ...base, metric, value_kg: -1 }), /CHECK constraint/);
    assert.throws(() => f.insert({ ...base, item_type: 'stream', metric: 'mass', status: 'measured', value_kg: -1 }), /CHECK constraint/);
    for (const change of [
      { item_type: 'stream', metric: 'accumulation', status: 'measured', value_kg: -1 },
      { item_type: 'unit', metric: 'unknown' },
      { item_type: 'unknown', metric: 'accumulation', value_kg: -1 },
      { item_type: 'unit', metric: 'mass' },
      { item_type: 'stream', metric: 'opening_inventory', status: 'measured' },
      { item_type: 'unit', status: 'measured' },
      { item_type: 'stream', metric: 'mass', status: 'reconciled' },
      { item_type: 'unit', metric: 'accumulation', value_kg: -1, status: 'unobservable' },
    ]) assert.throws(() => f.insert({ ...base, ...change }), /CHECK constraint/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM reconciliation_results').get().n, 0);
  });

  test(`${dialect} supplied output DDL retains nonempty periods, required values, and unique result identity`, t => {
    const f = database(t, dialect);
    assert.throws(() => f.insert({ ...base, batch_end: base.batch_start }), /CHECK constraint/);
    assert.throws(() => f.insert({ ...base, batch_end: '2026-10-10T11:00:00.000Z' }), /CHECK constraint/);
    assert.throws(() => f.insert({ ...base, value_kg: null }), /NOT NULL constraint/);
    assert.throws(() => f.insert({ ...base, item_type: null }), /NOT NULL constraint/);
    assert.equal(f.insert(base).changes, 1);
    assert.throws(() => f.insert(base), /UNIQUE constraint/);
  });

  test(`${dialect} supplied identity columns distinguish case, accents and Unicode normalization`, t => {
    const f = database(t, dialect);
    const rows = [
      { ...base, run_id: 'Run-A', model_id: 'Model-A', item_id: 'F1' },
      { ...base, run_id: 'Run-A', model_id: 'Model-A', item_id: 'f1' },
      { ...base, run_id: 'run-a', model_id: 'model-a', item_id: 'F1' },
      ...['e', '\u00e9', 'e\u0301'].map(item_id => ({ ...base, run_id: 'Unicode', item_id })),
    ];
    assert.equal(validateWrite({ table: 'results', rows: rows.slice(0, 2) }, { writableTables: ['results'] }).length, 2);
    for (const row of rows) assert.equal(f.insert(row).changes, 1);
    assert.throws(() => f.insert(rows[0]), /UNIQUE constraint/);
    const count = (column, value) => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM reconciliation_results WHERE ${column} = ?`).get(value).n;
    assert.equal(count('run_id', 'Run-A'), 2); assert.equal(count('run_id', 'run-a'), 1);
    assert.equal(count('model_id', 'Model-A'), 2); assert.equal(count('model_id', 'model-a'), 1);
    assert.equal(count('item_id', 'F1'), 2); assert.equal(count('item_id', 'f1'), 1);
    for (const id of ['e', '\u00e9', 'e\u0301']) assert.equal(count('item_id', id), 1);
  });
}
