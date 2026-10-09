export const USER_ROLES = ['viewer', 'operator', 'editor', 'admin'];
export const MODEL_LEVELS = ['none', 'viewer', 'operator', 'editor'];

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function permissions(user, model, grant = 'none') {
  const enabled = Boolean(user?.active && model && !model.deletedAt);
  const admin = enabled && user.role === 'admin';
  const level = enabled ? admin ? 3 : Math.min(USER_ROLES.indexOf(user.role), MODEL_LEVELS.indexOf(grant) - 1) : -1;
  return {
    revision: model?.revision ?? 0,
    published: Boolean(model?.published), editLocked: Boolean(model?.editLocked), unpublishLocked: Boolean(model?.unpublishLocked),
    canView: level >= 0, canRun: level >= 1,
    canEdit: level >= 2 && !model.editLocked,
    canSchedule: level >= 2 && Boolean(model.published),
    canPublish: level >= 2 && !model.published,
    canUnpublish: level >= 2 && Boolean(model.published) && !model.unpublishLocked,
    canDelete: admin
  };
}

export function requireAdmin(user) {
  if (!user?.active || user.role !== 'admin') throw new ApiError(403, 'Administrator access is required.');
}

export function requirePermission(permission, action) {
  if (!permission?.[action]) throw new ApiError(403, 'Your account does not have permission for this action.');
}

export function validateRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ApiError(400, 'A positive model revision is required.');
  return value;
}

export function fields(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new ApiError(400, 'The request contains missing or unsupported fields.');
  return value;
}

export function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) throw new ApiError(400, 'Choose a safe identifier.');
  return value;
}
