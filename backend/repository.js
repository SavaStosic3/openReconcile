import { ApiError, permissions, requireAdmin, requirePermission } from './policy.js';

const rolesFor = { view: ['viewer', 'operator', 'editor'], run: ['operator', 'editor'], edit: ['editor'] };
const placeholders = values => values.map(() => '?').join(',');
const changed = result => Number(result?.meta?.changes ?? 0) > 0;
const legacyPublication = row => Boolean(row?.published && row.published_model_json === null && row.published_version === 0);
const parse = row => row && ({
  id: row.id, name: row.name, model: JSON.parse(row.model_json), revision: row.revision,
  // Catalog reads project the old live model until its first per-model access.
  // The guarded initialization below persists this same copy before any edit.
  publishedModel: row.published_model_json ? JSON.parse(row.published_model_json) : legacyPublication(row) ? JSON.parse(row.model_json) : null,
  publishedVersion: legacyPublication(row) ? 1 : row.published_version,
  publishedAt: legacyPublication(row) ? row.updated_at : row.published_at,
  hasUnpublishedChanges: !legacyPublication(row) && row.model_json !== row.published_model_json,
  published: Boolean(row.published), editLocked: Boolean(row.edit_locked), unpublishLocked: Boolean(row.unpublish_locked),
  schedule: JSON.parse(row.schedule_json), sources: JSON.parse(row.sources_json),
  createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at
});
const userRow = row => row && ({ id: row.id, email: row.email, name: row.name, role: row.role, active: Boolean(row.active), createdAt: row.created_at });

// Each write repeats authorization in SQL. A role/grant revoked after a read
// cannot authorize an in-flight mutation; revisions independently guard edits.
function accessClause(action, userId) {
  const roles = rolesFor[action];
  return {
    sql: `EXISTS (SELECT 1 FROM users actor LEFT JOIN model_grants grant_row ON grant_row.user_id = actor.id AND grant_row.model_id = models.id WHERE actor.id = ? AND actor.active = 1 AND (actor.role = 'admin' OR (actor.role IN (${placeholders(roles)}) AND grant_row.level IN (${placeholders(roles)}))))`,
    values: [userId, ...roles, ...roles]
  };
}
const adminClause = userId => ({ sql: "EXISTS (SELECT 1 FROM users actor WHERE actor.id = ? AND actor.active = 1 AND actor.role = 'admin')", values: [userId] });
const legacyRun = (run, model) => {
  if (Object.hasOwn(run, 'target')) return run;
  const published = model?.publishedVersion === 1 && model.publishedModel !== null && JSON.stringify(run.modelSnapshot) === JSON.stringify(model.publishedModel);
  return { ...run, target: published ? 'published' : 'draft', publishedVersion: published ? 1 : null };
};

export class Repository {
  constructor(db, { now = () => Date.now(), uuid = () => crypto.randomUUID() } = {}) {
    if (!db?.prepare || !db?.batch) throw new Error('A D1 database binding is required.');
    this.db = db; this.now = now; this.uuid = uuid;
  }
  statement(sql, values = []) { return this.db.prepare(sql).bind(...values); }
  async first(sql, values) { return this.statement(sql, values).first(); }
  async all(sql, values) { return (await this.statement(sql, values).all()).results; }
  stamp() { return new Date(this.now()).toISOString(); }

  async authenticate(identity, adminEmail) {
    if (!identity || typeof identity.id !== 'string' || !identity.id || identity.id.length > 512 || typeof identity.email !== 'string' || !identity.email || identity.email.length > 320) throw new ApiError(401, 'Sign in to access this workspace.');
    const email = identity.email.trim(), name = String(identity.name || email).slice(0, 160), stamp = this.stamp();
    const role = typeof adminEmail === 'string' && adminEmail.trim() && email.toLowerCase() === adminEmail.trim().toLowerCase() ? 'admin' : 'viewer';
    await this.statement("INSERT INTO users (id,email,name,role,active,created_at,updated_at) VALUES (?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name", [identity.id, email, name, role, stamp, stamp]).run();
    const user = await this.user(identity.id);
    if (!user.active) throw new ApiError(403, 'Your account is disabled. Contact an administrator.');
    return user;
  }
  async user(id) { return userRow(await this.first('SELECT * FROM users WHERE id=?', [id])); }
  async model(id, includeDeleted = false) {
    const sql = `SELECT * FROM models WHERE id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`;
    let row = await this.first(sql, [id]);
    if (legacyPublication(row)) {
      await this.initializePublication(id);
      row = await this.first(sql, [id]);
    }
    return parse(row);
  }
  async initializePublication(id) {
    // Sites migrations stay schema-only. This bounded, idempotent transaction
    // preserves one existing live copy without changing draft/revision/policy.
    // Legacy result attribution is fixed before a subsequent promotion can
    // replace publication 1, and touches at most the retained 20 run records.
    const snapshot = this.statement('UPDATE models SET published_model_json=model_json,published_version=1,published_at=updated_at WHERE id=? AND published=1 AND published_model_json IS NULL AND published_version=0', [id]);
    const matching = "EXISTS(SELECT 1 FROM models WHERE models.id=model_runs.model_id AND published_version=1 AND published_model_json=json_extract(model_runs.run_json,'$.modelSnapshot'))";
    const runs = this.statement(`UPDATE model_runs SET run_json=json_set(run_json,'$.target',CASE WHEN ${matching} THEN 'published' ELSE 'draft' END,'$.publishedVersion',CASE WHEN ${matching} THEN 1 ELSE NULL END) WHERE model_id=? AND json_type(run_json,'$.target') IS NULL AND id IN(SELECT id FROM model_runs WHERE model_id=? ORDER BY started_at DESC,id DESC LIMIT 20)`, [id, id]);
    await this.db.batch([snapshot, runs]);
  }
  async grant(modelId, userId) { return (await this.first('SELECT level FROM model_grants WHERE model_id=? AND user_id=?', [modelId, userId]))?.level || 'none'; }
  async permission(user, model) { return permissions(await this.user(user.id), model, await this.grant(model.id, user.id)); }
  async accessibleModel(user, id, action = 'canView') {
    const model = await this.model(id);
    if (!model) throw new ApiError(404, 'That model does not exist.');
    const permission = await this.permission(user, model);
    requirePermission(permission, action);
    return { model, permission };
  }
  async runs(modelId, model = null) {
    model ??= await this.model(modelId);
    return (await this.all('SELECT run_json FROM (SELECT run_json,started_at,id FROM model_runs WHERE model_id=? ORDER BY started_at DESC,id DESC LIMIT 20) ORDER BY started_at,id', [modelId])).map(row => legacyRun(JSON.parse(row.run_json), model));
  }
  entry(model) {
    return { id: model.id, model: model.model, updatedAt: model.updatedAt,
      publishedModel: model.publishedModel, publishedVersion: model.publishedVersion,
      publishedAt: model.publishedAt, hasUnpublishedChanges: model.hasUnpublishedChanges };
  }
  async workspace(user) {
    user = await this.user(user.id);
    if (!user?.active) throw new ApiError(403, 'Your account is disabled.');
    const access = accessClause('view', user.id);
    const visible = (await this.all(`SELECT models.* FROM models WHERE deleted_at IS NULL AND ${access.sql} ORDER BY created_at,id`, access.values)).map(parse);
    const catalog = { version: 1, activeId: visible[0]?.id ?? null, models: [], schedules: {}, sources: {}, runs: {} }, policy = {};
    for (const model of visible) {
      catalog.models.push(this.entry(model)); catalog.schedules[model.id] = model.schedule; catalog.sources[model.id] = model.sources;
      catalog.runs[model.id] = await this.runs(model.id, model); policy[model.id] = await this.permission(user, model);
    }
    return { user, catalog, permissions: policy, serverTime: this.stamp() };
  }
  async admin(user) {
    requireAdmin(await this.user(user.id));
    const models = (await this.all('SELECT * FROM models ORDER BY created_at,id')).map(parse).map(({ model, publishedModel, schedule, sources, ...summary }) => ({ ...summary, streams: model.streams.length, scheduleEnabled: schedule.enabled }));
    return { users: (await this.all('SELECT * FROM users ORDER BY created_at,id')).map(userRow), models, grants: (await this.all('SELECT model_id,user_id,level FROM model_grants')).map(row => ({ modelId: row.model_id, userId: row.user_id, level: row.level })) };
  }
  async createModel(user, model, schedule) {
    const id = this.uuid(), stamp = this.stamp(), guard = adminClause(user.id);
    const result = await this.statement(`INSERT INTO models (id,name,model_json,revision,published,edit_locked,unpublish_locked,schedule_json,sources_json,created_by,created_at,updated_at) SELECT ?,?,?,1,0,0,0,?,'[]',?,?,? WHERE ${guard.sql} OR EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='editor')`, [id, model.name, JSON.stringify(model), JSON.stringify(schedule), user.id, stamp, stamp, ...guard.values, user.id]).run();
    if (!changed(result)) throw new ApiError(403, 'An editor or administrator account is required to create a model.');
    if (user.role !== 'admin') {
      // Grant only the model's current creator; no client-supplied owner/role.
      await this.statement("INSERT INTO model_grants (model_id,user_id,level) SELECT id,?,'editor' FROM models WHERE id=? AND created_by=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='editor')", [user.id, id, user.id, user.id]).run();
    }
    const saved = await this.model(id);
    return { entry: this.entry(saved), permission: await this.permission(user, saved), schedule: saved.schedule, sources: [], runs: [] };
  }
  async rejectWrite(user, id, revision, action, { includeDeleted = false } = {}) {
    const model = await this.model(id, includeDeleted);
    if (!model) throw new ApiError(404, 'That model does not exist.');
    if (action === 'admin') requireAdmin(await this.user(user.id));
    else requirePermission(await this.permission(user, model), action);
    if (model.revision !== revision) throw new ApiError(409, 'This model changed. Refresh the workspace before saving.');
    throw new ApiError(409, 'The model state changed. Refresh the workspace and try again.');
  }
  async updateModel(user, id, model, revision) {
    await this.model(id);
    const guard = accessClause('edit', user.id);
    const result = await this.statement(`UPDATE models SET name=?,model_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND edit_locked=0 AND ${guard.sql}`, [model.name, JSON.stringify(model), this.stamp(), id, revision, ...guard.values]).run();
    if (!changed(result)) await this.rejectWrite(user, id, revision, 'canEdit');
    const saved = await this.model(id);
    return { entry: this.entry(saved), permission: await this.permission(user, saved) };
  }
  async updateSchedule(user, id, schedule, revision) {
    await this.model(id);
    const guard = accessClause('edit', user.id);
    const result = await this.statement(`UPDATE models SET schedule_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND published=1 AND ${guard.sql}`, [JSON.stringify(schedule), this.stamp(), id, revision, ...guard.values]).run();
    if (!changed(result)) await this.rejectWrite(user, id, revision, 'canSchedule');
    const saved = await this.model(id);
    return { schedule: saved.schedule, permission: await this.permission(user, saved) };
  }
  async updatePublication(user, id, published, revision, disabledSchedule) {
    const { model } = await this.accessibleModel(user, id);
    const guard = accessClause('edit', user.id);
    // Promotion copies the draft inside the guarded SQL update, so a concurrent
    // edit can never produce a snapshot labelled as a different publication.
    const promotion = published ? ',published_model_json=model_json,published_version=published_version+1,published_at=?' : '';
    const stamp = this.stamp();
    const result = await this.statement(`UPDATE models SET published=?,schedule_json=?,revision=revision+1,updated_at=?${promotion} WHERE id=? AND revision=? AND deleted_at IS NULL AND ${published ? "edit_locked=0 AND (published=0 OR model_json<>published_model_json OR published_model_json IS NULL)" : 'published=1 AND unpublish_locked=0'} AND ${guard.sql}`, [Number(published), JSON.stringify(published ? model.schedule : disabledSchedule), stamp, ...(published ? [stamp] : []), id, revision, ...guard.values]).run();
    if (!changed(result)) {
      const fresh = await this.model(id);
      const permission = fresh ? await this.permission(user, fresh) : null;
      if (fresh?.published && !published && fresh.unpublishLocked && permission?.canView) throw new ApiError(403, 'An administrator must unlock unpublishing before this model can be unpublished.');
      await this.rejectWrite(user, id, revision, published ? 'canPublish' : 'canUnpublish');
    }
    const saved = await this.model(id);
    return { entry: this.entry(saved), permission: await this.permission(user, saved), schedule: saved.schedule };
  }
  async claimSchedule(user, model, schedule) {
    await this.model(model.id);
    const guard = accessClause('run', user.id);
    const result = await this.statement(`UPDATE models SET schedule_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND published=1 AND schedule_json=? AND ${guard.sql}`, [JSON.stringify(schedule), this.stamp(), model.id, model.revision, JSON.stringify(model.schedule), ...guard.values]).run();
    if (!changed(result)) await this.rejectWrite(user, model.id, model.revision, 'canRun');
    // Keep the snapshot from the successful claim. A promotion after this SQL
    // update must not substitute a newer snapshot into the already claimed run.
    return { ...model, schedule, revision: model.revision + 1 };
  }
  async appendRun(user, modelId, run) {
    const guard = accessClause('run', user.id);
    const insert = this.statement(`INSERT INTO model_runs (id,model_id,run_json,started_at,created_by) SELECT ?,id,?,?,? FROM models WHERE id=? AND deleted_at IS NULL AND ${guard.sql}`, [run.id, JSON.stringify(run), run.startedAt, user.id, modelId, ...guard.values]);
    const prune = this.statement('DELETE FROM model_runs WHERE model_id=? AND id NOT IN (SELECT id FROM model_runs WHERE model_id=? ORDER BY started_at DESC,id DESC LIMIT 20)', [modelId, modelId]);
    const results = await this.db.batch([insert, prune]);
    if (!changed(results[0])) throw new ApiError(403, 'Model access changed before this run could be saved.');
  }
  async updateUser(actor, id, changes) {
    const current = await this.user(id);
    if (!current) throw new ApiError(404, 'That user does not exist. Users appear after signing in.');
    const role = changes.role ?? current.role, active = changes.active ?? current.active, guard = adminClause(actor.id);
    const result = await this.statement(`UPDATE users SET role=?,active=?,updated_at=? WHERE id=? AND ${guard.sql} AND (NOT(role='admin' AND active=1 AND (?<>'admin' OR ?=0)) OR EXISTS(SELECT 1 FROM users other WHERE other.id<>users.id AND other.role='admin' AND other.active=1))`, [role, Number(active), this.stamp(), id, ...guard.values, role, Number(active)]).run();
    if (!changed(result)) {
      requireAdmin(await this.user(actor.id));
      throw new ApiError(409, 'Keep at least one active administrator.');
    }
    return { user: await this.user(id) };
  }
  async setGrant(actor, modelId, userId, level) {
    requireAdmin(await this.user(actor.id));
    if (!await this.model(modelId)) throw new ApiError(404, 'That model does not exist.');
    if (!await this.user(userId)) throw new ApiError(404, 'That user does not exist.');
    const guard = adminClause(actor.id);
    const statement = level === 'none'
      ? this.statement(`DELETE FROM model_grants WHERE model_id=? AND user_id=? AND ${guard.sql}`, [modelId, userId, ...guard.values])
      : this.statement(`INSERT INTO model_grants (model_id,user_id,level) SELECT id,?,? FROM models WHERE id=? AND deleted_at IS NULL AND ${guard.sql} ON CONFLICT(model_id,user_id) DO UPDATE SET level=excluded.level`, [userId, level, modelId, ...guard.values]);
    await statement.run();
    requireAdmin(await this.user(actor.id));
    return { modelId, userId, level };
  }
  async updatePolicy(actor, id, changes, revision, disabledSchedule) {
    const { model } = await this.accessibleModel(actor, id);
    requireAdmin(await this.user(actor.id));
    const published = changes.published ?? model.published, editLocked = changes.editLocked ?? model.editLocked, unpublishLocked = changes.unpublishLocked ?? model.unpublishLocked;
    // The admin settings form sends its publication checkbox with lock changes.
    // Only a transition to active publishes here; republishing is an explicit
    // /publication action, so saving a lock never silently promotes a draft.
    const promote = changes.published === true && !model.published;
    const guard = adminClause(actor.id);
    // Unlock and unpublish are separate requests. This makes a persisted lock
    // an actual prerequisite, including when the administrator performs it.
    const stamp = this.stamp(), promotion = promote ? ',published_model_json=model_json,published_version=published_version+1,published_at=?' : '';
    const result = await this.statement(`UPDATE models SET published=?,edit_locked=?,unpublish_locked=?,schedule_json=?,revision=revision+1,updated_at=?${promotion} WHERE id=? AND revision=? AND deleted_at IS NULL AND NOT(published=1 AND ?=0 AND unpublish_locked=1) ${promote ? 'AND edit_locked=0' : ''} AND ${guard.sql}`, [Number(published), Number(editLocked), Number(unpublishLocked), JSON.stringify(published ? model.schedule : disabledSchedule), stamp, ...(promote ? [stamp] : []), id, revision, Number(published), ...guard.values]).run();
    if (!changed(result)) {
      const fresh = await this.model(id);
      requireAdmin(await this.user(actor.id));
      if (fresh?.published && !published && fresh.unpublishLocked) throw new ApiError(403, 'Unlock unpublishing before unpublishing this model.');
      if (promote && fresh?.editLocked) throw new ApiError(403, 'Unlock editing before publishing this model.');
      await this.rejectWrite(actor, id, revision, 'admin');
    }
    const saved = await this.model(id);
    return { entry: this.entry(saved), permission: await this.permission(actor, saved), schedule: saved.schedule };
  }
  async deleteModel(actor, id, revision, disabledSchedule) {
    await this.model(id);
    const guard = adminClause(actor.id);
    const result = await this.statement(`UPDATE models SET deleted_at=?,schedule_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND ${guard.sql}`, [this.stamp(), JSON.stringify(disabledSchedule), this.stamp(), id, revision, ...guard.values]).run();
    if (!changed(result)) await this.rejectWrite(actor, id, revision, 'admin');
    return { id, deleted: true };
  }
  async restoreModel(actor, id, revision) {
    await this.model(id, true);
    const guard = adminClause(actor.id);
    const result = await this.statement(`UPDATE models SET deleted_at=NULL,published=0,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NOT NULL AND ${guard.sql}`, [this.stamp(), id, revision, ...guard.values]).run();
    if (!changed(result)) await this.rejectWrite(actor, id, revision, 'admin', { includeDeleted: true });
    const saved = await this.model(id);
    return { entry: this.entry(saved), permission: await this.permission(actor, saved), schedule: saved.schedule };
  }
}
