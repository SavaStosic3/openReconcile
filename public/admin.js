const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const clone = value => structuredClone(value);
const roles = ['viewer', 'operator', 'editor', 'admin'];
const levels = ['none', 'viewer', 'operator', 'editor'];
const rank = { none: 0, viewer: 1, operator: 2, editor: 3, admin: 4 };
const title = value => String(value ?? '').replace(/^./, character => character.toUpperCase());
const modelName = model => model.name || model.model?.name || 'Untitled model';
const date = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const options = (values, selected) => values.map(value => `<option value="${value}"${value === selected ? ' selected' : ''}>${value === 'none' ? 'No access' : title(value)}</option>`).join('');
const folderIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 7h17v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7Z"/><path d="M3.5 7V5A1.5 1.5 0 0 1 5 3.5h5l2 3.5"/></svg>';

export function createAdmin({ api, getUser, onChange, onBack, beforeOpen, onToast }) {
  let data = null, selectedId = null, pageOpen = false, busy = false, deleting = null, requestId = 0;

  function message(text = '', error = false) {
    $('#admin-error').textContent = error ? text : '';
    $('#admin-error').classList.toggle('hidden', !error);
    $('#admin-message').textContent = error ? '' : text;
  }
  function closeMenu() {
    $('#app-menu').hidden = true;
    $('#menu-button').setAttribute('aria-expanded', 'false');
  }
  function authorized() {
    const user = getUser?.();
    const allowed = user?.role === 'admin' && user.active !== false;
    $('#menu-admin').hidden = !allowed;
    return allowed;
  }
  function clearData() {
    data = null;
    selectedId = null;
    $('#admin-content').hidden = true;
    $('#admin-users-list').replaceChildren();
    $('#admin-models-list').replaceChildren();
    $('#admin-model-detail').replaceChildren();
  }
  function setBusy(value) {
    busy = value;
    $('#view-admin').dataset.busy = String(value);
    $('#view-admin').setAttribute('aria-busy', String(value));
    $('#admin-refresh').disabled = value;
    $('#admin-delete-submit').disabled = value;
    if (data) render();
  }
  function effective(user, level) {
    if (user.active === false) return 'Account disabled';
    if (user.role === 'admin') return 'Admin · all models';
    const levelName = levels[Math.min(rank[user.role] ?? 0, rank[level] ?? 0)];
    return levelName === 'none' ? 'No access' : title(levelName);
  }
  function renderUsers() {
    $('#admin-users-list').innerHTML = data.users.length ? `<table class="admin-table"><thead><tr><th>User</th><th>Account role</th><th>Account access</th><th><span class="sr-only">Save user settings</span></th></tr></thead><tbody>${data.users.map(user => `<tr data-user-id="${esc(user.id)}"><td><span class="admin-user-name">${esc(user.name || user.email || 'Workspace user')}${user.id === getUser()?.id ? '<span class="admin-user-self">You</span>' : ''}</span><span class="admin-user-email">${esc(user.email)}</span></td><td><select class="admin-user-role" aria-label="Account role for ${esc(user.name || user.email)}"${busy ? ' disabled' : ''}>${options(roles, user.role)}</select></td><td><label class="admin-account-active"><input class="admin-user-active" type="checkbox" aria-label="Enable account for ${esc(user.name || user.email)}"${user.active !== false ? ' checked' : ''}${busy ? ' disabled' : ''}> Enabled</label></td><td><button type="button" class="button secondary" data-action="save-user" aria-label="Save account settings for ${esc(user.name || user.email)}"${busy ? ' disabled' : ''}>Save</button></td></tr>`).join('')}</tbody></table>` : '<div class="admin-list-empty"><p>No users have signed in yet.</p></div>';
  }
  function renderModels() {
    const visible = data.models.filter(model => $('#admin-show-deleted').checked || !model.deletedAt);
    if (!visible.some(model => model.id === selectedId)) selectedId = visible[0]?.id ?? null;
    $('#admin-models-list').innerHTML = visible.length ? visible.map(model => `<button type="button" class="admin-model-item" data-model-id="${esc(model.id)}" aria-pressed="${model.id === selectedId}"${busy ? ' disabled' : ''}>${folderIcon}<span><strong>${esc(modelName(model))}</strong><small>Revision ${esc(model.revision)}${model.deletedAt ? ` · Deleted ${esc(date(model.deletedAt))}` : ''}</small><span class="admin-model-tags"><span class="admin-model-tag${model.deletedAt ? ' deleted' : model.published ? ' published' : ''}">${model.deletedAt ? 'Deleted' : model.published ? 'Published · active' : 'Draft'}</span>${model.editLocked ? '<span class="admin-model-tag">Editing locked</span>' : ''}${model.unpublishLocked ? '<span class="admin-model-tag">Unpublishing locked</span>' : ''}</span></span></button>`).join('') : '<div class="admin-list-empty"><p>No models available. Create a model in Model editor.</p></div>';
    renderDetail();
  }
  function renderDetail() {
    const model = data.models.find(item => item.id === selectedId);
    if (!model) {
      $('#admin-model-detail').innerHTML = '<div class="admin-detail-empty"><h2>Select a model</h2><p>Select a model from the list to manage its permissions and protection.</p></div>';
      return;
    }
    const heading = `<div class="admin-detail-header"><div><h2 id="admin-selected-model-heading">${esc(modelName(model))}</h2><p>Revision ${esc(model.revision)}</p></div><span class="admin-model-tag${model.deletedAt ? ' deleted' : model.published ? ' published' : ''}">${model.deletedAt ? 'Deleted' : model.published ? 'Published' : 'Draft'}</span></div>`;
    if (model.deletedAt) {
      $('#admin-model-detail').innerHTML = `${heading}<div class="admin-restore-panel"><h3>This model is deleted.</h3><p>Deleted ${esc(date(model.deletedAt))}. Restore it as a draft to make it available again. Its schedule stays disabled until it is published and configured.</p><button type="button" class="button secondary" data-action="restore-model"${busy ? ' disabled' : ''}>Restore model</button></div>`;
      return;
    }
    const disabled = busy ? ' disabled' : '';
    const publicationDisabled = busy || (model.published && model.unpublishLocked);
    $('#admin-model-detail').innerHTML = `${heading}
      <form id="admin-protection-form" class="admin-protection-form"><h3>Publication &amp; protection</h3>
        <label class="admin-policy"><input id="admin-model-published" type="checkbox"${model.published ? ' checked' : ''}${publicationDisabled ? ' disabled' : ''}><span><strong>Published model</strong><small>Published models are active and can run on a schedule. Draft models can be edited and run manually.</small></span></label>
        <label class="admin-policy"><input id="admin-model-edit-locked" type="checkbox"${model.editLocked ? ' checked' : ''}${disabled}><span><strong>Lock editing</strong><small>Prevent changes to the flowsheet and measurements for everyone. An administrator must unlock it before editing.</small></span></label>
        <label class="admin-policy"><input id="admin-model-unpublish-locked" type="checkbox"${model.unpublishLocked ? ' checked' : ''}${disabled}><span><strong>Lock unpublishing</strong><small>Keep this model published until an administrator removes the lock.</small></span></label>
        <div class="admin-policy-actions"><button type="submit" class="button primary"${disabled}>Save model settings</button></div><p class="admin-policy-note">${model.published && model.unpublishLocked ? 'To unpublish this model, clear Lock unpublishing and save first. Then clear Published model and save again.' : 'Unpublishing stops scheduled runs. Only administrators can delete models.'}</p>
      </form>
      <div class="admin-grants-heading"><h3>Model permissions</h3><p>Assign a level for each user. Their account role limits the permissions they can use. Administrators have full access to all models.</p></div>
      <div class="admin-table-wrap"><table class="admin-table admin-grants-table"><thead><tr><th>User</th><th>Model permission</th><th><span class="sr-only">Save model permission</span></th></tr></thead><tbody>${data.users.map(user => {
        const level = data.grants.find(grant => grant.modelId === model.id && grant.userId === user.id)?.level ?? 'none';
        const admin = user.role === 'admin';
        return `<tr data-grant-user-id="${esc(user.id)}"><td><span class="admin-user-name">${esc(user.name || user.email || 'Workspace user')}</span><span class="admin-user-email">${esc(user.email)}</span></td><td><select class="admin-grant-level" aria-label="Model permission for ${esc(user.name || user.email)}"${busy || admin ? ' disabled' : ''}>${admin ? '<option>Admin · all models</option>' : options(levels, level)}</select><span class="admin-effective-level">Effective: ${esc(effective(user, level))}</span></td><td><button type="button" class="button secondary" data-action="save-grant" aria-label="Save model permission for ${esc(user.name || user.email)}"${busy || admin ? ' disabled' : ''}>Save</button></td></tr>`;
      }).join('')}</tbody></table></div>
      <div class="admin-danger-zone"><div><h3>Delete model</h3><p>Remove this model from the workspace and stop its schedule. You can restore it later.</p></div><button type="button" class="button danger" data-action="delete-model"${disabled}>Delete model</button></div>`;
  }
  function render() {
    if (!data || !authorized()) return;
    $('#admin-content').hidden = false;
    const current = data.models.filter(model => !model.deletedAt);
    $('#admin-users-count').textContent = data.users.length;
    $('#admin-models-count').textContent = current.length;
    $('#admin-protected-count').textContent = current.filter(model => model.editLocked).length;
    renderUsers();
    renderModels();
  }
  async function refresh() {
    if (!authorized()) {
      clearData();
      message('Administrator access is required to open this page.', true);
      return false;
    }
    const request = ++requestId;
    setBusy(true);
    message('Loading workspace users and models…');
    try {
      const next = await api('/api/admin');
      if (request !== requestId || !authorized()) return false;
      if (!Array.isArray(next.users) || !Array.isArray(next.models) || !Array.isArray(next.grants)) throw new Error('The administration response could not be read. Please refresh.');
      data = clone(next);
      render();
      message();
      return true;
    } catch (error) {
      if (request !== requestId) return false;
      // Never leave previously loaded admin data visible after access is lost.
      clearData();
      message(error.message || 'Workspace administration could not be loaded.', true);
      return false;
    } finally {
      if (request === requestId) setBusy(false);
    }
  }
  async function open() {
    if (!authorized()) {
      clearData();
      onToast?.('Only an administrator can open Admin.');
      return;
    }
    try {
      await beforeOpen?.();
      if (!authorized()) return;
      closeMenu();
      pageOpen = true;
      document.querySelectorAll('[role="tabpanel"]').forEach(view => view.classList.add('hidden'));
      $('#view-management').classList.add('hidden');
      $('#workspace-empty').hidden = true;
      $('#view-admin').classList.remove('hidden');
      document.body.classList.add('is-admin');
      $('#menu-admin').setAttribute('aria-current', 'page');
      $('#admin-heading').focus();
      await refresh();
    } catch (error) {
      onToast?.(error.message || 'Admin could not be opened.');
    }
  }
  function leave() {
    pageOpen = false;
    closeMenu();
    $('#view-admin').classList.add('hidden');
    document.body.classList.remove('is-admin');
    $('#menu-admin').removeAttribute('aria-current');
    if (!authorized()) clearData();
  }
  async function mutate(path, method, body, success) {
    if (busy || !authorized()) return false;
    setBusy(true);
    message();
    try {
      await api(path, method, body);
      await onChange?.();
      if (!authorized()) {
        clearData();
        leave();
        onBack?.();
        onToast?.('Your account permissions have changed.');
        return true;
      }
      const loaded = await refresh();
      if (loaded) message(success);
      return true;
    } catch (error) {
      if (error.status === 401 || error.status === 403) clearData();
      message(error.message || 'The change could not be saved.', true);
      if (error.status === 409) onToast?.(error.message || 'This change conflicts with the current workspace state. Refresh before trying again.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function action(event) {
    const button = event.target.closest('button[data-action]');
    if (!button || busy || !authorized()) return;
    const kind = button.dataset.action;
    if (kind === 'save-user') {
      const row = button.closest('[data-user-id]');
      const userId = row.dataset.userId;
      const role = row.querySelector('.admin-user-role').value;
      const active = row.querySelector('.admin-user-active').checked;
      await mutate(`/api/admin/users/${encodeURIComponent(userId)}`, 'PATCH', { role, active }, 'User account settings saved.');
      return;
    }
    const model = data.models.find(item => item.id === selectedId);
    if (!model) return;
    const base = `/api/admin/models/${encodeURIComponent(model.id)}`;
    if (kind === 'save-grant') {
      const row = button.closest('[data-grant-user-id]');
      await mutate(`${base}/permissions`, 'PUT', { userId: row.dataset.grantUserId, level: row.querySelector('.admin-grant-level').value }, 'Model permission saved.');
    } else if (kind === 'restore-model') {
      await mutate(`${base}/restore`, 'POST', { revision: model.revision }, 'Model restored as a draft. Review its permissions before publishing.');
    } else if (kind === 'delete-model') {
      deleting = clone(model);
      $('#admin-delete-description').textContent = `Delete “${modelName(model)}”? ${model.published ? 'This is an active, published model.' : 'This model is currently a draft.'}`;
      $('#admin-delete-confirm').value = '';
      $('#admin-delete-error').textContent = '';
      $('#admin-delete-error').classList.add('hidden');
      $('#admin-delete-dialog').showModal();
      $('#admin-delete-confirm').focus();
    }
  }
  $('#menu-admin').addEventListener('click', open);
  $('#admin-back').addEventListener('click', () => { leave(); onBack?.(); });
  $('#admin-refresh').addEventListener('click', refresh);
  $('#admin-show-deleted').addEventListener('change', () => { if (data) renderModels(); });
  $('#admin-users-list').addEventListener('click', action);
  $('#admin-model-detail').addEventListener('click', action);
  $('#admin-model-detail').addEventListener('submit', async event => {
    if (event.target.id !== 'admin-protection-form') return;
    event.preventDefault();
    const model = data?.models.find(item => item.id === selectedId);
    if (!model || busy) return;
    const body = { revision: model.revision, published: $('#admin-model-published').checked, editLocked: $('#admin-model-edit-locked').checked, unpublishLocked: $('#admin-model-unpublish-locked').checked };
    await mutate(`/api/admin/models/${encodeURIComponent(model.id)}`, 'PATCH', body, 'Model publication and protection settings saved.');
  });
  $('#admin-models-list').addEventListener('click', event => {
    const button = event.target.closest('[data-model-id]');
    if (!button || busy || !data) return;
    selectedId = button.dataset.modelId;
    renderModels();
  });
  for (const selector of ['#admin-delete-close', '#admin-delete-cancel']) $(selector).addEventListener('click', () => $('#admin-delete-dialog').close());
  $('#admin-delete-dialog').addEventListener('close', () => { deleting = null; });
  $('#admin-delete-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!deleting || busy || $('#admin-delete-confirm').value !== 'DELETE') return;
    const target = clone(deleting);
    const success = await mutate(`/api/admin/models/${encodeURIComponent(target.id)}`, 'DELETE', { revision: target.revision }, 'Model deleted. Show deleted models to restore it.');
    if (success) $('#admin-delete-dialog').close();
    else {
      $('#admin-delete-error').textContent = $('#admin-error').textContent || 'The model could not be deleted.';
      $('#admin-delete-error').classList.remove('hidden');
    }
  });
  authorized();
  return { open, leave, refresh, get isOpen() { return pageOpen; } };
}
