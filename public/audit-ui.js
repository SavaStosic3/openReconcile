import { auditQuery } from './workspace-api.js';
import { createQuantityFormatter } from './quantity-format.js';
export { auditQuery } from './workspace-api.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = createQuantityFormatter({ maximumFractionDigits: 5, scientificAbove: 1e9 });
const categories = { measurement: 'Measurements', mapping: 'Mappings', model: 'Models', schedule: 'Schedules', connector: 'Connectors', publication: 'Publications', permission: 'Permissions', retention: 'Retention' };
const time = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC' : '—';
};
const display = value => value === null || value === undefined || value === '' ? 'Not set' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const fieldName = value => String(value || 'Value').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').replace(/^./, character => character.toUpperCase());

export function auditEventHtml(event) {
  const changes = Array.isArray(event.changes) ? event.changes : [];
  return `<details class="audit-event"><summary><span class="audit-event-mark" aria-hidden="true">${event.category === 'permission' ? '◇' : event.category === 'publication' ? '✓' : '↻'}</span><span class="audit-event-main"><strong>${escape(event.summary || fieldName(event.action))}</strong><span>${escape(event.actor?.name || 'Workspace user')}<span aria-hidden="true"> · </span>${escape(event.model?.name || 'Workspace settings')}</span></span><span class="audit-event-meta"><span class="audit-category">${escape(categories[event.category] || fieldName(event.category))}</span><time datetime="${escape(event.occurredAt)}">${escape(time(event.occurredAt))}</time></span><span class="audit-event-chevron" aria-hidden="true">⌄</span></summary><div class="audit-event-detail"><dl class="audit-event-facts"><div><dt>Action</dt><dd>${escape(fieldName(event.action))}</dd></div>${event.target?.name ? `<div><dt>Item</dt><dd>${escape(event.target.name)}</dd></div>` : ''}${event.revisionAfter != null ? `<div><dt>${event.model ? 'Model revision' : 'Settings revision'}</dt><dd>${escape(event.revisionBefore ?? '—')} → ${escape(event.revisionAfter)}</dd></div>` : ''}</dl>${changes.length ? `<div class="audit-table-wrap"><table class="audit-change-table"><thead><tr><th>Item / field</th><th>Before</th><th>After</th></tr></thead><tbody>${changes.map(change => `<tr><th scope="row">${escape(change.itemName || event.target?.name || 'Settings')}<small>${escape(fieldName(change.field))}</small></th><td>${escape(display(change.before))}${change.previousUnit && change.field === 'value' ? ` <span class="muted">${escape(change.previousUnit)}</span>` : ''}</td><td>${escape(display(change.after))}${change.unit && change.field === 'value' ? ` <span class="muted">${escape(change.unit)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="helper">This event records the action and responsible user.</p>'}${event.truncated ? '<p class="helper">The change list reached its size limit. This event shows the first recorded changes.</p>' : ''}</div></details>`;
}

// A chart uses the latest measurement type and unit. Other configurations stay
// in the table, and each transition breaks the line rather than mixing units.
export function trendSegments(points = []) {
  const latest = [...points].reverse().find(point => point.meterType !== 'virtual' && Number.isFinite(point.after));
  if (!latest) return { unit: '', metric: '', segments: [], points: [] };
  const compatible = point => point.meterType !== 'virtual' && Number.isFinite(point.after) && point.unit === latest.unit && point.metric === latest.metric;
  const segments = [], selected = [];
  let segment = null;
  for (const point of points) {
    if (!compatible(point)) { segment = null; continue; }
    if (!segment) { segment = []; segments.push(segment); }
    segment.push(point); selected.push(point);
    if ((point.previousUnit && point.previousUnit !== point.unit) || (point.previousMetric && point.previousMetric !== point.metric)) {
      // A reading changed together with its unit/type; it starts a new series.
      if (segment.length > 1) { segment.pop(); segment = [point]; segments.push(segment); }
    }
  }
  return { unit: latest.unit || '', metric: latest.metric || '', segments, points: selected };
}

export function auditTrendHtml(data) {
  const points = Array.isArray(data.points) ? data.points : [];
  if (!points.length) return '<div class="audit-empty"><strong>No recorded reading changes</strong><p>Changes to saved physical meter readings will appear here. Connector previews, virtual calculations, and reconciliation results do not add reading points.</p></div>';
  const series = trendSegments(points);
  let chart = '';
  if (series.points.length) {
    const scale = Math.max(1, ...series.points.map(point => Math.abs(point.after)));
    const values = series.points.map(point => point.after / scale), min = Math.min(...values), max = Math.max(...values);
    const padding = max === min ? Math.max(Math.abs(max) * .05, .01) : (max - min) * .12;
    const low = min - padding, high = max + padding;
    const firstTime = Date.parse(points[0].occurredAt), lastTime = Date.parse(points.at(-1).occurredAt);
    const validTimes = points.every(point => Number.isFinite(Date.parse(point.occurredAt)));
    const x = point => validTimes && lastTime > firstTime ? 74 + (Date.parse(point.occurredAt) - firstTime) / (lastTime - firstTime) * 624 : 74 + points.indexOf(point) / Math.max(1, points.length - 1) * 624;
    const y = point => 168 - (point.after / scale - low) / (high - low) * 140;
    const axis = position => Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, (high - position * (high - low)) * scale));
    chart = `<div class="audit-chart-heading"><strong>${escape(data.item?.name || 'Meter readings')}</strong><span>${escape(series.unit)} · ${escape(fieldName(series.metric))}</span></div><svg class="audit-trend-chart" viewBox="0 0 730 218" role="img" aria-label="Recorded physical readings in ${escape(series.unit)}. A table of every change follows.">${[0, .5, 1].map(position => `<line class="audit-chart-grid" x1="74" x2="698" y1="${28 + position * 140}" y2="${28 + position * 140}"/><text class="audit-chart-label" x="64" y="${32 + position * 140}" text-anchor="end">${escape(number(axis(position)))}</text>`).join('')}${series.segments.map(segment => segment.length > 1 ? `<polyline class="audit-chart-line" points="${segment.map(point => `${x(point).toFixed(2)},${y(point).toFixed(2)}`).join(' ')}"/>` : '').join('')}${series.points.map(point => `<circle class="audit-chart-point" cx="${x(point).toFixed(2)}" cy="${y(point).toFixed(2)}" r="3.5"><title>${escape(time(point.occurredAt))}: ${escape(number(point.after))} ${escape(point.unit)} · ${escape(point.actorName)}</title></circle>`).join('')}<text class="audit-chart-label" x="74" y="203">${escape(time(points[0].occurredAt))}</text><text class="audit-chart-label" x="698" y="203" text-anchor="end">${escape(time(points.at(-1).occurredAt))}</text></svg><p class="helper">Points show saved reading changes at their edit times, rather than process sampling times. The chart uses the latest unit and measurement type; transitions break the line.</p>`;
  }
  return `${chart}${data.truncated ? `<p class="audit-limit-note">Showing the latest ${escape(data.maxPoints || 500)} changes. Narrow the date range to review earlier readings.</p>` : ''}<details class="audit-reading-details"><summary>Reading change table · ${points.length} ${points.length === 1 ? 'change' : 'changes'}</summary><div class="audit-table-wrap"><table class="audit-change-table"><thead><tr><th>Changed at (UTC)</th><th>User</th><th>Before</th><th>After</th><th>Measurement type</th></tr></thead><tbody>${points.map(point => `<tr><th scope="row">${escape(time(point.occurredAt))}</th><td>${escape(point.actorName || 'Workspace user')}</td><td>${escape(number(point.before))} ${escape(point.previousUnit || point.unit)}</td><td>${escape(number(point.after))} ${escape(point.unit)}</td><td>${escape(fieldName(point.metric))}</td></tr>`).join('')}</tbody></table></div></details>`;
}

export function createAuditHistory({ backend, beforeOpen, onBack, onChange, onToast, document: doc = document }) {
  const $ = selector => doc.querySelector(selector);
  let pageOpen = false, generation = 0, eventRequest = 0, trendRequest = 0, data = null, settings = null, currentFilters = {}, pendingRetention = null, settingsBusy = false;
  const active = () => Boolean(backend.user?.active !== false && backend.user?.role);
  const admin = () => active() && backend.user.role === 'admin';
  const accessKey = () => JSON.stringify([backend.user?.id, backend.user?.role, backend.user?.active, Object.entries(backend.workspace.permissions || {}).map(([id, permission]) => [id, Boolean(permission.canView)]).sort(([left], [right]) => left.localeCompare(right))]);
  let knownAccess = accessKey();
  const options = (selector, entries, placeholder, value = $(selector).value) => {
    $(selector).innerHTML = `<option value="">${escape(placeholder)}</option>${entries.map(entry => `<option value="${escape(entry.id)}">${escape(entry.name)}${entry.deleted ? ' · deleted' : ''}</option>`).join('')}`;
    $(selector).value = entries.some(entry => entry.id === value) ? value : '';
  };
  const message = (text = '', error = false) => { $('#audit-message').textContent = text; $('#audit-message').classList.toggle('is-error', error); $('#audit-message').setAttribute('role', error ? 'alert' : 'status'); };
  const trendMessage = (text = '', error = false) => { $('#audit-trend-message').textContent = text; $('#audit-trend-message').classList.toggle('is-error', error); };
  const retentionMessage = (text = '', error = false) => { $('#audit-retention-message').textContent = text; $('#audit-retention-message').classList.toggle('is-error', error); $('#audit-retention-message').setAttribute('role', error ? 'alert' : 'status'); };
  function controls() {
    $('#menu-audit').hidden = !active();
    $('#audit-retention').hidden = !admin();
    $('#audit-retention-save').disabled = !admin() || settingsBusy || !settings;
    $('#audit-retention-confirm').disabled = !admin() || settingsBusy;
    $('#audit-retention-days').disabled = settingsBusy || $('#audit-retention-policy').value === 'indefinite';
    $('#audit-retention-policy').disabled = !admin() || settingsBusy || !settings;
  }
  function clear() {
    trendRequest++;
    data = null; settings = null; pendingRetention = null;
    $('#audit-events').replaceChildren(); $('#audit-trend-content').replaceChildren();
    $('#audit-content').hidden = true;
    $('#audit-load-more').hidden = true;
    options('#audit-model', [], 'All accessible models');
    options('#audit-actor', [], 'All users');
    options('#audit-trend-model', [], 'Choose a model');
    $('#audit-trend-meter').innerHTML = '<option value="">No meters selected</option>';
    $('#audit-trend-meter').disabled = true;
    if ($('#audit-retention-dialog').open) $('#audit-retention-dialog').close();
    controls();
  }
  function readFilters() {
    const filters = { modelId: $('#audit-model').value, actorId: $('#audit-actor').value, category: $('#audit-category').value, q: $('#audit-search').value.trim(), from: $('#audit-from').value, to: $('#audit-to').value };
    auditQuery(filters);
    return filters;
  }
  function installSettings(next) {
    settings = next;
    const days = settings?.retentionDays ?? 365;
    $('#audit-retention-policy').value = days === 0 ? 'indefinite' : 'days';
    $('#audit-retention-days').value = days === 0 ? '365' : String(days);
    $('#audit-retention-summary').textContent = days === 0 ? 'Keep audit history indefinitely' : `Keep audit history for ${days} ${days === 1 ? 'day' : 'days'}`;
    $('#audit-retention-label').textContent = days === 0 ? 'Indefinite' : `${days} days`;
    controls();
  }
  function renderEvents() {
    $('#audit-content').hidden = false;
    $('#audit-count').textContent = data.events.length;
    $('#audit-latest').textContent = data.events[0] ? time(data.events[0].occurredAt) : 'No matching changes';
    $('#audit-events').innerHTML = data.events.length ? data.events.map(auditEventHtml).join('') : '<div class="audit-empty"><strong>No matching history</strong><p>Try a different model or date range. Saved changes will be recorded from the time audit history is enabled.</p></div>';
    $('#audit-load-more').hidden = !data.nextCursor;
    $('#audit-results-label').textContent = `${data.events.length} ${data.events.length === 1 ? 'change' : 'changes'} loaded${data.nextCursor ? ' · more available' : ''}`;
  }
  async function refresh({ more = false } = {}) {
    if (!pageOpen || !active()) return false;
    let filters;
    try { filters = more ? { ...currentFilters, cursor: data?.nextCursor } : readFilters(); if (more && !filters.cursor) return false; }
    catch (error) { message(error.message, true); return false; }
    const epoch = ++eventRequest, view = generation;
    $('#audit-events').setAttribute('aria-busy', 'true'); $('#audit-refresh').disabled = true; $('#audit-load-more').disabled = true;
    // A fresh search never displays cached events while checking current access.
    if (!more) { data = null; trendRequest++; $('#audit-events').replaceChildren(); $('#audit-content').hidden = true; $('#audit-load-more').hidden = true; $('#audit-trend-content').replaceChildren(); $('#audit-trend-meter').disabled = true; trendMessage(); }
    message(more ? 'Loading earlier changes…' : 'Loading audit history…');
    try {
      const next = await backend.audit(filters);
      if (!pageOpen || view !== generation || epoch !== eventRequest || !active()) return false;
      if (!Array.isArray(next.events) || !Array.isArray(next.models) || !Array.isArray(next.actors)) throw new Error('Audit history could not be read. Please refresh.');
      if (more) data = { ...next, events: [...(data?.events || []), ...next.events].filter((event, index, events) => events.findIndex(item => item.id === event.id) === index) };
      else { data = next; currentFilters = { ...filters }; }
      options('#audit-model', next.models, 'All accessible models'); options('#audit-actor', next.actors, 'All users');
      const trendModel = $('#audit-trend-model').value || filters.modelId || backend.workspace.catalog.activeId;
      options('#audit-trend-model', next.models.filter(model => !model.deleted), 'Choose a model', trendModel);
      installSettings(next.settings); renderEvents(); message();
      if (!more) await loadTrends();
      return true;
    } catch (error) {
      if (pageOpen && view === generation && epoch === eventRequest) { clear(); message(error.message || 'Audit history could not be loaded.', true); }
      return false;
    } finally {
      if (view === generation && epoch === eventRequest) { $('#audit-events').setAttribute('aria-busy', 'false'); $('#audit-refresh').disabled = false; $('#audit-load-more').disabled = false; }
    }
  }
  async function loadTrends({ keepMeter = false } = {}) {
    const id = $('#audit-trend-model').value, epoch = ++trendRequest, view = generation;
    $('#audit-trend-content').replaceChildren(); $('#audit-trend-meter').disabled = true;
    if (!pageOpen || !active() || !id) { trendMessage('Choose a model to inspect changes to its physical readings.'); return; }
    trendMessage('Loading recorded readings…');
    try {
      const filters = { modelId: id, from: currentFilters.from, to: currentFilters.to, ...(keepMeter && $('#audit-trend-meter').value ? { itemId: $('#audit-trend-meter').value } : {}) };
      const next = await backend.auditTrends(filters);
      if (!pageOpen || view !== generation || epoch !== trendRequest || !active()) return;
      options('#audit-trend-meter', next.items || [], 'Choose a physical meter', next.item?.id);
      $('#audit-trend-meter').disabled = !next.items?.length;
      $('#audit-trend-content').innerHTML = auditTrendHtml(next);
      trendMessage(currentFilters.from || currentFilters.to ? 'Uses the UTC date range from the history search.' : 'Shows changes within the retained audit history.');
    } catch (error) {
      if (pageOpen && view === generation && epoch === trendRequest) { $('#audit-trend-meter').innerHTML = '<option value="">No readings available</option>'; trendMessage(error.message || 'Recorded readings could not be loaded.', true); }
    }
  }
  async function saveRetention(value) {
    if (!pageOpen || !admin() || !settings || settingsBusy) return;
    const view = generation, revision = settings.revision;
    settingsBusy = true; controls(); retentionMessage('Saving retention policy…');
    try {
      const result = await backend.auditSettings({ retentionDays: value, revision });
      if (!pageOpen || generation !== view || !active()) return;
      installSettings(result.settings); $('#audit-retention-dialog').close(); pendingRetention = null;
      await refresh();
      if (pageOpen && generation === view && admin()) retentionMessage('Audit retention policy saved.');
    } catch (error) {
      if (pageOpen && generation === view) { $('#audit-retention-dialog').close(); retentionMessage(error.message || 'Retention could not be saved.', true); if (error.status === 409) onToast?.('The retention policy changed. Refresh history before saving again.'); }
    } finally { if (generation === view) { settingsBusy = false; controls(); } }
  }
  async function open() {
    if (!active()) return;
    const opening = ++generation;
    try {
      await beforeOpen?.();
      if (opening !== generation || !active()) return;
      pageOpen = true;
      $('#app-menu').hidden = true; $('#menu-button').setAttribute('aria-expanded', 'false');
      for (const view of doc.querySelectorAll('[role="tabpanel"]')) view.classList.add('hidden');
      $('#view-management').classList.add('hidden'); $('#view-admin').classList.add('hidden'); $('#view-sql').classList.add('hidden');
      $('#workspace-empty').hidden = true; $('#workflow-nav').classList.add('hidden'); $('#view-audit').classList.remove('hidden');
      doc.body.classList.add('is-audit'); $('#menu-audit').setAttribute('aria-current', 'page');
      controls(); onChange?.(); $('#audit-heading').focus(); await refresh();
    } catch (error) { if (opening === generation) onToast?.(error.message || 'Audit history could not be opened.'); }
  }
  function leave() {
    pageOpen = false; generation++; eventRequest++; trendRequest++; settingsBusy = false;
    $('#view-audit').classList.add('hidden'); doc.body.classList.remove('is-audit'); $('#menu-audit').removeAttribute('aria-current'); clear();
  }
  $('#menu-audit').onclick = open;
  $('#audit-back').onclick = () => { leave(); onBack?.(); };
  $('#audit-refresh').onclick = () => refresh();
  $('#audit-filter-form').onsubmit = event => { event.preventDefault(); return refresh(); };
  $('#audit-reset').onclick = () => { $('#audit-filter-form').reset(); return refresh(); };
  $('#audit-load-more').onclick = () => refresh({ more: true });
  $('#audit-trend-model').onchange = () => loadTrends();
  $('#audit-trend-meter').onchange = () => loadTrends({ keepMeter: true });
  $('#audit-retention-policy').onchange = controls;
  $('#audit-retention-form').onsubmit = event => {
    event.preventDefault();
    if (!admin() || settingsBusy || !settings) return;
    const value = $('#audit-retention-policy').value === 'indefinite' ? 0 : Number($('#audit-retention-days').value);
    if (!Number.isInteger(value) || value < 0 || value > 3650 || (value === 0 && $('#audit-retention-policy').value !== 'indefinite')) { retentionMessage('Choose a whole number of days between 1 and 3,650.', true); return; }
    if (value === settings.retentionDays) { retentionMessage('This retention policy is already saved.'); return; }
    if (value !== 0 && (settings.retentionDays === 0 || value < settings.retentionDays)) {
      pendingRetention = value;
      $('#audit-retention-confirm-description').textContent = `Keep audit history for ${value} ${value === 1 ? 'day' : 'days'}? Older audit events will be permanently removed. Increasing retention later cannot recover removed history.`;
      $('#audit-retention-dialog').showModal(); $('#audit-retention-cancel').focus();
    } else return saveRetention(value);
  };
  $('#audit-retention-confirm').onclick = () => pendingRetention === null ? undefined : saveRetention(pendingRetention);
  for (const selector of ['#audit-retention-close', '#audit-retention-cancel']) $(selector).onclick = () => { pendingRetention = null; $('#audit-retention-dialog').close(); };
  $('#audit-retention-dialog').addEventListener('close', () => { pendingRetention = null; });
  backend.subscribe(reason => {
    controls();
    if (!active()) { leave(); return; }
    const nextAccess = accessKey();
    if (nextAccess !== knownAccess) {
      knownAccess = nextAccess; eventRequest++; clear();
      $('#audit-refresh').disabled = false; $('#audit-events').setAttribute('aria-busy', 'false');
      options('#audit-model', backend.workspace.catalog.models.map(entry => ({ id: entry.id, name: entry.model?.name || entry.name || 'Untitled model' })), 'All accessible models');
      options('#audit-trend-model', backend.workspace.catalog.models.map(entry => ({ id: entry.id, name: entry.model?.name || entry.name || 'Untitled model' })), 'Choose a model');
      options('#audit-actor', [], 'All users');
      if (pageOpen) { message('Workspace access changed. Search history again to load the changes available to you.'); trendMessage('Choose a model to inspect changes to its physical readings.'); }
    } else if (reason === 'refresh' && pageOpen && !admin() && $('#audit-retention-dialog').open) $('#audit-retention-dialog').close();
  });
  controls();
  return { open, leave, refresh, get isOpen() { return pageOpen; } };
}
