import { appendUnitSymbol, unitBounds } from './unit-symbols.js';
import { getStreamRoutes } from './stream-routing.js';
import { isStorageNode } from './inventory.js';
import { modelActionPermissions } from './model-actions.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = selector => document.querySelector(selector);

/** Select only accessible snapshots, without changing catalog order or data. */
export function galleryEntries(catalog, permission, view, query = '') {
  if (!['published', 'editing'].includes(view) || !Array.isArray(catalog?.models)) return [];
  const search = String(query).trim().toLocaleLowerCase();
  return catalog.models.flatMap(entry => {
    const access = permission(entry.id) || {};
    if (!access.canView || (view === 'published' && (!access.published || !entry.publishedModel))) return [];
    const model = view === 'published' ? entry.publishedModel : entry.model;
    if (!model) return [];
    const name = model.name || 'Untitled model';
    return String(name).toLocaleLowerCase().includes(search) ? [{ id: entry.id, entry, model, permission: access, name }] : [];
  });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}
function displayDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }

function preview(item) {
  const holder = element('div', 'gallery-preview');
  holder.setAttribute('aria-hidden', 'true');
  const model = item.model;
  if (!model.nodes?.length) {
    const icon = svgElement('svg', { viewBox: '0 0 80 58', class: 'gallery-preview-empty-icon' });
    icon.append(svgElement('rect', { x: 7, y: 8, width: 25, height: 25, rx: 5 }), svgElement('rect', { x: 48, y: 25, width: 25, height: 25, rx: 5 }), svgElement('path', { d: 'M32 20H60V25' }));
    holder.append(icon, element('span', '', 'Flowsheet ready to build'));
    return holder;
  }
  // Reuse the diagram's connection ports and crossing geometry. Gallery previews
  // use the selected snapshot, never the active editor or reconciliation results.
  const routes = getStreamRoutes(model);
  const bounds = [...model.nodes.map(unitBounds), ...[...routes.values()].map(route => route.bounds)];
  const left = Math.min(...bounds.map(bound => bound.left)) - 26;
  const top = Math.min(...bounds.map(bound => bound.top)) - 26;
  const width = Math.max(220, Math.max(...bounds.map(bound => bound.right)) - left + 26);
  const height = Math.max(130, Math.max(...bounds.map(bound => bound.bottom)) - top + 26);
  const svg = svgElement('svg', { viewBox: `${left} ${top} ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', focusable: 'false' });
  const markerId = `gallery-arrow-${item.id}`;
  const defs = svgElement('defs'), marker = svgElement('marker', { id: markerId, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto' });
  marker.append(svgElement('path', { d: 'M0 0L8 4L0 8Z', fill: '#769c98' }));
  defs.append(marker); svg.append(defs);
  for (const stream of model.streams) {
    const route = routes.get(stream.id);
    if (!route) continue;
    svg.append(svgElement('path', { d: route.d, fill: 'none', stroke: '#769c98', 'stroke-width': 2.3, 'stroke-linejoin': 'round', 'marker-end': `url(#${markerId})` }));
    if (stream.measured) {
      const group = svgElement('g', { transform: `translate(${route.label.x} ${route.label.y})` });
      group.append(svgElement('circle', { r: 10, fill: '#f6fbf9', stroke: '#087f75', 'stroke-width': 1.5 }));
      const label = svgElement('text', { x: 0, y: 3.7, 'text-anchor': 'middle', fill: '#06675f', 'font-size': 10, 'font-weight': 600, 'font-family': 'inherit' });
      label.textContent = stream.meterType === 'virtual' ? 'V' : 'M'; group.append(label); svg.append(group);
    }
  }
  for (const node of model.nodes) {
    const group = svgElement('g', { transform: `translate(${node.x} ${node.y})` });
    if (['inlet', 'outlet'].includes(node.kind)) {
      group.append(svgElement('path', { d: 'M-26,-26L30,0L-26,26Z', fill: '#bf6657', stroke: '#bf6657', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    } else appendUnitSymbol(node.kind, group, { stroke: '#243a54', fill: '#ffffff', strokeWidth: 2.5 });
    svg.append(group);
  }
  holder.append(svg);
  return holder;
}

function card(item, view, user) {
  const { entry, model, permission, name } = item;
  const article = element('article', 'gallery-card');
  article.id = `gallery-model-${item.id}`;
  const headingId = `gallery-model-name-${item.id}`;
  article.setAttribute('aria-labelledby', headingId);
  article.append(preview(item));
  const overflow = element('div', 'gallery-card-overflow');
  const menuButton = element('button', 'gallery-menu-button');
  menuButton.type = 'button'; menuButton.dataset.galleryMenu = item.id;
  menuButton.setAttribute('aria-label', `Model actions — ${name}`);
  menuButton.setAttribute('aria-haspopup', 'menu'); menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-controls', `gallery-model-menu-${item.id}`);
  const dots = svgElement('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', focusable: 'false' });
  for (const y of [5, 10, 15]) dots.append(svgElement('circle', { cx: 10, cy: y, r: 1.5, fill: 'currentColor' }));
  menuButton.append(dots);
  const menu = element('div', 'gallery-card-menu');
  menu.id = `gallery-model-menu-${item.id}`; menu.hidden = true;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Actions for ${name}`);
  const flags = modelActionPermissions(user, permission);
  for (const [actionName, label, allowed] of [['rename', 'Rename', flags.canRename], ['duplicate', 'Duplicate', flags.canDuplicate], ['delete', 'Delete', flags.canDelete]]) {
    const itemButton = element('button', `gallery-menu-item${actionName === 'delete' ? ' danger' : ''}`, label);
    itemButton.type = 'button'; itemButton.dataset.galleryAction = actionName; itemButton.dataset.galleryId = item.id;
    itemButton.setAttribute('role', 'menuitem'); itemButton.tabIndex = -1; itemButton.disabled = !allowed;
    menu.append(itemButton);
  }
  overflow.append(menuButton, menu); article.append(overflow);
  const body = element('div', 'gallery-card-body');
  const badges = element('div', 'gallery-card-badges');
  const published = permission.published && entry.publishedModel;
  if (view === 'published') badges.append(element('span', 'gallery-badge published', `Published${entry.publishedVersion ? ` · v${entry.publishedVersion}` : ''}`));
  else if (!published) badges.append(element('span', 'gallery-badge draft', 'Draft'));
  else badges.append(element('span', `gallery-badge ${entry.hasUnpublishedChanges ? 'changes' : 'published'}`, entry.hasUnpublishedChanges ? 'Unpublished changes' : `Published${entry.publishedVersion ? ` · v${entry.publishedVersion}` : ''}`));
  if (permission.editLocked && view === 'editing') badges.append(element('span', 'gallery-badge locked', 'Editing locked'));
  else badges.append(element('span', 'gallery-access', permission.canEdit ? 'Can edit' : permission.canRun ? 'Run access' : 'View only'));
  const heading = element('h2', 'gallery-card-title', name);
  heading.id = headingId;
  body.append(badges, heading);
  const stats = element('p', 'gallery-card-stats');
  const units = model.nodes.filter(node => !['inlet', 'outlet'].includes(node.kind)).length;
  const meters = model.streams.filter(stream => stream.measured).length + model.nodes.filter(isStorageNode).reduce((total, node) => total + ['opening', 'closing'].filter(endpoint => node.inventory?.[endpoint]?.measured).length, 0);
  stats.append(element('span', '', plural(units, 'unit')), element('span', '', plural(model.streams.length, 'stream')), element('span', '', plural(meters, 'meter')));
  body.append(stats);
  const when = view === 'published' ? entry.publishedAt : entry.updatedAt;
  const date = displayDate(when);
  const detail = element('p', 'gallery-card-date');
  if (date) {
    detail.append(document.createTextNode(view === 'published' ? 'Published ' : 'Updated '));
    const time = element('time', '', date); time.dateTime = new Date(when).toISOString(); detail.append(time);
  } else detail.textContent = view === 'published' ? 'Published model' : 'Working draft';
  body.append(detail);
  const action = element('button', 'gallery-card-action');
  action.type = 'button'; action.dataset.galleryOpen = item.id;
  const actionLabel = view === 'published' ? 'Open published model' : permission.canEdit ? 'Edit draft' : 'View draft';
  action.setAttribute('aria-label', `${actionLabel} — ${name}`);
  action.append(element('span', '', actionLabel));
  const arrow = svgElement('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', focusable: 'false' });
  arrow.append(svgElement('path', { d: 'M4 10H16M11 5L16 10L11 15', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  action.append(arrow); body.append(action); article.append(body);
  return article;
}

export function createModelGallery({ backend, onOpen, onCreate, onAction, onToast }) {
  let pageOpen = false, currentView = 'published', loading = false, opening = false, updating = false, cardsKey = '';
  let menuState = null, dialogContext = null;
  const section = $('#model-gallery'), search = $('#gallery-search'), grid = $('#gallery-grid');
  const renameDialog = $('#gallery-rename-dialog'), deleteDialog = $('#gallery-delete-dialog');
  const busy = () => loading || opening || updating;
  const currentItem = (id, view = currentView) => galleryEntries(backend.workspace.catalog, itemId => backend.permission(itemId), view).find(item => item.id === id);
  const allowed = (action, item) => Boolean(item && modelActionPermissions(backend.user, item.permission)[{ rename: 'canRename', duplicate: 'canDuplicate', delete: 'canDelete' }[action]]);
  function focusCard(id) {
    const trigger = [...grid.querySelectorAll('button[data-gallery-menu]')].find(button => button.dataset.galleryMenu === id);
    if (pageOpen && trigger && !trigger.disabled) trigger.focus();
    else if (pageOpen) search.focus();
  }
  function closeMenu(restoreFocus = true) {
    if (!menuState) return;
    const { trigger, menu, article } = menuState;
    menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); article.classList.remove('menu-open');
    menuState = null;
    if (restoreFocus && pageOpen && grid.contains(trigger) && !trigger.disabled) trigger.focus();
  }
  function closeDialog(restoreFocus = true) {
    const context = dialogContext;
    dialogContext = null;
    if (renameDialog.open) renameDialog.close();
    if (deleteDialog.open) deleteDialog.close();
    if (context && restoreFocus) focusCard(context.id);
  }
  function showActionError(action, message) {
    const error = $(`#gallery-${action}-error`);
    error.textContent = message; error.hidden = false;
  }
  function render() {
    if (!pageOpen) return;
    const published = currentView === 'published';
    const all = galleryEntries(backend.workspace.catalog, id => backend.permission(id), currentView);
    const entries = galleryEntries(backend.workspace.catalog, id => backend.permission(id), currentView, search.value);
    const canBuild = ['admin', 'editor'].includes(backend.user.role);
    const canCreate = !published && canBuild;
    $('#gallery-heading').textContent = published ? 'Published models' : 'Edit models';
    $('#gallery-description').textContent = published ? 'Open a published model to view its flowsheet and reconciliation results.' : 'Choose a working draft to build, update, and publish your process model.';
    $('#gallery-new-model').hidden = !canCreate;
    $('#gallery-new-model').disabled = busy();
    $('#gallery-summary').textContent = search.value.trim() ? `${entries.length} of ${plural(all.length, 'model')}` : `${plural(all.length, 'model')} available`;
    $('#gallery-clear-search').hidden = !search.value;
    const key = JSON.stringify([currentView, backend.user.role, backend.user.active, entries]);
    if (key !== cardsKey) {
      const menuId = menuState?.id;
      closeMenu(false);
      grid.replaceChildren(...entries.map(item => card(item, currentView, backend.user)));
      cardsKey = key;
      if (menuId) focusCard(menuId);
    }
    for (const button of grid.querySelectorAll('button[data-gallery-open]')) button.disabled = busy();
    for (const button of grid.querySelectorAll('button[data-gallery-menu]')) button.disabled = busy();
    for (const button of grid.querySelectorAll('button[data-gallery-action]')) button.disabled = busy() || !allowed(button.dataset.galleryAction, currentItem(button.dataset.galleryId));
    grid.hidden = entries.length === 0;
    $('#gallery-empty').hidden = entries.length !== 0 || loading;
    const searching = Boolean(search.value.trim());
    $('#gallery-empty-heading').textContent = searching ? 'No matching models' : published ? 'No published models yet' : 'No models available';
    $('#gallery-empty-description').textContent = searching ? 'Try another name or clear the search to see all available models.' : published ? canBuild ? 'Publish a draft from Edit models to make it available here. Your administrator manages access to other models.' : 'Published models assigned to your account appear here. Ask your administrator for model access.' : canCreate ? 'Create a model to start building your flowsheet. You can also import a saved model from the editor.' : 'Models assigned to your account appear here. Ask your administrator for model access.';
    $('#gallery-reset-search').hidden = !searching;
    section.setAttribute('aria-busy', String(busy()));
    $('#gallery-status').textContent = updating ? 'Updating model…' : opening ? 'Opening model…' : loading ? 'Refreshing models…' : '';
  }
  async function perform(action) {
    if (busy() || !pageOpen) return;
    closeMenu(false);
    opening = true; render();
    try { await action(); }
    catch (error) { onToast?.(error?.message || 'The model could not be opened.'); }
    finally { opening = false; render(); }
  }
  async function performAction(context, name) {
    if (busy() || !pageOpen) return;
    const item = currentItem(context.id, context.view);
    if (!allowed(context.action, item)) {
      const message = 'You no longer have permission to make this change.';
      if (dialogContext === context) showActionError(context.action, message); else onToast?.(message);
      return;
    }
    let focusId = context.id;
    updating = true; closeMenu(false); render();
    for (const action of ['rename', 'delete']) {
      $(`#gallery-${action}-submit`).disabled = true;
      $(`#gallery-${action}-cancel`).disabled = true;
      $(`#gallery-${action}-close`).disabled = true;
    }
    $('#gallery-rename-name').disabled = true;
    try {
      if (!onAction) throw new Error('Model actions are not available.');
      const result = await onAction(context.action, context.id, { ...(name !== undefined ? { name } : {}), revision: context.revision, view: context.view });
      if (context.action === 'duplicate' && result?.id) focusId = result.id;
      if (dialogContext === context) closeDialog(false);
    } catch (error) {
      const message = error?.message || 'The model could not be updated.';
      if (dialogContext === context) showActionError(context.action, message);
      else onToast?.(message);
    } finally {
      updating = false;
      for (const action of ['rename', 'delete']) {
        $(`#gallery-${action}-submit`).disabled = false;
        $(`#gallery-${action}-cancel`).disabled = false;
        $(`#gallery-${action}-close`).disabled = false;
      }
      $('#gallery-rename-name').disabled = false;
      render();
      if (!dialogContext) focusCard(focusId);
    }
  }
  function chooseAction(action, id) {
    if (busy() || !pageOpen) return;
    const item = currentItem(id);
    if (!allowed(action, item)) return;
    const context = { action, id, view: currentView, revision: item.permission.revision ?? item.entry.revision };
    closeMenu(false);
    if (action === 'duplicate') { void performAction(context); return; }
    dialogContext = context;
    const error = $(`#gallery-${action}-error`); error.textContent = ''; error.hidden = true;
    if (action === 'rename') {
      $('#gallery-rename-name').value = item.entry.model.name || 'Untitled model';
      $('#gallery-rename-description').textContent = currentView === 'published' ? 'Rename the working draft. The current publication keeps its name until you publish the updated draft.' : 'Choose a name for this working draft.';
      renameDialog.showModal(); $('#gallery-rename-name').focus(); $('#gallery-rename-name').select();
    } else {
      $('#gallery-delete-description').textContent = `Delete “${item.name}”? This removes the model from both galleries and stops its schedule. An administrator can restore it from deleted models.`;
      deleteDialog.showModal(); $('#gallery-delete-cancel').focus();
    }
  }
  function openMenu(trigger, last = false) {
    if (busy() || !pageOpen || !grid.contains(trigger) || !currentItem(trigger.dataset.galleryMenu)) return;
    const article = trigger.closest('article'), menu = article.querySelector('.gallery-card-menu');
    closeMenu(false);
    menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); article.classList.add('menu-open');
    menuState = { id: trigger.dataset.galleryMenu, view: currentView, trigger, menu, article };
    const items = [...menu.querySelectorAll('button[data-gallery-action]')].filter(button => !button.disabled);
    (last ? items.at(-1) : items[0])?.focus();
  }
  grid.addEventListener('click', event => {
    const action = event.target.closest?.('button[data-gallery-action]');
    if (action && grid.contains(action)) {
      event.stopPropagation();
      if (menuState && menuState.menu.contains(action) && !action.disabled) chooseAction(action.dataset.galleryAction, action.dataset.galleryId);
      return;
    }
    const trigger = event.target.closest?.('button[data-gallery-menu]');
    if (trigger && grid.contains(trigger)) {
      event.stopPropagation();
      if (menuState?.trigger === trigger) closeMenu(); else openMenu(trigger);
      return;
    }
    const button = event.target.closest?.('button[data-gallery-open]');
    if (!button || !grid.contains(button)) return;
    void perform(() => onOpen(currentView, button.dataset.galleryOpen));
  });
  grid.addEventListener('keydown', event => {
    const trigger = event.target.closest?.('button[data-gallery-menu]');
    if (trigger && grid.contains(trigger) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); openMenu(trigger, event.key === 'ArrowUp'); return;
    }
    if (!menuState || !menuState.menu.contains(event.target)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    if (event.key === 'Tab') { closeMenu(); return; }
    const items = [...menuState.menu.querySelectorAll('button[data-gallery-action]')].filter(button => !button.disabled);
    const index = items.indexOf(event.target);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  });
  grid.addEventListener('focusout', event => {
    if (menuState && event.relatedTarget && !menuState.menu.contains(event.relatedTarget) && !menuState.trigger.contains(event.relatedTarget)) closeMenu(false);
  });
  document.addEventListener('click', event => { if (menuState && !menuState.menu.contains(event.target) && !menuState.trigger.contains(event.target)) closeMenu(false); });
  document.addEventListener('keydown', event => { if (menuState && event.key === 'Escape') { event.preventDefault(); closeMenu(); } });
  for (const action of ['rename', 'delete']) {
    const dialog = action === 'rename' ? renameDialog : deleteDialog;
    const dismiss = () => { if (!updating) closeDialog(); };
    $(`#gallery-${action}-close`).addEventListener('click', dismiss);
    $(`#gallery-${action}-cancel`).addEventListener('click', dismiss);
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog || updating) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
    });
    dialog.addEventListener('close', () => { if (dialogContext?.action === action) { const id = dialogContext.id; dialogContext = null; focusCard(id); } });
    $(`#gallery-${action}-form`).addEventListener('submit', event => {
      event.preventDefault();
      const context = dialogContext;
      if (!context || context.action !== action || busy()) return;
      $(`#gallery-${action}-error`).hidden = true;
      const name = action === 'rename' ? $('#gallery-rename-name').value.trim() : undefined;
      if (action === 'rename' && (!name || name.length > 160)) {
        showActionError(action, 'Enter a model name between 1 and 160 characters.'); $('#gallery-rename-name').focus(); return;
      }
      void performAction(context, name);
    });
  }
  $('#gallery-new-model').addEventListener('click', () => {
    if (currentView !== 'editing' || !['admin', 'editor'].includes(backend.user.role)) return;
    void perform(() => onCreate());
  });
  search.addEventListener('input', render);
  const clearSearch = () => { search.value = ''; render(); search.focus(); };
  $('#gallery-clear-search').addEventListener('click', clearSearch);
  $('#gallery-reset-search').addEventListener('click', clearSearch);
  return {
    open(view) {
      if (!['published', 'editing'].includes(view)) throw new Error('Choose published models or edit models.');
      closeMenu(false); closeDialog(false);
      if (!pageOpen || currentView !== view) search.value = '';
      currentView = view; pageOpen = true;
      section.hidden = false; document.body.classList.add('is-model-gallery');
      render(); $('#gallery-heading').focus();
    },
    leave() { closeMenu(false); closeDialog(false); pageOpen = false; section.hidden = true; document.body.classList.remove('is-model-gallery'); },
    render,
    setLoading(value) { loading = Boolean(value); render(); },
    get isOpen() { return pageOpen; },
    get view() { return currentView; }
  };
}
