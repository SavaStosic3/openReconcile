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
  models.forEach((entry, index) => { entry.revision = 10 + index; });
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
    this.value = ''; this.hidden = false; this.disabled = false; this.ownText = ''; this.open = false; this.className = '';
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle: (name, force) => { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; } };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Gallery model data must be rendered with DOM text nodes.'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.ownText = ''; this.children = []; this.append(...children); }
  addEventListener(name, listener) { const listeners = this.listeners.get(name) || []; listeners.push(listener); this.listeners.set(name, listeners); }
  dispatch(name, target = this, detail = {}) {
    const event = { target, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...detail };
    for (const listener of this.listeners.get(name) || []) listener(event);
    return event;
  }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  matches(selector) {
    return selector.split(',').some(part => {
      const match = part.trim().match(/^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i);
      if (!match) return part.trim().startsWith('#') && this.id === part.trim().slice(1);
      const [, tag, className, attribute, expected] = match;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (className && !this.className.split(/\s+/).includes(className) && !this.classList.contains(className)) return false;
      const value = attribute?.startsWith('data-') ? this.dataset[attribute.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] : this.getAttribute(attribute);
      return !attribute || (value !== undefined && value !== null && (expected === undefined || String(value) === expected));
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; globalThis.document.activeElement = this; }
  select() { this.selected = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  checkValidity() { return !this.required || Boolean(this.value.trim()); }
  reportValidity() { return this.checkValidity(); }
}

function uiFixture(t, options = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nodes = new Map(), data = fixture(), calls = [], toasts = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const documentEvents = new Element('#document');
  const document = { querySelector: node, createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag), createTextNode: text => { const child = new Element('#text'); child.textContent = text; return child; }, body: node('body'), activeElement: null, addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: (name, listener) => { documentEvents.listeners.set(name, (documentEvents.listeners.get(name) || []).filter(item => item !== listener)); } };
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  if (options.role === 'admin') for (const permission of Object.values(data.grants)) permission.canDelete = true;
  const backend = { workspace: { catalog: data.catalog }, user: { role: options.role || 'editor', active: true }, permission: data.permission };
  const ui = createModelGallery({ backend, onOpen: async (view, id) => { calls.push({ view, id }); return options.onOpen?.(view, id); }, onCreate: async () => { calls.push({ create: true }); return options.onCreate?.(); }, onAction: async (action, id, details) => { calls.push({ action, id, details }); return options.onAction?.(action, id, details); }, onToast: text => toasts.push(text) });
  t.after(() => { ui.leave(); if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
  return { ...data, ui, node, calls, toasts, backend, document, documentEvents, buttons: () => node('#gallery-grid').querySelectorAll('button[data-gallery-open]'), click: button => node('#gallery-grid').dispatch('click', button.children[0] || button), menuButtons: () => node('#gallery-grid').querySelectorAll('button[data-gallery-menu]'), actionButtons: () => node('#gallery-grid').querySelectorAll('button[data-gallery-action]'), key: (target, key, detail = {}) => { const event = node('#gallery-grid').dispatch('keydown', target, { key, ...detail }); if (!event.propagationStopped) return documentEvents.dispatch('keydown', target, { key, ...detail }); return event; }, outsideClick: target => documentEvents.dispatch('click', target || node('outside')) };
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

function menuFor(f, id) {
  const trigger = f.menuButtons().find(button => button.dataset.galleryMenu === id);
  assert.ok(trigger, `Expected model actions for ${id}.`);
  return { trigger, menu: trigger.closest('article').querySelector('[role="menu"]'), action: name => trigger.closest('article').querySelector(`button[data-gallery-action="${name}"]`) };
}

function openMenu(f, id) {
  const controls = menuFor(f, id);
  controls.trigger.focus(); f.click(controls.trigger);
  assert.equal(controls.menu.hidden, false);
  assert.equal(controls.trigger.getAttribute('aria-expanded'), 'true');
  return controls;
}

test('model actions menu stays separate from card navigation and exposes each card identity', t => {
  const f = uiFixture(t);
  f.ui.open('editing');
  const first = openMenu(f, 'transfer');
  assert.deepEqual(f.calls, []);
  assert.equal(first.trigger.getAttribute('aria-label'), 'Model actions — Transfer draft');
  const second = openMenu(f, 'draft-only');
  assert.equal(first.menu.hidden, true);
  assert.equal(first.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(second.trigger.getAttribute('aria-controls'), 'gallery-model-menu-draft-only');
  assert.deepEqual(f.calls, []);
});

test('editor card actions preserve edit locks and the administrator-only model deletion rule', t => {
  const f = uiFixture(t, { role: 'editor' });
  f.ui.open('editing');
  const editable = menuFor(f, 'transfer'), locked = menuFor(f, 'filtration'), draft = menuFor(f, 'draft-only'), readOnly = menuFor(f, 'unpublished');
  assert.equal(editable.action('rename').disabled, false);
  assert.equal(editable.action('duplicate').disabled, false);
  assert.equal(editable.action('delete').disabled, true);
  assert.equal(locked.action('rename').disabled, true);
  assert.equal(locked.action('duplicate').disabled, false);
  assert.equal(locked.action('delete').disabled, true);
  assert.equal(draft.action('rename').disabled, false);
  assert.equal(draft.action('duplicate').disabled, false);
  assert.equal(draft.action('delete').disabled, true);
  assert.equal(readOnly.action('rename').disabled, true);
  assert.equal(readOnly.action('duplicate').disabled, false);
  assert.equal(readOnly.action('delete').disabled, true);
});

test('viewer menus cannot rename, duplicate, or delete any accessible model', t => {
  const f = uiFixture(t, { role: 'viewer' });
  for (const permission of Object.values(f.grants)) permission.canEdit = false;
  f.ui.open('editing');
  assert.ok(f.actionButtons().length > 0);
  assert.ok(f.actionButtons().every(button => button.disabled));
  const controls = openMenu(f, 'draft-only');
  for (const name of ['rename', 'duplicate', 'delete']) f.click(controls.action(name));
  assert.deepEqual(f.calls, []);
  assert.equal(f.node('#gallery-rename-dialog').open, false);
  assert.equal(f.node('#gallery-delete-dialog').open, false);
});

test('administrator menus can delete an active model without bypassing card-level access', t => {
  const f = uiFixture(t, { role: 'admin' });
  f.grants.filtration.canEdit = true; // Backend permissions include the administrator lock override.
  f.ui.open('published');
  for (const id of ['transfer', 'filtration']) {
    const controls = menuFor(f, id);
    assert.equal(controls.action('rename').disabled, false);
    assert.equal(controls.action('duplicate').disabled, false);
    assert.equal(controls.action('delete').disabled, false);
  }
  assert.equal(f.menuButtons().some(button => button.dataset.galleryMenu === 'private'), false);
});

test('duplicate targets the selected card once and blocks card opening while the request is pending', async t => {
  const gate = deferred(), f = uiFixture(t, { onAction: () => gate.promise });
  f.ui.open('editing');
  const controls = openMenu(f, 'filtration');
  f.click(controls.action('duplicate')); f.click(controls.action('duplicate')); f.click(f.buttons()[0]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { action: 'duplicate', id: 'filtration', details: { revision: 11, view: 'editing' } });
  assert.ok(f.buttons().every(button => button.disabled));
  assert.ok(f.menuButtons().every(button => button.disabled));
  assert.equal(f.node('#gallery-status').textContent, 'Updating model…');
  gate.resolve();
  await until(() => f.node('#gallery-status').textContent === '');
  assert.ok(f.buttons().every(button => !button.disabled));
  assert.equal(f.ui.isOpen, true);
});

test('Escape closes the menu and returns focus to its trigger; outside clicks close it', t => {
  const f = uiFixture(t);
  f.ui.open('editing');
  let controls = openMenu(f, 'transfer');
  f.key(controls.action('rename'), 'Escape');
  assert.equal(controls.menu.hidden, true);
  assert.equal(controls.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(f.document.activeElement, controls.trigger);
  controls = openMenu(f, 'draft-only');
  f.outsideClick();
  assert.equal(controls.menu.hidden, true);
  assert.equal(controls.trigger.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(f.calls, []);
});

test('menu keyboard navigation skips disabled actions and focuses available commands', t => {
  const f = uiFixture(t);
  f.ui.open('editing');
  const controls = openMenu(f, 'transfer');
  f.key(controls.action('rename'), 'ArrowDown');
  assert.equal(f.document.activeElement, controls.action('duplicate'));
  f.key(controls.action('duplicate'), 'ArrowDown');
  assert.equal(f.document.activeElement, controls.action('rename'));
  f.key(controls.action('rename'), 'End');
  assert.equal(f.document.activeElement, controls.action('duplicate'));
  f.key(controls.action('duplicate'), 'Home');
  assert.equal(f.document.activeElement, controls.action('rename'));
});

test('rename validates the draft name and sends the reviewed revision without changing a publication', async t => {
  const f = uiFixture(t);
  f.ui.open('published');
  const before = structuredClone(f.catalog.models[0].publishedModel);
  const controls = openMenu(f, 'transfer');
  f.click(controls.action('rename'));
  const dialog = f.node('#gallery-rename-dialog'), field = f.node('#gallery-rename-name'), form = f.node('#gallery-rename-form');
  assert.equal(dialog.open, true);
  assert.equal(field.value, 'Transfer draft');
  assert.match(f.node('#gallery-rename-description').textContent, /publish|draft/i);
  field.value = '   '; form.dispatch('submit');
  assert.deepEqual(f.calls, []);
  assert.equal(dialog.open, true);
  assert.equal(field.value, '   ');
  assert.equal(f.node('#gallery-rename-error').hidden, false);
  field.value = 'A'.repeat(161); form.dispatch('submit');
  assert.deepEqual(f.calls, []);
  assert.equal(field.value.length, 161);
  assert.equal(dialog.open, true);
  field.value = '  New transfer name  ';
  f.catalog.models[0].revision = 88;
  form.dispatch('submit');
  await until(() => !dialog.open);
  assert.deepEqual(f.calls, [{ action: 'rename', id: 'transfer', details: { name: 'New transfer name', revision: 10, view: 'published' } }]);
  assert.deepEqual(f.catalog.models[0].publishedModel, before);
  assert.equal(f.ui.isOpen, true);
});

test('rename failures preserve typed input for retry and requests cannot be submitted twice', async t => {
  const gate = deferred(); let shouldFail = true;
  const f = uiFixture(t, { onAction: async () => { await gate.promise; if (shouldFail) throw new Error('This model was changed by another user.'); } });
  f.ui.open('editing');
  f.click(openMenu(f, 'draft-only').action('rename'));
  const dialog = f.node('#gallery-rename-dialog'), field = f.node('#gallery-rename-name'), form = f.node('#gallery-rename-form');
  field.value = 'Production balance'; form.dispatch('submit'); form.dispatch('submit');
  assert.equal(f.calls.length, 1);
  assert.equal(f.node('#gallery-rename-submit').disabled, true);
  assert.equal(dialog.dispatch('cancel').defaultPrevented, true);
  gate.resolve();
  await until(() => !f.node('#gallery-rename-submit').disabled);
  assert.equal(dialog.open, true);
  assert.equal(field.value, 'Production balance');
  assert.match(f.node('#gallery-rename-error').textContent, /changed by another user/);
  shouldFail = false; form.dispatch('submit');
  await until(() => !dialog.open);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], f.calls[0]);
});

test('delete requires explicit confirmation and uses the selected card revision', async t => {
  const f = uiFixture(t, { role: 'admin' });
  f.ui.open('published');
  const controls = openMenu(f, 'filtration'); f.click(controls.action('delete'));
  const dialog = f.node('#gallery-delete-dialog');
  assert.equal(dialog.open, true);
  assert.match(f.node('#gallery-delete-description').textContent, /Filtration/);
  assert.deepEqual(f.calls, []);
  f.node('#gallery-delete-cancel').dispatch('click');
  assert.equal(dialog.open, false);
  assert.deepEqual(f.calls, []);
  f.click(openMenu(f, 'filtration').action('delete'));
  f.node('#gallery-delete-form').dispatch('submit');
  await until(() => !dialog.open);
  assert.deepEqual(f.calls, [{ action: 'delete', id: 'filtration', details: { revision: 11, view: 'published' } }]);
});

test('withdrawn access, refreshed cards, and a closed gallery reject stale menu actions', t => {
  const f = uiFixture(t);
  f.ui.open('editing');
  const controls = openMenu(f, 'transfer');
  f.grants.transfer.canEdit = false;
  f.click(controls.action('rename'));
  assert.equal(f.node('#gallery-rename-dialog').open, false);
  assert.deepEqual(f.calls, []);
  f.grants.transfer.canView = false; f.ui.render();
  f.click(controls.action('duplicate'));
  assert.deepEqual(f.calls, []);
  const remaining = openMenu(f, 'draft-only'); f.ui.leave();
  f.click(remaining.action('delete'));
  assert.equal(f.node('#gallery-delete-dialog').open, false);
  assert.deepEqual(f.calls, []);
});

test('an action dialog rechecks withdrawn edit permission before sending a renamed model', t => {
  const f = uiFixture(t);
  f.ui.open('editing');
  f.click(openMenu(f, 'transfer').action('rename'));
  f.node('#gallery-rename-name').value = 'A reviewed draft';
  f.grants.transfer.canEdit = false;
  f.node('#gallery-rename-form').dispatch('submit');
  assert.deepEqual(f.calls, []);
  assert.equal(f.node('#gallery-rename-dialog').open, true);
  assert.equal(f.node('#gallery-rename-name').value, 'A reviewed draft');
  assert.match(f.node('#gallery-rename-error').textContent, /no longer have permission/i);
  f.node('#gallery-rename-cancel').dispatch('click');
  assert.equal(f.node('#gallery-rename-dialog').open, false);
});

test('failed deletion retains confirmation and restores controls for an explicit retry', async t => {
  const gate = deferred(); let shouldFail = true;
  const f = uiFixture(t, { role: 'admin', onAction: async () => { await gate.promise; if (shouldFail) throw new Error('The server could not delete this model.'); } });
  f.ui.open('published');
  f.click(openMenu(f, 'transfer').action('delete'));
  const dialog = f.node('#gallery-delete-dialog'), form = f.node('#gallery-delete-form');
  form.dispatch('submit'); form.dispatch('submit');
  assert.equal(f.calls.length, 1);
  assert.equal(f.node('#gallery-delete-submit').disabled, true);
  f.node('#gallery-delete-cancel').dispatch('click');
  assert.equal(dialog.open, true);
  gate.resolve();
  await until(() => !f.node('#gallery-delete-submit').disabled);
  assert.equal(dialog.open, true);
  assert.match(f.node('#gallery-delete-error').textContent, /server could not delete/);
  shouldFail = false; form.dispatch('submit');
  await until(() => !dialog.open);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], f.calls[0]);
});

test('a failed duplicate releases the pending state and leaves its card available to retry', async t => {
  let shouldFail = true;
  const f = uiFixture(t, { onAction: () => { if (shouldFail) throw new Error('The copied model could not be created.'); } });
  f.ui.open('editing');
  f.click(openMenu(f, 'draft-only').action('duplicate'));
  await until(() => f.toasts.length === 1 && !f.menuButtons()[0].disabled);
  assert.match(f.toasts[0], /copied model could not be created/);
  assert.equal(f.ui.isOpen, true);
  shouldFail = false;
  f.click(openMenu(f, 'draft-only').action('duplicate'));
  await until(() => f.calls.length === 2 && !f.menuButtons()[0].disabled);
  assert.deepEqual(f.calls[1], f.calls[0]);
});

test('leaving the gallery dismisses an unsubmitted confirmation without writing', t => {
  const f = uiFixture(t, { role: 'admin' });
  f.ui.open('published');
  f.click(openMenu(f, 'transfer').action('delete'));
  assert.equal(f.node('#gallery-delete-dialog').open, true);
  f.ui.leave();
  assert.equal(f.node('#gallery-delete-dialog').open, false);
  f.node('#gallery-delete-form').dispatch('submit');
  assert.deepEqual(f.calls, []);
});
