import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
