// Staff management, roles & per-staff permissions ("สิ่งที่พนักงานนี้ทำได้")
import { Router } from 'express';
import { z } from 'zod';
import { one, all, run, insert, update, tx } from '../db/index.js';
import { parse, notFound, bad, conflict, forbidden } from '../lib/errors.js';
import { hashSecret } from '../lib/security.js';
import { requireStaff, requirePerm, hasPerm, loadStaffPermissions } from '../middleware/auth.js';
import { PERMISSION_GROUPS, APPROVAL_ACTIONS } from '../../shared/permissions.js';
import { audit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';

const r = Router();
r.use(requireStaff);

r.get('/permissions/catalog', (_req, res) => res.json({ groups: PERMISSION_GROUPS, approvalActions: APPROVAL_ACTIONS }));

export function suggestEmployeeCode(prefix, digits) {
  const p = prefix ?? 'EMP';
  const d = Number(digits) || 3;
  const rows = all('SELECT employee_code FROM staff WHERE employee_code LIKE ?', `${p}%`);
  let max = 0;
  for (const r_ of rows) {
    const n = Number(r_.employee_code.slice(p.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${p}${String(max + 1).padStart(d, '0')}`;
}

r.get('/staff/next-code', requirePerm('staff.create'), (req, res) => {
  const pos = getSetting('pos');
  res.json({ code: suggestEmployeeCode(req.query.prefix ?? pos.employeeCodePrefix, req.query.digits ?? pos.employeeCodeDigits) });
});
r.get('/staff/check-code', requirePerm('staff.create', 'staff.edit'), (req, res) => {
  const ex = one('SELECT id FROM staff WHERE employee_code = ? AND deleted_at IS NULL AND id <> ?', String(req.query.code || ''), Number(req.query.excludeId) || 0);
  res.json({ available: !ex });
});

r.get('/staff', requirePerm('staff.create', 'staff.edit', 'staff.permission', 'report.other_staff'), (req, res) => {
  const branchFilter = hasPerm(req, 'report.all_branches') || req.staff.allBranches ? '' : 'AND (s.branch_id = ? OR s.all_branches = 1)';
  res.json(all(`SELECT s.id, s.employee_code, s.first_name, s.last_name, s.nickname, s.photo_url, s.role_id, ro.name AS role_name, ro.code AS role_code,
                       s.branch_id, b.name AS branch_name, s.all_branches, s.phone, s.email, s.start_date, s.status, s.max_discount_pct, s.note, u.last_login_at
                FROM staff s JOIN roles ro ON ro.id = s.role_id LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN users u ON u.staff_id = s.id
                WHERE s.deleted_at IS NULL ${branchFilter} ORDER BY s.status, s.employee_code`, ...(branchFilter ? [req.staff.branchId] : [])));
});

r.get('/staff/:id', requirePerm('staff.edit', 'staff.permission'), (req, res) => {
  const s = one('SELECT s.*, ro.name AS role_name FROM staff s JOIN roles ro ON ro.id = s.role_id WHERE s.id = ? AND s.deleted_at IS NULL', req.params.id);
  if (!s) throw notFound();
  res.json({
    ...s,
    rolePermissions: all('SELECT permission FROM role_permissions WHERE role_id = ?', s.role_id).map((x) => x.permission),
    overrides: all('SELECT permission, allowed FROM staff_permissions WHERE staff_id = ?', s.id),
    effective: [...loadStaffPermissions(s.id, s.role_id)],
  });
});

const staffSchema = z.object({
  employeeCode: z.string().min(2).max(30).regex(/^[A-Za-z0-9-]+$/, 'ใช้ได้เฉพาะ A-Z 0-9 และ -'), firstName: z.string().min(1).max(80),
  lastName: z.string().max(80).optional().nullable(), nickname: z.string().max(40).optional().nullable(), photoUrl: z.string().max(1000).optional().nullable(),
  roleId: z.number().int(), branchId: z.number().int().nullable().optional(), allBranches: z.boolean().optional(),
  phone: z.string().max(30).optional().nullable(), email: z.string().max(120).optional().nullable(), startDate: z.string().max(10).optional().nullable(),
  status: z.enum(['active', 'inactive']).optional(), maxDiscountPct: z.number().min(0).max(100).optional(), note: z.string().max(500).optional().nullable(),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN ต้องเป็นตัวเลข 4–6 หลัก').optional(),
  overrides: z.array(z.object({ permission: z.string(), allowed: z.boolean() })).optional(),
});

function assertCanAssignRole(req, roleId) {
  const role = one('SELECT * FROM roles WHERE id = ?', roleId);
  if (!role) throw bad('ไม่พบ Role');
  if (role.level >= req.staff.roleLevel && req.staff.roleCode !== 'owner') throw forbidden('ไม่สามารถกำหนด Role ที่สูงกว่าหรือเท่ากับตนเอง');
  return role;
}

r.post('/staff', requirePerm('staff.create'), (req, res) => {
  const b = parse(staffSchema, req.body);
  if (!b.pin) throw bad('กรุณากำหนด PIN');
  assertCanAssignRole(req, b.roleId);
  const id = tx(() => {
    if (one('SELECT id FROM staff WHERE employee_code = ? AND deleted_at IS NULL', b.employeeCode)) throw conflict(`รหัสพนักงาน ${b.employeeCode} ถูกใช้แล้ว`, 'DUPLICATE_CODE');
    const id = insert('staff', {
      employee_code: b.employeeCode, first_name: b.firstName, last_name: b.lastName ?? null, nickname: b.nickname ?? null, photo_url: b.photoUrl ?? null,
      role_id: b.roleId, branch_id: b.branchId ?? req.staff.branchId, all_branches: b.allBranches ? 1 : 0, phone: b.phone ?? null, email: b.email ?? null,
      start_date: b.startDate ?? null, status: b.status || 'active', max_discount_pct: b.maxDiscountPct ?? 0, note: b.note ?? null,
    });
    insert('users', { staff_id: id, pin_hash: hashSecret(b.pin), pin_changed_at: new Date().toISOString() });
    if (b.overrides && hasPerm(req, 'staff.permission')) for (const o of b.overrides) insert('staff_permissions', { staff_id: id, permission: o.permission, allowed: o.allowed ? 1 : 0 });
    return id;
  });
  audit(req, 'staff.create', { entity: 'staff', entityId: id, details: `${b.employeeCode} ${b.firstName}` });
  res.json({ id });
});

r.put('/staff/:id', requirePerm('staff.edit', 'staff.permission'), (req, res) => {
  const b = parse(staffSchema, req.body);
  const id = Number(req.params.id);
  const cur = one('SELECT s.*, ro.level FROM staff s JOIN roles ro ON ro.id = s.role_id WHERE s.id = ? AND s.deleted_at IS NULL', id);
  if (!cur) throw notFound();
  if (cur.level >= req.staff.roleLevel && req.staff.roleCode !== 'owner' && cur.id !== req.staff.id) throw forbidden('ไม่สามารถแก้ไขพนักงานระดับเดียวกันหรือสูงกว่า');
  const changes = [];
  tx(() => {
    if (one('SELECT id FROM staff WHERE employee_code = ? AND deleted_at IS NULL AND id <> ?', b.employeeCode, id)) throw conflict(`รหัสพนักงาน ${b.employeeCode} ถูกใช้แล้ว`, 'DUPLICATE_CODE');
    if (hasPerm(req, 'staff.edit')) {
      if (b.roleId !== cur.role_id) { assertCanAssignRole(req, b.roleId); changes.push(`role ${cur.role_id}→${b.roleId}`); }
      if ((b.branchId ?? cur.branch_id) !== cur.branch_id) changes.push(`branch ${cur.branch_id}→${b.branchId}`);
      if (b.status && b.status !== cur.status) {
        if (!hasPerm(req, 'staff.disable')) throw forbidden('ไม่มีสิทธิ์ปิดใช้งานพนักงาน');
        changes.push(`status ${b.status}`);
        if (b.status === 'inactive') run("UPDATE sessions SET revoked_at = datetime('now') WHERE staff_id = ? AND revoked_at IS NULL", id);
      }
      update('staff', id, {
        employee_code: b.employeeCode, first_name: b.firstName, last_name: b.lastName ?? null, nickname: b.nickname ?? null, photo_url: b.photoUrl ?? null,
        role_id: b.roleId, branch_id: b.branchId ?? cur.branch_id, all_branches: b.allBranches ? 1 : 0, phone: b.phone ?? null, email: b.email ?? null,
        start_date: b.startDate ?? null, status: b.status || cur.status, max_discount_pct: b.maxDiscountPct ?? cur.max_discount_pct, note: b.note ?? null,
        updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
    }
    if (b.overrides && hasPerm(req, 'staff.permission')) {
      run('DELETE FROM staff_permissions WHERE staff_id = ?', id);
      for (const o of b.overrides) insert('staff_permissions', { staff_id: id, permission: o.permission, allowed: o.allowed ? 1 : 0 });
      changes.push(`permissions (${b.overrides.length} overrides)`);
    }
    if (b.pin) {
      if (!hasPerm(req, 'staff.reset_pin')) throw forbidden('ไม่มีสิทธิ์ Reset PIN');
      run("UPDATE users SET pin_hash = ?, pin_changed_at = datetime('now'), failed_attempts = 0, locked_until = NULL WHERE staff_id = ?", hashSecret(b.pin), id);
      changes.push('PIN reset');
    }
  });
  audit(req, 'staff.update', { entity: 'staff', entityId: id, details: changes.join(', ') || 'profile' });
  res.json({ ok: true });
});

r.post('/staff/:id/reset-pin', requirePerm('staff.reset_pin'), (req, res) => {
  const b = parse(z.object({ pin: z.string().regex(/^\d{4,6}$/) }), req.body);
  run("UPDATE users SET pin_hash = ?, pin_changed_at = datetime('now'), failed_attempts = 0, locked_until = NULL WHERE staff_id = ?", hashSecret(b.pin), req.params.id);
  audit(req, 'staff.reset_pin', { entity: 'staff', entityId: req.params.id });
  res.json({ ok: true });
});

// Soft delete
r.delete('/staff/:id', requirePerm('staff.disable'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.staff.id) throw bad('ไม่สามารถลบบัญชีตัวเอง');
  const cur = one('SELECT s.*, ro.code FROM staff s JOIN roles ro ON ro.id = s.role_id WHERE s.id = ?', id);
  if (!cur) throw notFound();
  if (cur.code === 'owner' && one("SELECT COUNT(*) c FROM staff s JOIN roles ro ON ro.id = s.role_id WHERE ro.code = 'owner' AND s.deleted_at IS NULL").c <= 1) throw bad('ต้องมี Owner อย่างน้อย 1 คน');
  run("UPDATE staff SET deleted_at = datetime('now'), status = 'inactive' WHERE id = ?", id);
  run("UPDATE sessions SET revoked_at = datetime('now') WHERE staff_id = ? AND revoked_at IS NULL", id);
  audit(req, 'staff.delete', { entity: 'staff', entityId: id, details: cur.employee_code });
  res.json({ ok: true });
});

// ── Roles ─────────────────────────────────────────────────────────────────
r.get('/roles', (_req, res) => {
  const perms = all('SELECT * FROM role_permissions');
  res.json(all('SELECT r.*, (SELECT COUNT(*) FROM staff s WHERE s.role_id = r.id AND s.deleted_at IS NULL) AS staff_count FROM roles r ORDER BY level DESC, id').map((r_) => ({ ...r_, permissions: perms.filter((p) => p.role_id === r_.id).map((p) => p.permission) })));
});
const roleSchema = z.object({ name: z.string().min(1).max(40), code: z.string().min(1).max(30).regex(/^[a-z0-9_]+$/), level: z.number().int().min(1).max(99), permissions: z.array(z.string()) });
r.post('/roles', requirePerm('staff.role'), (req, res) => {
  const b = parse(roleSchema, req.body);
  if (b.level >= req.staff.roleLevel && req.staff.roleCode !== 'owner') throw forbidden();
  if (one('SELECT id FROM roles WHERE code = ?', b.code)) throw conflict('รหัส Role ซ้ำ');
  const id = tx(() => { const id = insert('roles', { code: b.code, name: b.name, level: b.level }); for (const p of b.permissions.filter((x) => x !== '*')) run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', id, p); return id; });
  audit(req, 'role.create', { entity: 'role', entityId: id, details: b.name });
  res.json({ id });
});
r.put('/roles/:id', requirePerm('staff.role'), (req, res) => {
  const b = parse(roleSchema, req.body);
  const role = one('SELECT * FROM roles WHERE id = ?', req.params.id);
  if (!role) throw notFound();
  if (role.code === 'owner') throw forbidden('ไม่สามารถแก้ไข Role Owner');
  tx(() => {
    update('roles', role.id, { name: b.name, level: role.is_system ? role.level : b.level });
    run('DELETE FROM role_permissions WHERE role_id = ?', role.id);
    for (const p of b.permissions.filter((x) => x !== '*')) run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', role.id, p);
  });
  audit(req, 'role.update', { entity: 'role', entityId: role.id, details: `${b.permissions.length} permissions` });
  res.json({ ok: true });
});
r.delete('/roles/:id', requirePerm('staff.role'), (req, res) => {
  const role = one('SELECT * FROM roles WHERE id = ?', req.params.id);
  if (!role || role.is_system) throw bad('ไม่สามารถลบ Role เริ่มต้นของระบบ');
  if (one('SELECT COUNT(*) c FROM staff WHERE role_id = ? AND deleted_at IS NULL', role.id).c) throw conflict('ยังมีพนักงานใช้ Role นี้');
  run('DELETE FROM roles WHERE id = ?', role.id);
  audit(req, 'role.delete', { entity: 'role', entityId: role.id });
  res.json({ ok: true });
});

export default r;
