import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashPassword } from '../backend/local-auth.js';
import { openDatabase } from './sqlite.js';

const secretName = 'server-secrets.json';
const workFactor = 600_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export function loadServerSecrets({ dataDir }) {
  let secrets;
  try { secrets = JSON.parse(readFileSync(join(resolve(dataDir), secretName), 'utf8')); }
  catch { throw new Error('Server secrets are missing or invalid. Run the setup command, or restore the matching secrets file with the database.'); }
  if (secrets?.version !== 1 || typeof secrets.localAuthPepper !== 'string' || !/^[a-f0-9]{64}$/.test(secrets.localAuthPepper)) throw new Error('Server secrets are invalid. Restore the matching secrets file; do not replace it.');
  return { version: 1, localAuthPepper: secrets.localAuthPepper };
}

function createSecrets(dataDir) {
  const file = join(resolve(dataDir), secretName);
  if (!existsSync(file)) {
    try { writeFileSync(file, `${JSON.stringify({ version: 1, localAuthPepper: randomBytes(32).toString('hex') }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  chmodSync(file, 0o600);
  return loadServerSecrets({ dataDir });
}

function accountInput({ username, password, name, email = '', role = 'viewer' }) {
  if (typeof username !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{2,63}$/.test(username.trim())) throw new Error('Choose a username beginning with a letter and containing 3–64 letters, numbers, dots, hyphens or underscores.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Choose a password between 12 and 1024 characters.');
  const label = name === undefined ? username.trim() : name;
  if (typeof label !== 'string' || !label.trim() || label.length > 160) throw new Error('Choose an account name between 1 and 160 characters.');
  if (typeof email !== 'string' || email.length > 320 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Enter a valid email address, or leave it blank.');
  if (!['viewer', 'operator', 'editor', 'admin'].includes(role)) throw new Error('Choose viewer, operator, editor or admin for the account role.');
  return { username: username.trim().toLowerCase(), password, name: label.trim(), email: email.trim(), role };
}

function insertAccount(db, account, passwordHash, { firstAdmin = false } = {}) {
  return db.transaction(() => {
    const count = Number(db.raw.prepare('SELECT COUNT(*) AS count FROM users').get().count);
    if (firstAdmin && count !== 0) throw new Error('This installation already has users. Setup cannot reset, promote or replace accounts; use add-user instead.');
    if (!firstAdmin && count === 0) throw new Error('Set up the first administrator before adding users.');
    if (!firstAdmin && account.role !== 'admin' && !db.raw.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1").get()) throw new Error('Restore administrator access by adding a new administrator account before adding ordinary users.');
    const id = `local:${account.username}`, stamp = new Date().toISOString();
    if (db.raw.prepare('SELECT 1 FROM users WHERE id=?').get(id) || db.raw.prepare('SELECT 1 FROM local_credentials WHERE username=?').get(account.username)) throw new Error('That username already exists. Existing accounts are never reset by this command.');
    db.raw.prepare('INSERT INTO users(id,email,name,role,active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(id, account.email, account.name, account.role, stamp, stamp);
    db.raw.prepare('INSERT INTO local_credentials(username,user_id,password_hash,created_at) VALUES(?,?,?,?)').run(account.username, id, passwordHash, stamp);
    db.raw.prepare('INSERT INTO audit_events(id,occurred_at,actor_id,actor_name,category,action,summary,target_id,target_name,changes_json,truncated) VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(randomUUID(), stamp, 'system:local-cli', 'Server account CLI', 'permission', 'account_created', `Created ${account.role} account using the server account CLI.`, id, account.name, JSON.stringify([{ field: 'role', before: null, after: account.role }, { field: 'active', before: null, after: true }]));
    return { id, username: account.username, name: account.name, email: account.email, role: account.role, active: true };
  });
}

export async function setupAdmin({ dataDir, migrationsDir, ...options }) {
  const account = accountInput({ ...options, role: 'admin' });
  const db = openDatabase({ dataDir, migrationsDir });
  try {
    if (db.raw.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new Error('This installation already has users. Setup cannot reset, promote or replace accounts; use add-user instead.');
    const secrets = createSecrets(dataDir);
    const passwordHash = await hashPassword(account.password, secrets.localAuthPepper, { iterations: workFactor });
    return insertAccount(db, account, passwordHash, { firstAdmin: true });
  } finally { db.close(); }
}

export async function addUser({ dataDir, migrationsDir, ...options }) {
  const account = accountInput(options), secrets = loadServerSecrets({ dataDir });
  const db = openDatabase({ dataDir, migrationsDir });
  try {
    const passwordHash = await hashPassword(account.password, secrets.localAuthPepper, { iterations: workFactor });
    return insertAccount(db, account, passwordHash);
  } finally { db.close(); }
}

export async function backupDatabase({ dataDir, backupDir, now = new Date() }) {
  const directory = resolve(dataDir), file = join(directory, 'app.sqlite');
  if (!existsSync(file)) throw new Error('No installation database exists to back up.');
  loadServerSecrets({ dataDir: directory });
  const secretBytes = readFileSync(join(directory, secretName));
  const destination = resolve(backupDir ?? join(directory, 'backups', now.toISOString().replace(/[:.]/g, '-')));
  // The destination itself must be new. An existing backup is never replaced.
  mkdirSync(join(destination, '..'), { recursive: true, mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    raw.exec('PRAGMA busy_timeout=5000');
    if (!raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_openreconcile_migrations'").get()) throw new Error('Refusing to back up an unmanaged database.');
    if (raw.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Database integrity check failed.');
    await backup(raw, join(destination, 'app.sqlite'));
    if (hash(readFileSync(join(directory, secretName))) !== hash(secretBytes)) throw new Error('Server secrets changed during backup. Retry with a new backup directory.');
    writeFileSync(join(destination, secretName), secretBytes, { flag: 'wx', mode: 0o600 });
    chmodSync(join(destination, 'app.sqlite'), 0o600);
    const manifest = { version: 1, createdAt: now.toISOString(), database: 'app.sqlite', secrets: secretName, files: { 'app.sqlite': await fileHash(join(destination, 'app.sqlite')), [secretName]: hash(secretBytes) } };
    writeFileSync(join(destination, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { backupDir: destination, manifest };
  } finally { raw.close(); }
}

export async function verifyBackup({ backupDir }) {
  if (typeof backupDir !== 'string' || !backupDir.trim()) throw new Error('Provide the backup directory to verify.');
  const directory = resolve(backupDir), manifest = JSON.parse(readFileSync(join(directory, 'backup-manifest.json'), 'utf8'));
  if (manifest?.version !== 1 || manifest.database !== 'app.sqlite' || manifest.secrets !== secretName || !manifest.files || ['app.sqlite', secretName].some(file => !/^[a-f0-9]{64}$/.test(manifest.files[file]))) throw new Error('The backup manifest is invalid.');
  for (const file of ['app.sqlite', secretName]) if (await fileHash(join(directory, file)) !== manifest.files[file]) throw new Error(`Backup checksum mismatch: ${file}. Do not restore this backup.`);
  loadServerSecrets({ dataDir: directory });
  const raw = new DatabaseSync(join(directory, 'app.sqlite'), { readOnly: true });
  try {
    if (raw.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || raw.prepare('PRAGMA foreign_key_check').get()) throw new Error('Backup database integrity check failed.');
    if (!raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_openreconcile_migrations'").get()) throw new Error('The backup contains an unmanaged database.');
  } finally { raw.close(); }
  return { backupDir: directory, manifest };
}
