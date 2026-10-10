import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApi } from '../backend/api.js';
import { Repository } from '../backend/repository.js';
import { newStream } from '../public/model.js';
import { describeModelChanges } from '../backend/audit-diff.js';

function model() {
  const result = { version: 1, name: 'Tank verification', periodHours: 1, nodes: [
    { id: 'feed', kind: 'inlet', name: 'Feed', x: 100, y: 250 },
    { id: 'tank', kind: 'tank', name: 'Buffer tank', x: 400, y: 250, inventory: {
      basis: 'mass', unit: 'kg', density: 1000, densityUncertainty: 0, readingCorrelation: 0,
      geometry: { kind: 'verticalCylinder', diameter: 2 }, capacityMass: null,
      opening: { measured: true, value: 100, uncertainty: 1, uncertaintyType: 'absolute' },
      closing: { measured: true, value: 120, uncertainty: 1, uncertaintyType: 'absolute' },
    } },
    { id: 'product', kind: 'outlet', name: 'Product', x: 700, y: 250 },
  ], streams: [newStream('feed', 'tank'), newStream('tank', 'product')] };
  Object.assign(result.streams[0], { id: 'input', measured: true, value: 60, uncertainty: 1, uncertaintyType: 'absolute' });
  Object.assign(result.streams[1], { id: 'output', measured: true, value: 40, uncertainty: 1, uncertaintyType: 'absolute' });
  return result;
}
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of ['0000_complete_random.sql', '0001_published_snapshots.sql', '0002_elite_layla_miller.sql', '0003_kind_tempest.sql']) sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  let serial = 0, tail = Promise.resolve();
  const DB = {
    prepare(sql) { return { values: [], bind(...values) { assert.ok(values.length <= 100); this.values = values; return this; }, async first() { return sqlite.prepare(sql).get(...this.values) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...this.values) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...this.values).changes) } }; } }; },
    batch(statements) { const job = tail.then(async () => { sqlite.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }); tail = job.catch(() => {}); return job; },
  };
  const env = { DB, ADMIN_EMAIL: 'owner@example.test', NOW: () => Date.parse('2026-10-10T13:00:00.000Z'), UUID: () => `storage-${String(++serial).padStart(8, '0')}` };
  const owner = { id: 'owner', email: 'owner@example.test', name: 'Owner' }, viewer = { id: 'viewer', email: 'viewer@example.test', name: 'Viewer' };
  const repository = new Repository(DB, { now: env.NOW, uuid: env.UUID });
  async function request(path, method = 'GET', body, identity = owner) {
    const result = await handleApi(new Request(`https://balance.test${path}`, { method, headers: method === 'GET' ? {} : { Origin: 'https://balance.test', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, identity);
    return { status: result.status, body: await result.json() };
  }
  async function create() { const response = await request('/api/models', 'POST', { model: model() }); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.entry.id; }
  async function save(id, change, identity = owner) { const previous = await repository.model(id), next = structuredClone(previous.model); change(next.nodes[1].inventory); return request(`/api/models/${id}`, 'PATCH', { revision: previous.revision, model: next }, identity); }
  t.after(() => sqlite.close());
  return { sqlite, env, owner, viewer, repository, request, create, save };
}

test('backend retains complete inventory configuration and saves atomic measurement/mapping audit records', async t => {
  const f = fixture(t), id = await f.create();
  assert.deepEqual((await f.repository.model(id)).model.nodes[1].inventory, model().nodes[1].inventory);
  const result = await f.save(id, inventory => { inventory.closing.value = 121; inventory.closing.dataMapping = { sourceName: 'PLANT.TANK.MASS' }; inventory.readingCorrelation = 0.5; });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const history = (await f.request(`/api/audit?modelId=${id}`)).body;
  const reading = history.events.flatMap(event => event.changes).find(change => change.field === 'inventory.closing.value');
  assert.equal(reading.before, 120); assert.equal(reading.after, 121); assert.equal(reading.itemId, 'tank'); assert.equal(reading.unit, 'kg');
  assert.ok(history.events.some(event => event.category === 'mapping' && event.changes.some(change => change.field === 'inventory.closing.sourceName' && change.after === 'PLANT.TANK.MASS')));
  assert.ok(history.events.some(event => event.category === 'measurement' && event.actor.id === 'owner' && event.changes.some(change => change.field === 'inventory.readingCorrelation')));
});

test('inventory writes retain optimistic revision, model lock, permission, and validation guards', async t => {
  const f = fixture(t), id = await f.create(), before = await f.repository.model(id);
  assert.equal((await f.save(id, inventory => { inventory.closing.value = 140; }, f.viewer)).status, 403);
  assert.equal((await f.save(id, inventory => { inventory.geometry.diameter = 0; })).status, 400);
  assert.equal((await f.save(id, inventory => { inventory.closing.value = 121; })).status, 200);
  const stale = structuredClone(before.model); stale.nodes[1].inventory.closing.value = 150;
  assert.equal((await f.request(`/api/models/${id}`, 'PATCH', { model: stale, revision: 1 })).status, 409);
  assert.equal((await f.request(`/api/admin/models/${id}`, 'PATCH', { revision: 2, editLocked: true })).status, 200);
  assert.equal((await f.save(id, inventory => { inventory.closing.value = 150; })).status, 403);
  assert.equal((await f.repository.model(id)).model.nodes[1].inventory.closing.value, 121);
});

test('audit failure rolls back an inventory change in the same database transaction', async t => {
  const f = fixture(t), id = await f.create();
  f.sqlite.exec("CREATE TRIGGER reject_storage_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;");
  const changed = await f.save(id, inventory => { inventory.closing.value = 123; });
  assert.equal(changed.status, 500);
  const stored = await f.repository.model(id); assert.equal(stored.revision, 1); assert.equal(stored.model.nodes[1].inventory.closing.value, 120);
});

test('published inventory inputs remain detached from draft edits and historical run snapshots', async t => {
  const f = fixture(t), id = await f.create();
  assert.equal((await f.request(`/api/models/${id}/publication`, 'PATCH', { published: true, revision: 1 })).status, 200);
  assert.equal((await f.save(id, inventory => { inventory.closing.value = 140; })).status, 200);
  const stored = await f.repository.model(id); assert.equal(stored.publishedModel.nodes[1].inventory.closing.value, 120); assert.equal(stored.model.nodes[1].inventory.closing.value, 140);
  const response = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'published' });
  assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.run.status, 'ok', response.body.run.error);
  assert.equal(response.body.run.modelSnapshot.nodes[1].inventory.closing.value, 120);
  assert.ok(Math.abs(response.body.run.result.inventories[0].accumulation.value - 20) < 1e-8);
  assert.equal((await f.repository.runs(id))[0].modelSnapshot.nodes[1].inventory.closing.value, 120);
});

test('storage runs preserve the existing twenty-run retention cap and do not become edit-history events', async t => {
  const f = fixture(t), id = await f.create(), count = f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  for (let index = 0; index < 21; index++) {
    const response = await f.request(`/api/models/${id}/runs`, 'POST', { trigger: 'manual', target: 'draft' });
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.run.status, 'ok', response.body.run.error);
  }
  assert.equal((await f.repository.runs(id)).length, 20); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, count);
});

test('inventory calibration audit records every changed point and ignores unknown imported metadata', () => {
  const before = model(), after = structuredClone(before), inventory = after.nodes[1].inventory;
  inventory.geometry = { kind: 'calibration', points: Array.from({ length: 100 }, (_, index) => ({ level: index, volume: index * 2 })) };
  inventory.password = 'should-never-be-audited'; inventory.closing.secret = 'neither-should-this';
  const events = describeModelChanges(before, after), fields = events.flatMap(event => event.changes);
  assert.equal(fields.filter(change => change.field.startsWith('inventory.geometry.points[')).length, 200);
  assert.ok(events.every(event => event.changes.length <= 100 && !event.truncated));
  assert.equal(JSON.stringify(events).includes('should-never'), false); assert.equal(JSON.stringify(events).includes('neither-should'), false);
  assert.equal(describeModelChanges(before, structuredClone(before)).length, 0);
});
