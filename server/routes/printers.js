import { Router } from 'express';
import { z } from 'zod';
import { one, all, run, insert, update, tx } from '../db/index.js';
import { parse, notFound, bad, forbidden } from '../lib/errors.js';
import { requireStaff, requirePerm, requireDevice, gate, hasPerm } from '../middleware/auth.js';
import { createPrintJob, claimJob, finishJob, retryJob, cancelJob, reprintJob, shapeJob, receiptPrinterFor } from '../services/printing.js';
import { renderPng } from '../print/render.js';
import { probeTcp } from '../print/render.js';
import { audit } from '../services/audit.js';
import { emitBranch, isOnline } from '../realtime.js';
import { getSetting } from '../services/settings.js';

const r = Router();

const printerSchema = z.object({
  name: z.string().min(1).max(60), role: z.enum(['receipt', 'kitchen', 'label', 'report']),
  connection: z.enum(['ble', 'bt_classic', 'usb', 'serial', 'lan', 'bridge']), hostDeviceId: z.number().int().nullable().optional(),
  address: z.string().max(200).nullable().optional(), paper: z.enum(['58', '80']), dotsWidth: z.number().int().min(200).max(1000).nullable().optional(),
  renderMode: z.enum(['raster', 'text']).optional(), codepage: z.number().int().min(0).max(255).optional(),
  hasCutter: z.boolean().optional(), cutType: z.enum(['full', 'partial']).optional(), feedLines: z.number().int().min(0).max(20).optional(),
  hasDrawer: z.boolean().optional(), drawerPin: z.number().int().min(0).max(1).optional(), beep: z.boolean().optional(),
  kitchenCopies: z.number().int().min(0).max(10).optional(),
  routes: z.array(z.object({ stationId: z.number().int(), copies: z.number().int().min(0).max(10) })).optional(),
});
const row = (b) => ({
  name: b.name, role: b.role, connection: b.connection, host_device_id: b.hostDeviceId ?? null, address: b.address ?? null, paper: b.paper,
  dots_width: b.dotsWidth ?? null, render_mode: b.renderMode || 'raster', codepage: b.codepage ?? 255, has_cutter: b.hasCutter === false ? 0 : 1,
  cut_type: b.cutType || 'partial', feed_lines: b.feedLines ?? 4, has_drawer: b.hasDrawer ? 1 : 0, drawer_pin: b.drawerPin ?? 0, beep: b.beep ? 1 : 0,
  kitchen_copies: b.kitchenCopies ?? 1,
});

const branchPrinters = (branchId) => all(`SELECT p.*, d.name AS host_device_name FROM printers p LEFT JOIN pos_devices d ON d.id = p.host_device_id
                                          WHERE p.branch_id = ? AND p.active = 1 ORDER BY p.role, p.name`, branchId)
  .map((p) => ({ ...p, routes: all('SELECT r.*, s.name AS station_name FROM printer_routes r LEFT JOIN kitchen_stations s ON s.id = r.station_id WHERE r.printer_id = ?', p.id), hostOnline: p.host_device_id ? isOnline(p.host_device_id) : null }));

r.get('/printers', requireStaff, (req, res) => res.json(branchPrinters(req.staff.branchId)));

function saveRoutes(printerId, routes) {
  if (!routes) return;
  run("DELETE FROM printer_routes WHERE printer_id = ? AND doc_type = 'kitchen'", printerId);
  for (const rt of routes) insert('printer_routes', { printer_id: printerId, station_id: rt.stationId, doc_type: 'kitchen', copies: rt.copies });
}

r.post('/printers', requireStaff, requirePerm('settings.printer'), (req, res) => {
  const b = parse(printerSchema, req.body);
  const id = tx(() => { const id = insert('printers', { ...row(b), branch_id: req.staff.branchId }); saveRoutes(id, b.routes); return id; });
  audit(req, 'printer.create', { entity: 'printer', entityId: id, details: `${b.name} ${b.connection}` });
  emitBranch(req.staff.branchId, 'printers:changed', {});
  res.json({ id });
});
r.put('/printers/:id', requireStaff, requirePerm('settings.printer'), (req, res) => {
  const b = parse(printerSchema, req.body);
  const id = Number(req.params.id);
  if (!one('SELECT id FROM printers WHERE id = ? AND branch_id = ?', id, req.staff.branchId)) throw notFound();
  tx(() => { update('printers', id, row(b)); saveRoutes(id, b.routes); });
  audit(req, 'printer.update', { entity: 'printer', entityId: id, details: b.name });
  emitBranch(req.staff.branchId, 'printers:changed', {});
  res.json({ ok: true });
});
r.delete('/printers/:id', requireStaff, requirePerm('settings.printer'), (req, res) => {
  run('UPDATE printers SET active = 0 WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  run("UPDATE print_jobs SET status = 'cancelled' WHERE printer_id = ? AND status = 'waiting'", req.params.id);
  audit(req, 'printer.delete', { entity: 'printer', entityId: req.params.id });
  emitBranch(req.staff.branchId, 'printers:changed', {});
  res.json({ ok: true });
});

// Test print (real job through the queue)
r.post('/printers/:id/test', requireStaff, requirePerm('settings.printer', 'pos.access'), (req, res) => {
  const p = one('SELECT * FROM printers WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  if (!p) throw notFound();
  const id = createPrintJob({ branchId: p.branch_id, printerId: p.id, docType: 'test', staffId: req.staff.id,
    payload: { type: 'test', printerName: p.name, connection: p.connection, paper: p.paper, tz: getSetting('shop').timezone, cutInfo: p.has_cutter ? `ตัดกระดาษแบบ ${p.cut_type === 'full' ? 'Full Cut' : 'Partial Cut'} · Feed ${p.feed_lines} บรรทัด` : 'ไม่มี Cutter — Feed กระดาษแทนการตัด' } });
  audit(req, 'printer.test', { entity: 'printer', entityId: p.id });
  res.json({ jobId: id });
});

// LAN probe
r.post('/printers/:id/probe', requireStaff, requirePerm('settings.printer', 'pos.access'), async (req, res) => {
  const p = one('SELECT * FROM printers WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  if (!p) throw notFound();
  if (p.connection !== 'lan') throw bad('ตรวจสอบผ่านเซิร์ฟเวอร์ได้เฉพาะเครื่องพิมพ์ LAN');
  const out = await probeTcp(p.address);
  run("UPDATE printers SET status = ?, status_message = ?, status_at = datetime('now') WHERE id = ?", out.ok ? 'connected' : 'disconnected', out.ok ? null : out.message, p.id);
  emitBranch(p.branch_id, 'printer:status', { printerId: p.id, status: out.ok ? 'connected' : 'disconnected', message: out.message });
  res.json(out);
});

// Open cash drawer (No Sale) — logged, can require manager approval
r.post('/drawer/open', requireStaff, (req, res) => {
  const b = parse(z.object({ reason: z.string().min(1).max(200), printerId: z.number().int().optional() }), req.body);
  const out = tx(() => {
    const g = gate(req, 'open_drawer', { perm: 'payment.open_drawer' });
    const p = b.printerId ? one('SELECT * FROM printers WHERE id = ?', b.printerId) : receiptPrinterFor(req.staff.branchId, req.device?.id);
    if (!p || !p.has_drawer) throw bad('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ที่ต่อ Cash Drawer');
    const shift = req.device ? one("SELECT id FROM shifts WHERE device_id = ? AND status = 'open'", req.device.id) : null;
    insert('cash_movements', { branch_id: req.staff.branchId, shift_id: shift?.id ?? null, device_id: req.device?.id ?? null, staff_id: req.staff.id, type: 'no_sale', amount: 0, reason: b.reason, approval_id: g.approvalId });
    audit(req, 'drawer.open', { details: b.reason, approvedBy: g.approvedBy });
    return { jobId: createPrintJob({ branchId: req.staff.branchId, printerId: p.id, docType: 'drawer', payload: { type: 'drawer' }, staffId: req.staff.id }) };
  });
  res.json(out);
});

// ── Print queue ───────────────────────────────────────────────────────────
r.get('/print-jobs', requireStaff, (req, res) => {
  const { status, printerId, orderId, limit = 150 } = req.query;
  const where = ['j.branch_id = ?']; const p = [req.staff.branchId];
  if (status) { const l = String(status).split(','); where.push(`j.status IN (${l.map(() => '?').join(',')})`); p.push(...l); }
  if (printerId) { where.push('j.printer_id = ?'); p.push(Number(printerId)); }
  if (orderId) { where.push('j.order_id = ?'); p.push(orderId); }
  res.json(all(`SELECT j.id, j.job_uid, j.printer_id, j.order_id, j.doc_type, j.station_id, j.sub_index, j.sub_count, j.copy_index, j.copy_count,
                       j.status, j.attempts, j.error, j.created_at, j.printed_at, j.reprint_of, p.name AS printer_name, p.connection,
                       o.order_no, o.queue_no, ks.name AS station_name
                FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id LEFT JOIN orders o ON o.id = j.order_id
                LEFT JOIN kitchen_stations ks ON ks.id = j.station_id
                WHERE ${where.join(' AND ')} ORDER BY j.id DESC LIMIT ?`, ...p, Math.min(Number(limit) || 150, 500)));
});
r.get('/print-jobs/:id', requireStaff, (req, res) => {
  const j = one('SELECT * FROM print_jobs WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  if (!j) throw notFound();
  res.json(shapeJob(j));
});
// PNG preview rendered with the same Sarabun renderer used for printing
r.get('/print-jobs/:id/preview.png', requireStaff, async (req, res) => {
  const j = one('SELECT j.*, p.paper, p.dots_width FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id WHERE j.id = ? AND j.branch_id = ?', req.params.id, req.staff.branchId);
  if (!j) throw notFound();
  if (j.doc_type === 'drawer') throw bad('งานเปิดลิ้นชักไม่มีภาพตัวอย่าง');
  const png = await renderPng(shapeJob(j).payload, { paper: j.paper || '80', dots_width: j.dots_width });
  res.type('png').set('Cache-Control', 'no-store').send(png);
});
r.post('/print-jobs/preview.png', requireStaff, async (req, res) => {
  const png = await renderPng(req.body.doc, { paper: String(req.body.paper || '80') });
  res.type('png').set('Cache-Control', 'no-store').send(png);
});
r.post('/print-jobs/:id/retry', requireStaff, (req, res) => {
  const j = one('SELECT * FROM print_jobs WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  if (!j) throw notFound();
  if (j.status === 'printed') throw bad('งานนี้พิมพ์สำเร็จแล้ว ใช้ Reprint แทน');
  audit(req, 'print.retry', { entity: 'print_job', entityId: j.id, details: j.doc_type });
  res.json(retryJob(j.id));
});
r.post('/print-jobs/:id/cancel', requireStaff, (req, res) => {
  const j = one('SELECT * FROM print_jobs WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  if (!j) throw notFound();
  audit(req, 'print.cancel', { entity: 'print_job', entityId: j.id });
  res.json(cancelJob(j.id));
});
r.post('/print-jobs/:id/reprint', requireStaff, (req, res) => {
  const b = parse(z.object({ printerId: z.number().int().optional(), reason: z.string().max(200).optional() }), req.body || {});
  const j = one('SELECT * FROM print_jobs WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  if (!j) throw notFound();
  const out = tx(() => {
    let g = { approvedBy: null };
    if (j.doc_type === 'receipt') {
      g = gate(req, 'reprint', { perm: 'receipt.reprint', orderId: j.order_id });
      if (j.receipt_id) insert('reprints', { receipt_id: j.receipt_id, staff_id: req.staff.id, approval_id: g.approvalId, reason: b.reason || 'reprint from print queue' });
    } else if (!hasPerm(req, 'pos.send_kitchen') && !hasPerm(req, 'settings.printer')) throw forbidden();
    audit(req, 'print.reprint', { entity: 'print_job', entityId: j.id, details: `${j.doc_type} ${b.reason || ''}`, approvedBy: g.approvedBy });
    return { jobId: reprintJob(j.id, req.staff.id, b.printerId) };
  });
  res.json(out);
});

// ── Device print agents (POS browsers hosting BT/USB printers, Local Print Bridge) ──
r.get('/print-agent/jobs', requireDevice, (req, res) => {
  const printers = all('SELECT id FROM printers WHERE host_device_id = ? AND active = 1', req.device.id).map((p) => p.id);
  if (req.device.type === 'bridge') printers.push(...all("SELECT id FROM printers WHERE connection = 'bridge' AND branch_id = ? AND active = 1", req.device.branch_id).map((p) => p.id));
  if (!printers.length) return res.json([]);
  res.json(all(`SELECT id, printer_id, doc_type, status FROM print_jobs WHERE status = 'waiting' AND printer_id IN (${printers.map(() => '?').join(',')}) ORDER BY id LIMIT 50`, ...printers));
});
r.post('/print-agent/jobs/:id/claim', requireDevice, (req, res) => {
  const j = one('SELECT j.*, p.host_device_id, p.connection, p.branch_id AS p_branch FROM print_jobs j JOIN printers p ON p.id = j.printer_id WHERE j.id = ?', req.params.id);
  if (!j) throw notFound();
  const mine = j.host_device_id === req.device.id || (req.device.type === 'bridge' && j.connection === 'bridge' && j.p_branch === req.device.branch_id);
  if (!mine) throw forbidden('เครื่องพิมพ์นี้ไม่ได้ผูกกับอุปกรณ์นี้');
  const job = claimJob(j.id, `device:${req.device.id}`);
  if (!job) return res.status(409).json({ error: 'งานนี้ถูกรับไปแล้ว', code: 'ALREADY_CLAIMED' });
  res.json({ job, printer: one('SELECT * FROM printers WHERE id = ?', job.printer_id) });
});
r.post('/print-agent/jobs/:id/result', requireDevice, (req, res) => {
  const b = parse(z.object({ ok: z.boolean(), error: z.string().max(500).optional() }), req.body);
  const j = one('SELECT * FROM print_jobs WHERE id = ?', req.params.id);
  if (!j || j.claimed_by !== `device:${req.device.id}`) throw notFound();
  res.json(finishJob(j.id, b));
});

export default r;
