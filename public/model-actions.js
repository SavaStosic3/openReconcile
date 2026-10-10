const clone = value => structuredClone(value);

export function modelActionPermissions(user, permission = {}) {
  const canView = Boolean(user?.active && permission.canView);
  return {
    canRename: canView && Boolean(permission.canEdit),
    canDuplicate: canView && ['admin', 'editor'].includes(user.role),
    canDelete: canView && user.role === 'admin' && Boolean(permission.canDelete)
  };
}

export function createModelActions({ backend }) {
  let busy = false;
  const permissions = id => modelActionPermissions(backend.user, backend.permission(id));

  function requireReviewedRevision(permission, revision) {
    if (revision !== undefined && permission.revision !== revision) {
      const error = new Error('This model changed. Refresh the gallery and review the action again.');
      error.status = 409;
      throw error;
    }
  }

  async function perform(id, action, operation) {
    if (busy) throw new Error('Another model action is in progress.');
    busy = true;
    try {
      // Save queued edits before reading the server's current model and policy.
      // Each write still uses the server's revision and authorization checks.
      await backend.flush();
      await backend.refresh();
      const entry = backend.workspace.catalog.models.find(model => model.id === id);
      if (!entry || !backend.permission(id).canView) throw new Error('You no longer have access to this model.');
      if (!permissions(id)[{ rename: 'canRename', duplicate: 'canDuplicate', delete: 'canDelete' }[action]]) {
        throw new Error(`You do not have permission to ${action} this model.`);
      }
      const activeId = backend.workspace.catalog.activeId;
      return await operation(clone(entry), backend.permission(id), activeId);
    } finally { busy = false; }
  }

  return {
    permissions,
    get busy() { return busy; },
    rename(id, value, { revision } = {}) {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name || name.length > 160) return Promise.reject(new Error('Enter a model name of 1–160 characters.'));
      return perform(id, 'rename', async (entry, permission) => {
        requireReviewedRevision(permission, revision);
        const model = { ...entry.model, name };
        const result = await backend.api(`/api/models/${encodeURIComponent(id)}`, 'PATCH', { model, revision: permission.revision });
        await backend.refresh();
        return { action: 'rename', id, entry: result.entry, activeId: backend.workspace.catalog.activeId };
      });
    },
    duplicate(id, { view = 'editing' } = {}) {
      if (!['editing', 'published'].includes(view)) return Promise.reject(new Error('Choose the published model or draft to duplicate.'));
      return perform(id, 'duplicate', async (entry, _permission, activeId) => {
        if (view === 'published' && (!backend.permission(id).published || !entry.publishedModel)) throw new Error('This model is no longer published. Refresh the gallery.');
        const source = view === 'published' ? entry.publishedModel : entry.model;
        const model = { ...source, name: `${source.name.slice(0, 153)} (copy)` };
        // The existing creation endpoint intentionally starts a separate draft:
        // no publication, connector configuration, run history or copied grants.
        const duplicate = await backend.create(model);
        const catalog = backend.workspace.catalog;
        backend.select(catalog.models.some(model => model.id === activeId) ? activeId : catalog.models[0]?.id ?? null);
        return { action: 'duplicate', id: duplicate.id, entry: clone(duplicate), activeId: backend.workspace.catalog.activeId };
      });
    },
    remove(id, { revision } = {}) {
      return perform(id, 'delete', async (entry, permission, activeId) => {
        requireReviewedRevision(permission, revision);
        await backend.api(`/api/admin/models/${encodeURIComponent(id)}`, 'DELETE', { revision: permission.revision });
        await backend.refresh();
        return { action: 'delete', id, entry, activeId: backend.workspace.catalog.activeId, deletedActive: activeId === id };
      });
    }
  };
}
