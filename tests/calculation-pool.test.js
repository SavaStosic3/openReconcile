import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalculationPool } from '../deploy/calculation-pool.mjs';
import { showcaseModel } from '../public/showcase-model.js';
import { storageShowcaseModel } from '../public/storage-showcase-model.js';
import { reconcile } from '../public/solver.js';
import { createCatalog, registerSource, setSchedule } from '../public/management-store.js';
import { executeModelRun } from '../public/schedule-runner.js';

const workerURL = new URL('./helpers/calculation-worker-fixture.mjs', import.meta.url);
const fixture = (t, options = {}) => { const pool = createCalculationPool({ workerURL, ...options }); t.after(() => pool.close()); return pool; };
const cpu = (delayMs, value = 1) => ({ fixture: 'cpu', delayMs, value });
const code = expected => error => error.code === expected;
const waitIdle = async pool => {
  const deadline = Date.now() + 3000;
  while (pool.status().active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pool.status().active, 0);
};

test('worker calculations reproduce both analytical showcase results without mutating inputs', async t => {
  const pool = createCalculationPool(); t.after(() => pool.close());
  for (const model of [showcaseModel(), storageShowcaseModel()]) {
    const before = structuredClone(model);
    assert.deepEqual(await pool.calculate(model), reconcile(model));
    assert.deepEqual(model, before);
  }
});

test('CPU work stays off the event loop and the bounded queue remains FIFO', async t => {
  const pool = fixture(t, { workers: 1, maxQueue: 1 });
  const first = pool.calculate(cpu(250, 1));
  const second = pool.calculate(cpu(0, 2));
  assert.equal(pool.status().active, 1); assert.equal(pool.status().queued, 1);
  await assert.rejects(pool.calculate(cpu(0)), code('CALCULATION_BUSY'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pool.status().active, 1, 'a main-thread timer must run during CPU work');
  assert.equal((await first).value, 1); assert.equal((await second).value, 2);
  await waitIdle(pool);
});

test('execution deadlines terminate workers and later calculations can run', async t => {
  const pool = fixture(t, { timeoutMs: 500 });
  await assert.rejects(pool.calculate(cpu(10_000)), code('CALCULATION_TIMEOUT'));
  await waitIdle(pool);
  assert.equal((await pool.calculate(cpu(0, 3))).value, 3);
});

test('queue deadlines release capacity without starting the expired calculation', async t => {
  const pool = fixture(t, { queueTimeoutMs: 30 });
  const active = pool.calculate(cpu(200));
  await assert.rejects(pool.calculate(cpu(0)), code('CALCULATION_QUEUE_TIMEOUT'));
  assert.equal(pool.status().queued, 0);
  await active;
});

test('queued and running work can be cancelled, including an already aborted signal', async t => {
  const pool = fixture(t), running = new AbortController(), queued = new AbortController();
  const first = pool.calculate(cpu(10_000), { signal: running.signal });
  const second = pool.calculate(cpu(0), { signal: queued.signal });
  const firstRejected = assert.rejects(first, code('CALCULATION_CANCELLED'));
  const secondRejected = assert.rejects(second, code('CALCULATION_CANCELLED'));
  queued.abort(); running.abort();
  await Promise.all([firstRejected, secondRejected]); await waitIdle(pool);
  assert.equal(pool.status().queued, 0);
  await assert.rejects(pool.calculate(cpu(0), { signal: running.signal }), code('CALCULATION_CANCELLED'));
  assert.equal((await pool.calculate(cpu(0))).status, 'ok');
});

test('worker crashes and early exits fail closed and release the slot', async t => {
  const pool = fixture(t);
  for (const mode of ['crash', 'exit']) {
    await assert.rejects(pool.calculate({ fixture: mode }), code('CALCULATION_WORKER_FAILED'));
    await waitIdle(pool);
  }
  assert.equal((await pool.calculate(cpu(0))).status, 'ok');
});

test('shutdown cancels queued and running work, is idempotent, and rejects new work', async t => {
  const pool = fixture(t);
  const first = assert.rejects(pool.calculate(cpu(10_000)), code('CALCULATION_CANCELLED'));
  const second = assert.rejects(pool.calculate(cpu(0)), code('CALCULATION_CANCELLED'));
  await Promise.all([pool.close(), pool.close(), first, second]);
  assert.equal(pool.status().queued, 0); assert.equal(pool.status().active, 0);
  await assert.rejects(pool.calculate(cpu(0)), code('CALCULATION_CANCELLED'));
});

test('timeout failures retain a failed run and never invoke an output adapter', async t => {
  const pool = fixture(t, { timeoutMs: 100 });
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  let catalog = createCatalog(showcaseModel(), { id: 'model-a', now });
  catalog = registerSource(catalog, 'model-a', { id: 'out', name: 'Output fixture', type: 'fixture', direction: 'output' });
  catalog = setSchedule(catalog, 'model-a', { outputSourceId: 'out' }, now);
  let outputs = 0, fenced = 0;
  const { run } = await executeModelRun(catalog, 'model-a', {
    calculate: () => pool.calculate(cpu(10_000)),
    beforeOutput: async () => { fenced++; }, outputAdapters: { fixture: async () => { outputs++; } },
  });
  assert.equal(run.status, 'failed'); assert.equal(run.result, null);
  assert.match(run.error, /Reconciliation failed:.*execution time limit/);
  assert.equal(outputs, 0); assert.equal(fenced, 0);
});

test('calculation bounds reject invalid configuration instead of creating unbounded workers', () => {
  for (const options of [{ workers: 0 }, { workers: 5 }, { maxQueue: 33 }, { maxQueue: -1 }, { timeoutMs: Infinity }, { timeoutMs: 300001 }, { queueTimeoutMs: 0 }]) assert.throws(() => createCalculationPool(options), /limit/);
});
