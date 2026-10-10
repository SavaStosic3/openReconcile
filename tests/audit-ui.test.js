import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditHistory, auditQuery, auditEventHtml, auditTrendHtml, trendSegments } from '../public/audit-ui.js';
import { connectWorkspace } from '../public/workspace-api.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(condition) { for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(condition()); }
const point = (after, extra = {}) => ({ eventId: String(after), occurredAt: '2026-10-10T12:00:00.000Z', actorName: 'Operator', before: 10, after, unit: 'kg/h', metric: 'massFlow', meterType: 'physical', ...extra });
const event = (id = 'event-1') => ({ id, occurredAt: '2026-10-10T12:00:00.000Z', actor: { id: 'user', name: 'Operator' }, model: { id: 'plant', name: 'Plant' }, category: 'measurement', action: 'measurement.changed', summary: `Feed reading changed (${id})`, changes: [{ itemName: 'Feed', field: 'value', before: 10, after: 20, unit: 'kg/h', previousUnit: 'kg/h' }] });
const response = (events = [event()], extra = {}) => ({ events, nextCursor: null, models: [{ id: 'plant', name: 'Plant', deleted: false }], actors: [{ id: 'user', name: 'Operator' }], settings: { retentionDays: 365, revision: 1, updatedAt: null, updatedBy: null }, ...extra });

class Node {
  constructor(value = '') { this.value = value; this.checked = false; this.hidden = true; this.disabled = false; this.open = false; this.innerHTML = ''; this.textContent = ''; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); const classes = new Set(); this.classList = { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)), contains: value => classes.has(value), toggle: (value, on) => on ? classes.add(value) : classes.delete(value) }; }
  replaceChildren() { this.innerHTML = ''; this.textContent = ''; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
}
function fixture(t, role = 'admin') {
  const nodes = new Map(), listeners = [], calls = [], toasts = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  const doc = { querySelector: node, querySelectorAll: () => [node('#view-model'), node('#view-data')], body: node('body') };
  node('#audit-retention-policy').value = 'days'; node('#audit-retention-days').value = '365';
  node('#audit-filter-form').reset = () => { for (const selector of ['#audit-model', '#audit-actor', '#audit-category', '#audit-from', '#audit-to', '#audit-search']) node(selector).value = ''; };
  let auditHandler = async () => response(), trendHandler = async () => ({ items: [], item: null, points: [], truncated: false, maxPoints: 500 }), settingsHandler = async changes => ({ settings: { ...response().settings, retentionDays: changes.retentionDays, revision: 2 } }), beforeHandler = async () => {};
  const backend = { user: { id: 'user', role, active: true }, workspace: { catalog: { activeId: 'plant', models: [{ id: 'plant', model: { name: 'Plant' } }] }, permissions: { plant: { canView: true } } }, subscribe: listener => { listeners.push(listener); }, audit: async filters => { calls.push({ kind: 'audit', filters }); return auditHandler(filters); }, auditTrends: async filters => { calls.push({ kind: 'trend', filters }); return trendHandler(filters); }, auditSettings: async changes => { calls.push({ kind: 'settings', changes }); return settingsHandler(changes); } };
  const ui = createAuditHistory({ backend, document: doc, beforeOpen: () => beforeHandler(), onToast: message => toasts.push(message) });
  t.after(() => ui.leave());
  return { ui, backend, node, calls, toasts, notify: (reason = 'refresh') => listeners.forEach(listener => listener(reason)), auditWith: callback => { auditHandler = callback; }, trendWith: callback => { trendHandler = callback; }, settingsWith: callback => { settingsHandler = callback; }, beforeWith: callback => { beforeHandler = callback; } };
}

test('audit search encodes text and UTC calendar boundaries without accepting invalid or reversed dates', () => {
  const query = new URLSearchParams(auditQuery({ q: '[Feed] & Source', modelId: 'plant/a', from: '2026-10-10', to: '2026-10-10', cursor: 'cursor+/=' }));
  assert.equal(query.get('q'), '[Feed] & Source'); assert.equal(query.get('modelId'), 'plant/a'); assert.equal(query.get('cursor'), 'cursor+/=');
  assert.equal(query.get('from'), '2026-10-10T00:00:00.000Z'); assert.equal(query.get('to'), '2026-10-11T00:00:00.000Z');
  assert.throws(() => auditQuery({ from: '2026-02-30' }), /valid UTC/); assert.throws(() => auditQuery({ from: '2026-10-12', to: '2026-10-10' }), /end date/);
});

test('audit details escape untrusted names, summaries, and before/after values', () => {
  const html = auditEventHtml({ ...event(), summary: '<script>bad()</script>', actor: { name: '"<img>' }, changes: [{ itemName: '<Feed>', field: 'sourceName', before: '<svg>', after: 'Plant & Feed' }] });
  assert.ok(!html.includes('<script>') && !html.includes('<img>') && !html.includes('<svg>'));
  assert.ok(html.includes('&lt;Feed&gt;') && html.includes('Plant &amp; Feed') && html.includes('Before') && html.includes('After'));
});

test('audit revision labels distinguish model changes from workspace settings', () => {
  const modelHtml = auditEventHtml({ ...event(), revisionBefore: 4, revisionAfter: 5 });
  const settingsHtml = auditEventHtml({ ...event(), model: null, category: 'retention', revisionBefore: 1, revisionAfter: 2 });
  assert.ok(modelHtml.includes('<dt>Model revision</dt>'));
  assert.ok(settingsHtml.includes('<dt>Settings revision</dt>'));
  assert.ok(!settingsHtml.includes('<dt>Model revision</dt>'));
});

test('reading charts break at virtual, missing, unit, and measurement-type transitions', () => {
  const values = [point(10), point(11), point(12, { meterType: 'virtual' }), point(13), point(null), point(14), point(15, { unit: 't/h' }), point(16), point(17, { previousUnit: 't/h' }), point(18), point(19, { metric: 'mass' }), point(20)];
  const series = trendSegments(values);
  assert.equal(series.unit, 'kg/h'); assert.equal(series.metric, 'massFlow');
  assert.deepEqual(series.segments.map(segment => segment.map(reading => reading.after)), [[10, 11], [13], [14], [16], [17, 18], [20]]);
  const html = auditTrendHtml({ item: { name: 'Feed' }, points: values, truncated: true, maxPoints: 500 });
  assert.ok(html.includes('Reading change table') && html.includes('latest 500') && html.includes('edit times'));
  assert.ok(!html.includes('NaN'));
});

test('extreme finite readings and invalid dates never generate nonfinite SVG coordinates', () => {
  const html = auditTrendHtml({ points: [point(-Number.MAX_VALUE, { occurredAt: 'invalid' }), point(Number.MAX_VALUE)] });
  assert.ok(html.includes('<circle')); assert.ok(!/\b(?:NaN|Infinity)\b/.test(html));
});

test('closing while history loads prevents late responses from reopening cached data', async t => {
  const f = fixture(t), gate = deferred(); f.auditWith(() => gate.promise);
  const opening = f.ui.open(); await until(() => f.calls.length === 1); f.ui.leave(); gate.resolve(response()); await opening;
  assert.equal(f.ui.isOpen, false); assert.equal(f.node('#audit-content').hidden, true); assert.equal(f.node('#audit-events').innerHTML, '');
  assert.equal(f.calls.filter(call => call.kind === 'trend').length, 0);
});

test('leaving during the draft barrier cancels a pending history navigation', async t => {
  const f = fixture(t), gate = deferred(); f.beforeWith(() => gate.promise);
  const opening = f.ui.open(); f.ui.leave(); gate.resolve(); await opening;
  assert.equal(f.ui.isOpen, false); assert.equal(f.calls.length, 0);
});

test('new searches supersede old responses, and load-more keeps the applied filters', async t => {
  const f = fixture(t), first = deferred(); let requests = 0;
  f.auditWith(() => ++requests === 1 ? first.promise : response([event('new')], { nextCursor: requests === 2 ? 'next' : null }));
  const opening = f.ui.open(); await until(() => requests === 1);
  f.node('#audit-search').value = 'new filter'; await f.ui.refresh(); first.resolve(response([event('old')])); await opening;
  assert.ok(f.node('#audit-events').innerHTML.includes('new') && !f.node('#audit-events').innerHTML.includes('old'));
  f.node('#audit-search').value = 'not searched yet'; await f.node('#audit-load-more').onclick();
  assert.equal(f.calls.filter(call => call.kind === 'audit').at(-1).filters.q, 'new filter');
  assert.equal(f.calls.filter(call => call.kind === 'audit').at(-1).filters.cursor, 'next');
  assert.equal(f.node('#audit-count').textContent, 1, 'Duplicate page events are not added twice.');
});

test('shorter retention requires explicit confirmation, and indefinite retention saves zero', async t => {
  const f = fixture(t); await f.ui.open();
  f.node('#audit-retention-days').value = '30'; await f.node('#audit-retention-form').onsubmit({ preventDefault() {} });
  assert.equal(f.node('#audit-retention-dialog').open, true); assert.equal(f.calls.filter(call => call.kind === 'settings').length, 0);
  assert.match(f.node('#audit-retention-confirm-description').textContent, /permanently removed/);
  f.node('#audit-retention-cancel').onclick(); assert.equal(f.calls.filter(call => call.kind === 'settings').length, 0);
  await f.node('#audit-retention-form').onsubmit({ preventDefault() {} }); await f.node('#audit-retention-confirm').onclick();
  assert.deepEqual(f.calls.filter(call => call.kind === 'settings')[0].changes, { retentionDays: 30, revision: 1 });
  f.node('#audit-retention-policy').value = 'indefinite'; await f.node('#audit-retention-form').onsubmit({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.kind === 'settings').at(-1).changes.retentionDays, 0);
});

test('non-admin accounts can search their history but cannot change retention', async t => {
  const f = fixture(t, 'viewer'); await f.ui.open();
  assert.equal(f.node('#audit-retention').hidden, true); assert.equal(f.node('#menu-audit').hidden, false);
  f.node('#audit-retention-policy').value = 'indefinite'; await f.node('#audit-retention-form').onsubmit({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.kind === 'settings').length, 0); assert.equal(f.node('#audit-content').hidden, false);
});

test('failed access refresh invalidates earlier trends before they can repopulate the page', async t => {
  const f = fixture(t), trend = deferred(); f.trendWith(() => trend.promise);
  const opening = f.ui.open(); await until(() => f.calls.some(call => call.kind === 'trend'));
  f.auditWith(() => { const error = new Error('Model access unavailable.'); error.status = 403; throw error; });
  await f.ui.refresh(); trend.resolve({ items: [{ id: 'feed', name: 'Feed' }], item: { id: 'feed', name: 'Feed' }, points: [point(999)] }); await opening;
  assert.equal(f.node('#audit-trend-content').innerHTML, ''); assert.equal(f.node('#audit-content').hidden, true);
});

test('grant revocation or admin demotion clears loaded history and pending trends', async t => {
  const f = fixture(t); await f.ui.open();
  assert.ok(f.node('#audit-events').innerHTML.includes('Feed'));
  f.backend.workspace.permissions = {}; f.backend.workspace.catalog.models = []; f.notify();
  assert.equal(f.node('#audit-events').innerHTML, ''); assert.equal(f.node('#audit-trend-content').innerHTML, '');
  assert.equal(f.node('#audit-content').hidden, true); assert.match(f.node('#audit-message').textContent, /access changed/);
  f.backend.user.role = 'viewer'; f.notify(); assert.equal(f.node('#audit-retention').hidden, true);
  f.backend.user.active = false; f.notify('auth'); assert.equal(f.ui.isOpen, false); assert.equal(f.node('#menu-audit').hidden, true);
});

function workspaceFixture(t) {
  const descriptors = new Map(['document', 'fetch', 'location', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const nodes = new Map(), calls = []; let handler = () => null;
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  const document = { querySelector: selector => selector === '#login-form' ? null : node(selector), querySelectorAll: () => [], body: node('body') };
  const state = { user: { id: 'user', name: 'Editor', email: 'editor@example.test', role: 'editor', active: true }, catalog: { activeId: 'plant', models: [{ id: 'plant', model: { name: 'Plant' } }], schedules: {}, sources: {}, runs: {} }, permissions: { plant: { canView: true, canEdit: true, revision: 1 } } };
  const reply = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
  const values = { document, location: { href: 'https://plant.test/', reload() {} }, localStorage: { getItem: () => null, setItem() {} }, fetch: async (path, options = {}) => {
    const call = { path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null }; calls.push(call);
    const custom = handler(call); if (custom) return custom;
    if (path === '/api/session') return reply({ user: state.user });
    if (path === '/api/workspace') return reply(structuredClone(state));
    if (path === '/api/models/plant') { state.permissions.plant.revision++; return reply({ entry: state.catalog.models[0], permission: state.permissions.plant }); }
    return reply(response());
  } };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let controller;
  t.after(() => { controller?.destroy(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { calls, node, reply, handle: callback => { handler = callback; }, async connect() { controller = await connectWorkspace(); calls.length = 0; return controller; } };
}

test('audit reads flush pending measurements and refresh permissions before querying history', async t => {
  const f = workspaceFixture(t), workspace = await f.connect();
  const saved = workspace.queueSave('plant', { name: 'Latest measurement draft' });
  await workspace.audit({ modelId: 'plant', to: '2026-10-10' }); assert.equal(await saved, true);
  assert.deepEqual(f.calls.map(call => call.path.split('?')[0]), ['/api/models/plant', '/api/workspace', '/api/audit']);
  assert.equal(new URLSearchParams(f.calls.at(-1).path.split('?')[1]).get('to'), '2026-10-11T00:00:00.000Z');
});

test('disabled-account audit refresh closes the workspace before querying cached history', async t => {
  const f = workspaceFixture(t), workspace = await f.connect(); f.handle(call => call.path === '/api/workspace' ? f.reply({ error: 'Account disabled.' }, 403) : null);
  await assert.rejects(workspace.audit(), error => error.authUnavailable && error.status === 403);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/workspace']); assert.equal(workspace.user.active, false);
  assert.equal(f.node('#workspace-main').hidden, true); assert.equal(f.node('#auth-screen').hidden, false);
});
