import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagement } from '../public/management.js';
import { exampleModel } from '../public/model.js';
import { createCatalog, addModel, setActiveModel, registerSource, setSchedule } from '../public/management-store.js';

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
      this.controls = [];
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
    querySelectorAll(selector) { return selector === '[data-review-run]' ? this.reviewButtons : selector === 'details' ? this.details : selector === 'input, select, button' ? this.controls : []; }
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

function sharedBackend(catalog) {
  const listeners = new Set();
  const state = {
    catalog: clone(catalog), user: { id: 'editor-user', name: 'Editor', role: 'editor', active: true },
    grants: Object.fromEntries(catalog.models.map(entry => [entry.id, { canView: true, canRun: true, canEdit: true, canSchedule: true, canPublish: false, canUnpublish: true, published: true, editLocked: false, unpublishLocked: false }])),
    flush: async () => {}, selections: []
  };
  state.catalog.models = state.catalog.models.map(entry => ({ publishedModel: clone(entry.model), publishedVersion: 1, publishedAt: new Date(START).toISOString(), hasUnpublishedChanges: false, ...entry }));
  return {
    state,
    get workspace() { return { catalog: clone(state.catalog) }; },
    get user() { return clone(state.user); },
    permission(id) { return clone(state.grants[id] || {}); },
    now: () => START,
    flush: () => state.flush(),
    select(id) { state.selections.push(id); state.catalog.activeId = id; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify(reason = 'policy') { for (const listener of listeners) listener(reason); }
  };
}

function withRun(catalog, modelId, id = 'saved-run') {
  const next = clone(catalog), entry = next.models.find(item => item.id === modelId);
  next.runs[modelId].push({
    id, modelId, trigger: 'manual', status: 'ok', target: 'draft', publishedVersion: null,
    startedAt: new Date(START).toISOString(), finishedAt: new Date(START).toISOString(),
    modelSnapshot: clone(entry.model),
    result: { message: 'Reconciliation completed.', streams: [{ id: 'f1', value: 99.4444444444, status: 'reconciled' }] }
  });
  return next;
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

test('shared saved-run review waits for pending edits before activating its model', async t => {
  const catalog = withRun(setActiveModel(addModel(seed(), { ...exampleModel(), name: 'Model B' }, { id: 'model-b', now: START }), 'model-a'), 'model-b');
  const env = setup(t), backend = sharedBackend(catalog), events = [], reviews = [];
  const controller = env.create({ backend, onActivate: entry => events.push(['activate', entry.id]), onReview: run => { events.push(['review', run.modelId]); reviews.push(run); } });
  await controller.open();
  env.node('#management-model').onchange({ target: { value: 'model-b' } });
  let release;
  const pendingSave = new Promise(resolve => { release = resolve; });
  backend.state.flush = () => pendingSave;
  const reviewing = env.node('#management-runs').reviewButtons[0].onclick();
  assert.equal(controller.isOpen, true);
  assert.equal(controller.activeId, 'model-a');
  assert.deepEqual(backend.state.selections, []);
  assert.deepEqual(reviews, []);

  release();
  await reviewing;
  assert.equal(controller.isOpen, false);
  assert.equal(controller.activeId, 'model-b');
  assert.deepEqual(events, [['activate', 'model-b'], ['review', 'model-b']]);
  assert.equal(reviews[0].id, 'saved-run');
  near(reviews[0].result.streams[0].value, 99.4444444444);
  assert.equal(env.data.has(CATALOG_KEY), false, 'Shared management must not write its models into browser storage.');
});

test('shared saved-run review preserves the current workbench when saving the draft fails', async t => {
  const catalog = withRun(setActiveModel(addModel(seed(), { ...exampleModel(), name: 'Model B' }, { id: 'model-b', now: START }), 'model-a'), 'model-b');
  const env = setup(t), backend = sharedBackend(catalog), activated = [], reviews = [], warnings = [];
  const controller = env.create({ backend, onActivate: entry => activated.push(entry), onReview: run => reviews.push(run), onToast: text => warnings.push(text) });
  await controller.open();
  env.node('#management-model').onchange({ target: { value: 'model-b' } });
  backend.state.flush = async () => { throw new Error('This draft could not be saved. Export it before refreshing.'); };
  await env.node('#management-runs').reviewButtons[0].onclick();
  assert.equal(controller.isOpen, true);
  assert.equal(controller.activeId, 'model-a');
  assert.equal(env.node('#management-model').value, 'model-b');
  assert.deepEqual(backend.state.selections, []);
  assert.deepEqual(activated, []);
  assert.deepEqual(reviews, []);
  assert.ok(warnings.some(text => /draft could not be saved.*Export/.test(text)));
  assert.equal(env.node('#management-runs').reviewButtons.length, 1, 'Saved results must remain available in management.');
});

test('publication controls follow server-granted publication access after permission changes', async t => {
  const env = setup(t), backend = sharedBackend(seed());
  const controller = env.create({ backend });
  await controller.open();
  const button = env.node('#model-publication-button');
  const unpublish = env.node('#model-unpublish-button');
  for (const access of [
    { role: 'viewer', published: false, canPublish: false, canUnpublish: false, hidden: true, unpublishHidden: true, text: 'Publish model' },
    { role: 'operator', published: true, canPublish: false, canUnpublish: false, hidden: true, unpublishHidden: true, text: 'Publish changes' },
    { role: 'editor', published: false, canPublish: true, canUnpublish: false, hidden: false, unpublishHidden: true, text: 'Publish model' },
    { role: 'editor', published: true, canPublish: true, canUnpublish: true, hidden: true, unpublishHidden: false, text: 'Publish changes' },
    { role: 'admin', published: true, canPublish: true, canUnpublish: false, unpublishLocked: true, hidden: true, unpublishHidden: true, text: 'Publish changes' },
    { role: 'editor', published: true, canPublish: true, canUnpublish: true, changes: true, hidden: false, unpublishHidden: false, text: 'Publish changes' }
  ]) {
    backend.state.user.role = access.role;
    Object.assign(backend.state.grants['model-a'], {
      published: access.published, canPublish: access.canPublish, canUnpublish: access.canUnpublish,
      unpublishLocked: access.unpublishLocked || false,
      canRun: access.role !== 'viewer', canEdit: ['editor', 'admin'].includes(access.role),
      canSchedule: access.published && ['editor', 'admin'].includes(access.role)
    });
    backend.state.catalog.models[0].model.name = access.changes ? 'Changed draft' : backend.state.catalog.models[0].publishedModel.name;
    backend.notify();
    assert.equal(button.hidden, access.hidden, `${access.role} publication visibility`);
    assert.equal(button.disabled, access.hidden, `${access.role} publication availability`);
    assert.equal(button.textContent, access.text);
    assert.equal(unpublish.hidden, access.unpublishHidden, `${access.role} unpublish visibility`);
    assert.equal(unpublish.disabled, access.unpublishHidden, `${access.role} unpublish availability`);
    assert.equal(env.node('#model-publication-state').textContent, access.published ? access.changes ? 'Published · draft changes' : 'Published' : 'Draft');
    assert.equal(env.node('#management-open-model').disabled, !backend.state.grants['model-a'].canEdit);
    assert.equal(env.node('#management-view-published').disabled, !access.published);
  }
});

test('losing all shared model access clears publication, schedule, and saved-run details', async t => {
  const scheduled = setSchedule(seed(), 'model-a', { enabled: true, intervalMinutes: 60 }, START);
  const env = setup(t), backend = sharedBackend(withRun(scheduled, 'model-a'));
  const controls = ['#schedule-enabled', '#schedule-interval', '#schedule-unit', '#schedule-input', '#schedule-output', '#schedule-save', '#schedule-run-now'].map(env.node);
  env.node('#schedule-form').controls = controls;
  const controller = env.create({ backend });
  await controller.open();
  assert.equal(env.node('#model-unpublish-button').hidden, false);
  assert.equal(env.node('#schedule-enabled').checked, true);
  assert.equal(env.node('#schedule-summary-frequency').textContent, 'Every 1 hour');
  assert.equal(env.node('#management-runs').reviewButtons.length, 1);

  backend.state.catalog = { version: 1, activeId: null, models: [], schedules: {}, sources: {}, runs: {} };
  backend.state.grants = {};
  backend.notify('refresh');
  assert.equal(controller.activeId, null);
  assert.equal(controller.isOpen, true);
  assert.equal(env.node('#model-publication-button').hidden, true);
  assert.equal(env.node('#model-publication-button').disabled, true);
  assert.equal(env.node('#model-unpublish-button').hidden, true);
  assert.equal(env.node('#model-unpublish-button').disabled, true);
  assert.equal(env.node('#model-publication-state').textContent, 'No model selected');
  assert.equal(env.node('#management-open-model').disabled, true);
  assert.equal(env.node('#management-view-published').disabled, true);
  assert.equal(env.node('#management-duplicate-model').disabled, true);
  assert.ok(controls.every(control => control.disabled));
  assert.equal(env.node('#schedule-enabled').checked, false);
  assert.equal(env.node('#schedule-interval').value, '');
  assert.equal(env.node('#schedule-summary-state').textContent, 'No model selected');
  assert.equal(env.node('#schedule-summary-state').classList.contains('is-enabled'), false);
  for (const field of ['frequency', 'input', 'output']) assert.equal(env.node(`#schedule-summary-${field}`).textContent, '—');
  assert.equal(env.node('#schedule-next-run').textContent, 'No upcoming run');
  assert.equal(env.node('#schedule-last-run').textContent, 'No runs yet');
  assert.equal(env.node('#schedule-input').children[0].text, 'No model selected');
  assert.equal(env.node('#schedule-output').children[0].text, 'No model selected');
  assert.equal(env.node('#schedule-input-help').textContent, '');
  assert.equal(env.node('#schedule-output-help').textContent, '');
  assert.equal(env.node('#management-runs').reviewButtons.length, 0);
  assert.match(env.node('#management-runs').innerHTML, /No model selected/);
});

test('published and editing activation use the same model identity but request distinct pages', async t => {
  const env = setup(t), backend = sharedBackend(seed()), activations = [];
  const controller = env.create({ backend, onActivate: (entry, options) => activations.push({ entry, options }) });
  await controller.activate('model-a', { view: 'published' });
  assert.equal(activations[0].entry.publishedVersion, 1);
  assert.deepEqual(activations[0].options, { view: 'published' });
  await env.node('#menu-workbench').onclick();
  assert.deepEqual(activations[1].options, { view: 'editing' });
  backend.state.catalog.models[0].publishedVersion = 2;
  backend.notify('refresh');
  assert.equal(activations.at(-1).options, undefined, 'An automatic refresh must preserve the current page.');
  assert.equal(controller.current().publishedVersion, 2);
  assert.equal(controller.publishedEntries().length, 1);
  backend.state.grants['model-a'].published = false;
  backend.notify();
  assert.deepEqual(controller.publishedEntries(), []);
});

test('latest published results require their exact publication version and retain latest failures', t => {
  const env = setup(t), backend = sharedBackend(withRun(seed(), 'model-a', 'draft-run'));
  const base = clone(backend.state.catalog.runs['model-a'][0]);
  backend.state.catalog.runs['model-a'].push({ ...base, id: 'published-run', target: 'published', publishedVersion: 1 });
  const controller = env.create({ backend });
  assert.equal(controller.latest('model-a', { target: 'draft' }).id, 'draft-run');
  assert.equal(controller.latest('model-a', { target: 'published' }).id, 'published-run');
  backend.state.catalog.runs['model-a'].push({ ...base, id: 'published-failure', target: 'published', publishedVersion: 1, status: 'failed', result: null, error: 'Input unavailable' });
  backend.notify();
  assert.equal(controller.latest('model-a', { target: 'published' }).id, 'published-failure');
  assert.equal(controller.latest('model-a', { target: 'published' }).result, null);
  backend.state.catalog.models[0].publishedVersion = 2;
  backend.notify();
  assert.equal(controller.latest('model-a', { target: 'published' }), null, 'Identical diagrams at a new version must not borrow the prior publication result.');
  assert.equal(controller.latest('model-a', { target: 'draft' }).id, 'draft-run');
});

test('manual target selection and browser scheduler both send explicit execution targets', async t => {
  const catalog = setSchedule(seed(), 'model-a', { enabled: true, intervalMinutes: 60 }, START - 3_600_000);
  const env = setup(t), backend = sharedBackend(catalog), calls = [];
  backend.execute = async (id, trigger, options) => {
    calls.push({ id, trigger, ...options });
    return { id: `run-${calls.length}`, modelId: id, trigger, ...options, status: 'ok' };
  };
  const controller = env.create({ backend });
  await controller.run('model-a', { target: 'draft' });
  await controller.run('model-a', { target: 'published' });
  await controller.tick();
  assert.deepEqual(calls, [
    { id: 'model-a', trigger: 'manual', target: 'draft' },
    { id: 'model-a', trigger: 'manual', target: 'published' },
    { id: 'model-a', trigger: 'scheduled', target: 'published' }
  ]);
});

test('legacy runs are adopted only by their matching first published snapshot', t => {
  const env = setup(t), backend = sharedBackend(withRun(seed(), 'model-a'));
  delete backend.state.catalog.runs['model-a'][0].target;
  delete backend.state.catalog.runs['model-a'][0].publishedVersion;
  const controller = env.create({ backend });
  assert.equal(controller.latest('model-a', { target: 'draft' }), null);
  assert.equal(controller.latest('model-a', { target: 'published' }).id, 'saved-run');
  backend.state.catalog.models[0].publishedVersion = 2;
  backend.notify();
  assert.equal(controller.latest('model-a', { target: 'published' }), null);
});
