// Settings, branches, devices, hardware status, backup/restore, activity log, notifications, media proxy
import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { one, all, run, insert, update, json } from '../db/index.js';
import { parse, notFound, bad, forbidden, conflict } from '../lib/errors.js';
import { requireStaff, requirePerm, hasPerm } from '../middleware/auth.js';
import { DEFAULT_SETTINGS, getSetting, setSetting, getAllSettings, publicSettings, branchOverrides, clearBranchSetting, BRANCH_SCOPED } from '../services/settings.js';
import { audit } from '../services/audit.js';
import { createBackup, listBackups, backupPath, restoreFrom } from '../services/backup.js';
import { fetchImageBuffer } from '../print/render.js';
import { emitBranch, emitAll, isOnline } from '../realtime.js';
import { sendEmail } from '../services/messaging.js';
import { shapePromotion } from '../services/catalog.js';
import { PROMOTION_TYPES } from '../../shared/promotions.js';

const r = Router();

r.use(requireStaff);

// image proxy: lets canvases (receipt logo preview, customer display) use images set by URL
r.get('/media/proxy', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) throw bad('invalid url');
  try {
    const { buf, type } = await fetchImageBuffer(url);
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=86400').send(buf);
  } catch (e) {
    res.status(502).json({ error: `โหลดรูปไม่ได้: ${e.message}` });
  }
});


// ── Settings ──────────────────────────────────────────────────────────────
const SETTING_PERM = {
  shop: 'settings.shop', vat: 'settings.vat', serviceCharge: 'settings.service_charge', receipt: 'settings.receipt', kitchen: 'settings.printer',
  pos: 'settings.shop', payment: 'settings.payment', points: 'settings.point', member: 'settings.member', approval: 'settings.approval',
  display: 'settings.shop', queue: 'settings.shop', notifications: 'settings.member', backup: 'settings.backup',
};
r.get('/settings', (req, res) => {
  const branchId = Number(req.query.branchId) || req.staff.branchId;
  const canSee = Object.values(SETTING_PERM).some((p) => hasPerm(req, p));
  res.json({ settings: canSee && hasPerm(req, 'settings.member') ? getAllSettings(branchId) : publicSettings(branchId), overrides: branchOverrides(branchId), branchScoped: BRANCH_SCOPED, defaults: DEFAULT_SETTINGS });
});
r.put('/settings/:key', (req, res) => {
  const key = req.params.key;
  if (!(key in DEFAULT_SETTINGS)) throw notFound();
  if (!hasPerm(req, SETTING_PERM[key])) throw forbidden(`ไม่มีสิทธิ์แก้ไข ${key}`);
  const branchId = req.body.branchId ? Number(req.body.branchId) : null;
  if (branchId && !BRANCH_SCOPED.includes(key)) throw bad('ค่านี้กำหนดได้เฉพาะระดับทั้งระบบ');
  if (branchId && branchId !== req.staff.branchId && !hasPerm(req, 'settings.branch')) throw forbidden();
  const value = req.body.value;
  if (!value || typeof value !== 'object') throw bad('value required');
  if (key === 'vat' && (value.rate < 0 || value.rate > 30)) throw bad('อัตรา VAT ไม่ถูกต้อง');
  if (key === 'serviceCharge' && (value.rate < 0 || value.rate > 50)) throw bad('อัตรา Service Charge ไม่ถูกต้อง');
  if (key === 'points' && !(Number(value.earnAmount) > 0)) throw bad('ยอดซื้อต่อแต้มต้องมากกว่า 0');
  if (key === 'receipt' && (value.copies < 0 || value.copies > 10)) throw bad('จำนวนใบเสร็จต้องอยู่ระหว่าง 0–10');
  const before = getSetting(key, branchId);
  setSetting(key, value, branchId, req.staff.id);
  audit(req, 'settings.update', { entity: 'settings', entityId: key, details: `${branchId ? `branch ${branchId}` : 'global'}: ${diffSummary(before, value)}` });
  if (branchId) emitBranch(branchId, 'settings:changed', { key }); else emitAll('settings:changed', { key });
  res.json({ value: getSetting(key, branchId) });
});
r.delete('/settings/:key/branch/:branchId', (req, res) => {
  if (!hasPerm(req, SETTING_PERM[req.params.key] || 'settings.branch')) throw forbidden();
  clearBranchSetting(req.params.key, Number(req.params.branchId));
  audit(req, 'settings.reset_branch', { entity: 'settings', entityId: req.params.key, details: `branch ${req.params.branchId}` });
  emitBranch(Number(req.params.branchId), 'settings:changed', { key: req.params.key });
  res.json({ ok: true });
});
function diffSummary(a, b) {
  const out = [];
  for (const k of Object.keys(b || {})) if (JSON.stringify(a?.[k]) !== JSON.stringify(b[k]) && !/pass|token/i.test(k)) out.push(`${k}=${JSON.stringify(b[k]).slice(0, 60)}`);
  return out.join('; ').slice(0, 900) || 'no change';
}
r.post('/settings/test-email', requirePerm('settings.member'), async (req, res) => {
  const to = parse(z.string().email(), req.body.to);
  await sendEmail(getSetting('notifications').smtp, to, 'ทดสอบอีเมลจากระบบ POS', 'การตั้งค่า SMTP ถูกต้อง');
  res.json({ ok: true });
});

// ── Branches ──────────────────────────────────────────────────────────────
const branchSchema = z.object({
  code: z.string().min(1).max(20).regex(/^[A-Za-z0-9-]+$/), name: z.string().min(1).max(120), address: z.string().max(400).optional().nullable(),
  phone: z.string().max(30).optional().nullable(), taxId: z.string().max(20).optional().nullable(), taxBranch: z.string().max(20).optional().nullable(),
  timezone: z.string().max(60).optional(), receiptPrefix: z.string().min(1).max(10).regex(/^[A-Za-z0-9-]+$/), queuePrefix: z.string().max(5).regex(/^[A-Za-z]*$/), active: z.boolean().optional(),
});
const branchRow = (b) => ({ code: b.code, name: b.name, address: b.address ?? null, phone: b.phone ?? null, tax_id: b.taxId ?? null, tax_branch: b.taxBranch ?? null, timezone: b.timezone || 'Asia/Bangkok', receipt_prefix: b.receiptPrefix, queue_prefix: b.queuePrefix, active: b.active === false ? 0 : 1 });
r.get('/branches', (req, res) => {
  const rows = all(`SELECT b.*, (SELECT COUNT(*) FROM staff s WHERE s.branch_id = b.id AND s.deleted_at IS NULL) AS staff_count,
                           (SELECT COUNT(*) FROM pos_devices d WHERE d.branch_id = b.id AND d.active = 1) AS device_count
                    FROM branches b ORDER BY b.id`);
  res.json(req.staff.allBranches ? rows : rows.filter((b) => b.id === req.staff.branchId));
});
r.post('/branches', requirePerm('settings.branch'), (req, res) => {
  const b = parse(branchSchema, req.body);
  if (one('SELECT id FROM branches WHERE code = ? OR receipt_prefix = ?', b.code, b.receiptPrefix)) throw conflict('รหัสสาขาหรือ Prefix ใบเสร็จซ้ำกับสาขาอื่น');
  const id = insert('branches', branchRow(b));
  insert('zones', { branch_id: id, name: 'Indoor' });
  audit(req, 'branch.create', { entity: 'branch', entityId: id, details: b.name });
  res.json({ id });
});
r.put('/branches/:id', requirePerm('settings.branch'), (req, res) => {
  const b = parse(branchSchema, req.body);
  if (one('SELECT id FROM branches WHERE (code = ? OR receipt_prefix = ?) AND id <> ?', b.code, b.receiptPrefix, Number(req.params.id))) throw conflict('รหัสสาขาหรือ Prefix ใบเสร็จซ้ำกับสาขาอื่น');
  update('branches', Number(req.params.id), { ...branchRow(b), updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
  audit(req, 'branch.update', { entity: 'branch', entityId: req.params.id, details: b.name });
  res.json({ ok: true });
});

// ── Devices ───────────────────────────────────────────────────────────────
r.get('/devices', requirePerm('settings.device', 'settings.printer'), (req, res) => {
  res.json(all(`SELECT d.id, d.branch_id, d.code, d.name, d.type, d.paired_pos_id, d.station_id, d.config, d.active, d.last_seen_at, d.last_ip, d.created_at, p.name AS paired_pos_name, s.name AS station_name
                FROM pos_devices d LEFT JOIN pos_devices p ON p.id = d.paired_pos_id LEFT JOIN kitchen_stations s ON s.id = d.station_id
                WHERE d.branch_id = ? ORDER BY d.type, d.code`, Number(req.query.branchId) || req.staff.branchId).map((d) => ({ ...d, config: json(d.config, {}), online: isOnline(d.id) })));
});
r.put('/devices/:id', requirePerm('settings.device'), (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(60), pairedPosId: z.number().int().nullable().optional(), stationId: z.number().int().nullable().optional(), active: z.boolean().optional(), config: z.record(z.string(), z.any()).optional() }), req.body);
  const d = one('SELECT * FROM pos_devices WHERE id = ?', req.params.id);
  if (!d) throw notFound();
  update('pos_devices', d.id, { name: b.name, paired_pos_id: b.pairedPosId ?? null, station_id: b.stationId ?? null, active: b.active === false ? 0 : 1, config: b.config ? { ...json(d.config, {}), ...b.config } : undefined });
  audit(req, 'device.update', { entity: 'device', entityId: d.id, details: b.active === false ? 'deactivated' : b.name });
  res.json({ ok: true });
});
// POS terminal may update its own printer preferences
r.put('/device/config', (req, res) => {
  if (!req.device) throw bad('ไม่ได้ใช้งานจากอุปกรณ์ที่ลงทะเบียน');
  if (!hasPerm(req, 'settings.printer') && !hasPerm(req, 'settings.device')) throw forbidden();
  const cfg = parse(z.record(z.string(), z.any()), req.body);
  update('pos_devices', req.device.id, { config: { ...json(req.device.config, {}), ...cfg } });
  res.json({ ok: true });
});

// ── Hardware status ───────────────────────────────────────────────────────
r.get('/hardware', (req, res) => {
  const branchId = req.staff.branchId;
  const printers = all('SELECT p.id, p.name, p.role, p.connection, p.address, p.status, p.status_message, p.status_at, p.has_drawer, p.has_cutter, p.paper, p.host_device_id, d.name AS host_name FROM printers p LEFT JOIN pos_devices d ON d.id = p.host_device_id WHERE p.branch_id = ? AND p.active = 1', branchId)
    .map((p) => ({ ...p, hostOnline: p.host_device_id ? isOnline(p.host_device_id) : null }));
  const devices = all('SELECT id, code, name, type, last_seen_at, paired_pos_id FROM pos_devices WHERE branch_id = ? AND active = 1', branchId).map((d) => ({ ...d, online: isOnline(d.id) }));
  const failedJobs = one("SELECT COUNT(*) c FROM print_jobs WHERE branch_id = ? AND status = 'failed' AND created_at >= datetime('now','-1 day')", branchId).c;
  const waitingJobs = one("SELECT COUNT(*) c FROM print_jobs WHERE branch_id = ? AND status = 'waiting'", branchId).c;
  res.json({ printers, devices, failedJobs, waitingJobs, server: { uptime: process.uptime(), node: process.version, platform: os.platform(), memory: process.memoryUsage().rss } });
});

// ── Promotions (POS engine) ───────────────────────────────────────────────
const promoSchema = z.object({
  name: z.string().min(1).max(100), description: z.string().max(1000).optional().nullable(), imageUrl: z.string().max(1000).optional().nullable(),
  type: z.enum(Object.keys(PROMOTION_TYPES)), rule: z.record(z.string(), z.any()), conditions: z.record(z.string(), z.any()).optional(),
  startAt: z.string().nullable().optional(), endAt: z.string().nullable().optional(), priority: z.number().int().optional(), stackable: z.boolean().optional(),
  autoApply: z.boolean().optional(), showMember: z.boolean().optional(), active: z.boolean().optional(),
});
const promoRow = (b) => ({ name: b.name, description: b.description ?? null, image_url: b.imageUrl ?? null, type: b.type, rule: b.rule, conditions: b.conditions || {}, start_at: b.startAt || null, end_at: b.endAt || null, priority: b.priority ?? 0, stackable: b.stackable === false ? 0 : 1, auto_apply: b.autoApply === false ? 0 : 1, show_member: b.showMember ? 1 : 0, active: b.active === false ? 0 : 1 });
r.get('/promotions', (_req, res) => res.json({ types: PROMOTION_TYPES, promotions: all('SELECT * FROM promotions ORDER BY active DESC, priority DESC, id DESC').map(shapePromotion) }));
r.post('/promotions', requirePerm('settings.promotion'), (req, res) => {
  const b = parse(promoSchema, req.body);
  if (b.type === 'coupon' && !b.rule.code) throw bad('กรุณากำหนดรหัสคูปอง');
  const id = insert('promotions', promoRow(b));
  audit(req, 'promotion.create', { entity: 'promotion', entityId: id, details: b.name });
  emitAll('catalog:changed', {});
  res.json({ id });
});
r.put('/promotions/:id', requirePerm('settings.promotion'), (req, res) => {
  update('promotions', Number(req.params.id), promoRow(parse(promoSchema, req.body)));
  audit(req, 'promotion.update', { entity: 'promotion', entityId: req.params.id });
  emitAll('catalog:changed', {});
  res.json({ ok: true });
});
r.delete('/promotions/:id', requirePerm('settings.promotion'), (req, res) => {
  run('UPDATE promotions SET active = 0 WHERE id = ?', req.params.id);
  audit(req, 'promotion.delete', { entity: 'promotion', entityId: req.params.id });
  emitAll('catalog:changed', {});
  res.json({ ok: true });
});

// ── Activity log ──────────────────────────────────────────────────────────
r.get('/audit-logs', requirePerm('audit.view'), (req, res) => {
  const { action, staffId, from, to, q } = req.query;
  const where = []; const p = [];
  if (!hasPerm(req, 'report.all_branches')) { where.push('(a.branch_id = ? OR a.branch_id IS NULL)'); p.push(req.staff.branchId); }
  if (action) { where.push('a.action LIKE ?'); p.push(`${action}%`); }
  if (staffId) { where.push('a.staff_id = ?'); p.push(Number(staffId)); }
  if (from) { where.push('a.created_at >= ?'); p.push(from); }
  if (to) { where.push('a.created_at <= ?'); p.push(`${to} 23:59:59`); }
  if (q) { where.push('(a.details LIKE ? OR a.entity_id LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  res.json(all(`SELECT a.*, s.employee_code AS staff_code, COALESCE(s.nickname, s.first_name) AS staff_name, ap.employee_code AS approver_code, d.name AS device_name, b.name AS branch_name
                FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id LEFT JOIN staff ap ON ap.id = a.approved_by LEFT JOIN pos_devices d ON d.id = a.device_id LEFT JOIN branches b ON b.id = a.branch_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 1000`, ...p));
});

// ── Staff notifications ───────────────────────────────────────────────────
r.get('/notifications', (req, res) => {
  res.json(all('SELECT * FROM notifications WHERE branch_id = ? OR branch_id IS NULL ORDER BY id DESC LIMIT 100', req.staff.branchId).map((n) => ({ ...n, data: json(n.data, null) })));
});
r.post('/notifications/read', (req, res) => {
  if (req.body?.id) run("UPDATE notifications SET read_at = datetime('now') WHERE id = ?", req.body.id);
  else run("UPDATE notifications SET read_at = datetime('now') WHERE (branch_id = ? OR branch_id IS NULL) AND read_at IS NULL", req.staff.branchId);
  res.json({ ok: true });
});

// ── Backup / Restore / Export ─────────────────────────────────────────────
r.get('/backups', requirePerm('settings.backup'), (_req, res) => res.json(listBackups()));
r.post('/backups', requirePerm('settings.backup'), async (req, res) => {
  const out = await createBackup('manual', req.staff.id);
  audit(req, 'backup.create', { details: out.filename });
  res.json(out);
});
r.get('/backups/:file/download', requirePerm('settings.backup'), (req, res) => {
  const p = backupPath(req.params.file);
  if (!p) throw notFound();
  audit(req, 'backup.download', { details: req.params.file });
  res.download(p);
});
const upload = multer({ dest: path.join(os.tmpdir(), 'pos-restore'), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
r.post('/backups/restore', requirePerm('settings.backup'), upload.single('file'), async (req, res) => {
  if (req.staff.roleLevel < 90) throw forbidden('เฉพาะ Owner/Admin เท่านั้น');
  let file = req.file?.path;
  if (!file && req.body?.filename) file = backupPath(req.body.filename);
  if (!file) throw bad('กรุณาเลือกไฟล์สำรองข้อมูล');
  const who = { ...req.staff };
  await restoreFrom(file, who.id);
  if (req.file) fs.unlink(req.file.path, () => {});
  audit({ staff: who, ip: req.ip }, 'backup.restore', { details: req.file?.originalname || req.body.filename });
  emitAll('system:restored', {});
  res.json({ ok: true });
});
// Export data (JSON) — master data + transactions for the selected period
r.get('/export', requirePerm('settings.backup'), (req, res) => {
  const tables = ['branches', 'roles', 'role_permissions', 'staff', 'categories', 'products', 'product_variants', 'modifier_groups', 'modifiers', 'product_modifier_groups', 'zones', 'tables', 'kitchen_stations', 'printers', 'printer_routes', 'member_tiers', 'tier_rules', 'members', 'rewards', 'promotions', 'birthday_campaigns', 'ingredients', 'recipes', 'suppliers', 'inventory', 'settings'];
  const out = { exportedAt: new Date().toISOString(), tables: {} };
  for (const t of tables) out.tables[t] = all(`SELECT * FROM ${t}`);
  out.tables.members = out.tables.members.map(({ pin_hash, ...m }) => m);
  out.tables.settings = out.tables.settings.map((s) => (s.key === 'notifications' ? { ...s, value: '{"redacted":true}' } : s));
  if (req.query.from) {
    for (const t of ['orders', 'payments', 'payment_transactions', 'receipts', 'refunds', 'voids', 'point_transactions', 'stock_movements', 'waste']) {
      out.tables[t] = all(`SELECT * FROM ${t} WHERE created_at >= ? AND created_at <= ?`, req.query.from, `${req.query.to || req.query.from} 23:59:59`);
    }
  }
  audit(req, 'data.export', { details: `${req.query.from || 'master'}..${req.query.to || ''}` });
  res.set('Content-Disposition', `attachment; filename="pos-export-${new Date().toISOString().slice(0, 10)}.json"`).json(out);
});

export default r;
