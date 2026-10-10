import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryEntries, createModelGallery } from '../public/model-gallery.js';
import { exampleModel } from '../public/model.js';

const snapshot = (name, unitName = 'Feed mixer') => {
  const model = exampleModel();
  model.name = name;
  model.nodes.find(node => node.id === 'mix').name = unitName;
  return model;
};

function fixture() {
  const models = [
    { id: 'transfer', model: snapshot('Transfer draft', 'Draft pump'), publishedModel: snapshot('Transfer operations', 'Published mixer'), publishedVersion: 3, publishedAt: '2026-10-10T12:00:00.000Z', hasUnpublishedChanges: true },
    { id: 'filtration', model: snapshot('Filtration'), publishedModel: snapshot('Filtration'), publishedVersion: 2, hasUnpublishedChanges: false },
    { id: 'draft-only', model: snapshot('New production line'), publishedModel: null, publishedVersion: 0 },
    { id: 'unpublished', model: snapshot('Retired line draft'), publishedModel: snapshot('Retired publication'), publishedVersion: 1 },
    { id: 'private', model: snapshot('Restricted process draft'), publishedModel: snapshot('Restricted operations'), publishedVersion: 1 }
  ];
  const grants = {
    transfer: { canView: true, canEdit: true, canRun: true, published: true, editLocked: false },
    filtration: { canView: true, canEdit: false, canRun: false, published: true, editLocked: true },
    'draft-only': { canView: true, canEdit: true, published: false },
    unpublished: { canView: true, canEdit: false, published: false },
    private: { canView: false, canEdit: false, published: true }
  };
  return { catalog: { version: 1, activeId: 'draft-only', models, schedules: {}, sources: {}, runs: {} }, grants, permission: id => grants[id] || {} };
}

test('published gallery includes only accessible active publications and preserves model identity', () => {
  const { catalog, permission } = fixture();
  const entries = galleryEntries(catalog, permission, 'published');
  assert.deepEqual(entries.map(entry => entry.id), ['transfer', 'filtration']);
  assert.equal(entries[0].entry.publishedVersion, 3);
  assert.equal(entries[0].name, 'Transfer operations');
  assert.equal(entries[0].model.nodes.find(node => node.id === 'mix').name, 'Published mixer');
  assert.equal(entries[0].model, catalog.models[0].publishedModel);
  assert.notEqual(entries[0].model, catalog.models[0].model);
  assert.equal(entries[0].entry.id, 'transfer');
});

test('editing gallery uses each draft while retaining visible read-only and locked models', () => {
  const { catalog, permission } = fixture();
  const entries = galleryEntries(catalog, permission, 'editing');
  assert.deepEqual(entries.map(entry => entry.id), ['transfer', 'filtration', 'draft-only', 'unpublished']);
  assert.equal(entries[0].name, 'Transfer draft');
  assert.equal(entries[0].model.nodes.find(node => node.id === 'mix').name, 'Draft pump');
  assert.equal(entries[0].model, catalog.models[0].model);
  assert.equal(entries[1].permission.canEdit, false);
  assert.equal(entries[1].permission.editLocked, true);
  assert.equal(entries[1].permission.canRun, false);
  assert.equal(entries[3].permission.published, false);
});

test('published search uses the publication name rather than unpublished draft edits', () => {
  const { catalog, permission } = fixture();
  assert.deepEqual(galleryEntries(catalog, permission, 'published', '  TRANSFER OPERATIONS  ').map(entry => entry.id), ['transfer']);
  assert.deepEqual(galleryEntries(catalog, permission, 'published', 'Transfer draft'), []);
  assert.deepEqual(galleryEntries(catalog, permission, 'editing', 'Transfer draft').map(entry => entry.id), ['transfer']);
  assert.deepEqual(galleryEntries(catalog, permission, 'editing', 'Transfer operations'), []);
});

test('search cannot expose inaccessible models or an inactive publication snapshot', () => {
  const { catalog, permission } = fixture();
  for (const view of ['published', 'editing']) assert.deepEqual(galleryEntries(catalog, permission, view, 'Restricted'), []);
  assert.deepEqual(galleryEntries(catalog, permission, 'published', 'Retired'), []);
  assert.deepEqual(galleryEntries(catalog, permission, 'editing', 'Retired').map(entry => entry.id), ['unpublished']);
});

test('a publication flag without a snapshot and a snapshot without active publication do not make published cards', () => {
  const { catalog, grants, permission } = fixture();
  grants['draft-only'].published = true;
  grants.unpublished.canRun = true;
  assert.deepEqual(galleryEntries(catalog, permission, 'published').map(entry => entry.id), ['transfer', 'filtration']);
});

test('refreshed per-model grants govern gallery membership even when the active model loses access', () => {
  const { catalog, grants, permission } = fixture();
  catalog.activeId = 'transfer';
  grants.transfer = { ...grants.transfer, canView: false };
  delete grants.filtration;
  assert.deepEqual(galleryEntries(catalog, permission, 'published'), []);
  assert.deepEqual(galleryEntries(catalog, permission, 'editing').map(entry => entry.id), ['draft-only', 'unpublished']);
  grants.private.canView = true;
  assert.deepEqual(galleryEntries(catalog, permission, 'published').map(entry => entry.id), ['private']);
});

test('gallery queries leave draft, publication, permissions, and active model unchanged', () => {
  const { catalog, grants, permission } = fixture();
  const before = structuredClone({ catalog, grants });
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(catalog); freeze(grants);
  galleryEntries(catalog, permission, 'published', 'transfer');
  galleryEntries(catalog, permission, 'editing', 'filtration');
  assert.deepEqual({ catalog, grants }, before);
});

test('empty, unavailable, or unsupported gallery views have no candidates', () => {
  const { catalog, permission } = fixture();
  for (const missing of [null, {}, { models: null }, { models: [] }]) assert.deepEqual(galleryEntries(missing, permission, 'editing'), []);
  assert.deepEqual(galleryEntries(catalog, () => ({}), 'editing'), []);
  assert.deepEqual(galleryEntries(catalog, permission, 'results'), []);
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.dataset = {}; this.listeners = new Map();
    this.value = ''; this.hidden = false; this.disabled = false; this.ownText = '';
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Gallery model data must be rendered with DOM text nodes.'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.ownText = ''; this.children = []; this.append(...children); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name, target = this) { this.listeners.get(name)?.({ target }); }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  matches(selector) { return selector === 'button[data-gallery-open]' && this.tagName === 'BUTTON' && this.dataset.galleryOpen !== undefined; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  focus() { this.focused = true; }
}

function uiFixture(t, options = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nodes = new Map(), data = fixture(), calls = [], toasts = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const document = { querySelector: node, createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag), createTextNode: text => { const child = new Element('#text'); child.textContent = text; return child; }, body: node('body') };
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  const backend = { workspace: { catalog: data.catalog }, user: { role: options.role || 'editor' }, permission: data.permission };
  const ui = createModelGallery({ backend, onOpen: async (view, id) => { calls.push({ view, id }); return options.onOpen?.(view, id); }, onCreate: async () => { calls.push({ create: true }); return options.onCreate?.(); }, onToast: text => toasts.push(text) });
  t.after(() => { ui.leave(); if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
  return { ...data, ui, node, calls, toasts, backend, buttons: () => node('#gallery-grid').querySelectorAll('button[data-gallery-open]'), click: button => node('#gallery-grid').dispatch('click', button.children[0]) };
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(condition) { for (let index = 0; index < 100 && !condition(); index++) await new Promise(resolve => setImmediate(resolve)); assert.ok(condition(), 'Expected gallery state transition did not finish.'); }

test('gallery renders untrusted model names as text and read-only cards use review actions', t => {
  const f = uiFixture(t, { role: 'viewer' });
  const name = '<script>publishDraft()</script> " & <img src=x onerror=run()>';
  f.catalog.models[0].publishedModel.name = name;
  f.catalog.models[0].publishedAt = 'invalid date';
  f.ui.open('published');
  assert.equal(f.buttons()[0].attributes.get('aria-label'), `Open published model — ${name}`);
  assert.ok(f.node('#gallery-grid').textContent.includes(name));
  const tags = node => [node.tagName, ...node.children.flatMap(tags)];
  assert.ok(!tags(f.node('#gallery-grid')).includes('SCRIPT'));
  assert.ok(!tags(f.node('#gallery-grid')).includes('IMG'));
  assert.ok(!f.node('#gallery-grid').textContent.includes('Invalid Date'));
  f.ui.open('editing');
  assert.equal(f.buttons()[1].attributes.get('aria-label'), 'View draft — Filtration');
  assert.ok(f.node('#gallery-grid').children[1].textContent.includes('Editing locked'));
  assert.equal(f.node('#gallery-new-model').hidden, true);
});

test('repeated card clicks open only the selected model while navigation is pending', async t => {
  const gate = deferred(), f = uiFixture(t, { onOpen: () => gate.promise });
  f.ui.open('editing');
  const buttons = f.buttons();
  f.click(buttons[0]); f.click(buttons[1]);
  assert.deepEqual(f.calls, [{ view: 'editing', id: 'transfer' }]);
  assert.ok(f.buttons().every(button => button.disabled));
  assert.equal(f.node('#model-gallery').attributes.get('aria-busy'), 'true');
  gate.resolve(false);
  await until(() => f.node('#gallery-status').textContent === '');
  assert.equal(f.ui.isOpen, true);
  assert.ok(f.buttons().every(button => !button.disabled));
});

test('failed model navigation leaves the gallery available for a different selection', async t => {
  let rejectOpen = true;
  const f = uiFixture(t, { onOpen: () => { if (rejectOpen) throw new Error('The current draft could not be saved.'); return false; } });
  f.ui.open('published');
  f.click(f.buttons()[0]);
  await until(() => f.toasts.length === 1 && !f.buttons()[0].disabled);
  assert.equal(f.ui.isOpen, true);
  assert.match(f.toasts[0], /draft could not be saved/);
  rejectOpen = false;
  f.click(f.buttons()[1]);
  await until(() => f.calls.length === 2 && !f.buttons()[0].disabled);
  assert.deepEqual(f.calls[1], { view: 'published', id: 'filtration' });
});

test('refresh loading blocks selection and searching/clearing restores the accessible model list', async t => {
  const f = uiFixture(t);
  f.ui.open('editing');
  f.ui.setLoading(true); f.click(f.buttons()[0]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.node('#gallery-new-model').disabled, true);
  f.ui.setLoading(false);
  f.node('#gallery-search').value = 'new production'; f.node('#gallery-search').dispatch('input');
  assert.deepEqual(f.buttons().map(button => button.dataset.galleryOpen), ['draft-only']);
  assert.equal(f.node('#gallery-summary').textContent, '1 of 4 models');
  f.node('#gallery-search').value = 'unknown'; f.node('#gallery-search').dispatch('input');
  assert.equal(f.buttons().length, 0);
  assert.equal(f.node('#gallery-empty').hidden, false);
  assert.equal(f.node('#gallery-empty-heading').textContent, 'No matching models');
  f.node('#gallery-reset-search').dispatch('click');
  assert.equal(f.node('#gallery-search').value, '');
  assert.equal(f.node('#gallery-search').focused, true);
  assert.equal(f.buttons().length, 4);
  f.click(f.buttons()[2]);
  await until(() => !f.buttons()[0].disabled);
  assert.deepEqual(f.calls, [{ view: 'editing', id: 'draft-only' }]);
});

test('permission refresh removes withdrawn publications and rejects detached or closed-gallery card actions', t => {
  const f = uiFixture(t);
  f.ui.open('published');
  const removedButton = f.buttons()[0];
  f.grants.transfer.published = false;
  f.ui.render();
  assert.deepEqual(f.buttons().map(button => button.dataset.galleryOpen), ['filtration']);
  f.click(removedButton);
  assert.deepEqual(f.calls, []);
  const remainingButton = f.buttons()[0];
  f.ui.leave(); f.click(remainingButton);
  assert.deepEqual(f.calls, []);
  assert.equal(f.ui.isOpen, false);
});
