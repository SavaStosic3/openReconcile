import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../deploy/sqlite.js';
import { setupAdmin, addUser, backupDatabase, verifyBackup, loadServerSecrets } from '../deploy/accounts.js';
import { hiddenPassword } from '../deploy/cli.mjs';
import { verifyPassword } from '../backend/local-auth.js';

const password = 'Test-only strong password 49';
const connections = new Set();
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'openreconcile-database-'));
  t.after(() => {
    for (const db of connections) if (db.file.startsWith(`${root}${sep}`)) { db.close(); connections.delete(db); }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function dbFor(t, dataDir) { const db = openDatabase({ dataDir }); connections.add(db); return db; }
function putUser(db, id = 'local:fixture', role = 'admin') {
  return db.prepare('INSERT INTO users(id,email,name,role,active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').bind(id, '', 'Fixture', role, '2026-10-10T12:00:00.000Z', '2026-10-10T12:00:00.000Z');
}

test('standalone database applies ordered migrations idempotently and persists across reopening', async t => {
  const dataDir = directory(t), db = openDatabase({ dataDir });
  assert.equal(db.raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.raw.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(db.raw.prepare('PRAGMA synchronous').get().synchronous, 2);
  const expectedMigrations = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')).entries.length;
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM _openreconcile_migrations').get().count, expectedMigrations);
  assert.equal((await putUser(db).run()).meta.changes, 1);
  const applied = db.raw.prepare('SELECT * FROM _openreconcile_migrations ORDER BY name').all();
  db.close();
  const reopened = dbFor(t, dataDir);
  assert.deepEqual(reopened.raw.prepare('SELECT * FROM _openreconcile_migrations ORDER BY name').all(), applied);
  assert.equal(await reopened.prepare('SELECT role FROM users WHERE id=?').bind('local:fixture').first('role'), 'admin');
  assert.equal(await reopened.prepare('SELECT id FROM users WHERE id=?').bind('missing').first(), null);
  assert.equal((await reopened.prepare('SELECT * FROM users').all()).results.length, 1);
});

test('standalone migrations refuse unmanaged databases and altered or missing applied SQL', t => {
  const root = directory(t), unmanaged = join(root, 'unmanaged'); mkdirSync(unmanaged);
  const raw = new DatabaseSync(join(unmanaged, 'app.sqlite')); raw.exec('CREATE TABLE company_data(id INTEGER)'); raw.close();
  assert.throws(() => openDatabase({ dataDir: unmanaged }), /unmanaged, nonempty/);
  const source = new URL('../drizzle/', import.meta.url), migrationsDir = join(root, 'migrations'); cpSync(source, migrationsDir, { recursive: true });
  const dataDir = join(root, 'managed'), db = openDatabase({ dataDir, migrationsDir }); db.close();
  const file = join(migrationsDir, '0003_kind_tempest.sql'), content = readFileSync(file, 'utf8');
  writeFileSync(file, `${content}\n-- edited after application\n`);
  assert.throws(() => openDatabase({ dataDir, migrationsDir }), /Applied migrations differ/);
  writeFileSync(file, content.replace(/\r?\n/g, '\r\n'));
  // Checkout newline differences do not invalidate a portable backup.
  openDatabase({ dataDir, migrationsDir }).close();
  rmSync(file);
  assert.throws(() => openDatabase({ dataDir, migrationsDir }), /ENOENT/);
});

test('failed migration release rolls back every schema change and its ledger entries', t => {
  const root = directory(t), migrationsDir = join(root, 'migrations');
  cpSync(new URL('../drizzle/', import.meta.url), migrationsDir, { recursive: true });
  const journalPath = join(migrationsDir, 'meta', '_journal.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const badRelease = `${String(journal.entries.length).padStart(4, '0')}_bad_release`;
  journal.entries.push({ idx: journal.entries.length, tag: badRelease });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(migrationsDir, `${badRelease}.sql`), 'CREATE TABLE partial_release(id INTEGER); INVALID SQL;');
  const dataDir = join(root, 'data');
  assert.throws(() => openDatabase({ dataDir, migrationsDir }), /syntax error/);
  const raw = new DatabaseSync(join(dataDir, 'app.sqlite'));
  assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().count, 0);
  raw.close();
});

test('D1 batches are atomic and changes() audit guards cannot interleave across concurrent calls', async t => {
  const db = dbFor(t, directory(t));
  await assert.rejects(db.batch([putUser(db), db.prepare('INSERT INTO local_credentials(username,user_id,password_hash,created_at) VALUES(?,?,?,?)').bind('broken', 'missing-user', 'invalid', 'now')]), /FOREIGN KEY/);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count'), 0);
  const write = putUser(db);
  const guardedAudit = (id, summary) => db.prepare('INSERT INTO audit_events(id,occurred_at,actor_id,actor_name,category,action,summary,changes_json) SELECT ?,?,?,?,?,?,?,? WHERE changes()>0').bind(id, 'now', 'system:fixture', 'Fixture', 'permission', 'created', summary, '[]');
  const update = db.prepare('UPDATE users SET name=? WHERE id=?').bind('Impossible', 'missing-user');
  const results = await Promise.all([
    db.batch([write, guardedAudit('allowed-audit', 'Allowed')]),
    db.batch([update, guardedAudit('denied-audit', 'Denied')]),
    db.batch([db.prepare('SELECT role FROM users WHERE id=?').bind('local:fixture')])
  ]);
  assert.equal(results[0][0].meta.changes, 1);
  assert.equal(results[1][0].meta.changes, 0);
  assert.equal(results[2][0].results[0].role, 'admin');
  assert.deepEqual((await db.prepare('SELECT id FROM audit_events').all()).results.map(row => row.id), ['allowed-audit']);
  assert.throws(() => db.transaction(async () => {}), /synchronous/);
});

test('batches reject statements from another database and invalid first columns', async t => {
  const root = directory(t), first = dbFor(t, join(root, 'one')), second = dbFor(t, join(root, 'two'));
  await assert.rejects(first.batch([putUser(second)]), /prepared by this database/);
  await assert.rejects(first.prepare('SELECT 1 AS value').first('missing'), /does not exist/);
});

test('first-admin setup creates private per-installation secrets and audited local credentials without resetting accounts', async t => {
  const root = directory(t), dataDir = join(root, 'installation');
  const admin = await setupAdmin({ dataDir, username: 'PlantAdmin', name: 'Plant Administrator', password });
  assert.equal(admin.id, 'local:plantadmin'); assert.equal(admin.role, 'admin');
  const secrets = loadServerSecrets({ dataDir }), secretBytes = readFileSync(join(dataDir, 'server-secrets.json'), 'utf8');
  assert.match(secrets.localAuthPepper, /^[a-f0-9]{64}$/);
  const db = dbFor(t, dataDir), credential = await db.prepare('SELECT password_hash FROM local_credentials').first('password_hash');
  assert.match(credential, /^pbkdf2_sha256_hmac\$600000\$/);
  assert.equal(await verifyPassword(password, credential, secrets.localAuthPepper, { iterations: 600_000 }), true);
  const event = await db.prepare('SELECT * FROM audit_events').first();
  assert.equal(event.actor_id, 'system:local-cli'); assert.equal(event.target_id, admin.id); assert.equal(event.category, 'permission');
  assert.equal(JSON.stringify(event).includes(password), false);
  await db.prepare("UPDATE users SET role='viewer',active=0 WHERE id=?").bind(admin.id).run();
  await assert.rejects(setupAdmin({ dataDir, username: 'PlantAdmin', password: 'Different fixture password 83' }), /already has users/);
  assert.equal(await db.prepare('SELECT password_hash FROM local_credentials').first('password_hash'), credential);
  assert.equal(readFileSync(join(dataDir, 'server-secrets.json'), 'utf8'), secretBytes);
  assert.equal(await db.prepare('SELECT role FROM users').first('role'), 'viewer');
  const other = join(root, 'other'); await setupAdmin({ dataDir: other, username: 'AnotherAdmin', password });
  assert.notEqual(loadServerSecrets({ dataDir: other }).localAuthPepper, secrets.localAuthPepper);
});

test('server account CLI provisioning adds scoped users, rejects duplicates and never includes credentials in audit records', async t => {
  const dataDir = directory(t); await setupAdmin({ dataDir, username: 'PlantAdmin', password });
  const viewer = await addUser({ dataDir, username: 'ViewerOne', password, role: 'viewer', name: 'Control Room' });
  assert.equal(viewer.role, 'viewer');
  const db = dbFor(t, dataDir), before = (await db.prepare('SELECT * FROM local_credentials WHERE username=?').bind(viewer.username).first()).password_hash;
  await assert.rejects(addUser({ dataDir, username: 'ViewerOne', password, role: 'admin' }), /already exists/);
  assert.equal(await db.prepare('SELECT role FROM users WHERE id=?').bind(viewer.id).first('role'), 'viewer');
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM model_grants').first('count'), 0);
  const history = JSON.stringify((await db.prepare('SELECT * FROM audit_events').all()).results);
  assert.equal(history.includes(before), false); assert.equal(history.includes(password), false);
  await assert.rejects(addUser({ dataDir, username: 'BadRole', password, role: 'owner' }), /Choose viewer/);
  await assert.rejects(addUser({ dataDir, username: 'BadPassword', password: 'short' }), /12 and 1024/);
  await db.prepare("UPDATE users SET active=0 WHERE role='admin'").run();
  await assert.rejects(addUser({ dataDir, username: 'OperatorTwo', password, role: 'operator' }), /Restore administrator access/);
  const recovered = await addUser({ dataDir, username: 'ReplacementAdmin', password, role: 'admin' });
  assert.equal(recovered.role, 'admin');
  assert.equal(await db.prepare('SELECT active FROM users WHERE id=?').bind('local:plantadmin').first('active'), 0);
});

test('online SQLite backup captures WAL changes, secrets and a portable database that can be restored without account changes', async t => {
  const root = directory(t), dataDir = join(root, 'original');
  await setupAdmin({ dataDir, username: 'PlantAdmin', password });
  const db = dbFor(t, dataDir);
  await db.prepare("UPDATE users SET name='Latest committed WAL change' WHERE id='local:plantadmin'").run();
  const destination = join(root, 'backup');
  const result = await backupDatabase({ dataDir, backupDir: destination });
  assert.equal(result.manifest.version, 1);
  assert.match(result.manifest.files['app.sqlite'], /^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(join(destination, 'server-secrets.json')), readFileSync(join(dataDir, 'server-secrets.json')));
  assert.deepEqual((await verifyBackup({ backupDir: destination })).manifest, result.manifest);
  await assert.rejects(backupDatabase({ dataDir, backupDir: destination }), /EEXIST/);
  const restoredDir = join(root, 'restored'); mkdirSync(restoredDir);
  for (const file of ['app.sqlite', 'server-secrets.json']) copyFileSync(join(destination, file), join(restoredDir, file));
  const restored = dbFor(t, restoredDir);
  assert.equal(await restored.prepare('SELECT name FROM users').first('name'), 'Latest committed WAL change');
  const credential = await restored.prepare('SELECT password_hash FROM local_credentials').first('password_hash');
  assert.equal(await verifyPassword(password, credential, loadServerSecrets({ dataDir: restoredDir }).localAuthPepper, { iterations: 600_000 }), true);
  assert.equal(await restored.prepare('SELECT COUNT(*) AS count FROM audit_events').first('count'), 1);
  writeFileSync(join(destination, 'server-secrets.json'), `${readFileSync(join(destination, 'server-secrets.json'), 'utf8')} `);
  await assert.rejects(verifyBackup({ backupDir: destination }), /checksum mismatch/);
});

test('lost or corrupt server secrets cannot be regenerated for an existing installation', async t => {
  const dataDir = directory(t); await setupAdmin({ dataDir, username: 'PlantAdmin', password });
  rmSync(join(dataDir, 'server-secrets.json'));
  assert.throws(() => loadServerSecrets({ dataDir }), /missing or invalid/);
  await assert.rejects(setupAdmin({ dataDir, username: 'OtherAdmin', password }), /already has users/);
  await assert.rejects(addUser({ dataDir, username: 'OtherAdmin', password }), /missing or invalid/);
  writeFileSync(join(dataDir, 'server-secrets.json'), '{"version":1,"localAuthPepper":"shared-invalid"}');
  assert.throws(() => loadServerSecrets({ dataDir }), /invalid/);
});

test('password terminal prompts never echo text, preserve UTF-8 chunks and restore terminal state on completion or cancellation', async () => {
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; }, resume() {}, pause() {} });
  let outputText = ''; const output = { isTTY: true, write(text) { outputText += text; } };
  const waiting = hiddenPassword('Hidden password: ', { input, output });
  const unicode = Buffer.from('long passwörd'); input.emit('data', unicode.subarray(0, 11)); input.emit('data', unicode.subarray(11)); input.emit('data', Buffer.from('\r'));
  assert.equal(await waiting, 'long passwörd'); assert.equal(outputText, 'Hidden password: \n'); assert.equal(input.isRaw, false);
  const cancelled = hiddenPassword('Hidden password: ', { input, output }); input.emit('data', Buffer.from('\u0003'));
  await assert.rejects(cancelled, /cancelled/); assert.equal(input.isRaw, false);
  await assert.rejects(hiddenPassword('Password: ', { input: { isTTY: false }, output }), /interactive terminal/);
});
