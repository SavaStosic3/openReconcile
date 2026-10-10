import { validateSqlSource, SQL_AGGREGATIONS, SQL_OUTPUT_COLUMNS } from './sql-sources.js';
import { validatePiSource } from './pi-sources.js';
import { validateInputQuality } from './input-quality.js';
import { createPeriodSelector, qualityAuditHtml } from './reporting-ui.js';
import { createPiConnectionSettings } from './pi-configuration-ui.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dialectName = value => ({ sqlserver: 'SQL Server', postgres: 'PostgreSQL', mysql: 'MySQL' }[value] || value);
const number = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value) : '—';
const connectorName = type => type === 'pi' ? 'PI Web API' : 'SQL';

export function createSqlConnectors({ backend, beforeOpen, onBack, onMapping, onManagement, onChange, onToast, periodSelectorFactory = createPeriodSelector }) {
  const form = $('#sql-source-form');
  let pageOpen = false, selectedId = null, editingId = null, connections = [], configured = false, busy = false, generation = 0, removingId = null, connectorType = 'sql';
  const metadata = new Map();
  const piSettings = createPiConnectionSettings({ backend, onSaved: async () => { connectorType = 'pi'; editingId = null; metadata.clear(); await refresh(); } });
  const idleWaiters = [];
  function finish() { busy = false; idleWaiters.splice(0).forEach(resolve => resolve()); if (pageOpen) renderAccess(); }
  const authorized = () => backend.user.active !== false && backend.user.role === 'admin';
  const sources = () => (backend.workspace.catalog.sources[selectedId] || []).filter(source => ['sql', 'pi'].includes(source.type));
  const typedSources = () => sources().filter(source => source.type === connectorType);
  const editable = () => authorized() && Boolean(selectedId && backend.permission(selectedId).canEdit);
  const periodSelector = periodSelectorFactory({ container: $('#sql-period-selector'), prefix: 'sql-period', context: () => { const entry = backend.workspace.catalog.models.find(item => item.id === selectedId); return { id: selectedId, model: $('#sql-preview-target').value === 'published' ? entry?.publishedModel : entry?.model, settings: backend.workspace.catalog.schedules[selectedId]?.reporting, now: backend.now?.() }; }, onChange: () => { $('#sql-preview').replaceChildren(); message(); } });

  function message(text = '', error = false) {
    $('#sql-message').textContent = text;
    $('#sql-message').classList.toggle('is-error', error);
  }
  function renderAccess() {
    const enabled = editable() && configured && !busy;
    for (const control of form.querySelectorAll('input,select,button')) control.disabled = !enabled;
    form.elements.connectorType.disabled = !editable() || busy;
    $('#sql-model').disabled = busy || !backend.workspace.catalog.models.length;
    $('#sql-refresh').disabled = busy;
    $('#sql-new-source').disabled = !editable() || busy;
    $('#sql-preview-target').disabled = !enabled;
    periodSelector.refresh(); periodSelector.setEnabled(enabled);
    $('#sql-preview-target option[value="published"]').disabled = !backend.permission(selectedId).published;
    if (!backend.permission(selectedId).published) $('#sql-preview-target').value = 'draft';
    $('#sql-access-note').textContent = !selectedId ? 'Create a model before adding a source.' : !editable() ? 'Editing is locked for this model. An administrator must unlock it before configuring or testing sources.' : 'Source settings apply to reconciliation runs for both the draft and the published model. Changing or removing a selected source pauses its schedule for review.';
    for (const button of $('#sql-source-list').querySelectorAll('button')) button.disabled = !editable() || busy;
  }
  function renderList() {
    const list = sources();
    $('#sql-source-count').textContent = `${list.length} defined source${list.length === 1 ? '' : 's'}`;
    const schedule = backend.workspace.catalog.schedules[selectedId];
    $('#sql-source-list').innerHTML = list.map(source => `<article class="sql-source-card${editingId === source.id ? ' is-selected' : ''}"><div><span class="eyebrow">${esc(source.direction)} / ${esc(source.type === 'pi' ? connectorName(source.type) : dialectName(metadata.get('sql')?.connections.find(c => c.id === source.connectionId)?.dialect) || 'SQL')}</span><h3>${esc(source.name)}</h3><p>${esc(source.connectionId)}${source.type === 'sql' ? ` · <code>${esc(source.table)}</code>` : ''}</p>${source.direction === 'input' ? `<small>${esc(source.aggregation)}${source.type === 'sql' ? ` · ${esc(source.tagColumn)} → ${esc(source.valueColumn)}` : ' · PI quality flags enforced'}</small>` : `<small>${source.type === 'pi' ? 'Reconciled values to configured output tags' : 'Reconciled streams, inventories, and accumulation in kg'}</small>`}${schedule?.[`${source.direction}SourceId`] === source.id ? '<span class="pill">Selected for runs</span>' : ''}</div><div class="sql-card-actions"><button type="button" class="text-button" data-sql-edit="${esc(source.id)}" aria-label="Edit ${esc(source.name)}">Edit</button><button type="button" class="text-button danger" data-sql-remove="${esc(source.id)}" aria-label="${removingId === source.id ? 'Confirm remove' : 'Remove'} ${esc(source.name)}">${removingId === source.id ? 'Confirm remove' : 'Remove'}</button></div></article>`).join('') || '<div class="sql-list-empty"><strong>No data sources yet.</strong><p>Add an input to fetch meter readings and inventory snapshots, or an output to deliver reconciled results.</p></div>';
    renderAccess();
  }
  function connectionOptions() {
    const direction = form.elements.direction.value, prior = form.elements.connectionId.value;
    const available = connections.filter(connection => direction === 'input' ? connection.canRead : connection.canWrite);
    const choices = available.map(connection => new Option(`${connection.name} · ${connectorType === 'pi' ? 'PI Web API' : dialectName(connection.dialect)}`, connection.id));
    if (!choices.length) choices.push(new Option(configured ? 'No allowed connections for this direction' : connectorType === 'pi' ? 'Add a connection in PI connection settings' : 'Set up the SQL gateway first', ''));
    form.elements.connectionId.replaceChildren(...choices);
    if (available.some(connection => connection.id === prior)) form.elements.connectionId.value = prior;
    $('#sql-input-fields').hidden = direction !== 'input';
    $('#sql-output-fields').hidden = direction !== 'output' || connectorType !== 'sql';
    $('#sql-table-field').hidden = connectorType !== 'sql';
    $('#sql-input-column-fields').hidden = connectorType !== 'sql';
    $('#sql-quality-column-field').hidden = connectorType !== 'sql';
    $('#pi-quality-note').hidden = connectorType !== 'pi';
    $('#pi-output-fields').hidden = direction !== 'output' || connectorType !== 'pi';
    $('#sql-preview-input').hidden = direction !== 'input';
    $('#sql-preview-target-field').hidden = direction !== 'input';
    $('#sql-period-selector').hidden = direction !== 'input';
    for (const name of ['tagColumn', 'valueColumn', 'timestampColumn']) form.elements[name].required = direction === 'input' && connectorType === 'sql';
    form.elements.table.required = connectorType === 'sql';
    for (const name of ['aggregation', 'maxAgeMinutes', 'minCoveragePercent', 'goodQualityValues']) form.elements[name].required = direction === 'input';
    form.elements.goodQualityValues.readOnly = connectorType === 'pi';
    $('#sql-quality-values-help').textContent = connectorType === 'pi' ? 'PI inputs accept Good only. Questionable and substituted readings are excluded or rejected according to the rule below.' : 'Comma-separated values; matching is case-sensitive.';
    renderBindings();
    renderAccess();
  }
  function renderBindings() {
    const panel = $('#pi-bindings'); panel.hidden = connectorType !== 'pi';
    if (connectorType !== 'pi') return;
    const direction = form.elements.direction.value, connection = connections.find(item => item.id === form.elements.connectionId.value);
    const bindings = connection?.[direction === 'input' ? 'inputs' : 'outputs'] || [];
    panel.innerHTML = `<h3>Available ${direction === 'input' ? 'input' : 'output'} mappings</h3><p class="helper">Use these Source Names in Data Mapping. ${direction === 'input' ? 'Input units must match the model meter or inventory boundary.' : 'Output destinations are separate from raw measurement tags. Each metric uses its configured destination.'}</p>${bindings.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Source Name</th>${direction === 'output' ? '<th>Result metric</th>' : ''}<th>Unit</th></tr></thead><tbody>${bindings.map(binding => `<tr><td><code>${esc(binding.sourceName)}</code></td>${direction === 'output' ? `<td>${esc(binding.metric)}</td>` : ''}<td>${esc(binding.unit)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="helper">No allowed mappings for this connection and direction. Ask the server administrator to configure them.</p>'}`;
  }
  function qualityFields() {
    const aggregation = form.elements.aggregation.value;
    $('#sql-integration-rules').hidden = aggregation !== 'timeWeightedAverage';
    $('#sql-totalizer-rules').hidden = aggregation !== 'totalizerDelta';
    $('#sql-rollover-field').hidden = aggregation !== 'totalizerDelta' || form.elements.totalizerReset.value !== 'rollover';
    form.elements.rolloverValue.required = aggregation === 'totalizerDelta' && form.elements.totalizerReset.value === 'rollover';
    $('#sql-aggregation-help').textContent = ({ latest: 'Latest selects the most recent accepted reading inside the period.', sum: 'Sum combines readings inside the period. Use this for interval totals, not cumulative counters or flow rates.', average: 'Arithmetic average gives each accepted reading equal weight.', timeWeightedAverage: 'Time-weighted average integrates a flow rate over elapsed time. Configure a mass-flow or volume-flow meter; the run uses its actual period duration.', totalizerDelta: 'Counter difference calculates the total mass or volume across the period. Configure a total mass or total volume meter.' })[aggregation] + ' Inventory inputs always use snapshots at the exact opening and closing boundaries.';
  }
  function reset(source = null) {
    editingId = source?.id || null; removingId = null;
    form.reset();
    form.elements.connectorType.value = connectorType;
    form.elements.direction.value = source?.direction || 'input';
    connectionOptions();
    for (const name of ['name','connectionId','table','tagColumn','valueColumn','timestampColumn','aggregation']) {
      if (source?.[name] !== undefined) form.elements[name].value = source[name];
    }
    const quality = validateInputQuality(source?.quality);
    for (const name of ['maxAgeMinutes', 'minCoveragePercent', 'qualityColumn', 'badQualityPolicy', 'interpolation', 'gapPolicy', 'totalizerReset', 'rolloverValue']) form.elements[name].value = quality[name] ?? '';
    form.elements.goodQualityValues.value = quality.goodQualityValues.join(', ');
    qualityFields();
    if (source && !connections.some(connection => connection.id === source.connectionId)) {
      form.elements.connectionId.add(new Option(`${source.connectionId} · unavailable`, source.connectionId));
      form.elements.connectionId.value = source.connectionId;
    }
    renderBindings();
    $('#sql-form-heading').textContent = source ? 'Edit source' : 'Add a source';
    $('#sql-save-source').textContent = source ? 'Save changes' : 'Add source';
    $('#sql-preview').replaceChildren(); message(); renderList();
  }
  function readSource() {
    const direction = form.elements.direction.value;
    const source = { id: editingId || crypto.randomUUID(), name: form.elements.name.value.trim(), type: connectorType, direction, connectionId: form.elements.connectionId.value };
    if (connectorType === 'sql') source.table = form.elements.table.value.trim();
    if (direction === 'input') {
      for (const name of connectorType === 'sql' ? ['tagColumn','valueColumn','timestampColumn','aggregation'] : ['aggregation']) source[name] = form.elements[name].value.trim();
      source.quality = validateInputQuality({ maxAgeMinutes: Number(form.elements.maxAgeMinutes.value), minCoveragePercent: Number(form.elements.minCoveragePercent.value), qualityColumn: connectorType === 'pi' ? 'piQuality' : form.elements.qualityColumn.value.trim() || null, goodQualityValues: connectorType === 'pi' ? ['Good'] : form.elements.goodQualityValues.value.split(',').map(value => value.trim()).filter(Boolean), badQualityPolicy: form.elements.badQualityPolicy.value, interpolation: form.elements.interpolation.value, gapPolicy: form.elements.gapPolicy.value, totalizerReset: form.elements.totalizerReset.value, rolloverValue: form.elements.rolloverValue.value === '' ? null : Number(form.elements.rolloverValue.value) });
    }
    return connectorType === 'pi' ? validatePiSource(source) : validateSqlSource(source);
  }
  async function action(callback, requireConfigured = true) {
    if (busy || !editable() || requireConfigured && !configured) return;
    const epoch = generation; busy = true; message(); renderAccess();
    try { await callback(epoch); }
    catch (error) { if (pageOpen && epoch === generation) message(error.message || 'The connector operation failed.', true); }
    finally { finish(); }
  }
  async function refresh() {
    if (!authorized() || busy) return;
    const epoch = ++generation; busy = true; message(); renderAccess();
    try {
      await backend.refresh();
      if (!authorized()) { leave(); onBack?.(); return; }
      if (!pageOpen || epoch !== generation) return;
      const data = await backend.api(`/api/${connectorType}/connections`);
      if (!pageOpen || epoch !== generation) return;
      metadata.set(connectorType, data);
      configured = data.configured === true; connections = data.connections || [];
      const models = backend.workspace.catalog.models;
      if (!models.some(model => model.id === selectedId)) selectedId = backend.workspace.catalog.activeId || models[0]?.id || null;
      $('#sql-model').replaceChildren(...(models.length ? models.map(model => new Option(model.model.name, model.id)) : [new Option('No models available', '')]));
      $('#sql-model').value = selectedId || '';
      renderSetup();
      reset();
    } catch (error) {
      if (pageOpen && epoch === generation) { configured = false; connections = []; renderSetup(); message(error.message, true); renderList(); }
    } finally { finish(); }
  }
  function renderSetup() {
    $('#sql-gateway-state').textContent = configured ? `${connectorName(connectorType)} · ${connections.length} connection${connections.length === 1 ? '' : 's'} available` : `${connectorName(connectorType)} setup required`;
    $('#sql-gateway-state').dataset.ready = String(configured);
    $('#sql-connection-kind').textContent = connectorType === 'pi' ? 'Recorded measurements · PI quality flags · Reconciled output tags' : 'SQL Server · PostgreSQL · MySQL';
    $('#sql-setup-note').hidden = configured || connectorType !== 'sql';
    $('#pi-setup-note').hidden = configured || connectorType !== 'pi';
  }
  async function switchConnector(type, source = null) {
    if (!['sql', 'pi'].includes(type) || !editable()) return;
    if (busy) await new Promise(resolve => idleWaiters.push(resolve));
    if (!pageOpen || !editable()) return;
    const epoch = ++generation;
    connectorType = type; configured = false; connections = []; busy = true;
    reset(); renderSetup();
    try {
      const data = metadata.get(type) || await backend.api(`/api/${type}/connections`);
      if (!pageOpen || epoch !== generation || !editable()) return;
      metadata.set(type, data); configured = data.configured === true; connections = data.connections || [];
      renderSetup(); reset(source);
    } catch (error) { if (pageOpen && epoch === generation) { renderSetup(); message(error.message || 'Connection metadata is unavailable.', true); } }
    finally { finish(); }
  }
  async function open() {
    if (!authorized()) { onToast?.('Data connector settings require an administrator account.'); return; }
    await beforeOpen?.();
    if (busy) await new Promise(resolve => idleWaiters.push(resolve));
    if (!authorized()) return;
    pageOpen = true; selectedId = backend.workspace.catalog.activeId;
    $('#app-menu').hidden = true; $('#menu-button').setAttribute('aria-expanded','false');
    for (const view of document.querySelectorAll('[role="tabpanel"]')) view.classList.add('hidden');
    $('#view-sql').classList.remove('hidden'); $('#workflow-nav').classList.add('hidden');
    $('#workspace-empty').hidden = true;
    document.body.classList.add('is-sql');
    onChange?.(); $('#sql-heading').focus(); await refresh();
  }
  function leave() { if (!pageOpen) return; pageOpen = false; generation++; piSettings.leave(); $('#view-sql').classList.add('hidden'); document.body.classList.remove('is-sql'); }

  form.elements.aggregation.replaceChildren(...SQL_AGGREGATIONS.map(value => new Option({ latest: 'Latest reading', sum: 'Sum of interval totals', average: 'Arithmetic average', timeWeightedAverage: 'Time-weighted flow average', totalizerDelta: 'Totalizer difference' }[value], value)));
  $('#sql-output-columns').textContent = SQL_OUTPUT_COLUMNS.join(', ');
  $('#menu-sql').onclick = open;
  $('#sql-back').onclick = () => { leave(); onBack?.(); };
  $('#sql-open-mapping').onclick = () => { leave(); onMapping?.(selectedId); };
  $('#sql-open-management').onclick = () => { leave(); onManagement?.(selectedId); };
  $('#sql-refresh').onclick = refresh;
  $('#sql-new-source').onclick = () => { reset(); form.elements.name.focus(); };
  form.elements.connectorType.onchange = () => switchConnector(form.elements.connectorType.value);
  form.elements.direction.onchange = () => { connectionOptions(); $('#sql-preview').replaceChildren(); message(); };
  form.elements.connectionId.onchange = () => { renderBindings(); $('#sql-preview').replaceChildren(); message(); };
  form.elements.aggregation.onchange = qualityFields;
  form.elements.totalizerReset.onchange = qualityFields;
  $('#sql-preview-target').onchange = () => { periodSelector.refresh(); $('#sql-preview').replaceChildren(); message(); };
  // A preview describes the configuration tested at that moment, not later edits.
  for (const event of ['input', 'change']) form.addEventListener(event, () => { $('#sql-preview').replaceChildren(); message(); });
  $('#sql-model').onchange = () => { selectedId = $('#sql-model').value || null; generation++; reset(); };
  form.onsubmit = event => { event.preventDefault(); action(async epoch => {
    const source = readSource(), id = selectedId;
    const next = typedSources().filter(item => item.id !== source.id).concat(source);
    const result = await backend.sources(id, next, connectorType);
    if (!pageOpen || epoch !== generation) return;
    reset(source); message(result.schedulePaused ? 'Source saved. Review and re-enable the paused schedule in Model Management.' : 'Source saved. Select it for runs in Model Management.');
    onChange?.();
  }); };
  $('#sql-test-source').onclick = () => action(async epoch => {
    const source = readSource();
    await (backend.connectorTest || backend.sqlTest).call(backend, selectedId, source);
    if (pageOpen && epoch === generation) message(`Connection and ${connectorType === 'pi' ? 'configured PI mappings' : source.direction === 'input' ? 'input columns' : 'output columns'} verified. No output data was written.`);
  });
  $('#sql-preview-input').onclick = () => action(async epoch => {
    const source = readSource(), target = $('#sql-preview-target').value;
    const data = await (backend.connectorPreview || backend.sqlPreview).call(backend, selectedId, source, target, periodSelector.value());
    if (!pageOpen || epoch !== generation) return;
    const date = value => new Date(value).toLocaleString();
    $('#sql-preview').innerHTML = `<div class="table-heading"><h3>Input preview · ${esc(target)}</h3><span class="helper">${esc(data.reportingPeriod?.label || `${date(data.window.start)} → ${date(data.window.end)}`)}</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Input / Source Name</th><th>Reading</th><th>Timestamp</th></tr></thead><tbody>${data.readings.map(row => `<tr><td>${esc(row.modelName)}<small>${esc(row.sourceName)}</small></td><td class="mono">${esc(number(row.value))} ${esc(row.unit)}</td><td>${esc(date(row.timestamp))}</td></tr>`).join('')}</tbody></table></div>${qualityAuditHtml(data.readings)}<p class="helper">Preview only. Saved readings and reconciliation results have not changed.</p>`;
    message(`${data.readings.length} physical input readings fetched. Inventory snapshots match the opening/closing boundaries; virtual meters are calculated during reconciliation.`);
  });
  $('#sql-source-list').onclick = event => {
    const edit = event.target.closest('[data-sql-edit]'), remove = event.target.closest('[data-sql-remove]');
    if (busy || !editable()) return;
    if (edit) { const source = sources().find(source => source.id === edit.dataset.sqlEdit); if (source) { if (source.type !== connectorType) switchConnector(source.type, source); else { reset(source); form.elements.name.focus(); } } }
    if (remove) {
      const id = remove.dataset.sqlRemove;
      if (removingId !== id) { removingId = id; renderList(); message('Confirm removal on this source. If it is selected for runs, that selection will be cleared and its schedule paused.'); return; }
      action(async epoch => {
        const removed = sources().find(source => source.id === id);
        if (!removed) return;
        const result = await backend.sources(selectedId, sources().filter(source => source.type === removed.type && source.id !== id), removed.type);
        if (!pageOpen || epoch !== generation) return;
        reset(); message(result.schedulePaused ? 'Source removed. Its schedule is paused; review the run selections.' : 'Source removed.'); onChange?.();
      }, false);
    }
  };
  backend.subscribe(() => { if (pageOpen) { if (!authorized()) { leave(); onBack?.(); } else renderList(); } });
  return { open, leave, get isOpen() { return pageOpen; } };
}
