import { ApiError, permissions, requireAdmin, requirePermission } from './policy.js';
import { describeModelChanges, describeReadingChanges } from './audit-diff.js';

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
const different = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
const auditEvent = (category, action, summary, changes = []) => ({ category, action, summary, changes, truncated: false });
const detail = (field, before, after, extra = {}) => ({ field, before, after, ...extra });
const auditRow = row => ({ id: row.id, occurredAt: row.occurred_at, actor: { id: row.actor_id, name: row.actor_name }, model: row.model_id ? { id: row.model_id, name: row.model_name } : null, category: row.category, action: row.action, summary: row.summary, target: row.target_id ? { id: row.target_id, name: row.target_name } : null, changes: JSON.parse(row.changes_json), revisionBefore: row.revision_before, revisionAfter: row.revision_after, truncated: Boolean(row.truncated) });
const settingsRow = row => ({ retentionDays: row.retention_days, revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by_id ? { id: row.updated_by_id, name: row.updated_by_name } : null });
const scheduleDetails = (before,after) => Object.keys(after).filter(key=>different(before?.[key],after[key])).map(key=>detail(key,before?.[key] ?? null,after[key]));
function sourceAuditChanges(before, after) {
  const keys = ['id','name','type','direction','connectionId','table','tagColumn','valueColumn','timestampColumn','aggregation','quality'];
  const result = [], previous = new Map(before.map(item => [item.id, item])), current = new Map(after.map(item => [item.id, item]));
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const old = previous.get(id), next = current.get(id);
    for (const key of keys) if (different(old?.[key] ?? null, next?.[key] ?? null)) result.push(detail(key, old?.[key] ?? null, next?.[key] ?? null, { itemId: id, itemName: next?.name ?? old?.name ?? id }));
  }
  return result;
}

// This marker is created only by the server's local-session resolver. Local
// accounts already exist in D1 and must never enter the SSO upsert/bootstrap.
export const localAccountIdentity = Symbol('local account identity');

// Each write repeats authorization in SQL. A role/grant revoked after a read
// cannot authorize an in-flight mutation; revisions independently guard edits.
export function accessClause(action, userId) {
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
  constructor(db, { now = () => Date.now(), uuid = () => crypto.randomUUID(), standaloneScheduler = false } = {}) {
    if (!db?.prepare || !db?.batch) throw new Error('A D1 database binding is required.');
    this.db = db; this.now = now; this.uuid = uuid; this.standaloneScheduler = standaloneScheduler;
  }
  statement(sql, values = []) { return this.db.prepare(sql).bind(...values); }
  async first(sql, values) { return this.statement(sql, values).first(); }
  async all(sql, values) { return (await this.statement(sql, values).all()).results; }
  stamp() { return new Date(this.now()).toISOString(); }

  // Called directly after the guarded mutation inside one D1 batch. The first
  // insert uses SQLite changes() so a failed optimistic/permission guard cannot
  // create an event. Later records depend on that batch's unique first event.
  auditStatements(actor, model, events, { revisionBefore = null, revisionAfter = null, target = null, readings = [] } = {}) {
    if (!events.length) return [];
    events = events.flatMap(event => event.changes?.length > 100 ? Array.from({length: Math.ceil(event.changes.length/100)},(_,index)=>({...event,summary:`${event.summary} (part ${index+1} of ${Math.ceil(event.changes.length/100)})`,changes:event.changes.slice(index*100,(index+1)*100)})) : [event]);
    const stamp = this.stamp(), firstId = this.uuid(), statements = [];
    let readingEventId = null; const readingEvents = new Map();
    events.forEach((event, index) => {
      const id = index === 0 ? firstId : this.uuid();
      if (event.category === 'measurement') { readingEventId ??= id; for(const change of event.changes ?? []) if(['value','unit','metric','meterType','measured'].includes(change.field)) readingEvents.set(change.itemId,id); }
      statements.push(this.statement(`INSERT INTO audit_events(id,occurred_at,actor_id,actor_name,model_id,model_name,category,action,summary,target_id,target_name,changes_json,revision_before,revision_after,truncated) SELECT ?,?,actor.id,actor.name,?,?,?,?,?,?,?,?,?,?,? FROM users actor WHERE actor.id=? AND ${index === 0 ? 'changes()>0' : 'EXISTS(SELECT 1 FROM audit_events WHERE id=?)'}`, [id, stamp, model?.id ?? null, model?.name ?? null, event.category, event.action, event.summary.slice(0, 500), target?.id ?? null, target?.name ?? null, JSON.stringify(event.changes ?? []), revisionBefore, revisionAfter, Number(Boolean(event.truncated)), actor.id, ...(index === 0 ? [] : [firstId])]));
    });
    if (readings.length && readingEventId) {
      const values = readings.map(item => ({ ...item, eventId: readingEvents.get(item.itemId) ?? readingEventId, meterType: item.meterType ?? 'none', id: this.uuid(), beforeJson: JSON.stringify(item.before), afterJson: JSON.stringify(item.after) }));
      statements.push(this.statement(`INSERT INTO audit_readings(id,event_id,model_id,item_id,item_name,before_json,after_json,unit,previous_unit,metric,previous_metric,meter_type) SELECT json_extract(value,'$.id'),json_extract(value,'$.eventId'),?,json_extract(value,'$.itemId'),json_extract(value,'$.itemName'),json_extract(value,'$.beforeJson'),json_extract(value,'$.afterJson'),json_extract(value,'$.unit'),json_extract(value,'$.previousUnit'),json_extract(value,'$.metric'),json_extract(value,'$.previousMetric'),json_extract(value,'$.meterType') FROM json_each(?) WHERE EXISTS(SELECT 1 FROM audit_events WHERE id=?)`, [model.id, JSON.stringify(values), firstId]));
    }
    return statements;
  }
  async auditedWrite(statement, actor, model, events, options) {
    const results = await this.db.batch([statement, ...this.auditStatements(actor, model, events, options)]);
    return results[0];
  }
  async ensureAuditSettings() {
    await this.statement('INSERT OR IGNORE INTO audit_settings(id,retention_days,revision) VALUES(1,365,1)').run();
  }
  async auditSettings(user) {
    const actor = await this.user(user.id);
    if (!actor?.active) throw new ApiError(403, 'Your account is disabled.');
    await this.ensureAuditSettings();
    return settingsRow(await this.first('SELECT * FROM audit_settings WHERE id=1'));
  }
  async pruneAudit() {
    // A request performs one bounded cleanup. Reads also enforce the exact
    // retention cutoff, so records awaiting physical cleanup remain invisible.
    await this.ensureAuditSettings();
    await this.statement(`DELETE FROM audit_events WHERE id IN(SELECT event.id FROM audit_events event,audit_settings settings WHERE settings.id=1 AND settings.retention_days>0 AND event.occurred_at<strftime('%Y-%m-%dT%H:%M:%fZ',julianday(?)-settings.retention_days) ORDER BY event.occurred_at,event.id LIMIT 500)`, [this.stamp()]).run();
  }
  auditAccess(user, alias = 'event') {
    const access = accessClause('view', user.id), admin = adminClause(user.id);
    return { sql: `(${admin.sql} OR EXISTS(SELECT 1 FROM models WHERE models.id=${alias}.model_id AND models.deleted_at IS NULL AND ${access.sql})) AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1)`, values: [...admin.values, ...access.values, user.id] };
  }
  auditWhere(user, filters, alias = 'event') {
    const access = this.auditAccess(user, alias), clauses = [access.sql, `(SELECT retention_days FROM audit_settings WHERE id=1)=0 OR ${alias}.occurred_at>=strftime('%Y-%m-%dT%H:%M:%fZ',julianday(?)-(SELECT retention_days FROM audit_settings WHERE id=1))`], values = [...access.values, this.stamp()];
    // Parentheses prevent indefinite retention from bypassing access filters.
    clauses[1] = `(${clauses[1]})`;
    for (const [key, column] of [['modelId','model_id'],['actorId','actor_id'],['category','category']]) if (filters[key]) { clauses.push(`${alias}.${column}=?`); values.push(filters[key]); }
    if (filters.from) { clauses.push(`${alias}.occurred_at>=?`); values.push(filters.from); }
    if (filters.to) { clauses.push(`${alias}.occurred_at<?`); values.push(filters.to); }
    if (filters.q) { clauses.push(`(instr(lower(${alias}.summary),lower(?))>0 OR instr(lower(${alias}.model_name),lower(?))>0 OR instr(lower(${alias}.actor_name),lower(?))>0 OR instr(lower(${alias}.changes_json),lower(?))>0)`); values.push(filters.q,filters.q,filters.q,filters.q); }
    return { sql: clauses.map(sql => `(${sql})`).join(' AND '), values };
  }
  async audit(user, filters) {
    await this.auditSettings(user);
    const where = this.auditWhere(user, filters), values = [...where.values];
    let cursor = '';
    if (filters.cursor) { cursor = ' AND (event.occurred_at<? OR (event.occurred_at=? AND event.id<?))'; values.push(filters.cursor.occurredAt, filters.cursor.occurredAt, filters.cursor.id); }
    const rows = await this.all(`SELECT event.* FROM audit_events event WHERE ${where.sql}${cursor} ORDER BY event.occurred_at DESC,event.id DESC LIMIT ?`, [...values, filters.limit + 1]);
    const more = rows.length > filters.limit, events = rows.slice(0, filters.limit).map(auditRow), last = events.at(-1);
    const access = accessClause('view', user.id), admin = adminClause(user.id), actorAccess = this.auditWhere(user, {});
    const models = (await this.all(`SELECT models.id,models.name,models.deleted_at FROM models WHERE ${admin.sql} OR (models.deleted_at IS NULL AND ${access.sql}) ORDER BY models.name,models.id`, [...admin.values, ...access.values])).map(row => ({ id: row.id, name: row.name, deleted: Boolean(row.deleted_at) }));
    const actors = await this.all(`SELECT id,name FROM(SELECT event.actor_id AS id,event.actor_name AS name,ROW_NUMBER() OVER(PARTITION BY event.actor_id ORDER BY event.occurred_at DESC,event.id DESC) AS position FROM audit_events event WHERE ${actorAccess.sql}) WHERE position=1 ORDER BY name,id`, actorAccess.values);
    // Recheck identity after reads as well; a revoked account cannot receive a
    // previously assembled privileged page of events.
    const fresh = await this.user(user.id);
    if (!fresh?.active || fresh.role !== user.role) throw new ApiError(403, 'Your account permissions changed. Refresh the workspace.');
    if (events.length) {
      const accessNow = this.auditWhere(fresh,{});
      const allowed = await this.first(`SELECT COUNT(*) AS count FROM audit_events event WHERE event.id IN(SELECT value FROM json_each(?)) AND ${accessNow.sql}`, [JSON.stringify(events.map(item=>item.id)), ...accessNow.values]);
      if (allowed.count !== events.length) throw new ApiError(403,'Model access changed. Refresh the workspace.');
    }
    if (models.length) {
      const currentAccess = accessClause('view',fresh.id), currentAdmin = adminClause(fresh.id);
      const allowed = await this.first(`SELECT COUNT(*) AS count FROM models WHERE id IN(SELECT value FROM json_each(?)) AND (${currentAdmin.sql} OR (deleted_at IS NULL AND ${currentAccess.sql}))`, [JSON.stringify(models.map(item=>item.id)), ...currentAdmin.values, ...currentAccess.values]);
      if (allowed.count !== models.length) throw new ApiError(403,'Model access changed. Refresh the workspace.');
    }
    return { events, nextCursor: more && last ? btoa(JSON.stringify({ occurredAt: last.occurredAt, id: last.id })) : null, settings: await this.auditSettings(user), models, actors };
  }
  async updateAuditSettings(actor, retentionDays, revision) {
    requireAdmin(await this.user(actor.id)); await this.ensureAuditSettings();
    const before = await this.first('SELECT * FROM audit_settings WHERE id=1'), guard = adminClause(actor.id);
    if (before.revision !== revision) throw new ApiError(409, 'History settings changed. Refresh before saving.');
    if (before.retention_days === retentionDays) return { settings: settingsRow(before) };
    const statement = this.statement(`UPDATE audit_settings SET retention_days=?,revision=revision+1,updated_at=?,updated_by_id=?,updated_by_name=(SELECT name FROM users WHERE id=?) WHERE id=1 AND revision=? AND ${guard.sql}`, [retentionDays, this.stamp(), actor.id, actor.id, revision, ...guard.values]);
    const result = await this.auditedWrite(statement, actor, null, [auditEvent('retention', 'retention_changed', 'Changed audit-history retention.', [detail('retentionDays', before.retention_days, retentionDays)])], { revisionBefore: revision, revisionAfter: revision + 1 });
    if (!changed(result)) { requireAdmin(await this.user(actor.id)); throw new ApiError(409, 'History settings changed. Refresh before saving.'); }
    return { settings: await this.auditSettings(actor) };
  }
  async auditTrends(user, filters) {
    const checkAccess = async () => {
      const actor = await this.user(user.id);
      if (!actor?.active) throw new ApiError(403,'Your account is disabled.');
      const model = await this.model(filters.modelId, actor.role === 'admin');
      if (!model) throw new ApiError(404,'That model does not exist.');
      if (actor.role !== 'admin') requirePermission(await this.permission(actor,model),'canView');
    };
    await checkAccess();
    await this.auditSettings(user);
    const where = this.auditWhere(user, filters);
    const itemRows = await this.all(`SELECT id,name,unit,metric FROM(SELECT reading.item_id AS id,reading.item_name AS name,reading.unit,reading.metric,event.occurred_at,event.revision_after,event.id AS event_id,ROW_NUMBER() OVER(PARTITION BY reading.item_id ORDER BY event.occurred_at DESC,event.revision_after DESC,event.id DESC) AS position FROM audit_readings reading JOIN audit_events event ON event.id=reading.event_id WHERE ${where.sql}) WHERE position=1 ORDER BY occurred_at DESC,revision_after DESC,event_id DESC LIMIT 501`, where.values);
    const items = itemRows.slice(0,500);
    const selected = filters.itemId ?? items[0]?.id ?? null;
    const rows = selected ? await this.all(`SELECT reading.*,event.id AS audit_id,event.occurred_at,event.actor_name FROM audit_readings reading JOIN audit_events event ON event.id=reading.event_id WHERE ${where.sql} AND reading.item_id=? ORDER BY event.occurred_at DESC,event.revision_after DESC,event.id DESC LIMIT 501`, [...where.values, selected]) : [];
    await checkAccess();
    return { items, item: selected ? { id: selected, name: items.find(item => item.id === selected)?.name ?? selected } : null, points: rows.slice(0, 500).reverse().map(row => ({ eventId: row.audit_id, occurredAt: row.occurred_at, actorName: row.actor_name, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), unit: row.unit, previousUnit: row.previous_unit, metric: row.metric, previousMetric: row.previous_metric, meterType: row.meter_type === 'none' ? null : row.meter_type })), truncated: rows.length > 500 || itemRows.length > 500, maxPoints: 500 };
  }

  async authenticate(identity, adminEmail) {
    if (identity?.[localAccountIdentity] === true) {
      const user = await this.user(identity.id);
      if (!user?.active) throw new ApiError(401, 'Sign in to access this workspace.');
      return user;
    }
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
    const statement = this.statement(`INSERT INTO models (id,name,model_json,revision,published,edit_locked,unpublish_locked,schedule_json,sources_json,created_by,created_at,updated_at) SELECT ?,?,?,1,0,0,0,?,'[]',?,?,? WHERE ${guard.sql} OR EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='editor')`, [id, model.name, JSON.stringify(model), JSON.stringify(schedule), user.id, stamp, stamp, ...guard.values, user.id]);
    const summary = { id, name: model.name };
    const ownerGrant = this.statement("INSERT INTO model_grants (model_id,user_id,level) SELECT id,?,'editor' FROM models WHERE id=? AND created_by=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='editor')",[user.id,id,user.id,user.id]);
    const results = await this.db.batch([statement,...this.auditStatements(user,summary,[auditEvent('model','created','Created model.')],{revisionAfter:1}),ownerGrant,...this.auditStatements(user,summary,[auditEvent('permission','access_changed','Assigned creator access to model.',[detail('level','none','editor')])],{target:{id:user.id,name:user.name}})]);
    const result = results[0];
    if (!changed(result)) throw new ApiError(403, 'An editor or administrator account is required to create a model.');
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
    const before = await this.model(id);
    if (before?.revision !== revision) await this.rejectWrite(user,id,revision,'canEdit');
    const guard = accessClause('edit', user.id);
    const statement = this.statement(`UPDATE models SET name=?,model_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND edit_locked=0 AND ${guard.sql}`, [model.name, JSON.stringify(model), this.stamp(), id, revision, ...guard.values]);
    const result = await this.auditedWrite(statement, user, before, before ? describeModelChanges(before.model, model) : [], { revisionBefore: revision, revisionAfter: revision + 1, readings: before ? describeReadingChanges(before.model, model) : [] });
    if (!changed(result)) await this.rejectWrite(user, id, revision, 'canEdit');
    const saved = await this.model(id);
    return { entry: this.entry(saved), permission: await this.permission(user, saved) };
  }
  async updateSchedule(user, id, schedule, revision) {
    const before = await this.model(id);
    if (before?.revision !== revision) await this.rejectWrite(user,id,revision,'canSchedule');
    const guard = accessClause('edit', user.id);
    const statement = this.statement(`UPDATE models SET schedule_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND published=1 AND ${guard.sql}`, [JSON.stringify(schedule), this.stamp(), id, revision, ...guard.values]);
    const changes = Object.keys(schedule).filter(key => different(before?.schedule[key], schedule[key])).map(key => detail(key, before?.schedule[key] ?? null, schedule[key]));
    const events = changes.length ? [auditEvent('schedule','updated','Updated reconciliation schedule.',changes)] : [];
    // Saving a standalone schedule is the explicit authorization for unattended
    // execution. The owner and generation share the guarded configuration write
    // so a stale request cannot transfer ownership or revive old work.
    const ownership = this.standaloneScheduler ? [this.statement(`INSERT INTO schedule_authorizations(model_id,user_id,generation,configured_at) SELECT id,?,1,? FROM models WHERE id=? AND revision=? AND changes()>0 ON CONFLICT(model_id) DO UPDATE SET user_id=excluded.user_id,generation=schedule_authorizations.generation+1,configured_at=excluded.configured_at`, [user.id, this.stamp(), id, revision + 1])] : [];
    const previousAuthorization = this.standaloneScheduler ? await this.first('SELECT user_id FROM schedule_authorizations WHERE model_id=?', [id]) : null;
    if (this.standaloneScheduler) events.push(auditEvent('schedule','authorized','Authorized unattended reconciliation under the scheduling account.',[detail('authorizedUserId',previousAuthorization?.user_id ?? null,user.id)]));
    const results = await this.db.batch([statement, ...ownership, ...this.auditStatements(user, before, events, { revisionBefore: revision, revisionAfter: revision + 1 })]);
    const result = results[0];
    if (!changed(result)) await this.rejectWrite(user, id, revision, 'canSchedule');
    const saved = await this.model(id);
    return { schedule: saved.schedule, permission: await this.permission(user, saved) };
  }
  async updateSources(user, id, sources, schedule, revision, piRegistryRevision) {
    // Admin and editing lock checks are repeated in the atomic write. A source
    // change increments the same revision as diagrams, schedules, and policies.
    const guard = adminClause(user.id);
    const before = await this.model(id);
    if (before?.revision !== revision) { requireAdmin(await this.user(user.id)); await this.rejectWrite(user,id,revision,'canEdit'); }
    // Source definitions are bounded configurations; credentials reside in the
    // gateway environment and are never copied into audit history.
    const sourceChanges = sourceAuditChanges(before?.sources ?? [], sources);
    const events = sourceChanges.length ? [auditEvent('connector','updated','Updated model data sources.',sourceChanges)] : [];
    if (different(before?.schedule, schedule)) events.push(auditEvent('schedule','updated','Adjusted schedule after a data-source change.',Object.keys(schedule).filter(key => different(before?.schedule[key], schedule[key])).map(key => detail(key,before?.schedule[key] ?? null,schedule[key]))));
    const registryGuard = piRegistryRevision === undefined ? '' : ' AND COALESCE((SELECT revision FROM pi_configuration WHERE id=1),0)=?';
    const statement = this.statement(`UPDATE models SET sources_json=?,schedule_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND edit_locked=0 AND ${guard.sql}${registryGuard}`, [JSON.stringify(sources), JSON.stringify(schedule), this.stamp(), id, revision, ...guard.values, ...(piRegistryRevision === undefined ? [] : [piRegistryRevision])]);
    const result = await this.auditedWrite(statement, user, before, events, { revisionBefore: revision, revisionAfter: revision + 1 });
    if (!changed(result)) {
      requireAdmin(await this.user(user.id));
      if (piRegistryRevision !== undefined && Number((await this.first('SELECT revision FROM pi_configuration WHERE id=1'))?.revision ?? 0) !== piRegistryRevision) throw new ApiError(409, 'PI connections changed. Refresh before saving model sources.');
      await this.rejectWrite(user, id, revision, 'canEdit');
    }
    const saved = await this.model(id);
    return { sources: saved.sources, schedule: saved.schedule, entry: this.entry(saved), permission: await this.permission(user, saved) };
  }
  async updatePublication(user, id, published, revision, disabledSchedule) {
    const { model } = await this.accessibleModel(user, id);
    if (model.revision !== revision) await this.rejectWrite(user,id,revision,published?'canPublish':'canUnpublish');
    const guard = accessClause('edit', user.id);
    // Promotion copies the draft inside the guarded SQL update, so a concurrent
    // edit can never produce a snapshot labelled as a different publication.
    const promotion = published ? ',published_model_json=model_json,published_version=published_version+1,published_at=?' : '';
    const stamp = this.stamp();
    const statement = this.statement(`UPDATE models SET published=?,schedule_json=?,revision=revision+1,updated_at=?${promotion} WHERE id=? AND revision=? AND deleted_at IS NULL AND ${published ? "edit_locked=0 AND (published=0 OR model_json<>published_model_json OR published_model_json IS NULL)" : 'published=1 AND unpublish_locked=0'} AND ${guard.sql}`, [Number(published), JSON.stringify(published ? model.schedule : disabledSchedule), stamp, ...(published ? [stamp] : []), id, revision, ...guard.values]);
    const events = [auditEvent('publication',published ? 'published' : 'unpublished',published ? `Published model version ${model.publishedVersion + 1}.` : 'Unpublished model.',[detail('published',model.published,published),...(published ? [detail('publishedVersion',model.publishedVersion,model.publishedVersion + 1)] : [])])];
    if (!published && different(model.schedule,disabledSchedule)) events.push(auditEvent('schedule','updated','Paused schedule when model was unpublished.',scheduleDetails(model.schedule,disabledSchedule)));
    const result = await this.auditedWrite(statement, user, model, events, { revisionBefore: revision, revisionAfter: revision + 1 });
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
    const statement = this.statement(`UPDATE users SET role=?,active=?,updated_at=? WHERE id=? AND role=? AND active=? AND ${guard.sql} AND (NOT(role='admin' AND active=1 AND (?<>'admin' OR ?=0)) OR EXISTS(SELECT 1 FROM users other WHERE other.id<>users.id AND other.role='admin' AND other.active=1))`, [role, Number(active), this.stamp(), id, current.role, Number(current.active), ...guard.values, role, Number(active)]);
    const details = [detail('role',current.role,role),detail('active',current.active,active)].filter(item => different(item.before,item.after));
    const result = await this.auditedWrite(statement, actor, null, details.length ? [auditEvent('permission','access_changed',`Updated account permissions for ${current.name}.`,details)] : [], { target: current });
    if (!changed(result)) {
      requireAdmin(await this.user(actor.id));
      const fresh = await this.user(id);
      if (fresh?.role !== current.role || fresh?.active !== current.active) throw new ApiError(409, 'That user changed. Refresh before saving.');
      throw new ApiError(409, 'Keep at least one active administrator.');
    }
    return { user: await this.user(id) };
  }
  async setGrant(actor, modelId, userId, level) {
    requireAdmin(await this.user(actor.id));
    const model = await this.model(modelId), target = await this.user(userId);
    if (!model) throw new ApiError(404, 'That model does not exist.');
    if (!target) throw new ApiError(404, 'That user does not exist.');
    const before = await this.grant(modelId,userId);
    if (before === level) return { modelId, userId, level };
    const guard = adminClause(actor.id);
    const statement = level === 'none'
      ? this.statement(`DELETE FROM model_grants WHERE model_id=? AND user_id=? AND level=? AND EXISTS(SELECT 1 FROM models WHERE id=? AND deleted_at IS NULL) AND ${guard.sql}`, [modelId, userId, before, modelId, ...guard.values])
      : this.statement(`INSERT INTO model_grants (model_id,user_id,level) SELECT id,?,? FROM models WHERE id=? AND deleted_at IS NULL AND COALESCE((SELECT level FROM model_grants WHERE model_id=? AND user_id=?),'none')=? AND ${guard.sql} ON CONFLICT(model_id,user_id) DO UPDATE SET level=excluded.level`, [userId, level, modelId, modelId, userId, before, ...guard.values]);
    const result = await this.auditedWrite(statement, actor, model, [auditEvent('permission','access_changed',`Changed model access for ${target.name}.`,[detail('level',before,level)])], { target });
    requireAdmin(await this.user(actor.id));
    if (!changed(result)) throw new ApiError(409, 'Model permissions changed. Refresh before saving.');
    return { modelId, userId, level };
  }
  async updatePolicy(actor, id, changes, revision, disabledSchedule) {
    const { model } = await this.accessibleModel(actor, id);
    requireAdmin(await this.user(actor.id));
    if (model.revision !== revision) await this.rejectWrite(actor,id,revision,'admin');
    const published = changes.published ?? model.published, editLocked = changes.editLocked ?? model.editLocked, unpublishLocked = changes.unpublishLocked ?? model.unpublishLocked;
    // The admin settings form sends its publication checkbox with lock changes.
    // Only a transition to active publishes here; republishing is an explicit
    // /publication action, so saving a lock never silently promotes a draft.
    const promote = changes.published === true && !model.published;
    const guard = adminClause(actor.id);
    // Unlock and unpublish are separate requests. This makes a persisted lock
    // an actual prerequisite, including when the administrator performs it.
    const stamp = this.stamp(), promotion = promote ? ',published_model_json=model_json,published_version=published_version+1,published_at=?' : '';
    const statement = this.statement(`UPDATE models SET published=?,edit_locked=?,unpublish_locked=?,schedule_json=?,revision=revision+1,updated_at=?${promotion} WHERE id=? AND revision=? AND deleted_at IS NULL AND NOT(published=1 AND ?=0 AND unpublish_locked=1) ${promote ? 'AND edit_locked=0' : ''} AND ${guard.sql}`, [Number(published), Number(editLocked), Number(unpublishLocked), JSON.stringify(published ? model.schedule : disabledSchedule), stamp, ...(promote ? [stamp] : []), id, revision, Number(published), ...guard.values]);
    const details = [detail('published',model.published,published),detail('editLocked',model.editLocked,editLocked),detail('unpublishLocked',model.unpublishLocked,unpublishLocked),...(promote ? [detail('publishedVersion',model.publishedVersion,model.publishedVersion+1)] : [])].filter(item => different(item.before,item.after));
    const events = details.length ? [auditEvent('publication',promote ? 'published' : model.published && !published ? 'unpublished' : 'policy_changed','Updated model publication or locks.',details)] : [];
    if (!published && different(model.schedule,disabledSchedule)) events.push(auditEvent('schedule','updated','Paused schedule when publication settings changed.',scheduleDetails(model.schedule,disabledSchedule)));
    const result = await this.auditedWrite(statement, actor, model, events, { revisionBefore: revision, revisionAfter: revision + 1 });
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
    const before = await this.model(id);
    if (before?.revision !== revision) await this.rejectWrite(actor,id,revision,'admin');
    const guard = adminClause(actor.id);
    const statement = this.statement(`UPDATE models SET deleted_at=?,schedule_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND ${guard.sql}`, [this.stamp(), JSON.stringify(disabledSchedule), this.stamp(), id, revision, ...guard.values]);
    const events = [auditEvent('model','deleted','Deleted model.',[detail('deleted',false,true)])];
    if (different(before.schedule,disabledSchedule)) events.push(auditEvent('schedule','updated','Paused schedule when model was deleted.',scheduleDetails(before.schedule,disabledSchedule)));
    const result = await this.auditedWrite(statement, actor, before, events, { revisionBefore: revision, revisionAfter: revision + 1 });
    if (!changed(result)) await this.rejectWrite(actor, id, revision, 'admin');
    return { id, deleted: true };
  }
  async restoreModel(actor, id, revision) {
    const before = await this.model(id, true);
    if (before?.revision !== revision) await this.rejectWrite(actor,id,revision,'admin',{includeDeleted:true});
    const guard = adminClause(actor.id);
    const statement = this.statement(`UPDATE models SET deleted_at=NULL,published=0,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NOT NULL AND ${guard.sql}`, [this.stamp(), id, revision, ...guard.values]);
    const result = await this.auditedWrite(statement, actor, before, [auditEvent('model','restored','Restored model as draft.',[detail('deleted',true,false),detail('published',before?.published ?? false,false)])], { revisionBefore: revision, revisionAfter: revision + 1 });
    if (!changed(result)) await this.rejectWrite(actor, id, revision, 'admin', { includeDeleted: true });
    const saved = await this.model(id);
    return { entry: this.entry(saved), permission: await this.permission(actor, saved), schedule: saved.schedule };
  }
}
