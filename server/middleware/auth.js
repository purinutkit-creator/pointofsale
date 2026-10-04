import { one, all, run, insert, sqlNow } from '../db/index.js';
import { sha256, randomToken, verifySecret } from '../lib/security.js';
import { HttpError, forbidden } from '../lib/errors.js';
import { effectivePermissions, APPROVAL_ACTIONS } from '../../shared/permissions.js';
import { getSetting } from '../services/settings.js';

/** Resolve the calling device from X-Device-Token (POS terminal, KDS, displays, bridge). */
export function deviceContext(req, _res, next) {
  const t = req.get('x-device-token');
  if (t) {
    const d = one('SELECT * FROM pos_devices WHERE token_hash = ? AND active = 1', sha256(t));
    if (d) {
      req.device = d;
      if (Math.random() < 0.2) run("UPDATE pos_devices SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?", req.ip, d.id);
    }
  }
  next();
}

export function requireDevice(req, _res, next) {
  if (!req.device) return next(new HttpError(401, 'อุปกรณ์นี้ยังไม่ได้ลงทะเบียน', 'DEVICE_REQUIRED'));
  next();
}

export function loadStaffPermissions(staffId, roleId) {
  const rolePerms = all('SELECT permission FROM role_permissions WHERE role_id = ?', roleId).map((r) => r.permission);
  const overrides = all('SELECT permission, allowed FROM staff_permissions WHERE staff_id = ?', staffId);
  return effectivePermissions(rolePerms, overrides);
}

export function staffContext(staffRow) {
  const role = one('SELECT * FROM roles WHERE id = ?', staffRow.role_id);
  const perms = loadStaffPermissions(staffRow.id, staffRow.role_id);
  return {
    id: staffRow.id,
    code: staffRow.employee_code,
    name: [staffRow.first_name, staffRow.last_name].filter(Boolean).join(' '),
    nickname: staffRow.nickname,
    displayName: staffRow.nickname || staffRow.first_name,
    photoUrl: staffRow.photo_url,
    roleId: role.id, roleCode: role.code, roleName: role.name, roleLevel: role.level,
    homeBranchId: staffRow.branch_id,
    allBranches: !!staffRow.all_branches || perms.has('report.all_branches') || role.code === 'owner',
    maxDiscountPct: role.code === 'owner' ? 100 : Number(staffRow.max_discount_pct) || 0,
    perms,
  };
}

/** Create a session token for a staff member. */
export function createSession(staff, req) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + (Number(process.env.SESSION_HOURS) || 12) * 3600e3);
  insert('sessions', {
    token_hash: sha256(token), staff_id: staff.id, device_id: req.device?.id ?? null,
    branch_id: req.device?.branch_id ?? staff.branch_id ?? null, ip: req.ip, user_agent: (req.get('user-agent') || '').slice(0, 250),
    expires_at: sqlNow(expires),
  });
  return { token, expiresAt: expires.toISOString() };
}

/** Authenticate staff session (Authorization: Bearer). Applies idle auto-logout. */
export function requireStaff(req, _res, next) {
  if (req.staff) return next();
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'LOGIN_REQUIRED'));
  const s = one(`SELECT s.*, st.* , s.id AS session_id, s.branch_id AS session_branch
                 FROM sessions s JOIN staff st ON st.id = s.staff_id
                 WHERE s.token_hash = ? AND s.revoked_at IS NULL`, sha256(token));
  if (!s || s.deleted_at || s.status !== 'active') return next(new HttpError(401, 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 'SESSION_EXPIRED'));
  const now = Date.now();
  if (new Date(s.expires_at.replace(' ', 'T') + 'Z').getTime() < now) return next(new HttpError(401, 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 'SESSION_EXPIRED'));
  const idleMin = Number(getSetting('pos', s.session_branch).autoLogoutMinutes) || 0;
  if (idleMin > 0 && now - new Date(s.last_used_at.replace(' ', 'T') + 'Z').getTime() > idleMin * 60e3) {
    run("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?", s.session_id);
    return next(new HttpError(401, 'ออกจากระบบอัตโนมัติเนื่องจากไม่มีการใช้งาน', 'SESSION_IDLE'));
  }
  run("UPDATE sessions SET last_used_at = datetime('now') WHERE id = ?", s.session_id);
  const staffRow = one('SELECT * FROM staff WHERE id = ?', s.staff_id);
  req.staff = staffContext(staffRow);
  req.sessionId = s.session_id;
  // working branch: device branch → session branch → staff home; owners may switch with X-Branch-Id
  let branchId = req.device?.branch_id ?? s.session_branch ?? staffRow.branch_id;
  const want = Number(req.get('x-branch-id'));
  if (want && want !== branchId && req.staff.allBranches) branchId = want;
  if (!branchId) branchId = one('SELECT id FROM branches WHERE active = 1 ORDER BY id LIMIT 1')?.id;
  req.staff.branchId = branchId;
  next();
}

export const hasPerm = (req, perm) => !!req.staff && (req.staff.perms.has('*') || req.staff.perms.has(perm));

export function requirePerm(...perms) {
  return (req, _res, next) => {
    if (!req.staff) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'LOGIN_REQUIRED'));
    if (perms.some((p) => hasPerm(req, p))) return next();
    next(forbidden(`ไม่มีสิทธิ์: ${perms.join(', ')}`, 'PERMISSION_DENIED', { permissions: perms }));
  };
}

export const APPROVAL_PERM = Object.fromEntries(APPROVAL_ACTIONS.map(([a, , p]) => [a, p]));

/**
 * Manager approval gate.
 * - Staff lacking `perm` → needs an approval token issued by someone who has it.
 * - Action listed in settings.approval.actions → needs approval unless staff is Manager level (≥70).
 * Returns { approvalId, approvedBy } or throws 403 APPROVAL_REQUIRED.
 */
export function gate(req, action, { perm = APPROVAL_PERM[action], orderId = null, force = false } = {}) {
  const allowed = perm ? hasPerm(req, perm) : true;
  const configured = getSetting('approval').actions?.includes(action);
  const needs = force || !allowed || (configured && req.staff.roleLevel < 70);
  if (!needs) return { approvalId: null, approvedBy: null };
  const token = req.get('x-approval-token');
  if (token) {
    const a = one(`SELECT * FROM approvals WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`, sha256(token));
    if (a && a.action === action && a.requested_by === req.staff.id && (!a.order_id || !orderId || a.order_id === orderId)) {
      run("UPDATE approvals SET used_at = datetime('now') WHERE id = ?", a.id);
      return { approvalId: a.id, approvedBy: a.approved_by, reason: a.reason };
    }
  }
  throw forbidden(allowed ? 'ต้องได้รับการอนุมัติจากผู้จัดการ' : 'ไม่มีสิทธิ์ ต้องให้ผู้มีสิทธิ์อนุมัติ', 'APPROVAL_REQUIRED', { action, perm });
}

/** Verify approver credentials and issue a single-use approval token. */
export function issueApproval(req, { action, employeeCode, pin, orderId, reason }) {
  const approver = one('SELECT s.*, u.pin_hash FROM staff s JOIN users u ON u.staff_id = s.id WHERE s.employee_code = ? AND s.deleted_at IS NULL AND s.status = \'active\'', employeeCode);
  if (!approver || !verifySecret(pin, approver.pin_hash)) throw new HttpError(401, 'รหัสพนักงานหรือ PIN ผู้อนุมัติไม่ถูกต้อง', 'APPROVER_INVALID');
  const ctx = staffContext(approver);
  const perm = APPROVAL_PERM[action];
  if (perm && !(ctx.perms.has('*') || ctx.perms.has(perm))) throw forbidden('ผู้อนุมัติไม่มีสิทธิ์ทำรายการนี้');
  if (ctx.roleLevel < 50) throw forbidden('ผู้อนุมัติต้องเป็นระดับ Supervisor ขึ้นไป');
  const token = randomToken(24);
  const id = insert('approvals', {
    token_hash: sha256(token), action, requested_by: req.staff.id, approved_by: approver.id, order_id: orderId || null,
    reason: reason || null, branch_id: req.staff.branchId, device_id: req.device?.id ?? null,
    expires_at: sqlNow(new Date(Date.now() + 5 * 60e3)),
  });
  return { token, approvalId: id, approver: { id: approver.id, name: ctx.displayName, code: approver.employee_code } };
}
