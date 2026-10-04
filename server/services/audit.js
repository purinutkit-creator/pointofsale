import { insert } from '../db/index.js';

/** Write an activity/audit log entry. Never throws (logging must not break a sale). */
export function audit(req, action, { entity, entityId, details, approvedBy, branchId } = {}) {
  try {
    insert('audit_logs', {
      branch_id: branchId ?? req?.staff?.branchId ?? req?.device?.branch_id ?? null,
      staff_id: req?.staff?.id ?? null,
      device_id: req?.device?.id ?? null,
      action,
      entity: entity ?? null,
      entity_id: entityId != null ? String(entityId) : null,
      details: details ?? null,
      approved_by: approvedBy ?? null,
      ip: req?.ip ?? null,
    });
  } catch (e) {
    console.error('[audit] failed', action, e.message);
  }
}
