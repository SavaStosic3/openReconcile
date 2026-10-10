import { appendUnitSymbol, unitBounds } from './unit-symbols.js';
import { getStreamRoutes } from './stream-routing.js';
import { isStorageNode } from './inventory.js';

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

function card(item, view) {
  const { entry, model, permission, name } = item;
  const article = element('article', 'gallery-card');
  article.id = `gallery-model-${item.id}`;
  const headingId = `gallery-model-name-${item.id}`;
  article.setAttribute('aria-labelledby', headingId);
  article.append(preview(item));
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

export function createModelGallery({ backend, onOpen, onCreate, onToast }) {
  let pageOpen = false, currentView = 'published', loading = false, opening = false, cardsKey = '';
  const section = $('#model-gallery'), search = $('#gallery-search'), grid = $('#gallery-grid');
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
    $('#gallery-new-model').disabled = loading || opening;
    $('#gallery-summary').textContent = search.value.trim() ? `${entries.length} of ${plural(all.length, 'model')}` : `${plural(all.length, 'model')} available`;
    $('#gallery-clear-search').hidden = !search.value;
    const key = JSON.stringify([currentView, entries]);
    if (key !== cardsKey) {
      grid.replaceChildren(...entries.map(item => card(item, currentView)));
      cardsKey = key;
    }
    for (const button of grid.querySelectorAll('button[data-gallery-open]')) button.disabled = loading || opening;
    grid.hidden = entries.length === 0;
    $('#gallery-empty').hidden = entries.length !== 0 || loading;
    const searching = Boolean(search.value.trim());
    $('#gallery-empty-heading').textContent = searching ? 'No matching models' : published ? 'No published models yet' : 'No models available';
    $('#gallery-empty-description').textContent = searching ? 'Try another name or clear the search to see all available models.' : published ? canBuild ? 'Publish a draft from Edit models to make it available here. Your administrator manages access to other models.' : 'Published models assigned to your account appear here. Ask your administrator for model access.' : canCreate ? 'Create a model to start building your flowsheet. You can also import a saved model from the editor.' : 'Models assigned to your account appear here. Ask your administrator for model access.';
    $('#gallery-reset-search').hidden = !searching;
    section.setAttribute('aria-busy', String(loading || opening));
    $('#gallery-status').textContent = opening ? 'Opening model…' : loading ? 'Refreshing models…' : '';
  }
  async function perform(action) {
    if (loading || opening || !pageOpen) return;
    opening = true; render();
    try { await action(); }
    catch (error) { onToast?.(error?.message || 'The model could not be opened.'); }
    finally { opening = false; render(); }
  }
  grid.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-gallery-open]');
    if (!button || !grid.contains(button)) return;
    void perform(() => onOpen(currentView, button.dataset.galleryOpen));
  });
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
      if (!pageOpen || currentView !== view) search.value = '';
      currentView = view; pageOpen = true;
      section.hidden = false; document.body.classList.add('is-model-gallery');
      render(); $('#gallery-heading').focus();
    },
    leave() { pageOpen = false; section.hidden = true; document.body.classList.remove('is-model-gallery'); },
    render,
    setLoading(value) { loading = Boolean(value); render(); },
    get isOpen() { return pageOpen; },
    get view() { return currentView; }
  };
}
