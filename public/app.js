import { exampleModel, emptyModel, METRICS, NODE_TYPES, measurementToMass } from './model.js';
import { createEditor } from './editor.js';
import { createManagement } from './management.js';
import { validateEditableModel } from './management-store.js';
import { connectWorkspace } from './workspace-api.js';
import { createAdmin } from './admin.js';
import { UNIT_SYMBOLS, appendUnitSymbol } from './unit-symbols.js';
import { getPublishedUnitSummary } from './published-results.js';
import { createLineVisibility } from './line-visibility.js';
import { getMeterName, isVirtualMeter, evaluateMeterReadings, evaluateMeterDetails } from './virtual-meters.js';
import { sameRunInputs } from './schedule-runner.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => n === null || n === undefined || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(Math.abs(n) < 1e-8 ? 0 : n);
const clone = v => structuredClone(v);
const isBoundary = kind => kind === 'inlet' || kind === 'outlet';
function buildPalette() {
  const groups = [
    { label: 'Machinery', kinds: ['pump', 'compressor', 'conveyor'] },
    { label: 'Flow & separation', kinds: ['valve', 'filter', 'cyclone', 'mixer', 'splitter'] },
    { label: 'Process', kinds: ['heatExchanger', 'process'] }
  ];
  $('#equipment-palette').innerHTML = groups.map(group => `<div class="palette-section"><h3>${esc(group.label)}</h3>${group.kinds.map(kind => {
    const symbol = UNIT_SYMBOLS[kind];
    return `<button type="button" class="palette-item" draggable="true" data-kind="${kind}" title="${esc(symbol.description)}"><span class="unit-glyph" aria-hidden="true"></span><span>${esc(symbol.label)}<small>${esc(symbol.description)}</small></span><span class="drag-grip" aria-hidden="true">⠿</span></button>`;
  }).join('')}</div>`).join('');
  for (const button of $$('.palette-item')) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '-62 -42 124 84'); svg.setAttribute('aria-hidden', 'true');
    if (isBoundary(button.dataset.kind)) {
      const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      triangle.setAttribute('d', 'M-26,-26 L30,0 L-26,26 Z'); triangle.setAttribute('fill', 'currentColor'); svg.append(triangle);
    } else appendUnitSymbol(button.dataset.kind, svg, { stroke: 'currentColor', fill: 'white', strokeWidth: 4 });
    $('.unit-glyph, .boundary-glyph', button).replaceChildren(svg);
  }
  $('#node-form').elements.kind.innerHTML = Object.entries(UNIT_SYMBOLS).map(([kind, symbol]) => `<option value="${kind}">${esc(symbol.label)}</option>`).join('');
}
buildPalette();
let model = emptyModel(), results = null, selection = null, activeTab = 'model', mode = 'select', editingStream = null, editingNode = null, confirmAction = null, toastTimer, admin = null, runningWorkbench = false, viewMode = 'editing', activeRun = null;
const modelSessions = new Map();
const backend = await connectWorkspace(toast);
const lineVisibility = createLineVisibility();
const initialPage = new URL(location.href);
if (backend.workspace.catalog.models.some(entry => entry.id === initialPage.searchParams.get('model'))) backend.select(initialPage.searchParams.get('model'));
const management = createManagement({ backend, fallbackModel: model, beforeAction: () => { admin?.leave(); flushVisibleDraft(); }, onActivate: activateManagedModel, onRun: acceptManagedRun, onNewModel: () => replaceModel(emptyModel()), onToast: toast, onAccessChange: reason => { if (viewMode === 'published' && ['refresh', 'publication', 'run'].includes(reason)) refreshPublishedModel(); refreshChrome(); }, onReview: record => { acceptManagedRun(record); switchTab('results'); } });
viewMode = initialPage.searchParams.get('view') === 'editing' ? 'editing' : initialPage.searchParams.get('view') === 'published' || backend.permission(management.activeId).published ? 'published' : 'editing';
model = clone(viewMode === 'published' ? backend.permission(management.activeId).published && management.current().publishedModel || emptyModel() : management.current().model);
let editingModelId = management.activeId;
let history = [JSON.stringify(model)], historyIndex = 0;

function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.remove('hidden'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 4200);
}
async function persist() {
  $('#save-state').textContent = 'Saving to workspace…';
  try { if (!await management.saveCurrent(model)) throw new Error('Save unavailable'); $('#save-state').textContent = backend.hasPending ? 'Saving to workspace…' : 'Saved to workspace'; }
  catch { $('#save-state').textContent = 'Not saved · export your draft'; }
}
function commit() {
  if (!canEdit()) { refreshChrome(); return; }
  const json = JSON.stringify(model);
  if (json !== history[historyIndex]) {
    history = history.slice(0, historyIndex + 1); history.push(json);
    if (history.length > 100) history.shift(); historyIndex = history.length - 1;
    results = null; activeRun = null; editor.setResults(null); persist();
  }
  refreshChrome(); renderInspector(); if (activeTab === 'results') renderResults();
}
function refreshChrome() {
  if (admin?.isOpen && backend.user.role !== 'admin') { admin.leave(); switchTab('model'); }
  if (document.activeElement !== $('#model-name')) $('#model-name').value = model.name;
  const count = model.streams.filter(s => s.measured).length;
  $('#meter-count').textContent = count;
  $('#model-count').textContent = `${model.nodes.length} units · ${model.streams.length} streams`;
  $('#canvas-empty').classList.toggle('hidden', model.nodes.length > 0);
  const permission = backend.permission(editingModelId), editable = canEdit(), exists = Boolean(editingModelId);
  $('#undo-button').disabled = !editable || historyIndex === 0; $('#redo-button').disabled = !editable || historyIndex >= history.length - 1;
  $('#model-name').disabled = !editable || management.isOpen || Boolean(admin?.isOpen);
  const available = viewMode !== 'published' || hasPublishedModel();
  $('#run-button').disabled = !permission.canRun || !available || runningWorkbench; $('#data-run-button').disabled = !permission.canRun || runningWorkbench;
  if (!runningWorkbench) $('#run-button').innerHTML = `<span aria-hidden="true">▶</span> ${viewMode === 'published' ? 'Run reconciliation' : 'Test draft reconciliation'}`;
  $$('.palette-item').forEach(button => { button.disabled = !editable; button.draggable = editable; });
  $$('[data-field], #batch-period, #custom-hours, #sample-readings').forEach(input => input.disabled = !editable);
  $$('.stream-name-button, [data-add-meter], #inspect-edit-node, #inspect-edit-stream, #inspect-delete').forEach(button => button.disabled = !editable);
  $$('[data-mode="connect"]').forEach(button => button.disabled = !editable);
  for (const id of ['new-button', 'demo-button', 'import-button', 'empty-new-model', 'empty-import-legacy']) $(`#${id}`).disabled = !canCreate();
  $('#export-button').disabled = !permission.canView;
  $('#auth-export-draft').hidden = backend.user.active !== false || !backend.failedDraft();
  $('#menu-admin').hidden = backend.user.role !== 'admin';
  $('#account-chip').hidden = false;
  $('#account-name').textContent = backend.user.name || backend.user.email;
  $('#account-role').textContent = backend.user.role === 'admin' ? 'Administrator' : backend.user.role;
  $('#account-email').textContent = backend.user.email;
  $('#management-role-label').textContent = backend.user.role === 'admin' ? 'Administrator' : backend.user.role;
  if (!exists) $('#save-state').textContent = 'No model selected';
  else $('#save-state').textContent = backend.hasFailedSave ? 'Not saved · export your draft' : backend.hasPending ? 'Saving to workspace…' : 'Saved to workspace';
  $('#workspace-empty').hidden = exists || management.isOpen || Boolean(admin?.isOpen);
  $('#workspace-empty').classList.toggle('hidden', exists || management.isOpen || Boolean(admin?.isOpen));
  $('#workspace-empty-message').textContent = canCreate() ? 'Create a model, load the demo, or import a model from a file or your previous browser workspace.' : 'Ask your administrator to give you access to a model. Assigned models will appear here.';
  $('#empty-new-model').hidden = !canCreate(); $('#empty-import-legacy').hidden = !canCreate();
  $$('.tab').forEach(button => button.disabled = !exists);
  if ((!exists || !available) && !management.isOpen && !admin?.isOpen) $$('[role="tabpanel"]').forEach(view => view.classList.add('hidden'));
  if (viewMode === 'published') $('#canvas-status').textContent = 'Published diagram · mass values in kg per batch. Select a unit or stream to inspect its results.';
  else if (exists && permission.editLocked) $('#canvas-status').textContent = 'Editing is locked by an administrator. You can still review and run this model if permitted.';
  else if (exists && !editable) $('#canvas-status').textContent = 'Read-only model. Your assigned permissions control editing and reconciliation.';
  refreshPageChrome();
  syncLineVisibility();
}
function syncLineVisibility() {
  const entry = currentEntry();
  const streams = [...model.streams, ...(entry?.model.streams || []), ...(entry?.publishedModel?.streams || [])];
  lineVisibility.scope(backend.user.id, editingModelId, streams);
  editor.setLineVisibility(lineVisibility.snapshot());
  renderLineMenu();
}
function renderLineMenu() {
  const focusedId = document.activeElement?.dataset?.restoreLine;
  const previousButtons = $$('[data-restore-line]'), focusedIndex = previousButtons.findIndex(button => button.dataset.restoreLine === focusedId);
  const { hiddenIds, showHidden } = lineVisibility.snapshot(), hidden = new Set(hiddenIds);
  const count = model.streams.filter(stream => hidden.has(stream.id)).length;
  $('#line-hidden-count').textContent = count ? `${count} hidden` : '';
  $('#line-hidden-count').hidden = !count;
  $('#show-hidden-lines').checked = showHidden;
  $('#show-hidden-lines').disabled = !count;
  $('#restore-all-lines').disabled = !count;
  $('#line-visibility-status').textContent = count ? `${count} hidden line${count === 1 ? '' : 's'}${showHidden ? ' currently revealed' : ''}.` : 'No lines are hidden.';
  $('#line-visibility-list').innerHTML = model.streams.filter(stream => hidden.has(stream.id)).map(stream => {
    const source = model.nodes.find(node => node.id === stream.source), target = model.nodes.find(node => node.id === stream.target);
    return `<div class="line-visibility-row"><span><strong>${esc(stream.name)}</strong><small>${esc(source?.name)} → ${esc(target?.name)}</small></span><button type="button" class="button secondary compact" data-restore-line="${esc(stream.id)}" aria-label="Restore ${esc(stream.name)}">Restore</button></div>`;
  }).join('') || '<p class="helper line-menu-empty">Hidden lines will appear here when you hide a stream.</p>';
  $$('[data-restore-line]').forEach(button => button.onclick = () => {
    lineVisibility.show(button.dataset.restoreLine);
    applyLineVisibility();
  });
  if (focusedId && $('#lines-menu').open) {
    const buttons = $$('[data-restore-line]');
    const next = buttons.find(button => button.dataset.restoreLine === focusedId) || buttons[Math.min(Math.max(0, focusedIndex), buttons.length - 1)] || $('#lines-menu > summary');
    next.focus({ preventScroll: true });
  }
}
function applyLineVisibility() {
  editor.setLineVisibility(lineVisibility.snapshot()); renderLineMenu(); renderInspector();
}
function hideLine(id) {
  const stream = model.streams.find(item => item.id === id); if (!stream) return;
  lineVisibility.hide(id); lineVisibility.setShowHidden(false);
  editor.select('stream', ''); applyLineVisibility();
  toast(`${stream.name} hidden. Open Hidden lines to restore it. It still participates in reconciliation.`);
}
function openStreamActions(id) {
  if (canEdit()) { openStream(id); return; }
  const stream = model.streams.find(item => item.id === id); if (!stream) return;
  $('#stream-actions-title').textContent = stream.name;
  $('#stream-actions-description').textContent = `${model.nodes.find(node => node.id === stream.source)?.name} → ${model.nodes.find(node => node.id === stream.target)?.name}`;
  $('#context-hide-line').onclick = () => { $('#stream-actions-dialog').close(); hideLine(id); };
  $('#stream-actions-dialog').showModal();
}
function canEdit() { return viewMode === 'editing' && Boolean(backend.permission(editingModelId).canEdit); }
function canCreate() { return ['admin', 'editor'].includes(backend.user.role); }
function requireEdit() { if (canEdit()) return true; toast('This model is read-only or locked by an administrator.'); return false; }
function currentEntry() { return backend.workspace.catalog.models.find(entry => entry.id === editingModelId) || null; }
function hasPublishedModel() { return Boolean(backend.permission(editingModelId).published && currentEntry()?.publishedModel); }
function runResult(record) {
  if (!record) return null;
  return record.result || { status: 'invalid', message: record.error || 'This run could not be completed.', streams: [], balances: [], warnings: [], objective: null, degreesOfFreedom: 0 };
}
function refreshPageChrome() {
  const published = viewMode === 'published', pageOpen = !management.isOpen && !admin?.isOpen;
  const entry = currentEntry(), permission = backend.permission(editingModelId), available = hasPublishedModel();
  document.body.classList.toggle('is-published', published);
  $('#model-view-switch').hidden = !pageOpen;
  $('#published-banner').hidden = !pageOpen || !published;
  $('#editing-banner').hidden = !pageOpen || published || !entry;
  $('#published-empty').hidden = !pageOpen || !published || available;
  $('#workflow-nav').classList.toggle('hidden', !pageOpen || !entry || (published && !available));
  $('#workspace-empty').hidden = published || Boolean(entry) || !pageOpen;
  $('#workspace-empty').classList.toggle('hidden', $('#workspace-empty').hidden);
  $('#open-published-view').setAttribute('aria-pressed', String(published));
  $('#open-editing-view').setAttribute('aria-pressed', String(!published));
  $('#open-published-view').classList.toggle('active', published);
  $('#open-editing-view').classList.toggle('active', !published);
  $('#tab-data').hidden = published;
  for (const id of ['new-button', 'demo-button', 'import-button', 'undo-button', 'redo-button']) $(`#${id}`).hidden = published;
  $('[data-mode="connect"]').hidden = published;
  const entries = backend.workspace.catalog.models.filter(item => backend.permission(item.id).published && item.publishedModel);
  const select = $('#published-model-select');
  if (document.activeElement !== select) {
    const choices = entries.map(item => new Option(item.publishedModel.name, item.id));
    if (!available) choices.unshift(new Option(entries.length ? 'Choose a published model' : 'No published models', ''));
    select.replaceChildren(...choices);
    select.value = available ? editingModelId : '';
  }
  select.disabled = !entries.length;
  $('#published-version').textContent = available ? `Published version ${entry.publishedVersion}` : 'No published version';
  $('#published-run-time').textContent = activeRun ? `Last run ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(activeRun.finishedAt || activeRun.startedAt))}` : 'No run for this version yet';
  $('#published-result-status').textContent = activeRun ? activeRun.status === 'ok' ? 'Reconciled' : activeRun.status === 'underdetermined' ? 'Needs measurements' : activeRun.status === 'warning' ? 'Review warnings' : 'Run needs attention' : 'Awaiting reconciliation';
  $('#published-result-status').dataset.status = activeRun?.status || 'pending';
  $('#published-message').textContent = available ? `${fmt(Number(model.periodHours))}-hour batch · kg per batch. ${activeRun ? activeRun.result?.message || activeRun.error || 'Run completed.' : 'Run reconciliation to display the saved version’s values.'}${entry.hasUnpublishedChanges ? ' Draft changes are separate from this published model.' : ''}` : 'Choose a published model, or publish a draft from Model editor.';
  const changed = entry && (!entry.publishedModel || JSON.stringify(viewMode === 'editing' ? model : entry.model) !== JSON.stringify(entry.publishedModel));
  $('#editing-status').textContent = permission.published ? changed ? `Draft changes · published version ${entry?.publishedVersion} is unchanged` : `Draft matches published version ${entry?.publishedVersion}` : 'Draft · not published';
  $('#publish-draft-button').textContent = permission.published ? 'Publish changes' : 'Publish model';
  $('#publish-draft-button').hidden = !permission.canEdit;
  $('#publish-draft-button').disabled = !permission.canEdit || !changed || runningWorkbench;
  $('#view-live-button').hidden = !available;
  $('#view-live-button').disabled = !available;
  if (published) $('#save-state').textContent = available ? `Published version ${entry.publishedVersion} · read-only diagram` : 'No published model selected';
  for (const id of ['results-run', 'results-data', 'results-fix-data']) {
    const button = $(`#${id}`);
    if (button) { if (id === 'results-run') button.disabled = !permission.canRun || !available || runningWorkbench; else button.hidden = published; }
  }
}
function refreshPublishedModel() {
  if (viewMode !== 'published') return;
  const entry = currentEntry();
  const next = hasPublishedModel() ? entry.publishedModel : emptyModel();
  const changed = JSON.stringify(model) !== JSON.stringify(next);
  if (changed) { model = clone(next); selection = null; editor.setModel(model); }
  activeRun = hasPublishedModel() ? management.latest(editingModelId, { target: 'published' }) : null;
  results = runResult(activeRun); editor.setResults(results); renderInspector();
  if (changed) editor.fit();
  if (activeTab === 'results') renderResults();
}
async function openPage(view, id = editingModelId) {
  if (view === 'published' && !backend.permission(id).published) id = backend.workspace.catalog.models.find(entry => backend.permission(entry.id).published && entry.publishedModel)?.id || id;
  await management.activate(id, { view });
}
async function publishDraft() {
  if (!canEdit()) return;
  const id = editingModelId;
  try {
    flushVisibleDraft(); await backend.flush();
    await backend.publication(id, true);
    await management.activate(id, { view: 'published' });
    toast('Draft published. Reconcile this version to see its values.');
  } catch (error) { toast(error.message); }
}
const editor = createEditor({
  canEdit,
  svg: $('#flowsheet'), onChange: commit,
  onSelect: s => { selection = s; renderInspector(); },
  onEditStream: openStream, onEditNode: openNode,
  onStreamContext: openStreamActions,
  onStatus: message => { $('#canvas-status').textContent = message; }
});
editor.setPresentation(viewMode === 'published' ? 'published' : 'editing');
editor.setModel(model); refreshChrome(); renderInspector();
$('#show-hidden-lines').onchange = event => { lineVisibility.setShowHidden(event.target.checked); applyLineVisibility(); };
$('#restore-all-lines').onclick = () => { lineVisibility.showAll(); applyLineVisibility(); $('#lines-menu > summary').focus({ preventScroll: true }); toast('All flow lines restored.'); };
document.addEventListener('click', event => { if (!event.composedPath().includes($('#lines-menu'))) $('#lines-menu').open = false; });
$('#lines-menu').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); $('#lines-menu').open = false; $('#lines-menu > summary').focus(); } });
function positionLineMenu() {
  if (!$('#lines-menu').open) return;
  const panel = $('.lines-menu-panel'), group = $('.canvas-view-tools').getBoundingClientRect();
  panel.style.right = `${Math.max(0, group.right - document.documentElement.clientWidth + 12)}px`;
  panel.style.maxWidth = `${Math.max(180, document.documentElement.clientWidth - 32)}px`;
  panel.style.maxHeight = `${Math.max(220, window.innerHeight - panel.getBoundingClientRect().top - 16)}px`;
}
$('#lines-menu').addEventListener('toggle', positionLineMenu);
window.addEventListener('resize', positionLineMenu);
admin = createAdmin({ api: backend.api, getUser: () => backend.user, beforeOpen: async () => { flushVisibleDraft(); await backend.flush(); management.leave(); }, onChange: () => backend.refresh(), onBack: () => switchTab('model'), onToast: toast });
$('#empty-new-model').onclick = () => replaceModel(emptyModel());
$('#menu-refresh-workspace').onclick = () => askReplace('Reload workspace and discard unsaved changes?', async () => {
  try { await backend.refresh({ discardDrafts: true }); activateManagedModel(management.current()); toast('Workspace refreshed.'); }
  catch (error) { toast(error.message); }
});
$('#empty-import-legacy').onclick = () => {
  if (!canCreate()) return;
  try {
    const raw = localStorage.getItem('massflow-model-v1');
    if (!raw) { toast('No previous browser model was found. Use Import to upload a model JSON file.'); $('#import-file').click(); return; }
    const saved = validateEditableModel(JSON.parse(raw));
    askReplace('Import your previous browser model into this workspace?', () => replaceModel(saved));
  } catch (error) { toast(`Import failed: ${error.message}`); }
};

function switchTab(name) {
  if (viewMode === 'published' && name === 'data') name = 'model';
  admin?.leave();
  management.leave();
  activeTab = name;
  for (const button of $$('.tab')) { const active = button.dataset.tab === name; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
  for (const view of $$('[role="tabpanel"]')) view.classList.toggle('hidden', view.id !== `view-${name}`);
  if (name === 'data') renderData(); if (name === 'results') renderResults();
  refreshChrome();
}
$$('.tab').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('.tabbar').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight'].includes(event.key) || !event.target.matches('.tab')) return;
  event.preventDefault(); const tabs = $$('.tab').filter(tab => !tab.hidden); const i = tabs.indexOf(event.target); const next = tabs[(i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; next.click(); next.focus();
});
function setMode(value) { mode = value; editor.setMode(value); $$('button[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === value)); }
$$('button[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$$('.palette-item').forEach(button => {
  button.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-node-kind', button.dataset.kind); event.dataTransfer.effectAllowed = 'copy'; });
  button.addEventListener('click', () => { editor.addNode(button.dataset.kind); toast(`${NODE_TYPES[button.dataset.kind]} added. Drag it into position.`); });
});
$('#fit-button').onclick = () => editor.fit(); $('#zoom-in').onclick = () => editor.zoom(Math.log(1.2)); $('#zoom-out').onclick = () => editor.zoom(-Math.log(1.2));
function travel(delta) {
  if (!requireEdit()) return;
  const next = historyIndex + delta; if (next < 0 || next >= history.length) return;
  historyIndex = next; model = JSON.parse(history[next]); results = null; activeRun = null; selection = null; editor.setModel(model); editor.setResults(null); persist(); refreshChrome(); renderInspector();
  if (activeTab === 'data') renderData(); if (activeTab === 'results') renderResults();
  $('#canvas-status').textContent = delta < 0 ? 'Change undone.' : 'Change restored.';
}
$('#undo-button').onclick = () => travel(-1); $('#redo-button').onclick = () => travel(1);
document.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select,details,[contenteditable="true"]') || $('dialog[open]')) return;
  if (management.isOpen || admin?.isOpen) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(event.shiftKey ? 1 : -1); return; }
  if (event.ctrlKey || event.metaKey || event.altKey || activeTab !== 'model') return;
  if (event.key.toLowerCase() === 'v') setMode('select'); if (event.key.toLowerCase() === 'c') setMode('connect'); if (event.key.toLowerCase() === 'h') setMode('pan');
});
$('#model-name').addEventListener('change', event => { if (!requireEdit()) return; model.name = event.target.value.trim() || 'Untitled plant'; commit(); });
$('#model-name').addEventListener('input', event => { if (!requireEdit()) return; model.name = event.target.value.trim() || 'Untitled plant'; commit(); });
function askReplace(title, action) { $('#confirm-title').textContent = title; confirmAction = action; $('#confirm-dialog').showModal(); }
$('#confirm-cancel').onclick = () => { confirmAction = null; $('#confirm-dialog').close(); };
$('#confirm-ok').onclick = () => { $('#confirm-dialog').close(); const action = confirmAction; confirmAction = null; action?.(); };
function flushVisibleDraft() {
  if (!canEdit()) return;
  if (!$('#model-name').disabled) model.name = $('#model-name').value.trim() || 'Untitled plant';
  if (activeTab === 'data' && !$('#view-data').classList.contains('hidden')) {
    for (const input of $$('[data-field]')) {
      const stream = model.streams.find(s => s.id === input.closest('tr').dataset.stream);
      if (stream) stream[input.dataset.field] = input.dataset.field === 'uncertaintyType' ? input.value : input.value === '' ? '' : Number(input.value);
    }
    if ($('#batch-period').value === 'custom') {
      const hours = Number($('#custom-hours').value);
      if (Number.isFinite(hours) && hours > 0) model.periodHours = hours;
    }
  }
  commit();
}
function activateManagedModel(entry, options = {}) {
  if (viewMode === 'editing') modelSessions.set(editingModelId, { history, historyIndex, results, activeRun, json: JSON.stringify(model) });
  viewMode = options.view || viewMode;
  editingModelId = entry.id; model = clone(viewMode === 'published' ? backend.permission(entry.id).published && entry.publishedModel || emptyModel() : entry.model); selection = null;
  const previous = modelSessions.get(entry.id), same = previous?.json === JSON.stringify(model);
  history = viewMode === 'editing' && same ? previous.history : [JSON.stringify(model)]; historyIndex = viewMode === 'editing' && same ? previous.historyIndex : 0;
  activeRun = viewMode === 'published' && !hasPublishedModel() ? null : management.latest(entry.id, { target: viewMode === 'published' ? 'published' : 'draft' });
  results = runResult(activeRun);
  editor.setPresentation(viewMode === 'published' ? 'published' : 'editing'); editor.setModel(model); editor.setResults(results); setMode('select');
  refreshChrome(); renderInspector(); if (!admin?.isOpen && !management.isOpen) switchTab('model'); editor.fit();
  const url = new URL(location.href); url.searchParams.set('view', viewMode);
  if (entry.id) url.searchParams.set('model', entry.id); else url.searchParams.delete('model');
  window.history.replaceState({}, '', url);
}
function acceptManagedRun(record) {
  if (record.modelId !== editingModelId || record.target !== (viewMode === 'published' ? 'published' : 'draft') || !sameRunInputs(record.modelSnapshot, model)) return;
  if (viewMode === 'published' && record.publishedVersion !== currentEntry()?.publishedVersion) return;
  activeRun = record; results = runResult(record); editor.setResults(results); refreshChrome(); renderInspector();
  if (activeTab === 'results' && !management.isOpen) renderResults();
}
function replaceModel(next) { if (!canCreate()) { toast('Your account cannot create models.'); return; } management.create(next); }
$('#open-published-view').onclick = () => openPage('published');
$('#open-editing-view').onclick = () => openPage('editing');
$('#menu-published').onclick = () => openPage('published');
$('#published-model-select').onchange = event => openPage('published', event.target.value);
$('#view-live-button').onclick = () => openPage('published');
$('#publish-draft-button').onclick = publishDraft;
$('#new-button').onclick = () => askReplace('Start a new model?', () => replaceModel(emptyModel()));
function loadDemo() { askReplace('Load the example model?', () => { replaceModel(exampleModel()); toast('Demo loaded: 3 measured streams and 1 unmetered stream.'); }); }
$('#demo-button').onclick = loadDemo; $('#empty-demo').onclick = loadDemo;
$('#help-button').onclick = () => $('#help-dialog').showModal();
$$('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } }));

function renderInspector() {
  const node = selection?.kind === 'node' ? model.nodes.find(n => n.id === selection.id) : null;
  const stream = selection?.kind === 'stream' ? model.streams.find(s => s.id === selection.id) : null;
  if (node) {
    const incoming = model.streams.filter(s => s.target === node.id), outgoing = model.streams.filter(s => s.source === node.id);
    $('#inspector').innerHTML = `<p class="eyebrow">SELECTED UNIT</p><h2>${esc(node.name)}</h2><span class="pill">${esc(NODE_TYPES[node.kind])}</span><p class="helper">${['inlet','outlet'].includes(node.kind) ? 'A model boundary. Conservation is enforced at process units inside the model.' : 'All incoming mass equals all outgoing mass. No accumulation is assumed.'}</p><div class="inspector-stats"><div><strong>${incoming.length}</strong><span>incoming</span></div><div><strong>${outgoing.length}</strong><span>outgoing</span></div></div><button class="button secondary full-width" id="inspect-edit-node">Edit unit</button><button class="text-button danger" id="inspect-delete">Delete selection</button><hr><h3>Connected streams</h3>${[...incoming,...outgoing].map(s => `<button class="stream-list-item" data-inspect-stream="${esc(s.id)}"><span>${esc(s.name)}</span><small>${isVirtualMeter(s) ? 'Ⓥ Virtual' : s.measured ? 'Ⓜ Measured' : 'Unmetered'}</small></button>`).join('') || '<p class="helper">Use Connect or drag a port to another unit.</p>'}`;
    $('#inspect-edit-node').onclick = () => openNode(node.id);
    if (viewMode === 'published') {
      const summary = getPublishedUnitSummary(node, model, results);
      const card = document.createElement('div'); card.className = 'published-unit-readout';
      card.innerHTML = `<span>${esc(summary.heading)}</span>${summary.lines.map(line => `<strong>${esc(line)}</strong>`).join('')}<p class="helper">${esc(summary.description)}</p>`;
      $('.inspector-stats').after(card);
    }
  } else if (stream) {
    const source = model.nodes.find(n => n.id === stream.source), target = model.nodes.find(n => n.id === stream.target); const rec = results?.streams.find(s => s.id === stream.id);
    const virtual = isVirtualMeter(stream), reading = virtual ? evaluateMeterReadings(model).get(stream.id) : null;
    $('#inspector').innerHTML = `<p class="eyebrow">SELECTED STREAM</p><h2>${esc(stream.name)}</h2><p class="connection-mini">${esc(source?.name)}<br><span>↓</span><br>${esc(target?.name)}</p><span class="pill">${virtual ? 'Ⓥ Virtual meter' : stream.measured ? 'Ⓜ Measured' : 'Unmetered'}</span><dl class="properties-list"><dt>Material</dt><dd>${esc(stream.material)}</dd><dt>Phase</dt><dd>${esc(stream.phase)}</dd><dt>Density</dt><dd>${fmt(Number(stream.density))} kg/m³</dd>${stream.measured ? `<dt>Meter</dt><dd>${esc(getMeterName(stream))}</dd>` : ''}${virtual ? `<dt>Formula</dt><dd>${esc(stream.formula || 'Not entered')}</dd>` : ''}<dt>Reading</dt><dd>${virtual ? reading?.error ? esc(reading.error) : `${fmt(reading?.value)} ${esc(stream.unit)}` : stream.measured ? `${stream.value === '' ? 'Not entered' : esc(stream.value)} ${esc(stream.unit)}` : 'To be inferred'}</dd>${rec ? `<dt>Reconciled</dt><dd>${fmt(rec.value)} kg</dd>` : ''}</dl><button class="button secondary full-width" id="inspect-edit-stream">Edit stream & meter</button><button class="text-button danger" id="inspect-delete">Delete selection</button>`;
    $('#inspect-edit-stream').onclick = () => openStream(stream.id);
    const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'button secondary full-width'; hide.id = 'inspect-line-visibility';
    const hidden = lineVisibility.snapshot().hiddenIds.includes(stream.id);
    hide.textContent = hidden ? 'Restore line' : 'Hide line';
    hide.onclick = () => { if (hidden) { lineVisibility.show(stream.id); applyLineVisibility(); } else hideLine(stream.id); };
    $('#inspect-edit-stream').before(hide);
    const note = document.createElement('p'); note.className = 'helper'; note.textContent = 'Line visibility changes your diagram view only. Hidden streams remain in the mass balance.'; hide.after(note);
  } else {
    $('#inspector').innerHTML = `<p class="eyebrow">A CLEARER PICTURE</p><h2>Every stream.<br>One balance.</h2><p class="helper">Build the physical model, add what you measure, then let conservation connect the dots.</p><ol class="mini-steps"><li><strong>Place units</strong><span>Drag from the toolbox.</span></li><li><strong>Connect flows</strong><span>Drag between connection ports.</span></li><li><strong>Add measurements</strong><span>Right-click a stream to add a meter.</span></li><li><strong>Enter data & run</strong><span>Review adjustments and inferred flows.</span></li></ol><div class="inspector-callout"><span class="boundary-glyph">▶</span><p>Red triangles mark where material enters and leaves your model.</p></div><button class="button secondary full-width" id="inspect-guide">Open quick guide</button><div class="scope-note">Workspace autosave is enabled.<br><span>Export a file for a portable copy.</span></div>`;
    $('#inspect-guide').onclick = () => $('#help-dialog').showModal();
    if (viewMode === 'published') {
      $('#inspector').innerHTML = `<p class="eyebrow">PUBLISHED MODEL</p><h2>Reconciled values.<br>At a glance.</h2><p class="helper">Each unit shows incoming and outgoing mass above its symbol. Lines show the reconciled value of each stream.</p><div class="published-unit-readout"><span>${esc(activeRun ? `Version ${currentEntry()?.publishedVersion} · ${activeRun.status}` : 'Awaiting reconciliation')}</span><p class="helper">${esc(activeRun?.result?.message || activeRun?.error || 'Run this published version to show its batch values.')}</p></div><p class="helper">All values are kg per batch. Inferred stream values are marked. A dash means the available measurements do not determine the value.</p><p class="helper">Select a unit or line for more detail. Draft edits stay in Model editor until published.</p>`;
    }
  }
  if ($('#inspect-delete')) $('#inspect-delete').onclick = () => editor.deleteSelection();
  for (const selector of ['#inspect-edit-node', '#inspect-edit-stream', '#inspect-delete']) {
    const button = $(selector);
    if (button) {
      button.disabled = !canEdit();
      button.title = canEdit() ? '' : 'Editing requires editor access and an unlocked model.';
    }
  }
  $$('[data-inspect-stream]').forEach(b => b.onclick = () => { editor.select('stream', b.dataset.inspectStream); if (canEdit()) openStream(b.dataset.inspectStream); });
}

const streamForm = $('#stream-form');
for (const [key, metric] of Object.entries(METRICS)) streamForm.elements.metric.add(new Option(metric.label, key));
function updateUnits(preferred) { const select = streamForm.elements.unit; select.replaceChildren(); for (const unit of METRICS[streamForm.elements.metric.value].units) select.add(new Option(unit,unit)); if (preferred && METRICS[streamForm.elements.metric.value].units.includes(preferred)) select.value = preferred; }
function streamFromForm(current) {
  const next = { ...current };
  for (const key of ['name','material','phase','metric','unit','uncertaintyType','meterType','meterName','formula']) next[key] = streamForm.elements[key].value.trim();
  for (const key of ['density','temperature','pressure','uncertainty']) next[key] = streamForm.elements[key].value === '' ? null : Number(streamForm.elements[key].value);
  next.measured = streamForm.elements.measured.checked;
  next.value = next.meterType === 'virtual' ? '' : streamForm.elements.value.value === '' ? '' : Number(streamForm.elements.value.value);
  return next;
}
function updateMeterPreview() {
  const current = model.streams.find(stream => stream.id === editingStream); if (!current) return;
  const virtual = streamForm.elements.meterType.value === 'virtual', enabled = streamForm.elements.measured.checked;
  $('#meter-fields').hidden = !enabled; $('#virtual-meter-fields').hidden = !virtual;
  $('#physical-reading-field').hidden = virtual; streamForm.elements.value.disabled = virtual || !enabled;
  $('#meter-uncertainty-label').textContent = virtual ? 'Calculation uncertainty (1σ)' : 'Uncertainty (1σ)';
  $('#meter-uncertainty-help').hidden = !virtual;
  streamForm.elements.meterName.placeholder = streamForm.elements.name.value || current.name;
  if (!virtual || !enabled) return;
  const next = streamFromForm(current), preview = $('#formula-preview');
  if (!next.formula) { preview.dataset.state = 'pending'; preview.textContent = 'Enter a formula to preview the calculated reading. You can save an incomplete formula and finish it later.'; return; }
  const readings = evaluateMeterReadings({ ...model, streams: model.streams.map(stream => stream.id === current.id ? next : stream) });
  const reading = readings.get(current.id);
  preview.dataset.state = reading?.error ? 'error' : 'ok';
  preview.textContent = reading?.error ? `${reading.error} Reconciliation needs a valid formula.` : `Calculated reading: ${fmt(reading?.value)} ${next.unit}`;
}
streamForm.elements.metric.onchange = () => { updateUnits(); updateMeterPreview(); };
streamForm.elements.measured.onchange = updateMeterPreview;
streamForm.elements.meterType.onchange = updateMeterPreview;
streamForm.addEventListener('input', updateMeterPreview);
streamForm.addEventListener('change', updateMeterPreview);
function openStream(id) {
  if (!requireEdit()) return;
  const stream = model.streams.find(s => s.id === id); if (!stream) return;
  editingStream = id;
  for (const key of ['name','material','phase','density','temperature','pressure','metric','value','uncertainty','uncertaintyType']) streamForm.elements[key].value = stream[key] ?? '';
  streamForm.elements.meterType.value = stream.meterType || 'physical'; streamForm.elements.meterName.value = stream.meterName || ''; streamForm.elements.formula.value = stream.formula || '';
  updateUnits(stream.unit); streamForm.elements.measured.checked = stream.measured;
  $('#formula-reference-list').innerHTML = model.streams.filter(other => other.measured && other.id !== id).map(other => `<button type="button" class="formula-reference" data-reference-id="${esc(other.id)}"><span>[${esc(getMeterName(other))}]</span><small>${esc(other.unit)}</small></button>`).join('') || '<p class="helper">Add another meter to reference its reading, or use a constant formula.</p>';
  $$('[data-reference-id]').forEach(button => button.onclick = () => {
    const other = model.streams.find(item => item.id === button.dataset.referenceId); if (!other) return;
    const field = streamForm.elements.formula, start = field.selectionStart, end = field.selectionEnd, reference = `[${getMeterName(other)}]`;
    if (field.value.length - (end - start) + reference.length > field.maxLength) return;
    field.setRangeText(reference, start, end, 'end'); field.focus(); updateMeterPreview();
  });
  $('.formula-references').open = false; updateMeterPreview();
  $('#stream-connection').textContent = `${model.nodes.find(n => n.id === stream.source)?.name} → ${model.nodes.find(n => n.id === stream.target)?.name}`;
  $('#stream-error').classList.add('hidden'); $('#stream-dialog').showModal();
}
streamForm.addEventListener('submit', event => {
  event.preventDefault(); if (!requireEdit()) return; const current = model.streams.find(s => s.id === editingStream); if (!current) return;
  const next = streamFromForm(current);
  try { validateEditableModel({ ...model, streams: model.streams.map(stream => stream.id === current.id ? next : stream) }); if (next.measured && !isVirtualMeter(next) && next.value !== '') measurementToMass(next, model.periodHours); }
  catch (error) { $('#stream-error').textContent = error.message; $('#stream-error').classList.remove('hidden'); return; }
  Object.assign(current,next); $('#stream-dialog').close(); editor.setModel(model); commit(); if (activeTab === 'data') renderData(); toast(`${next.name} saved${next.measured ? ' · meter added' : ''}.`);
});
$('#delete-stream').onclick = () => { editor.select('stream',editingStream); editor.deleteSelection(); $('#stream-dialog').close(); if (activeTab === 'data') renderData(); };
$('#hide-stream-line').onclick = () => { $('#stream-dialog').close(); hideLine(editingStream); };
function updateNodeNote() {
  const kind = $('#node-form').elements.kind.value;
  $('#node-note').textContent = isBoundary(kind) ? 'Red triangles mark the model boundary. Its inflow or outflow direction stays fixed.' : `${UNIT_SYMBOLS[kind].description.replace(/\.$/, '')}. The symbol describes this unit; all incoming mass equals all outgoing mass, with no storage or equipment-specific equations. Changing a symbol keeps its connections and readings.`;
}
function openNode(id) {
  if (!requireEdit()) return;
  const node = model.nodes.find(n => n.id === id); if (!node) return;
  editingNode = id;
  const form = $('#node-form'); form.elements.name.value = node.name;
  form.elements.kind.innerHTML = isBoundary(node.kind) ? `<option value="${node.kind}">${esc(NODE_TYPES[node.kind])}</option>` : Object.entries(UNIT_SYMBOLS).map(([kind, symbol]) => `<option value="${kind}">${esc(symbol.label)}</option>`).join('');
  form.elements.kind.value = node.kind; form.elements.kind.disabled = isBoundary(node.kind);
  updateNodeNote(); $('#node-dialog').showModal();
}
$('#node-form').elements.kind.onchange = updateNodeNote;
$('#node-form').onsubmit = event => {
  event.preventDefault(); if (!requireEdit()) return;
  const node = model.nodes.find(n => n.id === editingNode); if (!node) return;
  const form = $('#node-form'), kind = form.elements.kind.value;
  if (!isBoundary(node.kind) && Object.hasOwn(UNIT_SYMBOLS, kind)) node.kind = kind;
  node.name = form.elements.name.value.trim() || NODE_TYPES[node.kind];
  $('#node-dialog').close(); editor.setModel(model); commit();
};
$('#delete-node').onclick = () => { editor.select('node',editingNode); editor.deleteSelection(); $('#node-dialog').close(); };

function massSummary(stream, readings = evaluateMeterDetails(model)) {
  if (!stream.measured) return '<span class="muted">Inferred after run</span>';
  try {
    const virtual = isVirtualMeter(stream), reading = readings.get(stream.id);
    if (virtual && reading?.error) throw new Error(reading.error);
    const m = measurementToMass(virtual ? { ...stream, value: reading?.value } : stream, model.periodHours);
    const sigma = virtual ? reading?.sigma === null ? null : reading?.sigma * m.factor : m.sigma;
    return `<strong>${fmt(m.value)} kg</strong><small>${sigma === null ? 'Check source uncertainty' : `σ ${fmt(sigma)} kg${virtual ? ' · propagated' : ''}`}</small>`;
  } catch (error) { return `<span class="reading-error" title="${esc(error.message)}">${isVirtualMeter(stream) ? 'Check formula / inputs' : stream.value === '' ? 'Reading needed' : 'Check input'}</span>`; }
}
function refreshMeterReadouts() {
  const readings = evaluateMeterDetails(model);
  for (const row of $$('#measurement-rows [data-stream]')) {
    const stream = model.streams.find(item => item.id === row.dataset.stream); if (!stream) continue;
    $('.mass-summary', row).innerHTML = massSummary(stream, readings);
    if (isVirtualMeter(stream)) {
      const reading = readings.get(stream.id);
      $('.virtual-reading', row).textContent = `${fmt(reading?.value)} ${stream.unit}`;
      $('.virtual-formula-error', row).textContent = reading?.error || '';
    }
  }
}
function renderData() {
  $('#batch-period').value = [1,24].includes(Number(model.periodHours)) ? String(model.periodHours) : 'custom';
  $('#custom-hours-label').classList.toggle('hidden', [1,24].includes(Number(model.periodHours))); $('#custom-hours').value = model.periodHours;
  $('#sample-readings').hidden = !['f1','f3','f4'].every(id => model.streams.some(s => s.id === id));
  const readings = evaluateMeterDetails(model);
  $('#measurement-rows').innerHTML = model.streams.map(stream => {
    const source = model.nodes.find(n => n.id === stream.source), target = model.nodes.find(n => n.id === stream.target);
    const virtual = isVirtualMeter(stream), reading = readings.get(stream.id);
    return `<tr data-stream="${esc(stream.id)}"><td><button class="stream-name-button" data-edit="${esc(stream.id)}">${stream.measured ? `<span class="meter-dot">${virtual ? 'V' : 'M'}</span>` : '<span class="unmetered-dot">·</span>'}${esc(stream.name)}</button><small>${esc(stream.material)}${stream.measured && getMeterName(stream) !== stream.name ? ` · ${esc(getMeterName(stream))}` : ''}</small></td><td>${esc(source?.name)}<small>→ ${esc(target?.name)}</small></td><td>${stream.measured ? `${esc(METRICS[stream.metric]?.label)}<small>${esc(stream.unit)}${virtual ? ' · Virtual' : ''}</small>` : `<button class="button secondary compact" data-add-meter="${esc(stream.id)}">+ Add meter</button>`}</td><td>${virtual ? `<output class="virtual-reading" aria-label="${esc(getMeterName(stream))} calculated reading">${fmt(reading?.value)} ${esc(stream.unit)}</output><small class="virtual-formula">${esc(stream.formula || 'Formula needed')}</small><div class="reading-error virtual-formula-error">${esc(reading?.error)}</div>` : stream.measured ? `<input class="number-input" type="number" step="any" min="0" value="${esc(stream.value)}" data-field="value" aria-label="${esc(stream.name)} reading" placeholder="Enter value">` : '<span class="muted">Unmeasured</span>'}</td><td>${stream.measured ? `<div class="uncertainty-input"><input class="number-input" type="number" step="any" min="0.000001" value="${esc(stream.uncertainty)}" data-field="uncertainty" aria-label="${esc(stream.name)} ${virtual ? 'calculation uncertainty' : 'uncertainty'}"><select data-field="uncertaintyType" aria-label="${esc(stream.name)} uncertainty format"><option value="percent" ${stream.uncertaintyType === 'percent' ? 'selected' : ''}>%</option><option value="absolute" ${stream.uncertaintyType === 'absolute' ? 'selected' : ''}>${esc(stream.unit)}</option></select></div>${virtual ? '<small>Independent calculation error</small>' : ''}` : '—'}</td><td class="mass-summary">${massSummary(stream, readings)}</td></tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty-state"><h2>No streams yet.</h2><p>Connect units on the Flowsheet tab, then add meters to the streams you measure.</p><button class="button secondary" id="data-back">Build a flowsheet</button></div></td></tr>';
  $$('[data-edit]').forEach(button => button.onclick = () => openStream(button.dataset.edit));
  $$('[data-add-meter]').forEach(button => button.onclick = () => { openStream(button.dataset.addMeter); streamForm.elements.measured.checked = true; updateMeterPreview(); });
  $$('[data-field]').forEach(input => { const update = () => { if (!requireEdit()) return; const row = input.closest('tr'), stream = model.streams.find(s => s.id === row.dataset.stream); stream[input.dataset.field] = input.dataset.field === 'uncertaintyType' ? input.value : input.value === '' ? '' : Number(input.value); commit(); refreshMeterReadouts(); }; input.addEventListener('input', update); input.addEventListener('change', update); });
  if ($('#data-back')) $('#data-back').onclick = () => switchTab('model');
}
$('#batch-period').onchange = event => { if (!requireEdit()) return; if (event.target.value === 'custom') { $('#custom-hours-label').classList.remove('hidden'); $('#custom-hours').focus(); } else { model.periodHours = Number(event.target.value); commit(); renderData(); } };
$('#custom-hours').onchange = event => { if (!requireEdit()) return; const n = Number(event.target.value); if (Number.isFinite(n) && n > 0) { model.periodHours = n; commit(); renderData(); } else { toast('Batch duration must be greater than zero.'); event.target.value = model.periodHours; } };
$('#sample-readings').onclick = () => { if (!requireEdit()) return; for (const [id,value,uncertainty] of [['f1',100,1],['f3',60,2],['f4',35,2]]) { const stream = model.streams.find(s => s.id === id); if (stream && !isVirtualMeter(stream)) Object.assign(stream,{measured:true,metric:'mass',unit:'kg',value,uncertainty,uncertaintyType:'absolute'}); } editor.setModel(model); commit(); renderData(); toast('Example physical readings restored.'); };

async function run() {
  if (!backend.permission(editingModelId).canRun || (viewMode === 'published' && !hasPublishedModel())) { toast('Your account cannot run this model.'); return; }
  if ($('dialog[open]')) return;
  flushVisibleDraft();
  const targetId = editingModelId, target = viewMode === 'published' ? 'published' : 'draft', snapshot = clone(model), version = target === 'published' ? currentEntry()?.publishedVersion : null;
  runningWorkbench = true; $('#run-button').disabled = true; $('#data-run-button').disabled = true; $('#run-button').textContent = 'Reconciling…';
  try {
    const record = await management.run(targetId, { target });
    if (editingModelId === targetId && (viewMode === 'published' ? 'published' : 'draft') === target && sameRunInputs(model, snapshot) && sameRunInputs(record.modelSnapshot, snapshot) && (target !== 'published' || record.publishedVersion === version)) {
      activeRun = record; results = runResult(record);
      editor.setResults(results); switchTab(target === 'published' ? 'model' : 'results'); renderInspector(); editor.fit();
    }
  }
  catch (error) { toast(error.message || 'The model could not be reconciled.'); }
  finally { runningWorkbench = false; refreshChrome(); }
}
$('#run-button').onclick = run; $('#data-run-button').onclick = run;
function renderResults() {
  if (!results) { $('#view-results').innerHTML = '<div class="empty-state results-empty"><span class="empty-diagram">∑</span><p class="eyebrow">STEP 03 / RECONCILIATION</p><h1>Your balanced picture goes here.</h1><p>Enter your batch readings, then run reconciliation to compare measurements and estimate missing flows.</p><button class="button primary" id="results-run">▶ Run reconciliation</button><button class="text-button" id="results-data">Review measurements</button></div>'; $('#results-run').onclick = run; $('#results-data').onclick = () => switchTab('data'); return; }
  const good = ['ok','warning','underdetermined'].includes(results.status); const severe = ['invalid','infeasible'].includes(results.status); const warnings = results.warnings || []; const inferred = results.streams.filter(s => s.status === 'estimated').length; const unknown = results.streams.filter(s => s.status === 'unobservable').length;
  const balanced = results.balances.filter(b => b.reconciled !== null && Number.isFinite(b.reconciled)); const maxError = balanced.length ? Math.max(...balanced.map(b => Math.abs(b.reconciled))) : null;
  const heading = results.status === 'ok' ? 'Your mass balance is reconciled.' : results.status === 'underdetermined' ? 'Some flows need more information.' : results.status === 'warning' ? 'Balanced, with items to review.' : 'Check your model and inputs.';
  $('#view-results').innerHTML = `<div class="view-header"><div><p class="eyebrow">STEP 03 / RECONCILIATION</p><h1>${esc(heading)}</h1><p class="muted">${esc(model.name)} · ${fmt(Number(model.periodHours))}-hour batch · total mass in kg</p></div><div class="top-actions"><button class="button secondary" id="results-flowsheet">View on flowsheet</button>${good ? '<button class="button secondary" id="export-results">Export results ↓</button>' : ''}</div></div><div class="result-banner ${severe ? 'error' : results.status === 'ok' ? 'success' : 'warning'}"><span class="banner-icon">${severe ? '!' : results.status === 'ok' ? '✓' : '!'}</span><div><strong>${esc(results.message)}</strong>${warnings.length ? `<ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div></div>${good ? `<div class="summary-grid"><div class="summary-card"><span>Largest closing error</span><strong>${fmt(maxError)} <small>kg</small></strong><p>Across ${balanced.length} observable process units</p></div><div class="summary-card"><span>Weighted adjustment</span><strong>${fmt(results.objective)}</strong><p>Squared residuals weighted by uncertainty</p></div><div class="summary-card"><span>Inferred streams</span><strong>${inferred}<small> / ${model.streams.filter(s => !s.measured).length}</small></strong><p>${unknown ? `${unknown} unresolved stream${unknown === 1 ? '' : 's'}` : 'Unique estimates where observable'}</p></div></div><div class="table-heading"><h2>Stream results</h2><span class="helper">All values normalized to kg per batch</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Stream / material</th><th>Input mass</th><th>Reconciled</th><th>Adjustment</th><th>Estimate uncertainty (1σ)</th><th>Status</th></tr></thead><tbody>${results.streams.map(s => {const original = model.streams.find(v => v.id === s.id); return `<tr><td><button class="stream-name-button" data-result-stream="${esc(s.id)}">${esc(original?.name || s.id)}</button><small>${esc(original?.material)}</small></td><td class="mono">${fmt(s.raw)}</td><td class="mono result-number">${fmt(s.value)}</td><td class="mono">${s.correction !== null && s.correction !== undefined && s.correction > 0 ? '+' : ''}${fmt(s.correction)}</td><td class="mono">${fmt(s.uncertainty)}${s.atBound ? '<small>At physical bound</small>' : ''}</td><td><span class="status-pill ${s.status}">${s.status === 'unobservable' ? 'Needs measurement' : s.atBound ? 'At zero bound' : s.status === 'estimated' ? 'Inferred' : 'Reconciled'}</span></td></tr>`;}).join('')}</tbody></table></div><div class="table-heading"><h2>Unit balance checks</h2><span class="helper">Incoming mass − outgoing mass</span></div><div class="table-wrap"><table class="data-table balance-table"><thead><tr><th>Process unit</th><th>Before reconciliation</th><th>After reconciliation</th></tr></thead><tbody>${results.balances.map(b => `<tr><td>${esc(b.name)}</td><td class="mono">${fmt(b.raw)} kg</td><td class="mono">${fmt(b.reconciled)} kg</td></tr>`).join('')}</tbody></table></div><div class="result-method"><strong>How this result is calculated</strong><p>Measurements are adjusted using nonnegative, constrained generalized least squares. Every process unit conserves total mass with zero accumulation. Missing flows are reported only when uniquely determined. Physical reading errors and each virtual meter's calculation error are assumed independent and unbiased. Shared meter references use first-order covariance propagation; conversion properties stay fixed. Active bounds limit the usual Gaussian uncertainty interpretation.</p><p>A closed balance does not prove instrument accuracy. Raw values are preserved; corrections and diagnostics should be reviewed before using results for reporting.</p></div>` : '<button class="button secondary" id="results-fix-data">Review measurements</button>'}`;
  if ($('#results-flowsheet')) $('#results-flowsheet').onclick = () => { switchTab('model'); editor.fit(); };
  if ($('#results-fix-data')) $('#results-fix-data').onclick = () => switchTab('data');
  if ($('#export-results')) $('#export-results').onclick = exportResults;
  $$('[data-result-stream]').forEach(b => b.onclick = () => { switchTab('model'); editor.select('stream', b.dataset.resultStream); });
}
function download(filename, text, type) { const url = URL.createObjectURL(new Blob([text], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
function safeFilename() { return model.name.replace(/[^a-z0-9_-]+/gi,'-').slice(0,70) || 'plant-model'; }
$('#export-button').onclick = () => { flushVisibleDraft(); download(`${safeFilename()}.json`,JSON.stringify(model,null,2),'application/json'); toast('Model exported with stream properties and measurements.'); };
$('#auth-export-draft').onclick = () => {
  const draft = backend.failedDraft();
  if (draft) download('unsaved-plant-model.json', JSON.stringify(draft, null, 2), 'application/json');
};
$('#import-button').onclick = () => $('#import-file').click();
$('#import-file').onchange = async event => { const file = event.target.files[0]; event.target.value = ''; if (!file) return; try { if (file.size > 2e6) throw new Error('Choose a model file smaller than 2 MB.'); const loaded = validateEditableModel(JSON.parse(await file.text())); askReplace('Import this plant model?', () => { replaceModel(loaded); toast('Model imported.'); }); } catch (error) { toast(`Import failed: ${error.message}`); } };
function exportResults() { const cell = value => { let text = String(value ?? ''); if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g,'""')}"`; }; const rows = [['Stream','Material','Measured kg','Reconciled kg','Adjustment kg','Standard uncertainty kg','Status']]; for (const s of results.streams) { const stream = model.streams.find(v => v.id === s.id); rows.push([stream?.name,stream?.material,s.raw,s.value,s.correction,s.uncertainty,s.status]); } download(`${safeFilename()}-results.csv`,rows.map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8'); }
activateManagedModel(management.current(), { view: viewMode });
requestAnimationFrame(() => editor.fit());
