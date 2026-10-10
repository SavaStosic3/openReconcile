import { sqliteTable, text, integer, primaryKey, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), email: text('email').notNull(), name: text('name').notNull(),
  role: text('role', { enum: ['viewer', 'operator', 'editor', 'admin'] }).notNull().default('viewer'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull()
});

export const localCredentials = sqliteTable('local_credentials', {
  username: text('username').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  passwordHash: text('password_hash').notNull(), createdAt: text('created_at').notNull()
}, table => [uniqueIndex('local_credentials_user_idx').on(table.userId)]);

export const localSessions = sqliteTable('local_sessions', {
  tokenHash: text('token_hash').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  userUpdatedAt: text('user_updated_at').notNull(), createdAt: integer('created_at').notNull(), expiresAt: integer('expires_at').notNull()
}, table => [index('local_sessions_user_idx').on(table.userId), index('local_sessions_expiry_idx').on(table.expiresAt)]);

export const localLoginLimits = sqliteTable('local_login_limits', {
  key: text('key').primaryKey(), attempts: integer('attempts').notNull(), windowStart: integer('window_start').notNull()
}, table => [index('local_login_limits_time_idx').on(table.windowStart)]);

export const models = sqliteTable('models', {
  id: text('id').primaryKey(), name: text('name').notNull(), modelJson: text('model_json').notNull(),
  revision: integer('revision').notNull().default(1), published: integer('published', { mode: 'boolean' }).notNull().default(false),
  publishedModelJson: text('published_model_json'), publishedVersion: integer('published_version').notNull().default(0),
  publishedAt: text('published_at'),
  editLocked: integer('edit_locked', { mode: 'boolean' }).notNull().default(false),
  unpublishLocked: integer('unpublish_locked', { mode: 'boolean' }).notNull().default(false),
  scheduleJson: text('schedule_json').notNull(), sourcesJson: text('sources_json').notNull().default('[]'),
  createdBy: text('created_by').notNull().references(() => users.id), createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(), deletedAt: text('deleted_at')
});

export const modelGrants = sqliteTable('model_grants', {
  modelId: text('model_id').notNull().references(() => models.id), userId: text('user_id').notNull().references(() => users.id),
  level: text('level', { enum: ['viewer', 'operator', 'editor'] }).notNull()
}, table => [primaryKey({ columns: [table.modelId, table.userId] }), index('model_grants_user_idx').on(table.userId)]);

export const modelRuns = sqliteTable('model_runs', {
  id: text('id').primaryKey(), modelId: text('model_id').notNull().references(() => models.id),
  runJson: text('run_json').notNull(), startedAt: text('started_at').notNull(), createdBy: text('created_by').notNull().references(() => users.id)
}, table => [index('model_runs_model_time_idx').on(table.modelId, table.startedAt)]);

export const scheduleAuthorizations = sqliteTable('schedule_authorizations', {
  modelId: text('model_id').primaryKey().references(() => models.id),
  userId: text('user_id').notNull().references(() => users.id),
  generation: integer('generation').notNull(), configuredAt: text('configured_at').notNull()
});

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey(), modelId: text('model_id').notNull().references(() => models.id),
  actorId: text('actor_id').notNull().references(() => users.id), trigger: text('trigger', { enum: ['scheduled','manual'] }).notNull().default('scheduled'), generation: integer('generation').notNull(),
  scheduledAt: text('scheduled_at').notNull(), ownerToken: text('owner_token').notNull(), leaseUntil: integer('lease_until').notNull(),
  state: text('state', { enum: ['claimed','running','output','finished','interrupted','cancelled'] }).notNull(),
  snapshotJson: text('snapshot_json').notNull(), runJson: text('run_json').notNull(),
  claimedAt: text('claimed_at').notNull(), finishedAt: text('finished_at')
}, table => [uniqueIndex('scheduled_jobs_occurrence_idx').on(table.modelId, table.generation, table.scheduledAt),
  uniqueIndex('scheduled_jobs_active_model_idx').on(table.modelId).where(sql`${table.state} IN ('claimed','running','output')`),
  check('scheduled_jobs_state_check', sql`${table.state} IN ('claimed','running','output','finished','interrupted','cancelled')`),
  check('scheduled_jobs_trigger_check', sql`${table.trigger} IN ('scheduled','manual')`),
  index('scheduled_jobs_lease_idx').on(table.state, table.leaseUntil), index('scheduled_jobs_model_time_idx').on(table.modelId, table.claimedAt)]);

export const auditSettings = sqliteTable('audit_settings', {
  id: integer('id').primaryKey(), retentionDays: integer('retention_days').notNull().default(365),
  revision: integer('revision').notNull().default(1), updatedAt: text('updated_at'),
  updatedById: text('updated_by_id'), updatedByName: text('updated_by_name')
});

export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(), occurredAt: text('occurred_at').notNull(), actorId: text('actor_id').notNull(), actorName: text('actor_name').notNull(),
  modelId: text('model_id'), modelName: text('model_name'), category: text('category').notNull(), action: text('action').notNull(), summary: text('summary').notNull(),
  targetId: text('target_id'), targetName: text('target_name'), changesJson: text('changes_json').notNull(),
  revisionBefore: integer('revision_before'), revisionAfter: integer('revision_after'), truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false)
}, table => [index('audit_events_time_idx').on(table.occurredAt, table.id), index('audit_events_model_time_idx').on(table.modelId, table.occurredAt, table.id), index('audit_events_actor_time_idx').on(table.actorId, table.occurredAt, table.id)]);

export const auditReadings = sqliteTable('audit_readings', {
  id: text('id').primaryKey(), eventId: text('event_id').notNull().references(() => auditEvents.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(), itemId: text('item_id').notNull(), itemName: text('item_name').notNull(),
  beforeJson: text('before_json').notNull(), afterJson: text('after_json').notNull(), unit: text('unit'), previousUnit: text('previous_unit'),
  metric: text('metric'), previousMetric: text('previous_metric'), meterType: text('meter_type').notNull()
}, table => [index('audit_readings_model_item_idx').on(table.modelId, table.itemId, table.eventId)]);
