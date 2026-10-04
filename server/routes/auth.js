import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, all, run, insert } from '../db/index.js';
import { parse, HttpError, bad, forbidden } from '../lib/errors.js';
import { hashSecret, verifySecret, randomToken, sha256, isValidPin } from '../lib/security.js';
import { requireStaff, requireDevice, createSession, staffContext, issueApproval, requirePerm, hasPerm } from '../middleware/auth.js';
import { isSetupDone, runSetup } from '../services/bootstrap.js';
import { audit } from '../services/audit.js';
import { publicSettings, getSetting } from '../services/settings.js';
import { isOnline } from '../realtime.js';

const r = Router();
const loginLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่', code: 'RATE_LIMIT' } });

// ── First-run setup ───────────────────────────────────────────────────────
r.get('/setup/status', (_req, res) => res.json({ setupDone: isSetupDone(), shopName: isSetupDone() ? getSetting('shop').name : null }));

r.post('/setup', loginLimiter, (req, res) => {
  if (isSetupDone()) throw forbidden('ระบบถูกตั้งค่าแล้ว');
  const body = parse(z.object({
    shopName: z.string().min(1).max(120), branchName: z.string().min(1).max(120), branchCode: z.string().min(1).max(20).regex(/^[A-Za-z0-9-]+$/),
    ownerFirstName: z.string().min(1).max(80), ownerLastName: z.string().max(80).optional(), employeeCode: z.string().min(2).max(30).regex(/^[A-Za-z0-9-]+$/),
    pin: z.string().regex(/^\d{4,6}$/), phone: z.string().max(30).optional(), address: z.string().max(300).optional(), taxId: z.string().max(20).optional(),
    vatEnabled: z.boolean().optional(), sampleMenu: z.boolean().optional(),
  }), req.body);
  const out = runSetup(body);
  audit(null, 'setup.complete', { branchId: out.branchId, details: body.shopName });
  res.json({ ok: true, ...out });
});

// ── Device registration (POS / KDS / Customer Display / Queue Display / Bridge) ──
const deviceSchema = z.object({
  employeeCode: z.string().min(1), pin: z.string().regex(/^\d{4,6}$/),
  branchId: z.number().int(), name: z.string().min(1).max(60), code: z.string().min(1).max(20).regex(/^[A-Za-z0-9-]+$/),
  type: z.enum(['pos', 'kds', 'customer_display', 'queue_display', 'bridge', 'member_kiosk']),
  pairedPosId: z.number().int().nullable().optional(), stationId: z.number().int().nullable().optional(),
});

r.post('/devices/register', loginLimiter, (req, res) => {
  const b = parse(deviceSchema, req.body);
  const s = one("SELECT s.*, u.pin_hash FROM staff s JOIN users u ON u.staff_id = s.id WHERE s.employee_code = ? AND s.deleted_at IS NULL AND s.status = 'active'", b.employeeCode);
  if (!s || !verifySecret(b.pin, s.pin_hash)) throw new HttpError(401, 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง', 'LOGIN_FAILED');
  const ctx = staffContext(s);
  if (!(ctx.perms.has('*') || ctx.perms.has('settings.device'))) throw forbidden('ต้องใช้สิทธิ์ "อุปกรณ์ / POS Device" ในการลงทะเบียนเครื่อง');
  if (!one('SELECT id FROM branches WHERE id = ? AND active = 1', b.branchId)) throw bad('ไม่พบสาขา');
  const token = randomToken(32);
  const existing = one('SELECT id FROM pos_devices WHERE branch_id = ? AND code = ?', b.branchId, b.code);
  let id;
  if (existing) {
    run('UPDATE pos_devices SET name = ?, type = ?, token_hash = ?, paired_pos_id = ?, station_id = ?, active = 1 WHERE id = ?', b.name, b.type, sha256(token), b.pairedPosId ?? null, b.stationId ?? null, existing.id);
    id = existing.id;
  } else {
    id = insert('pos_devices', { branch_id: b.branchId, code: b.code, name: b.name, type: b.type, token_hash: sha256(token), paired_pos_id: b.pairedPosId ?? null, station_id: b.stationId ?? null });
  }
  audit({ staff: { id: s.id }, ip: req.ip }, 'device.register', { branchId: b.branchId, entity: 'device', entityId: id, details: `${b.type} ${b.code} ${b.name}` });
  res.json({ token, device: one('SELECT id, branch_id, code, name, type, paired_pos_id, station_id, config FROM pos_devices WHERE id = ?', id) });
});

// lightweight branch/device lists for the registration screen (needs staff credentials → POST)
r.post('/devices/options', loginLimiter, (req, res) => {
  const { employeeCode, pin } = req.body || {};
  const s = one("SELECT s.*, u.pin_hash FROM staff s JOIN users u ON u.staff_id = s.id WHERE s.employee_code = ? AND s.deleted_at IS NULL AND s.status = 'active'", employeeCode || '');
  if (!s || !verifySecret(pin || '', s.pin_hash)) throw new HttpError(401, 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง', 'LOGIN_FAILED');
  res.json({
    branches: all('SELECT id, code, name FROM branches WHERE active = 1 ORDER BY id'),
    posDevices: all("SELECT id, branch_id, code, name FROM pos_devices WHERE type = 'pos' AND active = 1"),
    stations: all('SELECT id, name, branch_id FROM kitchen_stations WHERE active = 1 ORDER BY sort_order'),
  });
});

r.get('/device/me', requireDevice, (req, res) => {
  const d = req.device;
  const branch = one('SELECT * FROM branches WHERE id = ?', d.branch_id);
  res.json({
    device: { id: d.id, code: d.code, name: d.name, type: d.type, branchId: d.branch_id, pairedPosId: d.paired_pos_id, stationId: d.station_id, config: JSON.parse(d.config || '{}') },
    branch: { id: branch.id, code: branch.code, name: branch.name, timezone: branch.timezone, queuePrefix: branch.queue_prefix, receiptPrefix: branch.receipt_prefix },
    settings: publicSettings(d.branch_id),
    pairedPosOnline: d.paired_pos_id ? isOnline(d.paired_pos_id) : null,
  });
});

// staff picker for "เลือกชื่อพนักงาน + PIN" (only on registered devices)
r.get('/auth/staff-list', requireDevice, (req, res) => {
  res.json(all(`SELECT s.id, s.employee_code, s.first_name, s.last_name, s.nickname, s.photo_url, ro.name AS role_name
                FROM staff s JOIN roles ro ON ro.id = s.role_id
                WHERE s.deleted_at IS NULL AND s.status = 'active' AND (s.branch_id = ? OR s.all_branches = 1)
                ORDER BY s.first_name`, req.device.branch_id));
});

// ── Login (Employee Code + PIN, or Staff picker + PIN) ────────────────────
const MAX_FAILS = 5; const LOCK_MIN = 5;
r.post('/auth/login', loginLimiter, (req, res) => {
  const b = parse(z.object({ employeeCode: z.string().max(30).optional(), staffId: z.number().int().optional(), pin: z.string().max(12) }), req.body);
  const ident = b.employeeCode || `id:${b.staffId}`;
  const s = b.staffId
    ? one("SELECT s.*, u.pin_hash, u.failed_attempts, u.locked_until, u.id AS user_id FROM staff s JOIN users u ON u.staff_id = s.id WHERE s.id = ? AND s.deleted_at IS NULL", b.staffId)
    : one("SELECT s.*, u.pin_hash, u.failed_attempts, u.locked_until, u.id AS user_id FROM staff s JOIN users u ON u.staff_id = s.id WHERE s.employee_code = ? AND s.deleted_at IS NULL", b.employeeCode || '');
  const fail = (msg = 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง') => {
    insert('login_attempts', { identifier: ident, ip: req.ip, success: 0 });
    throw new HttpError(401, msg, 'LOGIN_FAILED');
  };
  if (!s) fail();
  if (s.locked_until && new Date(s.locked_until) > new Date()) throw new HttpError(423, `บัญชีถูกล็อกชั่วคราว ลองใหม่หลัง ${new Date(s.locked_until).toLocaleTimeString('th-TH')}`, 'LOCKED');
  if (s.status !== 'active') fail('บัญชีพนักงานถูกปิดใช้งาน');
  if (!isValidPin(b.pin) || !verifySecret(b.pin, s.pin_hash)) {
    const n = s.failed_attempts + 1;
    run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', n % MAX_FAILS === 0 ? 0 : n, n % MAX_FAILS === 0 ? new Date(Date.now() + LOCK_MIN * 60e3).toISOString() : null, s.user_id);
    audit({ ip: req.ip, device: req.device }, 'auth.login_failed', { entity: 'staff', entityId: s.id, branchId: req.device?.branch_id });
    fail(n % MAX_FAILS === 0 ? `PIN ผิด ${MAX_FAILS} ครั้ง บัญชีถูกล็อก ${LOCK_MIN} นาที` : undefined);
  }
  if (req.device && s.branch_id && s.branch_id !== req.device.branch_id && !s.all_branches) throw forbidden('พนักงานนี้ไม่ได้อยู่สาขานี้');
  run("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?", s.user_id);
  insert('login_attempts', { identifier: ident, ip: req.ip, success: 1 });
  const ctx = staffContext(s);
  if (req.device?.type === 'kds' && !(ctx.perms.has('*') || ctx.perms.has('kds.access'))) throw forbidden('ไม่มีสิทธิ์ใช้งาน KDS');
  const session = createSession(s, req);
  audit({ staff: { id: s.id }, device: req.device, ip: req.ip }, 'auth.login', { entity: 'staff', entityId: s.id, branchId: req.device?.branch_id ?? s.branch_id });
  res.json({ ...session, staff: serializeStaff(ctx, req.device?.branch_id ?? s.branch_id) });
});

function serializeStaff(ctx, branchId) {
  return { id: ctx.id, code: ctx.code, name: ctx.name, displayName: ctx.displayName, photoUrl: ctx.photoUrl, role: { id: ctx.roleId, code: ctx.roleCode, name: ctx.roleName, level: ctx.roleLevel }, branchId, allBranches: ctx.allBranches, maxDiscountPct: ctx.maxDiscountPct, permissions: [...ctx.perms] };
}

r.get('/auth/me', requireStaff, (req, res) => {
  const branches = req.staff.allBranches ? all('SELECT id, code, name FROM branches WHERE active = 1 ORDER BY id') : all('SELECT id, code, name FROM branches WHERE id = ?', req.staff.homeBranchId || req.staff.branchId);
  res.json({ staff: serializeStaff(req.staff, req.staff.branchId), branches, settings: publicSettings(req.staff.branchId) });
});

r.post('/auth/logout', requireStaff, (req, res) => {
  run("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?", req.sessionId);
  audit(req, 'auth.logout', { entity: 'staff', entityId: req.staff.id });
  res.json({ ok: true });
});

// Lock screen unlock: verify the current staff's PIN without creating a new session
r.post('/auth/verify-pin', loginLimiter, requireStaff, (req, res) => {
  const u = one('SELECT pin_hash FROM users WHERE staff_id = ?', req.staff.id);
  if (!verifySecret(String(req.body?.pin || ''), u.pin_hash)) {
    audit(req, 'auth.unlock_failed', { entity: 'staff', entityId: req.staff.id });
    throw new HttpError(401, 'PIN ไม่ถูกต้อง', 'PIN_INVALID');
  }
  res.json({ ok: true });
});

r.post('/auth/change-pin', loginLimiter, requireStaff, (req, res) => {
  const b = parse(z.object({ currentPin: z.string(), newPin: z.string().regex(/^\d{4,6}$/) }), req.body);
  const u = one('SELECT pin_hash FROM users WHERE staff_id = ?', req.staff.id);
  if (!verifySecret(b.currentPin, u.pin_hash)) throw new HttpError(401, 'PIN เดิมไม่ถูกต้อง', 'PIN_INVALID');
  run("UPDATE users SET pin_hash = ?, pin_changed_at = datetime('now') WHERE staff_id = ?", hashSecret(b.newPin), req.staff.id);
  audit(req, 'staff.change_pin', { entity: 'staff', entityId: req.staff.id });
  res.json({ ok: true });
});

// ── Manager Approval ──────────────────────────────────────────────────────
r.post('/approvals', loginLimiter, requireStaff, (req, res) => {
  const b = parse(z.object({ action: z.string(), employeeCode: z.string(), pin: z.string(), orderId: z.string().optional().nullable(), reason: z.string().max(300).optional().nullable() }), req.body);
  const out = issueApproval(req, b);
  audit(req, 'approval.granted', { entity: 'approval', entityId: out.approvalId, details: `${b.action}${b.reason ? `: ${b.reason}` : ''}`, approvedBy: out.approver.id });
  res.json(out);
});

r.get('/approvals', requireStaff, requirePerm('audit.view'), (req, res) => {
  res.json(all(`SELECT a.id, a.action, a.order_id, a.reason, a.created_at, a.used_at,
                       COALESCE(rq.nickname, rq.first_name) AS requested_by_name, rq.employee_code AS requested_by_code,
                       COALESCE(ap.nickname, ap.first_name) AS approved_by_name, ap.employee_code AS approved_by_code, o.order_no
                FROM approvals a JOIN staff rq ON rq.id = a.requested_by JOIN staff ap ON ap.id = a.approved_by
                LEFT JOIN orders o ON o.id = a.order_id
                WHERE a.branch_id = ? OR ? ORDER BY a.id DESC LIMIT 300`, req.staff.branchId, hasPerm(req, 'report.all_branches') ? 1 : 0));
});

export default r;
