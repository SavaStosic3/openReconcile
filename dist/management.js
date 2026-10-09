import { createCatalog, validateCatalog, getModelEntry, addModel, updateModel, duplicateModel, setActiveModel, setSchedule, dueSchedules, advanceSchedule, appendRun, frequencyToMinutes } from './management-store.js';
import { executeModelRun } from './schedule-runner.js';

const CATALOG_KEY = 'openreconcile-model-library-v1';
const LEGACY_KEY = 'massflow-model-v1';
const LOCK_KEY = 'openreconcile-scheduler';
const clone = value => structuredClone(value);
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const number = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value) : '—';

export function createManagement({ fallbackModel, beforeAction, onActivate, onRun, onNewModel, onReview, onToast, inputAdapters = {}, outputAdapters = {} }) {
  let catalog, selectedId, pageOpen = false, tickBusy = false, storageWarning = '', lastStored = null, renderedRuns = '';
  const running = new Set();
  const now = () => Date.now();
  try {
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
  let editorBaseline = JSON.stringify(getModelEntry(catalog).model);

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
  save(catalog);

  function pullShared() {
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
  function activate(id, flush = true) {
    if (flush) beforeAction?.();
    pullShared();
    save(setActiveModel(catalog, id));
    editorBaseline = JSON.stringify(getModelEntry(catalog, id).model);
    selectedId = id;
    leaveManagement();
    onActivate?.(clone(getModelEntry(catalog, id)));
  }
  function sourceOptions(direction, selection) {
    const select = $(`#schedule-${direction}`);
    select.replaceChildren(new Option(direction === 'input' ? 'Saved model measurements' : 'Save run results', ''));
    const sources = catalog.sources[selectedId].filter(source => [direction, 'both'].includes(source.direction));
    for (const source of sources) {
      const key = source.adapterKey ?? source.adapter ?? source.type;
      const adapters = direction === 'input' ? inputAdapters : outputAdapters;
      const supported = Object.hasOwn(adapters, key) && typeof adapters[key] === 'function';
      const option = new Option(`${source.name}${supported ? '' : ' · adapter unavailable'}`, source.id);
      option.disabled = !supported;
      select.add(option);
    }
    select.value = selection || '';
    $(`#schedule-${direction}-help`).textContent = sources.length
      ? 'Choose a defined source. Sources require a supported adapter to run.'
      : direction === 'input' ? 'No external input sources defined. Uses this model’s saved readings; no new plant data is fetched.' : 'No external output destinations defined. Results are saved in this browser’s model history.';
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
  function render(form = false) {
    if (!pageOpen) return;
    const entry = getModelEntry(catalog, selectedId), schedule = catalog.schedules[selectedId];
    if (form) {
      const select = $('#management-model');
      select.replaceChildren(...catalog.models.map(item => new Option(item.model.name, item.id)));
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
    $('#schedule-run-now').disabled = running.has(selectedId);
    const runSignature = JSON.stringify([selectedId, runs]);
    if (renderedRuns === runSignature) return;
    renderedRuns = runSignature;
    if (!runs.length) {
      $('#management-runs').innerHTML = '<div class="management-runs-empty"><h3>No runs yet</h3><p>Run a reconciliation to see its status and results here.</p></div>';
    } else {
      $('#management-runs').innerHTML = `<div class="table-wrap"><table class="management-runs-table"><thead><tr><th>Run time</th><th>Trigger</th><th>Status</th><th>Result</th></tr></thead><tbody>${[...runs].reverse().slice(0, 10).map(run => `<tr><td>${esc(date(run.startedAt))}</td><td>${run.trigger === 'scheduled' ? 'Scheduled' : 'Manual'}</td><td><span class="status-pill ${run.status === 'ok' ? 'estimated' : run.status === 'failed' || run.status === 'invalid' ? 'unobservable' : ''}">${esc(run.status)}</span></td><td>${run.error ? esc(run.error) : `<span>${esc(run.result?.message || 'Completed')}</span><details><summary>Stream results</summary><ul>${(run.result?.streams || []).map(stream => `<li>${esc(run.modelSnapshot?.streams.find(item => item.id === stream.id)?.name || stream.id)}: ${number(stream.value)} kg · ${esc(stream.status)}</li>`).join('')}</ul></details><button type="button" class="text-button" data-review-run="${esc(run.id)}">View on workbench</button>`}</td></tr>`).join('')}</tbody></table></div>`;
      $('#management-runs').querySelectorAll('[data-review-run]').forEach(button => button.onclick = () => {
        const run = catalog.runs[selectedId].find(item => item.id === button.dataset.reviewRun);
        if (JSON.stringify(getModelEntry(catalog, selectedId).model) !== JSON.stringify(run.modelSnapshot)) {
          message('This model has changed since that run. The saved stream results are available above; run again for the current diagram.', true);
          return;
        }
        activate(selectedId);
        onReview?.(clone(run));
      });
    }
  }

  async function execute(id, trigger = 'manual') {
    if (running.has(id)) throw new Error('This model is already running.');
    running.add(id);
    render();
    try {
      pullShared();
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
    if (opening) $('#menu-workbench').focus();
  };
  document.addEventListener('click', event => { if (!event.target.closest('.application-navigation')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#app-menu').hidden) { event.preventDefault(); closeMenu(true); } });
  document.addEventListener('focusin', event => { if (!event.target.closest('.application-navigation')) closeMenu(); });
  $('#menu-model-management').onclick = openManagement;
  $('#menu-workbench').onclick = () => activate(catalog.activeId);
  $('#management-back').onclick = () => activate(catalog.activeId);
  $('#management-model').onchange = event => { selectedId = event.target.value; render(true); };
  $('#management-open-model').onclick = () => activate(selectedId);
  $('#management-new-model').onclick = () => onNewModel?.();
  $('#management-duplicate-model').onclick = () => {
    beforeAction?.();
    pullShared();
    const activeId = catalog.activeId, copyId = crypto.randomUUID();
    save(setActiveModel(duplicateModel(catalog, selectedId, { id: copyId, now: now(), name: `${getModelEntry(catalog, selectedId).model.name.slice(0, 153)} (copy)` }), activeId));
    selectedId = copyId;
    render(true);
    message('Model duplicated. Its schedule starts disabled.');
  };
  $('#schedule-form').onsubmit = event => {
    event.preventDefault();
    try {
      beforeAction?.();
      pullShared();
      const intervalMinutes = frequencyToMinutes(Number($('#schedule-interval').value), $('#schedule-unit').value);
      save(setSchedule(catalog, selectedId, { enabled: $('#schedule-enabled').checked, intervalMinutes, inputSourceId: $('#schedule-input').value || null, outputSourceId: $('#schedule-output').value || null }, now()), true);
      render(true);
      message('Schedule saved. It runs while this app is open.');
    } catch (error) { message(error.message, true); }
  };
  $('#schedule-run-now').onclick = async () => {
    const targetId = selectedId;
    try { beforeAction?.(); const run = await withLock(() => execute(targetId)); if (selectedId === targetId) message(run.error || run.result?.message || 'Run completed.', run.status === 'failed' || run.status === 'invalid'); }
    catch (error) { message(error.message, true); }
  };
  const timer = setInterval(tick, 1000);
  const resume = () => { if (!document.hidden) tick(); };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  setTimeout(tick, 100);
  if (storageWarning) setTimeout(() => onToast?.(storageWarning), 100);

  return {
    get activeId() { return catalog.activeId; },
    get isOpen() { return pageOpen; },
    current: () => clone(getModelEntry(catalog)),
    saveCurrent(value) {
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
    create(value) { beforeAction?.(); pullShared(); save(addModel(catalog, value, { id: crypto.randomUUID(), now: now() })); activate(catalog.activeId, false); },
    latest(id = catalog.activeId) { const entry = getModelEntry(catalog, id); return clone([...catalog.runs[id]].reverse().find(run => run.result && JSON.stringify(run.modelSnapshot) === JSON.stringify(entry.model)) || null); },
    run(id = catalog.activeId) { return withLock(() => execute(id)); },
    leave: leaveManagement,
    open: openManagement,
    tick,
    destroy() { clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('pageshow', resume); }
  };
}
