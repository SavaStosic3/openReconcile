import { defaultReportingSettings, validateReportingSettings, resolveReportingPeriod, recentReportingPeriods, formatReportingPeriod } from './reporting-periods.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) : '—';
const kinds = { hour: 'Hour', day: 'Day', shift: 'Shift', batch: 'Batch' };
const utcInput = value => new Date(value).toISOString().slice(0, 16);

export function qualityAuditHtml(readings = []) {
  const rows = readings.filter(reading => reading.quality);
  if (!rows.length) return '';
  return `<details class="quality-audit" open><summary>Input data quality</summary><div class="table-wrap"><table class="data-table quality-table"><thead><tr><th>Meter</th><th>Coverage</th><th>Samples / excluded</th><th>Latest reading (UTC)</th><th>Resets</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.modelName || row.sourceName || row.streamId)}${row.quality.warnings?.length ? `<small>${row.quality.warnings.map(esc).join(' · ')}</small>` : ''}</td><td>${number(row.quality.coveragePercent)}%</td><td>${esc(row.quality.sampleCount)} / ${esc(row.quality.rejectedCount)}</td><td>${esc(row.quality.latestTimestamp || row.timestamp || '—')}</td><td>${esc(row.quality.resetCount || 0)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

export function createPeriodSelector({ container, prefix, context, onChange }) {
  let scope = null, signature = null, kind = 'hour', selection = null, recent = [], selected = null, invalid = false;
  const dialog = document.createElement('dialog');
  dialog.className = 'reporting-period-dialog';
  dialog.setAttribute('aria-labelledby', `${prefix}-dialog-title`);
  dialog.innerHTML = `<form><div class="dialog-header"><div><p class="eyebrow">REPORTING PERIOD</p><h2 id="${prefix}-dialog-title">Choose an earlier period</h2></div><button type="button" class="icon-button" data-period-close aria-label="Close reporting period">×</button></div><div class="dialog-body"><p data-period-guidance></p><label class="field">Start time (UTC)<input type="datetime-local" name="start" step="60" required></label><label class="field">End time (UTC)<input type="datetime-local" name="end" step="60" required></label><p class="helper">Times above are UTC. The selected period is displayed in the model's time zone. Current and future periods cannot be reconciled.</p><p class="form-error hidden" role="alert" data-period-error></p></div><div class="dialog-footer"><button type="button" class="button secondary" data-period-cancel>Cancel</button><button type="submit" class="button primary">Select period</button></div></form>`;
  document.body.append(dialog);
  container.innerHTML = `<div class="reporting-period-title"><span class="eyebrow">REPORTING PERIOD</span><strong>Completed period</strong></div><div class="reporting-period-controls"><label class="sr-only" for="${prefix}-kind">Reporting period type</label><select id="${prefix}-kind" aria-label="Reporting period type">${Object.entries(kinds).map(([value, title]) => `<option value="${value}">${title}</option>`).join('')}</select><label class="sr-only" for="${prefix}-selection">Completed reporting period</label><select id="${prefix}-selection" aria-label="Completed reporting period"></select><button type="button" class="button secondary compact" data-period-earlier>Earlier / custom…</button></div><p class="reporting-period-detail" role="status" aria-live="polite"></p>`;
  const type = container.querySelector(`#${prefix}-kind`), choice = container.querySelector(`#${prefix}-selection`), detail = container.querySelector('.reporting-period-detail');
  const settings = ctx => ctx.settings == null ? defaultReportingSettings(ctx.model) : validateReportingSettings(ctx.settings);
  const now = () => context()?.now ?? Date.now();
  function changed() { refresh(); onChange?.(selected); }
  function refresh() {
    const ctx = context();
    if (!ctx?.id || !ctx.model) { selected = null; return; }
    const config = settings(ctx), configSignature = JSON.stringify(config);
    if (scope !== ctx.id || signature !== configSignature) {
      scope = ctx.id; signature = configSignature; kind = config.kind; selection = null;
    }
    try {
      const active = { ...config, kind };
      recent = recentReportingPeriods(active, ctx.model, now(), 24);
      selected = resolveReportingPeriod(active, ctx.model, now(), selection);
      invalid = false;
      type.value = kind;
      const options = recent.map((period, index) => new Option(`${index === 0 ? 'Latest ready · ' : ''}${formatReportingPeriod(period)}`, index === 0 ? 'latest' : `${period.start}|${period.end}`));
      const key = selection ? `${selected.start}|${selected.end}` : 'latest';
      if (selection && !options.some(option => option.value === key)) options.push(new Option(formatReportingPeriod(selected), key));
      if (document.activeElement !== choice) choice.replaceChildren(...options);
      choice.value = key;
      const prior = (ctx.runs || []).filter(run => run.reportingPeriod?.start === selected.start && run.reportingPeriod?.end === selected.end && run.reportingPeriod?.kind === selected.kind && (!ctx.target || run.target === ctx.target) && (ctx.target !== 'published' || ctx.publishedVersion === undefined || run.publishedVersion === ctx.publishedVersion));
      const newest = resolveReportingPeriod({ ...active, settlingMinutes: 0 }, ctx.model, now());
      const pending = newest.end !== recent[0].end ? ` Next closed period is waiting for late data until ${new Intl.DateTimeFormat(undefined, { timeZone: config.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(Date.parse(newest.end) + config.settlingMinutes * 60000))}.` : '';
      const input = ctx.inputSourceId === null ? ' Runs use the saved measurements. Enter totals for the selected period; rate readings use its elapsed duration.' : '';
      detail.textContent = `${config.timeZone} · ${number(selected.periodHours)} elapsed ${selected.periodHours === 1 ? 'hour' : 'hours'} · Ready.${prior.length ? ` ${prior.length} previous run${prior.length === 1 ? '' : 's'}. A rerun ${ctx.inputSourceId === null ? 'uses saved measurements' : 'reads the source again'} and creates a new record in retained history.` : ''}${pending}${input}`;
      detail.classList.remove('is-error');
    } catch (error) {
      selected = null; invalid = true; detail.textContent = error.message; detail.classList.add('is-error');
    }
  }
  type.onchange = () => { kind = type.value; selection = null; changed(); };
  choice.onchange = () => { const [start, end] = choice.value.split('|'); selection = choice.value === 'latest' ? null : { start, end, kind }; changed(); };
  container.querySelector('[data-period-earlier]').onclick = () => {
    refresh();
    const ctx = context(); if (!ctx?.id || !selected) return;
    const config = settings(ctx), form = dialog.querySelector('form');
    form.elements.start.value = utcInput(selected.start); form.elements.end.value = utcInput(selected.end);
    form.elements.end.max = utcInput(now() - config.settlingMinutes * 60000);
    dialog.querySelector('[data-period-guidance]').textContent = kind === 'batch' ? 'Choose any completed batch start and end. The elapsed duration is used for rate conversions.' : `Choose one complete ${kinds[kind].toLowerCase()} aligned with ${config.timeZone} reporting boundaries. To use arbitrary start and end times, select Batch.`;
    dialog.querySelector('[data-period-error]').classList.add('hidden'); dialog.showModal();
  };
  for (const button of dialog.querySelectorAll('[data-period-close],[data-period-cancel]')) button.onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = event => {
    event.preventDefault();
    try {
      const form = event.currentTarget, ctx = context();
      const requested = { start: new Date(`${form.elements.start.value}Z`).toISOString(), end: new Date(`${form.elements.end.value}Z`).toISOString(), kind };
      resolveReportingPeriod({ ...settings(ctx), kind }, ctx.model, now(), requested);
      selection = requested; dialog.close(); changed();
    } catch (error) { const field = dialog.querySelector('[data-period-error]'); field.textContent = error.message; field.classList.remove('hidden'); }
  };
  return {
    refresh,
    value() { refresh(); if (invalid || !selected) throw new Error(detail.textContent || 'Select a completed reporting period.'); return { start: selected.start, end: selected.end, kind: selected.kind }; },
    get selected() { return selected; },
    select(period) {
      if (!period) return;
      refresh();
      if (selection === null && selected?.start === period.start && selected?.end === period.end && selected?.kind === period.kind) return;
      kind = period.kind || kind; selection = { start: period.start, end: period.end, kind }; refresh();
    },
    get valid() { return !invalid && Boolean(selected); },
    setEnabled(enabled) { container.querySelectorAll('select,button').forEach(control => control.disabled = !enabled); },
    destroy() { dialog.remove(); }
  };
}
