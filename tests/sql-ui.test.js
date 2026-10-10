import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqlConnectors } from '../public/sql-ui.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(condition) {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), 'Expected the controller operation to reach its next stage.');
}

// This fixture models form/select state and controllable network completion,
// without testing SVG rendering or substituting a fake database connection.
function setup(t) {
  const descriptors = new Map(['document', 'Option'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const nodes = new Map(), listeners = new Set(), calls = [], toasts = [];
  class Node {
    constructor(value = '') {
      this.value = this.defaultValue = value; this.textContent = ''; this.innerHTML = '';
      this.hidden = true; this.disabled = false; this.required = false;
      this.dataset = {}; this.children = []; this.attributes = new Map(); this.listeners = new Map();
      const classes = new Set();
      this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle: (name, enabled) => { if (enabled) classes.add(name); else classes.delete(name); } };
    }
    replaceChildren(...children) { this.children = children; this.innerHTML = ''; this.textContent = ''; if (children.length && Object.hasOwn(children[0], 'value')) this.value = children[0].value; }
    add(child) { this.children.push(child); }
    focus() { this.focused = true; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, callback) { const list = this.listeners.get(name) || []; list.push(callback); this.listeners.set(name, list); }
    dispatchEvent(event) { for (const callback of this.listeners.get(event.type) || []) callback(event); }
    querySelectorAll() { return []; }
  }
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  const form = node('#sql-source-form');
  form.elements = Object.fromEntries(Object.entries({ name: '', direction: 'input', connectionId: '', table: '', tagColumn: 'source_name', valueColumn: 'value', timestampColumn: 'recorded_at', aggregation: 'latest' }).map(([name, value]) => [name, new Node(value)]));
  form.reset = () => { for (const field of Object.values(form.elements)) field.value = field.defaultValue; };
  form.querySelectorAll = () => [...Object.values(form.elements), node('#sql-save-source'), node('#sql-test-source'), node('#sql-preview-input')];
  node('#sql-preview-target').value = 'draft';
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: node('body'), querySelector: node, querySelectorAll: () => [node('#view-editing'), node('#view-published')] } });
  Object.defineProperty(globalThis, 'Option', { configurable: true, value: class { constructor(text, value) { this.textContent = text; this.value = value; } } });
  t.after(() => { ui.leave(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

  const workspace = { catalog: { activeId: 'model-a', models: [{ id: 'model-a', model: { name: 'Plant A' } }, { id: 'model-b', model: { name: 'Plant B' } }], sources: { 'model-a': [], 'model-b': [] }, schedules: { 'model-a': { inputSourceId: null, outputSourceId: null }, 'model-b': { inputSourceId: null, outputSourceId: null } } } };
  const permissions = { 'model-a': { canEdit: true, published: true }, 'model-b': { canEdit: true, published: false } };
  const user = { role: 'admin', active: true };
  let refreshHandler = async () => {}, metadataHandler = async () => ({ configured: true, connections: [{ id: 'plant', name: 'Plant database', dialect: 'postgres', canRead: true, canWrite: true }] });
  let testHandler = async () => ({ ok: true });
  const backend = {
    user, workspace,
    permission: id => permissions[id] || {},
    refresh: async () => { calls.push({ kind: 'refresh' }); return refreshHandler(); },
    api: async path => { calls.push({ kind: 'metadata', path }); return metadataHandler(); },
    sources: async (id, sources) => { calls.push({ kind: 'save', id, sources }); workspace.catalog.sources[id] = sources; for (const listener of listeners) listener(); return { schedulePaused: false }; },
    sqlTest: async (id, source) => { calls.push({ kind: 'test', id, source }); return testHandler(); },
    sqlPreview: async (id, source, target) => { calls.push({ kind: 'preview', id, source, target }); return { window: { start: '2026-10-10T00:00:00.000Z', end: '2026-10-10T01:00:00.000Z' }, readings: [{ modelName: 'Feed', sourceName: 'FEED', value: 100, unit: 'kg', timestamp: '2026-10-10T00:30:00.000Z' }] }; },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const ui = createSqlConnectors({ backend, beforeOpen: async () => {}, onToast: message => toasts.push(message) });
  return { ui, node, form, backend, permissions, calls, toasts,
    notify: () => { for (const listener of listeners) listener(); },
    refreshWith: handler => { refreshHandler = handler; }, metadataWith: handler => { metadataHandler = handler; }, testWith: handler => { testHandler = handler; },
    validForm: () => { form.elements.name.value = 'Hourly input'; form.elements.table.value = 'mass_readings'; }
  };
}

test('closing during workspace refresh does not fetch connection metadata for an abandoned SQL page', async t => {
  const f = setup(t), gate = deferred(); f.refreshWith(() => gate.promise);
  const opening = f.ui.open(); await until(() => f.calls.some(call => call.kind === 'refresh'));
  f.ui.leave(); gate.resolve(); await opening;
  assert.equal(f.ui.isOpen, false);
  assert.equal(f.calls.filter(call => call.kind === 'metadata').length, 0);
});

test('reopening while old SQL metadata is pending uses the new model and newly fetched connection list', async t => {
  const f = setup(t), first = deferred(); let count = 0;
  f.metadataWith(() => ++count === 1 ? first.promise : { configured: true, connections: [{ id: 'new-plant', name: 'New plant connection', dialect: 'mysql', canRead: true, canWrite: false }] });
  const opening = f.ui.open(); await until(() => count === 1);
  f.ui.leave(); f.backend.workspace.catalog.activeId = 'model-b';
  const reopened = f.ui.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1, 'A second refresh must wait for the abandoned operation to settle.');
  first.resolve({ configured: true, connections: [{ id: 'old-plant', name: 'Old plant connection', dialect: 'postgres', canRead: true, canWrite: true }] });
  await opening; await reopened;
  assert.equal(count, 2);
  assert.equal(f.node('#sql-model').value, 'model-b');
  assert.equal(f.form.elements.connectionId.value, 'new-plant');
  assert.equal(f.node('#sql-preview-target option[value="published"]').disabled, true);
  assert.equal(f.form.elements.table.disabled, false);
});

test('SQL actions remain disabled for missing gateway, locked models, and revoked administrator access', async t => {
  const f = setup(t); f.metadataWith(async () => ({ configured: false, connections: [] }));
  await f.ui.open(); f.validForm(); await f.node('#sql-test-source').onclick();
  assert.equal(f.node('#sql-save-source').disabled, true);
  assert.equal(f.calls.filter(call => call.kind === 'test').length, 0);
  f.metadataWith(async () => ({ configured: true, connections: [{ id: 'plant', name: 'Plant', dialect: 'postgres', canRead: true, canWrite: true }] }));
  await f.node('#sql-refresh').onclick(); f.validForm();
  f.permissions['model-a'].canEdit = false; f.notify();
  await f.node('#sql-test-source').onclick(); await f.node('#sql-preview-input').onclick();
  assert.equal(f.calls.filter(call => ['test', 'preview'].includes(call.kind)).length, 0);
  assert.equal(f.node('#sql-test-source').disabled, true);
  f.backend.user.role = 'operator'; f.notify();
  assert.equal(f.ui.isOpen, false); await f.ui.open();
  assert.match(f.toasts.at(-1), /administrator/);
});

test('connection failures leave saved sources untouched and release controls for a corrected retry', async t => {
  const f = setup(t); await f.ui.open(); f.validForm();
  f.testWith(async () => { throw new Error('The SQL gateway request failed.'); });
  await f.node('#sql-test-source').onclick();
  assert.match(f.node('#sql-message').textContent, /gateway request failed/);
  assert.equal(f.node('#sql-message').classList.contains('is-error'), true);
  assert.equal(f.node('#sql-test-source').disabled, false);
  assert.deepEqual(f.backend.workspace.catalog.sources['model-a'], []);
  assert.equal(f.calls.filter(call => call.kind === 'save').length, 0);
  f.testWith(async () => ({ ok: true })); await f.node('#sql-test-source').onclick();
  assert.match(f.node('#sql-message').textContent, /verified/);
  assert.equal(f.node('#sql-message').classList.contains('is-error'), false);
  assert.equal(f.calls.filter(call => call.kind === 'test').length, 2);
});

test('changing SQL configuration clears readings and verification messages from the previous configuration', async t => {
  const f = setup(t); await f.ui.open(); f.validForm();
  await f.node('#sql-preview-input').onclick();
  assert.match(f.node('#sql-preview').innerHTML, /Feed/);
  assert.match(f.node('#sql-message').textContent, /readings fetched/);
  f.form.elements.table.value = 'different_readings';
  f.form.dispatchEvent({ type: 'input', target: f.form.elements.table });
  assert.equal(f.node('#sql-preview').innerHTML, '');
  assert.equal(f.node('#sql-message').textContent, '');

  await f.node('#sql-preview-input').onclick();
  assert.equal(f.calls.filter(call => call.kind === 'preview').at(-1).source.table, 'different_readings');
  assert.match(f.node('#sql-preview').innerHTML, /Feed/);
  await f.node('#sql-test-source').onclick();
  assert.match(f.node('#sql-message').textContent, /verified/);
  f.form.elements.aggregation.value = 'sum';
  f.form.dispatchEvent({ type: 'change', target: f.form.elements.aggregation });
  assert.equal(f.node('#sql-preview').innerHTML, '');
  assert.equal(f.node('#sql-message').textContent, '');
  assert.deepEqual(f.backend.workspace.catalog.sources['model-a'], []);
  assert.equal(f.calls.filter(call => call.kind === 'save').length, 0);
});
