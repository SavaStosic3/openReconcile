import { createCatalog, validateCatalog, getModelEntry, addModel, updateModel, duplicateModel, setActiveModel, setSchedule, dueSchedules, advanceSchedule, appendRun, frequencyToMinutes } from './management-store.js';
import { executeModelRun, sameRunInputs, runMatchesModelInputs, runMatchesInputSource } from './schedule-runner.js';

const CATALOG_KEY = 'openreconcile-model-library-v1';
const LEGACY_KEY = 'massflow-model-v1';
const LOCK_KEY = 'openreconcile-scheduler';
const clone = value => structuredClone(value);
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const number = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value) : '—';

export function createManagement({ fallbackModel, beforeAction, onActivate, onRun, onNewModel, onReview, onToast, onAccessChange, backend = null, inputAdapters = {}, outputAdapters = {} }) {
  let catalog, selectedId, pageOpen = false, tickBusy = false, storageWarning = '', lastStored = null, renderedRuns = '';
  const running = new Set();
  const now = () => Date.now();
  if (backend) catalog = validateCatalog(backend.workspace.catalog);
  else try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (raw) catalog = validateCatalog(JSON.parse(raw));
    else {
      const legacy = localStorage.getItem(LEGACY_KEY);
      catalog = createCatalog(legacy ? JSON.parse(legacy) : fallbackModel, { id: crypto.randomUUID(), now: now() });
    }
    if (!catalog.models.length) catalog = createCatalog(fallbackModel, { id: crypto.randomUUID(), now: now() });
    lastStored = localStorage.getItem(CATALOG_KEY);
  } catch (error) {
    catalog = createCatalog(fallbackModel, { id: crypto.randomUUID(), now: now() });
    storageWarning = 'Saved models could not be restored. Your original browser data is retained; export this model before clearing storage.';
  }
  selectedId = catalog.activeId;
  let editorBaseline = JSON.stringify(catalog.activeId ? getModelEntry(catalog).model : fallbackModel);

  function save(next, required = false) {
    if (storageWarning) {
      if (required) throw new Error(storageWarning);
      catalog = next;
      return false;
    }
    try {
      const raw = JSON.stringify(next);
      localStorage.setItem(CATALOG_KEY, raw);
      lastStored = raw;
      catalog = next;
      return true;
    } catch {
      const message = 'Browser storage is full or unavailable. Export your models; schedules cannot be saved reliably.';
      if (required) throw new Error(message);
      catalog = next;
      return false;
    }
  }
  if (!backend) save(catalog);

  function pullShared() {
    if (backend) { catalog = validateCatalog(backend.workspace.catalog); return; }
    if (storageWarning) return;
    try {
      const raw = localStorage.getItem(CATALOG_KEY);
      if (!raw || raw === lastStored) return;
      const shared = validateCatalog(JSON.parse(raw));
      if (shared.models.some(entry => entry.id === catalog.activeId)) shared.activeId = catalog.activeId;
      catalog = shared;
      lastStored = raw;
      if (!catalog.models.some(entry => entry.id === selectedId)) selectedId = catalog.activeId;
    } catch {
      storageWarning = 'Browser data could not be read. Export your draft before reopening the app; scheduling is paused.';
      onToast?.(storageWarning);
    }
  }

  function message(text, error = false) {
    $('#schedule-error').classList.toggle('hidden', !error);
    $('#schedule-error').textContent = error ? text : '';
    $('#schedule-message').textContent = error ? '' : text;
  }
  function closeMenu(returnFocus = false) {
    $('#app-menu').hidden = true;
    $('#menu-button').setAttribute('aria-expanded', 'false');
    if (returnFocus) $('#menu-button').focus();
  }
  function openManagement() {
    beforeAction?.();
    closeMenu();
    pageOpen = true;
    if (backend) $('#workspace-empty').hidden = true;
    selectedId = catalog.activeId;
    document.querySelectorAll('[role="tabpanel"]').forEach(view => view.classList.add('hidden'));
    $('#workflow-nav').classList.add('hidden');
    $('#view-management').classList.remove('hidden');
    document.body.classList.add('is-management');
    $('#model-name').disabled = true;
    $('#run-button').hidden = true;
    $('#help-button').hidden = true;
    render(true);
    $('#management-heading').focus();
  }
  function leaveManagement() {
    closeMenu();
    pageOpen = false;
    $('#view-management').classList.add('hidden');
    $('#workflow-nav').classList.remove('hidden');
    document.body.classList.remove('is-management');
    $('#model-name').disabled = false;
    $('#run-button').hidden = false;
    $('#help-button').hidden = false;
  }
  function activate(id, options = {}) {
    if (typeof options === 'boolean') options = { flush: options };
    const { flush = true, view } = options;
    if (view !== undefined && !['published', 'editing'].includes(view)) throw new Error('Choose the published model or model editor.');
    if (backend) return (async () => {
      if (flush) beforeAction?.();
      await backend.flush();
      backend.select(id); pullShared(); selectedId = id;
      leaveManagement();
      onActivate?.(clone(id ? getModelEntry(catalog, id) : { id: null, model: fallbackModel }), view ? { view } : undefined);
      return true;
    })().catch(error => { onToast?.(error.message); return false; });
    if (flush) beforeAction?.();
    pullShared();
    save(setActiveModel(catalog, id));
    editorBaseline = JSON.stringify(getModelEntry(catalog, id).model);
    selectedId = id;
    leaveManagement();
    onActivate?.(clone(getModelEntry(catalog, id)), view ? { view } : undefined);
    return true;
  }
  function sourceOptions(direction, selection) {
    const select = $(`#schedule-${direction}`);
    select.replaceChildren(new Option(direction === 'input' ? 'Saved model measurements' : 'Save run results', ''));
    const sources = catalog.sources[selectedId].filter(source => [direction, 'both'].includes(source.direction));
    for (const source of sources) {
      const key = source.adapterKey ?? source.adapter ?? source.type;
      const adapters = direction === 'input' ? inputAdapters : outputAdapters;
      const supported = (backend && source.type === 'sql') || (Object.hasOwn(adapters, key) && typeof adapters[key] === 'function');
      const option = new Option(`${source.name}${supported ? '' : ' · adapter unavailable'}`, source.id);
      option.disabled = !supported;
      select.add(option);
    }
    select.value = selection || '';
    $(`#schedule-${direction}-help`).textContent = sources.length
      ? 'SQL sources use the server’s configured gateway. Input fetches fresh batch readings; output writes reconciled results. These choices also apply to manual runs.'
      : direction === 'input' ? 'No input connector configured. Runs use the model’s saved readings.' : backend ? 'No output connector configured. Results are saved in the workspace run history.' : 'No output connector configured. Results are saved in this browser’s run history.';
  }
  function cadence(minutes) {
    if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
    if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
    return { value: minutes, unit: 'minutes' };
  }
  function frequency(minutes) {
    const { value, unit } = cadence(minutes);
    return `Every ${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
  }
  function runTarget(entry, run) {
    if (['draft', 'published'].includes(run.target)) return run.target;
    if (!backend) return 'draft';
    // The first publication can adopt a legacy run only when its exact model
    // snapshot matches. Untagged runs never become results for an edited draft.
    if (entry.publishedVersion === 1 && entry.publishedModel && sameRunInputs(run.modelSnapshot, entry.publishedModel)) return 'published';
    return null;
  }
  function matchesRun(entry, run, target) {
    if (runTarget(entry, run) !== target) return false;
    const snapshot = target === 'published' ? entry.publishedModel : entry.model;
    if (!snapshot || !runMatchesModelInputs(run, snapshot) || !runMatchesInputSource(run, catalog.sources[entry.id], catalog.schedules[entry.id])) return false;
    return target !== 'published' || run.publishedVersion === entry.publishedVersion || (run.target === undefined && entry.publishedVersion === 1);
  }
  function render(form = false) {
    if (!pageOpen) return;
    if (backend) {
      $('#management-role-label').textContent = backend.user.role === 'admin' ? 'Administrator' : backend.user.role;
      $('#management-new-model').disabled = !['admin', 'editor'].includes(backend.user.role);
    }
    if (!selectedId || !catalog.models.some(entry => entry.id === selectedId)) {
      $('#management-model').replaceChildren(new Option('No models assigned', ''));
      $('#management-model-count').textContent = 'No models assigned to your account';
      $('#schedule-form').querySelectorAll('input, select, button').forEach(control => control.disabled = true);
      $('#management-open-model').disabled = true;
      $('#management-view-published').disabled = true;
      $('#management-duplicate-model').disabled = true;
      if (backend) {
        $('#model-publication-button').hidden = true;
        $('#model-publication-button').disabled = true;
        $('#model-unpublish-button').hidden = true;
        $('#model-unpublish-button').disabled = true;
        $('#model-publication-state').textContent = 'No model selected';
        $('#model-access-note').textContent = 'Select or create a model to manage its publication and access.';
      }
      $('#schedule-summary-state').textContent = 'No model selected';
      $('#schedule-summary-state').classList.remove('is-enabled');
      $('#schedule-summary-frequency').textContent = '—';
      $('#schedule-summary-input').textContent = '—';
      $('#schedule-summary-output').textContent = '—';
      $('#schedule-enabled').checked = false;
      $('#schedule-interval').value = '';
      $('#schedule-input').replaceChildren(new Option('No model selected', ''));
      $('#schedule-output').replaceChildren(new Option('No model selected', ''));
      $('#schedule-input-help').textContent = '';
      $('#schedule-output-help').textContent = '';
      renderedRuns = '';
      $('#schedule-next-run').textContent = 'No upcoming run';
      $('#schedule-last-run').textContent = 'No runs yet';
      $('#management-runs').innerHTML = '<div class="management-runs-empty"><h3>No model selected</h3><p>Create a model or ask an administrator for access.</p></div>';
      return;
    }
    const entry = getModelEntry(catalog, selectedId), schedule = catalog.schedules[selectedId];
    if (backend) {
      const permission = backend.permission(selectedId);
      $('#management-role-label').textContent = backend.user.role === 'admin' ? 'Administrator' : backend.user.role;
      $('#management-new-model').disabled = !['admin', 'editor'].includes(backend.user.role);
      $('#management-open-model').disabled = !permission.canEdit;
      $('#management-view-published').disabled = !permission.published || !entry.publishedModel;
      $('#management-duplicate-model').disabled = !['admin', 'editor'].includes(backend.user.role);
      $('#schedule-form').querySelectorAll('input, select, button').forEach(control => control.disabled = !permission.canSchedule);
      $('#schedule-run-now').disabled = !permission.canRun || running.has(selectedId);
      $('#model-publication-state').textContent = permission.published ? entry.hasUnpublishedChanges ? 'Published · draft changes' : 'Published' : 'Draft';
      $('#model-publication-button').textContent = permission.published ? 'Publish changes' : 'Publish model';
      $('#model-publication-button').hidden = !permission.canPublish || (permission.published && !entry.hasUnpublishedChanges);
      $('#model-publication-button').disabled = !permission.canPublish || (permission.published && !entry.hasUnpublishedChanges);
      $('#model-unpublish-button').hidden = !permission.published || !permission.canUnpublish;
      $('#model-unpublish-button').disabled = !permission.published || !permission.canUnpublish;
      $('#model-access-note').textContent = permission.editLocked ? 'Draft editing is locked by an administrator.' : permission.canEdit ? 'Draft changes do not affect the published model until you publish them.' : 'Read-only model access.';
      if (!permission.published) $('#model-access-note').textContent += ' Publish the model before enabling a schedule.';
    }
    if (form) {
      const select = $('#management-model');
      select.replaceChildren(...catalog.models.map(item => new Option(`${item.model.name}${item.hasUnpublishedChanges ? ' · draft changes' : ''}`, item.id)));
      select.value = selectedId;
      const choice = cadence(schedule.intervalMinutes);
      $('#schedule-enabled').checked = schedule.enabled;
      $('#schedule-interval').value = choice.value;
      $('#schedule-unit').value = choice.unit;
      sourceOptions('input', schedule.inputSourceId);
      sourceOptions('output', schedule.outputSourceId);
      message(storageWarning, Boolean(storageWarning));
    }
    $('#management-model-count').textContent = `${catalog.models.length} saved model${catalog.models.length === 1 ? '' : 's'} · ${entry.model.streams.length} streams in this model`;
    $('#schedule-summary-state').textContent = running.has(selectedId) ? 'Running' : schedule.enabled ? 'Enabled' : 'Not scheduled';
    $('#schedule-summary-state').classList.toggle('is-enabled', schedule.enabled);
    $('#schedule-next-run').textContent = schedule.enabled ? date(schedule.nextRunAt) : 'No upcoming run';
    $('#schedule-summary-frequency').textContent = frequency(schedule.intervalMinutes);
    $('#schedule-summary-input').textContent = catalog.sources[selectedId].find(source => source.id === schedule.inputSourceId)?.name || 'Saved model measurements';
    $('#schedule-summary-output').textContent = catalog.sources[selectedId].find(source => source.id === schedule.outputSourceId)?.name || 'Save run results';
    $('#schedule-timezone').textContent = `Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Daily means every 24 hours.`;
    const runs = catalog.runs[selectedId];
    $('#schedule-last-run').textContent = runs.length ? `${date(runs.at(-1).finishedAt)} · ${runs.at(-1).status}` : 'No runs yet';
    $('#schedule-run-now').disabled = running.has(selectedId) || (backend && !backend.permission(selectedId).canRun);
    const runSignature = JSON.stringify([selectedId, runs]);
    if (renderedRuns === runSignature) return;
    renderedRuns = runSignature;
    if (!runs.length) {
      $('#management-runs').innerHTML = '<div class="management-runs-empty"><h3>No runs yet</h3><p>Run a reconciliation to see its status and results here.</p></div>';
    } else {
      $('#management-runs').innerHTML = `<div class="table-wrap"><table class="management-runs-table"><thead><tr><th>Run time</th><th>Model</th><th>Trigger</th><th>Status</th><th>Result</th></tr></thead><tbody>${[...runs].reverse().slice(0, 10).map(run => `<tr><td>${esc(date(run.startedAt))}</td><td>${runTarget(entry, run) === 'published' ? `Published v${esc(run.publishedVersion ?? 1)}` : runTarget(entry, run) === 'draft' ? 'Draft test' : 'Legacy run'}</td><td>${run.trigger === 'scheduled' ? 'Scheduled' : 'Manual'}</td><td><span class="status-pill ${run.status === 'ok' ? 'estimated' : run.status === 'failed' || run.status === 'invalid' ? 'unobservable' : ''}">${esc(run.status)}</span></td><td>${run.error ? esc(run.error) : `<span>${esc(run.result?.message || 'Completed')}</span><details><summary>Stream results</summary><ul>${(run.result?.streams || []).map(stream => `<li>${esc(run.modelSnapshot?.streams.find(item => item.id === stream.id)?.name || stream.id)}: ${number(stream.value)} kg · ${esc(stream.status)}</li>`).join('')}</ul></details><button type="button" class="text-button" data-review-run="${esc(run.id)}">View on diagram</button>`}</td></tr>`).join('')}</tbody></table></div>`;
      $('#management-runs').querySelectorAll('[data-review-run]').forEach(button => button.onclick = async () => {
        const run = catalog.runs[selectedId].find(item => item.id === button.dataset.reviewRun);
        const current = getModelEntry(catalog, selectedId), target = runTarget(current, run);
        if (!target || !matchesRun(current, run, target)) {
          message('This model version has changed since that run. The saved stream results are available above; run again for the current diagram.', true);
          return;
        }
        if (await activate(selectedId, { view: target === 'published' ? 'published' : 'editing' })) onReview?.(clone(run));
      });
    }
  }

  async function execute(id, trigger = 'manual', { target = trigger === 'scheduled' ? 'published' : 'draft' } = {}) {
    if (!['published', 'draft'].includes(target)) throw new Error('Choose a published reconciliation or a draft test.');
    if (running.has(id)) throw new Error('This model is already running.');
    running.add(id);
    render();
    try {
      pullShared();
      if (backend) {
        const run = await backend.execute(id, trigger, { target });
        pullShared(); onRun?.(clone(run)); return run;
      }
      const { run } = await executeModelRun(clone(catalog), id, { trigger, now, id: crypto.randomUUID(), inputAdapters, outputAdapters });
      pullShared();
      if (!save(appendRun(catalog, id, run, { limit: 20 }))) onToast?.('Run completed, but browser storage is unavailable. Export your model and results to keep them.');
      onRun?.(clone(run));
      return run;
    } finally {
      running.delete(id);
      render();
    }
  }
  async function withLock(action, skipBusy = false) {
    if (navigator.locks?.request) {
      return navigator.locks.request(LOCK_KEY, { ...(skipBusy ? { ifAvailable: true } : {}) }, lock => lock ? action() : null);
    }
    return action();
  }
  async function tick() {
    if (tickBusy || storageWarning) return;
    tickBusy = true;
    try {
      if (backend) {
        if (Date.now() - lastRefresh > 15_000) { lastRefresh = Date.now(); await backend.refresh(); }
        pullShared();
        for (const due of dueSchedules(catalog, backend.now())) {
          const permission = backend.permission(due.modelId);
          if (!permission.published || !permission.canRun || running.has(due.modelId)) continue;
          try { await execute(due.modelId, 'scheduled'); }
          catch (error) { if (error.status !== 409) message(error.message, true); }
        }
        render(); return;
      }
      await withLock(async () => {
        // Read shared schedules/history inside the browser lock. Keep unsaved
        // editor data out of the scheduling path; app edits save synchronously.
        pullShared();
        for (const due of dueSchedules(catalog, now())) {
          if (running.has(due.modelId)) continue;
          save(advanceSchedule(catalog, due.modelId, now()), true);
          const run = await execute(due.modelId, 'scheduled');
          save(advanceSchedule(catalog, due.modelId, now()), true);
          if (run.status === 'failed' || run.status === 'invalid') message(`Scheduled run needs attention: ${run.error || run.result?.message}`, true);
        }
        render();
      }, true);
    } catch (error) {
      message(error.message, true);
    } finally { tickBusy = false; }
  }

  $('#menu-button').onclick = () => {
    const opening = $('#app-menu').hidden;
    $('#app-menu').hidden = !opening;
    $('#menu-button').setAttribute('aria-expanded', String(opening));
    if (opening) $('#menu-published').focus();
  };
  document.addEventListener('click', event => { if (!event.target.closest('.application-navigation')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#app-menu').hidden) { event.preventDefault(); closeMenu(true); } });
  document.addEventListener('focusin', event => { if (!event.target.closest('.application-navigation')) closeMenu(); });
  const open = () => backend ? (async () => { beforeAction?.(); await backend.flush(); pullShared(); openManagement(); })().catch(error => onToast?.(error.message)) : openManagement();
  $('#menu-model-management').onclick = open;
  $('#menu-workbench').onclick = () => activate(catalog.activeId, { view: 'editing' });
  $('#management-back').onclick = () => activate(catalog.activeId);
  $('#management-model').onchange = event => { selectedId = event.target.value; render(true); };
  $('#management-open-model').onclick = () => {
    if (backend && !backend.permission(selectedId).canEdit) { message('You do not have permission to edit this model.', true); return; }
    return activate(selectedId, { view: 'editing' });
  };
  $('#management-view-published').onclick = () => {
    if (backend && !backend.permission(selectedId).published) { message('Publish this model before opening its live diagram.', true); return; }
    return activate(selectedId, { view: 'published' });
  };
  $('#management-new-model').onclick = () => onNewModel?.();
  $('#management-duplicate-model').onclick = () => {
    if (backend) return (async () => {
      beforeAction?.(); await backend.flush(); pullShared();
      const activeId = catalog.activeId, source = clone(getModelEntry(catalog, selectedId).model);
      source.name = `${source.name.slice(0, 153)} (copy)`;
      const entry = await backend.create(source);
      backend.select(activeId); pullShared(); selectedId = entry.id;
      render(true); message('Model duplicated as a draft with scheduling disabled.');
    })().catch(error => message(error.message, true));
    beforeAction?.();
    pullShared();
    const activeId = catalog.activeId, copyId = crypto.randomUUID();
    save(setActiveModel(duplicateModel(catalog, selectedId, { id: copyId, now: now(), name: `${getModelEntry(catalog, selectedId).model.name.slice(0, 153)} (copy)` }), activeId));
    selectedId = copyId;
    render(true);
    message('Model duplicated. Its schedule starts disabled.');
  };
  $('#schedule-form').onsubmit = async event => {
    event.preventDefault();
    try {
      beforeAction?.();
      pullShared();
      const intervalMinutes = frequencyToMinutes(Number($('#schedule-interval').value), $('#schedule-unit').value);
      if (backend) {
        await backend.schedule(selectedId, { enabled: $('#schedule-enabled').checked, intervalMinutes, inputSourceId: $('#schedule-input').value || null, outputSourceId: $('#schedule-output').value || null });
        pullShared(); render(true); message('Schedule saved. Scheduled runs require an open, authorized browser session.'); return;
      }
      save(setSchedule(catalog, selectedId, { enabled: $('#schedule-enabled').checked, intervalMinutes, inputSourceId: $('#schedule-input').value || null, outputSourceId: $('#schedule-output').value || null }, now()), true);
      render(true);
      message('Schedule saved. Scheduled runs require an open browser session.');
    } catch (error) { message(error.message, true); }
  };
  $('#schedule-run-now').onclick = async () => {
    const targetId = selectedId;
    try { beforeAction?.(); const target = backend?.permission(targetId).published ? 'published' : 'draft'; const run = await withLock(() => execute(targetId, 'manual', { target })); if (selectedId === targetId) message(run.error || run.result?.message || 'Run completed.', run.status === 'failed' || run.status === 'invalid'); }
    catch (error) { message(error.message, true); }
  };
  if (backend) $('#model-publication-button').onclick = async () => {
    const targetId = selectedId;
    try { beforeAction?.(); await backend.publication(targetId, true); pullShared(); render(true); message('Draft published. Live reconciliation uses this published version.'); }
    catch (error) { message(error.message, true); }
  };
  if (backend) $('#model-unpublish-button').onclick = async () => {
    const targetId = selectedId;
    try { beforeAction?.(); await backend.publication(targetId, false); pullShared(); render(true); message('Model unpublished. Its draft remains available in Model editor.'); }
    catch (error) { message(error.message, true); }
  };
  let lastRefresh = Date.now();
  const unsubscribe = backend?.subscribe(reason => {
    const previous = catalog.activeId ? catalog.models.find(entry => entry.id === catalog.activeId) : null;
    pullShared();
    if (!catalog.models.some(entry => entry.id === selectedId)) selectedId = catalog.activeId;
    if (reason === 'refresh') {
      const current = catalog.activeId ? getModelEntry(catalog) : { id: null, model: fallbackModel };
      if (previous?.id !== current.id || JSON.stringify(previous?.model) !== JSON.stringify(current.model) || JSON.stringify(previous?.publishedModel) !== JSON.stringify(current.publishedModel) || previous?.publishedVersion !== current.publishedVersion) onActivate?.(clone(current));
    }
    onAccessChange?.(reason); render();
  });
  const timer = setInterval(tick, 1000);
  const resume = () => { if (!document.hidden) tick(); };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  setTimeout(tick, 100);
  if (storageWarning) setTimeout(() => onToast?.(storageWarning), 100);

  return {
    get activeId() { return catalog.activeId; },
    get isOpen() { return pageOpen; },
    current: () => clone(catalog.activeId ? getModelEntry(catalog) : { id: null, model: fallbackModel }),
    saveCurrent(value) {
      if (backend) return catalog.activeId ? backend.queueSave(catalog.activeId, value) : Promise.resolve(false);
      pullShared();
      if (JSON.stringify(getModelEntry(catalog).model) !== editorBaseline) {
        onToast?.('This model changed in another tab. Export your draft, then reopen the model from Model Management.');
        return false;
      }
      const saved = save(updateModel(catalog, catalog.activeId, value, now()));
      editorBaseline = JSON.stringify(getModelEntry(catalog).model);
      if (pageOpen) render();
      return saved;
    },
    create(value) {
      if (backend) return (async () => { beforeAction?.(); const entry = await backend.create(value); pullShared(); return activate(entry.id, { flush: false, view: 'editing' }); })().catch(error => onToast?.(error.message));
      beforeAction?.(); pullShared(); save(addModel(catalog, value, { id: crypto.randomUUID(), now: now() })); activate(catalog.activeId, { flush: false, view: 'editing' });
    },
    latest(id = catalog.activeId, { target = 'draft' } = {}) { if (!id) return null; const entry = getModelEntry(catalog, id); return clone([...catalog.runs[id]].reverse().find(run => matchesRun(entry, run, target)) || null); },
    publishedEntries: () => clone(catalog.models.filter(entry => entry.publishedModel && (!backend || backend.permission(entry.id).published))),
    activate,
    run(id = catalog.activeId, { target = 'draft' } = {}) { return withLock(() => execute(id, 'manual', { target })); },
    leave: leaveManagement,
    open,
    tick,
    destroy() { unsubscribe?.(); clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('pageshow', resume); }
  };
}
