import { getModelItemName, getDataMapping, setItemDataMapping, inventoryMappingItems } from './data-mapping.js';
import { NODE_TYPES } from './model.js';
import { isVirtualMeter } from './virtual-meters.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createDataMapping({ getModel, getModelId, canEdit, onChange, onInspect, getModels, onSelectModel, getView, onToast }) {
  const $ = selector => document.querySelector(selector);
  const rows = $('#mapping-rows'), search = $('#mapping-search');
  let structure = '', renderedScope = null;
  const scope = () => `${getModelId()}:${getView()}`;

  function items() {
    const model = getModel();
    return [
      ...model.nodes.map(item => ({ item, kind: 'node', type: NODE_TYPES[item.kind], detail: 'Process unit' })),
      ...inventoryMappingItems(model),
      ...model.streams.map(item => ({ item, kind: 'stream', type: isVirtualMeter(item) ? 'Virtual meter' : item.measured ? 'Physical meter' : 'Stream', detail: `${item.name} · ${item.unit}` }))
    ];
  }
  function update(kind, id, sourceName, endpoint) {
    if (!canEdit()) { onToast('This model is read-only or locked by an administrator.'); render(); return; }
    try {
      onChange(setItemDataMapping(getModel(), { kind, id, sourceName, endpoint }));
      render();
    } catch (error) { onToast(error.message); }
  }
  function render() {
    const all = items(), query = search.value.trim().toLocaleLowerCase();
    const visible = all.filter(({ item, kind, type }) => `${getModelItemName(item, kind)} ${item.name} ${type} ${getDataMapping(item)?.sourceName || ''}`.toLocaleLowerCase().includes(query));
    const models = getModels(), select = $('#mapping-model');
    if (document.activeElement !== select) {
      select.replaceChildren(...models.map(entry => new Option(entry.name, entry.id)));
      if (!models.length) select.add(new Option('No models available', ''));
      select.value = models.find(entry => entry.active)?.id || '';
    }
    select.disabled = !models.length;
    const mapped = all.filter(({ item }) => getDataMapping(item)).length;
    $('#mapping-summary').textContent = `${mapped} of ${all.length} items mapped`;
    $('#mapping-version').textContent = getView();
    $('#mapping-access-note').textContent = canEdit() ? 'Enter a source identifier and press Tab to save. Select Clear to remove a mapping.' : 'Read-only mappings. Changes require an unlocked model draft and editor access.';
    const nextStructure = JSON.stringify([scope(), visible.map(({ item, kind, type, detail, endpoint }) => [kind, item.id, getModelItemName(item, kind), type, detail, endpoint])]);
    if (structure !== nextStructure || !rows.children.length) {
      structure = nextStructure;
      rows.innerHTML = visible.map(({ item, kind, type, detail, endpoint }) => {
        const name = getModelItemName(item, kind), mapping = getDataMapping(item);
        return `<tr data-mapping-kind="${kind}" data-mapping-id="${esc(item.id)}"${endpoint ? ` data-mapping-endpoint="${endpoint}"` : ''}><td><button type="button" class="stream-name-button" data-mapping-inspect aria-label="Show ${esc(name)} on diagram">${esc(name)}</button><small>${esc(type)}${kind !== 'node' ? ` · ${esc(detail)}` : ''}</small></td><td><input class="mapping-source-input" type="text" maxlength="200" autocomplete="off" spellcheck="false" value="${esc(mapping?.sourceName || '')}" placeholder="e.g. PLANT.FEED.FLOW" aria-label="${esc(name)} Source Name" aria-describedby="mapping-access-note"><span class="mapping-state" data-mapping-state></span></td><td><button type="button" class="text-button" data-mapping-clear aria-label="Clear ${esc(name)} mapping">Clear</button></td></tr>`;
      }).join('') || `<tr><td colspan="3" class="mapping-empty">${all.length ? 'No items match your search.' : 'Add process units and streams to your diagram to start mapping.'}</td></tr>`;
      for (const row of rows.querySelectorAll('[data-mapping-id]')) {
        const { mappingKind: kind, mappingId: id, mappingEndpoint: endpoint } = row.dataset;
        row.querySelector('input').onchange = event => update(kind, id, event.target.value, endpoint);
        row.querySelector('[data-mapping-clear]').onclick = () => update(kind, id, '', endpoint);
        row.querySelector('[data-mapping-inspect]').onclick = () => onInspect(kind === 'inventory' ? 'node' : kind, id);
      }
    }
    renderedScope = scope();
    for (const row of rows.querySelectorAll('[data-mapping-id]')) {
      const current = all.find(({ item, kind, endpoint }) => kind === row.dataset.mappingKind && item.id === row.dataset.mappingId && endpoint === row.dataset.mappingEndpoint);
      const mapping = current && getDataMapping(current.item), input = row.querySelector('input');
      if (document.activeElement !== input) input.value = mapping?.sourceName || '';
      input.disabled = !canEdit();
      row.querySelector('[data-mapping-clear]').disabled = !canEdit() || !mapping;
      row.querySelector('[data-mapping-state]').textContent = mapping ? 'Mapped' : 'Not mapped';
      row.querySelector('[data-mapping-state]').classList.toggle('is-mapped', Boolean(mapping));
    }
  }
  function flush() {
    if (!canEdit() || renderedScope !== scope()) return;
    let next = getModel(), changed = false;
    for (const row of rows.querySelectorAll('[data-mapping-id]')) {
      const { mappingKind: kind, mappingId: id, mappingEndpoint: endpoint } = row.dataset, sourceName = row.querySelector('input').value.trim();
      const owner = next[kind === 'node' || kind === 'inventory' ? 'nodes' : 'streams'].find(value => value.id === id), item = kind === 'inventory' ? owner?.inventory?.[endpoint] : owner;
      if (item && sourceName !== (getDataMapping(item)?.sourceName || '')) { next = setItemDataMapping(next, { kind, id, sourceName, endpoint }); changed = true; }
    }
    if (changed) onChange(next);
  }
  search.oninput = render;
  $('#mapping-model').onchange = async event => { const id = event.target.value; flush(); await onSelectModel(id); render(); };
  $('#mapping-back').onclick = () => onInspect(null, null);
  return { render, flush, invalidate: () => { structure = ''; renderedScope = null; rows.replaceChildren(); } };
}
