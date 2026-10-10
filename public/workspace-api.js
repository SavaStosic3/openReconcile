const clone = value => structuredClone(value);
const $ = selector => document.querySelector(selector);

export async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'The request could not be completed.'); error.status = response.status; throw error; }
  return data;
}

function showAuth(message, title = 'Sign in to MassFlow') {
  document.body.classList.add('is-auth');
  $('#auth-screen').hidden = false;
  $('#workspace-main').hidden = true;
  $('#auth-title').textContent = title;
  $('#auth-message').textContent = message;
  $('#auth-retry').onclick = () => location.reload();
  for (const dialog of document.querySelectorAll?.('dialog[open]') || []) dialog.close();
  const menu = $('#app-menu'), menuButton = $('#menu-button'), adminButton = $('#menu-admin');
  if (menu) menu.hidden = true;
  menuButton?.setAttribute?.('aria-expanded', 'false');
  if (adminButton) adminButton.hidden = true;
}

export async function connectWorkspace(onError) {
  let session, state;
  try {
    session = await api('/api/session');
    state = await api('/api/workspace');
  } catch (error) {
    showAuth(error.status === 401 ? 'Sign in with ChatGPT to access the models assigned to your account.' : error.message, error.status === 403 ? 'Account access is unavailable' : 'Sign in to MassFlow');
    // Sign-in is a normal top-level navigation; this document resumes on reload.
    return new Promise(() => {});
  }
  const preference = `openreconcile-active-model-${session.user.id}`;
  try { const preferred = localStorage.getItem(preference); if (state.catalog.models.some(entry => entry.id === preferred)) state.catalog.activeId = preferred; } catch {}
  document.body.classList.remove('is-auth');
  $('#auth-screen').hidden = true;
  $('#workspace-main').hidden = false;
  const listeners = new Set(), drafts = new Map(), failedDrafts = new Map(), waiters = new Map();
  let timer = null, tail = Promise.resolve(), pendingOperations = 0, saving = false, accessUnavailable = null, recoveryModelId = state.catalog.activeId;
  let serverClockOffset = Number.isFinite(Date.parse(state.serverTime)) ? Date.parse(state.serverTime) - Date.now() : 0;
  const report = message => { try { onError?.(message); } catch {} };
  const notify = reason => { for (const listener of listeners) { try { listener(reason); } catch (error) { report(error.message || 'The workspace view could not be updated.'); } } };
  function enqueue(action) {
    pendingOperations++;
    const operation = tail.then(action);
    // Keep the operation queue usable after a rejected request. Callers still
    // receive the original rejection; later dependent actions check saved state.
    tail = operation.catch(() => {}).finally(() => { pendingOperations--; notify('idle'); });
    return operation;
  }
  async function request(path, method = 'GET', body) {
    if (accessUnavailable) throw accessUnavailable;
    try { return await api(path, method, body); }
    catch (error) {
      const resource = path.split('?')[0];
      if (error.status === 401 || (error.status === 403 && ['/api/session', '/api/workspace'].includes(resource))) revokeAccess(error);
      throw error;
    }
  }
  function revokedUser() { return { id: session.user.id, email: '', name: '', role: null, active: false }; }
  function revokeAccess(error) {
    accessUnavailable = error; error.authUnavailable = true;
    recoveryModelId = state.catalog.activeId;
    clearTimeout(timer); timer = null;
    // Keep local drafts in this authenticated namespace, never in a newly
    // connected account's catalog. Reconnection requires a full page reload.
    for (const [id, model] of drafts) { failedDrafts.set(id, { model: clone(model), error }); settle(id, false); }
    drafts.clear();
    showAuth(error.status === 403 ? 'Your account access is unavailable. Contact an administrator before trying again.' : 'Your session ended. Sign in again to continue.', error.status === 403 ? 'Account access is unavailable' : 'Sign in to MassFlow');
    notify('auth');
  }
  function visibleWorkspace() {
    return accessUnavailable ? { user: revokedUser(), catalog: { version: 1, activeId: null, models: [], schedules: {}, sources: {}, runs: {} }, permissions: {}, serverTime: state.serverTime } : state;
  }
  function installWorkspace(next, reason) {
    const activeId = state.catalog.activeId;
    if (next.catalog.models.some(entry => entry.id === activeId)) next.catalog.activeId = activeId;
    state = next;
    if (Number.isFinite(Date.parse(next.serverTime))) serverClockOffset = Date.parse(next.serverTime) - Date.now();
    session.user = next.user;
    notify(reason);
  }
  function revision(id) { const permission = state.permissions[id]; if (!permission) throw new Error('You no longer have access to this model.'); return permission.revision; }
  async function sync() { installWorkspace(await request('/api/workspace'), 'refresh'); return clone(state); }
  function applyChange(id, result, reason) {
    if (result.entry) {
      const index = state.catalog.models.findIndex(entry => entry.id === id);
      if (index < 0) state.catalog.models.push(result.entry); else state.catalog.models[index] = result.entry;
      if (!state.catalog.activeId) state.catalog.activeId = id;
    }
    if (result.permission) state.permissions[id] = result.permission;
    if (result.schedule) state.catalog.schedules[id] = result.schedule;
    if (result.sources) state.catalog.sources[id] = result.sources;
    if (result.runs) state.catalog.runs[id] = result.runs;
    if (result.run) state.catalog.runs[id] = [...(state.catalog.runs[id] || []), result.run].slice(-20);
    notify(reason);
  }
  function blockedSave() {
    const original = failedDrafts.values().next().value?.error;
    const error = new Error(`Changes could not be saved. Export your draft, then refresh or try saving again.${original?.message ? ` ${original.message}` : ''}`);
    error.status = original?.status;
    error.unsavedDraft = true;
    return error;
  }
  function settle(id, saved) {
    for (const waiter of waiters.get(id) || []) waiter.resolve(saved);
    waiters.delete(id);
  }
  function preserveFailure(id, model, error, waiting) {
    // An edit may arrive while its preceding PATCH is in flight. Keep the
    // newest local draft and settle both generations without an implicit retry.
    failedDrafts.set(id, { model: clone(drafts.get(id) || model), error });
    drafts.delete(id);
    for (const waiter of waiting) waiter.resolve(false);
    settle(id, false);
    for (const [otherId, otherModel] of drafts) {
      failedDrafts.set(otherId, { model: clone(otherModel), error });
      settle(otherId, false);
    }
    drafts.clear();
  }
  async function drain() {
    clearTimeout(timer); timer = null;
    saving = true;
    try {
      while (drafts.size) {
        const [id, model] = drafts.entries().next().value;
        drafts.delete(id);
        const waiting = waiters.get(id) || []; waiters.delete(id);
        try {
          const result = await request(`/api/models/${encodeURIComponent(id)}`, 'PATCH', { model, revision: revision(id) });
          applyChange(id, result, 'save');
          failedDrafts.delete(id);
          for (const waiter of waiting) waiter.resolve(true);
        } catch (error) {
          preserveFailure(id, model, error, waiting);
          const blocked = blockedSave(); report(blocked.message);
          throw blocked;
        }
      }
      if (failedDrafts.size) throw blockedSave();
    } finally { saving = false; }
  }
  function discardDrafts() {
    clearTimeout(timer); timer = null;
    for (const id of waiters.keys()) settle(id, false);
    drafts.clear(); failedDrafts.clear();
  }
  function scheduleDrain() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; enqueue(drain).catch(() => {}); }, 250);
  }
  return {
    get workspace() { return clone(visibleWorkspace()); },
    get user() { return clone(accessUnavailable ? revokedUser() : session.user); },
    get hasPending() { return saving || drafts.size > 0 || failedDrafts.size > 0 || pendingOperations > 0; },
    get hasFailedSave() { return failedDrafts.size > 0; },
    failedDraft(id = accessUnavailable ? recoveryModelId : state.catalog.activeId) { return clone(failedDrafts.get(id)?.model || null); },
    api(path, method = 'GET', body) { return enqueue(async () => { if (method !== 'GET') await drain(); return request(path, method, body); }); },
    permission(id = state.catalog.activeId) { return clone(accessUnavailable ? {} : state.permissions[id] || {}); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    select(id) { if (accessUnavailable) return; state.catalog.activeId = id; recoveryModelId = id; try { localStorage.setItem(preference, id); } catch {} },
    queueSave(id, model) {
      if (accessUnavailable || !state.permissions[id]?.canEdit) return Promise.resolve(false);
      drafts.set(id, clone(model));
      failedDrafts.delete(id);
      scheduleDrain();
      return new Promise(resolve => { const waiting = waiters.get(id) || []; waiting.push({ resolve }); waiters.set(id, waiting); });
    },
    flush() { return enqueue(drain); },
    refresh({ discardDrafts: discard = false } = {}) {
      return enqueue(async () => { if (discard) discardDrafts(); else await drain(); return sync(); });
    },
    create(model) {
      return enqueue(async () => {
        await drain();
        const result = await request('/api/models', 'POST', { model });
        applyChange(result.entry.id, result, 'create');
        state.catalog.activeId = result.entry.id;
        try { localStorage.setItem(preference, result.entry.id); } catch {}
        return result.entry;
      });
    },
    schedule(id, changes) {
      return enqueue(async () => {
        await drain();
        const result = await request(`/api/models/${encodeURIComponent(id)}/schedule`, 'PATCH', { changes, revision: revision(id) });
        applyChange(id, result, 'schedule'); return result;
      });
    },
    sources(id, sources) {
      return enqueue(async () => {
        await drain();
        const result = await request(`/api/models/${encodeURIComponent(id)}/sources`, 'PUT', { sources, revision: revision(id) });
        applyChange(id, result, 'sources'); return result;
      });
    },
    sqlTest(id, source) {
      return enqueue(async () => {
        await drain();
        return request(`/api/models/${encodeURIComponent(id)}/sources/test`, 'POST', { source, revision: revision(id) });
      });
    },
    sqlPreview(id, source, target, period = null) {
      return enqueue(async () => {
        await drain();
        return request(`/api/models/${encodeURIComponent(id)}/sources/preview`, 'POST', { source, revision: revision(id), target, ...(period ? { period } : {}) });
      });
    },
    publication(id, published) {
      return enqueue(async () => {
        await drain();
        const result = await request(`/api/models/${encodeURIComponent(id)}/publication`, 'PATCH', { published, revision: revision(id) });
        applyChange(id, result, 'publication'); return result;
      });
    },
    execute(id, trigger = 'manual', { target, period = null } = {}) {
      return enqueue(async () => {
        await drain();
        const result = await request(`/api/models/${encodeURIComponent(id)}/runs`, 'POST', { trigger, ...(target ? { target } : {}), ...(period ? { period } : {}) });
        applyChange(id, result, 'run'); return result.run;
      });
    },
    destroy() { clearTimeout(timer); listeners.clear(); },
    now() { return Date.now() + serverClockOffset; }
  };
}
