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
  form.elements = Object.fromEntries(Object.entries({ connectorType: 'sql', name: '', direction: 'input', connectionId: '', table: '', tagColumn: 'source_name', valueColumn: 'value', timestampColumn: 'recorded_at', aggregation: 'latest', maxAgeMinutes: '60', minCoveragePercent: '100', qualityColumn: '', goodQualityValues: 'Good', badQualityPolicy: 'reject', interpolation: 'step', gapPolicy: 'reject', totalizerReset: 'reject', rolloverValue: '' }).map(([name, value]) => [name, new Node(value)]));
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
  let testHandler = async () => ({ ok: true }), previewHandler = async () => ({ window: { start: '2026-10-10T00:00:00.000Z', end: '2026-10-10T01:00:00.000Z' }, readings: [{ modelName: 'Feed', sourceName: 'FEED', value: 100, unit: 'kg', timestamp: '2026-10-10T00:30:00.000Z' }] });
  const backend = {
    user, workspace,
    permission: id => permissions[id] || {},
    refresh: async () => { calls.push({ kind: 'refresh' }); return refreshHandler(); },
    api: async path => { calls.push({ kind: 'metadata', path }); return metadataHandler(path); },
    sources: async (id, sources, connectorType = 'sql') => { calls.push({ kind: 'save', id, sources, connectorType }); workspace.catalog.sources[id] = workspace.catalog.sources[id].filter(source => source.type !== connectorType).concat(sources); for (const listener of listeners) listener(); return { schedulePaused: false }; },
    sqlTest: async (id, source) => { calls.push({ kind: 'test', id, source }); return testHandler(); },
    sqlPreview: async (id, source, target, period) => { calls.push({ kind: 'preview', id, source, target, period }); return previewHandler(); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const period = { start: '2026-10-10T00:00:00.000Z', end: '2026-10-10T01:00:00.000Z', kind: 'hour' };
  const ui = createSqlConnectors({ backend, beforeOpen: async () => {}, onToast: message => toasts.push(message), periodSelectorFactory: () => ({ refresh() {}, setEnabled() {}, value: () => period }) });
  return { ui, node, form, backend, permissions, calls, toasts,
    notify: () => { for (const listener of listeners) listener(); },
    refreshWith: handler => { refreshHandler = handler; }, metadataWith: handler => { metadataHandler = handler; }, testWith: handler => { testHandler = handler; }, previewWith: handler => { previewHandler = handler; },
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
  assert.deepEqual(f.calls.find(call => call.kind === 'preview').period, { start: '2026-10-10T00:00:00.000Z', end: '2026-10-10T01:00:00.000Z', kind: 'hour' });
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

const piMetadata = () => ({ configured: true, connections: [{ id: 'historian', name: 'Plant historian', canRead: true, canWrite: true,
  inputs: [{ sourceName: 'FEED', unit: 'kg' }], outputs: [{ sourceName: 'FEED', metric: 'mass', unit: 'kg' }] }] });
async function selectPi(f) {
  f.metadataWith(path => path === '/api/pi/connections' ? piMetadata() : { configured: true, connections: [{ id: 'plant', name: 'Plant database', dialect: 'postgres', canRead: true, canWrite: true }] });
  f.form.elements.connectorType.value = 'pi'; await f.form.elements.connectorType.onchange();
}

test('PI source selection hides SQL identifiers, exposes safe aliases, and retains cached connections', async t => {
  const f = setup(t); await f.ui.open(); await selectPi(f);
  assert.equal(f.node('#sql-table-field').hidden, true);
  assert.equal(f.node('#sql-input-column-fields').hidden, true);
  assert.equal(f.node('#sql-quality-column-field').hidden, true);
  assert.equal(f.form.elements.table.required, false);
  assert.equal(f.form.elements.goodQualityValues.readOnly, true);
  assert.match(f.node('#pi-bindings').innerHTML, /FEED/);
  assert.match(f.node('#pi-bindings').innerHTML, /kg/);
  assert.doesNotMatch(f.node('#pi-bindings').innerHTML, /password|bearer|\\\\/);
  f.form.elements.direction.value = 'output'; f.form.elements.direction.onchange();
  assert.equal(f.node('#pi-output-fields').hidden, false);
  assert.equal(f.node('#sql-output-fields').hidden, true);
  assert.equal(f.node('#sql-preview-input').hidden, true);
  assert.match(f.node('#pi-bindings').innerHTML, /mass/);
  f.form.elements.connectorType.value = 'sql'; await f.form.elements.connectorType.onchange();
  assert.equal(f.form.elements.connectionId.value, 'plant');
  assert.equal(f.node('#sql-table-field').hidden, false);
  await selectPi(f);
  assert.equal(f.calls.filter(call => call.path === '/api/pi/connections').length, 1);
});

test('saving PI and SQL sources sends only the selected connector kind and preserves the other registry', async t => {
  const f = setup(t);
  f.backend.workspace.catalog.sources['model-a'] = [{ id: 'sql-existing', name: 'SQL output', type: 'sql', direction: 'output', connectionId: 'plant', table: 'results' }];
  await f.ui.open(); await selectPi(f);
  f.form.elements.name.value = 'PI input';
  f.form.elements.goodQualityValues.value = 'Bad';
  await f.form.onsubmit({ preventDefault() {} });
  const piSave = f.calls.find(call => call.kind === 'save');
  assert.equal(piSave.connectorType, 'pi'); assert.equal(piSave.sources.length, 1);
  assert.equal(piSave.sources[0].type, 'pi'); assert.equal(piSave.sources[0].quality.qualityColumn, 'piQuality');
  assert.deepEqual(piSave.sources[0].quality.goodQualityValues, ['Good']);
  assert.equal(f.backend.workspace.catalog.sources['model-a'].length, 2);
  assert.match(f.node('#sql-source-list').innerHTML, /SQL output/);
  assert.match(f.node('#sql-source-list').innerHTML, /PI input/);
  f.form.elements.connectorType.value = 'sql'; await f.form.elements.connectorType.onchange();
  f.validForm(); await f.form.onsubmit({ preventDefault() {} });
  const sqlSave = f.calls.filter(call => call.kind === 'save').at(-1);
  assert.equal(sqlSave.connectorType, 'sql'); assert.equal(sqlSave.sources.length, 2);
  assert.ok(sqlSave.sources.every(source => source.type === 'sql'));
  assert.equal(f.backend.workspace.catalog.sources['model-a'].filter(source => source.type === 'pi').length, 1);
});

test('unconfigured PI still allows choosing SQL, while locked and revoked access block PI actions', async t => {
  const f = setup(t); await f.ui.open();
  f.metadataWith(() => ({ configured: false, connections: [] }));
  f.form.elements.connectorType.value = 'pi'; await f.form.elements.connectorType.onchange();
  assert.equal(f.node('#pi-setup-note').hidden, false);
  assert.equal(f.node('#sql-setup-note').hidden, true);
  assert.equal(f.form.elements.connectorType.disabled, false);
  assert.equal(f.node('#sql-test-source').disabled, true);
  await f.node('#sql-test-source').onclick(); assert.equal(f.calls.filter(call => call.kind === 'test').length, 0);
  f.metadataWith(() => piMetadata()); await f.node('#sql-refresh').onclick();
  f.form.elements.name.value = 'PI input'; f.permissions['model-a'].canEdit = false; f.notify();
  await f.node('#sql-preview-input').onclick(); assert.equal(f.calls.filter(call => call.kind === 'preview').length, 0);
  assert.equal(f.form.elements.connectorType.disabled, true);
  f.backend.user.role = 'operator'; f.notify(); assert.equal(f.ui.isOpen, false);
});

test('late PI preview cannot populate another model and reopening waits for pending operations', async t => {
  const f = setup(t), gate = deferred(); await f.ui.open(); await selectPi(f);
  f.form.elements.name.value = 'PI input'; f.previewWith(() => gate.promise);
  const preview = f.node('#sql-preview-input').onclick();
  await until(() => f.calls.some(call => call.kind === 'preview'));
  f.node('#sql-model').value = 'model-b'; f.node('#sql-model').onchange();
  gate.resolve({ window: { start: '2026-10-10T00:00:00.000Z', end: '2026-10-10T01:00:00.000Z' }, readings: [{ modelName: 'Late Feed', sourceName: 'FEED', value: 100, unit: 'kg', timestamp: '2026-10-10T00:30:00.000Z' }] });
  await preview;
  assert.equal(f.node('#sql-preview').innerHTML, ''); assert.equal(f.node('#sql-message').textContent, '');
  assert.equal(f.node('#sql-model').value, 'model-b');
});

test('PI metadata loaded after closing the connector page is discarded', async t => {
  const f = setup(t), gate = deferred(); await f.ui.open();
  f.metadataWith(() => gate.promise);
  f.form.elements.connectorType.value = 'pi'; const switching = f.form.elements.connectorType.onchange();
  await until(() => f.calls.some(call => call.path === '/api/pi/connections'));
  f.ui.leave(); gate.resolve(piMetadata()); await switching;
  assert.equal(f.ui.isOpen, false);
  assert.doesNotMatch(f.node('#pi-bindings').innerHTML, /FEED/);
});
