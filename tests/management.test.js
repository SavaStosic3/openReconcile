import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagement } from '../dist/management.js';
import { exampleModel } from '../dist/model.js';
import { createCatalog, addModel, setActiveModel, registerSource, setSchedule } from '../dist/management-store.js';

const CATALOG_KEY = 'openreconcile-model-library-v1';
const START = Date.parse('2026-10-09T12:00:00.000Z');
const clone = value => structuredClone(value);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const seed = () => createCatalog(exampleModel(), { id: 'model-a', now: START });

function setup(t, { initialCatalog, failReads = false, failWrites = false, locks } = {}) {
  const globals = ['document', 'window', 'localStorage', 'navigator', 'Option', 'setInterval', 'clearInterval', 'setTimeout'];
  const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalNow = Date.now;
  const elements = new Map(), controllers = [], timers = new Map();
  const state = { failReads, failWrites };
  const data = new Map(initialCatalog ? [[CATALOG_KEY, JSON.stringify(initialCatalog)]] : []);
  let timerId = 0;
  let document;

  class Element {
    constructor() {
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle(name, force) { const next = force ?? !classes.has(name); next ? classes.add(name) : classes.delete(name); return next; },
        contains: name => classes.has(name)
      };
      this.value = '';
      this.textContent = '';
      this.hidden = true;
      this.disabled = false;
      this.children = [];
      this.details = [];
      this.reviewButtons = [];
      this.innerHTMLWrites = 0;
    }
    setAttribute(name, value) { this[name] = value; }
    replaceChildren(...children) { this.children = children; }
    add(child) { this.children.push(child); }
    addEventListener() {}
    focus() { document.activeElement = this; }
    set innerHTML(value) {
      this.html = value;
      this.innerHTMLWrites++;
      this.details = [...value.matchAll(/<details>/g)].map(() => ({ open: false }));
      this.reviewButtons = [...value.matchAll(/data-review-run="([^"]+)"/g)].map(match => ({ dataset: { reviewRun: match[1] } }));
    }
    get innerHTML() { return this.html || ''; }
    querySelectorAll(selector) { return selector === '[data-review-run]' ? this.reviewButtons : selector === 'details' ? this.details : []; }
  }
  const node = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  document = {
    body: new Element(), hidden: false, activeElement: null,
    querySelector: node,
    querySelectorAll: selector => selector === '[role="tabpanel"]' ? ['#view-model', '#view-data', '#view-results'].map(node) : [],
    addEventListener() {}, removeEventListener() {}
  };
  const values = {
    document,
    window: { addEventListener() {}, removeEventListener() {} },
    localStorage: {
      getItem(key) { if (state.failReads) throw new Error('Storage blocked'); return data.get(key) ?? null; },
      setItem(key, value) { if (state.failWrites) throw new Error('Storage full'); data.set(key, String(value)); }
    },
    navigator: { locks },
    Option: class { constructor(text, value) { this.text = text; this.value = value; this.disabled = false; } },
    setInterval: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id),
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  Date.now = () => START;
  t.after(() => {
    controllers.forEach(controller => controller.destroy());
    Date.now = originalNow;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    node, state, data,
    stored: () => JSON.parse(data.get(CATALOG_KEY)),
    create(options = {}) {
      const controller = createManagement({ fallbackModel: exampleModel(), ...options });
      controllers.push(controller);
      return controller;
    }
  };
}

test('manual reconciliation returns and applies its result when browser storage cannot be read', async t => {
  const env = setup(t, { failReads: true });
  const applied = [], warnings = [];
  const controller = env.create({ onRun: run => applied.push(run), onToast: text => warnings.push(text) });
  const run = await controller.run();
  assert.equal(run.status, 'ok');
  near(run.result.streams.find(stream => stream.id === 'f1').value, 99.4444444444);
  assert.deepEqual(applied, [run]);
  assert.deepEqual(controller.latest(), run);
  assert.ok(warnings.some(text => /Run completed.*storage is unavailable/.test(text)));
  assert.equal(env.data.size, 0);
});

test('manual reconciliation keeps in-memory history and results when writing run history exceeds storage', async t => {
  const env = setup(t, { initialCatalog: seed() });
  const applied = [], warnings = [];
  const controller = env.create({ onRun: run => applied.push(run), onToast: text => warnings.push(text) });
  env.state.failWrites = true;
  const run = await controller.run();
  assert.equal(run.status, 'ok');
  assert.deepEqual(applied, [run]);
  assert.deepEqual(controller.latest(), run);
  assert.equal(env.stored().runs['model-a'].length, 0);
  assert.ok(warnings.some(text => /Export your model and results/.test(text)));
});

test('a stale workbench cannot overwrite a shared-tab rename and reopening permits a fresh edit', async t => {
  const env = setup(t, { initialCatalog: seed() });
  const warnings = [], activated = [];
  const first = env.create({ onToast: text => warnings.push(text), onActivate: entry => activated.push(entry) });
  const reopenFirst = env.node('#menu-workbench').onclick;
  const staleDraft = first.current().model;
  const second = env.create();
  assert.equal(second.saveCurrent({ ...second.current().model, name: 'Remote rename' }), true);
  await first.tick();
  staleDraft.streams[0].value = 110;
  assert.equal(first.saveCurrent(staleDraft), false);
  assert.equal(env.stored().models[0].model.name, 'Remote rename');
  assert.equal(env.stored().models[0].model.streams[0].value, 100);
  assert.equal(staleDraft.streams[0].value, 110);
  assert.ok(warnings.some(text => /changed in another tab.*Export your draft/.test(text)));

  reopenFirst();
  assert.equal(activated.at(-1).model.name, 'Remote rename');
  const freshDraft = clone(activated.at(-1).model);
  freshDraft.streams[0].value = 110;
  assert.equal(first.saveCurrent(freshDraft), true);
  assert.equal(env.stored().models[0].model.name, 'Remote rename');
  assert.equal(env.stored().models[0].model.streams[0].value, 110);
});

test('Run now retains the clicked model while waiting for the browser lock and the selector changes', async t => {
  const original = setActiveModel(addModel(seed(), { ...exampleModel(), name: 'Model B' }, { id: 'model-b', now: START }), 'model-a');
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const lockRequests = [];
  const env = setup(t, { initialCatalog: original, locks: {
    request(name, options, action) { lockRequests.push({ name, options }); return waiting.then(() => action({ name })); }
  } });
  const applied = [];
  const controller = env.create({ onRun: run => applied.push(run) });
  controller.open();
  const clicked = env.node('#schedule-run-now').onclick();
  assert.equal(lockRequests.length, 1);
  env.node('#management-model').value = 'model-b';
  env.node('#management-model').onchange({ target: { value: 'model-b' } });
  release();
  await clicked;
  assert.equal(applied.length, 1);
  assert.equal(applied[0].modelId, 'model-a');
  assert.equal(env.stored().runs['model-a'].length, 1);
  assert.equal(env.stored().runs['model-b'].length, 0);
  assert.equal(env.node('#management-model').value, 'model-b');
  assert.equal(env.node('#schedule-last-run').textContent, 'No runs yet');
  assert.equal(controller.isOpen, true);
});

test('an asynchronous run appends to refreshed shared data without replacing edits made during input loading', async t => {
  let original = registerSource(seed(), 'model-a', { id: 'readings', name: 'Deferred readings', direction: 'input', type: 'deferred' });
  original = setSchedule(original, 'model-a', { inputSourceId: 'readings' }, START);
  const env = setup(t, { initialCatalog: original });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const first = env.create({ inputAdapters: { deferred: async (_source, model) => { await waiting; return model; } } });
  const execution = first.run();
  const second = env.create();
  assert.equal(second.saveCurrent({ ...second.current().model, name: 'Renamed during run' }), true);
  release();
  const run = await execution;
  assert.equal(env.stored().models[0].model.name, 'Renamed during run');
  assert.equal(env.stored().runs['model-a'].length, 1);
  assert.equal(env.stored().runs['model-a'][0].modelSnapshot.name, original.models[0].model.name);
  assert.equal(run.modelSnapshot.name, original.models[0].model.name);
  assert.equal(first.latest(), null);
});

test('unchanged scheduler ticks preserve expanded history details and a new run refreshes history', async t => {
  const env = setup(t, { initialCatalog: seed() });
  const controller = env.create();
  await controller.run();
  controller.open();
  const history = env.node('#management-runs');
  assert.equal(history.details.length, 1);
  const expanded = history.details[0];
  expanded.open = true;
  const writes = history.innerHTMLWrites;
  await controller.tick();
  await controller.tick();
  assert.equal(history.innerHTMLWrites, writes);
  assert.equal(history.details[0], expanded);
  assert.equal(history.details[0].open, true);
  await controller.run();
  assert.equal(history.innerHTMLWrites, writes + 1);
  assert.equal(history.details.length, 2);
});
