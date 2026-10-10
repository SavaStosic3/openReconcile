const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inputUnits = ['kg', 't', 'g', 'kg/h', 't/h', 'm³', 'L', 'm³/h', 'L/h', 'm', 'cm', 'mm'];
const outputMetrics = ['mass', 'incoming_mass', 'outgoing_mass', 'opening_inventory', 'closing_inventory', 'accumulation'];
const outputUnits = ['kg', 't', 'g', 'kg/h', 't/h'];
const metricName = value => ({ mass: 'Stream mass', incoming_mass: 'Incoming mass', outgoing_mass: 'Outgoing mass', opening_inventory: 'Opening inventory', closing_inventory: 'Closing inventory', accumulation: 'Accumulation' })[value];

export function createPiConnectionSettings({ backend, onSaved }) {
  const $ = id => document.querySelector(`#${id}`), dialog = $('pi-connection-dialog');
  // The source-controller tests use a deliberately small document fixture.
  if (typeof dialog?.showModal !== 'function') return { leave() {} };
  const form = $('pi-connection-form');
  let state = { revision: 0, profiles: [], available: false }, current = null, busy = false, generation = 0, confirmingDelete = false;
  const authorized = () => backend.user.active !== false && backend.user.role === 'admin';
  const message = (text = '', error = false) => { $('pi-configuration-message').textContent = text; $('pi-configuration-message').classList.toggle('is-error', error); };
  function controls() {
    const readOnly = current?.readOnly || !state.available, enabled = authorized() && !busy && !readOnly;
    for (const control of form.querySelectorAll('input,select,button')) control.disabled = !enabled;
    $('pi-connection-cancel').disabled = busy;
    $('pi-connection-close').disabled = busy;
    $('pi-add-connection').disabled = !authorized() || busy || !state.available;
    $('pi-connection-save').hidden = Boolean(current?.readOnly);
    $('pi-connection-test').hidden = Boolean(current?.readOnly);
    $('pi-connection-delete').hidden = !current || Boolean(current.readOnly);
    $('pi-credential-help').textContent = current?.readOnly ? 'This connection is managed by the server file. Its credentials are never returned to the browser.' : current ? 'A credential is saved. Leave this blank to keep it. Enter a new credential when changing the endpoint, account, or authentication method.' : 'Credentials are encrypted on the server. Enter them here once; saved passwords and tokens are never returned to the browser.';
  }
  function authFields() {
    const basic = form.elements.authType.value === 'basic';
    $('pi-username-field').hidden = !basic;
    form.elements.username.required = basic;
    $('pi-credential-label').textContent = basic ? 'Password' : 'Proxy bearer token';
    form.elements.credential.value = '';
    form.elements.credential.placeholder = current ? 'Saved credential · leave blank to keep' : basic ? 'Service account password' : 'Company proxy token';
  }
  const option = (value, label = value) => `<option value="${esc(value)}">${esc(label)}</option>`;
  function addBinding(direction, binding = {}) {
    const row = document.createElement('div'); row.className = 'pi-binding-row'; row.dataset.direction = direction;
    row.innerHTML = `<label class="field">Source Name<input data-binding="sourceName" maxlength="200" required placeholder="PLANT.FEED.FLOW"></label><label class="field pi-path-field">PI point or AF path<input data-binding="path" maxlength="2048" required placeholder="\\\\PIARCHIVE\\FEED.FLOW"></label>${direction === 'outputs' ? `<label class="field">Result metric<select data-binding="metric">${outputMetrics.map(metric => option(metric, metricName(metric))).join('')}</select></label>` : ''}<label class="field">Unit<select data-binding="unit">${(direction === 'outputs' ? outputUnits : inputUnits).map(unit => option(unit)).join('')}</select></label><button type="button" class="text-button danger pi-remove-binding" aria-label="Remove ${direction === 'inputs' ? 'input' : 'output'} mapping">Remove</button>`;
    for (const field of row.querySelectorAll('[data-binding]')) field.value = binding[field.dataset.binding] ?? (field.dataset.binding === 'unit' ? 'kg' : field.dataset.binding === 'metric' ? 'mass' : '');
    row.querySelector('.pi-remove-binding').onclick = () => { row.remove(); message(); };
    $(`pi-${direction}`).append(row); controls();
  }
  function reset(profile = null) {
    current = profile; confirmingDelete = false; $('pi-connection-delete').textContent = 'Delete connection'; form.reset();
    form.elements.name.value = profile?.name || '';
    form.elements.baseUrl.value = profile?.baseUrl || '';
    form.elements.authType.value = profile?.auth.type || 'basic';
    form.elements.username.value = profile?.auth.username || '';
    authFields(); $('pi-inputs').replaceChildren(); $('pi-outputs').replaceChildren();
    for (const direction of ['inputs', 'outputs']) for (const binding of profile?.[direction] || []) addBinding(direction, binding);
    $('pi-connection-heading').textContent = profile?.readOnly ? 'Server-managed PI connection' : profile ? 'Edit PI connection' : 'Add PI connection';
    $('pi-connection-origin').textContent = profile?.readOnly ? 'Server file' : 'Encrypted server configuration';
    message(); controls();
  }
  function renderList() {
    $('pi-connections-list').innerHTML = state.profiles.length ? state.profiles.map(profile => `<article class="pi-connection-card"><div><h3>${esc(profile.name)}</h3><p>${esc(profile.baseUrl)}</p><small>${profile.inputs.length} input mappings · ${profile.outputs.length} output mappings · ${profile.auth.type === 'basic' ? 'HTTPS Basic' : 'Company proxy'} · ${profile.readOnly ? 'Server file' : 'Credentials saved'}</small></div><button type="button" class="button secondary compact" data-pi-edit="${esc(profile.id)}">${profile.readOnly ? 'View settings' : 'Configure'}</button></article>`).join('') : '<div class="pi-connection-empty"><strong>Connect your plant historian</strong><p>Add the PI Web API endpoint, a service account, and the tags this application can read and write.</p></div>';
    $('pi-connection-storage-note').textContent = state.available ? 'Connections are shared across models. Credentials stay encrypted on the server; changes invalidate affected sources and pause selected schedules.' : 'Connection storage needs the installation’s server authentication secret. Ask the server administrator to restore or configure it.';
    controls();
  }
  async function refresh() {
    if (!authorized()) return;
    const epoch = ++generation;
    const result = await backend.api('/api/admin/pi/connections');
    if (epoch !== generation || !authorized()) return;
    state = result; renderList();
  }
  function profileFromForm() {
    const auth = form.elements.authType.value === 'basic' ? { type: 'basic', username: form.elements.username.value.trim() } : { type: 'bearer' };
    if (form.elements.credential.value) auth[auth.type === 'basic' ? 'password' : 'token'] = form.elements.credential.value;
    const profile = { id: current?.id || `pi-${crypto.randomUUID()}`, name: form.elements.name.value.trim(), baseUrl: form.elements.baseUrl.value.trim(), auth, inputs: [], outputs: [] };
    for (const row of form.querySelectorAll('.pi-binding-row')) profile[row.dataset.direction].push(Object.fromEntries([...row.querySelectorAll('[data-binding]')].map(field => [field.dataset.binding, field.value.trim()])));
    return profile;
  }
  async function action(operation) {
    if (!authorized() || busy || current?.readOnly || !state.available || !form.reportValidity()) return;
    const epoch = generation; busy = true; controls(); message();
    try {
      const profile = profileFromForm();
      if (operation === 'test') {
        await backend.api('/api/admin/pi/connections/test', 'POST', { profile, revision: state.revision });
        if (epoch === generation && authorized()) message('Connection, numeric mappings, and units verified. No output values were written.');
      } else {
        const result = await backend.api(`/api/admin/pi/connections/${encodeURIComponent(profile.id)}`, 'PUT', { profile, revision: state.revision });
        form.elements.credential.value = '';
        if (epoch !== generation || !authorized()) return;
        state = result; current = state.profiles.find(item => item.id === profile.id); renderList();
        message('Connection saved. Choose it for an input or output source below.');
        await onSaved?.();
        dialog.close(); form.reset();
      }
    } catch (error) { if (epoch === generation && authorized()) message(error.message || 'The PI configuration could not be saved.', true); }
    finally { busy = false; controls(); }
  }
  const open = profile => { if (!authorized() || busy) return; reset(profile); dialog.showModal(); form.elements.name.focus(); };
  $('pi-manage-connections').onclick = async () => {
    if (!authorized()) return;
    $('pi-connection-settings').hidden = !$('pi-connection-settings').hidden;
    if (!$('pi-connection-settings').hidden) { try { await refresh(); } catch (error) { $('pi-connection-storage-note').textContent = error.message; } }
  };
  $('pi-add-connection').onclick = () => open(null);
  $('pi-connections-list').onclick = event => { const button = event.target.closest('[data-pi-edit]'); if (button) open(state.profiles.find(profile => profile.id === button.dataset.piEdit)); };
  $('pi-add-input').onclick = () => addBinding('inputs'); $('pi-add-output').onclick = () => addBinding('outputs');
  form.elements.authType.onchange = authFields;
  form.onsubmit = event => { event.preventDefault(); action('save'); };
  $('pi-connection-test').onclick = () => action('test');
  $('pi-connection-delete').onclick = async () => {
    if (!authorized() || busy || !current || current.readOnly) return;
    if (!confirmingDelete) { confirmingDelete = true; $('pi-connection-delete').textContent = 'Confirm deletion'; message('Delete this connection and its saved credential? Remove any model sources using it first.'); return; }
    busy = true; controls(); const epoch = generation;
    try {
      const result = await backend.api(`/api/admin/pi/connections/${encodeURIComponent(current.id)}`, 'DELETE', { revision: state.revision });
      if (epoch !== generation || !authorized()) return;
      state = result; renderList(); dialog.close(); reset(); await onSaved?.();
    } catch (error) { if (epoch === generation && authorized()) message(error.message || 'The connection could not be deleted.', true); }
    finally { busy = false; controls(); }
  };
  const close = () => { if (!busy) { dialog.close(); reset(); } };
  $('pi-connection-cancel').onclick = close; $('pi-connection-close').onclick = close;
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else reset(); });
  dialog.addEventListener('close', () => { form.elements.credential.value = ''; });
  form.addEventListener('input', () => message()); form.addEventListener('change', () => message());
  const leave = () => { generation++; form.elements.credential.value = ''; dialog.close(); $('pi-connection-settings').hidden = true; state = { revision: 0, profiles: [], available: false }; $('pi-connections-list').replaceChildren(); };
  backend.subscribe(() => { if (!authorized()) leave(); });
  return { leave };
}
